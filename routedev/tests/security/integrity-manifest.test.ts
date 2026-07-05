// tests/security/integrity-manifest.test.ts
// 依赖完整性校验清单单元测试
//
// 测试策略：
//   - 用 tmpdir 隔离测试，不写死路径
//   - record/verify/save/load 四个核心方法
//   - fail-open：manifest 文件不存在时 verify 返回 ok=true（首次信任）
//   - SHA-256 计算正确性（与 node:crypto 对照）
//   - 流式读取（大文件场景）
//   - 持久化往返：save → load 数据一致
//   - 多文件记录与 list 查询
//   - 篡改检测：文件修改后 verify 返回 ok=false

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { IntegrityManifest } from '../../src/security/integrity-manifest.js';

// ============================================================
// 辅助
// ============================================================

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-integrity-'));
}

/** 计算文件 SHA-256（与实现对照用） */
function computeExpectedSha256(filePath: string): string {
  const content = fsSync.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/** 写入测试文件 */
async function writeTestFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

// ============================================================
// 测试
// ============================================================

describe('IntegrityManifest', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  // ----------------------------------------------------------
  // 测试 1：record 应计算 SHA-256 并保存到内存
  // ----------------------------------------------------------
  it('record 应计算 SHA-256 并保存到内存', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const filePath = path.join(tmpDir, 'skill.md');
    await writeTestFile(filePath, '# Test Skill\n\nHello world');

    const manifest = new IntegrityManifest(manifestPath);
    await manifest.record(filePath, 'skill-market');

    const records = manifest.list();
    expect(records.length).toBe(1);
    expect(records[0]!.path).toBe(filePath);
    expect(records[0]!.source).toBe('skill-market');
    expect(records[0]!.sha256).toBe(computeExpectedSha256(filePath));
    expect(records[0]!.sha256).toHaveLength(64); // SHA-256 hex
    expect(records[0]!.recordedAt).toBeGreaterThan(0);
  });

  // ----------------------------------------------------------
  // 测试 2：verify 文件未修改时应返回 ok=true
  // ----------------------------------------------------------
  it('verify 文件未修改时应返回 ok=true 且 expected=actual', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const filePath = path.join(tmpDir, 'skill.md');
    await writeTestFile(filePath, 'unchanged content');

    const manifest = new IntegrityManifest(manifestPath);
    await manifest.record(filePath, 'anthropic-skills');

    const result = await manifest.verify(filePath);
    expect(result.ok).toBe(true);
    expect(result.expected).toBe(result.actual);
    expect(result.expected).toBe(computeExpectedSha256(filePath));
  });

  // ----------------------------------------------------------
  // 测试 3：verify 文件被篡改时应返回 ok=false
  // ----------------------------------------------------------
  it('verify 文件被篡改时应返回 ok=false 且 expected != actual', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const filePath = path.join(tmpDir, 'skill.md');
    await writeTestFile(filePath, 'original content');

    const manifest = new IntegrityManifest(manifestPath);
    await manifest.record(filePath, 'skill-market');
    const originalHash = computeExpectedSha256(filePath);

    // 篡改文件
    await fs.writeFile(filePath, 'tampered content', 'utf-8');
    const tamperedHash = computeExpectedSha256(filePath);

    const result = await manifest.verify(filePath);
    expect(result.ok).toBe(false);
    expect(result.expected).toBe(originalHash);
    expect(result.actual).toBe(tamperedHash);
    expect(result.expected).not.toBe(result.actual);
  });

  // ----------------------------------------------------------
  // 测试 4：fail-open - verify 无记录时应返回 ok=true
  // ----------------------------------------------------------
  it('verify 无记录时应返回 ok=true 且 expected=undefined（首次信任）', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const filePath = path.join(tmpDir, 'skill.md');
    await writeTestFile(filePath, 'first time content');

    const manifest = new IntegrityManifest(manifestPath);
    // 不调用 record，直接 verify
    const result = await manifest.verify(filePath);
    expect(result.ok).toBe(true);
    expect(result.expected).toBeUndefined();
    expect(result.actual).toBe(computeExpectedSha256(filePath));
  });

  // ----------------------------------------------------------
  // 测试 5：save + load 持久化往返
  // ----------------------------------------------------------
  it('save + load 持久化往返数据一致', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const file1 = path.join(tmpDir, 'skill1.md');
    const file2 = path.join(tmpDir, 'skill2.md');
    await writeTestFile(file1, 'content 1');
    await writeTestFile(file2, 'content 2');

    // 第一个 manifest 实例：record + save
    const manifest1 = new IntegrityManifest(manifestPath);
    await manifest1.record(file1, 'skill-market');
    await manifest1.record(file2, 'claude-plugin');
    await manifest1.save();

    // manifest 文件应已创建
    expect(fsSync.existsSync(manifestPath)).toBe(true);

    // 第二个 manifest 实例：load + verify
    const manifest2 = new IntegrityManifest(manifestPath);
    await manifest2.load();

    const records = manifest2.list();
    expect(records.length).toBe(2);

    // 两个文件的 verify 都应通过
    const result1 = await manifest2.verify(file1);
    expect(result1.ok).toBe(true);
    expect(result1.expected).toBe(computeExpectedSha256(file1));

    const result2 = await manifest2.verify(file2);
    expect(result2.ok).toBe(true);
    expect(result2.expected).toBe(computeExpectedSha256(file2));

    // source 标注应保留
    const rec1 = records.find((r) => r.path === file1);
    const rec2 = records.find((r) => r.path === file2);
    expect(rec1?.source).toBe('skill-market');
    expect(rec2?.source).toBe('claude-plugin');
  });

  // ----------------------------------------------------------
  // 测试 6：fail-open - load 不存在的 manifest 文件应返回空记录
  // ----------------------------------------------------------
  it('load 不存在的 manifest 文件应返回空记录（fail-open）', async () => {
    const manifestPath = path.join(tmpDir, 'does-not-exist.json');
    const manifest = new IntegrityManifest(manifestPath);

    // 不应抛错
    await manifest.load();
    expect(manifest.list()).toHaveLength(0);
  });

  // ----------------------------------------------------------
  // 测试 7：fail-open - load 损坏的 JSON 应 warn 并返回空记录
  // ----------------------------------------------------------
  it('load 损坏的 JSON 应返回空记录（fail-open）', async () => {
    const manifestPath = path.join(tmpDir, 'corrupt.json');
    await fs.writeFile(manifestPath, '{invalid json', 'utf-8');

    const manifest = new IntegrityManifest(manifestPath);
    // 不应抛错
    await manifest.load();
    expect(manifest.list()).toHaveLength(0);
  });

  // ----------------------------------------------------------
  // 测试 8：record 不带 source 时 source 应为 undefined
  // ----------------------------------------------------------
  it('record 不带 source 时 source 应为 undefined', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const filePath = path.join(tmpDir, 'skill.md');
    await writeTestFile(filePath, 'no source');

    const manifest = new IntegrityManifest(manifestPath);
    await manifest.record(filePath);

    const records = manifest.list();
    expect(records.length).toBe(1);
    expect(records[0]!.source).toBeUndefined();
  });

  // ----------------------------------------------------------
  // 测试 9：list 应返回所有已记录的条目
  // ----------------------------------------------------------
  it('list 应返回所有已记录的条目', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const manifest = new IntegrityManifest(manifestPath);

    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const filePath = path.join(tmpDir, `skill${i}.md`);
      await writeTestFile(filePath, `content ${i}`);
      await manifest.record(filePath, 'test');
      files.push(filePath);
    }

    const records = manifest.list();
    expect(records.length).toBe(5);
    for (const file of files) {
      expect(records.some((r) => r.path === file)).toBe(true);
    }
  });

  // ----------------------------------------------------------
  // 测试 10：save 应创建父目录
  // ----------------------------------------------------------
  it('save 应自动创建不存在的父目录', async () => {
    const manifestPath = path.join(tmpDir, 'nested', 'dir', 'manifest.json');
    const manifest = new IntegrityManifest(manifestPath);
    await manifest.save();

    expect(fsSync.existsSync(manifestPath)).toBe(true);
  });

  // ----------------------------------------------------------
  // 测试 11：流式读取大文件应正确计算 SHA-256
  // ----------------------------------------------------------
  it('流式读取大文件应正确计算 SHA-256（与一次性读取一致）', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const filePath = path.join(tmpDir, 'large.md');

    // 生成 1MB 内容（超过单次读取块大小）
    const chunk = 'x'.repeat(1024);
    const content = chunk.repeat(1024); // 1MB
    await writeTestFile(filePath, content);

    const manifest = new IntegrityManifest(manifestPath);
    await manifest.record(filePath, 'large-file');

    const expected = createHash('sha256').update(content).digest('hex');
    expect(manifest.list()[0]!.sha256).toBe(expected);
  });

  // ----------------------------------------------------------
  // 测试 12：has 应正确判断是否已记录
  // ----------------------------------------------------------
  it('has 应正确判断是否已记录', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const file1 = path.join(tmpDir, 'skill1.md');
    const file2 = path.join(tmpDir, 'skill2.md');
    await writeTestFile(file1, 'content 1');
    await writeTestFile(file2, 'content 2');

    const manifest = new IntegrityManifest(manifestPath);
    await manifest.record(file1, 'test');

    expect(manifest.has(file1)).toBe(true);
    expect(manifest.has(file2)).toBe(false);
  });

  // ----------------------------------------------------------
  // 测试 13：forget 应删除指定文件的记录
  // ----------------------------------------------------------
  it('forget 应删除指定文件的记录', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const file1 = path.join(tmpDir, 'skill1.md');
    const file2 = path.join(tmpDir, 'skill2.md');
    await writeTestFile(file1, 'content 1');
    await writeTestFile(file2, 'content 2');

    const manifest = new IntegrityManifest(manifestPath);
    await manifest.record(file1, 'test');
    await manifest.record(file2, 'test');
    expect(manifest.list().length).toBe(2);

    manifest.forget(file1);
    expect(manifest.list().length).toBe(1);
    expect(manifest.has(file1)).toBe(false);
    expect(manifest.has(file2)).toBe(true);

    // forget 后 verify 应返回 ok=true（无记录 = 首次信任）
    const result = await manifest.verify(file1);
    expect(result.ok).toBe(true);
    expect(result.expected).toBeUndefined();
  });

  // ----------------------------------------------------------
  // 测试 14：完整工作流 - record → save → reload → verify → 篡改 → verify
  // ----------------------------------------------------------
  it('完整工作流：record → save → reload → verify → 篡改 → verify 失败', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const skillDir = path.join(tmpDir, 'skills', 'my-skill');
    const skillFile = path.join(skillDir, 'SKILL.md');
    await writeTestFile(skillFile, '# My Skill\n\nOriginal content');

    // 实例 1：record + save
    const manifest1 = new IntegrityManifest(manifestPath);
    await manifest1.record(skillFile, 'skill-market');
    await manifest1.save();

    // 实例 2：load + verify（应通过）
    const manifest2 = new IntegrityManifest(manifestPath);
    await manifest2.load();
    const verifyBefore = await manifest2.verify(skillFile);
    expect(verifyBefore.ok).toBe(true);

    // 篡改文件
    await fs.writeFile(skillFile, '# My Skill\n\nTampered content', 'utf-8');

    // 再次 verify（应失败）
    const verifyAfter = await manifest2.verify(skillFile);
    expect(verifyAfter.ok).toBe(false);
    expect(verifyAfter.expected).not.toBe(verifyAfter.actual);
  });

  // ----------------------------------------------------------
  // 测试 15：多次 record 同一文件应覆盖旧记录
  // ----------------------------------------------------------
  it('多次 record 同一文件应覆盖旧记录（按最新内容计算）', async () => {
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const filePath = path.join(tmpDir, 'skill.md');
    await writeTestFile(filePath, 'content v1');

    const manifest = new IntegrityManifest(manifestPath);
    await manifest.record(filePath, 'test');
    const hash1 = manifest.list()[0]!.sha256;

    // 文件未变，再次 record 应得到相同 hash
    await manifest.record(filePath, 'test');
    const hash2 = manifest.list()[0]!.sha256;
    expect(hash1).toBe(hash2);
    expect(manifest.list().length).toBe(1); // 仍是 1 条记录

    // 修改文件后 record，hash 应改变
    await fs.writeFile(filePath, 'content v2', 'utf-8');
    await manifest.record(filePath, 'test');
    const hash3 = manifest.list()[0]!.sha256;
    expect(hash3).not.toBe(hash1);
    expect(manifest.list().length).toBe(1); // 仍是 1 条记录（覆盖）
  });
});
