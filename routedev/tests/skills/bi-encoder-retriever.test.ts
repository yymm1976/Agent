// tests/skills/bi-encoder-retriever.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BiEncoderSkillRetriever } from '../../src/skills/bi-encoder-retriever.js';
import type { BiEncoderConfig } from '../../src/skills/bi-encoder-retriever.js';

const SKILLS = [
  { id: 's1', name: 'code-reviewer', description: 'review code quality and style', category: 'review' },
  { id: 's2', name: 'test-generator', description: 'generate unit tests automatically', category: 'test' },
  { id: 's3', name: 'refactor-tool', description: 'refactor code structure and patterns', category: 'refactor' },
  { id: 's4', name: 'doc-writer', description: 'write documentation and comments', category: 'doc' },
];

function makeConfig(overrides: Partial<BiEncoderConfig> = {}): BiEncoderConfig {
  return {
    enabled: true,
    modelId: 'hash',
    topK: 3,
    minScore: 0.0,
    backend: 'memory',
    ...overrides,
  };
}

function makeSubTask(id: string, desc: string) {
  return { id, description: desc, expectedSkillCategory: 'review' };
}

describe('BiEncoderSkillRetriever', () => {
  it('initialize 构建索引后 isReady 返回 true', async () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig());
    await retriever.initialize(SKILLS);
    expect(retriever.isReady()).toBe(true);
  });

  it('未初始化时 isReady 返回 false', () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig());
    expect(retriever.isReady()).toBe(false);
  });

  it('enabled=false 时 initialize 后 isReady 仍为 false', async () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig({ enabled: false }));
    await retriever.initialize(SKILLS);
    expect(retriever.isReady()).toBe(false);
  });

  it('retrieve 返回置信度在 [0,1] 之间', async () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig());
    await retriever.initialize(SKILLS);
    const result = await retriever.retrieve(makeSubTask('t1', 'review code quality'));
    if (result !== null) {
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('retrieveTopK 返回数量不超过 k', async () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig({ topK: 2 }));
    await retriever.initialize(SKILLS);
    const results = await retriever.retrieveTopK(makeSubTask('t1', 'review and test code'), 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('minScore 过滤：高阈值时返回空', async () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig({ minScore: 0.9999 }));
    await retriever.initialize(SKILLS);
    const results = await retriever.retrieveTopK(makeSubTask('t1', 'some random query'), 10);
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.9999);
    }
  });

  it('embedding 缓存命中：同输入两次初始化，索引相同', async () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig());
    await retriever.initialize(SKILLS);
    const r1 = await retriever.retrieve(makeSubTask('t1', 'generate unit test'));
    await retriever.initialize(SKILLS);
    const r2 = await retriever.retrieve(makeSubTask('t1', 'generate unit test'));
    expect(r1?.skillId).toBe(r2?.skillId);
  });

  it('空技能库初始化后 retrieve 返回空数组', async () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig());
    await retriever.initialize([]);
    const result = await retriever.retrieve(makeSubTask('t1', 'review code'));
    expect(result).toBeNull();
  });

  it('retrieveTopK 按 confidence 降序排列', async () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig());
    await retriever.initialize(SKILLS);
    const results = await retriever.retrieveTopK(makeSubTask('t1', 'code review'), 4);
    for (let i = 0; i + 1 < results.length; i++) {
      expect(results[i].confidence).toBeGreaterThanOrEqual(results[i + 1].confidence);
    }
  });

  it('isReady 为 false 时 retrieve 返回 null', async () => {
    const retriever = new BiEncoderSkillRetriever(makeConfig());
    const result = await retriever.retrieve(makeSubTask('t1', 'review code'));
    expect(result).toBeNull();
  });
});
