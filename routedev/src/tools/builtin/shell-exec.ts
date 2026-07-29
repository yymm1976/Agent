// src/tools/builtin/shell-exec.ts
// 执行 Shell 命令
// 权限：confirm
// Phase 17c：集成 RetryPolicy + CircuitBreaker（熔断保护，默认不重试 shell 命令）
// Phase 29 Task 3：环境变量白名单过滤（防止 env 注入）

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { RetryPolicy, CircuitBreaker, resilientExecute } from '../../utils/retry.js';
import { logger } from '../../utils/logger.js';
import type { CommandSandbox } from '../../security/sandbox.js';
// Phase 96 P1-5：ANSI 去除 + 二进制净化 + 截断元数据
import { stripAnsi, sanitizeBinaryOutput, computeTruncationMetadata, type TruncationResult } from '../../utils/ansi-stripper.js';

const MAX_STDOUT = 100 * 1024;
const MAX_STDERR = 50 * 1024;

// V3-021 修复：timeoutMs 上限（10 分钟），防止 LLM 传入超大值导致进程长时间挂起
const MAX_TIMEOUT_MS = 600_000;

/**
 * Phase 96 修复：把命令链（&& / ||）翻译为 Windows PowerShell 5.x 兼容形式
 *
 * 背景：Windows 自带 powershell.exe 是 5.x，不支持 && 和 || 运算符（PS 7+ 才支持）。
 * 直接执行 `cd x && cmd` 会触发语法错误，stderr 可能为空，shell_exec 上游显示「未知错误」。
 *
 * 翻译规则（保留短路语义）：
 *   cmd1 && cmd2  →  cmd1; if ($?) { cmd2 }
 *   cmd1 || cmd2  →  cmd1; if (-not $?) { cmd2 }
 *
 * 嵌套命令链会递归翻译：
 *   cmd1 && cmd2 && cmd3  →  cmd1; if ($?) { cmd2; if ($?) { cmd3 } }
 *
 * 引号内的 && / || 不替换（避免破坏 echo "a && b" 这类字面量）。
 *
 * @internal 导出仅为单元测试使用，外部不应直接调用
 */
export function translateChainForPowerShell5(command: string): string {
  // 引号感知分割：避免替换引号内的 && / ||
  // 简化实现：逐字符扫描，遇到引号时跳过
  // operator 字段表示「该段前面的运算符」（第一段为 null）
  const parts: { cmd: string; operator: '&&' | '||' | null }[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let pendingOperator: '&&' | '||' | null = null;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (ch === '\'' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
      continue;
    }

    // 仅在引号外检测 && 或 ||
    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '&' && next === '&') {
        if (current.trim()) {
          parts.push({ cmd: current.trim(), operator: pendingOperator });
          pendingOperator = '&&';
        }
        current = '';
        i += 2;
        continue;
      }
      if (ch === '|' && next === '|') {
        if (current.trim()) {
          parts.push({ cmd: current.trim(), operator: pendingOperator });
          pendingOperator = '||';
        }
        current = '';
        i += 2;
        continue;
      }
    }

    current += ch;
    i++;
  }

  if (current.trim()) {
    parts.push({ cmd: current.trim(), operator: pendingOperator });
  }

  // 单条命令无需翻译
  if (parts.length <= 1) return command;

  // 嵌套重组：cmd1; if ($?) { cmd2; if ($?) { cmd3 } }
  // 嵌套形式保证短路语义正确传递：c 的执行依赖 b 的结果，而非 a 的结果
  // 末尾统一闭合所有打开的 {
  let result = parts[0].cmd;
  let openBraces = 0;
  for (let j = 1; j < parts.length; j++) {
    const op = parts[j].operator;
    if (op === '&&') {
      result += `; if ($?) { ${parts[j].cmd}`;
      openBraces++;
    } else if (op === '||') {
      result += `; if (-not $?) { ${parts[j].cmd}`;
      openBraces++;
    } else {
      // 防御性 fallback：不应该走到这里（pendingOperator 已设置）
      result += `; ${parts[j].cmd}`;
    }
  }
  for (let k = 0; k < openBraces; k++) {
    result += ' }';
  }
  return result;
}

/**
 * V3-020 修复：Windows PowerShell 参数转义
 * PowerShell 单引号字符串中，唯一的转义规则是把单引号替换为两个单引号。
 * 用单引号包裹后，参数内的特殊字符（$ ; | & 等）将不再被 PowerShell 解释。
 *
 * 注意：当前 shell_exec 的 command 是用户/LLM 提供的完整 shell 命令字符串，
 * 不能对整个 command 转义（否则会破坏合法的管道/重定向）。
 * 此函数供未来扩展使用：若工具演进为接受分离的命令 + 参数，应对每个参数调用此函数。
 * 当前的注入防护主要依赖：
 *   1. sandbox 前置校验（白/黑名单 + 危险模式检测）
 *   2. spawn（而非 exec）传递参数，避免额外的 shell 解释层
 */
function escapePowerShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "''") + "'";
}

/**
 * 环境变量白名单：仅允许这些变量被子进程覆盖
 * 防止恶意工具调用通过 context.environment 注入或覆盖敏感环境变量
 * （如 LD_PRELOAD、NODE_OPTIONS 等可导致代码注入的变量）
 */
const ALLOWED_ENV_KEYS = new Set([
  'NODE_ENV', 'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL',
  'TERM', 'SHELL', 'EDITOR', 'PAGER',
  // Git 工具链常见变量
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]);

/**
 * F-N004 修复：process.env 继承白名单
 * 仅从 process.env 中继承子进程运行所必需的环境变量，
 * 防止完整透传 process.env 导致潜在敏感信息（如 API Key、CI 密钥等）泄露给子进程。
 * 包含 Windows 平台必需变量（SYSTEMROOT/USERPROFILE/APPDATA/LOCALAPPDATA），
 * 缺失 SYSTEMROOT 会导致 Windows 上 spawn 失败。
 */
const INHERITED_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL',
  // Windows 必需：缺任一都可能导致 spawn/cmd 闪窗或命令异常
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'PATHEXT', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'NODE_ENV', 'EDITOR', 'PAGER',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]);

export class ShellExecTool implements ITool {
  // 熔断器：连续失败 5 次后开路 30 秒，防止系统不稳定
  private circuit = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 });
  // 重试策略：shell 命令通常有副作用，默认不重试（maxRetries=0），仅启用熔断
  private retry = new RetryPolicy({ maxRetries: 0 });
  // 可选沙箱：注入后对命令做白/黑名单 + 危险模式前置校验
  private sandbox: CommandSandbox | null = null;

  /** 注入安全沙箱（用于命令前置校验：白/黑名单 + 危险模式检测） */
  setSandbox(sandbox: CommandSandbox): void {
    this.sandbox = sandbox;
  }

  readonly definition: ToolDefinition = {
    name: 'shell_exec',
    description: '当用户需要执行 shell 命令、运行构建脚本、或调用系统工具时，使用此工具。执行前会进行环境变量白名单过滤与熔断保护。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 Shell 命令',
        },
        workingDirectory: {
          type: 'string',
          description: '命令执行的工作目录（可选，默认项目根目录）',
        },
        timeoutMs: {
          type: 'number',
          description: '超时时间（毫秒，可选）',
        },
      },
      required: ['command'],
    },
    requiresApproval: true,
    category: 'shell',
    // Phase 73 Part B：shell 命令常涉及文件系统/进程状态竞争，强制串行
    executionMode: 'sequential' as const,
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.command || typeof args.command !== 'string') {
      errors.push('缺少必需参数: command');
    }
    if (args.timeoutMs !== undefined && typeof args.timeoutMs !== 'number') {
      errors.push('timeoutMs 必须是数字');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const command = args.command as string;
    const cwd = args.workingDirectory
      ? path.resolve(context.workingDirectory, args.workingDirectory as string)
      : context.workingDirectory;
    // V3-021 修复：timeoutMs 上限保护，防止 LLM 传入超大值导致进程长时间挂起
    const rawTimeout = (args.timeoutMs as number) ?? context.timeoutMs ?? 30000;
    const timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_MS);

    // C3 修复：校验 cwd 在允许目录内，防止通过绝对路径 workingDirectory 逃逸到任意目录
    const allowedDirs = context.allowedDirectories ?? [context.workingDirectory];
    // F-039：Windows 平台路径大小写不敏感，比较前用 path.resolve + toLowerCase() 归一化
    const normalizedCwd = path.resolve(cwd).toLowerCase();
    const isCwdAllowed = allowedDirs.some(dir => {
      const normalizedDir = path.resolve(dir).toLowerCase();
      const rel = path.relative(normalizedDir, normalizedCwd);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!isCwdAllowed) {
      return {
        success: false,
        output: '',
        error: `工作目录 "${args.workingDirectory}" 不在允许范围内`,
        durationMs: 0,
      };
    }

    // 沙箱前置校验：白/黑名单 + 危险模式检测
    if (this.sandbox) {
      const validation = this.sandbox.validate(command);
      if (!validation.allowed) {
        logger.warn('shell_exec blocked by sandbox', { command, reason: validation.reason });
        return {
          success: false,
          output: '',
          error: `命令被安全沙箱拦截: ${validation.reason ?? '未知原因'}`,
          durationMs: 0,
        };
      }
    }

    // 用 resilientExecute 包装：熔断器保护 + 可选重试
    // shell 命令默认不重试（maxRetries=0），仅启用熔断器防止连续失败
    try {
      return await resilientExecute(
        () => this.runCommand(command, cwd, timeoutMs, context),
        this.retry,
        this.circuit,
      );
    } catch (error) {
      // 熔断器开启时抛出 'Circuit breaker is OPEN'
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('shell_exec blocked by circuit breaker or retry exhausted', { command, error: msg });
      return {
        success: false,
        output: '',
        error: `INFRA_FAILURE: 命令执行被熔断器阻止或重试耗尽: ${msg}`,
        durationMs: 0,
        metadata: { errorType: 'INFRA_FAILURE', reason: msg },
      };
    }
  }

  /** 实际执行 shell 命令的内部方法 */
  private runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      // 根据平台选择 shell
      // Windows 上使用 PowerShell：兼容 cmd 命令且原生支持 cmdlet（Remove-Item/Get-ChildItem 等）
      // 避免 LLM 生成 PowerShell 命令时在 cmd.exe 中乱码或报错
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'powershell.exe' : '/bin/sh';
      // Phase 95 修复：Windows PowerShell 5.x 默认输出编码是 CP936/GBK，
      // 含中文路径的输出（如 git status / dir）转 utf-8 解码会乱码。
      // 在命令前注入 [Console]::OutputEncoding 设置，让 PowerShell 用 UTF-8 输出。
      // 注意：必须同时设 OutputEncoding 和 [Console]::OutputEncoding，前者影响管道字节，
      // 后者影响 PowerShell 内部的 Console 输出编码。
      // Phase 96 修复：PowerShell 5.x 不支持 && 和 ||（PS 7+ 才支持），直接执行会语法错误。
      // 在送入 PowerShell 前先翻译为 ; if ($?) { ... } / ; if (-not $?) { ... } 兼容形式。
      const translatedCommand = isWin ? translateChainForPowerShell5(command) : command;
      const winCommand = isWin
        ? `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${translatedCommand}`
        : command;
      const shellArgs = isWin ? ['-NoProfile', '-NonInteractive', '-Command', winCommand] : ['-c', command];

      // Phase 29 Task 3：环境变量白名单过滤
      // 仅允许白名单内的变量被子进程覆盖，防止 env 注入攻击
      const filteredEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(context.environment ?? {})) {
        if (ALLOWED_ENV_KEYS.has(key)) {
          filteredEnv[key] = String(value);
        } else {
          logger.warn(`环境变量 ${key} 不在白名单中，已忽略`);
        }
      }

      // F-N004 修复：process.env 按白名单过滤后再继承，防止敏感环境变量泄露给子进程
      // 缺失 SYSTEMROOT 会导致 Windows 上 spawn 失败，因此 Windows 必需变量已包含在白名单中
      const inheritedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (INHERITED_ENV_KEYS.has(key) && value !== undefined) {
          inheritedEnv[key] = value;
        }
      }

      const startTime = Date.now();
      const child = spawn(shell, shellArgs, {
        cwd,
        env: { ...inheritedEnv, ...filteredEnv },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // M5 修复：移除 spawn 的 timeout 选项，仅保留手动 setTimeout（含 SIGKILL 兜底）
        // 避免 spawn timeout 与手动 setTimeout 同时触发 SIGTERM 的竞态
      });

      let sigkillTimer: NodeJS.Timeout | undefined;
      // Phase 96 P1-5：保留原始 stdout/stderr（未经截断），用于 TruncationResult 元数据计算
      let rawStdout = '';
      let rawStderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      // Phase 96 P1-1：标记是否因 AbortSignal 触发的取消
      let aborted = false;

      const timeout = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        // 5 秒后强制 kill
        sigkillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);

      // Phase 96 P1-1：监听 AbortSignal，用户取消时终止子进程
      // 与 timeout 共用 killed 标志和 SIGKILL 兜底逻辑
      const onAbort = () => {
        if (!killed) {
          killed = true;
          aborted = true;
          child.kill('SIGTERM');
          sigkillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
        }
      };
      context.signal?.addEventListener('abort', onAbort);

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf-8');
        rawStdout += chunk;
        if (stdout.length < MAX_STDOUT) {
          stdout += chunk;
          if (stdout.length > MAX_STDOUT) {
            stdout = stdout.slice(0, MAX_STDOUT);
            stdoutTruncated = true;
          }
          // Phase 96 P1-1：推送增量输出给上层（loop → IPC → 渲染层）
          // 仅推送未截断的部分，避免超长输出刷屏
          context.onUpdate?.(chunk);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString('utf-8');
        rawStderr += chunk;
        if (stderr.length < MAX_STDERR) {
          stderr += chunk;
          if (stderr.length > MAX_STDERR) {
            stderr = stderr.slice(0, MAX_STDERR);
            stderrTruncated = true;
          }
          // Phase 96 P1-1：stderr 也推送增量输出（标记为错误流）
          context.onUpdate?.(`[stderr] ${chunk}`);
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        context.signal?.removeEventListener('abort', onAbort);
        resolve({
          success: false,
          output: '',
          error: `启动命令失败: ${error.message}`,
          durationMs: Date.now() - startTime,
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        // Phase 96 P1-1：清理 AbortSignal 监听器，避免内存泄漏
        context.signal?.removeEventListener('abort', onAbort);

        if (killed) {
          // Phase 96 P1-1：区分超时和用户取消，给出不同的错误信息
          const errorMsg = aborted
            ? '命令被用户取消'
            : `命令执行超时（>${timeoutMs}ms）`;
          resolve({
            success: false,
            output: stdout,
            error: errorMsg,
            durationMs: Date.now() - startTime,
          });
          return;
        }

        // Phase 96 P1-5：ANSI 去除 + 二进制净化
        // 之前直接把 stdout/stderr 拼接给 LLM，导致 pnpm test / vitest 等带颜色输出
        // 在 LLM 上下文里变成乱码（\u001b[32m 等），既浪费 token 又干扰注入检测正则
        const cleanStdout = sanitizeBinaryOutput(stripAnsi(stdout));
        const cleanStderr = sanitizeBinaryOutput(stripAnsi(stderr));

        // 截断标记改为 in-band 注释（仍保留，便于 LLM 阅读时感知截断）
        const stdoutDisplay = cleanStdout + (stdoutTruncated ? '\n[输出已截断]' : '');
        const stderrDisplay = cleanStderr + (stderrTruncated ? '\n[错误输出已截断]' : '');

        const output = [
          stdoutDisplay ? `stdout:\n${stdoutDisplay}` : '',
          stderrDisplay ? `stderr:\n${stderrDisplay}` : '',
          code !== null ? `[退出码: ${code}]` : `[信号: ${signal}]`,
        ].filter(Boolean).join('\n\n');

        // Phase 96 P1-5：附加 TruncationResult 结构化元数据
        // 之前 metadata 仅 { exitCode, signal }，下游只能正则匹配 in-band 文本判断截断
        // 现在 stdoutTruncation / stderrTruncation 让调用方直接读字段
        const stdoutTruncation: TruncationResult = computeTruncationMetadata(rawStdout, cleanStdout);
        const stderrTruncation: TruncationResult = computeTruncationMetadata(rawStderr, cleanStderr);

        resolve({
          success: code === 0,
          output,
          // Phase 96 修复：stderr 非空时也明确给出错误信息，避免上游显示「未知错误」
          // - stderr 非空：直接用 stderr 作为错误（截断避免过长）
          // - stderr 为空但 exitCode 非零：给出明确退出码错误
          error: code !== 0
            ? (cleanStderr.trim() ? `命令执行失败（退出码 ${code}）: ${cleanStderr.trim().slice(0, 200)}` : `命令退出码非零: ${code}`)
            : undefined,
          durationMs: Date.now() - startTime,
          metadata: {
            exitCode: code,
            signal,
            // P1-5 新增：结构化截断元数据（替代 in-band 文本标记解析）
            stdoutTruncated: stdoutTruncated || stdoutTruncation.truncatedBy !== null,
            stderrTruncated: stderrTruncated || stderrTruncation.truncatedBy !== null,
            stdoutTruncation,
            stderrTruncation,
          },
        });
      });
    });
  }
}
