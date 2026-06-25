// src/code-map/renderer.ts
// Aider 风格渲染器

import path from 'node:path';
import fs from 'node:fs';
import type { CodeMapNode, CodeMapFile } from './schema.js';

/** 渲染选项 */
export interface RenderOptions {
  /** token 预算 */
  tokenBudget?: number;
  /** 每个文件最多显示的符号数 */
  maxSymbolsPerFile?: number;
  /** 是否显示行号 */
  showLineNumbers?: boolean;
}

/** 渲染结果 */
export interface RenderResult {
  /** 渲染后的文本 */
  text: string;
  /** 包含的文件数 */
  fileCount: number;
  /** 包含的符号数 */
  symbolCount: number;
  /** 估算的 token 数 */
  estimatedTokens: number;
}

/** 估算字符串的 token 数（粗略：1 token ≈ 4 字符） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 渲染 Aider 风格的代码地图
 *
 * 格式：
 * src/auth/auth-manager.ts:
 * ⋮...
 * │export class AuthManager {
 * │  async login(credentials: Credentials): Promise<AuthResult> {
 * ⋮...
 */
export function renderCodeMap(
  files: CodeMapFile[],
  nodes: CodeMapNode[],
  options?: RenderOptions,
): RenderResult {
  const tokenBudget = options?.tokenBudget ?? 4000;
  const maxSymbolsPerFile = options?.maxSymbolsPerFile ?? 5;
  const showLineNumbers = options?.showLineNumbers ?? false;

  // 按文件分组节点
  const nodesByFile = new Map<string, CodeMapNode[]>();
  for (const node of nodes) {
    if (node.kind === 'import') continue; // 跳过 import 节点
    const list = nodesByFile.get(node.filePath) ?? [];
    list.push(node);
    nodesByFile.set(node.filePath, list);
  }

  // 按文件中最高 rankScore 排序文件
  const sortedFiles = files
    .map(f => {
      const fileNodes = nodesByFile.get(f.path) ?? [];
      const maxRank = fileNodes.reduce((m, n) => Math.max(m, n.rankScore ?? 0), 0);
      return { file: f, nodes: fileNodes, maxRank };
    })
    .sort((a, b) => b.maxRank - a.maxRank);

  const lines: string[] = [];
  let totalTokens = 0;
  let symbolCount = 0;
  let fileCount = 0;

  for (const { file, nodes: fileNodes } of sortedFiles) {
    if (fileNodes.length === 0) continue;

    // 按 rankScore 排序符号
    const sortedNodes = [...fileNodes]
      .sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
      .slice(0, maxSymbolsPerFile);

    // 构建文件块
    const fileBlock: string[] = [];
    fileBlock.push(`${file.path}:`);
    fileBlock.push('⋮...');

    for (const node of sortedNodes) {
      const signature = node.signature ?? node.name;
      const lineNum = showLineNumbers ? `${node.startLine + 1}: ` : '';
      fileBlock.push(`│${lineNum}${signature}`);
    }
    fileBlock.push('⋮...');

    const blockText = fileBlock.join('\n') + '\n';
    const blockTokens = estimateTokens(blockText);

    // 检查预算
    if (totalTokens + blockTokens > tokenBudget && fileCount > 0) {
      break;
    }

    lines.push(blockText);
    totalTokens += blockTokens;
    fileCount++;
    symbolCount += sortedNodes.length;
  }

  return {
    text: lines.join('\n'),
    fileCount,
    symbolCount,
    estimatedTokens: totalTokens,
  };
}

/**
 * 渲染单个文件的符号结构
 */
export function renderFileStructure(filePath: string, nodes: CodeMapNode[]): string {
  const lines: string[] = [];
  lines.push(`${filePath}:`);
  lines.push('⋮...');

  const sorted = [...nodes]
    .filter(n => n.kind !== 'import')
    .sort((a, b) => a.startLine - b.startLine);

  for (const node of sorted) {
    const signature = node.signature ?? node.name;
    lines.push(`│${signature}`);
  }

  lines.push('⋮...');
  return lines.join('\n');
}

/**
 * 读取文件中某符号的源代码行
 */
export function readSymbolLines(
  rootDir: string,
  node: CodeMapNode,
): string | null {
  const fullPath = path.join(rootDir, node.filePath);
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, node.startLine);
    const end = Math.min(lines.length - 1, node.endLine);
    return lines.slice(start, end + 1).join('\n');
  } catch {
    return null;
  }
}
