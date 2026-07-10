// src/tools/builtin/repo-map.ts
// Phase 34 Task 4：Repo Map 工具
// 为 Agent 提供代码地图，辅助代码检索和变更决策
// 短板 8 修复：优先查 code-map DB（Aider 风格），降级到 regex 实现

import path from 'node:path';
import fs from 'node:fs';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { buildRepoMap, renderRepoMap } from '../repo-map.js';
import {
  initDatabase,
  getTopFilesByRank,
  getTopSymbolsByFile,
  type DB,
  type TopFileEntry,
  type TopSymbolEntry,
} from '../../code-map/database.js';

export class RepoMapTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'repo_map',
    description: '当用户需要快速了解项目代码结构、定位相关代码位置时，使用此工具。优先查询代码地图数据库（按 PageRank 排序的 top 文件 + 符号签名），DB 不存在时降级到正则扫描。默认扫描 .ts/.js/.tsx/.jsx。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '扫描路径（可选，默认项目根目录；仅 regex 降级路径使用）',
        },
        maxFiles: {
          type: 'number',
          description: '最大文件数（默认 100；DB 路径默认 50）',
        },
        maxSignaturesPerFile: {
          type: 'number',
          description: '每个文件最大签名数（默认 10；DB 路径固定 3）',
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

    const start = Date.now();
    const maxFiles = (args.maxFiles as number) ?? undefined;

    // 优先尝试 code-map DB（Aider 风格：top 文件 + 每文件 top 3 符号签名）
    const dbPath = path.join(
      context.workingDirectory,
      '.routedev',
      'code-map',
      'code-map.db',
    );
    if (fs.existsSync(dbPath)) {
      try {
        const dbResult = this.buildFromDB(dbPath, maxFiles ?? 50);
        if (dbResult !== null) {
          return {
            success: true,
            output: dbResult.output,
            durationMs: Date.now() - start,
            metadata: { source: 'code-map-db', fileCount: dbResult.fileCount },
          };
        }
      } catch (e) {
        // DB 查询失败 → 降级到 regex（fail-open）
        // eslint-disable-next-line no-console
        console.warn(`[repo-map] DB 查询失败，降级到 regex: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 降级：regex 实现（buildRepoMap）
    try {
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
          metadata: { source: 'regex-fallback', fileCount: 0 },
        };
      }

      const output = renderRepoMap(entries, 400);
      return {
        success: true,
        output,
        durationMs,
        metadata: { source: 'regex-fallback', fileCount: entries.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `生成代码地图失败: ${msg}`,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * 从 code-map DB 构建 Aider 风格的 repo map
   * @returns 格式化文本；DB 为空（无文件）时返回 null 触发 regex 降级
   */
  private buildFromDB(dbPath: string, maxFiles: number): { output: string; fileCount: number } | null {
    let db: DB;
    try {
      db = initDatabase(dbPath);
    } catch (e) {
      // 数据库初始化失败（node:sqlite 不可用或 DB 损坏），返回 null 触发 regex 降级
      // eslint-disable-next-line no-console
      console.warn(`[repo-map] initDatabase 失败，降级到 regex: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }

    try {
      const topFiles: TopFileEntry[] = getTopFilesByRank(db, maxFiles);
      if (topFiles.length === 0) {
        // DB 存在但无数据 → 降级到 regex
        return null;
      }

      const lines: string[] = [
        `代码地图（共 ${topFiles.length} 个文件，来自 code-map DB，按 PageRank 排序）`,
        '',
      ];

      for (const file of topFiles) {
        const symbols: TopSymbolEntry[] = getTopSymbolsByFile(db, file.filePath, 3);
        lines.push(file.filePath);
        for (const s of symbols) {
          const sig = s.signature ?? `${s.kind} ${s.name}`;
          lines.push(`  ${sig}`);
        }
        lines.push('');
      }

      return { output: lines.join('\n').trim(), fileCount: topFiles.length };
    } finally {
      try {
        db.close();
      } catch (e) {
        // ignore close errors（db.close 失败不影响结果）
        // eslint-disable-next-line no-console
        console.warn(`[repo-map] db.close 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
