// tests/skills/granularity-auditor.test.ts
import { describe, it, expect } from 'vitest';
import { DecompositionGranularityAuditor } from '../../src/skills/granularity-auditor.js';
import type { GranularityAuditConfig } from '../../src/skills/granularity-auditor.js';
import type { AtomicSubTask } from '../../src/skills/compositional-router.js';

function makeConfig(overrides: Partial<GranularityAuditConfig> = {}): GranularityAuditConfig {
  return { enabled: true, ...overrides };
}

function makeSub(id: string, desc: string, cat: string): AtomicSubTask {
  return { id, description: desc, expectedSkillCategory: cat };
}

describe('DecompositionGranularityAuditor', () => {
  it('配置关闭时返回空数组', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig({ enabled: false }));
    const issues = auditor.audit({
      query: 'review code',
      subTasks: [makeSub('t1', 'a', 'review'), makeSub('t2', 'b', 'test'), makeSub('t3', 'c', 'fix'), makeSub('t4', 'd', 'doc'), makeSub('t5', 'e', 'deploy')],
    });
    expect(issues).toHaveLength(0);
  });

  it('短查询：步数在 [1,2] 区间内不报 over/under_decomposed', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const issues = auditor.audit({
      query: 'review code',
      subTasks: [makeSub('t1', 'review code quality', 'review')],
    });
    const stepIssues = issues.filter((i) => i.type === 'over_decomposed' || i.type === 'under_decomposed');
    expect(stepIssues).toHaveLength(0);
  });

  it('长查询步数区间启发式：>120 token 返回 [4,8]', () => {
    const longQuery = Array(130).fill('word').join(' ');
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const subs = Array.from({ length: 5 }, (_, i) => makeSub(`t${i}`, `task ${i}`, 'review'));
    const issues = auditor.audit({ query: longQuery, subTasks: subs });
    const stepIssues = issues.filter((i) => i.type === 'over_decomposed' || i.type === 'under_decomposed');
    expect(stepIssues).toHaveLength(0);
  });

  it('过度分解：步数 >> max 报 over_decomposed', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const subs = Array.from({ length: 10 }, (_, i) => makeSub(`t${i}`, `task ${i}`, 'review'));
    const issues = auditor.audit({ query: 'review code', subTasks: subs });
    expect(issues.some((i) => i.type === 'over_decomposed')).toBe(true);
  });

  it('严重过度分解（>max*1.5）报 critical', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const subs = Array.from({ length: 20 }, (_, i) => makeSub(`t${i}`, `task ${i}`, 'review'));
    const issues = auditor.audit({ query: 'review code', subTasks: subs });
    const critical = issues.filter((i) => i.type === 'over_decomposed' && i.severity === 'critical');
    expect(critical.length).toBeGreaterThan(0);
  });

  it('欠分解：步数 < min 报 under_decomposed', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const longQuery = Array(130).fill('word').join(' ');
    const issues = auditor.audit({
      query: longQuery,
      subTasks: [makeSub('t1', 'single task', 'review')],
    });
    expect(issues.some((i) => i.type === 'under_decomposed')).toBe(true);
  });

  it('粒度不一致：description 长度方差大报 inconsistent_granularity', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const subs = [
      makeSub('t1', 'a', 'review'),
      makeSub('t2', 'b'.repeat(300), 'test'),
    ];
    const issues = auditor.audit({ query: 'review and test', subTasks: subs });
    expect(issues.some((i) => i.type === 'inconsistent_granularity')).toBe(true);
  });

  it('missing_category：查询含"测试"但子任务无 test 类别', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const issues = auditor.audit({
      query: '对代码进行测试和审查',
      subTasks: [makeSub('t1', 'review code', 'review')],
    });
    expect(issues.some((i) => i.type === 'missing_category')).toBe(true);
  });

  it('computeDA 类别完全召回返回 da=1', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const predicted = [makeSub('t1', 'review', 'review'), makeSub('t2', 'test', 'test')];
    const result = auditor.computeDA(predicted, ['review', 'test']);
    expect(result.da).toBeCloseTo(1.0);
  });

  it('computeDA 类别部分召回返回正确比率', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const predicted = [makeSub('t1', 'review', 'review')];
    const result = auditor.computeDA(predicted, ['review', 'test']);
    expect(result.da).toBeCloseTo(0.5);
  });

  it('computeDA overDecomposed 判定：步数 > ground truth * 1.5', () => {
    const auditor = new DecompositionGranularityAuditor(makeConfig());
    const predicted = Array.from({ length: 8 }, (_, i) => makeSub(`t${i}`, `task ${i}`, 'review'));
    const result = auditor.computeDA(predicted, ['review', 'test']);
    expect(result.overDecomposed).toBe(true);
  });
});
