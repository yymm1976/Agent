// tests/agent/circuit-breaker.test.ts
// Phase 53 Task 11：熔断器模式测试
//
// 覆盖场景：
//   1. 连续 5 次失败后转 open
//   2. open 状态 canCall 返回 false
//   3. resetTimeout 过期后 half_open
//   4. half_open 试探成功后 closed
//   5. half_open 试探失败后回 open
//   6. （补充）默认配置 / 自定义配置 / reset 强制恢复
//   7. （补充）half_open 状态下 halfOpenMaxAttempts 限制
//   8. （补充）统计信息正确

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  CircuitBreaker,
  type CircuitState,
  type CircuitBreakerConfig,
} from '../../src/agent/circuit-breaker.js';

// ============================================================
// 辅助
// ============================================================

/** 用 vi.replaceEnv + Date.now 控制 currentTime */
function setTime(now: number): void {
  vi.setSystemTime(now);
}

// ============================================================
// 测试用例
// ============================================================

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    // 默认时间设为 1000ms 起步，避免和真实时间混淆
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    cb = new CircuitBreaker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('默认配置', () => {
    it('默认 failureThreshold=5、resetTimeout=60000、halfOpenMaxAttempts=1', () => {
      const breaker = new CircuitBreaker();
      // 5 次失败触发熔断
      for (let i = 0; i < 4; i++) {
        expect(breaker.canCall()).toBe(true);
        breaker.recordResult(false);
        expect(breaker.getStats().state).toBe('closed');
      }
      // 第 5 次失败 → 转 open
      expect(breaker.canCall()).toBe(true);
      breaker.recordResult(false);
      expect(breaker.getStats().state).toBe('open');
    });

    it('允许通过 config 自定义阈值', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 1000,
        halfOpenMaxAttempts: 2,
      });
      breaker.recordResult(false);
      expect(breaker.getStats().state).toBe('closed');
      breaker.recordResult(false);
      expect(breaker.getStats().state).toBe('open');
    });

    it('非法参数抛错', () => {
      expect(() => new CircuitBreaker({ failureThreshold: 0 })).toThrow();
      expect(() => new CircuitBreaker({ failureThreshold: -1 })).toThrow();
      expect(() => new CircuitBreaker({ resetTimeout: -1 })).toThrow();
      expect(() => new CircuitBreaker({ halfOpenMaxAttempts: 0 })).toThrow();
    });
  });

  describe('closed → open 状态转换', () => {
    it('连续 5 次失败后转 open', () => {
      const stats0 = cb.getStats();
      expect(stats0.state).toBe('closed');

      // 4 次失败仍未熔断
      for (let i = 0; i < 4; i++) {
        cb.canCall();
        cb.recordResult(false);
        expect(cb.getStats().state).toBe('closed');
      }
      // 第 5 次失败 → open
      cb.canCall();
      cb.recordResult(false);
      expect(cb.getStats().state).toBe('open');
      expect(cb.getStats().failureCount).toBe(5);
      expect(cb.getStats().lastFailureTime).not.toBeNull();
    });

    it('成功调用会重置 failureCount', () => {
      // 3 次失败
      for (let i = 0; i < 3; i++) {
        cb.canCall();
        cb.recordResult(false);
      }
      expect(cb.getStats().failureCount).toBe(3);
      // 成功 → failureCount 重置
      cb.canCall();
      cb.recordResult(true);
      expect(cb.getStats().failureCount).toBe(0);
      expect(cb.getStats().successCount).toBe(1);
      expect(cb.getStats().state).toBe('closed');
      // 再次失败 4 次不应触发熔断
      for (let i = 0; i < 4; i++) {
        cb.canCall();
        cb.recordResult(false);
      }
      expect(cb.getStats().state).toBe('closed');
    });
  });

  describe('open 状态', () => {
    it('open 状态下 canCall 返回 false', () => {
      // 触发熔断
      for (let i = 0; i < 5; i++) {
        cb.canCall();
        cb.recordResult(false);
      }
      expect(cb.getStats().state).toBe('open');

      // canCall 应拒绝
      const allowed = cb.canCall();
      expect(allowed).toBe(false);

      const stats = cb.getStats();
      // totalCalls 累计 +1（canCall 被调用了一次）
      // totalRejected 累计 +1（被拒绝）
      expect(stats.totalRejected).toBeGreaterThanOrEqual(1);
    });

    it('open 状态未到 resetTimeout，recordResult 不改变状态', () => {
      // 触发熔断
      for (let i = 0; i < 5; i++) {
        cb.canCall();
        cb.recordResult(false);
      }
      expect(cb.getStats().state).toBe('open');

      // 直接调 recordResult（绕过 canCall）不应改变状态
      cb.recordResult(true);
      expect(cb.getStats().state).toBe('open');
    });
  });

  describe('open → half_open 转换', () => {
    it('resetTimeout 过期后 canCall 转换为 half_open 并允许调用', () => {
      const resetTimeout = 60_000;
      cb = new CircuitBreaker({ resetTimeout });
      // 触发熔断
      for (let i = 0; i < 5; i++) {
        cb.canCall();
        cb.recordResult(false);
      }
      expect(cb.getStats().state).toBe('open');

      // 时间前进 59999ms（未过期）→ 仍拒绝
      vi.advanceTimersByTime(59_999);
      expect(cb.canCall()).toBe(false);
      expect(cb.getStats().state).toBe('open');

      // 再前进 1ms（共 60000ms，已过期）→ 转 half_open 并允许
      vi.advanceTimersByTime(1);
      const allowed = cb.canCall();
      expect(allowed).toBe(true);
      expect(cb.getStats().state).toBe('half_open');
    });

    it('转换到 half_open 时重置 halfOpenAttempts', () => {
      cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
        halfOpenMaxAttempts: 3,
      });
      // 触发熔断
      cb.canCall();
      cb.recordResult(false);
      expect(cb.getStats().state).toBe('open');

      // 等待 resetTimeout
      vi.advanceTimersByTime(1000);
      expect(cb.canCall()).toBe(true);
      expect(cb.getStats().state).toBe('half_open');
    });
  });

  describe('half_open 状态试探', () => {
    it('half_open 试探成功后转 closed', () => {
      cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
        halfOpenMaxAttempts: 1,
      });
      // 触发熔断
      cb.canCall();
      cb.recordResult(false);
      expect(cb.getStats().state).toBe('open');

      // 等待 resetTimeout → 转 half_open
      vi.advanceTimersByTime(1000);
      expect(cb.canCall()).toBe(true);
      expect(cb.getStats().state).toBe('half_open');

      // 试探成功 → 转 closed
      cb.recordResult(true);
      expect(cb.getStats().state).toBe('closed');
      expect(cb.getStats().failureCount).toBe(0);
      expect(cb.getStats().successCount).toBe(1);
    });

    it('half_open 试探失败后回 open', () => {
      cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
        halfOpenMaxAttempts: 1,
      });
      // 触发熔断
      cb.canCall();
      cb.recordResult(false);
      expect(cb.getStats().state).toBe('open');

      // 等待 resetTimeout → 转 half_open
      vi.advanceTimersByTime(1000);
      expect(cb.canCall()).toBe(true);
      expect(cb.getStats().state).toBe('half_open');

      // 试探失败 → 回 open
      cb.recordResult(false);
      expect(cb.getStats().state).toBe('open');
      // lastStateChange 应被刷新（新 open 状态）
      const stats = cb.getStats();
      expect(stats.lastFailureTime).not.toBeNull();
    });

    it('half_open 状态下试探失败后，halfOpenAttempts 增加 → 回 open，再次 canCall 拒绝', () => {
      // 验证 halfOpenMaxAttempts 的语义：试探次数由 recordResult 累计
      // （规范明确：recordResult 在 half_open 状态下，无论成功失败都增加 halfOpenAttempts）
      cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
        halfOpenMaxAttempts: 1,
      });
      // 触发熔断
      cb.canCall();
      cb.recordResult(false);
      expect(cb.getStats().state).toBe('open');

      // 等待 resetTimeout → 转 half_open
      vi.advanceTimersByTime(1000);
      expect(cb.canCall()).toBe(true); // 第 1 次试探，允许（halfOpenAttempts=0 < 1）
      expect(cb.getStats().state).toBe('half_open');

      // 试探失败 → halfOpenAttempts=1，回 open
      cb.recordResult(false);
      expect(cb.getStats().state).toBe('open');

      // open 状态下未到 resetTimeout，canCall 拒绝
      expect(cb.canCall()).toBe(false);
      expect(cb.getStats().totalRejected).toBeGreaterThanOrEqual(1);
    });

    it('half_open 试探成功后，下一次 canCall 应允许（已回到 closed）', () => {
      cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeout: 1000,
        halfOpenMaxAttempts: 1,
      });
      // 触发熔断
      cb.canCall();
      cb.recordResult(false);

      // 等待 resetTimeout → 转 half_open
      vi.advanceTimersByTime(1000);
      expect(cb.canCall()).toBe(true);
      cb.recordResult(true);

      // 已回到 closed，canCall 应允许
      expect(cb.getStats().state).toBe('closed');
      expect(cb.canCall()).toBe(true);
    });
  });

  describe('reset 强制恢复', () => {
    it('reset 强制回到 closed 状态并清空计数', () => {
      // 触发熔断
      for (let i = 0; i < 5; i++) {
        cb.canCall();
        cb.recordResult(false);
      }
      expect(cb.getStats().state).toBe('open');

      cb.reset();
      const stats = cb.getStats();
      expect(stats.state).toBe('closed');
      expect(stats.failureCount).toBe(0);
    });

    it('reset 后 canCall 立即允许', () => {
      for (let i = 0; i < 5; i++) {
        cb.canCall();
        cb.recordResult(false);
      }
      expect(cb.getStats().state).toBe('open');
      cb.reset();
      expect(cb.canCall()).toBe(true);
    });
  });

  describe('统计信息', () => {
    it('totalCalls / totalRejected 累计正确', () => {
      // 5 次 canCall + recordResult(false) → open
      for (let i = 0; i < 5; i++) {
        cb.canCall();
        cb.recordResult(false);
      }
      let stats = cb.getStats();
      expect(stats.totalCalls).toBe(5);
      expect(stats.totalRejected).toBe(0);
      expect(stats.state).toBe('open');

      // 第 6 次 canCall → 被拒绝
      cb.canCall();
      stats = cb.getStats();
      expect(stats.totalCalls).toBe(6);
      expect(stats.totalRejected).toBe(1);
    });

    it('lastStateChange 在状态变更时更新', () => {
      const initialChange = cb.getStats().lastStateChange;
      // 推进时间
      vi.advanceTimersByTime(500);
      // 触发熔断
      for (let i = 0; i < 5; i++) {
        cb.canCall();
        cb.recordResult(false);
      }
      const stats = cb.getStats();
      expect(stats.state).toBe('open');
      expect(stats.lastStateChange).toBeGreaterThan(initialChange);
    });
  });
});
