// src/tools/builtin/repo-map.ts
// Phase 34 Task 4：Repo Map 工具
// 为 Agent 提供代码地图，辅助代码检索和变更决策

import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { buildRepoMap, renderRepoMap } from '../repo-map.js';

export class RepoMapTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'repo_map',
    description: '当用户需要快速了解项目代码结构、定位相关代码位置时，使用此工具。扫描源文件并提取导出符号与函数/类签名，默认扫描 .ts/.js/.tsx/.jsx。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '扫描路径（可选，默认项目根目录）',
        },
        maxFiles: {
          type: 'number',
          description: '最大文件数（默认 100）',
        },
        maxSignaturesPerFile: {
          type: 'number',
          description: '每个文件最大签名数（默认 10）',
        },
      },
      required: [],
    },
    requiresApproval: false,
    category: 'code',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (args.maxFiles !== undefined && typeof args.maxFiles !== 'number') {
      errors.push('maxFiles 必须是数字');
    }
    if (args.maxSignaturesPerFile !== undefined && typeof args.maxSignaturesPerFile !== 'number') {
      errors.push('maxSignaturesPerFile 必须是数字');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const scanPath = args.path
      ? path.resolve(context.workingDirectory, args.path as string)
      : context.workingDirectory;

    // 路径边界校验
    const allowedDirs = context.allowedDirectories ?? [context.workingDirectory];
    const isAllowed = allowedDirs.some(dir =>
      scanPath === dir || scanPath.startsWith(dir + path.sep),
    );
    if (!isAllowed) {
      return {
        success: false,
        output: '',
        error: `扫描路径超出项目边界: ${args.path ?? scanPath}`,
        durationMs: 0,
      };
    }

    try {
      const start = Date.now();
      const entries = await buildRepoMap(
        {
          root: scanPath,
          maxFiles: (args.maxFiles as number) ?? 100,
          maxSignaturesPerFile: (args.maxSignaturesPerFile as number) ?? 10,
        },
        // M2 修复：传入允许的目录边界，让 buildRepoMap 也做防御性校验
        allowedDirs,
      );
      const durationMs = Date.now() - start;

      if (entries.length === 0) {
        return {
          success: true,
          output: '未找到可索引的源文件（尝试扫描 .ts/.js/.tsx/.jsx）',
          durationMs,
        };
      }

      const output = renderRepoMap(entries, 400);
      return {
        success: true,
        output,
        durationMs,
        metadata: { fileCount: entries.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `生成代码地图失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
