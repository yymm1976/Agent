// tests/agent/discovery-eq.test.ts
// EQ 感知与节奏调节单元测试

import { describe, it, expect, beforeEach } from 'vitest';
import { EQDetector } from '../../src/agent/eq-detector.js';

describe('EQDetector', () => {
  let detector: EQDetector;

  beforeEach(() => {
    detector = new EQDetector();
  });

  it('1. 初始状态应为 calm', () => {
    const adj = detector.analyze();
    expect(adj.state).toBe('calm');
    expect(adj.confirmationLevel).toBe('normal');
  });

  it('2. recordRollback 2 次应进入 frustrated', () => {
    detector.recordRollback();
    detector.recordRollback();
    const adj = detector.analyze();
    expect(adj.state).toBe('frustrated');
    expect(adj.tone).toBe('supportive');
    expect(adj.confirmationLevel).toBe('increased');
    expect(adj.shouldPreviewImpact).toBe(true);
  });

  it('3. recordInterruption 2 次应进入 rushed', () => {
    detector.recordInterruption();
    detector.recordInterruption();
    const adj = detector.analyze();
    expect(adj.state).toBe('rushed');
    expect(adj.tone).toBe('concise');
    expect(adj.confirmationLevel).toBe('reduced');
  });

  it('4. recordRepeatedPrompt 2 次应进入 confused', () => {
    detector.recordRepeatedPrompt();
    detector.recordRepeatedPrompt();
    const adj = detector.analyze();
    expect(adj.state).toBe('confused');
    expect(adj.tone).toBe('mentor');
    expect(adj.shouldAskClarification).toBe(true);
  });

  it('5. recordEdit 3 次应进入 frustrated', () => {
    detector.recordEdit();
    detector.recordEdit();
    detector.recordEdit();
    const adj = detector.analyze();
    expect(adj.state).toBe('frustrated');
    expect(adj.shouldPreviewImpact).toBe(true);
  });

  it('6. recordError high 应进入 frustrated', () => {
    detector.recordError('high');
    const adj = detector.analyze();
    expect(adj.state).toBe('frustrated');
    expect(adj.tone).toBe('supportive');
  });

  it('7. frustrated 状态 needsExtraConfirmation 对普通动作应返回 true', () => {
    detector.recordRollback();
    detector.recordRollback();
    expect(detector.analyze().state).toBe('frustrated');
    expect(detector.needsExtraConfirmation('edit-file')).toBe(true);
  });

  it('8. rushed 状态 needsExtraConfirmation 对低风险动作应返回 false', () => {
    detector.recordInterruption();
    detector.recordInterruption();
    expect(detector.analyze().state).toBe('rushed');
    expect(detector.needsExtraConfirmation('read-file')).toBe(false);
  });

  it('8b. 高风险动作在任何状态下都应返回 true', () => {
    // calm 状态下，高风险动作仍需确认
    expect(detector.analyze().state).toBe('calm');
    expect(detector.needsExtraConfirmation('delete-file')).toBe(true);
    expect(detector.needsExtraConfirmation('force-push')).toBe(true);
  });

  it('9. analyze 对各状态应返回正确的 tone 调整', () => {
    // frustrated → supportive
    detector.recordRollback();
    detector.recordRollback();
    expect(detector.analyze().tone).toBe('supportive');

    detector.reset();
    // rushed → concise
    detector.recordInterruption();
    detector.recordInterruption();
    expect(detector.analyze().tone).toBe('concise');

    detector.reset();
    // confused → mentor
    detector.recordRepeatedPrompt();
    detector.recordRepeatedPrompt();
    expect(detector.analyze().tone).toBe('mentor');
  });

  it('10. getRhythmAdvice 应返回非空文本', () => {
    const advice = detector.getRhythmAdvice();
    expect(typeof advice).toBe('string');
    expect(advice.length).toBeGreaterThan(0);

    detector.recordRollback();
    detector.recordRollback();
    const frustratedAdvice = detector.getRhythmAdvice();
    expect(frustratedAdvice.length).toBeGreaterThan(0);
    expect(frustratedAdvice).not.toBe(advice);
  });

  it('11. reset 后所有信号应归零并回到 calm', () => {
    detector.recordRollback();
    detector.recordRollback();
    detector.recordEdit();
    detector.recordInterruption();
    detector.recordError('high');
    expect(detector.analyze().state).not.toBe('calm');

    detector.reset();
    const signals = detector.getSignals();
    expect(signals.consecutiveEdits).toBe(0);
    expect(signals.consecutiveRollbacks).toBe(0);
    expect(signals.interruptionCount).toBe(0);
    expect(signals.repeatedPrompts).toBe(0);
    expect(signals.lastErrorSeverity).toBeUndefined();
    expect(detector.analyze().state).toBe('calm');
  });
});
