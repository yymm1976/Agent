// tests/evaluation/evaluation-framework.test.ts
// Phase 49 Task 5.4：评估集框架单元测试
//
// 覆盖蓝图 5.4 节测试要求：
//   1. Smoke set 返回报告
//   2. Regression set 返回报告
//   3. 用例顺序被随机打乱（位置偏差防御）
//   4. 报告包含 Rubric 评分和通过/失败统计
//   5. 报告记录 modelVersion（陷阱 #149）
//   6. EVALUATION_SETS 配置正确（额外覆盖）
//   7. 依赖注入的 executeTarget 和 judge 被正确调用（额外覆盖）

import { describe, it, expect, vi } from 'vitest';
import {
  EvaluationFramework,
  EVALUATION_SETS,
  type EvaluationCase,
  type JudgeResult,
  type EvaluationReport,
} from '../../src/evaluation/evaluation-framework.js';

// ============================================================
// 辅助函数
// ============================================================

/** 构造一个标准评估用例 */
function makeCase(id: string, scenario: EvaluationCase['scenario'] = 'normal'): EvaluationCase {
  return {
    id,
    input: `输入-${id}`,
    expectedBehavior: `期望行为-${id}`,
    scenario,
    rubric: [
      { criterion: '正确性', weight: 0.5 },
      { criterion: '边界处理', weight: 0.3 },
      { criterion: '安全性', weight: 0.2 },
    ],
  };
}

/** 批量生成用例 */
function makeCases(count: number): EvaluationCase[] {
  return Array.from({ length: count }, (_, i) => makeCase(`case-${i + 1}`));
}

/** 构造通过的 Judge 结果（所有 Rubric 维度满分） */
function passJudge(testCase: EvaluationCase, reasoning: string = '通过'): JudgeResult {
  return {
    passed: true,
    score: 0.95,
    reasoning,
    rubricScores: testCase.rubric.map(r => ({
      criterion: r.criterion,
      weight: r.weight,
      score: 0.95,
    })),
  };
}

/** 构造不通过的 Judge 结果（所有 Rubric 维度低分） */
function failJudge(testCase: EvaluationCase, reasoning: string = '不通过'): JudgeResult {
  return {
    passed: false,
    score: 0.3,
    reasoning,
    rubricScores: testCase.rubric.map(r => ({
      criterion: r.criterion,
      weight: r.weight,
      score: 0.3,
    })),
  };
}

// ============================================================
// 测试套件
// ============================================================

describe('EvaluationFramework (Phase 49 Task 5.2)', () => {
  // ============================================================
  // 测试 1：Smoke set 运行返回报告
  // ============================================================
  it('1. Smoke set 运行返回报告', async () => {
    const cases = makeCases(EVALUATION_SETS.smoke.size);
    const executeTarget = vi.fn(async (input: string) => `输出-${input}`);
    const judge = vi.fn(async (tc: EvaluationCase) => passJudge(tc));

    const framework = new EvaluationFramework(executeTarget, judge, 'judge-model-v1.0');
    const report = await framework.runEvaluation(cases, 'skill', 'my-skill');

    // 报告基本字段
    expect(report.target).toBe('skill');
    expect(report.targetId).toBe('my-skill');
    expect(report.totalCases).toBe(EVALUATION_SETS.smoke.size);
    expect(report.passed).toBe(EVALUATION_SETS.smoke.size);
    expect(report.failed).toBe(0);

    // 每个用例都执行了一次 executeTarget 和 judge
    expect(executeTarget).toHaveBeenCalledTimes(EVALUATION_SETS.smoke.size);
    expect(judge).toHaveBeenCalledTimes(EVALUATION_SETS.smoke.size);
  });

  // ============================================================
  // 测试 2：Regression set 运行返回报告
  // ============================================================
  it('2. Regression set 运行返回报告', async () => {
    const cases = makeCases(EVALUATION_SETS.regression.size);
    const executeTarget = vi.fn(async (input: string) => `输出-${input}`);
    const judge = vi.fn(async (tc: EvaluationCase) => passJudge(tc));

    const framework = new EvaluationFramework(executeTarget, judge, 'judge-model-v2.0');
    const report = await framework.runEvaluation(cases, 'goal', 'goal-123');

    expect(report.target).toBe('goal');
    expect(report.targetId).toBe('goal-123');
    expect(report.totalCases).toBe(EVALUATION_SETS.regression.size);
    expect(report.passed).toBe(EVALUATION_SETS.regression.size);
    expect(report.failed).toBe(0);
    expect(report.results).toHaveLength(EVALUATION_SETS.regression.size);
  });

  // ============================================================
  // 测试 3：用例顺序被随机打乱（位置偏差防御）
  // ============================================================
  it('3. 用例顺序被随机打乱（执行顺序 ≠ 输入顺序）', async () => {
    // 用足够多的用例，确保打乱后顺序与原顺序不同的概率极高
    const cases = makeCases(20);
    const executedOrder: string[] = [];
    const executeTarget = vi.fn(async (input: string) => {
      // input 形如 "输入-case-5"，提取 caseId
      const match = input.match(/输入-(case-\d+)/);
      if (match) executedOrder.push(match[1]);
      return `输出-${input}`;
    });
    const judge = vi.fn(async (tc: EvaluationCase) => passJudge(tc));

    const framework = new EvaluationFramework(executeTarget, judge, 'judge-v1');
    await framework.runEvaluation(cases, 'skill', 'skill-x');

    const originalOrder = cases.map(c => c.id);
    // 至少有一半用例的执行位置发生变化（20 个用例，原顺序与打乱后顺序不应完全一致）
    let changed = 0;
    for (let i = 0; i < originalOrder.length; i++) {
      if (executedOrder[i] !== originalOrder[i]) changed++;
    }
    // 20 个用例随机打乱，至少应该有 1 个位置变化（实际几乎所有都变化）
    expect(changed).toBeGreaterThan(0);

    // 验证：执行顺序与原顺序不是完全相同（即发生了打乱）
    expect(executedOrder).not.toEqual(originalOrder);

    // 但所有用例都执行了（集合一致）
    expect(new Set(executedOrder)).toEqual(new Set(originalOrder));
  });

  // ============================================================
  // 测试 4：报告包含 Rubric 评分和通过/失败统计
  // ============================================================
  it('4. 报告包含 Rubric 评分和通过/失败统计', async () => {
    const cases = makeCases(5);
    const executeTarget = vi.fn(async (input: string) => `输出-${input}`);

    // 前 3 个用例通过，后 2 个不通过
    const judge = vi.fn(async (tc: EvaluationCase) => {
      const idx = parseInt(tc.id.replace('case-', ''), 10);
      return idx <= 3 ? passJudge(tc, `通过-${tc.id}`) : failJudge(tc, `不通过-${tc.id}`);
    });

    const framework = new EvaluationFramework(executeTarget, judge, 'judge-v1');
    const report = await framework.runEvaluation(cases, 'skill', 'skill-y');

    // 通过/失败统计
    expect(report.passed).toBe(3);
    expect(report.failed).toBe(2);
    expect(report.totalCases).toBe(5);

    // 每条结果都有 Rubric 评分明细
    for (const result of report.results) {
      expect(result.rubricScores).toBeDefined();
      expect(result.rubricScores.length).toBeGreaterThan(0);
      // 每个 Rubric 评分包含 criterion / weight / score
      for (const rs of result.rubricScores) {
        expect(rs.criterion).toBeTruthy();
        expect(rs.weight).toBeGreaterThan(0);
        expect(rs.score).toBeGreaterThanOrEqual(0);
        expect(rs.score).toBeLessThanOrEqual(1);
      }
    }

    // 全局聚合 Rubric 评分（按维度求平均）
    expect(report.rubricScores).toBeDefined();
    expect(report.rubricScores.length).toBe(3); // 正确性 / 边界处理 / 安全性
    const criterionNames = report.rubricScores.map(rs => rs.criterion);
    expect(criterionNames).toContain('正确性');
    expect(criterionNames).toContain('边界处理');
    expect(criterionNames).toContain('安全性');
  });

  // ============================================================
  // 测试 5：报告记录 modelVersion（陷阱 #149）
  // ============================================================
  it('5. 报告记录 modelVersion（陷阱 #149：模型升级后需重新校准 Rubric）', async () => {
    const cases = makeCases(3);
    const executeTarget = vi.fn(async (input: string) => `输出-${input}`);
    const judge = vi.fn(async (tc: EvaluationCase) => passJudge(tc));

    const modelVersion = 'claude-3.7-sonnet-20250101';
    const framework = new EvaluationFramework(executeTarget, judge, modelVersion);
    const report = await framework.runEvaluation(cases, 'skill', 'skill-z');

    expect(report.modelVersion).toBe(modelVersion);
    // getModelVersion 方法也能正确返回
    expect(framework.getModelVersion()).toBe(modelVersion);
    // 时间戳应为合法 ISO 字符串
    expect(report.timestamp).toBeTruthy();
    expect(() => new Date(report.timestamp).toISOString()).not.toThrow();
  });

  // ============================================================
  // 测试 6：EVALUATION_SETS 配置正确（RouteDev 缩小版）
  // ============================================================
  it('6. EVALUATION_SETS 配置正确（RouteDev 缩小版：Smoke 10 / Regression 30）', () => {
    // Smoke set
    expect(EVALUATION_SETS.smoke.size).toBe(10);
    expect(EVALUATION_SETS.smoke.trigger).toBe('skill-install');
    expect(EVALUATION_SETS.smoke.timeoutMs).toBe(120_000);

    // Regression set
    expect(EVALUATION_SETS.regression.size).toBe(30);
    expect(EVALUATION_SETS.regression.trigger).toBe('goal-complete');
    expect(EVALUATION_SETS.regression.timeoutMs).toBe(600_000);
  });

  // ============================================================
  // 测试 7：executeTarget 回调接收正确的参数
  // ============================================================
  it('7. executeTarget 和 judge 回调接收正确的参数', async () => {
    const cases = [makeCase('c1')];
    const executeTarget = vi.fn(async (_input: string) => 'mock-output');
    const judge = vi.fn(async (tc: EvaluationCase, actualOutput: string) => {
      // judge 回调应收到原始用例和 executeTarget 的输出
      expect(tc.id).toBe('c1');
      expect(actualOutput).toBe('mock-output');
      return passJudge(tc);
    });

    const framework = new EvaluationFramework(executeTarget, judge, 'v1');
    await framework.runEvaluation(cases, 'skill', 'my-skill');

    // executeTarget 应收到 input、target、targetId 三个参数
    expect(executeTarget).toHaveBeenCalledWith('输入-c1', 'skill', 'my-skill');
    // judge 应收到原始用例（包含 rubric）和实际输出
    expect(judge).toHaveBeenCalledTimes(1);
    const judgeCall = judge.mock.calls[0];
    expect(judgeCall[0].rubric).toBeDefined();
    expect(judgeCall[1]).toBe('mock-output');
  });
});
