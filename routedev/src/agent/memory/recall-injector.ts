// src/agent/memory/recall-injector.ts
// Phase 71 Task B3：记忆召回注入器——把 KnowledgeGraph.recall() 结果格式化为 system prompt 片段
// Phase 96 修复 I-2/I-3：接入 KG.improve/forget 到生产路径，避免知识图谱只增不减
//
// 工作时机：
//   - 由 ReActAgentLoop.run() 在每轮循环开始时调用 recallToPrompt(userMessage)
//   - 召回结果按 injectThreshold 过滤后格式化为【相关记忆】片段
//   - 注入到 systemPrompt 末尾，让 LLM 在推理时能引用历史决策/事实
//   - 召回后立即对命中节点调用 improve({ outcome: 'partially_useful' }) 刷新 updatedAt（延缓衰减）
//   - ReActAgentLoop session 结束时调用 commitUsefulFeedback() 标记 useful（强化 validatedCount）
//   - recallToPrompt 时顺带调用 forgetStaleMemories() 清理长期未使用节点
//
// fail-open 原则：
//   - graph.recall / improve / forget 抛错时返回空字符串或跳过，不阻塞 ReAct 循环
//   - 空查询返回空字符串

import type { KnowledgeGraph } from './graph.js';
import { logger } from '../../utils/logger.js';
// Phase 97 Part I Task I2：记忆命中计数（记录点：recallToPrompt 命中时）
import type { HitStat } from '../../memory/hit-stat.js';

// Phase 97 Part I Task I2 接线：低触发评估节流间隔（10 分钟一次，避免每次召回全量扫描统计表）
const LOW_HIT_EVAL_INTERVAL_MS = 10 * 60 * 1000;
/** 低触发评估窗口：仅统计窗口内命中（最近命中早于窗口起点视为窗口内 0 次） */
const LOW_HIT_EVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 低触发阈值：窗口内命中次数低于该值视为低触发（建议级，不自动淘汰） */
const LOW_HIT_MIN_HITS = 2;

/** 召回并适配后的记忆条目（对外暴露，便于测试与扩展） */
export interface RecalledMemory {
  /** 记忆内容（GraphNode.content） */
  fact: string;
  /** 置信度（recall 返回的 score，综合 PPR 与置信度） */
  confidence: number;
  /** 来源（GraphNode.type：'fact'|'decision'|'skill'|'event'） */
  source: string;
  /** 召回时间戳 */
  recalledAt: number;
}

/**
 * 记忆召回注入器
 *
 * 把 KnowledgeGraph.recall() 的原始结果适配为 RecalledMemory，
 * 按 injectThreshold 过滤后格式化为可注入 system prompt 的字符串片段。
 *
 * Phase 96 I-2/I-3：同时承担记忆生命周期反馈职责——
 * 召回时刷新 updatedAt，session 结束时强化 validatedCount，长期未使用节点自动 forget。
 */
export class MemoryRecallInjector {
  /** 上次召回命中的节点 ID 列表（用于 session 结束时反馈 useful） */
  private lastRecalledNodeIds: string[] = [];
  /** Phase 97 Part I Task I2 接线：上次低触发评估时间戳（节流用） */
  private lastLowHitEvalAt = 0;
  /**
   * Phase 96 R-2 修复：图谱持久化回调
   * session 结束反馈 useful 后立即调用，避免进程崩溃丢失整个 session 的知识强化数据。
   * 由 app-init-memory.ts 装配时注入 contextManager.flushGraphToDisk.bind(contextManager)。
   * fail-open：未注入或抛错时仅记日志。
   */
  private graphFlusher: (() => void) | null = null;

  constructor(
    private readonly graph: KnowledgeGraph,
    private readonly injectThreshold: number = 0.7,
    private readonly maxMemories: number = 5,
    /** 长期未使用阈值：unusedCount 超过此值的节点会被 forget（Phase 96 I-3） */
    private readonly staleUnusedThreshold: number = 10,
    /** Phase 97 Part I Task I2：命中计数（可选注入；未注入时跳过记录） */
    private readonly hitStat?: HitStat,
  ) {}

  /**
   * Phase 96 R-2：注入图谱持久化回调
   * 调用时机：commitUsefulFeedback() 末尾——session 结束反馈 useful 后立即落盘
   * 传入 null 可显式卸载（用于测试或热重载场景）
   */
  setGraphFlusher(flusher: (() => void) | null): void {
    this.graphFlusher = flusher;
  }

  /**
   * 根据当前 query 召回相关记忆，格式化为 system prompt 片段。
   *
   * @param query 当前用户消息或上下文查询字符串
   * @returns 格式化后的【相关记忆】片段；无召回或全部低于阈值时返回空字符串
   *
   * fail-open：graph.recall 抛错时返回空字符串，不阻塞主流程
   */
  recallToPrompt(query: string): string {
    try {
      if (!query || query.trim().length === 0) return '';
      const memories = this.graph.recall(query, { maxResults: this.maxMemories });
      // 适配 GraphNode → RecalledMemory
      const adapted: RecalledMemory[] = memories.map(m => ({
        fact: m.node.content,
        confidence: m.score,
        source: m.node.type,
        recalledAt: Date.now(),
      }));
      const filtered = adapted.filter(m => m.confidence >= this.injectThreshold);
      if (filtered.length === 0) return '';

      // Phase 97 Part I Task I2：命中计数（每个命中节点 record 一次，供低触发评估）
      // fail-open：hitStat 未注入或 record 抛错均不影响召回主流程
      if (this.hitStat) {
        try {
          for (const m of memories) {
            if (m.score >= this.injectThreshold) {
              this.hitStat.record(`memory:${m.node.id}`, 'memory');
            }
          }

          // Phase 97 Part I Task I2 接线：生产消费 evaluateLowHits——节流评估低触发记忆
          // 仅记录日志建议（不自动淘汰），与 hitStat.record 共用本 fail-open try/catch
          if (Date.now() - this.lastLowHitEvalAt >= LOW_HIT_EVAL_INTERVAL_MS) {
            this.lastLowHitEvalAt = Date.now();
            const lowHits = this.hitStat.evaluateLowHits(
              Date.now() - LOW_HIT_EVAL_WINDOW_MS,
              LOW_HIT_MIN_HITS,
            );
            if (lowHits.length > 0) {
              logger.info('MemoryRecallInjector: low-hit memories detected (suggestion only, no auto-eviction)', {
                count: lowHits.length,
                windowMs: LOW_HIT_EVAL_WINDOW_MS,
                minHits: LOW_HIT_MIN_HITS,
                samples: lowHits.slice(0, 5).map((h) => h.key),
              });
            }
          }
        } catch (hitErr) {
          logger.debug('MemoryRecallInjector: hitStat.record failed (fail-open)', {
            error: hitErr instanceof Error ? hitErr.message : String(hitErr),
          });
        }
      }

      // Phase 96 I-2：记录命中的 nodeIds，session 结束时反馈 useful
      this.lastRecalledNodeIds = memories
        .filter(m => m.score >= this.injectThreshold)
        .map(m => m.node.id);

      // Phase 96 I-2：立即对命中节点调用 improve({ outcome: 'partially_useful' })
      // 刷新 updatedAt 延缓时间衰减（computeConfidence 中 ~70 天衰减趋零）
      // fail-open：improve 抛错不影响召回结果
      if (this.lastRecalledNodeIds.length > 0) {
        try {
          this.graph.improve({
            query,
            nodeIds: this.lastRecalledNodeIds,
            outcome: 'partially_useful',
          });
        } catch (improveErr) {
          logger.debug('MemoryRecallInjector: improve(partially_useful) failed (fail-open)', {
            error: improveErr instanceof Error ? improveErr.message : String(improveErr),
          });
        }
      }

      // Phase 96 R-1 修复：对「被召回但低于 injectThreshold 的节点」调用 improve({outcome:'unused'})
      // 之前 unusedCount 仅在 outcome:'unused' 时递增，但该 outcome 零生产调用方，
      // 导致 forgetStaleMemories() 永远无法触发（unusedCount 永远为 0）。
      // 现在把召回但未达阈值的节点标记为 unused，让 forget() 真正能清理过期知识。
      const unusedNodeIds = memories
        .filter(m => m.score < this.injectThreshold)
        .map(m => m.node.id);
      if (unusedNodeIds.length > 0) {
        try {
          this.graph.improve({
            query,
            nodeIds: unusedNodeIds,
            outcome: 'unused',
          });
        } catch (improveUnusedErr) {
          logger.debug('MemoryRecallInjector: improve(unused) failed (fail-open)', {
            error: improveUnusedErr instanceof Error ? improveUnusedErr.message : String(improveUnusedErr),
          });
        }
      }

      // Phase 96 I-3：顺带清理长期未使用节点（fail-open，不阻塞召回）
      this.forgetStaleMemories();

      const lines = filtered.map(m =>
        `- ${m.fact}（置信度: ${m.confidence.toFixed(2)}, 来源: ${m.source}）`,
      );
      return `\n\n【相关记忆】\n${lines.join('\n')}`;
    } catch (err) {
      logger.warn('memory recall failed, fail-open', { err });
      return ''; // fail-open
    }
  }

  /**
   * Session 结束时反馈 useful：把上次召回命中的节点 validatedCount += 1
   *
   * 调用时机：ReActAgentLoop.run() 的 finally 块——session 完成 = 召回的记忆确实被使用
   * fail-open：graph.improve 抛错时仅记日志，不阻塞 session 结束流程
   */
  commitUsefulFeedback(): void {
    // Phase 96 R-2：即使 lastRecalledNodeIds 为空，也尝试 flush
    // 原因：recallToPrompt 中对未命中阈值节点调用了 improve(unused)，可能触发 forgetStaleMemories() → forget()
    // 这些图谱变更同样需要落盘，不能仅依赖 shutdown hook（进程崩溃会丢失）
    const hadFeedback = this.lastRecalledNodeIds.length > 0;
    if (hadFeedback) {
      try {
        this.graph.improve({
          query: '', // session 结束时不带 query
          nodeIds: this.lastRecalledNodeIds,
          outcome: 'useful',
        });
        logger.debug('MemoryRecallInjector: committed useful feedback', {
          nodeCount: this.lastRecalledNodeIds.length,
        });
      } catch (err) {
        logger.debug('MemoryRecallInjector: commitUsefulFeedback failed (fail-open)', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // 清空以备下次 session
        this.lastRecalledNodeIds = [];
      }
    }

    // Phase 96 R-2 修复：立即持久化图谱变更
    // 之前仅通过 shutdown hook（app-init-memory.ts:350-352）落盘，进程崩溃会丢失整个 session 的反馈数据
    // 现在在 commitUsefulFeedback 末尾立即 flush，确保 improve/forget 变更及时落地
    if (this.graphFlusher) {
      try {
        this.graphFlusher();
      } catch (err) {
        logger.debug('MemoryRecallInjector: graphFlusher failed (fail-open)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * 清理长期未使用的记忆节点（Phase 96 I-3）
   *
   * 遍历图中所有节点，对 unusedCount 超过阈值的节点调用 graph.forget()
   * fail-open：任何异常仅记日志，不阻塞主流程
   */
  forgetStaleMemories(): void {
    try {
      // graph 暴露 listNodes() 用于遍历；若无此方法则跳过
      const graph = this.graph as unknown as {
        listNodes?: () => Array<{ id: string; unusedCount?: number; deprecated?: boolean }>;
      };
      if (typeof graph.listNodes !== 'function') return;

      const staleNodes = graph.listNodes()
        .filter(n => !n.deprecated && (n.unusedCount ?? 0) > this.staleUnusedThreshold)
        .map(n => n.id);

      if (staleNodes.length === 0) return;

      this.graph.forget({ nodeIds: staleNodes });
      logger.info('MemoryRecallInjector: forgot stale memories', {
        count: staleNodes.length,
        threshold: this.staleUnusedThreshold,
      });
    } catch (err) {
      logger.debug('MemoryRecallInjector: forgetStaleMemories failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
