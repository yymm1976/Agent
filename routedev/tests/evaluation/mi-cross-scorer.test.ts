// tests/evaluation/mi-cross-scorer.test.ts
// Phase 67 Task 1：MI 代理评分器单元测试
//
// 覆盖蓝图 Task 1 测试要求：
//   1. Retrieval-Acc 全部正确→1.0
//   2. 坍缩场景（全部错误→接近 1/P）
//   3. randomBaseline=1/P
//   4. z-score 归一化增量更新
//   5. EMA 平滑（α=0.9）
//   6. collapseWarning 触发条件
//   7. P < minPrompts 返回占位快照
//   8. 配置关闭时跳过

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MICrossScorer,
  type ReasoningScore,
  DEFAULT_MI_CROSS_SCORER_CONFIG,
} from '../../src/evaluation/mi-cross-scorer.js';

// ============================================================
// 辅助函数
// ============================================================

/**
 * 构造 ReasoningScore 列表
 *
 * @param accs retrievalAcc 值数组
 */
function makeScores(accs: number[]): ReasoningScore[] {
  return accs.map((acc, i) => ({
    promptId: `prompt-${i + 1}`,
    retrievalAcc: acc,
    randomBaseline: 1 / accs.length,
  }));
}

// ============================================================
// 测试套件
// ============================================================

describe('MICrossScorer (Phase 67 Task 1)', () => {
  let scorer: MICrossScorer;

  beforeEach(() => {
    // 每个测试前创建全新实例，避免 Welford 状态污染
    scorer = new MICrossScorer({
      enabled: true,
      collapseThreshold: 1.5,
      minPrompts: 2,
      samplesPerPrompt: 4,
    });
  });

  // ============================================================
  // 测试 1：Retrieval-Acc 全部正确→1.0
  // ============================================================
  it('1. Retrieval-Acc 全部正确时 avgRetrievalAcc 应为 1.0', () => {
    const scores = makeScores([1.0, 1.0, 1.0, 1.0]);
    const snapshot = scorer.computeMIProxy(scores);

    expect(snapshot.avgRetrievalAcc).toBe(1.0);
    expect(snapshot.prompts).toBe(4);
    // 全部正确时坍缩告警不应触发
    expect(snapshot.collapseWarning).toBe(false);
  });

  // ============================================================
  // 测试 2：坍缩场景（全部错误→接近 1/P）
  // ============================================================
  it('2. 坍缩场景：retrievalAcc 接近 1/P 时应触发 collapseWarning', () => {
    // P=2, randomBaseline=0.5，retrievalAcc 在 0.5 附近随机摆动
    // 平均 retrievalAcc = 0.5 = randomBaseline，miZScore ≈ 0
    const scores = makeScores([0.4, 0.6]);
    const snapshot = scorer.computeMIProxy(scores);

    // 平均检索精度接近 randomBaseline（无信号）
    expect(snapshot.avgRetrievalAcc).toBeCloseTo(0.5, 5);
    expect(snapshot.randomBaseline).toBeCloseTo(0.5, 5);
    // miZScore 接近 0（无信号）
    expect(Math.abs(snapshot.miZScore)).toBeLessThan(0.001);
    // 触发坍缩告警
    expect(snapshot.collapseWarning).toBe(true);
  });

  // ============================================================
  // 测试 3：randomBaseline=1/P
  // ============================================================
  it('3. randomBaseline 应等于 1/P', () => {
    // P=2
    const scoresP2 = makeScores([0.8, 0.6]);
    const snapshotP2 = scorer.computeMIProxy(scoresP2);
    expect(snapshotP2.randomBaseline).toBeCloseTo(1 / 2, 5);

    // P=5
    const scorerP5 = new MICrossScorer({
      enabled: true,
      collapseThreshold: 1.5,
      minPrompts: 2,
      samplesPerPrompt: 4,
    });
    const scoresP5 = makeScores([0.9, 0.8, 0.7, 0.6, 0.5]);
    const snapshotP5 = scorerP5.computeMIProxy(scoresP5);
    expect(snapshotP5.randomBaseline).toBeCloseTo(1 / 5, 5);

    // P=10
    const scorerP10 = new MICrossScorer({
      enabled: true,
      collapseThreshold: 1.5,
      minPrompts: 2,
      samplesPerPrompt: 4,
    });
    const scoresP10 = makeScores([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05]);
    const snapshotP10 = scorerP10.computeMIProxy(scoresP10);
    expect(snapshotP10.randomBaseline).toBeCloseTo(1 / 10, 5);
  });

  // ============================================================
  // 测试 4：z-score 归一化增量更新
  // ============================================================
  it('4. zScoreNormalize 应通过 Welford 算法增量更新标准差', () => {
    // 第一次调用：[1.0, 2.0, 3.0, 4.0, 5.0]
    // 期望均值=3，方差=2（总体方差 ÷N），标准差=sqrt(2)≈1.414
    const std1 = scorer.zScoreNormalize([1.0, 2.0, 3.0, 4.0, 5.0]);
    expect(std1).toBeCloseTo(Math.sqrt(2), 5);

    // 第二次调用：增量更新（追加 [6.0]）
    // 累积数据集：[1,2,3,4,5,6]，均值=3.5
    // sum((xi-3.5)^2) = 6.25+2.25+0.25+0.25+2.25+6.25 = 17.5
    // 总体方差 = 17.5/6 ≈ 2.9167，标准差≈1.7078
    const std2 = scorer.zScoreNormalize([6.0]);
    expect(std2).toBeCloseTo(Math.sqrt(17.5 / 6), 5);
    // 累积统计量大于单批次统计量
    expect(std2).toBeGreaterThan(std1);
  });

  // ============================================================
  // 测试 5：EMA 平滑（α=0.9）
  // ============================================================
  it('5. emaSmooth 应按 α=0.9 公式平滑', () => {
    // 公式：ema = 0.9 * current + 0.1 * previous
    expect(scorer.emaSmooth(1.0, 0.0, 0.9)).toBeCloseTo(0.9, 5);
    expect(scorer.emaSmooth(0.5, 0.5, 0.9)).toBeCloseTo(0.5, 5);
    expect(scorer.emaSmooth(2.0, 1.0, 0.9)).toBeCloseTo(1.9, 5);
    // α=0.9 时新值占主导
    expect(scorer.emaSmooth(10.0, 1.0, 0.9)).toBeCloseTo(9.1, 5);
  });

  // ============================================================
  // 测试 6：collapseWarning 触发条件
  // ============================================================
  it('6. collapseWarning 应在 miZScoreEma < collapseThreshold 时触发', () => {
    // 场景 A：高质量推理，retrievalAcc 远高于 randomBaseline
    const goodScores = makeScores([0.9, 0.95, 0.92, 0.88]);
    const goodSnapshot = scorer.computeMIProxy(goodScores);
    expect(goodSnapshot.miZScoreEma).toBeGreaterThan(0);
    // 高质量推理不应触发坍缩
    expect(goodSnapshot.collapseWarning).toBe(false);

    // 场景 B：低质量推理，retrievalAcc 接近 randomBaseline
    const scorerBad = new MICrossScorer({
      enabled: true,
      collapseThreshold: 1.5,
      minPrompts: 2,
      samplesPerPrompt: 4,
    });
    const badScores = makeScores([0.51, 0.49]);
    const badSnapshot = scorerBad.computeMIProxy(badScores);
    // miZScoreEma 接近 0，低于阈值 1.5
    expect(badSnapshot.miZScoreEma).toBeLessThan(1.5);
    expect(badSnapshot.collapseWarning).toBe(true);
  });

  // ============================================================
  // 测试 7：P < minPrompts 返回占位快照
  // ============================================================
  it('7. P < minPrompts 时应返回占位快照（collapseWarning=false）', () => {
    // minPrompts=2，仅 1 个 prompt
    const scores = makeScores([0.9]);
    const snapshot = scorer.computeMIProxy(scores);

    expect(snapshot.prompts).toBe(1);
    expect(snapshot.avgRetrievalAcc).toBe(0);
    expect(snapshot.randomBaseline).toBeCloseTo(1.0, 5); // 1/1
    expect(snapshot.miZScore).toBe(0);
    expect(snapshot.miZScoreEma).toBe(0);
    expect(snapshot.collapseWarning).toBe(false);
  });

  // ============================================================
  // 测试 8：配置关闭时跳过
  // ============================================================
  it('8. 配置关闭时应返回占位快照', () => {
    const disabledScorer = new MICrossScorer({
      ...DEFAULT_MI_CROSS_SCORER_CONFIG,
      enabled: false,
    });
    const scores = makeScores([0.9, 0.8, 0.7]);
    const snapshot = disabledScorer.computeMIProxy(scores);

    // 关闭时返回零值占位快照
    expect(snapshot.prompts).toBe(0);
    expect(snapshot.avgRetrievalAcc).toBe(0);
    expect(snapshot.miZScore).toBe(0);
    expect(snapshot.miZScoreEma).toBe(0);
    expect(snapshot.collapseWarning).toBe(false);
  });

  // ============================================================
  // 额外测试 9：estimateConditionalEntropy 正确性
  // ============================================================
  it('9. estimateConditionalEntropy 应正确计算 -Σ p(xi) log2 p(xi)', () => {
    // 均匀分布 [0.25, 0.25, 0.25, 0.25]：熵 = log2(4) = 2
    const uniform = scorer.estimateConditionalEntropy([0.25, 0.25, 0.25, 0.25]);
    expect(uniform).toBeCloseTo(2.0, 5);

    // 确定性分布 [1, 0, 0, 0]：熵 = 0
    const deterministic = scorer.estimateConditionalEntropy([1, 0, 0, 0]);
    expect(deterministic).toBeCloseTo(0, 5);

    // 空数组：熵 = 0
    expect(scorer.estimateConditionalEntropy([])).toBe(0);
  });

  // ============================================================
  // 额外测试 10：argmax 正确性
  // ============================================================
  it('10. argmax 应返回最大值的索引', () => {
    expect(scorer.argmax([0.1, 0.5, 0.9, 0.3])).toBe(2);
    expect(scorer.argmax([0.9, 0.1, 0.5])).toBe(0);
    expect(scorer.argmax([])).toBe(-1);
    expect(scorer.argmax([0.5])).toBe(0);
  });

  // ============================================================
  // 额外测试 11：reset 应清空内部状态
  // ============================================================
  it('11. reset 应清空 Welford 统计量和 EMA 状态', () => {
    // 先累积一些数据
    scorer.zScoreNormalize([1.0, 2.0, 3.0]);
    expect(scorer.zScoreNormalize([])).toBeGreaterThan(0); // 累积统计量非零

    scorer.reset();

    // 重置后再次调用 zScoreNormalize 应仅包含新数据
    const stdAfterReset = scorer.zScoreNormalize([1.0, 1.0, 1.0]);
    expect(stdAfterReset).toBe(0); // 全相同值 → stdDev=0
  });
});
