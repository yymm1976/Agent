// src/observability/usage-counter.ts
// Phase 80 Task 2：本地使用遥测计数器
//
// 设计原则：
//   1. 仅本地计数，禁止云上报（隐私优先）
//   2. fail-open：计数异常绝不影响主流程（increment/snapshot/flushToFile 全部 catch）
//   3. 仅计数 key（如 tool:file_read、command:/help），不记录参数/内容
//   4. flushToFile 写入 .routedev/usage/ 目录下的 JSON 文件
//
// 借鉴 Claude Code 的 UsageTracker：轻量本地统计，供 /usage 命令导出摘要

import { logger } from '../utils/logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// 类型定义
// ============================================================

/** 使用事件（辨识联合，按 kind 区分计数维度） */
export type UsageEvent =
  | { kind: 'tool'; name: string }
  | { kind: 'command'; name: string }
  | { kind: 'pack'; name: string; action: 'load' | 'skip' }
  | { kind: 'config_gate'; name: string; enabled: boolean };

// ============================================================
// UsageCounter
// ============================================================

/**
 * 本地使用计数器
 *
 * - increment：按事件构造 key 并累加，fail-open
 * - snapshot：返回当前计数快照（key → count），fail-open
 * - flushToFile：将快照写入 JSON 文件，fail-open
 *
 * key 格式约定：
 *   - tool:file_read
 *   - command:/help
 *   - pack:multi-agent:load
 */
export class UsageCounter {
  /** 计数表（key → 累计次数） */
  private readonly counts: Map<string, number> = new Map();
  /** 计数起始时间（用于导出摘要标注统计窗口） */
  private readonly startedAt: number;

  constructor() {
    this.startedAt = Date.now();
  }

  /**
   * 累加一次使用事件
   * fail-open：内部 catch 所有异常，不抛到调用方
   */
  increment(event: UsageEvent): void {
    try {
      const key = this.buildKey(event);
      const current = this.counts.get(key) ?? 0;
      this.counts.set(key, current + 1);
    } catch (err) {
      // fail-open：计数失败仅记录日志，不影响主流程
      logger.debug('UsageCounter.increment 失败，fail-open 跳过', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 返回当前计数快照（key → count 的浅拷贝）
   * fail-open：异常时返回空对象
   */
  snapshot(): Record<string, number> {
    try {
      const result: Record<string, number> = {};
      for (const [key, count] of this.counts) {
        result[key] = count;
      }
      return result;
    } catch (err) {
      logger.debug('UsageCounter.snapshot 失败，fail-open 返回空对象', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /**
   * 将快照写入 JSON 文件
   *
   * @param filePath 目标文件路径（调用方负责构造，通常位于 .routedev/usage/ 下）
   * @returns 无返回值；失败时 fail-open 仅记录日志
   *
   * fail-open：文件写入失败不抛异常，避免阻断 /usage 命令
   */
  async flushToFile(filePath: string): Promise<void> {
    try {
      // 确保父目录存在（recursive 创建）
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });

      // 构造导出载荷：元数据 + 计数快照
      const payload = {
        exportedAt: new Date().toISOString(),
        startedAt: new Date(this.startedAt).toISOString(),
        windowDays: 7,
        counts: this.snapshot(),
      };

      const json = JSON.stringify(payload, null, 2);
      fs.writeFileSync(filePath, json, 'utf-8');
    } catch (err) {
      // fail-open：写入失败仅记录日志，不抛异常
      logger.warn('UsageCounter.flushToFile 失败，fail-open 跳过', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 根据事件类型构造计数 key
   * - tool → tool:<name>
   * - command → command:<name>
   * - pack → pack:<name>:<action>
   * - config_gate → config_gate:<name>:<enabled>
   */
  private buildKey(event: UsageEvent): string {
    switch (event.kind) {
      case 'tool':
        return `tool:${event.name}`;
      case 'command':
        return `command:${event.name}`;
      case 'pack':
        return `pack:${event.name}:${event.action}`;
      case 'config_gate':
        return `config_gate:${event.name}:${event.enabled}`;
      default:
        // 防御性兜底：未知事件类型用 kind 前缀
        return `unknown:${(event as { kind: string }).kind}`;
    }
  }
}
