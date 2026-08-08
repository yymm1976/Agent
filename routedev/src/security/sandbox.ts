// src/security/sandbox.ts
// 命令执行沙箱
//
// 设计目标：
//   1. 基于 child_process.spawn 执行外部命令，不使用 vm 模块（vm 不是真正的沙箱，
//      不适合命令执行场景）
//   2. 命令白名单 / 黑名单：检查 command 是否在 allowedCommands 中或不在
//      blockedCommands 中
//   3. 工作目录限制：cwd 必须在 workingDirectoryRestriction 列表内
//   4. 超时控制：spawn + setTimeout，超时 kill 进程
//   5. 输出限制：监控 stdout/stderr 字节数，超 maxOutputBytes 时 kill 进程
//   6. 环境变量隔离：只传 env 中指定的变量 + PATH，不继承全部父进程环境
//   7. 危险命令检测：检测 rm -rf /、format、del /f /s /q 等危险模式
//
// 注意：此沙箱提供"限制 + 监控"层，不能替代操作系统级隔离（如容器 / chroot）
// 对于不可信代码，应在容器或单独的 VM 中执行

import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { auditPanel } from './audit-panel.js';
// F-040：使用 parseCommand 正确解析带引号命令的首 token
import { parseCommand } from '../tools/command-parser.js';
import { normalizeExecutableIdentity } from './executable-identity.js';
import { checkRmPolicy } from './destructive-policy.js';

// ============================================================
// 类型定义
// ============================================================

export interface SandboxOptions {
  /** 工作目录（可选，默认 process.cwd()） */
  cwd?: string;
  /** 超时（毫秒，默认 30000） */
  timeout?: number;
  /** 最大输出字节数（默认 1MB，stdout + stderr 各自限制） */
  maxOutputBytes?: number;
  /** 显式指定的环境变量（仅这些变量会传给子进程，外加 PATH） */
  env?: Record<string, string>;
  /** 命令白名单（空 = 全部允许，非空时 command 必须在列表中） */
  allowedCommands?: string[];
  /** 命令黑名单（command 在列表中时拒绝） */
  blockedCommands?: string[];
  /** 允许的工作目录列表（设置后 cwd 必须在其中或其子目录下） */
  workingDirectoryRestriction?: string[];
}

export interface SandboxResult {
  /** 退出码（进程被 kill 时为 null） */
  exitCode: number | null;
  /** 标准输出（已截断至 maxOutputBytes） */
  stdout: string;
  /** 标准错误（已截断至 maxOutputBytes） */
  stderr: string;
  /** 是否因超时被 kill */
  timedOut: boolean;
  /** 是否因输出超限被 kill */
  outputTruncated: boolean;
  /** 执行时长（毫秒） */
  durationMs: number;
}

/**
 * 命令级校验结果（P0-2 改造：原 ValidationResult 改名为 CommandValidationResult）
 *
 * 命名冲突说明：src/tools/types.ts 也导出 ValidationResult（辨识联合，用于工具参数校验），
 * 两者语义不同：
 *   - 本类型：命令级 allow/deny + reason
 *   - types.ts：工具参数级辨识联合（result + message + errorCode + behavior）
 * 改名后避免跨模块 import 时歧义，types.ts 的 ValidationResult 成为唯一权威定义。
 */
export interface CommandValidationResult {
  allowed: boolean;
  reason?: string;
}

// ============================================================
// 默认值
// ============================================================

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

/**
 * 危险命令模式（命中即拦截）
 *
 * 这些模式覆盖典型的"破坏系统"命令：
 *   - rm -rf / 或 rm -rf /*
 *   - Windows format 命令
 *   - Windows del /f /s /q
 *   - mkfs（格式化文件系统）
 *   - dd if=... of=/dev/...（裸设备写入）
 *   - shutdown / reboot / halt
 *   - :(){:|:&};: fork bomb
 *
 * 注意：模式大小写不敏感；空白容错（一个或多个空格）
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  // rm -rf / 或 rm -rf /*
  /rm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\/(\s|$|\*)/i,
  // F-040：rm -rf 变体扩充 — 防止绕过
  // rm -rf /. （/ 后是 .，递归删除根目录内容）
  /rm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\/\.(\/|\s|$)/i,
  // rm -rf /./etc （/./ 变体，绕过简单的 / 匹配）
  /rm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\/\.\/./i,
  // rm -rf -- / （-- flag 终止选项解析，后接 /）
  /rm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+--\s+\/(\s|$|\*)/i,
  // Windows format 命令（format C: 等）
  /^format\s+[a-z]:/i,
  // Windows del /f /s /q（强制删除递归静默）
  /^del\s+\/[a-z]*f[a-z]*\s+\/[a-z]*s[a-z]*\s+\/[a-z]*q/i,
  /^del\s+\/[a-z]*s[a-z]*\s+\/[a-z]*f[a-z]*\s+\/[a-z]*q/i,
  /^del\s+\/[a-z]*q[a-z]*\s+\/[a-z]*s[a-z]*\s+\/[a-z]*f/i,
  // mkfs（格式化文件系统）
  /^mkfs(\.|\s)/i,
  // dd if=... of=/dev/...（裸设备写入）
  /^dd\s+.*of=\/dev\//i,
  // shutdown / reboot / halt / poweroff（系统关机）
  /^(shutdown|reboot|halt|poweroff)(\s|$)/i,
  // fork bomb：:(){:|:&};:
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
];

// ============================================================
// 第九轮复审：结构化危险执行策略（ExecutionPolicy V2）
// 危险命令不依赖路径拼写——executable basename 归一后判定：
//   /sbin/shutdown、/usr/bin/dd、C:\Windows\System32ormat.com
//   与裸命令等价。regex 仅保留 fork bomb 等 defense-in-depth。
// ============================================================

/** 系统关机/重启类（任意路径前缀均拒绝） */
const SHUTDOWN_COMMANDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);

/** mkfs 系列（格式化文件系统）：mkfs / mkfs.ext4 / mkfs.xfs ... */
const MKFS_PATTERN = /^mkfs(\.|$)/;

/** shell 解释器（高风险类别：-c 可执行任意命令） */
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']);

/**
 * 结构化危险策略：基于 normalized executable（basename）判定命令语义。
 * @param executableName 归一化可执行名（小写、已 strip .exe/.cmd/.bat）
 * @param firstToken 原始首 token（Windows format.com 等扩展名保留判定用）
 * @param args 结构化参数（dd 的 of=/dev/* 检查）
 * @returns 危险原因；undefined = 通过结构化策略
 */
function checkDangerousPolicy(
  executableName: string,
  firstToken: string,
  args: readonly string[],
): string | undefined {
  const base = executableName.toLowerCase();
  const rawBase = firstToken.toLowerCase();

  // A2：rm 结构化 argv 策略（combined/separated flags + target 归一）
  const rmReason = checkRmPolicy(base, args);
  if (rmReason) return rmReason;

  // 系统关机/重启类：basename 命中即拒绝（路径拼写无关）
  if (SHUTDOWN_COMMANDS.has(base)) {
    return '系统关机/重启命令（shutdown/reboot/halt/poweroff）';
  }

  // mkfs 系列：basename 命中 mkfs/mkfs.* 即拒绝
  if (MKFS_PATTERN.test(base)) {
    return '文件系统格式化命令（mkfs 系列）';
  }

  // dd 裸设备写入：executable == dd 且参数含 of=/dev/*
  if (base === 'dd') {
    const hasDeviceWrite = args.some((a) => /^of=\/dev\//.test(a));
    if (hasDeviceWrite) {
      return 'dd 写入裸设备（of=/dev/*）';
    }
  }

  // Windows format：format / format.com（任意路径前缀）
  if (base === 'format' || rawBase === 'format.com' || base === 'format.com') {
    // 目标盘符（format C:）或裸调用均拒绝
    const hasDriveTarget = args.some((a) => /^[a-z]:/i.test(a));
    if (hasDriveTarget || args.length === 0) {
      return 'Windows format 磁盘格式化';
    }
  }

  // Windows del /f /s /q（强制递归静默删除）
  if (base === 'del') {
    const flags = args.join(' ').toLowerCase();
    if (flags.includes('/f') && flags.includes('/s') && flags.includes('/q')) {
      return 'Windows del /f /s /q 强制递归删除';
    }
  }

  // shell 解释器进入任意命令执行模式（显式高风险类别）
  // P1-4 修复（复审）：interpreter-specific flag 规范化——
  // - cmd：/c /C /k /K（大小写不敏感）
  // - powershell/pwsh：-c、-Command 及前缀缩写（-comm/-co...）、
  //   -EncodedCommand 家族（-e/-en/-enc...，参数可合并如 -enc:xxx）
  // - bash/sh/zsh：-c
  if (SHELL_INTERPRETERS.has(base)) {
    const loweredArgs = args.map((a) => a.toLowerCase());
    const isPowerShell = base === 'powershell' || base === 'pwsh';
    const hasEvalFlag = loweredArgs.some((a) => {
      // 剥离 `:值` 后缀得到参数名（powershell -enc:xxx / -Command:xxx）
      const param = a.split(':')[0];
      if (param === '-c' || param === '/c' || param === '/k') return true; // bash/sh/zsh -c + cmd /c /k
      // powershell -Command 及前缀缩写（-comm/-co...；-Command:xxx 由 param 处理）
      if (param.startsWith('-command') || '-command'.startsWith(param)) return true;
      // -EncodedCommand 家族（-enc.../合并 -enc:xxx；-e 由前缀匹配覆盖）
      if (isPowerShell && (param.startsWith('-enc') || '-encodedcommand'.startsWith(param))) return true;
      return false;
    });
    if (hasEvalFlag) {
      return 'shell 解释器进入任意命令执行模式（-c / /c / -Command / -EncodedCommand）';
    }
  }

  return undefined;
}


// ============================================================
// CommandSandbox 主类
// ============================================================

export class CommandSandbox {
  private readonly options: Required<
    Pick<SandboxOptions, 'timeout' | 'maxOutputBytes'>
  > &
    Pick<
      SandboxOptions,
      'cwd' | 'env' | 'allowedCommands' | 'blockedCommands' | 'workingDirectoryRestriction'
    >;

  constructor(options: SandboxOptions = {}) {
    this.options = {
      cwd: options.cwd ?? process.cwd(),
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      env: options.env,
      allowedCommands: options.allowedCommands,
      blockedCommands: options.blockedCommands,
      workingDirectoryRestriction: options.workingDirectoryRestriction,
    };
  }

  /**
   * 执行命令
   *
   * 流程：
   *   1. validateCommand 静态检查（白名单 / 黑名单 / 危险模式 / 工作目录限制）
   *   2. 通过则 spawn 子进程，传隔离后的 env
   *   3. 监控 stdout / stderr 字节数，超限 kill
   *   4. setTimeout 超时 kill
   *   5. 进程结束后收集结果
   *
   * 校验失败时返回 exitCode=null、stderr 含原因，不抛异常
   */
  async execute(command: string, args: string[] = []): Promise<SandboxResult> {
    const startTime = Date.now();

    // 1) 静态校验（结构化：executable identity 只看 command，危险模式查 command+args）
    // P0 修复（复审）：不得把 args 压扁回 command 再走 validateCommand——
    // 参数路径 basename 会冒充 executable（/tmp/evil /tmp/node 的 whole-basename 是 node）。
    const validation = CommandSandbox.validateExecution(command, args, this.options);
    if (!validation.allowed) {
      const reason = validation.reason ?? '命令被沙箱拒绝';
      logger.warn(`[sandbox] command rejected: ${command} — ${reason}`);
      auditPanel.log({
        level: 'warn',
        source: 'sandbox',
        action: 'blocked',
        target: `${command} ${args.join(' ')}`.trim(),
        reason,
        metadata: { cwd: this.options.cwd },
      });
      return {
        exitCode: null,
        stdout: '',
        stderr: `命令被沙箱拒绝: ${reason}`,
        timedOut: false,
        outputTruncated: false,
        durationMs: Date.now() - startTime,
      };
    }

    // 2) 工作目录二次校验（validateCommand 已检查，这里防御性确认）
    const cwd = this.options.cwd ?? process.cwd();

    // 3) 构造隔离的环境变量：仅 env 中指定的 + PATH
    const spawnEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
    };
    if (process.env.SYSTEMROOT !== undefined) {
      // Windows 上某些命令（cmd.exe）需要 SYSTEMROOT
      spawnEnv.SYSTEMROOT = process.env.SYSTEMROOT;
    }
    if (this.options.env) {
      for (const [k, v] of Object.entries(this.options.env)) {
        spawnEnv[k] = v;
      }
    }

    // 4) spawn 子进程
    return new Promise<SandboxResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd,
          env: spawnEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(`[sandbox] spawn failed: ${command}`, { error: reason });
        auditPanel.log({
          level: 'error',
          source: 'sandbox',
          action: 'logged',
          target: `${command} ${args.join(' ')}`.trim(),
          reason: `spawn 失败: ${reason}`,
        });
        resolve({
          exitCode: null,
          stdout: '',
          stderr: `spawn 失败: ${reason}`,
          timedOut: false,
          outputTruncated: false,
          durationMs: Date.now() - startTime,
        });
        return;
      }

      let stdoutBuf = '';
      let stderrBuf = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let outputTruncated = false;
      let settled = false;

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result: SandboxResult = {
          exitCode,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          timedOut,
          outputTruncated,
          durationMs: Date.now() - startTime,
        };
        auditPanel.log({
          level: timedOut || outputTruncated ? 'warn' : 'info',
          source: 'sandbox',
          action: timedOut || outputTruncated ? 'warned' : 'allowed',
          target: `${command} ${args.join(' ')}`.trim(),
          reason: timedOut
            ? `超时（${this.options.timeout}ms）`
            : outputTruncated
              ? `输出超限（${this.options.maxOutputBytes} bytes）`
              : undefined,
          metadata: { exitCode, durationMs: result.durationMs },
        });
        resolve(result);
      };

      // 超时定时器
      const timer = setTimeout(() => {
        timedOut = true;
        logger.warn(`[sandbox] timeout, killing: ${command}`, {
          timeout: this.options.timeout,
        });
        try {
          child.kill('SIGKILL');
        } catch (e) {
          // 超时 kill 失败（子进程可能已退出），降级为 debug 日志
          logger.debug('[sandbox] timeout kill 失败', {
            command,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }, this.options.timeout);

      // stdout 监控
      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          if (outputTruncated) return;
          stdoutBytes += chunk.length;
          if (stdoutBytes > this.options.maxOutputBytes) {
            outputTruncated = true;
            stdoutBuf += chunk.subarray(0, this.options.maxOutputBytes - stdoutBuf.length).toString('utf8');
            logger.warn(`[sandbox] stdout exceeds maxOutputBytes, killing: ${command}`, {
              bytes: stdoutBytes,
              limit: this.options.maxOutputBytes,
            });
            try {
              child.kill('SIGKILL');
            } catch (e) {
              // stdout 超限 kill 失败（子进程可能已退出），降级为 debug 日志
              logger.debug('[sandbox] stdout 超限 kill 失败', {
                command,
                error: e instanceof Error ? e.message : String(e),
              });
            }
            return;
          }
          stdoutBuf += chunk.toString('utf8');
        });
      }

      // stderr 监控
      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          if (outputTruncated) return;
          stderrBytes += chunk.length;
          if (stderrBytes > this.options.maxOutputBytes) {
            outputTruncated = true;
            stderrBuf += chunk.subarray(0, this.options.maxOutputBytes - stderrBuf.length).toString('utf8');
            logger.warn(`[sandbox] stderr exceeds maxOutputBytes, killing: ${command}`, {
              bytes: stderrBytes,
              limit: this.options.maxOutputBytes,
            });
            try {
              child.kill('SIGKILL');
            } catch (e) {
              // stderr 超限 kill 失败（子进程可能已退出），降级为 debug 日志
              logger.debug('[sandbox] stderr 超限 kill 失败', {
                command,
                error: e instanceof Error ? e.message : String(e),
              });
            }
            return;
          }
          stderrBuf += chunk.toString('utf8');
        });
      }

      // spawn 错误（命令不存在等）
      child.on('error', (err) => {
        if (settled) return;
        stderrBuf += `\nspawn error: ${err.message}`;
        finish(null);
      });

      // 进程退出
      child.on('close', (code) => {
        finish(code);
      });
    });
  }

  /**
   * 静态校验命令是否安全
   *
   * 接受两种形式：
   *   - 纯命令名（如 'node' / '/usr/bin/node'）
   *   - 完整命令行（如 'rm -rf /' / 'node -e "console.log(1)"'）
   *
   * 校验顺序（短路返回）：
   *   1. 命令非空
   *   2. 危险模式检测（拦截 rm -rf / 等破坏性命令，对完整命令行匹配）
   *   3. 白名单（如果设置）：首 token 必须在白名单中
   *   4. 黑名单（如果设置）：首 token 不能在黑名单中
   *   5. 工作目录限制（如果设置）：cwd 必须在限制列表内或其子目录
   */
  static validateCommand(
    command: string,
    options: SandboxOptions,
  ): CommandValidationResult {
    // 1) 非空检查
    if (!command || typeof command !== 'string' || command.trim() === '') {
      return { allowed: false, reason: '命令为空' };
    }

    // P0 修复（复审）：executable identity 只来自首 token——**移除整条命令的
    // basename 匹配**（cmdNameFromWhole）：`allowed:['node']` 时 `/tmp/evil /tmp/node`
    // 的 whole-basename 是 'node' → 放行，参数路径可冒充 executable（P0 安全绕过）。
    const identity = normalizeExecutableIdentity(command);
    const firstToken = identity.token;
    const cmdNameFromFirst = identity.canonicalName;
    // 去掉 Windows 可执行文件扩展名（.exe / .cmd / .bat）

    // 2) 危险模式检测（对完整命令行匹配；fork bomb 等 regex 保留为 defense-in-depth）
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `命中危险命令模式: ${pattern.source}`,
        };
      }
    }
    // 第九轮复审：结构化危险策略（basename 归一——/sbin/shutdown 与 shutdown 等价；
    // 字符串接口从 command 剩余部分解析参数供 dd of=/dev/*、bash -c 等语义检查）
    const restArgs = command.slice(firstToken.length).trim();
    const structuredReason = checkDangerousPolicy(
      cmdNameFromFirst,
      firstToken,
      restArgs.length > 0 ? restArgs.split(/\s+/) : [],
    );
    if (structuredReason) {
      return { allowed: false, reason: structuredReason };
    }

    // 3) 白名单检查（只认 executable identity——首 token）
    const allowed = options.allowedCommands;
    if (allowed && allowed.length > 0) {
      const allowedLower = allowed.map((c) => c.toLowerCase());
      const matched = allowedLower.some(
        (c) =>
          c === cmdNameFromFirst ||
          c === cmdNameFromFirst ||
          c === firstToken.toLowerCase(),
      );
      if (!matched) {
        return {
          allowed: false,
          reason: `命令 "${firstToken}" 不在白名单中`,
        };
      }
    }

    // 4) 黑名单检查（只认 executable identity——首 token）
    const blocked = options.blockedCommands;
    if (blocked && blocked.length > 0) {
      const blockedLower = blocked.map((c) => c.toLowerCase());
      const matched = blockedLower.some(
        (c) =>
          c === cmdNameFromFirst ||
          c === cmdNameFromFirst ||
          c === firstToken.toLowerCase(),
      );
      if (matched) {
        return {
          allowed: false,
          reason: `命令 "${firstToken}" 在黑名单中`,
        };
      }
    }

    // 5) 工作目录限制
    const restrictions = options.workingDirectoryRestriction;
    if (restrictions && restrictions.length > 0) {
      const cwd = options.cwd ?? process.cwd();
      const resolvedCwd = path.resolve(cwd);
      const ok = restrictions.some((dir) => {
        const resolvedDir = path.resolve(dir);
        if (resolvedCwd === resolvedDir) return true;
        const rel = path.relative(resolvedDir, resolvedCwd);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!ok) {
        return {
          allowed: false,
          reason: `工作目录 "${cwd}" 不在允许列表中`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * P0 修复（复审）：结构化执行校验——executable identity 与 command semantics 分离。
   * - executable 白/黑名单：只看 command（spawn 的真实可执行文件），args 永不参与
   * - 危险模式：检查 command + args 拼接（args 中的 rm -rf 等仍需拦截）
   * - 工作目录限制：与 validateCommand 一致
   */
  static validateExecution(
    command: string,
    args: readonly string[],
    options: SandboxOptions,
  ): CommandValidationResult {
    if (!command || typeof command !== 'string' || command.trim() === '') {
      return { allowed: false, reason: '命令为空' };
    }
    // executable identity：只看 command（spawn 的真实可执行文件）——
    // 结构化入口：command 即完整 executable（含空格路径不需要引号）
    const identity = normalizeExecutableIdentity(command, { wholeAsExecutable: true });
    const firstToken = identity.token;
    const cmdName = identity.canonicalName;

    // 危险模式：对完整语义（command + args）匹配
    const full = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(full)) {
        return {
          allowed: false,
          reason: `命中危险命令模式: ${pattern.source}`,
        };
      }
    }
    // 第九轮复审：结构化危险策略（basename 归一 + 参数语义：
    // dd of=/dev/*、format C:、del /f/s/q、shell -c）
    const structuredReason = checkDangerousPolicy(cmdName, firstToken, args);
    if (structuredReason) {
      return { allowed: false, reason: structuredReason };
    }

    // 白名单（只认 executable）
    const allowed = options.allowedCommands;
    if (allowed && allowed.length > 0) {
      const allowedLower = allowed.map((c) => c.toLowerCase());
      const matched = allowedLower.some(
        (c) => c === cmdName || c === cmdName || c === firstToken.toLowerCase(),
      );
      if (!matched) {
        return {
          allowed: false,
          reason: `命令 "${firstToken}" 不在白名单中`,
        };
      }
    }

    // 黑名单（只认 executable）
    const blocked = options.blockedCommands;
    if (blocked && blocked.length > 0) {
      const blockedLower = blocked.map((c) => c.toLowerCase());
      const matched = blockedLower.some(
        (c) => c === cmdName || c === cmdName || c === firstToken.toLowerCase(),
      );
      if (matched) {
        return {
          allowed: false,
          reason: `命令 "${firstToken}" 在黑名单中`,
        };
      }
    }

    // 工作目录限制
    const restrictions = options.workingDirectoryRestriction;
    if (restrictions && restrictions.length > 0) {
      const cwd = options.cwd ?? process.cwd();
      const resolvedCwd = path.resolve(cwd);
      const ok = restrictions.some((r) => {
        const resolved = path.resolve(r);
        return resolvedCwd === resolved || resolvedCwd.startsWith(resolved + path.sep);
      });
      if (!ok) {
        return {
          allowed: false,
          reason: `工作目录 "${cwd}" 不在允许列表中`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 实例方法：校验命令是否允许执行（委托给静态方法，使用实例的 options）
   */
  validate(command: string): CommandValidationResult {
    return CommandSandbox.validateCommand(command, this.options);
  }
}
