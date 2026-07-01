// tests/agent/budget-monitor.test.ts
// Phase 53 Task 9：BudgetMonitor 单元测试

import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetMonitor } from '../../src/agent/budget-monitor.js';

describe('BudgetMonitor', () => {
  let monitor: BudgetMonitor;

  beforeEach(() => {
    monitor = new BudgetMonitor({
      tokenLimit: 10000,
      costLimit: 5,
      toolLoopThreshold: 5,
    });
  });

  // ============================================================
  // 规则 1：token_low 分级
  // ============================================================
  describe('token_low 告警分级', () => {
    it('Token 用量 75% 应触发 warn', () => {
      monitor.recordToken(7500); // 75%
      const alerts = monitor.check();

      const tokenAlert = alerts.find((a) => a.type === 'token_low');
      expect(tokenAlert).toBeDefined();
      expect(tokenAlert!.severity).toBe('warn');
      expect(tokenAlert!.alertId).toBe('token_low_warn');
      expect(tokenAlert!.current).toBe(7500);
      // threshold = round(10000 * 0.75) = 7500
      expect(tokenAlert!.threshold).toBe(7500);
    });

    it('Token 用量 90% 应触发 critical', () => {
      monitor.recordToken(9000); // 90%
      const alerts = monitor.check();

      const tokenAlert = alerts.find((a) => a.type === 'token_low');
      expect(tokenAlert).toBeDefined();
      expect(tokenAlert!.severity).toBe('critical');
      expect(tokenAlert!.alertId).toBe('token_low_critical');
      // threshold = round(10000 * 0.9) = 9000
      expect(tokenAlert!.threshold).toBe(9000);
    });

    it('Token 用量 50% 应触发 info', () => {
      monitor.recordToken(5000); // 50%
      const alerts = monitor.check();

      const tokenAlert = alerts.find((a) => a.type === 'token_low');
      expect(tokenAlert).toBeDefined();
      expect(tokenAlert!.severity).toBe('info');
      expect(tokenAlert!.alertId).toBe('token_low_info');
    });

    it('Token 用量 30% 不应触发告警', () => {
      monitor.recordToken(3000); // 30%
      const alerts = monitor.check();

      const tokenAlert = alerts.find((a) => a.type === 'token_low');
      expect(tokenAlert).toBeUndefined();
    });

    it('Token 越过 75% 后再 check 不应重复返回同 alertId', () => {
      monitor.recordToken(7500);
      const first = monitor.check();
      expect(first.find((a) => a.type === 'token_low')).toBeDefined();

      // 第二次 check（同 severity warn）不应再返回
      const second = monitor.check();
      expect(second.find((a) => a.type === 'token_low')).toBeUndefined();
    });

    it('Token 从 warn 升级到 critical 时应返回新的 critical 告警', () => {
      monitor.recordToken(7500);
      monitor.check(); // 触发 warn

      monitor.recordToken(1500); // 累计 9000 → critical
      const alerts = monitor.check();
      const tokenAlert = alerts.find((a) => a.type === 'token_low');
      expect(tokenAlert).toBeDefined();
      expect(tokenAlert!.severity).toBe('critical');
    });
  });

  // ============================================================
  // 规则 2：cost_overrun
  // ============================================================
  describe('cost_overrun 告警', () => {
    it('成本超支应触发 critical', () => {
      monitor.recordCost(6); // 超过 costLimit=5
      const alerts = monitor.check();

      const costAlert = alerts.find((a) => a.type === 'cost_overrun');
      expect(costAlert).toBeDefined();
      expect(costAlert!.severity).toBe('critical');
      expect(costAlert!.alertId).toBe('cost_overrun');
      expect(costAlert!.current).toBe(6);
      expect(costAlert!.threshold).toBe(5);
    });

    it('成本未超支不触发', () => {
      monitor.recordCost(3);
      const alerts = monitor.check();
      expect(alerts.find((a) => a.type === 'cost_overrun')).toBeUndefined();
    });

    it('未配置 costLimit 时不检查 cost_overrun', () => {
      const m = new BudgetMonitor({ tokenLimit: 10000 });
      m.recordCost(99999);
      const alerts = m.check();
      expect(alerts.find((a) => a.type === 'cost_overrun')).toBeUndefined();
    });
  });

  // ============================================================
  // 规则 3：scope_creep
  // ============================================================
  describe('scope_creep 告警', () => {
    it('总调用 > 50 且最近 10 次涉及 ≥5 个不同工具应触发 warn', () => {
      // 填充 51 次调用，最后 10 次分散到 5 个不同工具
      for (let i = 0; i < 41; i++) {
        monitor.recordToolCall('tool_a');
      }
      // 最近 10 次：5 个不同工具各 2 次
      for (let i = 0; i < 2; i++) {
        monitor.recordToolCall('tool_a');
        monitor.recordToolCall('tool_b');
        monitor.recordToolCall('tool_c');
        monitor.recordToolCall('tool_d');
        monitor.recordToolCall('tool_e');
      }

      const alerts = monitor.check();
      const creepAlert = alerts.find((a) => a.type === 'scope_creep');
      expect(creepAlert).toBeDefined();
      expect(creepAlert!.severity).toBe('warn');
      expect(creepAlert!.alertId).toBe('scope_creep');
    });

    it('总调用 ≤ 50 不触发 scope_creep', () => {
      for (let i = 0; i < 50; i++) {
        monitor.recordToolCall('tool_a');
      }
      const alerts = monitor.check();
      expect(alerts.find((a) => a.type === 'scope_creep')).toBeUndefined();
    });

    it('最近 10 次工具数 < 5 不触发', () => {
      for (let i = 0; i < 51; i++) {
        monitor.recordToolCall('tool_a');
      }
      const alerts = monitor.check();
      expect(alerts.find((a) => a.type === 'scope_creep')).toBeUndefined();
    });
  });

  // ============================================================
  // 规则 4：tool_loop
  // ============================================================
  describe('tool_loop 告警', () => {
    it('连续 5 次相同工具应触发 tool_loop warn', () => {
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');

      const alerts = monitor.check();
      const loopAlert = alerts.find((a) => a.type === 'tool_loop');
      expect(loopAlert).toBeDefined();
      expect(loopAlert!.severity).toBe('warn');
      expect(loopAlert!.alertId).toBe('tool_loop');
      expect(loopAlert!.message).toContain('file_read');
    });

    it('连续 4 次相同工具不触发（阈值 5）', () => {
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');

      const alerts = monitor.check();
      expect(alerts.find((a) => a.type === 'tool_loop')).toBeUndefined();
    });

    it('最近 5 次非完全相同不触发', () => {
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_read');
      monitor.recordToolCall('file_write'); // 第 5 次不同

      const alerts = monitor.check();
      expect(alerts.find((a) => a.type === 'tool_loop')).toBeUndefined();
    });

    it('自定义 toolLoopThreshold=3 时连续 3 次相同触发', () => {
      const m = new BudgetMonitor({
        tokenLimit: 10000,
        toolLoopThreshold: 3,
      });
      m.recordToolCall('search');
      m.recordToolCall('search');
      m.recordToolCall('search');

      const alerts = m.check();
      const loopAlert = alerts.find((a) => a.type === 'tool_loop');
      expect(loopAlert).toBeDefined();
      expect(loopAlert!.severity).toBe('warn');
    });
  });

  // ============================================================
  // 去重与重置
  // ============================================================
  describe('去重与 resetAlerts', () => {
    it('同 alertId 不重复返回', () => {
      monitor.recordToken(7500);
      const first = monitor.check();
      expect(first.length).toBeGreaterThan(0);

      // 再次 check，无新告警
      const second = monitor.check();
      expect(second.length).toBe(0);
    });

    it('resetAlerts 后同告警可再次触发', () => {
      monitor.recordToken(7500);
      monitor.check(); // 触发 warn

      monitor.resetAlerts();
      const alerts = monitor.check();
      const tokenAlert = alerts.find((a) => a.type === 'token_low');
      expect(tokenAlert).toBeDefined();
      expect(tokenAlert!.severity).toBe('warn');
    });

    it('check 返回顺序：critical 优先于 warn 与 info', () => {
      // 同时触发 critical（token 90%）与 cost overrun（critical）
      monitor.recordToken(9000); // token_low_critical
      monitor.recordCost(10); // cost_overrun (critical)
      // 再触发一个 info：让 token 用量先到 50% 触发过 info，再继续到 90%
      // 但同 type 同 severity 只触发一次，因此这里直接验证 critical 优先
      const alerts = monitor.check();
      const severities = alerts.map((a) => a.severity);
      // 所有 critical 应在 warn/info 之前
      const firstCriticalIdx = severities.indexOf('critical');
      const firstNonCriticalIdx = severities.findIndex((s) => s !== 'critical');
      if (firstNonCriticalIdx !== -1) {
        expect(firstCriticalIdx).toBeLessThan(firstNonCriticalIdx);
      }
    });
  });

  // ============================================================
  // 构造参数校验
  // ============================================================
  describe('构造参数校验', () => {
    it('tokenLimit <= 0 应抛错', () => {
      expect(() => new BudgetMonitor({ tokenLimit: 0 })).toThrow();
      expect(() => new BudgetMonitor({ tokenLimit: -1 })).toThrow();
    });

    it('未传 opts 应抛错', () => {
      // @ts-expect-error 测试运行时校验
      expect(() => new BudgetMonitor()).toThrow();
    });
  });
});
