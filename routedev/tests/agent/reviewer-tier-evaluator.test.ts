// tests/agent/reviewer-tier-evaluator.test.ts
// Phase 51 Task 1/7：Reviewer 分级与审查反馈协议单元测试
//
// 覆盖关键能力：
//   1. assessRisk 风险因子评分（security / data-integrity / 多因子叠加 / 无因子）
//   2. selectCrossModelReviewer 跨家族模型选择
//   3. determineReviewerTier 四档判定（high-risk > tiny > big > medium）
//   4. getReviewPassesForTier 轮次映射
//
// 全部为纯函数测试，不依赖 LLM 或文件系统。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  assessRisk,
  selectCrossModelReviewer,
  determineReviewerTier,
  getReviewPassesForTier,
  validateReviewFeedback,
  type ReviewerTier,
} from '../../src/agent/reviewer-tier-evaluator.js';

describe('Phase 51 Task 1/7: reviewer-tier-evaluator 单元测试', () => {
  beforeEach(() => {
    // 纯函数无外部状态
  });

  // ============================================================
  // 1. assessRisk 风险评估
  // ============================================================

  it('1.1 assessRisk: security 因子触发 high-risk（score=40）', () => {
    const result = assessRisk({
      affectsSecurity: true,
      affectsDataIntegrity: false,
      affectsFileSystem: false,
      stepCount: 5,
      crossModuleChange: false,
      hasExternalSideEffects: false,
    });
    expect(result.riskScore).toBe(40);
    expect(result.isHighRisk).toBe(true); // 40 >= 默认阈值 40
    expect(result.riskFactors).toContain('security');
  });

  it('1.2 assessRisk: 多因子叠加 score 正确（security+data-integrity=70）', () => {
    const result = assessRisk({
      affectsSecurity: true,
      affectsDataIntegrity: true,
      affectsFileSystem: false,
      stepCount: 5,
      crossModuleChange: false,
      hasExternalSideEffects: false,
    });
    expect(result.riskScore).toBe(70);
    expect(result.isHighRisk).toBe(true);
    expect(result.riskFactors).toContain('security');
    expect(result.riskFactors).toContain('data-integrity');
    expect(result.riskFactors).toHaveLength(2);
  });

  it('1.3 assessRisk: 无风险因子时 score=0，isHighRisk=false', () => {
    const result = assessRisk({
      affectsSecurity: false,
      affectsDataIntegrity: false,
      affectsFileSystem: false,
      stepCount: 5,
      crossModuleChange: false,
      hasExternalSideEffects: false,
    });
    expect(result.riskScore).toBe(0);
    expect(result.isHighRisk).toBe(false);
    expect(result.riskFactors).toHaveLength(0);
  });

  it('1.4 assessRisk: 大任务（stepCount > 30）+ 文件系统写入叠加 10 分', () => {
    const result = assessRisk({
      affectsSecurity: false,
      affectsDataIntegrity: false,
      affectsFileSystem: true,
      stepCount: 50,
      crossModuleChange: false,
      hasExternalSideEffects: false,
    });
    // filesystem-write(5) + large-step-count(5) = 10
    expect(result.riskScore).toBe(10);
    expect(result.isHighRisk).toBe(false); // 10 < 40
    expect(result.riskFactors).toContain('filesystem-write');
    expect(result.riskFactors).toContain('large-step-count');
  });

  it('1.5 assessRisk: 自定义 highRiskThreshold 阈值生效', () => {
    // 仅 filesystem-write(5)，阈值=5 时应判 high-risk
    const result = assessRisk({
      affectsSecurity: false,
      affectsDataIntegrity: false,
      affectsFileSystem: true,
      stepCount: 5,
      crossModuleChange: false,
      hasExternalSideEffects: false,
    }, 5);
    expect(result.riskScore).toBe(5);
    expect(result.isHighRisk).toBe(true);
  });

  // ============================================================
  // 2. selectCrossModelReviewer 跨模型选择
  // ============================================================

  it('2.1 selectCrossModelReviewer: 选择不同家族模型（primary=openai，available 含 anthropic）', () => {
    const result = selectCrossModelReviewer('gpt-5.4', ['gpt-5.4', 'claude-3.5-sonnet']);
    expect(result).toBe('claude-3.5-sonnet');
  });

  it('2.2 selectCrossModelReviewer: 无跨模型可用时返回 null', () => {
    const result = selectCrossModelReviewer('gpt-5.4', ['gpt-5.4', 'gpt-4o', 'openai-o1']);
    expect(result).toBeNull();
  });

  it('2.3 selectCrossModelReviewer: 空 availableModels 返回 null', () => {
    expect(selectCrossModelReviewer('gpt-5.4', [])).toBeNull();
  });

  it('2.4 selectCrossModelReviewer: 不同家族识别准确（gemini / glm / qwen）', () => {
    expect(selectCrossModelReviewer('gpt-5.4', ['gemini-pro', 'gpt-4o'])).toBe('gemini-pro');
    expect(selectCrossModelReviewer('claude-opus', ['glm-5', 'claude-3'])).toBe('glm-5');
    expect(selectCrossModelReviewer('gpt-5.4', ['qwen-max', 'gpt-4o'])).toBe('qwen-max');
  });

  // ============================================================
  // 3. determineReviewerTier 四档判定
  // ============================================================

  it('3.1 determineReviewerTier: high-risk 优先级最高（无论规模）', () => {
    // 即使是 1 步任务，high-risk 也优先
    const tier = determineReviewerTier(1, true, { tinyTaskStepThreshold: 5, bigTaskStepThreshold: 30 });
    expect(tier).toBe('high-risk' as ReviewerTier);
  });

  it('3.2 determineReviewerTier: tiny 档——步骤数小于 tinyTaskStepThreshold', () => {
    const tier = determineReviewerTier(3, false, { tinyTaskStepThreshold: 5, bigTaskStepThreshold: 30 });
    expect(tier).toBe('tiny' as ReviewerTier);
  });

  it('3.3 determineReviewerTier: big 档——步骤数大于 bigTaskStepThreshold', () => {
    const tier = determineReviewerTier(50, false, { tinyTaskStepThreshold: 5, bigTaskStepThreshold: 30 });
    expect(tier).toBe('big' as ReviewerTier);
  });

  it('3.4 determineReviewerTier: medium 档——步骤数介于两阈值之间', () => {
    const tier = determineReviewerTier(15, false, { tinyTaskStepThreshold: 5, bigTaskStepThreshold: 30 });
    expect(tier).toBe('medium' as ReviewerTier);
  });

  // ============================================================
  // 4. getReviewPassesForTier 轮次映射
  // ============================================================

  it('4.1 getReviewPassesForTier: tiny → 不审查（0/0/无跨模型）', () => {
    expect(getReviewPassesForTier('tiny')).toEqual({ midWork: 0, final: 0, crossModel: false });
  });

  it('4.2 getReviewPassesForTier: medium → 仅 final 一轮（0/1/false）', () => {
    expect(getReviewPassesForTier('medium')).toEqual({ midWork: 0, final: 1, crossModel: false });
  });

  it('4.3 getReviewPassesForTier: big → mid-work + final（1/1/false）', () => {
    expect(getReviewPassesForTier('big')).toEqual({ midWork: 1, final: 1, crossModel: false });
  });

  it('4.4 getReviewPassesForTier: high-risk → mid-work + final + crossModel（1/1/true）', () => {
    expect(getReviewPassesForTier('high-risk')).toEqual({ midWork: 1, final: 1, crossModel: true });
  });

  // ============================================================
  // 5. validateReviewFeedback 三件证据协议
  // ============================================================

  it('5.1 validateReviewFeedback: enforceEvidenceProtocol=true 时缺 evidence 被拒绝', () => {
    const feedback = {
      summary: '存在风险',
      risks: [
        {
          description: '风险描述',
          failureScenario: '失败场景',
          violatedInvariant: '违反的不变量',
          evidence: [], // 空证据
          severity: 'blocking' as const,
        },
      ],
      overallVerdict: 'fail' as const,
    };
    const result = validateReviewFeedback(feedback, { enforceEvidenceProtocol: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('evidence'))).toBe(true);
  });

  it('5.2 validateReviewFeedback: 三件证据齐备（含 evidence）时通过', () => {
    const feedback = {
      summary: '存在风险',
      risks: [
        {
          description: '风险描述',
          failureScenario: '失败场景',
          violatedInvariant: '违反的不变量',
          evidence: [{ file: 'src/a.ts', line: 42 }],
          severity: 'blocking' as const,
        },
      ],
      overallVerdict: 'fail' as const,
    };
    const result = validateReviewFeedback(feedback, { enforceEvidenceProtocol: true });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
