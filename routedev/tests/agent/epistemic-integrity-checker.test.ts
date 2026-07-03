// tests/agent/epistemic-integrity-checker.test.ts
// Phase 67 Task 4：认知完整性检查器单元测试
//
// 覆盖蓝图 Task 4 测试要求：
//   1. 原始与审查后频率一致→frequencyDropRatio=0 无预警
//   2. 频率下降 60%→overCompressionWarning=true
//   3. 频率下降 30%→无预警（未超阈值）
//   4. 原始 token 计数 < minTokenCount→不触发预警
//   5. 频率上升→frequencyDropRatio<0 无预警
//   6. 配置关闭时返回占位结果

import { describe, it, expect, beforeEach } from 'vitest';
import { EpistemicTokenProtector } from '../../src/agent/epistemic-token-protector.js';
import {
  EpistemicIntegrityChecker,
  DEFAULT_EPISTEMIC_INTEGRITY_CHECKER_CONFIG,
} from '../../src/agent/epistemic-integrity-checker.js';

// ============================================================
// 测试套件
// ============================================================

describe('EpistemicIntegrityChecker (Phase 67 Task 4)', () => {
  let protector: EpistemicTokenProtector;
  let checker: EpistemicIntegrityChecker;

  beforeEach(() => {
    protector = new EpistemicTokenProtector({
      enabled: true,
      neighborhoodLines: 3,
    });
    checker = new EpistemicIntegrityChecker(protector, {
      enabled: true,
      overCompressionThreshold: 0.5,
      minTokenCount: 5,
    });
  });

  // ============================================================
  // 测试 1：原始与审查后频率一致→frequencyDropRatio=0 无预警
  // ============================================================
  it('1. 原始与审查后频率一致时 frequencyDropRatio=0 无预警', () => {
    // 原始与审查后完全相同（频率一致）
    const original = 'wait, let me think\nhmm, perhaps\nbut actually maybe not sure';
    const reviewed = original; // 完全一致

    const result = checker.check(original, reviewed);

    expect(result.originalFrequency).toBe(result.reviewedFrequency);
    expect(result.frequencyDropRatio).toBe(0);
    expect(result.overCompressionWarning).toBe(false);
  });

  // ============================================================
  // 测试 2：频率下降 60%→overCompressionWarning=true
  // ============================================================
  it('2. 频率下降 60% 且 token 计数足够时应触发 overCompressionWarning', () => {
    // 原始：包含 10 个 epistemic token，长度 100
    // 频率 = 10/100 = 0.1
    const original = Array.from({ length: 10 }, (_, i) => `wait line ${i}`).join('\n');
    // 原始长度约 100+，token 数 = 10

    // 审查后：仅保留 4 个 epistemic token，长度相同（约 100）
    // 频率 = 4/100 = 0.04
    // 下降比 = (0.1 - 0.04) / 0.1 = 0.6（60%）
    const reviewed = Array.from({ length: 4 }, (_, i) => `wait line ${i}`).join('\n')
      + '\nplain text\nplain text\nplain text\nplain text\nplain text\nplain text';

    const result = checker.check(original, reviewed);

    // 频率下降比应接近 0.6
    expect(result.frequencyDropRatio).toBeGreaterThan(0.5);
    expect(result.originalFrequency).toBeGreaterThan(result.reviewedFrequency);
    // 原始 token 计数 = 10 >= 5
    expect(protector.countEpistemicTokens(original)).toBeGreaterThanOrEqual(5);
    // 触发预警
    expect(result.overCompressionWarning).toBe(true);
  });

  // ============================================================
  // 测试 3：频率下降 30%→无预警（未超阈值）
  // ============================================================
  it('3. 频率下降 30%（未超 50% 阈值）时不应触发预警', () => {
    // 原始：10 个 token，长度约 100，频率 0.1
    const original = Array.from({ length: 10 }, (_, i) => `wait line ${i}`).join('\n');

    // 审查后：7 个 token，长度相同，频率 0.07
    // 下降比 = (0.1 - 0.07) / 0.1 = 0.3（30%，未超 50% 阈值）
    const reviewed = Array.from({ length: 7 }, (_, i) => `wait line ${i}`).join('\n')
      + '\nplain text\nplain text\nplain text';

    const result = checker.check(original, reviewed);

    // 频率下降比应小于阈值 0.5
    expect(result.frequencyDropRatio).toBeLessThan(0.5);
    expect(result.frequencyDropRatio).toBeGreaterThan(0);
    // 不应触发预警
    expect(result.overCompressionWarning).toBe(false);
  });

  // ============================================================
  // 测试 4：原始 token 计数 < minTokenCount→不触发预警
  // ============================================================
  it('4. 原始 token 计数 < minTokenCount 时不应触发预警', () => {
    // minTokenCount=5，原始仅 3 个 token
    // 即使频率下降 100%，因计数不足也不预警
    const original = 'wait\nhmm\nbut'; // 3 个 token
    const reviewed = 'plain text with no epistemic tokens'; // 0 个 token

    const result = checker.check(original, reviewed);

    // 原始 token 计数 = 3 < 5
    expect(protector.countEpistemicTokens(original)).toBe(3);
    // 频率下降比应较大（接近 1）
    expect(result.frequencyDropRatio).toBeGreaterThan(0.5);
    // 但因计数不足，不触发预警
    expect(result.overCompressionWarning).toBe(false);
  });

  // ============================================================
  // 测试 5：频率上升→frequencyDropRatio<0 无预警
  // ============================================================
  it('5. 频率上升时 frequencyDropRatio<0 不应触发预警', () => {
    // 原始：少量 token
    const original = 'plain text with one wait token';
    // 审查后：增加了更多 epistemic token（频率上升）
    const reviewed = 'wait, hmm, perhaps, but, however, maybe, actually, not sure, let me reconsider, on second thought';

    const result = checker.check(original, reviewed);

    // 频率上升 → drop ratio < 0
    expect(result.frequencyDropRatio).toBeLessThan(0);
    expect(result.reviewedFrequency).toBeGreaterThan(result.originalFrequency);
    // 不应触发预警
    expect(result.overCompressionWarning).toBe(false);
  });

  // ============================================================
  // 测试 6：配置关闭时返回占位结果
  // ============================================================
  it('6. 配置关闭时应返回占位结果', () => {
    const disabledChecker = new EpistemicIntegrityChecker(
      protector,
      {
        ...DEFAULT_EPISTEMIC_INTEGRITY_CHECKER_CONFIG,
        enabled: false,
      },
    );

    const original = 'wait, hmm, but, perhaps, maybe, not sure, actually, however';
    const reviewed = 'plain text';

    const result = disabledChecker.check(original, reviewed);

    // 占位结果：所有字段为 0/false
    expect(result.originalFrequency).toBe(0);
    expect(result.reviewedFrequency).toBe(0);
    expect(result.frequencyDropRatio).toBe(0);
    expect(result.overCompressionWarning).toBe(false);
  });

  // ============================================================
  // 额外测试 7：审查后为空字符串（完全丢失）
  // ============================================================
  it('7. 审查后为空字符串时应视为完全丢失（drop ratio=1）', () => {
    // 原始：10 个 token
    const original = Array.from({ length: 10 }, (_, i) => `wait line ${i}`).join('\n');
    const reviewed = '';

    const result = checker.check(original, reviewed);

    // reviewedFrequency = 0
    expect(result.reviewedFrequency).toBe(0);
    // frequencyDropRatio = 1（完全丢失）
    expect(result.frequencyDropRatio).toBe(1);
    // 原始计数 >= 5 且下降比 > 0.5 → 触发预警
    expect(result.overCompressionWarning).toBe(true);
  });

  // ============================================================
  // 额外测试 8：原始为空字符串
  // ============================================================
  it('8. 原始为空字符串时应返回占位结果（无频率可计算）', () => {
    const result = checker.check('', 'wait, hmm');

    // 原始长度=0，originalFrequency=0，无法计算 drop ratio
    expect(result.originalFrequency).toBe(0);
    expect(result.frequencyDropRatio).toBe(0);
    expect(result.overCompressionWarning).toBe(false);
  });
});
