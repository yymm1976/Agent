import { describe, it, expect } from 'vitest';
import { BudgetAwareRenderer } from '../../src/agent/budget-aware-renderer.js';
import type { BudgetRenderConfig } from '../../src/agent/budget-aware-renderer.js';

const FULL_BUDGET = 200000;

function makeConfig(overrides: Partial<BudgetRenderConfig> = {}): BudgetRenderConfig {
  return {
    enabled: true,
    contextWindow: FULL_BUDGET,
    softNotifyThreshold: 0.5,
    triggerThreshold: 0.8,
    forceThreshold: 0.9,
    renderEveryTurn: true,
    ...overrides,
  };
}

describe('BudgetAwareRenderer', () => {
  describe('computeBudget 四级', () => {
    it('ratio < 0.5 → safe', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const snap = r.computeBudget(50000);
      expect(snap.level).toBe('safe');
    });

    it('0.5 <= ratio < 0.8 → soft-notify', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const snap = r.computeBudget(110000);
      expect(snap.level).toBe('soft-notify');
    });

    it('0.8 <= ratio < 0.9 → trigger', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const snap = r.computeBudget(170000);
      expect(snap.level).toBe('trigger');
    });

    it('ratio >= 0.9 → force', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const snap = r.computeBudget(190000);
      expect(snap.level).toBe('force');
    });
  });

  describe('renderMarker 格式', () => {
    it('格式包含 BUDGET/used/remaining/level', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const snap = r.computeBudget(100000);
      const marker = r.renderMarker(snap);
      expect(marker).toContain('BUDGET');
      expect(marker).toContain('used=100000');
      expect(marker).toContain('remaining=100000');
      expect(marker).toContain('level=soft-notify');
    });
  });

  describe('renderAdvice 四级建议', () => {
    it('safe 级别无建议', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const snap = r.computeBudget(50000);
      expect(r.renderAdvice(snap)).toBe('');
    });

    it('soft-notify 级别包含 prune_chunks 建议', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const snap = r.computeBudget(110000);
      expect(r.renderAdvice(snap)).toContain('prune_chunks');
    });

    it('trigger 级别包含立即调用建议', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const snap = r.computeBudget(170000);
      expect(r.renderAdvice(snap)).toContain('立即');
    });

    it('force 级别包含必须 prune 建议', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const snap = r.computeBudget(190000);
      expect(r.renderAdvice(snap)).toContain('必须');
    });
  });

  describe('renderBudgetPrompt', () => {
    it('拼接 marker + advice', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const result = r.renderBudgetPrompt(100000);
      expect(result.prompt).toContain('BUDGET');
      expect(result.snapshot.level).toBe('soft-notify');
    });

    it('safe 级别 prompt 仅含 marker（无 advice）', () => {
      const r = new BudgetAwareRenderer(makeConfig());
      const result = r.renderBudgetPrompt(50000);
      expect(result.prompt).not.toContain('建议');
    });
  });
});
