// src/tools/builtin/file-search.ts
// 搜索文件内容或按名称查找文件
// 权限：auto

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class FileSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'file_search',
    description: '搜索文件。支持按内容搜索（grep）或按文件名模式（glob）查找。返回匹配的文件路径和行号。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（内容搜索）',
        },
        pattern: {
          type: 'string',
          description: '文件名 glob 模式（如 "*.ts"、"*.test.*"）',
        },
        maxResults: {
          type: 'number',
          description: '最大返回结果数（默认 20）',
        },
      },
      required: [],
    },
    requiresApproval: false,
    category: 'search',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.query && !args.pattern) {
      errors.push('至少需要提供 query（内容搜索）或 pattern（文件名搜索）之一');
    }
    if (args.maxResults !== undefined && typeof args.maxResults !== 'number') {
      errors.push('maxResults 必须是数字');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = args.query as string | undefined;
    const pattern = args.pattern as string | undefined;
    const maxResults = (args.maxResults as number) ?? 20;

    try {
      const results: string[] = [];
      const files = await this.walkDir(context.workingDirectory, maxResults * 5);

      for (const filePath of files) {
        if (results.length >= maxResults) break;

        const relativePath = path.relative(context.workingDirectory, filePath);
        const fileName = path.basename(filePath);

        if (this.isIgnoredPath(relativePath)) continue;

        if (pattern && !this.matchGlob(fileName, pattern)) continue;

        if (query) {
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            const matches: string[] = [];

            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                matches.push(`  ${i + 1}: ${lines[i].trim().slice(0, 100)}`);
                if (matches.length >= 3) break;
              }
            }

            if (matches.length > 0) {
              results.push(`${relativePath}\n${matches.join('\n')}`);
            }
          } catch {
            // 二进制文件或权限不足，跳过
          }
        } else {
          results.push(relativePath);
        }
      }

      if (results.length === 0) {
        return {
          success: true,
          output: '未找到匹配结果',
          durationMs: 0,
        };
      }

      return {
        success: true,
        output: `找到 ${results.length} 个结果:\n\n${results.join('\n\n')}`,
        durationMs: 0,
        metadata: { resultCount: results.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `搜索失败: ${msg}`,
        durationMs: 0,
      };
    }
  }

  private async walkDir(dir: string, maxFiles: number): Promise<string[]> {
    const files: string[] = [];

    async function walk(currentDir: string): Promise<void> {
      if (files.length >= maxFiles) return;

      let entries;
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
          await walk(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    await walk(dir);
    return files;
  }

  private isIgnoredPath(relativePath: string): boolean {
    const ignored = ['node_modules', '.git', 'dist', '.next', 'coverage', '__pycache__'];
    return ignored.some(dir => relativePath.startsWith(dir + path.sep) || relativePath.includes(path.sep + dir + path.sep));
  }

  private matchGlob(fileName: string, pattern: string): boolean {
    const regex = new RegExp(
      '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return regex.test(fileName);
  }
}
