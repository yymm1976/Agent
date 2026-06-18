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

const MAX_STDOUT = 100 * 1024;
const MAX_STDERR = 50 * 1024;

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

export class ShellExecTool implements ITool {
  // 熔断器：连续失败 5 次后开路 30 秒，防止系统不稳定
  private circuit = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 });
  // 重试策略：shell 命令通常有副作用，默认不重试（maxRetries=0），仅启用熔断
  private retry = new RetryPolicy({ maxRetries: 0 });

  readonly definition: ToolDefinition = {
    name: 'shell_exec',
    description: '执行 Shell 命令。返回命令的标准输出和标准错误。超时时间由 context 控制。',
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
    const timeoutMs = (args.timeoutMs as number) ?? context.timeoutMs ?? 30000;

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
        error: `命令执行被熔断器阻止或重试耗尽: ${msg}`,
        durationMs: 0,
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
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWin ? ['/c', command] : ['-c', command];

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

      const child = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env, ...filteredEnv },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });

      const timeout = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        // 5 秒后强制 kill
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < MAX_STDOUT) {
          stdout += data.toString('utf-8');
          if (stdout.length > MAX_STDOUT) {
            stdout = stdout.slice(0, MAX_STDOUT) + '\n[输出已截断]';
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < MAX_STDERR) {
          stderr += data.toString('utf-8');
          if (stderr.length > MAX_STDERR) {
            stderr = stderr.slice(0, MAX_STDERR) + '\n[错误输出已截断]';
          }
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          output: '',
          error: `启动命令失败: ${error.message}`,
          durationMs: 0,
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);

        if (killed) {
          resolve({
            success: false,
            output: stdout,
            error: `命令执行超时（>${timeoutMs}ms）`,
            durationMs: 0,
          });
          return;
        }

        const output = [
          stdout ? `stdout:\n${stdout}` : '',
          stderr ? `stderr:\n${stderr}` : '',
          code !== null ? `[退出码: ${code}]` : `[信号: ${signal}]`,
        ].filter(Boolean).join('\n\n');

        resolve({
          success: code === 0,
          output,
          error: code !== 0 && !stderr ? `命令退出码非零: ${code}` : undefined,
          durationMs: 0,
          metadata: { exitCode: code, signal },
        });
      });
    });
  }
}
