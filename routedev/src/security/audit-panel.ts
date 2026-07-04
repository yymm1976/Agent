// src/security/audit-panel.ts
// 统一安全审计面板
//
// 设计目标：
//   1. 单进程内单例，统一收集来自多个安全机制（sandbox / path-guard / mcp-scanner /
//      config-guard / intent-guard / policy-engine）的安全事件
//   2. 提供按 level / source / action 维度的过滤查询
//   3. 提供汇总统计（总数、blocked/allowed/warned、按 source / level 分组）
//   4. 提供文本报告导出（用于 /security 命令展示）
//   5. 内存上限保护：超过 maxEvents 时丢弃最旧事件（FIFO）
//
// 不引入外部依赖，不写文件——持久化由调用方决定

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

export type SecurityEventLevel = 'info' | 'warn' | 'error' | 'critical';

export interface SecurityEvent {
  /** 毫秒时间戳 */
  timestamp: number;
  /** 严重级别 */
  level: SecurityEventLevel;
  /** 事件来源（'sandbox' | 'path-guard' | 'mcp-scanner' | 'config-guard' | 'intent-guard' | 'policy-engine'） */
  source: string;
  /** 动作（'blocked' | 'allowed' | 'warned' | 'logged'） */
  action: string;
  /** 被检查的目标（命令 / 路径 / 配置等） */
  target: string;
  /** 拦截原因（可选） */
  reason?: string;
  /** 附加元数据（可选） */
  metadata?: Record<string, unknown>;
}

/** 事件过滤条件 */
export interface SecurityEventFilter {
  level?: SecurityEventLevel;
  source?: string;
  action?: string;
}

/** 汇总统计 */
export interface SecuritySummary {
  total: number;
  blocked: number;
  allowed: number;
  warned: number;
  bySource: Record<string, number>;
  byLevel: Record<string, number>;
}

// ============================================================
// SecurityAuditPanel 主类
// ============================================================

export class SecurityAuditPanel {
  private events: SecurityEvent[] = [];
  private readonly maxEvents: number;

  constructor(opts?: { maxEvents?: number }) {
    this.maxEvents = opts?.maxEvents ?? 1000;
  }

  /**
   * 记录一条安全事件
   *
   * 自动填充 timestamp；超过 maxEvents 时丢弃最旧事件（FIFO）
   */
  log(event: Omit<SecurityEvent, 'timestamp'>): void {
    const full: SecurityEvent = {
      timestamp: Date.now(),
      ...event,
    };

    this.events.push(full);

    // FIFO 淘汰：超过上限时删除最旧事件
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // 同步输出到 logger（便于在文件日志中检索）
    const logFn =
      full.level === 'critical' || full.level === 'error'
        ? logger.warn
        : full.level === 'warn'
          ? logger.info
          : logger.debug;
    logFn(`[audit-panel] ${full.source}/${full.action}: ${full.target}`, {
      level: full.level,
      reason: full.reason,
      metadata: full.metadata,
    });
  }

  /**
   * 查询事件，可选过滤
   *
   * 返回按时间正序排列的事件副本（不暴露内部引用）
   */
  getEvents(filter?: SecurityEventFilter): SecurityEvent[] {
    if (!filter) return [...this.events];
    return this.events.filter(
      (e) =>
        (!filter.level || e.level === filter.level) &&
        (!filter.source || e.source === filter.source) &&
        (!filter.action || e.action === filter.action),
    );
  }

  /**
   * 汇总统计
   */
  getSummary(): SecuritySummary {
    const summary: SecuritySummary = {
      total: this.events.length,
      blocked: 0,
      allowed: 0,
      warned: 0,
      bySource: {},
      byLevel: {},
    };

    for (const e of this.events) {
      if (e.action === 'blocked') summary.blocked++;
      else if (e.action === 'allowed') summary.allowed++;
      else if (e.action === 'warned') summary.warned++;

      summary.bySource[e.source] = (summary.bySource[e.source] ?? 0) + 1;
      summary.byLevel[e.level] = (summary.byLevel[e.level] ?? 0) + 1;
    }

    return summary;
  }

  /**
   * 清空所有事件
   */
  clear(): void {
    this.events = [];
  }

  /**
   * 导出为文本报告
   *
   * 格式：
   *   ====== 安全审计报告 ======
   *   生成时间: 2026-07-04T12:34:56.789Z
   *   总事件: N | 拦截: N | 放行: N | 警告: N
   *   按来源: path-guard=N, sandbox=N, ...
   *   按级别: info=N, warn=N, error=N, critical=N
   *   ------ 最近事件 ------
   *   [timestamp] LEVEL source/action target — reason
   *   ...
   */
  exportReport(): string {
    const summary = this.getSummary();
    const lines: string[] = [];

    lines.push('====== 安全审计报告 ======');
    lines.push(`生成时间: ${new Date().toISOString()}`);
    lines.push(
      `总事件: ${summary.total} | 拦截: ${summary.blocked} | 放行: ${summary.allowed} | 警告: ${summary.warned}`,
    );

    const sourceEntries = Object.entries(summary.bySource).sort((a, b) => b[1] - a[1]);
    lines.push(
      `按来源: ${sourceEntries.map(([k, v]) => `${k}=${v}`).join(', ') || '(无)'}`,
    );

    const levelEntries = Object.entries(summary.byLevel);
    lines.push(
      `按级别: ${levelEntries.map(([k, v]) => `${k}=${v}`).join(', ') || '(无)'}`,
    );

    lines.push('------ 最近事件（最多 50 条） ------');
    const recent = this.events.slice(-50);
    for (const e of recent) {
      const ts = new Date(e.timestamp).toISOString();
      const reason = e.reason ? ` — ${e.reason}` : '';
      lines.push(`[${ts}] ${e.level.toUpperCase()} ${e.source}/${e.action}: ${e.target}${reason}`);
    }

    return lines.join('\n');
  }
}

// ============================================================
// 单例导出（供 path-guard / config-guard / mcp-scanner 等直接 import）
// ============================================================

/**
 * 全局共享的安全审计面板单例
 *
 * 多个安全机制通过 `import { auditPanel } from '../security/audit-panel.js'`
 * 接入同一实例，避免事件分散在多个实例中
 */
export const auditPanel = new SecurityAuditPanel();
