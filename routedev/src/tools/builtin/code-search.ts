// src/tools/builtin/code-search.ts
// 代码搜索工具（优先 ripgrep，回退 JS 递归）
// 权限：auto
// Phase 29 Task 5：提取 walkDir/isIgnoredPath/matchGlob 到 search-utils.ts（修复 A4）

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { walkDir, isIgnoredPath, matchGlob, checkPathBoundary } from './search-utils.js';
import { logger } from '../../utils/logger.js';

export class CodeSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'code_search',
    description: '用正则搜索代码内容、定位符号或模式的实现位置（优先 ripgrep，回退 JS 实现）。需要按文件名找文件或简单文本关键词时改用 file_search。',
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

    // F-020 修复：统一使用 checkPathBoundary 进行路径边界校验（与其他文件工具一致）
    const boundaryError = checkPathBoundary(searchPath, context);
    if (boundaryError) {
      return {
        success: false,
        output: '',
        error: boundaryError,
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
      let child;
      try {
        child = spawn('rg', ['--version'], {
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
        });
      } catch {
        // 受限环境可能在 spawn 同步阶段抛出 EPERM；这不是搜索本身的失败，
        // 交给下面的 JS 实现继续完成只读搜索。
        resolve(false);
        return;
      }
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
        // Phase 96 修复：排除构建产物与仓库大目录，避免命中 out/release/archive/refs
        '--glob', '!**/out/**',
        '--glob', '!**/build/**',
        '--glob', '!**/release*/**',
        '--glob', '!**/archive/**',
        '--glob', '!**/refs/**',
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

    // Phase 95 修复：searchPath 是文件时直接读，避免 walkDir 抛 ENOTDIR 返回空
    let isFile = false;
    try {
      const stat = await fs.stat(searchPath);
      isFile = stat.isFile();
    } catch {
      // 路径不存在，走 walkDir 会被 catch 兜底
    }
    if (isFile) {
      try {
        const content = await fs.readFile(searchPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${searchPath}:${i + 1}:${lines[i].trim()}`);
            if (results.length >= maxResults) break;
          }
        }
      } catch (e) {
        logger.warn('读取文件失败', { filePath: searchPath, error: e instanceof Error ? e.message : String(e) });
      }
      return results.join('\n');
    }

    // Phase 96 修复：上限从 500 提高到 2000，与 file-search 一致
    // 配合 search-utils.ts 的 IGNORED_DIRS 跳过 out/release/archive/refs 等大目录
    const files = await walkDir(searchPath, 2000);

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
      } catch (e) {
        // skip（文件读取或正则匹配失败，跳过该文件）
        logger.warn('读取文件失败，跳过', { filePath: relativePath, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return results.join('\n');
  }
}
