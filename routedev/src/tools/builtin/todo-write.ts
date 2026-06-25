// src/tools/builtin/todo-write.ts
// TodoWrite 工具：任务列表管理
// P1-5：Codex/Claude Code 都有 TodoWrite 工具，RouteDev 缺失
//
// 支持操作：
//   - add：添加待办项
//   - update：更新待办项（内容/状态/优先级）
//   - delete：删除待办项
//   - list：列出所有待办项
//   - clear：清空所有待办项
//
// 状态通过注入的 TodoStore 维护（单会话内存）

import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { TodoStore } from './todo-store.js';

export class TodoWriteTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'todo_write',
    description: '当用户需要管理任务列表、追踪长任务的进度、防止 Agent 迷失方向时，使用此工具。支持添加、更新状态、删除、列出待办项。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'update', 'delete', 'list', 'clear'],
          description: '操作类型',
        },
        id: {
          type: 'string',
          description: '待办项 ID（update/delete 时必填）',
        },
        content: {
          type: 'string',
          description: '待办项内容（add 时必填，update 时可选）',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: '待办项状态（update 时可选）',
        },
        priority: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: '优先级（add/update 时可选，默认 medium）',
        },
      },
      required: ['action'],
    },
    requiresApproval: false,
    category: 'system',
  };

  private store: TodoStore;

  constructor(store: TodoStore) {
    this.store = store;
  }

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const validActions = ['add', 'update', 'delete', 'list', 'clear'];

    if (!args.action || typeof args.action !== 'string') {
      errors.push('缺少必需参数: action');
    } else if (!validActions.includes(args.action)) {
      errors.push(`无效的 action: ${args.action}`);
    }

    const action = args.action as string;

    if (action === 'add' && (!args.content || typeof args.content !== 'string')) {
      errors.push('add 操作需要 content 参数');
    }

    if ((action === 'update' || action === 'delete') && (!args.id || typeof args.id !== 'string')) {
      errors.push(`${action} 操作需要 id 参数`);
    }

    if (args.status !== undefined && !['pending', 'in_progress', 'completed'].includes(args.status as string)) {
      errors.push('status 必须是 pending/in_progress/completed 之一');
    }

    if (args.priority !== undefined && !['high', 'medium', 'low'].includes(args.priority as string)) {
      errors.push('priority 必须是 high/medium/low 之一');
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const action = args.action as string;

    try {
      switch (action) {
        case 'add': {
          const item = this.store.add(
            args.content as string,
            (args.priority as 'high' | 'medium' | 'low') ?? 'medium',
          );
          return {
            success: true,
            output: `已添加待办项 [${item.id}] (${item.priority}): ${item.content}`,
            durationMs: 0,
            metadata: { item },
          };
        }

        case 'update': {
          const updates: Record<string, unknown> = {};
          if (args.content !== undefined) updates.content = args.content;
          if (args.status !== undefined) updates.status = args.status;
          if (args.priority !== undefined) updates.priority = args.priority;

          const item = this.store.update(args.id as string, updates as never);
          if (!item) {
            return {
              success: false,
              output: '',
              error: `待办项 ${args.id} 不存在`,
              durationMs: 0,
            };
          }
          return {
            success: true,
            output: `已更新待办项 [${item.id}]: 状态=${item.status}, 优先级=${item.priority}, 内容=${item.content}`,
            durationMs: 0,
            metadata: { item },
          };
        }

        case 'delete': {
          const deleted = this.store.delete(args.id as string);
          if (!deleted) {
            return {
              success: false,
              output: '',
              error: `待办项 ${args.id} 不存在`,
              durationMs: 0,
            };
          }
          return {
            success: true,
            output: `已删除待办项 ${args.id}`,
            durationMs: 0,
          };
        }

        case 'list': {
          const snapshot = this.store.getSnapshot();
          if (snapshot.total === 0) {
            return {
              success: true,
              output: '待办列表为空',
              durationMs: 0,
              metadata: snapshot as unknown as Record<string, unknown>,
            };
          }

          const formatted = snapshot.items
            .map((item, i) => {
              const statusIcon = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]';
              const priorityTag = item.priority === 'high' ? ' (高)' : item.priority === 'low' ? ' (低)' : '';
              return `${i + 1}. ${statusIcon} ${item.id}${priorityTag}: ${item.content}`;
            })
            .join('\n');

          const summary = `\n\n总计: ${snapshot.total} | 进行中: ${snapshot.inProgress} | 待处理: ${snapshot.pending} | 已完成: ${snapshot.completed}`;

          return {
            success: true,
            output: formatted + summary,
            durationMs: 0,
            metadata: snapshot as unknown as Record<string, unknown>,
          };
        }

        case 'clear': {
          this.store.clear();
          return {
            success: true,
            output: '已清空所有待办项',
            durationMs: 0,
          };
        }

        default:
          return {
            success: false,
            output: '',
            error: `不支持的操作: ${action}`,
            durationMs: 0,
          };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `TodoWrite 操作失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
