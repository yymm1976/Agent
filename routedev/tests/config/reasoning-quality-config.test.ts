// tests/config/reasoning-quality-config.test.ts
// Phase 67 Task 7：推理质量诊断模块的配置测试
//
// 测试策略：
//   - 直接构造配置对象（不依赖 schema.ts）
//   - 验证各模块的默认配置值
//   - 验证 collapseThreshold 范围校验（手动验证，不依赖 zod schema）
//
// 覆盖蓝图 Task 7 测试要求：
//   1. MICrossScorer 默认配置（collapseThreshold=1.5, minPrompts=2, samplesPerPrompt=4）
//   2. SNRAwareFilter 默认配置（topP=0.9, minRVThreshold=0.01, batchRejectRatio=0.7）
//   3. EpistemicTokenProtector 默认配置（neighborhoodLines=3）
//   4. EpistemicIntegrityChecker 默认配置（overCompressionThreshold=0.5, minTokenCount=5）
//   5. EpistemicPreservingSummarizer 默认配置（maxTokens=500）
//   6. collapseThreshold 范围校验（手动验证 < 1 或 > 5 时应拒绝）

import { describe, it, expect } from 'vitest';
import {
  MICrossScorer,
  DEFAULT_MI_CROSS_SCORER_CONFIG,
  type MICrossScorerConfig,
} from '../../src/evaluation/mi-cross-scorer.js';
import {
  SNRAwareFilter,
  DEFAULT_SNR_AWARE_FILTER_CONFIG,
  type SNRAwareFilterConfig,
} from '../../src/agent/snr-aware-filter.js';
import {
  EpistemicTokenProtector,
  DEFAULT_EPISTEMIC_TOKEN_PROTECTOR_CONFIG,
  type EpistemicTokenProtectorConfig,
} from '../../src/agent/epistemic-token-protector.js';
import {
  EpistemicIntegrityChecker,
  DEFAULT_EPISTEMIC_INTEGRITY_CHECKER_CONFIG,
  type EpistemicIntegrityCheckerConfig,
} from '../../src/agent/epistemic-integrity-checker.js';
import {
  EpistemicPreservingSummarizer,
  DEFAULT_EPISTEMIC_PRESERVING_SUMMARIZER_CONFIG,
  type EpistemicPreservingSummarizerConfig,
} from '../../src/agent/epistemic-preserving-summarizer.js';
import {
  QualityMetricsRecorder,
  DEFAULT_QUALITY_METRICS_RECORDER_CONFIG,
} from '../../src/harness/quality-metrics-types.js';

// ============================================================
// 手动范围校验函数（模拟 zod schema 的范围校验）
// ============================================================

/**
 * 验证 collapseThreshold 是否在 [1, 5] 范围内
 *
 * 这是手动校验，不依赖 zod schema——
 * 用于验证用户提供的配置值是否合理。
 * 在实际生产中，应由 schema.ts 中的 z.number().min(1).max(5) 校验。
 */
function validateCollapseThreshold(value: number): { valid: boolean; reason?: string } {
  if (value < 1) {
    return { valid: false, reason: `collapseThreshold=${value} < 1，过敏感（任何 miZScoreEma 都会触发告警）` };
  }
  if (value > 5) {
    return { valid: false, reason: `collapseThreshold=${value} > 5，过宽松（即使严重坍缩也不会告警）` };
  }
  return { valid: true };
}

// ============================================================
// 测试套件
// ============================================================

describe('Reasoning Quality Config (Phase 67 Task 7)', () => {
  // ============================================================
  // 测试 1：MICrossScorer 默认配置
  // ============================================================
  it('1. MICrossScorer 默认配置应符合规范', () => {
    expect(DEFAULT_MI_CROSS_SCORER_CONFIG.enabled).toBe(false);
    expect(DEFAULT_MI_CROSS_SCORER_CONFIG.collapseThreshold).toBe(1.5);
    expect(DEFAULT_MI_CROSS_SCORER_CONFIG.minPrompts).toBe(2);
    expect(DEFAULT_MI_CROSS_SCORER_CONFIG.samplesPerPrompt).toBe(4);

    // 验证使用默认配置构造实例不抛异常
    const scorer = new MICrossScorer(DEFAULT_MI_CROSS_SCORER_CONFIG);
    expect(scorer).toBeInstanceOf(MICrossScorer);
  });

  // ============================================================
  // 测试 2：SNRAwareFilter 默认配置
  // ============================================================
  it('2. SNRAwareFilter 默认配置应符合规范', () => {
    expect(DEFAULT_SNR_AWARE_FILTER_CONFIG.enabled).toBe(false);
    expect(DEFAULT_SNR_AWARE_FILTER_CONFIG.topP).toBe(0.9);
    expect(DEFAULT_SNR_AWARE_FILTER_CONFIG.minRVThreshold).toBe(0.01);
    expect(DEFAULT_SNR_AWARE_FILTER_CONFIG.batchRejectRatio).toBe(0.7);

    // 验证使用默认配置构造实例不抛异常
    const filter = new SNRAwareFilter(DEFAULT_SNR_AWARE_FILTER_CONFIG);
    expect(filter).toBeInstanceOf(SNRAwareFilter);
  });

  // ============================================================
  // 测试 3：EpistemicTokenProtector 默认配置
  // ============================================================
  it('3. EpistemicTokenProtector 默认配置应符合规范', () => {
    expect(DEFAULT_EPISTEMIC_TOKEN_PROTECTOR_CONFIG.enabled).toBe(false);
    expect(DEFAULT_EPISTEMIC_TOKEN_PROTECTOR_CONFIG.neighborhoodLines).toBe(3);
    expect(DEFAULT_EPISTEMIC_TOKEN_PROTECTOR_CONFIG.customTokens).toBeUndefined();

    // 验证使用默认配置构造实例不抛异常
    const protector = new EpistemicTokenProtector(DEFAULT_EPISTEMIC_TOKEN_PROTECTOR_CONFIG);
    expect(protector).toBeInstanceOf(EpistemicTokenProtector);
  });

  // ============================================================
  // 测试 4：EpistemicIntegrityChecker 默认配置
  // ============================================================
  it('4. EpistemicIntegrityChecker 默认配置应符合规范', () => {
    expect(DEFAULT_EPISTEMIC_INTEGRITY_CHECKER_CONFIG.enabled).toBe(false);
    expect(DEFAULT_EPISTEMIC_INTEGRITY_CHECKER_CONFIG.overCompressionThreshold).toBe(0.5);
    expect(DEFAULT_EPISTEMIC_INTEGRITY_CHECKER_CONFIG.minTokenCount).toBe(5);

    // 验证使用默认配置构造实例不抛异常
    const protector = new EpistemicTokenProtector({ enabled: true, neighborhoodLines: 3 });
    const checker = new EpistemicIntegrityChecker(
      protector,
      DEFAULT_EPISTEMIC_INTEGRITY_CHECKER_CONFIG,
    );
    expect(checker).toBeInstanceOf(EpistemicIntegrityChecker);
  });

  // ============================================================
  // 测试 5：EpistemicPreservingSummarizer 默认配置
  // ============================================================
  it('5. EpistemicPreservingSummarizer 默认配置应符合规范', () => {
    expect(DEFAULT_EPISTEMIC_PRESERVING_SUMMARIZER_CONFIG.enabled).toBe(false);
    expect(DEFAULT_EPISTEMIC_PRESERVING_SUMMARIZER_CONFIG.maxTokens).toBe(500);

    // 验证使用默认配置构造实例不抛异常
    const protector = new EpistemicTokenProtector({ enabled: true, neighborhoodLines: 3 });
    const summarizer = new EpistemicPreservingSummarizer(
      protector,
      DEFAULT_EPISTEMIC_PRESERVING_SUMMARIZER_CONFIG,
    );
    expect(summarizer).toBeInstanceOf(EpistemicPreservingSummarizer);
  });

  // ============================================================
  // 测试 6：collapseThreshold 范围校验（手动验证 < 1 或 > 5 时应拒绝）
  // ============================================================
  describe('collapseThreshold 范围校验', () => {
    it('6.1 collapseThreshold < 1 时应拒绝（过敏感）', () => {
      // 0.5 < 1 → 拒绝
      const result = validateCollapseThreshold(0.5);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('< 1');

      // 0.99 < 1 → 拒绝
      expect(validateCollapseThreshold(0.99).valid).toBe(false);

      // 边界值：1.0 应接受
      expect(validateCollapseThreshold(1.0).valid).toBe(true);
    });

    it('6.2 collapseThreshold > 5 时应拒绝（过宽松）', () => {
      // 6 > 5 → 拒绝
      const result = validateCollapseThreshold(6);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('> 5');

      // 10 > 5 → 拒绝
      expect(validateCollapseThreshold(10).valid).toBe(false);

      // 边界值：5.0 应接受
      expect(validateCollapseThreshold(5.0).valid).toBe(true);
    });

    it('6.3 collapseThreshold 在 [1, 5] 范围内应接受', () => {
      // 1.5（默认值）应接受
      expect(validateCollapseThreshold(1.5).valid).toBe(true);
      // 2.0 应接受
      expect(validateCollapseThreshold(2.0).valid).toBe(true);
      // 3.0 应接受
      expect(validateCollapseThreshold(3.0).valid).toBe(true);
      // 5.0 应接受
      expect(validateCollapseThreshold(5.0).valid).toBe(true);
    });

    it('6.4 默认 collapseThreshold=1.5 应在合法范围内', () => {
      const defaultThreshold = DEFAULT_MI_CROSS_SCORER_CONFIG.collapseThreshold;
      const result = validateCollapseThreshold(defaultThreshold);
      expect(result.valid).toBe(true);
    });
  });

  // ============================================================
  // 额外测试 7：QualityMetricsRecorder 默认配置
  // ============================================================
  it('7. QualityMetricsRecorder 默认配置应符合规范', () => {
    expect(DEFAULT_QUALITY_METRICS_RECORDER_CONFIG.enabled).toBe(false);

    // 验证使用默认配置构造实例不抛异常
    const recorder = new QualityMetricsRecorder(DEFAULT_QUALITY_METRICS_RECORDER_CONFIG);
    expect(recorder).toBeInstanceOf(QualityMetricsRecorder);
  });

  // ============================================================
  // 额外测试 8：自定义配置可覆盖默认值
  // ============================================================
  it('8. 自定义配置应能覆盖默认值', () => {
    const customMIConfig: MICrossScorerConfig = {
      enabled: true,
      collapseThreshold: 2.5,
      minPrompts: 5,
      samplesPerPrompt: 8,
    };
    const scorer = new MICrossScorer(customMIConfig);
    expect(scorer).toBeInstanceOf(MICrossScorer);

    const customSNRConfig: SNRAwareFilterConfig = {
      enabled: true,
      topP: 0.8,
      minRVThreshold: 0.05,
      batchRejectRatio: 0.5,
    };
    const filter = new SNRAwareFilter(customSNRConfig);
    expect(filter).toBeInstanceOf(SNRAwareFilter);

    const customProtectorConfig: EpistemicTokenProtectorConfig = {
      enabled: true,
      neighborhoodLines: 5,
      customTokens: ['lemme see'],
    };
    const protector = new EpistemicTokenProtector(customProtectorConfig);
    expect(protector).toBeInstanceOf(EpistemicTokenProtector);

    const customCheckerConfig: EpistemicIntegrityCheckerConfig = {
      enabled: true,
      overCompressionThreshold: 0.3,
      minTokenCount: 10,
    };
    const checker = new EpistemicIntegrityChecker(protector, customCheckerConfig);
    expect(checker).toBeInstanceOf(EpistemicIntegrityChecker);

    const customSummarizerConfig: EpistemicPreservingSummarizerConfig = {
      enabled: true,
      maxTokens: 1000,
    };
    const summarizer = new EpistemicPreservingSummarizer(protector, customSummarizerConfig);
    expect(summarizer).toBeInstanceOf(EpistemicPreservingSummarizer);
  });
});
