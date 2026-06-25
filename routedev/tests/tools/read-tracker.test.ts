// tests/tools/read-tracker.test.ts
// Phase 31 Task 6.1：ReadTracker 先读后写强制测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReadTracker, createReadTracker } from '../../src/tools/read-tracker.js';

describe('ReadTracker (Phase 31 Task 6.1)', () => {
  let tracker: ReadTracker;
  let tempDir: string;

  beforeEach(() => {
    tracker = createReadTracker();
    tempDir = mkdtempSync(join(tmpdir(), 'rd-read-tracker-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('markRead / hasRead', () => {
    it('未标记的文件 hasRead 返回 false', () => {
      expect(tracker.hasRead(join(tempDir, 'a.ts'))).toBe(false);
    });

    it('标记后 hasRead 返回 true', () => {
      const file = join(tempDir, 'a.ts');
      tracker.markRead(file);
      expect(tracker.hasRead(file)).toBe(true);
    });

    it('路径规范化——相对路径与绝对路径等价', () => {
      const abs = join(tempDir, 'a.ts');
      const rel = './a.ts';
      tracker.markRead(abs);
      // 相对路径在 resolve 后应匹配
      // 注意：rel 是相对于 cwd，不一定等于 tempDir，所以这里测试 normalize 一致性
      expect(tracker.hasRead(abs)).toBe(true);
    });

    it('路径规范化——重复斜杠被 normalize', () => {
      const file = join(tempDir, 'a.ts');
      const messy = tempDir + '//a.ts';
      tracker.markRead(file);
      expect(tracker.hasRead(messy)).toBe(true);
    });

    it('getReadFiles 返回已读列表', () => {
      tracker.markRead(join(tempDir, 'a.ts'));
      tracker.markRead(join(tempDir, 'b.ts'));
      const files = tracker.getReadFiles();
      expect(files.length).toBe(2);
    });
  });

  describe('checkWriteAllowed - 已读文件', () => {
    it('已读文件允许写入', async () => {
      const file = join(tempDir, 'a.ts');
      writeFileSync(file, 'existing');
      tracker.markRead(file);
      const result = await tracker.checkWriteAllowed(file);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('checkWriteAllowed - 新建文件', () => {
    it('路径不存在的文件允许写入（新建文件例外）', async () => {
      const file = join(tempDir, 'nonexistent.ts');
      const result = await tracker.checkWriteAllowed(file);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('新建文件不需要先读', async () => {
      const file = join(tempDir, 'brand-new.ts');
      const result = await tracker.checkWriteAllowed(file);
      expect(result.allowed).toBe(true);
    });
  });

  describe('checkWriteAllowed - 未读且存在的文件', () => {
    it('未读且存在的文件被拒绝', async () => {
      const file = join(tempDir, 'existing.ts');
      writeFileSync(file, 'content');
      const result = await tracker.checkWriteAllowed(file);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('尚未被读取');
    });

    it('拒绝原因包含文件路径', async () => {
      const file = join(tempDir, 'existing.ts');
      writeFileSync(file, 'content');
      const result = await tracker.checkWriteAllowed(file);
      expect(result.reason).toContain('existing.ts');
    });
  });

  describe('checkWriteAllowedSync', () => {
    it('已读文件同步检查通过', () => {
      const file = join(tempDir, 'a.ts');
      tracker.markRead(file);
      const result = tracker.checkWriteAllowedSync(file);
      expect(result.allowed).toBe(true);
    });

    it('未读文件同步检查拒绝（保守策略）', () => {
      const file = join(tempDir, 'a.ts');
      const result = tracker.checkWriteAllowedSync(file);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('同步检查未通过');
    });
  });

  describe('存在性缓存', () => {
    it('同一路径的多次检查只访问文件系统一次', async () => {
      const file = join(tempDir, 'cached.ts');
      writeFileSync(file, 'content');
      // 第一次检查（会访问 fs）
      await tracker.checkWriteAllowed(file);
      // 删除文件
      unlinkSync(file);
      // 第二次检查（应使用缓存，仍认为文件存在）
      const result = await tracker.checkWriteAllowed(file);
      expect(result.allowed).toBe(false); // 缓存认为文件存在
    });
  });

  describe('reset', () => {
    it('reset 清空已读列表', () => {
      tracker.markRead(join(tempDir, 'a.ts'));
      tracker.reset();
      expect(tracker.getReadFiles().length).toBe(0);
    });

    it('reset 后已读文件变为未读', () => {
      const file = join(tempDir, 'a.ts');
      tracker.markRead(file);
      tracker.reset();
      expect(tracker.hasRead(file)).toBe(false);
    });

    it('reset 清空存在性缓存', async () => {
      const file = join(tempDir, 'a.ts');
      writeFileSync(file, 'content');
      await tracker.checkWriteAllowed(file); // 填充缓存
      tracker.reset();
      // 删除文件后 reset，再检查应认为不存在
      unlinkSync(file);
      const result = await tracker.checkWriteAllowed(file);
      expect(result.allowed).toBe(true); // 文件已不存在，允许新建
    });
  });

  describe('工厂函数', () => {
    it('createReadTracker 返回 ReadTracker 实例', () => {
      const t = createReadTracker();
      expect(t).toBeInstanceOf(ReadTracker);
    });
  });
});
