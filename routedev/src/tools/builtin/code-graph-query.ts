// src/tools/builtin/code-graph-query.ts
// 代码地图查询工具：让 Agent 主动查询 code-map DB
// 支持 4 种查询：find_callers / find_callees / impact_analysis / search_symbols
// 权限：auto（不需要用户确认）
// fail-open：DB 不存在 → 提示未索引；查询失败 → 返回 error；零结果 → 返回提示

import path from 'node:path';
import fs from 'node:fs';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { initDatabase, type DB } from '../../code-map/database.js';
import {
  findCallers,
  findCallees,
  analyzeImpact,
  explore,
} from '../../code-map/querier.js';
import type { CodeMapNode } from '../../code-map/schema.js';
import { logger } from '../../utils/logger.js';

const VALID_ACTIONS = new Set([
  'find_callers',
  'find_callees',
  'impact_analysis',
  'search_symbols',
]);

/** 默认/硬上限：防止调用图结果无限膨胀 */
const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 200;

/**
 * 代码地图查询工具
 * 让 Agent 可以主动查询 code-map DB 的调用关系、影响半径、符号搜索
 * 解决短板 2：Agent 完全无法主动查询 code-map
 */
export class CodeGraphQueryTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'code_graph_query',
    description:
      '当用户需要查询代码调用关系、影响半径或按关键词搜索符号时，使用此工具查询代码地图数据库。支持 4 种查询模式：find_callers（查找谁调用了指定符号）、find_callees（查找指定符号调用了谁）、impact_analysis（影响半径分析，反向 BFS 收集受影响节点）、search_symbols（按关键词搜索符号，按 PageRank 排序）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['find_callers', 'find_callees', 'impact_analysis', 'search_symbols'],
          description:
            '查询模式：find_callers=查找调用者，find_callees=查找被调用者，impact_analysis=影响半径分析，search_symbols=关键词搜索符号',
        },
        symbol: {
          type: 'string',
          description: '符号名（find_callers / find_callees / impact_analysis 使用）',
        },
        filePath: {
          type: 'string',
          description: '文件路径（impact_analysis 可选，用文件路径代替符号进行分析）',
        },
        fileHint: {
          type: 'string',
          description:
            '文件路径过滤提示（find_callers / find_callees 可选，限定结果文件路径包含此字符串）',
        },
        query: {
          type: 'string',
          description: '搜索关键词（search_symbols 使用，匹配符号名或签名）',
        },
        maxDepth: {
          type: 'number',
          description: '影响分析最大深度（impact_analysis 可选，默认 3）',
        },
        maxResults: {
          type: 'number',
          description: '最大返回结果数（search_symbols 可选，默认 20）',
        },
      },
      required: ['action'],
    },
    requiresApproval: false,
    category: 'code',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const action = args.action;

    if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
      errors.push(
        'action 必须是 find_callers / find_callees / impact_analysis / search_symbols 之一',
      );
      return { valid: false, errors };
    }

    if (action === 'find_callers' || action === 'find_callees') {
      if (!args.symbol || typeof args.symbol !== 'string') {
        errors.push(`${action} 需要必需参数: symbol`);
      }
    } else if (action === 'impact_analysis') {
      const hasSymbol = typeof args.symbol === 'string' && args.symbol.length > 0;
      const hasFilePath = typeof args.filePath === 'string' && args.filePath.length > 0;
      if (!hasSymbol && !hasFilePath) {
        errors.push('impact_analysis 需要 symbol 或 filePath 之一');
      }
    } else if (action === 'search_symbols') {
      if (!args.query || typeof args.query !== 'string') {
        errors.push('search_symbols 需要必需参数: query');
      }
    }

    if (args.maxDepth !== undefined && typeof args.maxDepth !== 'number') {
      errors.push('maxDepth 必须是数字');
    }
    if (args.maxResults !== undefined && typeof args.maxResults !== 'number') {
      errors.push('maxResults 必须是数字');
    }
    if (args.fileHint !== undefined && typeof args.fileHint !== 'string') {
      errors.push('fileHint 必须是字符串');
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const action = args.action as string;
    const start = Date.now();
    const dbPath = path.join(
      context.workingDirectory,
      '.routedev',
      'code-map',
      'code-map.db',
    );

    // DB 不存在 → fail-open（不创建空 DB，避免副作用）
    if (!fs.existsSync(dbPath)) {
      return {
        success: true,
        output: '代码地图尚未索引，请稍后等待索引完成',
        durationMs: Date.now() - start,
        metadata: { reason: 'db-not-found' },
      };
    }

    let db: DB;
    try {
      db = initDatabase(dbPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `打开代码地图数据库失败: ${msg}`,
        durationMs: Date.now() - start,
      };
    }

    try {
      let result: ToolResult;
      switch (action) {
        case 'find_callers':
          result = this.doFindCallers(db, args, start);
          break;
        case 'find_callees':
          result = this.doFindCallees(db, args, start);
          break;
        case 'impact_analysis':
          result = this.doImpactAnalysis(db, args, start);
          break;
        case 'search_symbols':
          result = await this.doSearchSymbols(db, args, context.workingDirectory, start);
          break;
        default:
          result = {
            success: false,
            output: '',
            error: `未知的 action: ${action}`,
            durationMs: Date.now() - start,
          };
      }
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `代码地图查询失败: ${msg}`,
        durationMs: Date.now() - start,
      };
    } finally {
      try {
        db.close();
      } catch (e) {
        // ignore close errors（db.close 失败不影响结果）
        logger.warn('db.close 失败', { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** 解析并钳制 maxResults */
  private resolveMaxResults(args: Record<string, unknown>): number {
    const raw = typeof args.maxResults === 'number' ? args.maxResults : DEFAULT_MAX_RESULTS;
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_RESULTS;
    return Math.min(Math.floor(raw), HARD_MAX_RESULTS);
  }

  /** find_callers：查找谁调用了指定符号 */
  private doFindCallers(db: DB, args: Record<string, unknown>, start: number): ToolResult {
    const symbol = args.symbol as string;
    const fileHint = args.fileHint as string | undefined;
    const maxResults = this.resolveMaxResults(args);
    const callers = findCallers(db, symbol, fileHint);
    const shown = callers.slice(0, maxResults);
    const truncated = callers.length > shown.length;

    if (callers.length === 0) {
      return {
        success: true,
        output: `未找到调用 \`${symbol}\` 的符号`,
        durationMs: Date.now() - start,
        metadata: { action: 'find_callers', count: 0 },
      };
    }

    const lines: string[] = [
      `find_callers: 找到 ${callers.length} 个调用者调用 \`${symbol}\`${truncated ? `（显示前 ${shown.length} 个）` : ''}：`,
      '',
    ];
    for (const c of shown) {
      lines.push(`  ${c.filePath}:${c.startLine + 1}  ${formatNode(c)}`);
    }
    if (truncated) {
      lines.push('', `[...结果已截断：共 ${callers.length} 个，仅显示前 ${shown.length} 个]`);
    }
    return {
      success: true,
      output: lines.join('\n'),
      durationMs: Date.now() - start,
      metadata: { action: 'find_callers', count: callers.length, shown: shown.length, truncated },
    };
  }

  /** find_callees：查找指定符号调用了谁 */
  private doFindCallees(db: DB, args: Record<string, unknown>, start: number): ToolResult {
    const symbol = args.symbol as string;
    const fileHint = args.fileHint as string | undefined;
    const maxResults = this.resolveMaxResults(args);
    const callees = findCallees(db, symbol, fileHint);
    const shown = callees.slice(0, maxResults);
    const truncated = callees.length > shown.length;

    if (callees.length === 0) {
      return {
        success: true,
        output: `未找到 \`${symbol}\` 调用的符号`,
        durationMs: Date.now() - start,
        metadata: { action: 'find_callees', count: 0 },
      };
    }

    const lines: string[] = [
      `find_callees: \`${symbol}\` 调用了 ${callees.length} 个符号${truncated ? `（显示前 ${shown.length} 个）` : ''}：`,
      '',
    ];
    for (const c of shown) {
      lines.push(`  ${c.filePath}:${c.startLine + 1}  ${formatNode(c)}`);
    }
    if (truncated) {
      lines.push('', `[...结果已截断：共 ${callees.length} 个，仅显示前 ${shown.length} 个]`);
    }
    return {
      success: true,
      output: lines.join('\n'),
      durationMs: Date.now() - start,
      metadata: { action: 'find_callees', count: callees.length, shown: shown.length, truncated },
    };
  }

  /** impact_analysis：影响半径分析（反向 BFS） */
  private doImpactAnalysis(db: DB, args: Record<string, unknown>, start: number): ToolResult {
    const symbol = args.symbol as string | undefined;
    const filePath = args.filePath as string | undefined;
    const maxDepth = (args.maxDepth as number) ?? 3;
    const maxResults = this.resolveMaxResults(args);
    const target = symbol || filePath;

    if (!target) {
      return {
        success: false,
        output: '',
        error: 'impact_analysis 需要 symbol 或 filePath 之一',
        durationMs: Date.now() - start,
      };
    }

    const result = analyzeImpact(db, target, maxDepth);

    if (result.totalCount === 0) {
      return {
        success: true,
        output: `未找到 \`${target}\` 的影响范围`,
        durationMs: Date.now() - start,
        metadata: { action: 'impact_analysis', totalCount: 0 },
      };
    }

    const shownFiles = result.impactedFiles.slice(0, maxResults);
    const shownNodes = result.impactedNodes.slice(0, maxResults);
    const truncated =
      result.impactedFiles.length > shownFiles.length ||
      result.impactedNodes.length > shownNodes.length;

    const lines: string[] = [
      `impact_analysis: \`${target}\` 影响半径分析（maxDepth=${maxDepth}）`,
      `受影响节点: ${result.totalCount} 个，涉及文件: ${result.impactedFiles.length} 个` +
        (truncated ? `（各显示前 ${maxResults} 个）` : ''),
      '',
      '受影响文件:',
    ];
    for (const f of shownFiles) {
      lines.push(`  ${f}`);
    }
    lines.push('', '受影响节点:');
    for (const n of shownNodes) {
      lines.push(`  ${n.filePath}:${n.startLine + 1}  ${formatNode(n)}`);
    }
    if (truncated) {
      lines.push(
        '',
        `[...结果已截断：文件 ${result.impactedFiles.length} / 节点 ${result.impactedNodes.length}，上限 ${maxResults}]`,
      );
    }
    return {
      success: true,
      output: lines.join('\n'),
      durationMs: Date.now() - start,
      metadata: {
        action: 'impact_analysis',
        totalCount: result.totalCount,
        fileCount: result.impactedFiles.length,
        shownNodes: shownNodes.length,
        shownFiles: shownFiles.length,
        truncated,
        maxDepth,
      },
    };
  }

  /** search_symbols：按关键词搜索符号 */
  private async doSearchSymbols(
    db: DB,
    args: Record<string, unknown>,
    rootDir: string,
    start: number,
  ): Promise<ToolResult> {
    const query = args.query as string;
    const maxResults = this.resolveMaxResults(
      typeof args.maxResults === 'number' ? args : { ...args, maxResults: 20 },
    );

    const ctx = await explore(db, query, rootDir, {
      maxResults,
      includeSnippets: false,
      includeCallPaths: false,
    });

    if (ctx.nodes.length === 0) {
      return {
        success: true,
        output: `未找到匹配 \`${query}\` 的符号`,
        durationMs: Date.now() - start,
        metadata: { action: 'search_symbols', count: 0 },
      };
    }

    const lines: string[] = [
      `search_symbols: 找到 ${ctx.nodes.length} 个匹配 \`${query}\` 的符号（按 rankScore 排序）：`,
      '',
    ];
    for (const n of ctx.nodes) {
      const score = n.rankScore ?? 0;
      lines.push(
        `  ${n.filePath}:${n.startLine + 1}  ${formatNode(n)}  (rank=${score.toFixed(4)})`,
      );
    }
    return {
      success: true,
      output: lines.join('\n'),
      durationMs: Date.now() - start,
      metadata: {
        action: 'search_symbols',
        count: ctx.nodes.length,
        impactRadius: ctx.impactRadius,
      },
    };
  }
}

/** 格式化节点为可读字符串：`name  signature` 或 `className.name  signature` */
function formatNode(node: CodeMapNode): string {
  const sig = node.signature ?? node.kind;
  if (node.className) {
    return `${node.className}.${node.name}  ${sig}`;
  }
  return `${node.name}  ${sig}`;
}
