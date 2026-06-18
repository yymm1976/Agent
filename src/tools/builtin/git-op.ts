// src/tools/builtin/git-op.ts
// Git 操作工具
// 权限：confirm（写操作）/ auto（读操作），实际由 PermissionChecker 规则控制

import simpleGit, { type SimpleGit } from 'simple-git';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class GitOpTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'git_op',
    description: '执行 Git 操作。支持 status、log、diff、add、commit、push、pull。',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['status', 'log', 'diff', 'add', 'commit', 'push', 'pull'],
          description: 'Git 操作类型',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '操作参数',
        },
      },
      required: ['operation'],
    },
    requiresApproval: true,
    category: 'git',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const validOps = ['status', 'log', 'diff', 'add', 'commit', 'push', 'pull'];
    if (!args.operation || typeof args.operation !== 'string') {
      errors.push('缺少必需参数: operation');
    } else if (!validOps.includes(args.operation)) {
      errors.push(`无效的 operation: ${args.operation}`);
    }
    if (args.args !== undefined && !Array.isArray(args.args)) {
      errors.push('args 必须是字符串数组');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const operation = args.operation as string;
    const opArgs = (args.args as string[]) ?? [];

    try {
      const git: SimpleGit = simpleGit(context.workingDirectory);
      let output = '';

      switch (operation) {
        case 'status': {
          const status = await git.status();
          output = JSON.stringify(status, null, 2);
          break;
        }
        case 'log': {
          const log = await git.log(opArgs.length > 0 ? opArgs : ['-10']);
          output = log.all.map(c => `${c.hash.slice(0, 7)} ${c.date} ${c.message}`).join('\n');
          break;
        }
        case 'diff': {
          output = await git.diff(opArgs);
          break;
        }
        case 'add': {
          await git.add(opArgs.length > 0 ? opArgs : ['.']);
          output = `已添加文件: ${opArgs.length > 0 ? opArgs.join(', ') : '全部'}`;
          break;
        }
        case 'commit': {
          const message = opArgs[0];
          if (!message) {
            return {
              success: false,
              output: '',
              error: 'commit 操作需要提供提交信息',
              durationMs: 0,
            };
          }
          const result = await git.commit(message, opArgs.slice(1));
          output = `提交成功: ${result.commit}`;
          break;
        }
        case 'push': {
          const pushResult = await git.push(opArgs);
          output = `推送成功: ${pushResult.repo}-${pushResult.ref?.local ?? 'unknown'}`;
          break;
        }
        case 'pull': {
          const pullResult = await git.pull();
          output = `拉取成功: ${JSON.stringify(pullResult.summary, null, 2)}`;
          break;
        }
        default:
          return {
            success: false,
            output: '',
            error: `不支持的 Git 操作: ${operation}`,
            durationMs: 0,
          };
      }

      return {
        success: true,
        output,
        durationMs: 0,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `Git 操作失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
