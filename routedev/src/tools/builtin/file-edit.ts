// src/tools/builtin/file-edit.ts
// 文件编辑工具：精确字符串替换，避免全量重写
// P1-4：Codex/Claude Code 都有 str_replace/edit_file 工具，RouteDev 缺失
//
// 支持两种模式：
//   1. str_replace：精确替换文件中的字符串片段（oldString → newString）
//   2. str_replace_many：批量替换多组字符串（edits 数组）
//
// 安全特性：
//   - oldString 必须在文件中唯一匹配，否则拒绝（防止误改多处）
//   - 文件不存在时返回错误（不自动创建，创建用 file_write）
//   - 替换前备份原内容到内存（失败可回滚，但不持久化）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { checkPathBoundary } from './search-utils.js';

/** 单条替换编辑 */
interface EditEntry {
  oldString: string;
  newString: string;
}

/** P2-1：最大编辑文件大小（1MB），防止大文件 OOM */
const MAX_EDIT_FILE_BYTES = 1024 * 1024;

export class FileEditTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'file_edit',
    description: '当用户需要精确修改文件中的某段字符串、避免全量重写时，使用此工具。要求 oldString 在文件中唯一匹配，支持批量替换。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对于项目根目录）',
        },
        oldString: {
          type: 'string',
          description: '要替换的旧字符串（必须在文件中唯一匹配）',
        },
        newString: {
          type: 'string',
          description: '替换后的新字符串',
        },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldString: { type: 'string' },
              newString: { type: 'string' },
            },
            required: ['oldString', 'newString'],
          },
          description: '批量替换列表（与 oldString/newString 二选一）',
        },
      },
      required: ['path'],
    },
    requiresApproval: true,
    category: 'file',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.path || typeof args.path !== 'string') {
      errors.push('缺少必需参数: path');
    }

    const hasSingle = typeof args.oldString === 'string' && typeof args.newString === 'string';
    const hasBatch = Array.isArray(args.edits);

    if (!hasSingle && !hasBatch) {
      errors.push('必须提供 oldString+newString 或 edits 数组');
    }
    if (hasSingle && hasBatch) {
      errors.push('oldString+newString 和 edits 不能同时使用');
    }

    if (hasBatch) {
      const edits = args.edits as unknown[];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i] as Record<string, unknown>;
        if (typeof e.oldString !== 'string' || typeof e.newString !== 'string') {
          errors.push(`edits[${i}] 必须包含 oldString 和 newString 字符串`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = path.resolve(context.workingDirectory, args.path as string);

    // C1 修复：内部路径边界校验（防御性深度防御）
    const boundaryError = checkPathBoundary(filePath, context);
    if (boundaryError) {
      return {
        success: false,
        output: '',
        error: boundaryError,
        durationMs: 0,
      };
    }

    // 解析替换列表
    let edits: EditEntry[];
    if (Array.isArray(args.edits)) {
      edits = args.edits as EditEntry[];
    } else {
      edits = [{
        oldString: args.oldString as string,
        newString: args.newString as string,
      }];
    }

    try {
      // P2-1：读取前检查文件大小，防止大文件 OOM
      const preStats = await fs.stat(filePath);
      if (preStats.size > MAX_EDIT_FILE_BYTES) {
        return {
          success: false,
          output: '',
          error: `文件过大: ${preStats.size} 字节（上限 ${MAX_EDIT_FILE_BYTES} 字节）。file_edit 仅支持编辑 1MB 以内的文件。`,
          durationMs: 0,
          metadata: { fileSize: preStats.size, maxBytes: MAX_EDIT_FILE_BYTES },
        };
      }

      // 读取原文件内容
      const original = await fs.readFile(filePath, 'utf-8');

      // 逐条应用替换
      let modified = original;
      const appliedEdits: Array<{ oldString: string; replaced: boolean }> = [];

      for (const edit of edits) {
        const { oldString, newString } = edit;

        // 空字符串不允许作为 oldString
        if (oldString.length === 0) {
          return {
            success: false,
            output: '',
            error: 'oldString 不能为空字符串',
            durationMs: 0,
          };
        }

        // 修复：唯一性校验基于 original 内容，避免前序替换影响后续校验
        const matchCount = original.split(oldString).length - 1;

        if (matchCount === 0) {
          return {
            success: false,
            output: '',
            error: `oldString 在文件中未找到匹配。请检查 oldString 是否正确（注意空白字符和缩进）。`,
            durationMs: 0,
            metadata: { filePath, failedEdit: oldString.slice(0, 80) },
          };
        }

        if (matchCount > 1) {
          return {
            success: false,
            output: '',
            error: `oldString 在文件中有 ${matchCount} 处匹配，必须唯一。请提供更多上下文使匹配唯一。`,
            durationMs: 0,
            metadata: { filePath, matchCount, failedEdit: oldString.slice(0, 80) },
          };
        }

        // 唯一匹配，执行替换（替换仍作用于 modified）
        modified = modified.replace(oldString, newString);
        appliedEdits.push({ oldString: oldString.slice(0, 60), replaced: true });
      }

      // 内容未变化
      if (modified === original) {
        return {
          success: true,
          output: '文件内容未变化（oldString 和 newString 相同）',
          durationMs: 0,
          metadata: { filePath, editsApplied: 0 },
        };
      }

      // 写回文件
      await fs.writeFile(filePath, modified, 'utf-8');

      const stats = await fs.stat(filePath);
      const lines = modified.split('\n').length;

      return {
        success: true,
        output: `文件编辑成功: ${args.path} (应用 ${appliedEdits.length} 处替换, ${lines} 行, ${stats.size} 字节)`,
        durationMs: 0,
        metadata: {
          filePath,
          editsApplied: appliedEdits.length,
          appliedEdits,
          bytes: stats.size,
          lines,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 文件不存在的特殊提示
      if (msg.includes('ENOENT')) {
        return {
          success: false,
          output: '',
          error: `文件不存在: ${args.path}。如需创建新文件，请使用 file_write 工具。`,
          durationMs: 0,
        };
      }
      return {
        success: false,
        output: '',
        error: `编辑文件失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
