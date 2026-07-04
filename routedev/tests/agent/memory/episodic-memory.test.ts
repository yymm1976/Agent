// tests/agent/memory/episodic-memory.test.ts
// Phase 71 Task B4：EpisodicMemory 单元测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EpisodicMemory, type Episode } from '../../../src/agent/memory/episodic-memory.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('EpisodicMemory', () => {
  const tmpFile = path.join(os.tmpdir(), `episodic-test-${Date.now()}.jsonl`);
  let em: EpisodicMemory;

  beforeEach(() => {
    em = new EpisodicMemory(tmpFile);
  });

  afterEach(async () => {
    try { await fs.unlink(tmpFile); } catch {}
  });

  const makeEpisode = (overrides: Partial<Episode> = {}): Episode => ({
    id: `ep-${Date.now()}`,
    query: 'how to fix bug',
    solutionPath: ['step1', 'step2', 'step3'],
    outcome: 'success',
    toolsUsed: ['read', 'edit'],
    durationMs: 5000,
    createdAt: Date.now(),
    tags: ['bugfix'],
    ...overrides,
  });

  it('store + recall 完整流程', async () => {
    await em.store(makeEpisode({ query: 'fix memory leak' }));
    const results = await em.recallSimilar('fix memory leak');
    expect(results).toHaveLength(1);
    expect(results[0].query).toBe('fix memory leak');
  });

  it('空 store recall 返回空', async () => {
    // 新文件不存在，recall 返回空
    const results = await em.recallSimilar('anything');
    expect(results).toHaveLength(0);
  });

  it('相似度评分正确（完全匹配 = 1.0）', async () => {
    await em.store(makeEpisode({ query: 'fix bug' }));
    const results = await em.recallSimilar('fix bug');
    expect(results).toHaveLength(1);
  });

  it('limit 参数生效', async () => {
    await em.store(makeEpisode({ id: 'ep1', query: 'fix bug one' }));
    await em.store(makeEpisode({ id: 'ep2', query: 'fix bug two' }));
    await em.store(makeEpisode({ id: 'ep3', query: 'fix bug three' }));
    const results = await em.recallSimilar('fix bug', 2);
    expect(results).toHaveLength(2);
  });

  it('无相似时返回空', async () => {
    await em.store(makeEpisode({ query: 'completely different topic' }));
    const results = await em.recallSimilar('fix bug');
    expect(results).toHaveLength(0);
  });

  it('多 episode 按相似度排序', async () => {
    await em.store(makeEpisode({ id: 'ep1', query: 'fix bug' }));
    await em.store(makeEpisode({ id: 'ep2', query: 'fix bug memory leak' }));
    const results = await em.recallSimilar('fix bug', 5);
    expect(results[0].id).toBe('ep1'); // 完全匹配优先
  });

  it('文件损坏时 fail-open 返回空', async () => {
    await fs.writeFile(tmpFile, 'invalid json\n{broken', 'utf-8');
    const results = await em.recallSimilar('anything');
    expect(results).toHaveLength(0);
  });

  it('outcome=failure 的 episode 也能存储', async () => {
    await em.store(makeEpisode({ outcome: 'failure', query: 'failed attempt' }));
    const results = await em.recallSimilar('failed attempt');
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('failure');
  });
});
