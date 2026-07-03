import { describe, it, expect } from 'vitest';
import { VerificationRecords } from '../../src/agent/verification-records.js';

describe('VerificationRecords', () => {
  describe('record 记录验证结果', () => {
    it('记录并可通过 isVerified 查询', () => {
      const vr = new VerificationRecords({ enabled: true, maxRecords: 100, ttlMs: 3600000 });
      const hash = vr.hashContent('file content');
      vr.record({ type: 'typecheck', target: 'src/foo.ts', targetHash: hash, passed: true, source: 'gate' });
      expect(vr.isVerified('typecheck', 'src/foo.ts', hash)).toBe(true);
    });
  });

  describe('isVerified 哈希不匹配返回 false', () => {
    it('目标内容变化后 isVerified 返回 false', () => {
      const vr = new VerificationRecords({ enabled: true, maxRecords: 100, ttlMs: 3600000 });
      const hash1 = vr.hashContent('old content');
      const hash2 = vr.hashContent('new content');
      vr.record({ type: 'typecheck', target: 'src/foo.ts', targetHash: hash1, passed: true, source: 'gate' });
      expect(vr.isVerified('typecheck', 'src/foo.ts', hash2)).toBe(false);
    });
  });

  describe('isVerified 超过 ttlMs 返回 false', () => {
    it('TTL 过期后记录失效', () => {
      const vr = new VerificationRecords({ enabled: true, maxRecords: 100, ttlMs: 1 });
      const hash = vr.hashContent('content');
      vr.record({ type: 'typecheck', target: 'src/foo.ts', targetHash: hash, passed: true, source: 'gate' });
      const rec = vr['records'].values().next().value;
      if (rec) rec.verifiedAt = Date.now() - 1000;
      expect(vr.isVerified('typecheck', 'src/foo.ts', hash)).toBe(false);
    });
  });

  describe('batchIsVerified 批量查询', () => {
    it('多个文件批量返回验证状态', () => {
      const vr = new VerificationRecords({ enabled: true, maxRecords: 100, ttlMs: 3600000 });
      const h1 = vr.hashContent('file1');
      const h2 = vr.hashContent('file2');
      vr.record({ type: 'typecheck', target: 'a.ts', targetHash: h1, passed: true, source: 'gate' });
      const result = vr.batchIsVerified([
        { path: 'a.ts', hash: h1 },
        { path: 'b.ts', hash: h2 },
      ]);
      expect(result.get('a.ts')).toBe(true);
      expect(result.get('b.ts')).toBe(false);
    });
  });

  describe('cleanup 清理过期记录', () => {
    it('清理过期记录并返回清理数量', () => {
      const vr = new VerificationRecords({ enabled: true, maxRecords: 100, ttlMs: 100 });
      const hash = vr.hashContent('content');
      vr.record({ type: 'typecheck', target: 'a.ts', targetHash: hash, passed: true, source: 'gate' });
      const rec = vr['records'].values().next().value;
      if (rec) rec.verifiedAt = Date.now() - 1000;
      const cleaned = vr.cleanup();
      expect(cleaned).toBeGreaterThanOrEqual(1);
    });
  });

  describe('LRU 淘汰', () => {
    it('超过 maxRecords 时淘汰最早记录', () => {
      const vr = new VerificationRecords({ enabled: true, maxRecords: 2, ttlMs: 3600000 });
      vr.record({ type: 'typecheck', target: 'a.ts', targetHash: 'h1', passed: true, source: 'gate' });
      vr.record({ type: 'typecheck', target: 'b.ts', targetHash: 'h2', passed: true, source: 'gate' });
      vr.record({ type: 'typecheck', target: 'c.ts', targetHash: 'h3', passed: true, source: 'gate' });
      expect(vr.getRecordCount()).toBeLessThanOrEqual(2);
    });
  });

  describe('passed=false 记录', () => {
    it('passed=false 的记录 isVerified 返回 false', () => {
      const vr = new VerificationRecords({ enabled: true, maxRecords: 100, ttlMs: 3600000 });
      const hash = vr.hashContent('content');
      vr.record({ type: 'typecheck', target: 'a.ts', targetHash: hash, passed: false, source: 'gate' });
      expect(vr.isVerified('typecheck', 'a.ts', hash)).toBe(false);
    });
  });
});
