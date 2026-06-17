// src/tools/builtin/shell-exec.ts
// 执行 Shell 命令
// 权限：confirm

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

const MAX_STDOUT = 100 * 1024;
const MAX_STDERR = 50 * 1024;

export class ShellExecTool implements ITool {
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

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      // 根据平台选择 shell
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWin ? ['/c', command] : ['-c', command];

      const child = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env, ...context.environment },
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
