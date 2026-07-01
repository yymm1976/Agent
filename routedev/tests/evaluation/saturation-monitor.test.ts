// tests/evaluation/saturation-monitor.test.ts
// Phase 52 Task 7：评估集饱和监测单元测试
//
// 覆盖蓝图 Task 7 测试要求：
//   1. 通过率 > 95% 且方差 < 0.05 时标记为 saturated
//   2. 区分度正确计算（通过率高+方差低 → discrimination 低）
//   3. 建议新增困难用例类型合理（saturated 时返回非空数组）
//   4. 建议淘汰过简用例合理（aging + 低方差时返回非空数组）
//
// 额外覆盖：
//   5. 运行结果数 < checkInterval 时返回 healthy
//   6. healthy 状态下不返回困难用例建议
//   7. saturated 时 recommendation 为 replace_evaluation
//   8. saturationFactors 包含导致饱和的具体因素描述

import { describe, it, expect } from 'vitest';
import {
  SaturationMonitor,
  type EvaluationRunResult,
} from '../../src/evaluation/saturation-monitor.js';

// ============================================================
// 辅助函数
// ============================================================

/**
 * 构造一个评估运行结果
 *
 * @param overrides 覆盖字段
 */
function makeRun(overrides: Partial<EvaluationRunResult> = {}): EvaluationRunResult {
  return {
    runId: overrides.runId ?? 'run-1',
    timestamp: overrides.timestamp ?? Date.now(),
    modelId: overrides.modelId ?? 'mock-model',
    totalCases: overrides.totalCases ?? 10,
    passedCases: overrides.passedCases ?? 10,
    failedCases: overrides.failedCases ?? 0,
    caseScores: overrides.caseScores ?? [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    durationMs: overrides.durationMs ?? 1000,
  };
}

/**
 * 批量构造运行结果：所有 run 都使用相同的通过率和得分分布
 *
 * @param count 运行次数
 * @param passRate 每次运行的通过率（0-1）
 * @param score 所有用例的得分（统一值，便于控制方差）
 * @param totalCases 每次运行的总用例数（默认 10）
 */
function makeRuns(
  count: number,
  passRate: number,
  score: number,
  totalCases: number = 10,
): EvaluationRunResult[] {
  const passedCases = Math.round(passRate * totalCases);
  const failedCases = totalCases - passedCases;
  // 所有 case 得分统一为 score（方差为 0，便于测试饱和判定）
  const caseScores = Array.from({ length: totalCases }, () => score);
  return Array.from({ length: count }, (_, i) => makeRun({
    runId: `run-${i + 1}`,
    passedCases,
    failedCases,
    totalCases,
    caseScores,
  }));
}

/**
 * 构造运行结果：所有用例得分分散（产生高方差）
 */
function makeHighVarianceRuns(
  count: number,
  passRate: number,
  totalCases: number = 10,
): EvaluationRunResult[] {
  const passedCases = Math.round(passRate * totalCases);
  const failedCases = totalCases - passedCases;
  // 一半 1.0 一半 0.0，方差 = 0.25
  const caseScores = Array.from({ length: totalCases }, (_, i) => (i < totalCases / 2 ? 1.0 : 0.0));
  return Array.from({ length: count }, (_, i) => makeRun({
    runId: `run-${i + 1}`,
    passedCases,
    failedCases,
    totalCases,
    caseScores,
  }));
}

// ============================================================
// 默认配置（与 schema.ts 中的默认值一致）
// ============================================================

const DEFAULT_CONFIG = {
  passRateThreshold: 0.95,
  varianceThreshold: 0.05,
  checkInterval: 10,
};

// ============================================================
// 测试套件
// ============================================================

describe('SaturationMonitor (Phase 52 Task 7)', () => {
  // ============================================================
  // 测试 1：通过率 > 95% 且方差 < 0.05 时标记为 saturated
  // ============================================================
  it('1. 通过率 > 95% 且方差 < 0.05 时应标记为 saturated', () => {
    const monitor = new SaturationMonitor();

    // 10 次运行，每次 100% 通过，所有用例得分都是 1.0（方差 = 0）
    const runs = makeRuns(10, 1.0, 1.0);
    const report = monitor.evaluate(runs, DEFAULT_CONFIG);

    expect(report.status).toBe('saturated');
    expect(report.passRate).toBeGreaterThan(0.95);
    expect(report.scoreVariance).toBeLessThan(0.05);
    expect(report.recommendation).toBe('replace_evaluation');
    expect(report.analyzedRuns).toBe(10);
  });

  // ============================================================
  // 测试 2：区分度正确计算（通过率高+方差低 → discrimination 低）
  // ============================================================
  it('2. 区分度正确计算（通过率高+方差低 → discrimination 低）', () => {
    const monitor = new SaturationMonitor();

    // 高通过率 + 低方差 → 低区分度（接近饱和）
    const saturatedRuns = makeRuns(10, 1.0, 1.0);
    const saturatedReport = monitor.evaluate(saturatedRuns, DEFAULT_CONFIG);

    // discrimination = clamp(1 - 1.0 + 0 * 10, 0, 1) = 0
    expect(saturatedReport.discrimination).toBe(0);
    expect(saturatedReport.discrimination).toBeLessThanOrEqual(0.1);

    // 低通过率 + 高方差 → 高区分度（健康）
    // 通过率 50%，方差 0.25（一半 1.0 一半 0.0）
    const healthyRuns = makeHighVarianceRuns(10, 0.5);
    const healthyReport = monitor.evaluate(healthyRuns, DEFAULT_CONFIG);

    // discrimination = clamp(1 - 0.5 + 0.25 * 10, 0, 1) = clamp(3.0, 0, 1) = 1.0
    expect(healthyReport.discrimination).toBe(1.0);
    expect(healthyReport.discrimination).toBeGreaterThan(saturatedReport.discrimination);
    expect(healthyReport.status).toBe('healthy');
  });

  // ============================================================
  // 测试 3：建议新增困难用例类型合理（saturated 时返回非空数组）
  // ============================================================
  it('3. saturated 时建议新增困难用例类型合理（返回非空数组）', () => {
    const monitor = new SaturationMonitor();

    // 构造 saturated 报告
    const runs = makeRuns(10, 1.0, 1.0);
    const report = monitor.evaluate(runs, DEFAULT_CONFIG);
    expect(report.status).toBe('saturated');

    const suggestions = monitor.suggestDifficultCases(report);

    // 应返回非空数组
    expect(suggestions.length).toBeGreaterThan(0);
    // 应包含常见困难用例类型
    expect(suggestions.some(s => s.includes('多步推理'))).toBe(true);
    expect(suggestions.some(s => s.includes('工具组合'))).toBe(true);
    expect(suggestions.some(s => s.includes('长上下文'))).toBe(true);
    expect(suggestions.some(s => s.includes('错误恢复'))).toBe(true);
  });

  // ============================================================
  // 测试 4：建议淘汰过简用例合理（aging + 低方差时返回非空数组）
  // ============================================================
  it('4. aging + 低方差时建议淘汰过简用例合理（返回非空数组）', () => {
    const monitor = new SaturationMonitor();

    // 构造 aging + 低方差场景：
    // passRate > 0.8 且 < 0.95（不是 saturated），scoreVariance < 0.1 且 < 0.05
    // 需满足：passRate > 0.8, scoreVariance < 0.1 → aging
    //         passRate <= 0.9, scoreVariance < 0.05 → retire_easy_cases
    //
    // 陷阱 #192：makeRuns(count, passRate, score, totalCases=10) 时
    // passedCases = round(0.85 * 10) = 9，单 run passRate = 0.9（不是 0.85），
    // 浮点精度会让 0.9 变成 0.9000000000000001，触发 add_difficult_cases 分支
    // 修复：用 totalCases=100，passedCases=85，passRate=0.85（精确）
    const runs = makeRuns(10, 0.85, 0.9, 100);
    const report = monitor.evaluate(runs, DEFAULT_CONFIG);

    // 验证状态判定
    expect(report.status).toBe('aging');
    expect(report.passRate).toBeGreaterThan(0.8);
    expect(report.passRate).toBeLessThanOrEqual(0.9);
    expect(report.scoreVariance).toBeLessThan(0.05);
    expect(report.recommendation).toBe('retire_easy_cases');

    const retireSuggestions = monitor.suggestRetireEasyCases(report);

    // 应返回非空数组
    expect(retireSuggestions.length).toBeGreaterThan(0);
    // 应包含常见过简用例类型
    expect(retireSuggestions.some(s => s.includes('单工具调用'))).toBe(true);
    expect(retireSuggestions.some(s => s.includes('短上下文'))).toBe(true);
    expect(retireSuggestions.some(s => s.includes('无分支'))).toBe(true);
  });

  // ============================================================
  // 测试 5：运行结果数 < checkInterval 时返回 healthy
  // ============================================================
  it('5. 运行结果数 < checkInterval 时返回 healthy', () => {
    const monitor = new SaturationMonitor();

    // 仅 5 次运行，但 checkInterval = 10
    const runs = makeRuns(5, 1.0, 1.0);
    const report = monitor.evaluate(runs, DEFAULT_CONFIG);

    expect(report.status).toBe('healthy');
    expect(report.recommendation).toBe('none');
    expect(report.analyzedRuns).toBe(5);
    // 不足时 discrimination 默认为 1（健康）
    expect(report.discrimination).toBe(1);
  });

  // ============================================================
  // 测试 6：healthy 状态下不返回困难用例建议
  // ============================================================
  it('6. healthy 状态下不返回困难用例建议', () => {
    const monitor = new SaturationMonitor();

    // 低通过率 + 高方差 → healthy
    const runs = makeHighVarianceRuns(10, 0.5);
    const report = monitor.evaluate(runs, DEFAULT_CONFIG);
    expect(report.status).toBe('healthy');

    // healthy 时不返回困难用例建议
    expect(monitor.suggestDifficultCases(report)).toEqual([]);
    // healthy 时不返回淘汰建议
    expect(monitor.suggestRetireEasyCases(report)).toEqual([]);
  });

  // ============================================================
  // 测试 7：saturated 时 recommendation 为 replace_evaluation
  // ============================================================
  it('7. saturated 时 recommendation 为 replace_evaluation', () => {
    const monitor = new SaturationMonitor();

    const runs = makeRuns(10, 1.0, 1.0);
    const report = monitor.evaluate(runs, DEFAULT_CONFIG);

    expect(report.status).toBe('saturated');
    expect(report.recommendation).toBe('replace_evaluation');
  });

  // ============================================================
  // 测试 8：saturationFactors 包含导致饱和的具体因素描述
  // ============================================================
  it('8. saturationFactors 包含导致饱和的具体因素描述', () => {
    const monitor = new SaturationMonitor();

    const runs = makeRuns(10, 1.0, 1.0);
    const report = monitor.evaluate(runs, DEFAULT_CONFIG);

    expect(report.status).toBe('saturated');
    expect(report.saturationFactors.length).toBeGreaterThan(0);

    // 应包含通过率因素（提到"通过率"）
    expect(report.saturationFactors.some(f => f.includes('通过率'))).toBe(true);
    // 应包含方差因素（提到"方差"）
    expect(report.saturationFactors.some(f => f.includes('方差'))).toBe(true);
    // 应包含综合判定因素（提到"饱和"）
    expect(report.saturationFactors.some(f => f.includes('饱和'))).toBe(true);
  });

  // ============================================================
  // 测试 9：aging + passRate > 0.9 时返回 add_difficult_cases
  // ============================================================
  it('9. aging + passRate > 0.9 时 recommendation 为 add_difficult_cases', () => {
    const monitor = new SaturationMonitor();

    // passRate = 0.92, 方差 = 0（< 0.05 但 passRate > 0.9 → add_difficult_cases 优先）
    // 但需保证 status=aging：passRate > 0.8 且方差 < 0.1 → aging
    // 注意：passRate = 0.92 < 0.95（passRateThreshold）→ 不是 saturated
    const runs = makeRuns(10, 0.92, 0.95);
    const report = monitor.evaluate(runs, DEFAULT_CONFIG);

    expect(report.status).toBe('aging');
    expect(report.passRate).toBeGreaterThan(0.9);
    expect(report.passRate).toBeLessThanOrEqual(0.95);
    expect(report.scoreVariance).toBeLessThan(0.05);
    expect(report.recommendation).toBe('add_difficult_cases');
  });
});
