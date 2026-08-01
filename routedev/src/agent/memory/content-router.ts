// src/agent/memory/content-router.ts
// Phase 72 Task B2：ContentRouter 按内容类型分派压缩（headroom 借鉴）
//
// 设计动机：tool-output-pipeline.ts 当前一刀切文本压缩（ksentence），
//   但 JSON 切散后结构信息丢失，代码切散后签名被破坏。改为按内容类型分派：
//   - JSON：走 json-sampler 统计采样（保留结构）
//   - 代码：走 code-ast-summary（保留签名，丢弃函数体）
//   - 散文：走 ksentence-compressor（现有路径，向后兼容）
//   - <200 token：直通（不压缩，避免开销）
//
// 调用方：tool-output-pipeline.ts 在 process() 入口调用 routeCompress
//
// 纯统计/AST 实现，禁止引入 LLM / ML 模型

import { sampleJson } from './compressors/json-sampler.js';
import { summarizeCode } from './compressors/code-ast-summary.js';
import { KSentenceCompressor } from '../ksentence-compressor.js';
import { logger } from '../../utils/logger.js';

/** 压缩策略类型 */
export type CompressStrategy = 'passthrough' | 'json-sampler' | 'code-ast-summary' | 'ksentence';

/** ContentRouter 配置 */
export interface ContentRouterConfig {
  /** 直通阈值（token 估算 < 该值则不压缩，默认 200） */
  passthroughTokenThreshold: number;
  /** JSON 采样配置（可选） */
  jsonSamplerConfig?: Parameters<typeof sampleJson>[1];
}

const DEFAULT_CONFIG: ContentRouterConfig = {
  passthroughTokenThreshold: 200,
};

/** 路由结果 */
export interface RouteCompressResult {
  /** 压缩后的内容 */
  output: string;
  /** 实际使用的策略 */
  strategy: CompressStrategy;
  /** 原始 token 估算 */
  originalTokens: number;
  /** 压缩后 token 估算 */
  compressedTokens: number;
  /** 是否实际进行了压缩 */
  wasCompressed: boolean;
}

/**
 * 内容类型检测：判断文本是否像 JSON
 * 启发式：trim 后首字符为 { 或 [ 且能 JSON.parse
 */
function looksLikeJson(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch (e) {
    // JSON 解析失败，返回 false（非 JSON 内容检测的正常路径）
    logger.warn('JSON 检测失败', { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** 主流代码文件扩展名集合 */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.rb', '.php', '.swift', '.kt', '.scala', '.cs',
]);

/**
 * 检测内容是否像代码
 * 启发式 1：toolName 含 file_read 且 content 含语言特征关键字
 * 启发式 2：从 content 自身的代码特征（function/class/def/import）判定
 */
function looksLikeCode(content: string, toolName: string): boolean {
  // 仅在 file_read 场景触发代码路径，避免误判
  if (toolName !== 'file_read' && toolName !== 'read_file') return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  // 代码特征关键字（任一命中即认为是代码）
  const codeIndicators = [
    /^\s*function\s+\w+/m,
    /^\s*(export\s+)?(async\s+)?function\s/m,
    /^\s*import\s.+from\s/m,
    /^\s*class\s+\w+/m,
    /^\s*interface\s+\w+/m,
    /^\s*def\s+\w+\s*\(/m,
    /^\s*package\s+\w+/m,
    /^\s*public\s+class\s/m,
  ];
  let hits = 0;
  for (const re of codeIndicators) {
    if (re.test(content)) hits++;
  }
  // 至少 1 个特征命中
  return hits >= 1;
}

/**
 * 从工具参数中提取文件路径（用于 AST 提取时判定语言）
 * 接受 args 对象，尝试常见字段名
 */
function extractFilePath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const candidates = ['filePath', 'path', 'file_path', 'filename', 'file'];
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Phase 72 Task B2：路由压缩入口
 *
 * 检测顺序：
 *   1. token 估算 < threshold → passthrough
 *   2. JSON.parse 成功 → json-sampler
 *   3. file_read 工具 + 代码特征 → code-ast-summary
 *   4. 其它 → ksentence（散文路径，向后兼容）
 *
 * @param content 工具输出内容
 * @param toolName 工具名（如 'file_read'）
 * @param toolArgs 工具参数（可选，用于提取 filePath 给 AST 提取用）
 * @param config 路由配置
 */
export async function routeCompress(
  content: string,
  toolName: string,
  toolArgs?: Record<string, unknown>,
  config: Partial<ContentRouterConfig> = DEFAULT_CONFIG,
): Promise<RouteCompressResult> {
  const cfg: ContentRouterConfig = { ...DEFAULT_CONFIG, ...config };
  const originalTokens = Math.ceil(content.length / 4);

  // 1. < threshold 直通
  if (originalTokens < cfg.passthroughTokenThreshold) {
    return {
      output: content,
      strategy: 'passthrough',
      originalTokens,
      compressedTokens: originalTokens,
      wasCompressed: false,
    };
  }

  // 2. JSON 路径
  if (looksLikeJson(content)) {
    const result = sampleJson(content, cfg.jsonSamplerConfig);
    return {
      output: result.compressed,
      strategy: 'json-sampler',
      originalTokens,
      compressedTokens: result.compressedTokens,
      wasCompressed: result.wasSampled,
    };
  }

  // 3. 代码路径（仅 file_read 场景）
  if (looksLikeCode(content, toolName)) {
    const filePath = extractFilePath(toolArgs);
    // 检查扩展名是否在已知代码扩展名集合（加速判定）
    if (filePath) {
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        const result = await summarizeCode(content, filePath);
        return {
          output: result.summary,
          strategy: 'code-ast-summary',
          originalTokens,
          compressedTokens: result.summaryTokens,
          wasCompressed: result.method !== 'none' && result.summaryTokens < originalTokens,
        };
      }
    }
    // 无 filePath 但内容明显是代码：仍尝试 AST 摘要（用内容启发式判定语言）
    const result = await summarizeCode(content, filePath);
    if (result.method !== 'none') {
      return {
        output: result.summary,
        strategy: 'code-ast-summary',
        originalTokens,
        compressedTokens: result.summaryTokens,
        wasCompressed: result.summaryTokens < originalTokens,
      };
    }
  }

  // 4. 散文路径：ksentence（现有路径，向后兼容）
  const compressor = new KSentenceCompressor();
  const result = compressor.compress(content);
  return {
    output: result.compressed,
    strategy: 'ksentence',
    originalTokens,
    compressedTokens: Math.ceil(result.compressed.length / 4),
    wasCompressed: result.wasCompressed,
  };
}
