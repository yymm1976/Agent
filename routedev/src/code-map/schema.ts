// src/code-map/schema.ts
// CodeMap 模块的核心类型定义

/** 符号类型 */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type_alias'
  | 'variable'
  | 'import'
  | 'arrow_function';

/** 边类型 */
export type EdgeKind = 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'CONTAINS' | 'REFERENCES';

/** 支持的源码语言 */
export type Language = 'typescript' | 'tsx' | 'javascript' | 'python' | 'java' | 'go' | 'unknown';

/** CodeMap 节点（符号） */
export interface CodeMapNode {
  /** 节点唯一 ID：filePath:startLine:name */
  id: string;
  /** 符号名称 */
  name: string;
  /** 符号类型 */
  kind: SymbolKind;
  /** 所属文件路径（相对项目根） */
  filePath: string;
  /** 起始行（0-based） */
  startLine: number;
  /** 结束行（0-based） */
  endLine: number;
  /** 函数/方法签名（如 `(a: number, b: string): Promise<void>`） */
  signature?: string;
  /** 是否异步 */
  async?: boolean;
  /** 是否导出 */
  exported?: boolean;
  /** 是否静态方法 */
  static?: boolean;
  /** 可见性（public/private/protected） */
  visibility?: string;
  /** 所属类名（方法时使用） */
  className?: string;
  /** 父类名 */
  extends?: string[];
  /** 实现的接口列表 */
  implements?: string[];
  /** import 来源模块 */
  sourceModule?: string;
  /** import 的符号列表 */
  importedNames?: string[];
  /** PageRank 分数 */
  rankScore?: number;
}

/** CodeMap 边 */
export interface CodeMapEdge {
  /** 边唯一 ID */
  id: string;
  /** 源节点 ID */
  source: string;
  /** 目标节点 ID */
  target: string;
  /** 边类型 */
  kind: EdgeKind;
  /** 边权重 */
  weight: number;
}

/** 已索引文件元信息 */
export interface CodeMapFile {
  /** 文件路径（相对项目根） */
  path: string;
  /** 语言 */
  language: Language;
  /** 文件内容 SHA-256 hash */
  contentHash: string;
  /** 文件行数 */
  lineCount: number;
  /** 最后索引时间（ISO 字符串） */
  indexedAt: string;
}

/** 索引统计 */
export interface IndexStats {
  /** 索引文件数 */
  fileCount: number;
  /** 节点数 */
  nodeCount: number;
  /** 边数 */
  edgeCount: number;
  /** 索引耗时（毫秒） */
  durationMs: number;
  /** 是否增量索引 */
  incremental: boolean;
  /** 跳过的文件数（未变更） */
  skippedFiles: number;
}

/** 索引状态 */
export interface IndexStatus {
  /** 已索引文件数 */
  fileCount: number;
  /** 节点数 */
  nodeCount: number;
  /** 边数 */
  edgeCount: number;
  /** 最后索引时间（ISO 字符串） */
  lastIndexedAt: string | null;
  /** 是否已初始化 */
  initialized: boolean;
}

/** 代码上下文（查询结果） */
export interface CodeContext {
  /** 查询关键词 */
  query: string;
  /** 匹配的节点列表 */
  nodes: CodeMapNode[];
  /** 相关的源代码片段 */
  snippets: CodeSnippet[];
  /** 调用路径 */
  callPaths: CallPath[];
  /** 影响半径 */
  impactRadius: number;
}

/** 代码片段 */
export interface CodeSnippet {
  /** 文件路径 */
  filePath: string;
  /** 起始行 */
  startLine: number;
  /** 结束行 */
  endLine: number;
  /** 源代码内容 */
  content: string;
  /** 所属符号名 */
  symbolName?: string;
}

/** 调用路径 */
export interface CallPath {
  /** 路径上的节点 ID 列表 */
  nodeIds: string[];
  /** 路径上的符号名列表 */
  symbolNames: string[];
}

/** 影响分析结果 */
export interface ImpactResult {
  /** 起始节点/文件 */
  root: string;
  /** 受影响的节点列表 */
  impactedNodes: CodeMapNode[];
  /** 受影响的文件列表 */
  impactedFiles: string[];
  /** 最大深度 */
  maxDepth: number;
  /** 总数 */
  totalCount: number;
}

/** 文件树节点 */
export interface FileNode {
  /** 名称 */
  name: string;
  /** 路径 */
  path: string;
  /** 是否目录 */
  isDirectory: boolean;
  /** 子节点（目录时使用） */
  children?: FileNode[];
  /** 文件中的符号列表（文件时使用） */
  symbols?: CodeMapNode[];
}

/** 边权重映射 */
export const EDGE_WEIGHTS: Record<EdgeKind, number> = {
  CALLS: 1.0,
  IMPORTS: 0.5,
  EXTENDS: 0.8,
  IMPLEMENTS: 0.8,
  REFERENCES: 0.3,
  CONTAINS: 0.1,
};

/** 支持的文件扩展名到语言映射 */
export const EXTENSION_LANGUAGE_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
};

/** WASM 文件名映射 */
export const LANGUAGE_WASM_MAP: Record<Language, string | null> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  go: 'tree-sitter-go.wasm',
  unknown: null,
};
