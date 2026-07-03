// src/memory/incremental-extractor.ts
// Phase 65 Task 2：IncrementalExtractor - 增量抽取器
//
// 论文：晚过滤原则（保原文优先）、Topic 抽取（LLM 模拟）
// 实现：
//   - phase 映射：requirements→topic、coding→decision、testing→error_fix、review→decision
//   - 先调 store.write 写原文（晚过滤原则）
//   - mode='topic' 时用简单关键词提取模拟 LLM Topic 抽取
//   - 失败 fail-open（topics 留空，原文已存）

import type { MemoryStore, MemoryEntry } from './memory-store.js';

export interface IncrementalExtractorConfig {
  enabled: boolean;
  /** topic 模式抽取关键名词短语；none 模式仅存原文 */
  mode: 'topic' | 'none';
  /** LLM 模型 ID（用于后续接入真实 LLM Topic 抽取） */
  modelId: string;
  /** 可选：自定义 topic 抽取函数（用于测试或注入 LLM） */
  topicExtractor?: (content: string) => string[];
}

export interface ExtractResult {
  extracted: number;
  memoryIds: string[];
}

/**
 * phase → type 映射
 * 论文：不同阶段抽取不同类型的记忆
 */
function mapPhaseToType(phase: string): MemoryEntry['type'] {
  switch (phase) {
    case 'requirements':
      return 'topic';
    case 'coding':
      return 'decision';
    case 'testing':
      return 'error_fix';
    case 'review':
      return 'decision';
    default:
      // 未知阶段默认 topic
      return 'topic';
  }
}

/**
 * 默认 Topic 抽取（模拟 LLM）
 * 策略：提取长度 >=4 的英文词或 CJK bigram，去重，最多 5 个
 */
function defaultTopicExtractor(content: string): string[] {
  const topics = new Set<string>();
  // 拆分为词（小写）
  const lower = content.toLowerCase();
  // 提取英文词（>=4 字符）
  const asciiWords = lower.match(/[a-z][a-z0-9_]{3,}/g) ?? [];
  for (const w of asciiWords) {
    topics.add(w);
  }
  // 提取 CJK bigram
  const cjkMatches = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const seg of cjkMatches) {
    if (seg.length === 1) {
      topics.add(seg);
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        topics.add(seg.substring(i, i + 2));
      }
    }
  }
  return Array.from(topics).slice(0, 5);
}

export class IncrementalExtractor {
  private store: MemoryStore;
  private config: IncrementalExtractorConfig;

  constructor(store: MemoryStore, config: IncrementalExtractorConfig) {
    this.store = store;
    this.config = config;
  }

  /**
   * 从阶段输出中增量抽取记忆
   * - phaseOutput 按行拆分，每行作为一条记忆
   * - 先写原文（晚过滤原则），再尝试抽取 topics
   * - 抽取失败 fail-open（topics 留空，原文已存）
   */
  async extractFromPhase(phase: string, phaseOutput: string): Promise<ExtractResult> {
    if (!this.config.enabled) {
      return { extracted: 0, memoryIds: [] };
    }
    if (!phaseOutput || !phaseOutput.trim()) {
      return { extracted: 0, memoryIds: [] };
    }

    const type = mapPhaseToType(phase);
    // 按行拆分，过滤空行
    const lines = phaseOutput.split('\n').map((l) => l.trim()).filter(Boolean);

    const memoryIds: string[] = [];
    for (const line of lines) {
      // 先写原文（晚过滤原则：原文优先于抽象）
      const id = await this.store.write({
        content: line,
        type,
        source: phase,
        validFrom: Date.now(),
      });
      if (id) {
        memoryIds.push(id);
      }

      // mode='topic' 时尝试抽取 topics
      if (this.config.mode === 'topic' && id) {
        try {
          const topics = this.config.topicExtractor
            ? this.config.topicExtractor(line)
            : defaultTopicExtractor(line);
          if (topics.length > 0) {
            await this.store.update(id, { topics });
          }
        } catch {
          // fail-open：topics 抽取失败不阻塞，原文已存
        }
      }
    }

    return { extracted: memoryIds.length, memoryIds };
  }
}
