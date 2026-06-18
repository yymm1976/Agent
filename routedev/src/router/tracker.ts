// src/router/tracker.ts
// Token 追踪器：多维度归因统计 + 每日自动重置 + 预算检查
// 支持：全局、按模型、按 Agent、按步骤的 Token 使用追踪

import type { TokenUsageInfo, TokenBudget } from './types.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';

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
 * Token 追踪器
 * 功能：
 * - 记录每次 LLM 调用的 Token 使用
 * - 多维度归因统计（模型、Agent、步骤）
 * - 每日自动重置（00:00 检查）
 * - 预算检查（enforce 模式下超限触发降级）
 */
export class TokenTracker {
  private budget: TokenBudget;
  private records: TokenUsageRecord[] = [];
  private currentDate: string;
  private checkInterval: NodeJS.Timeout | null = null;
  private persistPath: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly PERSIST_DEBOUNCE_MS = 500;

  constructor(budget: TokenBudget) {
    this.budget = budget;
    this.currentDate = this.getTodayString();
    this.persistPath = join(getAppDataDir(), 'token-usage.json');
    this.loadFromDisk();
    this.startDailyCheck();
  }

  /**
   * 记录 Token 使用
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
   * 检查预算
   * @returns true 表示在预算内，false 表示超限
   */
  checkBudget(): boolean {
    if (this.budget.mode === 'track_only') {
      return true;
    }

    const stats = this.getStats();
    const usagePercent = stats.total.totalTokens / this.budget.dailyLimit;

    if (usagePercent >= 1) {
      logger.warn('Token budget exceeded', {
        used: stats.total.totalTokens,
        limit: this.budget.dailyLimit,
      });
      return false;
    }

    if (usagePercent >= this.budget.degradationThreshold) {
      logger.warn('Token budget approaching limit', {
        used: stats.total.totalTokens,
        limit: this.budget.dailyLimit,
        percent: (usagePercent * 100).toFixed(1) + '%',
      });
    }

    return true;
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
      const dir = getAppDataDir();
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
      const dir = getAppDataDir();
      ensureDir(dir);
      const data: PersistedData = {
        date: this.currentDate,
        records: this.records,
      };
      // 动态引入 writeFileSync 避免在非退出路径使用
      const { writeFileSync } = require('fs');
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Failed to save token usage (sync)', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
