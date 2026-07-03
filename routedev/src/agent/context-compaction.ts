// src/agent/context-compaction.ts
// 渐进上下文压缩管线（借鉴 Claude Code 五阶段模型）
// L1-L4 零 LLM 调用（纯字符串/数组操作），L5 才调用模型摘要
//
// 五阶段说明：
//   L1 Budget Trimming  — 截断大工具输出（>2000 字符 → 500 首 + 500 尾 + 标记）
//   L2 Snipping         — 保留最近 10 条 + 所有 system 消息，删除中间
//   L3 Micro-Compaction — 删除 content 为空或仅含标记的消息
//   L4 Context Collapse — 合并连续相同 role 的消息，去重相同工具结果
//   L5 LLM Summary      — 调用 summarize 函数生成摘要（唯一调用 LLM 的阶段）
//
// Reasonix Layer 3 集成：三级压缩阈值（50%软通知/80%触发/90%强制）
// Claude Code 集成：压缩边界 UUID 标记（headUuid/anchorUuid/tailUuid）

import type { LLMMessage, ContentPart, ToolResultContent } from '../router/types.js';
import { decideCompactionAction, DEFAULT_COMPACTION_THRESHOLDS, type CompactionThresholds } from '../router/cache-optimizer.js';
import { createCompactionBoundary, type CompactionBoundary } from '../tools/trust-gradient.js';
import { logger } from '../utils/logger.js';
import type { CCRCache, CCRMarker } from './ccr-cache.js';
import { CuratedSet } from './curated-set.js';
import { KSentenceCompressor } from './ksentence-compressor.js';
import { BudgetAwareRenderer } from './budget-aware-renderer.js';
import { VerificationRecords } from './verification-records.js';
import { ContentDeduplicator } from './content-deduplicator.js';
import type { ToolOutputBudgetManager } from './memory/tool-output-budget.js';
import type { MessageGrouper } from './memory/message-grouper.js';
import type { ActionChainDetector, ActionChain } from './memory/action-chain-detector.js';
import type { AutoCompactGuardian, CompactAction, TokenState } from './memory/auto-compact-guardian.js';
import type { CompactPromptEngine } from './memory/compact-prompt-engine.js';
import type { SessionMemoryStore, SessionMemory } from './memory/session-memory-store.js';

/** 压缩结果 */
export interface CompactionResult {
  /** 压缩前的 token 估算 */
  beforeTokens: number;
  /** 压缩后的 token 估算 */
  afterTokens: number;
  /** 实际执行的最高阶段（1-5） */
  maxStageReached: 1 | 2 | 3 | 4 | 5;
  /** 被移除的消息数（原始条数 - 压缩后条数） */
  removedMessages: number;
  /** L5 生成的摘要（仅当 maxStageReached=5 且提供了 summarize 时存在） */
  summary?: string;
  /** Reasonix Layer 3：压缩动作（none/soft_notify/trigger/force） */
  action?: 'none' | 'soft_notify' | 'trigger' | 'force';
  /** Claude Code：压缩边界 UUID 标记 */
  boundary?: CompactionBoundary;
  /** B12：L5 摘要是否失败（true 表示 summarize 抛错或未提供，已降级到 L4 结果） */
  summaryFailed?: boolean;
  ccr?: CCRMarker;
}

/** 压缩配置 */
interface CompactionConfig {
  /** 目标 token 数：每阶段后检查，达到则停止 */
  targetTokens: number;
  /** token 估算函数 */
  estimateTokens: (text: string) => number;
  /** L5 摘要函数（可选，不提供则跳过 L5） */
  summarize?: (messages: LLMMessage[]) => Promise<string>;
  /** Reasonix Layer 3：三级压缩阈值（默认 50%/80%/90%） */
  thresholds?: CompactionThresholds;
  /** 上下文窗口大小（用于计算使用率，默认 targetTokens * 1.25） */
  contextWindow?: number;
  ccrCache?: CCRCache;
  /**
   * Phase 63：上下文状态外部化配置（可选）
   *
   * 所有子开关默认 false——不开启时压缩管线行为与 Phase 52 完全一致。
   * 开启后会在压缩流程的关键点插入条件调用：
   *   - L2 snip 阶段：kSentenceCompression / contentDedup
   *   - 渲染阶段：budgetAwareRendering
   *   - 压缩后：curatedSet / verificationRecords
   */
  stateExternalization?: StateExternalizationConfig;
  // Phase 70：上下文压缩技术深度优化（所有字段可选，fail-open）
  toolOutputBudgetManager?: ToolOutputBudgetManager;
  messageGrouper?: MessageGrouper;
  actionChainDetector?: ActionChainDetector;
  autoCompactGuardian?: AutoCompactGuardian;
  compactPromptEngine?: CompactPromptEngine;
  sessionMemoryStore?: SessionMemoryStore;
}

/**
 * Phase 63：状态外部化配置（与 src/config/schema.ts 中 stateExternalization 对齐）
 *
 * 所有字段可选，调用方只需提供要开启的子开关。各子模块的配置结构与对应模块的 Config 接口匹配，
 * 但本接口中所有字段均为可选（缺失时使用模块内置默认值）。
 */
export interface StateExternalizationConfig {
  /** 总开关（仅作语义提示，实际门控由各子开关决定） */
  enabled?: boolean;
  /** CuratedSet 策展集：压缩后策展重要上下文 */
  curatedSet?: {
    enabled?: boolean;
    autoPopulateCount?: number;
    maxTokenBudget?: number;
    importanceTaggingEnabled?: boolean;
    subtractiveCurationEnabled?: boolean;
  };
  /** K-sentence 压缩：L2 snip 阶段替代简单截断 */
  kSentenceCompression?: {
    enabled?: boolean;
    k?: number;
    keywordWeight?: number;
    lengthWeight?: number;
    positionWeight?: number;
  };
  /** 内容去重：L2 snip 阶段去除重复内容 */
  contentDedup?: {
    enabled?: boolean;
    hashAlgorithm?: 'sha256' | 'md5';
    minLength?: number;
    replaceWithReference?: boolean;
  };
  /** 预算感知渲染：渲染阶段注入预算标记 */
  budgetAwareRendering?: {
    enabled?: boolean;
    contextWindow?: number;
    softNotifyThreshold?: number;
    triggerThreshold?: number;
    forceThreshold?: number;
    renderEveryTurn?: boolean;
  };
  /** 验证记录：压缩后记录验证状态 */
  verificationRecords?: {
    enabled?: boolean;
    maxRecords?: number;
    ttlMs?: number;
  };
}

// 阈值常量
const TOOL_OUTPUT_TRUNCATE_THRESHOLD = 2000;
const TOOL_OUTPUT_HEAD = 500;
const TOOL_OUTPUT_TAIL = 500;
const TRUNCATE_MARKER = '[...截断...]';
const SNIP_KEEP_RECENT = 10;

export class ContextCompactor {
  /** P8：消息 token 缓存，避免重复计算（key 为 messages 数组的引用） */
  private tokenCache = new WeakMap<LLMMessage, number>();

  // Phase 63：状态外部化模块（仅在对应开关开启时实例化，跨 compact() 调用复用）
  private curatedSet: CuratedSet | null = null;
  private verificationRecords: VerificationRecords | null = null;
  private kSentenceCompressor: KSentenceCompressor | null = null;
  private contentDeduplicator: ContentDeduplicator | null = null;
  private budgetAwareRenderer: BudgetAwareRenderer | null = null;

  constructor(private config: CompactionConfig) {
    this.initStateExternalizationModules();
  }

  /**
   * Phase 63：根据 stateExternalization 配置实例化对应模块
   *
   * 各模块仅在对应子开关开启时实例化；未开启时字段保持 null，compact() 中的对应调用会被跳过。
   * CuratedSet 与 VerificationRecords 跨 compact() 调用复用（前者积累候选 chunk，后者积累验证记录）。
   */
  private initStateExternalizationModules(): void {
    const se = this.config.stateExternalization;
    if (!se) return;

    if (se.curatedSet?.enabled) {
      this.curatedSet = new CuratedSet({
        autoPopulateCount: se.curatedSet.autoPopulateCount ?? 8,
        maxTokenBudget: se.curatedSet.maxTokenBudget ?? 8000,
        importanceTaggingEnabled: se.curatedSet.importanceTaggingEnabled ?? true,
        subtractiveCurationEnabled: se.curatedSet.subtractiveCurationEnabled ?? true,
      });
    }

    if (se.kSentenceCompression?.enabled) {
      this.kSentenceCompressor = new KSentenceCompressor({
        k: se.kSentenceCompression.k ?? 4,
        scoring: {
          keywordWeight: se.kSentenceCompression.keywordWeight ?? 0.5,
          lengthWeight: se.kSentenceCompression.lengthWeight ?? 0.3,
          positionWeight: se.kSentenceCompression.positionWeight ?? 0.2,
        },
      });
    }

    if (se.contentDedup?.enabled) {
      this.contentDeduplicator = new ContentDeduplicator(
        {
          enabled: true,
          hashAlgorithm: se.contentDedup.hashAlgorithm ?? 'sha256',
          minLength: se.contentDedup.minLength ?? 50,
          replaceWithReference: se.contentDedup.replaceWithReference ?? true,
        },
        this.config.estimateTokens,
      );
    }

    if (se.budgetAwareRendering?.enabled) {
      this.budgetAwareRenderer = new BudgetAwareRenderer(
        {
          enabled: true,
          contextWindow: se.budgetAwareRendering.contextWindow ?? 200000,
          softNotifyThreshold: se.budgetAwareRendering.softNotifyThreshold ?? 0.5,
          triggerThreshold: se.budgetAwareRendering.triggerThreshold ?? 0.8,
          forceThreshold: se.budgetAwareRendering.forceThreshold ?? 0.9,
          renderEveryTurn: se.budgetAwareRendering.renderEveryTurn ?? true,
        },
        this.config.estimateTokens,
      );
    }

    if (se.verificationRecords?.enabled) {
      this.verificationRecords = new VerificationRecords({
        enabled: true,
        maxRecords: se.verificationRecords.maxRecords ?? 1000,
        ttlMs: se.verificationRecords.ttlMs ?? 3600000,
      });
    }
  }

  /**
   * 执行渐进压缩
   * 依次执行 L1→L5，每阶段后检查是否达到 targetTokens，达到则停止
   *
   * Reasonix Layer 3 集成：三级压缩阈值决定是否触发压缩
   *   - 50% 软通知：仅记录日志，不压缩（保护缓存）
   *   - 80% 触发：执行压缩
   *   - 90% 强制：必须压缩到目标
   *
   * Claude Code 集成：压缩时记录边界 UUID 标记
   */
  async compact(
    messages: LLMMessage[],
  ): Promise<{ messages: LLMMessage[]; result: CompactionResult }> {
    const beforeTokens = this.totalTokens(messages);
    const thresholds = this.config.thresholds ?? DEFAULT_COMPACTION_THRESHOLDS;
    const contextWindow = this.config.contextWindow ?? Math.floor(this.config.targetTokens * 1.25);
    const usagePercent = beforeTokens / contextWindow;

    // Reasonix Layer 3：三级阈值决策
    const decision = decideCompactionAction(usagePercent, thresholds);

    // 软通知：仅记录日志，不执行压缩（保护缓存前缀）
    if (decision.action === 'soft_notify') {
      logger.info('Context compaction: soft notify (cache protected)', {
        usage: `${(usagePercent * 100).toFixed(1)}%`,
        reason: decision.reason,
      });
    }

    // none 或 soft_notify：不触发压缩
    if (decision.action === 'none' || decision.action === 'soft_notify') {
      return {
        messages,
        result: {
          beforeTokens,
          afterTokens: beforeTokens,
          maxStageReached: 1,
          removedMessages: 0,
          action: decision.action,
        },
      };
    }

    // trigger 或 force：执行压缩（Phase 70 修复：添加 try-catch 用于 AutoCompactGuardian 反馈）
    try {
      const ccrRecord = this.config.ccrCache?.store(messages);
      let current = [...messages];
      // L1 始终执行
      let maxStageReached: 1 | 2 | 3 | 4 | 5 = 1;
      let summary: string | undefined;

    // L1: Budget Trimming — 截断大工具输出
      current = await this.stage1TrimToolOutputs(current);

      if (this.totalTokens(current) > this.config.targetTokens) {
        // L2: Snipping — 删除旧消息
        maxStageReached = 2;
        current = this.stage2SnipOldMessages(current);

        // Phase 63：L2 snip 阶段插入 K-sentence 压缩（替代简单截断）
        // 对保留的每条非 system 消息按打分保留前 k 句，进一步降低 token
        if (this.kSentenceCompressor) {
          current = this.applyKSentenceCompression(current);
        }

        // Phase 63：L2 snip 阶段插入内容去重（去除重复长内容）
        // 对每条消息的字符串内容做去重，重复内容替换为引用标记
        if (this.contentDeduplicator) {
          current = this.applyContentDedup(current);
        }

        if (this.totalTokens(current) > this.config.targetTokens) {
          // L3: Micro-Compaction — 清理空消息
          maxStageReached = 3;
          current = this.stage3MicroCompact(current);

          if (this.totalTokens(current) > this.config.targetTokens) {
            // L4: Context Collapse — 合并去重
            maxStageReached = 4;
            current = this.stage4Collapse(current);

            if (this.totalTokens(current) > this.config.targetTokens) {
              // L5: LLM Summary — 调用模型摘要
              maxStageReached = 5;
              if (this.config.summarize) {
                // B12：对 summarize 调用包裹 try/catch，失败时保留 L4 结果
                try {
                  // Phase 70：若 compactPromptEngine 可用，将结构化压缩指令作为 system 消息前缀
                  let summarizeMessages = current;
                  if (this.config.compactPromptEngine) {
                    const prompt = this.config.compactPromptEngine.getPrompt();
                    summarizeMessages = [{ role: 'system', content: prompt }, ...current];
                  }
                  summary = await this.config.summarize(summarizeMessages);
                  // Phase 70：若 compactPromptEngine 可用，格式化摘要输出
                  if (this.config.compactPromptEngine && summary) {
                    summary = this.config.compactPromptEngine.formatSummary(summary);
                  }
                  // I2 修复：保留最近 3 条消息，避免破坏 tool_use/tool_result 对偶
                  // 若 LLM 已返回 tool_use 但对应 tool_result 尚未注入，单条 system 摘要会丢失工具调用状态
                  const recentTail = current.slice(-3);
                  current = [{ role: 'system', content: summary }, ...recentTail];
                } catch (err) {
                  // L5 摘要失败：降级到 L4 结果，标记 summaryFailed
                  logger.warn('ContextCompactor: L5 summarize failed, fallback to L4 result', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                  summary = undefined;
                  // 保留 L4 的 current，不替换为摘要
                }
              }
              // B12：未提供 summarize 时，maxStageReached 仍记为 5 但标记 summaryFailed
              // 调用方可通过 summaryFailed 判断是否真正执行了摘要
            }
          }
        }
      }

      const afterTokens = this.totalTokens(current);
      const ccr = ccrRecord
        ? this.config.ccrCache?.buildMarker(ccrRecord.hash, messages.length, current.length)
        : undefined;

      // B12：判断 summaryFailed（L5 触发但未生成摘要）
      const summaryFailed = maxStageReached === 5 && !summary;

      // Claude Code：记录压缩边界 UUID 标记
      const boundary = createCompactionBoundary(messages, current, maxStageReached);

      // Phase 63：渲染阶段——预算感知渲染
      // 在压缩结果前注入预算标记，让下游模型感知当前预算水位
      if (this.budgetAwareRenderer) {
        const budgetPrompt = this.budgetAwareRenderer.renderBudgetPrompt(afterTokens);
        if (budgetPrompt.prompt) {
          current = [{ role: 'system', content: budgetPrompt.prompt }, ...current];
        }
      }

      // Phase 63：压缩后——CuratedSet 策展重要上下文
      // 把压缩后消息中的关键内容加入策展集（critical/useful/obsolete 自动分类）
      if (this.curatedSet) {
        this.populateCuratedSet(current);
      }

      // Phase 63：压缩后——VerificationRecords 记录验证状态
      // 把本次压缩作为一条 claim 记录入验证记录，便于后续判断是否需要重新验证
      if (this.verificationRecords) {
        this.recordCompactionVerification(messages, current, maxStageReached, summaryFailed);
      }

      // Phase 70：压缩后——SessionMemoryStore 保存会话记忆
      try {
        if (this.config.sessionMemoryStore && summary) {
          this.config.sessionMemoryStore.save({
            sessionId: Date.now().toString(),
            summary,
            keyDecisions: [],
            involvedFiles: [],
            errorsAndFixes: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      } catch (err) {
        logger.warn('ContextCompactor: Phase 70 sessionMemoryStore save failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.info('Context compacted', {
        stage: maxStageReached,
        before: beforeTokens,
        after: afterTokens,
        removed: messages.length - current.length,
        action: decision.action,
        boundary: boundary.headUuid.slice(0, 8),
        summaryFailed,
      });

      // Phase 70 修复：压缩成功后记录到 AutoCompactGuardian
      if (this.config.autoCompactGuardian) {
        this.config.autoCompactGuardian.recordSuccess();
      }

      return {
        messages: current,
        result: {
          beforeTokens,
          afterTokens,
          maxStageReached,
          removedMessages: Math.max(0, messages.length - current.length),
          summary,
          action: decision.action,
          boundary,
          summaryFailed,
          ccr,
        },
      };
    } catch (err) {
      // Phase 70 修复：压缩失败后记录到 AutoCompactGuardian
      if (this.config.autoCompactGuardian) {
        this.config.autoCompactGuardian.recordFailure();
      }
      logger.error('Context compaction failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Phase 70：AutoCompactGuardian 增强压缩决策
  // 使用 token 预算 + 断路器代替简单阈值判断
  shouldCompressEnhanced(
    estimatedTokens: number,
  ): { should: boolean; action: CompactAction; tokenState: TokenState } {
    const emptyState: TokenState = {
      currentTokens: estimatedTokens,
      effectiveWindow: 0,
      percentLeft: 100,
      isAboveWarning: false,
      isAboveError: false,
      isAboveAutoCompact: false,
      isAtBlockingLimit: false,
      suggestedAction: 'none',
    };
    try {
      if (!this.config.autoCompactGuardian) {
        return { should: false, action: 'none', tokenState: emptyState };
      }
      const tokenState = this.config.autoCompactGuardian.calculateTokenState(estimatedTokens);
      const should = tokenState.suggestedAction !== 'none' && tokenState.suggestedAction !== 'blocked';
      return { should, action: tokenState.suggestedAction, tokenState };
    } catch (err) {
      logger.warn('ContextCompactor: Phase 70 shouldCompressEnhanced failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { should: false, action: 'none', tokenState: emptyState };
    }
  }

  // Phase 70：获取 AutoCompactGuardian 实例（供外部查询断路器状态）
  getAutoCompactGuardian(): AutoCompactGuardian | null {
    return this.config.autoCompactGuardian ?? null;
  }

  // L1: Budget Trimming — 截断大工具输出（>2000 字符 → 500 首 + 标记 + 500 尾）
  // Phase 70：若 toolOutputBudgetManager 可用，使用 offload+preview 替代简单截断
  private async stage1TrimToolOutputs(messages: LLMMessage[]): Promise<LLMMessage[]> {
    try {
      if (this.config.toolOutputBudgetManager?.isEnabled()) {
        const { messages: processed, offloadedCount } =
          await this.config.toolOutputBudgetManager.processMessages(
            messages,
            (msg) => (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)),
            (msg, text) => ({ ...msg, content: text }),
          );
        if (offloadedCount > 0) {
          logger.info('ContextCompactor: Phase 70 ToolOutputBudget offloaded', { count: offloadedCount });
        }
        return processed;
      }
    } catch (err) {
      logger.warn('ContextCompactor: Phase 70 toolOutputBudgetManager failed, fallback to L1 default', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.stage1TrimToolOutputsDefault(messages);
  }

  private stage1TrimToolOutputsDefault(messages: LLMMessage[]): LLMMessage[] {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        // 字符串内容：user 消息中超长的可能是工具输出，截断
        if (msg.role === 'user' && msg.content.length > TOOL_OUTPUT_TRUNCATE_THRESHOLD) {
          return { ...msg, content: this.truncateText(msg.content) };
        }
        return msg;
      }
      // ContentPart[]：查找 ToolResultContent 并截断其 content 字段
      const newParts = msg.content.map((part) => {
        if (
          part.type === 'tool_result' &&
          part.content.length > TOOL_OUTPUT_TRUNCATE_THRESHOLD
        ) {
          return { ...part, content: this.truncateText(part.content) } as ToolResultContent;
        }
        return part;
      });
      return { ...msg, content: newParts };
    });
  }

  /** 截断文本：500 首 + 标记 + 500 尾 */
  private truncateText(text: string): string {
    return (
      text.slice(0, TOOL_OUTPUT_HEAD) +
      TRUNCATE_MARKER +
      text.slice(-TOOL_OUTPUT_TAIL)
    );
  }

  // L2: Snipping — 保留最近 10 条 + 所有 system 消息，删除中间
  // Phase 70：若 messageGrouper 可用，按轮次分组保护完整 user-assistant 对话轮
  private stage2SnipOldMessages(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length <= SNIP_KEEP_RECENT) {
      return messages;
    }
    try {
      if (this.config.messageGrouper) {
        const groups = this.config.messageGrouper.groupByRounds(messages);
        const keepRecent = this.config.messageGrouper.getKeepRecentRounds();
        const compressible = this.config.messageGrouper.markCompressible(groups, keepRecent);
        const keepIndices = new Set<number>();
        for (const msg of messages) {
          if (msg.role === 'system') {
            keepIndices.add(messages.indexOf(msg));
          }
        }
        for (let i = 0; i < groups.length; i++) {
          if (!compressible[i]) {
            for (let j = groups[i].startIndex; j < groups[i].endIndex; j++) {
              keepIndices.add(j);
            }
          }
        }
        const result = messages.filter((_, idx) => keepIndices.has(idx));
        if (result.length > 0) return result;
      }
    } catch (err) {
      logger.warn('ContextCompactor: Phase 70 messageGrouper failed, fallback to L2 default', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.stage2SnipOldMessagesDefault(messages);
  }

  private stage2SnipOldMessagesDefault(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length <= SNIP_KEEP_RECENT) {
      return messages;
    }
    const recent = messages.slice(-SNIP_KEEP_RECENT);
    // 从前段中提取 system 消息（保持顺序）
    const systemMessages = messages
      .slice(0, messages.length - SNIP_KEEP_RECENT)
      .filter((m) => m.role === 'system');
    return [...systemMessages, ...recent];
  }

  // L3: Micro-Compaction — 删除 content 为空或仅含标记的消息
  private stage3MicroCompact(messages: LLMMessage[]): LLMMessage[] {
    return messages.filter((msg) => {
      if (typeof msg.content === 'string') {
        return msg.content.trim().length > 0;
      }
      // ContentPart[]：保留有内容块的消息
      if (Array.isArray(msg.content)) {
        return msg.content.length > 0;
      }
      return false;
    });
  }

  // L4: Context Collapse — 合并连续相同 role 的消息，去重相同工具结果
  // Phase 70：若 actionChainDetector 可用，先检测并折叠 action chains
  private stage4Collapse(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return messages;

    let current = messages;
    try {
      if (this.config.actionChainDetector) {
        const chains = this.config.actionChainDetector.detect(
          current.map((m) => ({ role: m.role, content: m.content })),
        );
        if (chains.length > 0) {
          current = this.collapseActionChains(current, chains);
          logger.info('ContextCompactor: Phase 70 ActionChainDetector collapsed', { chains: chains.length });
        }
      }
    } catch (err) {
      logger.warn('ContextCompactor: Phase 70 actionChainDetector failed, fallback to L4 default', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.stage4CollapseDefault(current);
  }

  private collapseActionChains(messages: LLMMessage[], chains: ActionChain[]): LLMMessage[] {
    const removeIndices = new Set<number>();
    const insertions = new Map<number, LLMMessage>();
    for (const chain of chains) {
      const collapsed = this.config.actionChainDetector!.collapseChain(chain);
      for (let i = chain.startIndex; i < chain.endIndex && i < messages.length; i++) {
        removeIndices.add(i);
      }
      insertions.set(chain.startIndex, { role: 'system', content: collapsed.content as string });
    }
    const result: LLMMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (insertions.has(i)) {
        result.push(insertions.get(i)!);
      }
      if (!removeIndices.has(i)) {
        result.push(messages[i]);
      }
    }
    return result;
  }

  private stage4CollapseDefault(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return messages;

    // 第一步：合并连续相同 role 的消息
    const merged: LLMMessage[] = [];
    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        merged[merged.length - 1] = this.mergeMessages(last, msg);
      } else {
        merged.push({ ...msg });
      }
    }

    // 第二步：去重相同的工具结果（按 toolUseId + content 判定）
    const seenToolResults = new Set<string>();
    const deduped: LLMMessage[] = [];
    for (const msg of merged) {
      if (Array.isArray(msg.content)) {
        const newParts = msg.content.filter((part) => {
          if (part.type === 'tool_result') {
            const key = `${part.toolUseId}:${part.content}`;
            if (seenToolResults.has(key)) return false;
            seenToolResults.add(key);
          }
          return true;
        });
        if (newParts.length > 0) {
          deduped.push({ ...msg, content: newParts });
        }
      } else {
        deduped.push(msg);
      }
    }

    return deduped;
  }

  /** 合并两条同 role 消息 */
  private mergeMessages(a: LLMMessage, b: LLMMessage): LLMMessage {
    if (typeof a.content === 'string' && typeof b.content === 'string') {
      return { role: a.role, content: a.content + '\n' + b.content };
    }
    // ContentPart[] 情况：合并数组
    const aParts = Array.isArray(a.content) ? a.content : [];
    const bParts = Array.isArray(b.content) ? b.content : [];
    return { role: a.role, content: [...aParts, ...bParts] };
  }

  // ============================================================
  // Phase 63：状态外部化辅助方法
  // ============================================================

  /**
   * L2 snip 阶段：用 KSentenceCompressor 压缩每条非 system 消息的字符串内容
   *
   * KSentenceCompressor.compressMessages 跳过 system 消息，对其他消息按打分保留前 k 句。
   * ContentPart[] 类型的消息保持原样（K-sentence 压缩仅适用于字符串内容）。
   */
  private applyKSentenceCompression(messages: LLMMessage[]): LLMMessage[] {
    if (!this.kSentenceCompressor) return messages;
    // KSentenceCompressor.compressMessages 接受宽松类型，这里做适配
    const adapted = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      _raw: m,
    }));
    const compressed = this.kSentenceCompressor.compressMessages(adapted);
    // 还原为 LLMMessage：ContentPart[] 消息保持原样，字符串消息替换为压缩后内容
    return compressed.map((m, i) => {
      const original = messages[i];
      if (typeof original.content !== 'string') return original;
      return { role: m.role, content: typeof m.content === 'string' ? m.content : original.content } as LLMMessage;
    });
  }

  /**
   * L2 snip 阶段：用 ContentDeduplicator 去重字符串消息内容
   *
   * 仅对字符串内容做去重（长度 >= minLength 才参与去重）。
   * 重复内容根据配置替换为引用标记（如 [...DEDUP:hash=xxx first=#0...]）。
   * ContentPart[] 消息不参与去重（已在 stage4Collapse 中处理 tool_result 去重）。
   */
  private applyContentDedup(messages: LLMMessage[]): LLMMessage[] {
    if (!this.contentDeduplicator) return messages;

    const stringIndices: number[] = [];
    const stringItems: LLMMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (typeof messages[i].content === 'string') {
        stringIndices.push(i);
        stringItems.push(messages[i]);
      }
    }
    if (stringItems.length === 0) return messages;

    const result = this.contentDeduplicator.dedup(
      stringItems,
      (msg) => (typeof msg.content === 'string' ? msg.content : ''),
    );

    // 把去重后的结果回填到原位置（重复项可能被替换为字符串标记）
    const newMessages = [...messages];
    for (let i = 0; i < stringIndices.length; i++) {
      const idx = stringIndices[i];
      const item = result.items[i];
      // 如果是字符串标记（被替换为引用），item 是 string 而非 LLMMessage
      if (typeof item === 'string') {
        newMessages[idx] = { role: newMessages[idx].role, content: item };
      } else {
        newMessages[idx] = item;
      }
    }
    return newMessages;
  }

  /**
   * 压缩后：把压缩结果中的关键内容加入 CuratedSet
   *
   * 提取每条消息的字符串内容加入策展集，由 CuratedSet 自动分类为
   * critical / useful / obsolete。后续可通过 getCuratedSet() 取出策展集。
   */
  private populateCuratedSet(messages: LLMMessage[]): void {
    if (!this.curatedSet) return;
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.length === 0) continue;
      // 异步加入但不需要等待——策展集是积累式的，失败不影响压缩主流程
      this.curatedSet.add(content, `compaction:${msg.role}`).catch(() => {
        // CuratedSet.add 当前为同步实现，catch 仅作防御
      });
    }
  }

  /**
   * 压缩后：把本次压缩作为一条 claim 记录入 VerificationRecords
   *
   * targetHash 用压缩前消息的 JSON 哈希，便于后续 isVerified 判断输入是否变化。
   * passed = !summaryFailed（L5 失败视为未通过）。
   */
  private recordCompactionVerification(
    before: LLMMessage[],
    after: LLMMessage[],
    maxStageReached: 1 | 2 | 3 | 4 | 5,
    summaryFailed: boolean,
  ): void {
    if (!this.verificationRecords) return;
    try {
      const target = 'context-compaction';
      const targetHash = this.verificationRecords.hashContent(
        JSON.stringify(before.map((m) => ({ role: m.role, content: m.content }))),
      );
      this.verificationRecords.record({
        type: 'claim',
        target,
        targetHash,
        passed: !summaryFailed,
        source: `ContextCompactor(stage=${maxStageReached}, afterLen=${after.length})`,
      });
    } catch (err) {
      logger.warn('ContextCompactor: 记录验证状态失败', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Phase 63：获取 CuratedSet 实例（仅在 curatedSet.enabled 时存在）
   *
   * 供外部调用方读取策展集状态（如渲染到 prompt、查询 chunk 等）。
   */
  getCuratedSet(): CuratedSet | null {
    return this.curatedSet;
  }

  /**
   * Phase 63：获取 VerificationRecords 实例（仅在 verificationRecords.enabled 时存在）
   *
   * 供外部调用方查询历史压缩记录、判断是否需要重新验证等。
   */
  getVerificationRecords(): VerificationRecords | null {
    return this.verificationRecords;
  }

  /** 计算消息列表的总 token 数（P8：使用 WeakMap 缓存，避免重复计算） */
  private totalTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // P8：同一消息引用复用缓存结果（stage 产生新对象时不命中缓存，自动重算）
      const cached = this.tokenCache.get(msg);
      if (cached !== undefined) {
        total += cached;
      } else {
        const t = this.messageTokens(msg);
        this.tokenCache.set(msg, t);
        total += t;
      }
    }
    return total;
  }

  /** 计算单条消息的 token 数 */
  private messageTokens(msg: LLMMessage): number {
    if (typeof msg.content === 'string') {
      return this.config.estimateTokens(msg.content);
    }
    if (Array.isArray(msg.content)) {
      return msg.content.reduce((sum, part) => sum + this.partTokens(part), 0);
    }
    return 0;
  }

  /** 计算 ContentPart 的 token 数 */
  private partTokens(part: ContentPart): number {
    switch (part.type) {
      case 'text':
        return this.config.estimateTokens(part.text);
      case 'tool_result':
        return this.config.estimateTokens(part.content);
      case 'tool_use':
        return this.config.estimateTokens(part.name + JSON.stringify(part.arguments));
      case 'image':
        // B5：图片 token 估算（Anthropic 公式：基于 base64 数据量粗估）
        // 公式：Math.ceil(base64Length / 750)，近似 (width*height/750) + 1500 的平均值
        // 对于无尺寸信息的 base64，按数据量估算：每 750 字节 ≈ 1 token（含 overhead）
        if (part.source && typeof part.source === 'object' && 'data' in part.source) {
          const data = (part.source as { data: string }).data ?? '';
          return Math.ceil(data.length / 750) + 85; // +85 为图片固定 overhead
        }
        return 256; // 无数据时给保守估值
      default:
        return 0;
    }
  }
}
