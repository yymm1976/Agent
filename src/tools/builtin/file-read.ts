// src/tools/builtin/file-read.ts
// 读取文件内容
// 权限：auto（自动执行，无需确认）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class FileReadTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'file_read',
    description: '读取文件内容。支持指定行号范围。返回文件的文本内容。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对于项目根目录）',
        },
        startLine: {
          type: 'number',
          description: '起始行号（可选，从 1 开始）',
        },
        endLine: {
          type: 'number',
          description: '结束行号（可选，包含该行）',
        },
      },
      required: ['path'],
    },
    requiresApproval: false,
    category: 'file',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.path || typeof args.path !== 'string') {
      errors.push('缺少必需参数: path');
    }
    if (args.startLine !== undefined && typeof args.startLine !== 'number') {
      errors.push('startLine 必须是数字');
    }
    if (args.endLine !== undefined && typeof args.endLine !== 'number') {
      errors.push('endLine 必须是数字');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = path.resolve(context.workingDirectory, args.path as string);
    const startLine = (args.startLine as number) ?? 1;
    const endLine = args.endLine as number | undefined;

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // 如果有行号范围，截取指定行
      if (startLine > 1 || endLine) {
        const lines = content.split('\n');
        const start = Math.max(0, startLine - 1);
        const end = endLine ? Math.min(lines.length, endLine) : lines.length;
        const sliced = lines.slice(start, end);

        const numbered = sliced.map((line, i) =>
          `${String(start + i + 1).padStart(4)} | ${line}`,
        ).join('\n');

        return {
          success: true,
          output: numbered,
          durationMs: 0,
          metadata: { totalLines: lines.length, shownLines: sliced.length },
        };
      }

      const lines = content.split('\n');
      const numbered = lines.map((line, i) =>
        `${String(i + 1).padStart(4)} | ${line}`,
      ).join('\n');

      return {
        success: true,
        output: numbered,
        durationMs: 0,
        metadata: { totalLines: lines.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `读取文件失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
