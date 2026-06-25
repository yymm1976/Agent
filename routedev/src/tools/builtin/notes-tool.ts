// src/tools/builtin/notes-tool.ts
// notes 工具：Agent 唯一写通道（蓝图 Section X.1）
// 让 Agent 在推理过程中将自由格式笔记追加到 notes.md
// CheckpointWriter 在 checkpoint 时读取并分类
//
// 权限：auto（无需确认，因为只写 session 目录下的 notes.md，不影响项目文件）

import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { NotesManager } from '../../agent/memory/notes.js';

/**
 * notes 工具：Agent 追加笔记到 notes.md
 *
 * 工具参数：
 *   - content: 要追加的笔记内容（必填）
 *   - category: 笔记类别（可选，如 'discovery' / 'decision' / 'error' / 'todo'）
 *
 * 工具会自动在笔记前添加时间戳和类别标签。
 */
export class NotesTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'notes',
    description: '当用户需要记录发现、决策、错误或待办事项到 notes.md 时，使用此工具。这是 Agent 唯一的写通道，CheckpointWriter 会在 checkpoint 时读取并分类。',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '要追加的笔记内容（自由格式）',
        },
        category: {
          type: 'string',
          description: '笔记类别（可选）：discovery / decision / error / todo / misc',
        },
      },
      required: ['content'],
    },
    requiresApproval: false,
    category: 'system',
  };

  private notesManager: NotesManager;

  constructor(notesManager: NotesManager) {
    this.notesManager = notesManager;
  }

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.content || typeof args.content !== 'string') {
      errors.push('缺少必需参数: content');
    }
    if (args.category !== undefined && typeof args.category !== 'string') {
      errors.push('category 必须是字符串');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const content = args.content as string;
    const category = (args.category as string) ?? 'misc';

    try {
      // 格式化笔记条目：[时间戳] [类别] 内容
      const timestamp = new Date().toISOString();
      const formattedEntry = `[${timestamp}] [${category}] ${content}`;
      await this.notesManager.append(formattedEntry);

      const size = await this.notesManager.size();
      return {
        success: true,
        output: `笔记已追加到 notes.md (类别: ${category}, 当前文件大小: ${size} 字节)`,
        durationMs: 0,
        metadata: { category, fileSize: size },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `追加笔记失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
