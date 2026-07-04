// tests/security/audit-panel.test.ts
// SecurityAuditPanel 单元测试
//
// 测试策略：
//   - log 应自动填充 timestamp
//   - getEvents 支持按 level / source / action 过滤
//   - getSummary 统计正确（blocked/allowed/warned、bySource、byLevel）
//   - clear 清空事件
//   - maxEvents 上限触发 FIFO 淘汰
//   - exportReport 输出文本格式正确

import { describe, it, expect, beforeEach } from 'vitest';
import { SecurityAuditPanel } from '../../src/security/audit-panel.js';

describe('SecurityAuditPanel', () => {
  let panel: SecurityAuditPanel;

  beforeEach(() => {
    panel = new SecurityAuditPanel({ maxEvents: 1000 });
  });

  // ============================================================
  // log + getEvents
  // ============================================================
  describe('log + getEvents', () => {
    it('log 应自动填充 timestamp 并存储事件', () => {
      const before = Date.now();
      panel.log({
        level: 'warn',
        source: 'sandbox',
        action: 'blocked',
        target: 'rm -rf /',
        reason: '危险命令',
      });
      const after = Date.now();

      const events = panel.getEvents();
      expect(events.length).toBe(1);
      expect(events[0]!.timestamp).toBeGreaterThanOrEqual(before);
      expect(events[0]!.timestamp).toBeLessThanOrEqual(after);
      expect(events[0]!.level).toBe('warn');
      expect(events[0]!.source).toBe('sandbox');
      expect(events[0]!.action).toBe('blocked');
      expect(events[0]!.target).toBe('rm -rf /');
      expect(events[0]!.reason).toBe('危险命令');
    });

    it('getEvents 不传 filter 时返回全部事件副本', () => {
      panel.log({ level: 'info', source: 'a', action: 'allowed', target: 't1' });
      panel.log({ level: 'warn', source: 'b', action: 'blocked', target: 't2' });

      const all = panel.getEvents();
      expect(all.length).toBe(2);

      // 修改返回的数组不应影响内部状态
      all.push({
        timestamp: 0,
        level: 'error',
        source: 'x',
        action: 'y',
        target: 'z',
      });
      expect(panel.getEvents().length).toBe(2);
    });

    it('getEvents 按 level 过滤', () => {
      panel.log({ level: 'info', source: 'a', action: 'allowed', target: 't1' });
      panel.log({ level: 'critical', source: 'b', action: 'blocked', target: 't2' });
      panel.log({ level: 'warn', source: 'c', action: 'warned', target: 't3' });

      const critical = panel.getEvents({ level: 'critical' });
      expect(critical.length).toBe(1);
      expect(critical[0]!.target).toBe('t2');
    });

    it('getEvents 按 source 过滤', () => {
      panel.log({ level: 'info', source: 'path-guard', action: 'allowed', target: 't1' });
      panel.log({ level: 'warn', source: 'sandbox', action: 'blocked', target: 't2' });

      const sandboxEvents = panel.getEvents({ source: 'sandbox' });
      expect(sandboxEvents.length).toBe(1);
      expect(sandboxEvents[0]!.target).toBe('t2');
    });

    it('getEvents 按 action 过滤', () => {
      panel.log({ level: 'info', source: 'a', action: 'allowed', target: 't1' });
      panel.log({ level: 'warn', source: 'b', action: 'blocked', target: 't2' });
      panel.log({ level: 'warn', source: 'c', action: 'blocked', target: 't3' });

      const blocked = panel.getEvents({ action: 'blocked' });
      expect(blocked.length).toBe(2);
    });

    it('getEvents 多条件组合过滤', () => {
      panel.log({ level: 'warn', source: 'sandbox', action: 'blocked', target: 't1' });
      panel.log({ level: 'warn', source: 'path-guard', action: 'blocked', target: 't2' });
      panel.log({ level: 'info', source: 'sandbox', action: 'allowed', target: 't3' });

      const result = panel.getEvents({ source: 'sandbox', action: 'blocked' });
      expect(result.length).toBe(1);
      expect(result[0]!.target).toBe('t1');
    });
  });

  // ============================================================
  // getSummary
  // ============================================================
  describe('getSummary', () => {
    it('空面板返回全 0 统计', () => {
      const summary = panel.getSummary();
      expect(summary.total).toBe(0);
      expect(summary.blocked).toBe(0);
      expect(summary.allowed).toBe(0);
      expect(summary.warned).toBe(0);
      expect(Object.keys(summary.bySource).length).toBe(0);
      expect(Object.keys(summary.byLevel).length).toBe(0);
    });

    it('正确统计 blocked / allowed / warned 数量', () => {
      panel.log({ level: 'warn', source: 'a', action: 'blocked', target: 't1' });
      panel.log({ level: 'warn', source: 'b', action: 'blocked', target: 't2' });
      panel.log({ level: 'info', source: 'c', action: 'allowed', target: 't3' });
      panel.log({ level: 'info', source: 'd', action: 'warned', target: 't4' });
      panel.log({ level: 'info', source: 'e', action: 'logged', target: 't5' });

      const summary = panel.getSummary();
      expect(summary.total).toBe(5);
      expect(summary.blocked).toBe(2);
      expect(summary.allowed).toBe(1);
      expect(summary.warned).toBe(1);
      // logged 不计入 blocked/allowed/warned，但计入 total
    });

    it('bySource 按来源分组统计', () => {
      panel.log({ level: 'warn', source: 'path-guard', action: 'blocked', target: 't1' });
      panel.log({ level: 'warn', source: 'path-guard', action: 'blocked', target: 't2' });
      panel.log({ level: 'warn', source: 'sandbox', action: 'blocked', target: 't3' });

      const summary = panel.getSummary();
      expect(summary.bySource['path-guard']).toBe(2);
      expect(summary.bySource['sandbox']).toBe(1);
    });

    it('byLevel 按级别分组统计', () => {
      panel.log({ level: 'info', source: 'a', action: 'allowed', target: 't1' });
      panel.log({ level: 'warn', source: 'b', action: 'blocked', target: 't2' });
      panel.log({ level: 'critical', source: 'c', action: 'blocked', target: 't3' });

      const summary = panel.getSummary();
      expect(summary.byLevel['info']).toBe(1);
      expect(summary.byLevel['warn']).toBe(1);
      expect(summary.byLevel['critical']).toBe(1);
    });
  });

  // ============================================================
  // clear
  // ============================================================
  describe('clear', () => {
    it('clear 应清空所有事件', () => {
      panel.log({ level: 'warn', source: 'a', action: 'blocked', target: 't1' });
      panel.log({ level: 'warn', source: 'b', action: 'blocked', target: 't2' });
      expect(panel.getEvents().length).toBe(2);

      panel.clear();
      expect(panel.getEvents().length).toBe(0);
      expect(panel.getSummary().total).toBe(0);
    });
  });

  // ============================================================
  // maxEvents FIFO 淘汰
  // ============================================================
  describe('maxEvents FIFO', () => {
    it('超过 maxEvents 时丢弃最旧事件', () => {
      const small = new SecurityAuditPanel({ maxEvents: 3 });
      small.log({ level: 'info', source: 'a', action: 'logged', target: 't1' });
      small.log({ level: 'info', source: 'a', action: 'logged', target: 't2' });
      small.log({ level: 'info', source: 'a', action: 'logged', target: 't3' });
      small.log({ level: 'info', source: 'a', action: 'logged', target: 't4' });

      const events = small.getEvents();
      expect(events.length).toBe(3);
      // t1 应被淘汰，保留 t2/t3/t4
      expect(events[0]!.target).toBe('t2');
      expect(events[2]!.target).toBe('t4');
    });

    it('默认 maxEvents=1000', () => {
      const defaultPanel = new SecurityAuditPanel();
      for (let i = 0; i < 1005; i++) {
        defaultPanel.log({
          level: 'info',
          source: 'a',
          action: 'logged',
          target: `t${i}`,
        });
      }
      const events = defaultPanel.getEvents();
      expect(events.length).toBe(1000);
      // 最旧的 5 条被淘汰，最早保留的是 t5
      expect(events[0]!.target).toBe('t5');
    });
  });

  // ============================================================
  // exportReport
  // ============================================================
  describe('exportReport', () => {
    it('exportReport 应包含报告标题与统计', () => {
      panel.log({ level: 'warn', source: 'sandbox', action: 'blocked', target: 'rm -rf /', reason: '危险' });

      const report = panel.exportReport();
      expect(report).toContain('安全审计报告');
      expect(report).toContain('总事件: 1');
      expect(report).toContain('拦截: 1');
      expect(report).toContain('按来源: sandbox=1');
      expect(report).toContain('按级别: warn=1');
      expect(report).toContain('rm -rf /');
      expect(report).toContain('sandbox/blocked');
    });

    it('exportReport 空面板也应输出基本结构', () => {
      const report = panel.exportReport();
      expect(report).toContain('安全审计报告');
      expect(report).toContain('总事件: 0');
      expect(report).toContain('按来源: (无)');
      expect(report).toContain('最近事件');
    });

    it('exportReport 最多展示 50 条最近事件', () => {
      for (let i = 0; i < 60; i++) {
        panel.log({
          level: 'info',
          source: 'a',
          action: 'logged',
          target: `t${i}`,
        });
      }
      const report = panel.exportReport();
      // 报告应包含 "最多 50 条" 提示
      expect(report).toContain('最多 50 条');
      // 不应包含 t0..t9（已被截断）
      expect(report).not.toContain('target=t0');
    });
  });
});
