// src/agent/epistemic-token-protector.ts
// Phase 67 Task 3：认知不确定性 Token 保护器
//
// 核心思想（知识库原文）：
//   "推理过程中的'wait'、'hmm'、'actually'、'but'、'perhaps'等 epistemic token
//    反映了模型的认知探索过程——这些 token 不应被无脑压缩或删除，
//    否则会丢失'备选假设'和'不确定性渐进过程'。
//    保护策略：对每个 epistemic token 所在行，保护 [i-N, i+N] 邻域范围。"
//
// 实现：
//   - scanTokens：扫描所有 epistemic token 命中位置（大小写不敏感）
//   - computeProtectedLineRanges：计算 [i-N, i+N] 邻域保护范围
//   - protectMessage：根据策略保留/移除/标注邻域行
//
// fail-open：所有错误都返回降级结果（原样返回内容），不抛异常。

import { logger } from '../utils/logger.js';

// ============================================================
// 常量定义
// ============================================================

/**
 * 内置的认知不确定性 token 列表
 *
 * 这些 token 反映了模型推理时的"探索性思考"——
 * 表示模型在权衡备选假设、重新考虑、表达不确定性等。
 * 删除这些 token 会丢失推理过程的认知轨迹。
 */
export const EPISTEMIC_TOKENS = [
  'wait',
  'hmm',
  'actually',
  'let me reconsider',
  'on second thought',
  'but',
  'however',
  'perhaps',
  'maybe',
  'not sure',
] as const;

// ============================================================
// 类型定义
// ============================================================

/** 单个 epistemic token 的命中位置 */
export interface EpistemicTokenHit {
  /** 命中的 token 文本（保留原始大小写） */
  token: string;
  /** 所在行索引（0-based） */
  lineIndex: number;
  /** 所在字符索引（行内的 0-based 字符偏移） */
  charIndex: number;
}

/** 保护范围 */
export interface ProtectedLineRange {
  /** 起始行索引（含） */
  start: number;
  /** 结束行索引（含） */
  end: number;
}

/** 配置 */
export interface EpistemicTokenProtectorConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 邻域行数（保护 [i-N, i+N] 范围） */
  neighborhoodLines: number;
  /** 自定义 token 列表（可选，与内置 token 合并） */
  customTokens?: string[];
}

// ============================================================
// 默认配置
// ============================================================

export const DEFAULT_EPISTEMIC_TOKEN_PROTECTOR_CONFIG: EpistemicTokenProtectorConfig = {
  enabled: false,
  neighborhoodLines: 3,
};

/** 邻域保护标注 */
const PROTECTED_MARKER = '[epistemic-protected]';

// ============================================================
// EpistemicTokenProtector
// ============================================================

/**
 * 认知不确定性 token 保护器
 *
 * 使用方式：
 *   const protector = new EpistemicTokenProtector({ enabled: true, neighborhoodLines: 3 });
 *   const hits = protector.scanTokens(content);
 *   if (protector.hasEpistemicToken(content)) {
 *     const ranges = protector.computeProtectedLineRanges(content);
 *     // 标记需要保护的行范围
 *   }
 */
export class EpistemicTokenProtector {
  private config: EpistemicTokenProtectorConfig;
  /** 合并后的 token 列表（按长度降序排列，确保最长匹配优先） */
  private allTokens: string[];

  constructor(config: EpistemicTokenProtectorConfig = DEFAULT_EPISTEMIC_TOKEN_PROTECTOR_CONFIG) {
    this.config = { ...config };
    // 合并内置 token + 自定义 token
    const custom = this.config.customTokens ?? [];
    this.allTokens = this.dedupeAndSort([...EPISTEMIC_TOKENS, ...custom]);
  }

  /**
   * 扫描所有 epistemic token 命中位置
   *
   * 大小写不敏感匹配；返回所有命中（包括同一 token 多次出现）
   *
   * @param content 待扫描的文本内容
   * @returns 命中列表（按行号、字符位置升序）
   */
  scanTokens(content: string): EpistemicTokenHit[] {
    if (!content) return [];

    try {
      const hits: EpistemicTokenHit[] = [];
      const lines = content.split('\n');

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineLower = line.toLowerCase();

        for (const token of this.allTokens) {
          const tokenLower = token.toLowerCase();
          // 在当前行中查找所有出现位置
          let searchFrom = 0;
          while (searchFrom < lineLower.length) {
            const found = lineLower.indexOf(tokenLower, searchFrom);
            if (found === -1) break;

            // 边界检查：匹配的 token 应是独立词（前后非字母数字）
            if (this.isWordBoundary(lineLower, found, tokenLower.length)) {
              hits.push({
                token: line.slice(found, found + token.length), // 保留原始大小写
                lineIndex: lineIdx,
                charIndex: found,
              });
            }

            searchFrom = found + tokenLower.length;
          }
        }
      }

      // 按行号、字符位置升序
      hits.sort((a, b) => a.lineIndex - b.lineIndex || a.charIndex - b.charIndex);
      return hits;
    } catch (err) {
      // fail-open：异常时返回空命中列表
      logger.warn('EpistemicTokenProtector: scanTokens 异常，返回空列表', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * 判断内容中是否包含 epistemic token
   *
   * 比 scanTokens 更轻量（找到第一个就返回）
   */
  hasEpistemicToken(content: string): boolean {
    if (!content) return false;
    try {
      const contentLower = content.toLowerCase();
      for (const token of this.allTokens) {
        // 简单子串匹配（不要求 word boundary，提高性能）
        if (contentLower.includes(token.toLowerCase())) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 计算保护行范围
   *
   * 对每个命中行 i，保护 [i-N, i+N] 范围
   * 合并重叠或相邻的范围
   *
   * @param content 文本内容
   * @returns 合并后的保护范围列表
   */
  computeProtectedLineRanges(content: string): ProtectedLineRange[] {
    const hits = this.scanTokens(content);
    if (hits.length === 0) return [];

    try {
      const lines = content.split('\n');
      const totalLines = lines.length;
      const N = this.config.neighborhoodLines;

      // 计算所有命中行的保护范围
      const ranges: ProtectedLineRange[] = hits.map(hit => ({
        start: Math.max(0, hit.lineIndex - N),
        end: Math.min(totalLines - 1, hit.lineIndex + N),
      }));

      // 合并重叠或相邻的范围
      ranges.sort((a, b) => a.start - b.start);
      const merged: ProtectedLineRange[] = [];
      for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end + 1) {
          // 重叠或相邻：合并
          last.end = Math.max(last.end, range.end);
        } else {
          merged.push({ ...range });
        }
      }

      return merged;
    } catch (err) {
      // fail-open：异常时返回空范围列表
      logger.warn('EpistemicTokenProtector: computeProtectedLineRanges 异常', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * 保护消息内容
   *
   * 策略：
   *   - shouldKeep=true：原样返回（强制保留）
   *   - shouldKeep=false 且无 epistemic token：返回空字符串
   *   - shouldKeep=false 且有 epistemic token：保留邻域行，并标注 [epistemic-protected]
   *
   * @param content 文本内容
   * @param shouldKeep 是否强制保留
   * @returns 处理后的内容
   */
  protectMessage(content: string, shouldKeep: boolean): string {
    // shouldKeep=true 时原样返回
    if (shouldKeep) {
      return content;
    }

    // shouldKeep=false 且无 epistemic token：返回空
    if (!this.hasEpistemicToken(content)) {
      return '';
    }

    // shouldKeep=false 且有 epistemic token：保留邻域行
    try {
      const lines = content.split('\n');
      const ranges = this.computeProtectedLineRanges(content);

      // 收集所有需要保留的行索引
      const retainedLines = new Set<number>();
      for (const range of ranges) {
        for (let i = range.start; i <= range.end; i++) {
          retainedLines.add(i);
        }
      }

      // 构造输出：保留行 + 标注
      const output: string[] = [];
      let inProtectedRange = false;

      for (let i = 0; i < lines.length; i++) {
        if (retainedLines.has(i)) {
          if (!inProtectedRange) {
            // 进入保护范围时添加标注
            output.push(PROTECTED_MARKER);
            inProtectedRange = true;
          }
          output.push(lines[i]);
        } else {
          inProtectedRange = false;
        }
      }

      return output.join('\n');
    } catch (err) {
      // fail-open：异常时原样返回
      logger.warn('EpistemicTokenProtector: protectMessage 异常，原样返回', {
        error: err instanceof Error ? err.message : String(err),
      });
      return content;
    }
  }

  /**
   * 统计 epistemic token 出现次数
   *
   * 用于 EpistemicIntegrityChecker 计算频率
   */
  countEpistemicTokens(content: string): number {
    return this.scanTokens(content).length;
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /**
   * 去重并按长度降序排列
   *
   * 长度降序确保"let me reconsider"优先于"but"匹配
   * （避免短 token 截断长 token 的匹配）
   */
  private dedupeAndSort(tokens: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of tokens) {
      const lower = t.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(t);
      }
    }
    result.sort((a, b) => b.length - a.length);
    return result;
  }

  /**
   * 检查匹配位置是否是 word boundary（独立词）
   *
   * @param text 文本（已小写化）
   * @param start 匹配起始位置
   * @param length 匹配长度
   * @returns true=是独立词
   */
  private isWordBoundary(text: string, start: number, length: number): boolean {
    const before = start > 0 ? text[start - 1] : ' ';
    const after = start + length < text.length ? text[start + length] : ' ';
    // 前后字符应是非字母数字（即 word boundary）
    return !this.isAlphaNumeric(before) && !this.isAlphaNumeric(after);
  }

  /** 判断字符是否为字母或数字 */
  private isAlphaNumeric(ch: string): boolean {
    return /[a-z0-9]/i.test(ch);
  }
}
