// src/router/tracker.ts
// Token 追踪器：多维度归因统计 + 每日自动重置 + 预算检查
// 支持：全局、按模型、按 Agent、按步骤的 Token 使用追踪

import type { TokenUsageInfo, TokenBudget } from './types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
// Phase 32 Task 2.4：接入 CacheStatsTracker，记录缓存命中数据
import { CacheStatsTracker } from './cache-optimizer.js';

/** Token 使用记录 */
export interface TokenUsageRecord {
  timestamp: number;
  modelId: string;
  agentId: string;
  stepId: string;
  usage: TokenUsageInfo;
}

/** 聚合统计 */
export interface TokenStats {
  total: TokenUsageInfo;
  byModel: Record<string, TokenUsageInfo>;
  byAgent: Record<string, TokenUsageInfo>;
  byStep: Record<string, TokenUsageInfo>;
}

/** 持久化数据格式 */
interface PersistedData {
  date: string; // YYYY-MM-DD
  records: TokenUsageRecord[];
}

/**
 * Phase 31 Task 6.3：任务级 Token 预算状态
 * - ok：使用率 < 80%
 * - warning：使用率 ≥ 80%（接近上限）
 * - exceeded：使用率 ≥ 100%（已超限，应中止任务）
 */
export type TaskBudgetStatus = 'ok' | 'warning' | 'exceeded';

/**
 * Token 追踪器
 * 功能：
 * - 记录每次 LLM 调用的 Token 使用
 * - 多维度归因统计（模型、Agent、步骤）
 * - 每日自动重置（00:00 检查）
 * - 预算检查（enforce 模式下超限触发降级）
 * - Phase 31 Task 6.3：单任务 Token 熔断（Cost Circuit Breaker）
 *   - 任务级预算独立于日限额
 *   - 80% 警告、100% 中止
 *   - perRequestLimit 接入 checkBudget
 */
export class TokenTracker {
  private budget: TokenBudget;
  private records: TokenUsageRecord[] = [];
  private currentDate: string;
  private checkInterval: NodeJS.Timeout | null = null;
  private persistPath: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly PERSIST_DEBOUNCE_MS = 500;

  // Phase 31 Task 6.3：任务级预算
  private taskBudget: number = 0;
  private taskSpent: number = 0;
  private taskActive: boolean = false;

  // M4 优化：累计已用 token 缓存，避免 checkBudget 每次遍历全部 records O(n)
  private totalUsedCache: number | null = null;

  // Phase 32 Task 2.4：缓存统计追踪器（Layer 5/6：会话级累计计数器 + 绝对计数展示）
  private cacheStatsTracker: CacheStatsTracker | null = null;

  constructor(budget: TokenBudget, options?: { persistPath?: string }) {
    this.budget = budget;
    this.currentDate = this.getTodayString();
    this.persistPath = options?.persistPath ?? join(getAppDataDir(), 'token-usage.json');
    this.loadFromDisk();
    this.startDailyCheck();
  }

  /**
   * Phase 32 Task 2.4：注入 CacheStatsTracker
   * 注入后，每次 record() 会自动记录缓存命中数据
   */
  setCacheStatsTracker(tracker: CacheStatsTracker | null): void {
    this.cacheStatsTracker = tracker;
  }

  /**
   * Phase 32 Task 2.4：获取缓存统计追踪器（供 UI 层展示缓存命中率）
   */
  getCacheStatsTracker(): CacheStatsTracker | null {
    return this.cacheStatsTracker;
  }

  /**
   * 记录 Token 使用
   *
   * Phase 31/32 P0 接线修正：record() 同时负责全局 records 和 taskSpent 累加
   * recordTaskUsage() 只查询当前任务预算状态，不再累加（避免双计数）
   * 调用方在 record() 后调用 recordTaskUsage() 查询任务预算状态
   */
  record(usage: TokenUsageInfo, context: { modelId: string; agentId: string; stepId: string }): void {
    const record: TokenUsageRecord = {
      timestamp: Date.now(),
      modelId: context.modelId,
      agentId: context.agentId,
      stepId: context.stepId,
      usage,
    };
    this.records.push(record);

    // M4 优化：新记录加入后失效缓存，下次 checkBudget 重新计算
    this.totalUsedCache = null;

    // Phase 31 Task 6.3：任务激活时累加 taskSpent（与日限额共用同一次 record 调用，避免双计数）
    if (this.taskActive) {
      this.taskSpent += usage.totalTokens;
    }

    // Phase 32 Task 2.4：记录缓存命中统计（Layer 5：会话级累计计数器）
    // 多 Provider 缓存字段归一化：cacheReadInputTokens（Anthropic）/ cached_tokens（OpenAI）
    if (this.cacheStatsTracker) {
      const cacheHit = usage.cacheReadInputTokens ?? 0;
      const cacheMiss = Math.max(0, usage.inputTokens - cacheHit);
      this.cacheStatsTracker.record(cacheHit, cacheMiss, context.modelId);
    }

    // 异步持久化到磁盘（debounce 500ms，避免高频写入阻塞事件循环）
    this.schedulePersist();

    logger.debug('Token usage recorded', {
      modelId: context.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    });
  }

  /**
   * 获取当前统计
   */
  getStats(): TokenStats {
    const stats: TokenStats = {
      total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      byModel: {},
      byAgent: {},
      byStep: {},
    };

    for (const record of this.records) {
      // 总计
      stats.total.inputTokens += record.usage.inputTokens;
      stats.total.outputTokens += record.usage.outputTokens;
      stats.total.totalTokens += record.usage.totalTokens;

      // 按模型
      if (!stats.byModel[record.modelId]) {
        stats.byModel[record.modelId] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      stats.byModel[record.modelId].inputTokens += record.usage.inputTokens;
      stats.byModel[record.modelId].outputTokens += record.usage.outputTokens;
      stats.byModel[record.modelId].totalTokens += record.usage.totalTokens;

      // 按 Agent
      if (!stats.byAgent[record.agentId]) {
        stats.byAgent[record.agentId] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      stats.byAgent[record.agentId].inputTokens += record.usage.inputTokens;
      stats.byAgent[record.agentId].outputTokens += record.usage.outputTokens;
      stats.byAgent[record.agentId].totalTokens += record.usage.totalTokens;

      // 按步骤
      if (!stats.byStep[record.stepId]) {
        stats.byStep[record.stepId] = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      }
      stats.byStep[record.stepId].inputTokens += record.usage.inputTokens;
      stats.byStep[record.stepId].outputTokens += record.usage.outputTokens;
      stats.byStep[record.stepId].totalTokens += record.usage.totalTokens;
    }

    return stats;
  }

  /**
   * M4 优化：获取累计已用 token 总数（带缓存）
   * 避免 checkBudget 高频调用时每次遍历全部 records O(n)
   * 缓存在 record() / reset() 时失效
   */
  private getTotalUsed(): number {
    if (this.totalUsedCache === null) {
      let total = 0;
      for (const record of this.records) {
        total += record.usage.totalTokens;
      }
      this.totalUsedCache = total;
    }
    return this.totalUsedCache;
  }

  /**
   * 检查预算
   * @returns true 表示在预算内，false 表示超限
   *
   * Phase 31 Task 6.3：接入 perRequestLimit 检查（之前已定义但从未检查）
   */
  checkBudget(): boolean {
    if (this.budget.mode === 'track_only') {
      return true;
    }

    // M4 优化：使用缓存的累计 token 数，避免每次调用 getStats() 遍历全部 records O(n)
    const totalUsed = this.getTotalUsed();
    const usagePercent = totalUsed / this.budget.dailyLimit;

    if (usagePercent >= 1) {
      logger.warn('Token budget exceeded', {
        used: totalUsed,
        limit: this.budget.dailyLimit,
      });
      return false;
    }

    if (usagePercent >= this.budget.degradationThreshold) {
      logger.warn('Token budget approaching limit', {
        used: totalUsed,
        limit: this.budget.dailyLimit,
        percent: (usagePercent * 100).toFixed(1) + '%',
      });
    }

    // Phase 31 Task 6.3：检查 perRequestLimit（单次请求上限）
    // 注意：perRequestLimit 是单次请求的上限，这里在 checkBudget 中检查最近一次记录是否超限
    if (this.budget.perRequestLimit && this.records.length > 0) {
      const lastRecord = this.records[this.records.length - 1];
      if (lastRecord.usage.totalTokens > this.budget.perRequestLimit) {
        logger.warn('Per-request token limit exceeded', {
          lastRequestTokens: lastRecord.usage.totalTokens,
          perRequestLimit: this.budget.perRequestLimit,
        });
        return false;
      }
    }

    return true;
  }

  // ===== Phase 31 Task 6.3：单任务 Token 熔断（Cost Circuit Breaker） =====

  /**
   * 任务开始时调用，设定该任务的 token 预算
   * @param budgetTokens 任务级 token 预算（通常来自 config.router.budget.perRequestLimit 或默认 50000）
   */
  startTask(budgetTokens: number): void {
    this.taskBudget = budgetTokens;
    this.taskSpent = 0;
    this.taskActive = true;
    logger.info('Task token budget started', { budget: budgetTokens });
  }

  /**
   * 查询当前任务预算状态（不累加，累加由 record() 完成）
   * @returns 'ok' | 'warning'(80%) | 'exceeded'(100%)
   */
  recordTaskUsage(_usage?: TokenUsageInfo): TaskBudgetStatus {
    if (!this.taskActive) return 'ok';
    // Phase 31/32 P0 接线修正：taskSpent 由 record() 累加，此处只查询状态
    // 参数 _usage 保留以向后兼容，但不使用（避免双计数）
    const percent = this.taskBudget > 0 ? this.taskSpent / this.taskBudget : 0;
    if (percent >= 1) {
      logger.warn('Task token budget exceeded', {
        spent: this.taskSpent,
        budget: this.taskBudget,
      });
      return 'exceeded';
    }
    if (percent >= 0.8) {
      logger.warn('Task token budget approaching limit', {
        spent: this.taskSpent,
        budget: this.taskBudget,
        percent: (percent * 100).toFixed(1) + '%',
      });
      return 'warning';
    }
    return 'ok';
  }

  /**
   * 获取当前任务的使用百分比
   */
  getTaskUsagePercent(): number {
    if (!this.taskActive || this.taskBudget === 0) return 0;
    return this.taskSpent / this.taskBudget;
  }

  /**
   * 结束任务（清除任务级预算追踪）
   */
  endTask(): void {
    this.taskActive = false;
    this.taskBudget = 0;
    this.taskSpent = 0;
  }

  /**
   * 任务是否激活
   */
  isTaskActive(): boolean {
    return this.taskActive;
  }

  /**
   * 获取当前使用百分比
   */
  getUsagePercent(): number {
    const stats = this.getStats();
    return stats.total.totalTokens / this.budget.dailyLimit;
  }

  /**
   * 重置统计（每日自动调用）
   */
  reset(): void {
    this.records = [];
    // M4 优化：重置后失效缓存
    this.totalUsedCache = null;
    this.currentDate = this.getTodayString();
    this.schedulePersist();
    logger.info('Token tracker reset for new day', { date: this.currentDate });
  }

  /**
   * 销毁追踪器（清理定时器 + 同步写入最终数据）
   */
  destroy(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // 进程退出前同步写入最终数据
    this.persistSync();
  }

  /**
   * 获取今日字符串（YYYY-MM-DD）
   */
  private getTodayString(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /**
   * 启动每日检查定时器
   */
  private startDailyCheck(): void {
    // 每小时检查一次日期
    this.checkInterval = setInterval(() => {
      const today = this.getTodayString();
      if (today !== this.currentDate) {
        this.reset();
      }
    }, 60 * 60 * 1000); // 1 小时
  }

  /**
   * 从磁盘加载数据
   */
  private loadFromDisk(): void {
    try {
      if (existsSync(this.persistPath)) {
        const data = JSON.parse(readFileSync(this.persistPath, 'utf-8')) as PersistedData;
        // 如果是今天的数据，加载记录；否则忽略（自动重置）
        if (data.date === this.currentDate) {
          this.records = data.records;
          logger.debug('Token usage loaded from disk', { recordCount: this.records.length });
        }
      }
    } catch (err) {
      logger.error('Failed to load token usage', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 调度异步持久化（debounce 500ms）
   * 高频 record() 调用时合并为一次写入，避免阻塞事件循环
   */
  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistAsync().catch(err => {
        logger.error('Failed to persist token usage (async)', { error: err instanceof Error ? err.message : String(err) });
      });
    }, this.PERSIST_DEBOUNCE_MS);
  }

  /**
   * 异步写入磁盘（Phase 26 Task 5：替代原 writeFileSync）
   */
  private async persistAsync(): Promise<void> {
    try {
      const dir = dirname(this.persistPath);
      ensureDir(dir);
      const data: PersistedData = {
        date: this.currentDate,
        records: this.records,
      };
      await writeFile(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Failed to save token usage (async)', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 同步写入磁盘（仅用于进程退出前的最终写入）
   * 使用 writeFileSync 确保进程退出前数据落盘
   */
  private persistSync(): void {
    try {
      const dir = dirname(this.persistPath);
      ensureDir(dir);
      const data: PersistedData = {
        date: this.currentDate,
        records: this.records,
      };
      // C1 修复：ESM 中 require 未定义，直接使用顶部导入的 writeFileSync
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Failed to save token usage (sync)', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
