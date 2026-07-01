// tests/evaluation/process-defect-ontology.test.ts
// Phase 52 Task 2 单元测试：过程级缺陷评估——缺陷本体与校准风险评分卡
//
// 覆盖：
//   1. classifyDefect 10 类缺陷正确分类
//   2. calibrateRisk 考虑频率和影响
//   3. computeControlPreservation 正确计算
//   4. computeProcessGrade A-F 分级映射
//   5. buildCalibratedScorecard 整合所有字段
//   6. sensitivity=high 时检测更多缺陷（对比 medium）
//
// 全部使用纯函数调用，无外部依赖。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyDefect,
  calibrateRisk,
  computeControlPreservation,
  computeProcessGrade,
  buildCalibratedScorecard,
  type ProcessDefect,
  type DefectCategory,
  type DefectDetectionConfig,
} from '../../src/evaluation/process-defect-ontology.js';

// ============================================================
// 测试辅助
// ============================================================

const MEDIUM_CONFIG: DefectDetectionConfig = {
  sensitivity: 'medium',
  controlPreservationThreshold: 0.7,
};

const HIGH_CONFIG: DefectDetectionConfig = {
  sensitivity: 'high',
  controlPreservationThreshold: 0.7,
};

const LOW_CONFIG: DefectDetectionConfig = {
  sensitivity: 'low',
  controlPreservationThreshold: 0.7,
};

/** 构造一个 high severity 缺陷 */
function makeHighSeverityDefect(category: DefectCategory, stepIndex = 0): ProcessDefect {
  return {
    category,
    severity: 'high',
    calibratedRisk: 0,
    stepIndex,
    description: `defect-${category}`,
    evidence: 'evidence',
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 52 Task 2: process-defect-ontology 单元测试', () => {
  beforeEach(() => {
    // 纯函数无需重置 mock，留空保持一致性
  });

  // ----------------------------------------------------------
  // 1. classifyDefect 10 类缺陷正确分类
  // ----------------------------------------------------------

  it('1.1 classifyDefect 正确分类 10 类缺陷（每类一个 primary 关键词）', () => {
    // 每类对应一个 primary 关键词（参考 DEFECT_KEYWORDS）
    const cases: Array<{ category: DefectCategory; keyword: string }> = [
      { category: 'tool_misuse', keyword: 'wrong parameter' },
      { category: 'context_loss', keyword: 'forgotten' },
      { category: 'step_skip', keyword: 'skipped' },
      { category: 'infinite_loop', keyword: 'infinite loop' },
      { category: 'premature_termination', keyword: 'not finished' },
      { category: 'scope_creep', keyword: 'out of scope' },
      { category: 'recovery_failure', keyword: 'failed to recover' },
      { category: 'hallucination', keyword: 'does not exist' },
      { category: 'permission_violation', keyword: 'permission denied' },
      { category: 'resource_exhaustion', keyword: 'token limit' },
    ];

    for (const { category, keyword } of cases) {
      const defect = classifyDefect(
        { stepIndex: 1, error: keyword },
        MEDIUM_CONFIG,
      );
      expect(defect, `类别 ${category} 应被关键词 "${keyword}" 命中`).not.toBeNull();
      expect(defect!.category).toBe(category);
      expect(defect!.stepIndex).toBe(1);
      expect(defect!.description).toBeDefined();
      expect(defect!.evidence).toContain(keyword);
    }
  });

  it('1.2 classifyDefect 未匹配关键词时返回 null', () => {
    const defect = classifyDefect(
      { stepIndex: 0, error: 'everything is fine, no problem', output: 'normal output' },
      MEDIUM_CONFIG,
    );
    expect(defect).toBeNull();
  });

  it('1.3 classifyDefect sensitivity=low 时只查 error 字段，不查 output', () => {
    // "skipped" 是 step_skip 的 primary 关键词，但只出现在 output 中
    const defect = classifyDefect(
      { stepIndex: 2, error: '', output: 'step was skipped accidentally' },
      LOW_CONFIG,
    );
    // low 灵敏度只查 error 字段 → 不应命中
    expect(defect).toBeNull();
  });

  it('1.4 classifyDefect sensitivity=medium 时同时查 error 和 output 字段', () => {
    const defect = classifyDefect(
      { stepIndex: 2, error: '', output: 'step was skipped accidentally' },
      MEDIUM_CONFIG,
    );
    expect(defect).not.toBeNull();
    expect(defect!.category).toBe('step_skip');
  });

  it('1.5 classifyDefect 单条日志只匹配第一个命中的类别（按 DEFECT_CATEGORY_ORDER 顺序）', () => {
    // tool_misuse 排在 step_skip 之前 → 应分类为 tool_misuse
    const defect = classifyDefect(
      { stepIndex: 3, error: 'wrong parameter and step skipped' },
      MEDIUM_CONFIG,
    );
    expect(defect).not.toBeNull();
    expect(defect!.category).toBe('tool_misuse');
  });

  // ----------------------------------------------------------
  // 2. calibrateRisk 考虑频率和影响
  // ----------------------------------------------------------

  it('2.1 calibrateRisk 同类缺陷为空时返回 0', () => {
    const risk = calibrateRisk([], 'tool_misuse');
    expect(risk).toBe(0);
  });

  it('2.2 calibrateRisk high severity + 高频率 → 接近满分（0.6 ~ 1.0）', () => {
    // 出现 10 次 high severity 缺陷
    const defects: ProcessDefect[] = Array.from({ length: 10 }, (_, i) =>
      makeHighSeverityDefect('tool_misuse', i),
    );
    const risk = calibrateRisk(defects, 'tool_misuse');
    // high severity weight = 0.7；frequencyFactor = 1 - e^(-10/3) ≈ 0.964
    // risk = 0.7 * (0.6 + 0.4 * 0.964) ≈ 0.69
    expect(risk).toBeGreaterThan(0.6);
    expect(risk).toBeLessThanOrEqual(1.0);
  });

  it('2.3 calibrateRisk 频率越高风险越大（同 severity）', () => {
    const oneDefect = [makeHighSeverityDefect('hallucination')];
    const manyDefects = Array.from({ length: 10 }, (_, i) =>
      makeHighSeverityDefect('hallucination', i),
    );
    const riskLow = calibrateRisk(oneDefect, 'hallucination');
    const riskHigh = calibrateRisk(manyDefects, 'hallucination');
    expect(riskHigh).toBeGreaterThan(riskLow);
  });

  it('2.4 calibrateRisk 只考虑指定类别的缺陷（不同类别不影响）', () => {
    const defects: ProcessDefect[] = [
      makeHighSeverityDefect('tool_misuse'),
      makeHighSeverityDefect('hallucination'),
      makeHighSeverityDefect('hallucination'),
    ];
    // hallucination 有 2 个，tool_misuse 只有 1 个
    const riskHallucination = calibrateRisk(defects, 'hallucination');
    const riskToolMisuse = calibrateRisk(defects, 'tool_misuse');
    expect(riskHallucination).toBeGreaterThan(riskToolMisuse);
  });

  // ----------------------------------------------------------
  // 3. computeControlPreservation 正确计算
  // ----------------------------------------------------------

  it('3.1 computeControlPreservation 10步中9步保持 → 0.9', () => {
    // 10 步，1 个未恢复的缺陷（stepIndex=5）
    const defects: ProcessDefect[] = [
      { ...makeHighSeverityDefect('tool_misuse', 5), recoveredFrom: false },
    ];
    const cp = computeControlPreservation(10, defects);
    expect(cp).toBeCloseTo(0.9, 4);
  });

  it('3.2 computeControlPreservation 已恢复的缺陷不计入未恢复步骤', () => {
    // 10 步，1 个已恢复的缺陷
    const defects: ProcessDefect[] = [
      { ...makeHighSeverityDefect('tool_misuse', 5), recoveredFrom: true },
    ];
    const cp = computeControlPreservation(10, defects);
    expect(cp).toBe(1.0);
  });

  it('3.3 computeControlPreservation totalSteps<=0 时返回 1.0', () => {
    const cp = computeControlPreservation(0, []);
    expect(cp).toBe(1.0);
  });

  it('3.4 computeControlPreservation 多个缺陷同一步骤只算一次', () => {
    // 10 步，stepIndex=3 上有 3 个未恢复缺陷 → 应只算 1 步未恢复 → 0.9
    const defects: ProcessDefect[] = [
      makeHighSeverityDefect('tool_misuse', 3),
      makeHighSeverityDefect('step_skip', 3),
      makeHighSeverityDefect('hallucination', 3),
    ];
    const cp = computeControlPreservation(10, defects);
    expect(cp).toBeCloseTo(0.9, 4);
  });

  // ----------------------------------------------------------
  // 4. computeProcessGrade A-F 分级映射
  // ----------------------------------------------------------

  it('4.1 computeProcessGrade 通过且 overallRisk<0.1 → A', () => {
    expect(computeProcessGrade(true, 0.05, 1.0)).toBe('A');
  });

  it('4.2 computeProcessGrade 通过且 overallRisk<0.3 → B', () => {
    expect(computeProcessGrade(true, 0.2, 1.0)).toBe('B');
  });

  it('4.3 computeProcessGrade 未通过但 controlPreservation>0.7 → C', () => {
    expect(computeProcessGrade(false, 0.55, 0.85)).toBe('C');
  });

  it('4.4 computeProcessGrade overallRisk<0.5 → C（即使通过但风险偏高也降级）', () => {
    // 注：通过且 risk<0.1 → A；通过且 risk<0.3 → B；
    // 这里 risk=0.45（<0.5）但通过 → C? 看 C 的判定：
    //   (未通过 && cp>0.7) || overallRisk<0.5 → C
    // risk<0.5 满足条件 → C
    expect(computeProcessGrade(true, 0.45, 1.0)).toBe('C');
  });

  it('4.5 computeProcessGrade overallRisk<0.7 → D', () => {
    // 通过且 risk=0.6（不<0.5，不<0.3，不<0.1）→ 走 C 分支：
    //   (通过 && cp>0.7? 但 cp=1.0 但通过不在 C 条件)
    //   C 条件是 (!通过 && cp>0.7) || risk<0.5
    // risk=0.6 不满足 <0.5；通过 → 不满足 !通过
    // → D 分支：risk<0.7 → D
    expect(computeProcessGrade(true, 0.6, 1.0)).toBe('D');
  });

  it('4.6 computeProcessGrade overallRisk>=0.7 → F', () => {
    expect(computeProcessGrade(false, 0.85, 0.5)).toBe('F');
  });

  // ----------------------------------------------------------
  // 5. buildCalibratedScorecard 整合所有字段
  // ----------------------------------------------------------

  it('5.1 buildCalibratedScorecard 整合所有字段（缺陷/风险/控制/分级）', () => {
    // 含 tool_misuse + step_skip 缺陷的执行日志
    const log = [
      { stepIndex: 0, error: 'wrong parameter for tool X', output: '' },
      { stepIndex: 1, error: 'step skipped', output: '' },
      { stepIndex: 2, error: '', output: 'normal output' },
    ];
    const sc = buildCalibratedScorecard(log, /* outcomePassed */ false, MEDIUM_CONFIG);

    expect(sc.defects.length).toBe(2);
    expect(sc.outcomePassed).toBe(false);
    // overallRisk 取最高类别风险分
    expect(sc.overallRisk).toBeGreaterThan(0);
    expect(sc.overallRisk).toBeLessThanOrEqual(1);
    // 3 步，2 个未恢复步骤 → cp = 1 - 2/3 ≈ 0.3333
    expect(sc.controlPreservation).toBeCloseTo(1 - 2 / 3, 4);
    expect(sc.processGrade).toBeDefined();
    // 验证每条缺陷的 calibratedRisk 已被填充（非 0）
    for (const d of sc.defects) {
      expect(d.calibratedRisk).toBeGreaterThan(0);
    }
  });

  it('5.2 buildCalibratedScorecard 无缺陷时返回 overallRisk=0 且 processGrade=A', () => {
    const log = [
      { stepIndex: 0, error: '', output: 'all good' },
      { stepIndex: 1, error: '', output: 'still good' },
    ];
    const sc = buildCalibratedScorecard(log, /* outcomePassed */ true, MEDIUM_CONFIG);
    expect(sc.defects.length).toBe(0);
    expect(sc.overallRisk).toBe(0);
    expect(sc.controlPreservation).toBe(1.0);
    expect(sc.processGrade).toBe('A');
  });

  // ----------------------------------------------------------
  // 6. sensitivity=high 时检测更多缺陷（对比 medium）
  // ----------------------------------------------------------

  it('6.1 sensitivity=high 检测到 potential 关键词，medium 不检测', () => {
    // "argument error" 是 tool_misuse 的 potential 关键词（仅 high 检测）
    const defectMedium = classifyDefect(
      { stepIndex: 0, error: 'argument error in tool call' },
      MEDIUM_CONFIG,
    );
    const defectHigh = classifyDefect(
      { stepIndex: 0, error: 'argument error in tool call' },
      HIGH_CONFIG,
    );
    expect(defectMedium).toBeNull();
    expect(defectHigh).not.toBeNull();
    expect(defectHigh!.category).toBe('tool_misuse');
  });

  it('6.2 sensitivity=high 比 medium 检测出更多缺陷（buildCalibratedScorecard 对比）', () => {
    // 构造一个日志：包含 secondary（medium 检测）和 potential（仅 high 检测）关键词
    const log = [
      { stepIndex: 0, error: 'invalid parameter', output: '' }, // tool_misuse secondary
      { stepIndex: 1, error: 'bad argument', output: '' },       // tool_misuse potential
      { stepIndex: 2, error: 'denied', output: '' },              // permission_violation potential
    ];
    const scMedium = buildCalibratedScorecard(log, false, MEDIUM_CONFIG);
    const scHigh = buildCalibratedScorecard(log, false, HIGH_CONFIG);
    // high 应检测到全部 3 个；medium 只检测到 1 个（"invalid parameter"）
    expect(scHigh.defects.length).toBeGreaterThan(scMedium.defects.length);
    expect(scMedium.defects.length).toBe(1);
    expect(scHigh.defects.length).toBe(3);
  });
});
