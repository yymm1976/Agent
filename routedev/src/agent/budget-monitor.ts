// src/agent/budget-monitor.ts
// Phase 53 Task 9：上下文预算监控与告警
//
// 设计哲学："花多少算够"——给 Agent 一个会算账的财务官
// 监控 4 类预算异常并去重输出告警：
//   1. token_low：Token 用量接近上限（按 50% / 75% / 90% 分级）
//   2. cost_overrun：成本累计超出预算
//   3. scope_creep：调用工具数过多（疑似任务发散）
//   4. tool_loop：连续 N 次调用同一工具（疑似陷入循环）
//
// 设计要点：
//   1. 无 config 开关也能独立运行：所有阈值通过 constructor opts 注入
//   2. 同 severity 同 type 不重复告警（去重靠 alertId）
//   3. 纯内存状态，不持久化（新会话 resetAlerts 重置）
//   4. 不依赖外部 logger，由调用方决定如何呈现告警

/**
 * 预算告警类型
 */
export interface BudgetAlert {
  /** 告警类型 */
  type: 'token_low' | 'cost_overrun' | 'scope_creep' | 'tool_loop';
  /** 严重级别 */
  severity: 'info' | 'warn' | 'critical';
  /** 人类可读告警消息 */
  message: string;
  /** 当前实际值（token 用量 / 成本 / 调用次数） */
  current: number;
  /** 阈值（触发告警的边界值） */
  threshold: number;
  /** 告警 ID（用于去重，同一 alertId 不重复返回） */
  alertId: string;
}

/**
 * 预算监控器构造参数
 */
export interface BudgetMonitorOptions {
  /** Token 上限（必填） */
  tokenLimit: number;
  /** 成本上限（可选，未提供则不检查 cost_overrun） */
  costLimit?: number;
  /** Token 预警比例（默认 0.75，达到此比例触发 warn） */
  tokenWarnRatio?: number;
  /** 工具循环阈值（默认 5，最近 N 次相同工具触发 tool_loop） */
  toolLoopThreshold?: number;
}

/**
 * 上下文预算监控器
 *
 * 通过 recordToken / recordCost / recordToolCall 累积状态
 * check() 返回当前未触发的告警列表（同 alertId 不重复）
 */
export class BudgetMonitor {
  /** 已用 token 数 */
  private tokenUsage: number = 0;
  /** Token 上限 */
  private readonly tokenLimit: number;
  /** 累计成本 */
  private costAccumulated: number = 0;
  /** 成本上限 */
  private readonly costLimit: number | undefined;
  /** 工具调用历史（保留顺序，用于循环检测与 scope_creep） */
  private toolCallHistory: string[] = [];
  /** 工具循环阈值 */
  private readonly toolLoopThreshold: number;
  /** Token 预警比例（达到此比例触发 warn，超过则升级为 critical） */
  private readonly tokenWarnRatio: number;
  /** 已触发告警集合（用于去重） */
  private firedAlerts: Set<string> = new Set();

  constructor(opts: BudgetMonitorOptions) {
    if (!opts || typeof opts.tokenLimit !== 'number' || opts.tokenLimit <= 0) {
      throw new Error('BudgetMonitor 需要 tokenLimit > 0');
    }
    this.tokenLimit = opts.tokenLimit;
    this.costLimit = opts.costLimit;
    this.tokenWarnRatio = opts.tokenWarnRatio ?? 0.75;
    this.toolLoopThreshold = opts.toolLoopThreshold ?? 5;
  }

  /**
   * 记录 token 消耗
   * 允许负数（修正场景），但累计不会低于 0
   */
  recordToken(used: number): void {
    this.tokenUsage += used;
    if (this.tokenUsage < 0) {
      this.tokenUsage = 0;
    }
  }

  /**
   * 记录成本累积
   * 允许负数（退款场景），但累计不会低于 0
   */
  recordCost(amount: number): void {
    this.costAccumulated += amount;
    if (this.costAccumulated < 0) {
      this.costAccumulated = 0;
    }
  }

  /**
   * 记录一次工具调用
   * @param toolName 工具名称（用于循环检测与发散检测）
   */
  recordToolCall(toolName: string): void {
    this.toolCallHistory.push(toolName);
  }

  /**
   * 检查并返回当前告警
   *
   * 已触发过的同 alertId 不会重复返回
   * 返回顺序：critical 优先，其次 warn，最后 info
   */
  check(): BudgetAlert[] {
    const alerts: BudgetAlert[] = [];

    // ============================================================
    // 规则 1：token_low
    //   - ratio >= 0.9 → critical
    //   - 0.75 <= ratio < 0.9 → warn
    //   - 0.5 <= ratio < 0.75 → info
    //   - alertId = `token_low_${severity}`（同 severity 不重复）
    // ============================================================
    if (this.tokenLimit > 0) {
      const ratio = this.tokenUsage / this.tokenLimit;
      let severity: 'info' | 'warn' | 'critical' | null = null;
      let threshold = 0;
      if (ratio >= 0.9) {
        severity = 'critical';
        threshold = Math.round(this.tokenLimit * 0.9);
      } else if (ratio >= this.tokenWarnRatio) {
        severity = 'warn';
        threshold = Math.round(this.tokenLimit * this.tokenWarnRatio);
      } else if (ratio >= 0.5) {
        severity = 'info';
        threshold = Math.round(this.tokenLimit * 0.5);
      }
      if (severity) {
        const alertId = `token_low_${severity}`;
        const percent = Math.round(ratio * 100);
        alerts.push({
          type: 'token_low',
          severity,
          message: `Token 用量已达 ${percent}%（${this.tokenUsage}/${this.tokenLimit}）`,
          current: this.tokenUsage,
          threshold,
          alertId,
        });
      }
    }

    // ============================================================
    // 规则 2：cost_overrun
    //   - costAccumulated >= costLimit → critical
    //   - alertId = 'cost_overrun'
    // ============================================================
    if (this.costLimit !== undefined && this.costLimit > 0) {
      if (this.costAccumulated >= this.costLimit) {
        alerts.push({
          type: 'cost_overrun',
          severity: 'critical',
          message: `成本超支（${this.costAccumulated}/${this.costLimit}）`,
          current: this.costAccumulated,
          threshold: this.costLimit,
          alertId: 'cost_overrun',
        });
      }
    }

    // ============================================================
    // 规则 3：scope_creep
    //   - toolCallHistory.length > 50 且最近 10 次中有 ≥5 个不同工具
    //   - severity = warn，alertId = 'scope_creep'
    // ============================================================
    if (this.toolCallHistory.length > 50) {
      const recent = this.toolCallHistory.slice(-10);
      const unique = new Set(recent);
      if (unique.size >= 5) {
        alerts.push({
          type: 'scope_creep',
          severity: 'warn',
          message: `检测到任务发散：最近 10 次工具调用涉及 ${unique.size} 个不同工具`,
          current: unique.size,
          threshold: 5,
          alertId: 'scope_creep',
        });
      }
    }

    // ============================================================
    // 规则 4：tool_loop
    //   - 最近 N 次（toolLoopThreshold）工具调用完全相同 → warn
    //   - alertId = 'tool_loop'
    // ============================================================
    if (this.toolCallHistory.length >= this.toolLoopThreshold) {
      const recent = this.toolCallHistory.slice(-this.toolLoopThreshold);
      const first = recent[0];
      if (recent.every((name) => name === first)) {
        alerts.push({
          type: 'tool_loop',
          severity: 'warn',
          message: `检测到工具循环：连续 ${this.toolLoopThreshold} 次调用相同工具 "${first}"`,
          current: this.toolLoopThreshold,
          threshold: this.toolLoopThreshold,
          alertId: 'tool_loop',
        });
      }
    }

    // 去重：仅返回未触发过的 alertId
    const fresh = alerts.filter((a) => !this.firedAlerts.has(a.alertId));
    // 标记已触发
    for (const a of fresh) {
      this.firedAlerts.add(a.alertId);
    }

    // 按 severity 排序：critical → warn → info
    const order: Record<BudgetAlert['severity'], number> = {
      critical: 0,
      warn: 1,
      info: 2,
    };
    fresh.sort((a, b) => order[a.severity] - order[b.severity]);
    return fresh;
  }

  /**
   * 重置已触发告警集合（用于新会话）
   *
   * 注意：仅清空告警去重集合，不清空累计 token / cost / 工具调用历史
   * 若需完全重置，调用方应自行 new 一个新的 BudgetMonitor 实例
   */
  resetAlerts(): void {
    this.firedAlerts.clear();
  }
}
