// tests/agent/quantitative-gate.test.ts
// Phase 68 Task 5: MDL/AIC 定量门测试

import { describe, it, expect } from 'vitest';
import {
  QuantitativeGate,
  DEFAULT_GATE_CONFIG,
  type CandidateSolution,
  type GateDecision,
} from '../../src/agent/quantitative-gate.js';

function makeGate(overrides?: Partial<typeof DEFAULT_GATE_CONFIG>) {
  return new QuantitativeGate({ ...DEFAULT_GATE_CONFIG, enabled: true, ...overrides });
}

describe('QuantitativeGate (Phase 68 Task 5)', () => {
  describe('evaluate - 单候选', () => {
    it('短描述 + 默认 fitScore → accept（综合分 ≥ acceptThreshold）', () => {
      const gate = makeGate();
      const result = gate.evaluate({ id: 'test-1', description: 'hello' });
      // tokens≈2, mdlScore≈0.996, fitScore=0.5, complexity=2
      // aicRaw=0.48, normalizedAic=0.52, composite≈0.7104
      expect(result.decision).toBe('accept');
      expect(result.compositeScore).toBeGreaterThanOrEqual(0.7);
    });

    it('长描述 + 高 fitScore + 低显式 complexity → reject（综合分 < rejectThreshold）', () => {
      const gate = makeGate();
      const result = gate.evaluate({
        id: 'test-2',
        description: 'a'.repeat(2000),
        fitScore: 0.99,
        complexity: 1,
      });
      // tokens=500, mdlScore=0, aicRaw=0.99-0.01=0.98, normalizedAic=0.02
      // composite=0.4*0+0.6*0.02=0.012
      expect(result.decision).toBe('reject');
      expect(result.compositeScore).toBeLessThan(0.3);
    });

    it('中等描述 + 中等 fitScore → hold（综合分介于阈值之间）', () => {
      const gate = makeGate();
      const result = gate.evaluate({
        id: 'test-3',
        description: 'x'.repeat(100),
        fitScore: 0.9,
      });
      // tokens=25, mdlScore=0.95, complexity=25
      // aicRaw=0.9-0.25=0.65, normalizedAic=0.35
      // composite=0.4*0.95+0.6*0.35=0.59
      expect(result.decision).toBe('hold');
      expect(result.compositeScore).toBeGreaterThanOrEqual(0.3);
      expect(result.compositeScore).toBeLessThan(0.7);
    });
  });

  describe('evaluateMultiple - 多候选', () => {
    it('最高分候选 accept，其余 supersede', () => {
      const gate = makeGate();
      const results = gate.evaluateMultiple([
        { id: 'alpha', description: 'short' },
        { id: 'beta', description: 'a'.repeat(2000), fitScore: 0.99, complexity: 1 },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].decision).toBe('accept');
      expect(results[1].decision).toBe('supersede');
      expect(results[1].rationale).toContain('alpha');
    });

    it('所有候选低于 rejectThreshold → 全部 reject', () => {
      const gate = makeGate();
      const results = gate.evaluateMultiple([
        { id: 'a', description: 'a'.repeat(2000), fitScore: 0.99, complexity: 1 },
        { id: 'b', description: 'b'.repeat(2000), fitScore: 0.99, complexity: 1 },
      ]);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.decision === 'reject')).toBe(true);
    });

    it('空数组 → 空结果', () => {
      const gate = makeGate();
      expect(gate.evaluateMultiple([])).toEqual([]);
    });
  });

  describe('MDL 分数', () => {
    it('短描述的 mdlScore 高于长描述', () => {
      const gate = makeGate();
      const shortResult = gate.evaluate({ id: 's', description: 'hi' });
      const longResult = gate.evaluate({ id: 'l', description: 'x'.repeat(2000) });
      expect(shortResult.mdlScore).toBeGreaterThan(longResult.mdlScore);
    });
  });

  describe('自定义权重', () => {
    it('改变 mdlWeight/aicWeight 会影响 compositeScore', () => {
      const candidate: CandidateSolution = {
        id: 'w',
        description: 'x'.repeat(100),
        fitScore: 0.9,
      };
      const defaultGate = makeGate();
      const heavyMdl = makeGate({ mdlWeight: 0.9, aicWeight: 0.1 });
      const scoreA = defaultGate.evaluate(candidate).compositeScore;
      const scoreB = heavyMdl.evaluate(candidate).compositeScore;
      expect(scoreA).not.toBeCloseTo(scoreB, 2);
    });
  });

  describe('fitScore 对 AIC 分数的影响', () => {
    it('不同 fitScore 产生不同的 aicScore', () => {
      const gate = makeGate();
      const lowFit = gate.evaluate({ id: 'lf', description: 'x'.repeat(100), fitScore: 0.1 });
      const highFit = gate.evaluate({ id: 'hf', description: 'x'.repeat(100), fitScore: 0.9 });
      expect(lowFit.aicScore).not.toBeCloseTo(highFit.aicScore, 2);
      expect(lowFit.aicScore).toBeGreaterThan(highFit.aicScore);
    });
  });
});
