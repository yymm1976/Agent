// src/agent/memory/compressors/json-sampler.ts
// Phase 72 Task B2：JSON 统计采样压缩器（headroom 借鉴）
//
// 设计动机：tool_output 经常返回大段 JSON（如 repo_map、code-search 的结果），
//   一刀切文本压缩（ksentence）会把 JSON 切成无意义片段。本压缩器保留结构信息：
//   - 顶层 keys 全保留
//   - 数组：保留长度 + 前后各 3 项
//   - 数值字段：min / max / avg 统计
//   - 字符串字段：保留原值（截断到 200 字符）
//   - 嵌套对象：递归处理（深度限制 3 层）
//
// 纯统计/AST 实现，禁止引入 LLM 重写（避免幻觉摘要被反复引用的坑）

import { logger } from '../../../utils/logger.js';

/** JSON 采样配置 */
export interface JsonSamplerConfig {
  /** 数组采样：保留前 N 项 + 后 N 项（默认 3） */
  arraySampleSize: number;
  /** 嵌套最大深度（默认 3） */
  maxDepth: number;
  /** 字符串值截断长度（默认 200） */
  stringTruncate: number;
}

const DEFAULT_CONFIG: JsonSamplerConfig = {
  arraySampleSize: 3,
  maxDepth: 3,
  stringTruncate: 200,
};

/** 采样结果 */
export interface JsonSamplerResult {
  /** 压缩后的 JSON 字符串（带采样标记） */
  compressed: string;
  /** 原始 token 估算（用 length/4） */
  originalTokens: number;
  /** 压缩后 token 估算 */
  compressedTokens: number;
  /** 是否实际进行了采样（数组被截取 / 数值被统计） */
  wasSampled: boolean;
}

/**
 * JSON 统计采样压缩器
 *
 * @param content 原始 JSON 字符串
 * @param config 采样配置
 * @returns 采样结果（compressed 字段可直接替换原内容）
 */
export function sampleJson(content: string, config: Partial<JsonSamplerConfig> = {}): JsonSamplerResult {
  const cfg: JsonSamplerConfig = { ...DEFAULT_CONFIG, ...config };
  const originalTokens = Math.ceil(content.length / 4);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // 不是合法 JSON，返回原文（让上层走 ksentence 路径）
    logger.warn('JSON 解析失败，返回原文', { error: e instanceof Error ? e.message : String(e) });
    return {
      compressed: content,
      originalTokens,
      compressedTokens: originalTokens,
      wasSampled: false,
    };
  }

  const wasSampled = { value: false };
  const sampled = sampleValue(parsed, 0, cfg, wasSampled);
  const compressed = JSON.stringify(sampled, null, 2);
  const compressedTokens = Math.ceil(compressed.length / 4);

  return {
    compressed,
    originalTokens,
    compressedTokens,
    wasSampled: wasSampled.value,
  };
}

/**
 * 递归采样单个值
 * - 数组：保留前 N + 后 N + 长度标记
 * - 对象：递归采样每个字段（深度限制）
 * - 数值：原样返回（顶层字段统计在 sampleObject 中做）
 * - 字符串：截断
 */
function sampleValue(value: unknown, depth: number, cfg: JsonSamplerConfig, wasSampled: { value: boolean }): unknown {
  if (Array.isArray(value)) {
    return sampleArray(value, depth, cfg, wasSampled);
  }
  if (value !== null && typeof value === 'object') {
    return sampleObject(value as Record<string, unknown>, depth, cfg, wasSampled);
  }
  if (typeof value === 'string') {
    if (value.length > cfg.stringTruncate) {
      wasSampled.value = true;
      return value.slice(0, cfg.stringTruncate) + `... [truncated, ${value.length} chars]`;
    }
    return value;
  }
  return value;
}

/**
 * 采样数组：保留前 N + 后 N 项，中间用占位标记
 * 数组元素递归采样
 */
function sampleArray(arr: unknown[], depth: number, cfg: JsonSamplerConfig, wasSampled: { value: boolean }): unknown[] {
  const n = cfg.arraySampleSize;
  if (arr.length <= n * 2) {
    // 数组较小，全部保留（仍递归采样元素）
    return arr.map((v) => sampleValue(v, depth + 1, cfg, wasSampled));
  }
  wasSampled.value = true;
  const head = arr.slice(0, n).map((v) => sampleValue(v, depth + 1, cfg, wasSampled));
  const tail = arr.slice(-n).map((v) => sampleValue(v, depth + 1, cfg, wasSampled));
  const omitted = arr.length - n * 2;
  // 用特殊对象标记被省略的中间部分
  return [...head, `... [omitted ${omitted} items, total ${arr.length} items]`, ...tail];
}

/**
 * 采样对象：递归采样每个字段
 * 对数值字段做 min/max/avg 统计（仅当字段值在数组元素中是数值时）
 * 深度超限时返回占位字符串（不是对象），调用方需按 unknown 处理
 */
function sampleObject(obj: Record<string, unknown>, depth: number, cfg: JsonSamplerConfig, wasSampled: { value: boolean }): unknown {
  // 深度超限，用 {...} 占位
  if (depth >= cfg.maxDepth) {
    wasSampled.value = true;
    const keys = Object.keys(obj);
    return keys.length > 0 ? `{... [${keys.length} keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}]}` : '{}';
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > 0) {
      // 数组字段：采样数组 + 统计数值字段
      const sampledArr = sampleArray(value, depth + 1, cfg, wasSampled);
      result[key] = sampledArr;
      // 如果数组元素是数值，附加统计信息
      const numStats = computeNumericStats(value);
      if (numStats) {
        result[`${key}__stats`] = numStats;
        wasSampled.value = true;
      }
    } else if (value !== null && typeof value === 'object') {
      result[key] = sampleValue(value, depth + 1, cfg, wasSampled);
    } else if (typeof value === 'string' && value.length > cfg.stringTruncate) {
      wasSampled.value = true;
      result[key] = value.slice(0, cfg.stringTruncate) + `... [truncated, ${value.length} chars]`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 计算数值数组的统计信息（min/max/avg/count）
 * 非数值数组返回 null
 */
function computeNumericStats(arr: unknown[]): { min: number; max: number; avg: number; count: number } | null {
  const nums = arr.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
  if (nums.length === 0) return null;
  let min = nums[0];
  let max = nums[0];
  let sum = 0;
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
    sum += n;
  }
  return {
    min,
    max,
    avg: Math.round((sum / nums.length) * 1000) / 1000,
    count: nums.length,
  };
}
