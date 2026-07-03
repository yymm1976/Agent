import { describe, it, expect } from 'vitest';
import { CuratedSet } from '../../src/agent/curated-set.js';
import type { CuratedSetConfig } from '../../src/agent/curated-set.js';

const MINI_CONFIG: CuratedSetConfig = {
  autoPopulateCount: 3,
  maxTokenBudget: 8000,
  importanceTaggingEnabled: true,
  subtractiveCurationEnabled: true,
};

describe('CuratedSet', () => {
  describe('add 与 autoPopulate', () => {
    it('首次添加达到 autoPopulateCount 时触发 autoPopulate', async () => {
      const cs = new CuratedSet({ ...MINI_CONFIG, autoPopulateCount: 3 });
      await cs.add('critical error in module', 'src/mod.ts');
      await cs.add('export function foo', 'src/foo.ts');
      await cs.add('debug log output', 'src/log.ts');
      const stats = cs.getStats();
      expect(stats.totalChunks).toBe(3);
      expect(stats.candidatePoolSize).toBe(3);
    });

    it('autoPopulate 按哈希去重（相同内容不重复加入策展集）', async () => {
      const cs = new CuratedSet({ ...MINI_CONFIG, autoPopulateCount: 2 });
      const c1 = await cs.add('duplicate content', 'a.ts');
      const c2 = await cs.add('duplicate content', 'b.ts');
      expect(c1.id).toBe(c2.id);
      const stats = cs.getStats();
      expect(stats.totalChunks).toBeLessThanOrEqual(2);
    });
  });

  describe('estimateImportance 三类标签启发式', () => {
    it('含 error/fail/throw → critical', () => {
      const cs = new CuratedSet(MINI_CONFIG);
      expect(cs.estimateImportance('TypeError: Cannot read property of undefined')).toBe('critical');
      expect(cs.estimateImportance('test failed on line 42')).toBe('critical');
      expect(cs.estimateImportance('必须修复此问题')).toBe('critical');
    });

    it('含代码/配置/import → useful', () => {
      const cs = new CuratedSet(MINI_CONFIG);
      expect(cs.estimateImportance('export function bar() {}')).toBe('useful');
      expect(cs.estimateImportance('```ts\ncode block\n```')).toBe('useful');
      expect(cs.estimateImportance('import { foo } from "./bar"')).toBe('useful');
    });

    it('含日志/debug 前缀 → obsolete', () => {
      const cs = new CuratedSet(MINI_CONFIG);
      expect(cs.estimateImportance('[debug] connection established')).toBe('obsolete');
      expect(cs.estimateImportance('info: request processed')).toBe('obsolete');
    });

    it('普通文本 → useful（默认）', () => {
      const cs = new CuratedSet(MINI_CONFIG);
      expect(cs.estimateImportance('这是一段普通说明文本')).toBe('useful');
    });
  });

  describe('prune 减法式策展', () => {
    it('prune 移除指定 chunk 并返回被移除的列表', async () => {
      const cs = new CuratedSet({ ...MINI_CONFIG, autoPopulateCount: 1 });
      const c = await cs.add('error in module', 'src/mod.ts');
      const statsBefore = cs.getStats();
      expect(statsBefore.totalChunks).toBeGreaterThanOrEqual(1);
      const removed = cs.prune([c.id]);
      expect(removed).toHaveLength(1);
      expect(removed[0].id).toBe(c.id);
      const statsAfter = cs.getStats();
      expect(statsAfter.totalChunks).toBeLessThan(statsBefore.totalChunks);
    });

    it('prune 不存在的 chunkId 不报错', () => {
      const cs = new CuratedSet(MINI_CONFIG);
      const removed = cs.prune(['nonexistent']);
      expect(removed).toHaveLength(0);
    });
  });

  describe('promote 提升重要性', () => {
    it('promote useful → critical', async () => {
      const cs = new CuratedSet({ ...MINI_CONFIG, autoPopulateCount: 1 });
      const c = await cs.add('export function helper', 'src/helper.ts');
      const result = cs.promote(c.id, 'critical');
      expect(result).toBe(true);
    });

    it('promote 不存在的 chunkId 返回 false', () => {
      const cs = new CuratedSet(MINI_CONFIG);
      expect(cs.promote('nonexistent', 'critical')).toBe(false);
    });
  });

  describe('renderToPrompt', () => {
    it('按 importance 排序（critical → useful → obsolete），按 tokenBudget 截断', async () => {
      const cs = new CuratedSet(MINI_CONFIG);
      await cs.add('throw new Error("critical")', 'src/err.ts');
      await cs.add('export function helper', 'src/helper.ts');
      await cs.add('[debug] log info', 'src/log.ts');
      const result = cs.renderToPrompt(10000);
      expect(result.prompt).toContain('## 关键信息（critical）');
      expect(result.prompt).toContain('## Policy 四问');
      expect(result.usedTokens).toBeGreaterThan(0);
      expect(result.renderedChunks.length).toBeGreaterThan(0);
    });

    it('tokenBudget 不足时截断部分 chunk', async () => {
      const cs = new CuratedSet(MINI_CONFIG);
      await cs.add('a'.repeat(5000), 'a.ts');
      await cs.add('b'.repeat(5000), 'b.ts');
      const result = cs.renderToPrompt(10);
      expect(result.renderedChunks.length).toBeLessThan(2);
    });

    it('renderToPrompt 注入 policy 四问', async () => {
      const cs = new CuratedSet(MINI_CONFIG);
      await cs.add('test content', 'test.ts');
      const result = cs.renderToPrompt(10000);
      expect(result.prompt).toContain('What do I know?');
      expect(result.prompt).toContain('What should I search for next?');
      expect(result.prompt).toContain('What should I prune?');
      expect(result.prompt).toContain('Do I have enough information?');
    });
  });

  describe('query', () => {
    it('按关键词过滤', async () => {
      const cs = new CuratedSet({ ...MINI_CONFIG, autoPopulateCount: 2 });
      await cs.add('TypeError in module A', 'modA.ts');
      await cs.add('export function bar', 'bar.ts');
      const results = cs.query({ keyword: 'TypeError' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('TypeError');
    });

    it('按 importance 过滤', async () => {
      const cs = new CuratedSet({ ...MINI_CONFIG, autoPopulateCount: 2 });
      await cs.add('throw new Error("x")', 'err.ts');
      await cs.add('export const x = 1', 'const.ts');
      const critical = cs.query({ importance: 'critical' });
      expect(critical.every((c) => c.importance === 'critical')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('返回正确的统计信息', async () => {
      const cs = new CuratedSet({ ...MINI_CONFIG, autoPopulateCount: 2 });
      await cs.add('error in system', 'sys.ts');
      await cs.add('export function foo', 'foo.ts');
      const stats = cs.getStats();
      expect(stats.totalChunks).toBeGreaterThanOrEqual(1);
      expect(stats.totalTokens).toBeGreaterThan(0);
      expect(typeof stats.byImportance.critical).toBe('number');
      expect(typeof stats.byImportance.useful).toBe('number');
    });
  });
});
