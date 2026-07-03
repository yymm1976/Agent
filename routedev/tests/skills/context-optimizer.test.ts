// tests/skills/context-optimizer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SkillContextOptimizer } from '../../src/skills/context-optimizer.js';
import type { SkillContextOptimizerConfig } from '../../src/skills/context-optimizer.js';
import type { BiEncoderSkillRetriever } from '../../src/skills/bi-encoder-retriever.js';
import type { AtomicSubTask } from '../../src/skills/compositional-router.js';

const FALLBACK_SKILLS = [
  { id: 's1', name: 'code-reviewer', description: 'review code quality', category: 'review' },
  { id: 's2', name: 'test-generator', description: 'generate unit tests', category: 'test' },
  { id: 's3', name: 'refactor-tool', description: 'refactor code', category: 'refactor' },
  { id: 's4', name: 'doc-writer', description: 'write documentation', category: 'doc' },
];

function makeSub(id: string, desc: string, cat: string): AtomicSubTask {
  return { id, description: desc, expectedSkillCategory: cat };
}

function makeConfig(overrides: Partial<SkillContextOptimizerConfig> = {}): SkillContextOptimizerConfig {
  return { enabled: true, perSubTaskTopK: 3, maxTotalSkills: 8, maxTokens: 1200, ...overrides };
}

function makeRetriever(ready: boolean, topKResults: Array<{ skillId: string; skillName: string; category: string; confidence: number }> = []): BiEncoderSkillRetriever {
  return {
    isReady: () => ready,
    retrieveTopK: vi.fn().mockResolvedValue(
      topKResults.map((r) => ({ subTaskId: 'x', ...r })),
    ),
    retrieve: vi.fn(),
    initialize: vi.fn(),
  } as unknown as BiEncoderSkillRetriever;
}

describe('SkillContextOptimizer', () => {
  it('enabled=false 时返回空结果', async () => {
    const retriever = makeRetriever(false);
    const optimizer = new SkillContextOptimizer(retriever, makeConfig({ enabled: false }));
    const result = await optimizer.buildContext([makeSub('t1', 'review', 'review')], FALLBACK_SKILLS);
    expect(result.skills).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('空子任务列表返回空', async () => {
    const retriever = makeRetriever(true);
    const optimizer = new SkillContextOptimizer(retriever, makeConfig());
    const result = await optimizer.buildContext([], FALLBACK_SKILLS);
    expect(result.skills).toHaveLength(0);
  });

  it('retriever 未就绪时按 category 降级过滤', async () => {
    const retriever = makeRetriever(false);
    const optimizer = new SkillContextOptimizer(retriever, makeConfig());
    const result = await optimizer.buildContext(
      [makeSub('t1', 'review code', 'review')],
      FALLBACK_SKILLS,
    );
    expect(result.skills.every((s) => s.category === 'review')).toBe(true);
    expect(result.skills.length).toBeGreaterThan(0);
  });

  it('多子任务去重：同一技能只注入一次', async () => {
    const retriever = makeRetriever(true, [
      { skillId: 's1', skillName: 'code-reviewer', category: 'review', confidence: 0.8 },
    ]);
    const optimizer = new SkillContextOptimizer(retriever, makeConfig());
    const result = await optimizer.buildContext([
      makeSub('t1', 'review code', 'review'),
      makeSub('t2', 'review style', 'review'),
    ]);
    const ids = result.skills.map((s) => s.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('maxTotalSkills 上限裁剪', async () => {
    const topKResults = Array.from({ length: 5 }, (_, i) => ({
      skillId: `s${i}`,
      skillName: `skill-${i}`,
      category: 'review',
      confidence: 0.8 - i * 0.05,
    }));
    const retriever = makeRetriever(true, topKResults);
    const optimizer = new SkillContextOptimizer(retriever, makeConfig({ maxTotalSkills: 3 }));
    const result = await optimizer.buildContext([makeSub('t1', 'review', 'review')]);
    expect(result.skills.length).toBeLessThanOrEqual(3);
  });

  it('token 预算超限时 truncated=true', async () => {
    const topKResults = Array.from({ length: 5 }, (_, i) => ({
      skillId: `s${i}`,
      skillName: `skill-${i}`,
      category: 'review',
      confidence: 0.8,
    }));
    const retriever = makeRetriever(true, topKResults);
    const optimizer = new SkillContextOptimizer(retriever, makeConfig({ maxTokens: 5 }));
    const result = await optimizer.buildContext([makeSub('t1', 'review', 'review')]);
    expect(result.truncated).toBe(true);
  });

  it('结果按 confidence 降序排列', async () => {
    const topKResults = [
      { skillId: 's1', skillName: 'low', category: 'a', confidence: 0.3 },
      { skillId: 's2', skillName: 'high', category: 'b', confidence: 0.9 },
    ];
    const retriever = makeRetriever(true, topKResults);
    const optimizer = new SkillContextOptimizer(retriever, makeConfig());
    const result = await optimizer.buildContext([makeSub('t1', 'task', 'a')]);
    for (let i = 0; i + 1 < result.skills.length; i++) {
      expect(result.skills[i].confidence).toBeGreaterThanOrEqual(result.skills[i + 1].confidence);
    }
  });
});
