// src/tools/builtin/list-directory.ts
// 目录列表工具：列出指定目录下的文件和子目录
// P0-2：work-modes.ts 引用了 list_directory 但无实现，此工具补全该引用
//
// 权限：auto（只读操作，无需确认）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { checkPathBoundary } from './search-utils.js';

/** 单个目录条目 */
interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
}

export class ListDirectoryTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'list_directory',
    description: '当用户需要查看目录下的文件和子目录结构时，使用此工具。返回名称、类型和大小，支持可选的递归模式。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径（相对于项目根目录，默认为根目录）',
        },
        recursive: {
          type: 'boolean',
          description: '是否递归列出子目录（默认 false，仅列出当前目录）',
        },
        maxDepth: {
          type: 'number',
          description: '递归模式下的最大深度（默认 3）',
        },
      },
      required: [],
    },
    requiresApproval: false,
    category: 'file',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (args.path !== undefined && typeof args.path !== 'string') {
      errors.push('path 必须是字符串');
    }
    if (args.recursive !== undefined && typeof args.recursive !== 'boolean') {
      errors.push('recursive 必须是布尔值');
    }
    if (args.maxDepth !== undefined && typeof args.maxDepth !== 'number') {
      errors.push('maxDepth 必须是数字');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const dirPath = path.resolve(context.workingDirectory, (args.path as string) ?? '.');
    const recursive = (args.recursive as boolean) ?? false;
    const maxDepth = (args.maxDepth as number) ?? 3;

    // C1 修复：内部路径边界校验（防御性深度防御）
    const boundaryError = checkPathBoundary(dirPath, context);
    if (boundaryError) {
      return {
        success: false,
        output: '',
        error: boundaryError,
        durationMs: 0,
      };
    }

    try {
      if (recursive) {
        const tree = await this.listRecursive(dirPath, 0, maxDepth);
        const formatted = this.formatTree(tree, '');
        return {
          success: true,
          output: formatted,
          durationMs: 0,
          metadata: { path: args.path ?? '.', recursive: true, maxDepth },
        };
      }

      const entries = await this.listDir(dirPath);
      const formatted = entries
        .map((e, i) => `${i + 1}. [${e.type}] ${e.name} (${e.size} 字节)`)
        .join('\n');

      return {
        success: true,
        output: formatted || '目录为空',
        durationMs: 0,
        metadata: { path: args.path ?? '.', entryCount: entries.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `列出目录失败: ${msg}`,
        durationMs: 0,
      };
    }
  }

  /** 列出单个目录的内容 */
  private async listDir(dirPath: string): Promise<DirEntry[]> {
    const names = await fs.readdir(dirPath);
    const entries: DirEntry[] = [];

    for (const name of names) {
      const fullPath = path.join(dirPath, name);
      try {
        const lstat = await fs.lstat(fullPath);
        let type: DirEntry['type'] = 'file';
        if (lstat.isDirectory()) type = 'directory';
        else if (lstat.isSymbolicLink()) type = 'symlink';
        entries.push({ name, type, size: lstat.size });
      } catch {
        // lstat 失败（可能是 broken symlink），跳过
      }
    }

    // 目录优先，然后按名称排序
    entries.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    return entries;
  }

  /** 递归列出目录树 */
  private async listRecursive(
    dirPath: string,
    currentDepth: number,
    maxDepth: number,
  ): Promise<DirEntry[]> {
    const entries = await this.listDir(dirPath);
    const result: DirEntry[] = [...entries];

    if (currentDepth < maxDepth) {
      for (const entry of entries) {
        if (entry.type === 'directory') {
          const subPath = path.join(dirPath, entry.name);
          const subEntries = await this.listRecursive(subPath, currentDepth + 1, maxDepth);
          // 用缩进前缀标识子目录内容
          for (const sub of subEntries) {
            result.push({
              name: `${entry.name}/${sub.name}`,
              type: sub.type,
              size: sub.size,
            });
          }
        }
      }
    }

    return result;
  }

  /** 格式化树形输出 */
  private formatTree(entries: DirEntry[], prefix: string): string {
    return entries
      .map((e, i) => {
        const isLast = i === entries.length - 1;
        const marker = isLast ? '└── ' : '├── ';
        return `${prefix}${marker}[${e.type}] ${e.name} (${e.size} 字节)`;
      })
      .join('\n');
  }
}
