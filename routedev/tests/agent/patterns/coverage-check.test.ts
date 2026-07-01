// tests/agent/patterns/coverage-check.test.ts
// Phase 49 Task 6.5：五大模式覆盖检查单元测试
//
// 覆盖蓝图 6.5 节测试要求：
//   1. 五大模式覆盖检查通过
//   2. 每个模式都有对应的 notes 说明（额外覆盖）
//   3. 报告结构正确（额外覆盖）

import { describe, it, expect } from 'vitest';
import { checkPatternCoverage } from '../../../src/agent/patterns/coverage-check.js';

// ============================================================
// 测试套件
// ============================================================

describe('checkPatternCoverage (Phase 49 Task 6.5)', () => {
  // ============================================================
  // 测试 1：五大模式覆盖检查通过
  // ============================================================
  // E11 更新：routing 模式已被舍弃（RoutingFunnel 移除，路由由 ModelRouter + ScenarioClassifier 承担）
  //          因此 patterns.routing 现为 false（理论上无用，已有上位替代）
  it('1. 五大模式覆盖检查（routing 已舍弃）', () => {
    const report = checkPatternCoverage();

    // 4 个仍存在的模式应为 true
    expect(report.patterns.promptChain).toBe(true);
    expect(report.patterns.parallel).toBe(true);
    expect(report.patterns.reflection).toBe(true);
    expect(report.patterns.guardrail).toBe(true);
    // routing 已舍弃（RoutingFunnel 移除，由 ModelRouter + ScenarioClassifier 替代）
    expect(report.patterns.routing).toBe(false);
  });

  // ============================================================
  // 测试 2：notes 包含每个模式的判定说明
  // ============================================================
  it('2. notes 包含五个模式各自的判定说明', () => {
    const report = checkPatternCoverage();

    // notes 应该有 5 条（每个模式一条）
    expect(report.notes).toHaveLength(5);

    // 每条 note 应该标注模式名
    const joined = report.notes.join('\n');
    expect(joined).toContain('[promptChain]');
    expect(joined).toContain('[routing]');
    expect(joined).toContain('[parallel]');
    expect(joined).toContain('[reflection]');
    expect(joined).toContain('[guardrail]');

    // E11 更新：routing note 使用 ℹ（信息性说明，非通过/失败），其他 4 模式应带 ✓
    expect(report.notes.every(n => n.includes('✓') || n.includes('ℹ'))).toBe(true);
  });

  // ============================================================
  // 测试 3：报告结构正确
  // ============================================================
  it('3. 报告结构包含 patterns 和 notes 两个字段', () => {
    const report = checkPatternCoverage();

    expect(report).toHaveProperty('patterns');
    expect(report).toHaveProperty('notes');

    // patterns 应该包含五个布尔字段
    expect(report.patterns).toHaveProperty('promptChain');
    expect(report.patterns).toHaveProperty('routing');
    expect(report.patterns).toHaveProperty('parallel');
    expect(report.patterns).toHaveProperty('reflection');
    expect(report.patterns).toHaveProperty('guardrail');

    // 所有字段应该是布尔型
    expect(typeof report.patterns.promptChain).toBe('boolean');
    expect(typeof report.patterns.routing).toBe('boolean');
    expect(typeof report.patterns.parallel).toBe('boolean');
    expect(typeof report.patterns.reflection).toBe('boolean');
    expect(typeof report.patterns.guardrail).toBe('boolean');

    // notes 应该是字符串数组
    expect(Array.isArray(report.notes)).toBe(true);
    expect(report.notes.every(n => typeof n === 'string')).toBe(true);
  });

  // ============================================================
  // 测试 4：notes 中标注具体文件路径（额外审计价值）
  // ============================================================
  it('4. notes 中标注各模式的实现文件路径', () => {
    const report = checkPatternCoverage();
    const joined = report.notes.join('\n');

    // 提示链：本 Phase 实现
    expect(joined).toContain('prompt-chain.ts');
    // E11 更新：routing-funnel.ts 已删除，路由由 ModelRouter + ScenarioClassifier 承担
    expect(joined).toContain('ModelRouter');
    expect(joined).toContain('ScenarioClassifier');
    // 并行：已有
    expect(joined).toContain('loop.ts');
    expect(joined).toContain('orchestrator.ts');
    // 反思：本 Phase + 已有
    expect(joined).toContain('dual-loop-orchestrator.ts');
    // 护栏：已有
    expect(joined).toContain('permission-engine.ts');
    expect(joined).toContain('loop-detection.ts');
  });

  // ============================================================
  // 测试 5：连续两次调用结果一致（幂等性）
  // ============================================================
  it('5. 连续两次调用结果一致', () => {
    const r1 = checkPatternCoverage();
    const r2 = checkPatternCoverage();

    expect(r1.patterns).toEqual(r2.patterns);
    expect(r1.notes).toEqual(r2.notes);
  });
});
