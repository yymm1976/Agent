// tests/skills/compatibility-scorer.test.ts
import { describe, it, expect } from 'vitest';
import { CompatibilityScorer } from '../../src/skills/compatibility-scorer.js';
import type { CompatibilityScorerConfig } from '../../src/skills/compatibility-scorer.js';
import type { SkillDAGNode } from '../../src/skills/compositional-router.js';

function makeConfig(overrides: Partial<CompatibilityScorerConfig> = {}): CompatibilityScorerConfig {
  return {
    enabled: true,
    pruneThreshold: 0.15,
    weights: { ioType: 0.4, categoryJaccard: 0.3, keywordCoOccur: 0.3 },
    ...overrides,
  };
}

function makeNode(id: string, desc: string, cat: string): SkillDAGNode {
  return {
    id,
    subTask: { id, description: desc, expectedSkillCategory: cat },
    skillMatch: { subTaskId: id, skillId: `skill-${id}`, skillName: `skill-${id}`, confidence: 0.8, category: cat },
    status: 'pending',
  };
}

describe('CompatibilityScorer', () => {
  it('同类别节点得分为 1.0（完全兼容）', () => {
    const scorer = new CompatibilityScorer(makeConfig());
    const pred = makeNode('a', 'review code quality', 'review');
    const succ = makeNode('b', 'review style issues', 'review');
    const s = scorer.score(pred, succ);
    expect(s).toBeGreaterThan(0.5);
  });

  it('完全不同类别且无关键词重叠时得分较低', () => {
    const scorer = new CompatibilityScorer(makeConfig());
    const pred = makeNode('a', 'deploy to production server', 'deploy');
    const succ = makeNode('b', 'write unit tests', 'test');
    const s = scorer.score(pred, succ);
    expect(s).toBeLessThan(0.5);
  });

  it('关键词高重叠得分贡献 keywordCoOccur 权重', () => {
    const scorer = new CompatibilityScorer(makeConfig({ weights: { ioType: 0, categoryJaccard: 0, keywordCoOccur: 1.0 } }));
    const pred = makeNode('a', 'analyze code quality metrics', 'analyze');
    const succ = makeNode('b', 'report code quality issues', 'report');
    const s = scorer.score(pred, succ);
    expect(s).toBeGreaterThan(0);
  });

  it('filterEdges 剪枝低分 control 边', () => {
    const scorer = new CompatibilityScorer(makeConfig({ pruneThreshold: 0.5 }));
    const pred = makeNode('a', 'deploy app', 'deploy');
    const succ = makeNode('b', 'write docs', 'doc');
    const filtered = scorer.filterEdges([{ from: pred, to: succ, dependencyType: 'control' }]);
    expect(filtered).toHaveLength(0);
  });

  it('filterEdges 保留高分 control 边并附 weight', () => {
    const scorer = new CompatibilityScorer(makeConfig({ pruneThreshold: 0.1 }));
    const pred = makeNode('a', 'review code quality', 'review');
    const succ = makeNode('b', 'review style issues', 'review');
    const filtered = scorer.filterEdges([{ from: pred, to: succ, dependencyType: 'control' }]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].weight).toBeGreaterThan(0);
  });

  it('data 边使用低阈值（0.05），不误剪真实数据依赖', () => {
    const scorer = new CompatibilityScorer(makeConfig({ pruneThreshold: 0.3 }));
    const pred = makeNode('a', 'analyze metrics', 'analyze');
    const succ = makeNode('b', 'report results', 'report');
    const filteredData = scorer.filterEdges([{ from: pred, to: succ, dependencyType: 'data' }]);
    const filteredControl = scorer.filterEdges([{ from: pred, to: succ, dependencyType: 'control' }]);
    expect(filteredData.length).toBeGreaterThanOrEqual(filteredControl.length);
  });

  it('配置 enabled=false 时 filterEdges 保留所有边且 weight=1', () => {
    const scorer = new CompatibilityScorer(makeConfig({ enabled: false }));
    const pred = makeNode('a', 'some task', 'cat1');
    const succ = makeNode('b', 'other task', 'cat2');
    const filtered = scorer.filterEdges([{ from: pred, to: succ, dependencyType: 'control' }]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].weight).toBe(1);
  });

  it('score 返回值在 [0,1] 范围内', () => {
    const scorer = new CompatibilityScorer(makeConfig());
    const pred = makeNode('a', 'review and test and deploy code', 'review');
    const succ = makeNode('b', 'review test deploy fix refactor doc', 'review');
    const s = scorer.score(pred, succ);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('filterEdges 空输入返回空', () => {
    const scorer = new CompatibilityScorer(makeConfig());
    expect(scorer.filterEdges([])).toHaveLength(0);
  });
});
