import { describe, it, expect } from 'vitest';
import { ContentDeduplicator } from '../../src/agent/content-deduplicator.js';

describe('ContentDeduplicator', () => {
  describe('hashContent 标准化', () => {
    it('大小写不敏感', () => {
      const dedup = new ContentDeduplicator();
      expect(dedup.hashContent('Hello World')).toBe(dedup.hashContent('hello world'));
    });

    it('空白差异不敏感', () => {
      const dedup = new ContentDeduplicator();
      expect(dedup.hashContent('hello   world')).toBe(dedup.hashContent(' hello world '));
    });
  });

  describe('dedup 跨 role 识别重复', () => {
    it('不同 role 但相同内容被去重', () => {
      const dedup = new ContentDeduplicator({ enabled: true, hashAlgorithm: 'sha256', minLength: 5, replaceWithReference: true });
      const items = [
        { role: 'user', content: 'same content here for dedup test' },
        { role: 'assistant', content: 'same content here for dedup test' },
      ];
      const result = dedup.dedup(items, (i) => i.content);
      expect(result.deduplicatedCount).toBe(1);
    });
  });

  describe('dedup 短内容不去重', () => {
    it('长度 < minLength 的内容不参与去重', () => {
      const dedup = new ContentDeduplicator({ enabled: true, hashAlgorithm: 'sha256', minLength: 100, replaceWithReference: true });
      const items = ['short', 'short', 'short'];
      const result = dedup.dedup(items, (s) => s);
      expect(result.deduplicatedCount).toBe(0);
      expect(result.items).toHaveLength(3);
    });
  });

  describe('dedup replaceWithReference', () => {
    it('replaceWithReference=true 替换为引用标记', () => {
      const dedup = new ContentDeduplicator({ enabled: true, hashAlgorithm: 'sha256', minLength: 5, replaceWithReference: true });
      const longContent = 'this is a long content string that should be deduped properly now';
      const items = [longContent, longContent];
      const result = dedup.dedup(items, (s) => s);
      expect(result.items[1]).toContain('DEDUP');
    });

    it('replaceWithReference=false 直接删除重复项', () => {
      const dedup = new ContentDeduplicator({ enabled: true, hashAlgorithm: 'sha256', minLength: 5, replaceWithReference: false });
      const longContent = 'this is a long content string that should be deduped properly now';
      const items = [longContent, longContent];
      const result = dedup.dedup(items, (s) => s);
      expect(result.items).toHaveLength(1);
      expect(result.deduplicatedCount).toBe(1);
    });
  });

  describe('dedup savedTokens 统计', () => {
    it('savedTokens 累加去重节省的 token 数', () => {
      const dedup = new ContentDeduplicator({ enabled: true, hashAlgorithm: 'sha256', minLength: 5, replaceWithReference: true });
      const longContent = 'a'.repeat(200);
      const items = [longContent, longContent, longContent];
      const result = dedup.dedup(items, (s) => s);
      expect(result.savedTokens).toBeGreaterThan(0);
      expect(result.deduplicatedCount).toBe(2);
    });
  });

  describe('disabled 时不去重', () => {
    it('enabled=false 返回原始 items 不去重', () => {
      const dedup = new ContentDeduplicator({ enabled: false, hashAlgorithm: 'sha256', minLength: 5, replaceWithReference: true });
      const items = ['duplicate content', 'duplicate content'];
      const result = dedup.dedup(items, (s) => s);
      expect(result.deduplicatedCount).toBe(0);
      expect(result.items).toHaveLength(2);
    });
  });
});
