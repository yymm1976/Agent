// src/tools/builtin/code-search.ts
// 代码搜索工具（优先 ripgrep，回退 JS 递归）
// 权限：auto
// Phase 29 Task 5：提取 walkDir/isIgnoredPath/matchGlob 到 search-utils.ts（修复 A4）

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { walkDir, isIgnoredPath, matchGlob } from './search-utils.js';

export class CodeSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'code_search',
    description: '搜索代码内容。优先使用 ripgrep（如可用），否则回退到 JS 实现。支持正则表达式。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '搜索模式（支持正则）',
        },
        path: {
          type: 'string',
          description: '搜索路径（可选，默认项目根目录）',
        },
        filePattern: {
          type: 'string',
          description: '文件名模式（如 "*.ts"，可选）',
        },
        maxResults: {
          type: 'number',
          description: '最大返回结果数（默认 20）',
        },
      },
      required: ['pattern'],
    },
    requiresApproval: false,
    category: 'code',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.pattern || typeof args.pattern !== 'string') {
      errors.push('缺少必需参数: pattern');
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
    const pattern = args.pattern as string;
    const searchPath = args.path
      ? path.resolve(context.workingDirectory, args.path as string)
      : context.workingDirectory;
    const filePattern = args.filePattern as string | undefined;
    const maxResults = (args.maxResults as number) ?? 20;

    // 路径边界校验：防止路径遍历攻击（如 ../../etc/passwd）
    const allowedDirs = context.allowedDirectories ?? [context.workingDirectory];
    const isAllowed = allowedDirs.some(dir =>
      searchPath === dir || searchPath.startsWith(dir + path.sep),
    );
    if (!isAllowed) {
      return {
        success: false,
        output: '',
        error: `搜索路径超出项目边界: ${args.path ?? searchPath}`,
        durationMs: 0,
      };
    }

    try {
      const hasRipgrep = await this.checkRipgrep();

      let output = '';
      if (hasRipgrep) {
        output = await this.searchWithRipgrep(pattern, searchPath, filePattern, maxResults);
      } else {
        output = await this.searchWithJs(pattern, searchPath, filePattern, maxResults);
      }

      return {
        success: true,
        output: output || '未找到匹配结果',
        durationMs: 0,
        metadata: { usedRipgrep: hasRipgrep },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `代码搜索失败: ${msg}`,
        durationMs: 0,
      };
    }
  }

  private checkRipgrep(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('rg', ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  private searchWithRipgrep(
    pattern: string,
    searchPath: string,
    filePattern: string | undefined,
    maxResults: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--line-number',
        '--no-heading',
        '--max-count', String(Math.ceil(maxResults / 2)),
        '--glob', '!**/node_modules/**',
        '--glob', '!**/.git/**',
        '--glob', '!**/dist/**',
        pattern,
      ];

      if (filePattern) {
        args.push('--glob', filePattern);
      }

      args.push(searchPath);

      let output = '';
      let stderr = '';
      const child = spawn('rg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString('utf-8');
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf-8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0 && code !== 1) { // ripgrep 1 = no matches
          reject(new Error(stderr || `rg exited with ${code}`));
        } else {
          const lines = output.split('\n').filter(Boolean).slice(0, maxResults);
          resolve(lines.join('\n'));
        }
      });
    });
  }

  private async searchWithJs(
    pattern: string,
    searchPath: string,
    filePattern: string | undefined,
    maxResults: number,
  ): Promise<string> {
    const regex = new RegExp(pattern);
    const results: string[] = [];
    const files = await walkDir(searchPath, maxResults * 5);

    for (const filePath of files) {
      if (results.length >= maxResults) break;

      const relativePath = path.relative(searchPath, filePath);
      const fileName = path.basename(filePath);

      if (isIgnoredPath(relativePath)) continue;
      if (filePattern && !matchGlob(filePattern, fileName)) continue;

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${relativePath}:${i + 1}:${lines[i].trim()}`);
            if (results.length >= maxResults) break;
          }
        }
      } catch {
        // skip
      }
    }

    return results.join('\n');
  }
}
