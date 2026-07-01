// src/agent/circuit-breaker.ts
// Phase 53 Task 11：熔断器模式（Circuit Breaker）
//
// 借鉴 agency-agents-zh + AGT CascadeContainment：三态熔断器
//   1. closed（关闭）：正常放行所有调用；连续失败达阈值则熔断 → open
//   2. open（打开）：拒绝所有调用；resetTimeout 过期后 → half_open
//   3. half_open（半开）：放行有限试探次数
//      - 试探成功 → 恢复 closed
//      - 试探失败 → 回到 open
//
// 设计约束：
//   - 不依赖任何共享配置（schema.ts / defaults.ts），通过 constructor config 注入
//   - 不修改任何共享文件，独立可运行

// ============================================================
// 类型定义
// ============================================================

/** 熔断器状态 */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** 熔断器配置 */
export interface CircuitBreakerConfig {
  /** 连续失败 N 次后熔断（默认 5） */
  failureThreshold: number;
  /** 熔断后多久尝试恢复（毫秒，默认 60000） */
  resetTimeout: number;
  /** HALF-OPEN 状态最多试探次数（默认 1） */
  halfOpenMaxAttempts: number;
}

/** 熔断器统计信息 */
export interface CircuitStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastStateChange: number;
  totalCalls: number;
  totalRejected: number;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 60_000,
  halfOpenMaxAttempts: 1,
};

// ============================================================
// CircuitBreaker
// ============================================================

/**
 * 三态熔断器
 *
 * 使用方式：
 *   ```ts
 *   const cb = new CircuitBreaker();
 *   if (cb.canCall()) {
 *     try {
 *       const result = await doWork();
 *       cb.recordResult(true);
 *       return result;
 *     } catch (e) {
 *       cb.recordResult(false);
 *       throw e;
 *     }
 *   } else {
 *     throw new Error('circuit open');
 *   }
 *   ```
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount: number = 0;
  private successCount: number = 0;
  /** 上次失败时间戳（毫秒，0 表示从未失败） */
  private lastFailureTime: number = 0;
  /** 上次状态变更时间戳（毫秒） */
  private lastStateChange: number;
  /** HALF-OPEN 状态下已试探次数 */
  private halfOpenAttempts: number = 0;
  /** 累计调用次数（含被拒绝的） */
  private totalCalls: number = 0;
  /** 累计被拒绝次数 */
  private totalRejected: number = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // 防御：参数合法性检查
    if (this.config.failureThreshold <= 0) {
      throw new Error(`CircuitBreaker: failureThreshold 必须为正数，收到 ${this.config.failureThreshold}`);
    }
    if (this.config.resetTimeout < 0) {
      throw new Error(`CircuitBreaker: resetTimeout 不能为负数，收到 ${this.config.resetTimeout}`);
    }
    if (this.config.halfOpenMaxAttempts <= 0) {
      throw new Error(`CircuitBreaker: halfOpenMaxAttempts 必须为正数，收到 ${this.config.halfOpenMaxAttempts}`);
    }
    this.lastStateChange = Date.now();
  }

  /**
   * 检查是否允许调用
   *
   * 状态机：
   *   - closed：允许（totalCalls++）
   *   - open：
   *     - 若 resetTimeout 已过期 → 转 half_open，重置 halfOpenAttempts=0，允许本次调用
   *     - 否则拒绝（totalRejected++）
   *   - half_open：
   *     - 若 halfOpenAttempts >= halfOpenMaxAttempts → 拒绝（totalRejected++）
   *     - 否则允许（试探次数将由 recordResult 增加）
   *
   * @returns 是否允许调用
   */
  canCall(): boolean {
    this.totalCalls++;

    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      const now = Date.now();
      const elapsed = now - this.lastStateChange;
      if (elapsed >= this.config.resetTimeout) {
        // 过期 → 转 half_open 并重置试探次数
        this.transitionTo('half_open');
        this.halfOpenAttempts = 0;
        return true;
      }
      // 未过期 → 拒绝
      this.totalRejected++;
      return false;
    }

    // half_open 状态
    if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
      // 试探次数已用完，拒绝额外调用
      this.totalRejected++;
      return false;
    }
    return true;
  }

  /**
   * 记录调用结果
   *
   * 状态机：
   *   - success（任何状态）：
   *     - closed：failureCount=0，successCount++
   *     - half_open：试探成功 → 转 closed，重置 failureCount=0
   *     - open：异常情况，理论上不应出现（canCall 已拒绝）；防御性处理为忽略
   *   - failure（任何状态）：
   *     - closed：failureCount++，更新 lastFailureTime
   *       - 若 failureCount >= failureThreshold → 转 open
   *     - half_open：试探失败 → 转 open（重置 lastStateChange）
   *     - open：异常情况，理论上不应出现；防御性处理为忽略
   *
   * 注意：half_open 状态下，无论成功失败都增加 halfOpenAttempts
   *
   * @param success 调用是否成功
   */
  recordResult(success: boolean): void {
    if (this.state === 'closed') {
      if (success) {
        // 成功：重置失败计数
        this.failureCount = 0;
        this.successCount++;
      } else {
        // 失败：累计并检查阈值
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.failureCount >= this.config.failureThreshold) {
          this.transitionTo('open');
        }
      }
      return;
    }

    if (this.state === 'half_open') {
      // 无论成功失败都增加试探次数
      this.halfOpenAttempts++;
      if (success) {
        // 试探成功 → 恢复 closed
        this.failureCount = 0;
        this.successCount++;
        this.transitionTo('closed');
      } else {
        // 试探失败 → 回到 open
        this.lastFailureTime = Date.now();
        this.transitionTo('open');
      }
      return;
    }

    // open 状态：canCall 已拒绝，理论上不会调到 recordResult
    // 防御性：忽略，避免异常情况下误导状态机
  }

  /**
   * 强制重置为 closed（管理员手动恢复）
   *
   * 清空所有失败计数和试探次数，状态置为 closed。
   */
  reset(): void {
    this.transitionTo('closed');
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
  }

  /**
   * 获取统计信息
   *
   * @returns 当前熔断器状态与累计指标
   */
  getStats(): CircuitStats {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime === 0 ? null : this.lastFailureTime,
      lastStateChange: this.lastStateChange,
      totalCalls: this.totalCalls,
      totalRejected: this.totalRejected,
    };
  }

  /**
   * 状态转换：统一更新 lastStateChange 字段
   *
   * @param newState 新状态
   */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.lastStateChange = Date.now();
  }
}
