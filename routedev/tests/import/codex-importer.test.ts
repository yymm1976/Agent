// tests/import/codex-importer.test.ts
// Codex Instructions 导入器单元测试（Phase 48 Task 3）
//
// 覆盖：
//   1. .codex/ 目录不存在时 scan 返回 found: false，files 为空
//   2. .codex/instructions.md 存在时正确扫描
//   3. .codex/instructions.md + .codex/codex.md 多文件按字母顺序合并
//   4. import 在 system_prompt 模式下返回 systemPromptContent
//   5. import 在 project_memory 模式下按段落切分，每段带 codex-instruction 标签
//   6. import 在 ignore 模式下返回 ignored: true，不导入
//   7. import 时传入自定义 memoryTag 正确使用
//   8. hasUpdates 在文件 mtime 变化时返回 true
//   9. 空文件不导致崩溃，记入 warnings
//  10. 多个 .codex/*.md 文件按字母顺序合并（验证 files 排序）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexInstructionImporter } from '../../src/import/codex-importer.js';

// ============================================================
// 工具函数
// ============================================================

/** 创建临时项目根目录 */
async function makeTempProjectRoot(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'routedev-codex-test-'),
  );
  return dir;
}

/** 递归复制目录 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/** 递归删除目录 */
async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** fixture 根目录 */
const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'codex');

// ============================================================
// CodexInstructionImporter 测试
// ============================================================

describe('CodexInstructionImporter', () => {
  let importer: CodexInstructionImporter;
  let projectRoot: string;

  beforeEach(() => {
    importer = new CodexInstructionImporter();
  });

  afterEach(async () => {
    if (projectRoot) {
      await rmrf(projectRoot);
      projectRoot = '' as string;
    }
  });

  // ------------------------------------------------------------
  // 1. .codex/ 目录不存在
  // ------------------------------------------------------------
  it('.codex/ 目录不存在时 scan 返回 found: false 且 files 为空', async () => {
    projectRoot = await makeTempProjectRoot();

    const result = await importer.scan(projectRoot);

    expect(result.found).toBe(false);
    expect(result.files).toHaveLength(0);
    expect(result.absolutePaths).toHaveLength(0);
    expect(result.content).toBe('');
    expect(result.totalBytes).toBe(0);
  });

  // ------------------------------------------------------------
  // 2. .codex/instructions.md 存在时正确扫描
  // ------------------------------------------------------------
  it('.codex/instructions.md 存在时 scan 返回 found: true 且内容正确', async () => {
    projectRoot = await makeTempProjectRoot();
    await copyDir(
      path.join(FIXTURES_ROOT, 'basic'),
      projectRoot,
    );

    const result = await importer.scan(projectRoot);

    expect(result.found).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toBe(path.join('.codex', 'instructions.md'));
    expect(result.absolutePaths[0]).toBe(
      path.join(projectRoot, '.codex', 'instructions.md'),
    );
    expect(result.content).toContain('## 编码规范');
    expect(result.content).toContain('## 测试规范');
    expect(result.totalBytes).toBe(Buffer.byteLength(result.content, 'utf-8'));
    expect(result.totalBytes).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------
  // 3 & 10. 多文件按字母顺序合并
  // ------------------------------------------------------------
  it('多个 .codex/*.md 文件按字母顺序合并（codex.md < extra.md < instructions.md）', async () => {
    projectRoot = await makeTempProjectRoot();
    await copyDir(
      path.join(FIXTURES_ROOT, 'multi'),
      projectRoot,
    );

    const result = await importer.scan(projectRoot);

    expect(result.found).toBe(true);
    // 验证字母顺序：codex.md < extra.md < instructions.md
    expect(result.files).toEqual([
      path.join('.codex', 'codex.md'),
      path.join('.codex', 'extra.md'),
      path.join('.codex', 'instructions.md'),
    ]);
    expect(result.files).toHaveLength(3);
    // 验证合并内容包含三个文件的标记
    expect(result.content).toContain('Codex 项目文档（兼容文件）');
    expect(result.content).toContain('额外说明');
    expect(result.content).toContain('项目说明');
    // 验证用 \n\n---\n\n 分隔
    expect(result.content).toContain('\n\n---\n\n');
    // 验证顺序：codex.md 内容应在 extra.md 之前
    const codexIdx = result.content.indexOf('Codex 项目文档');
    const extraIdx = result.content.indexOf('额外说明');
    const instrIdx = result.content.indexOf('项目说明');
    expect(codexIdx).toBeLessThan(extraIdx);
    expect(extraIdx).toBeLessThan(instrIdx);
  });

  // ------------------------------------------------------------
  // 4. system_prompt 模式
  // ------------------------------------------------------------
  it('import 在 system_prompt 模式下返回 systemPromptContent', async () => {
    projectRoot = await makeTempProjectRoot();
    await copyDir(
      path.join(FIXTURES_ROOT, 'basic'),
      projectRoot,
    );

    const result = await importer.import({
      projectRoot,
      mode: 'system_prompt',
    });

    expect(result.mode).toBe('system_prompt');
    expect(result.systemPromptContent).toBeDefined();
    expect(result.systemPromptContent).toContain('## 编码规范');
    expect(result.systemPromptContent).toContain('## 测试规范');
    expect(result.importedFiles).toHaveLength(1);
    expect(result.totalBytes).toBeGreaterThan(0);
    // system_prompt 模式不应返回 memoryEntries
    expect(result.memoryEntries).toBeUndefined();
    expect(result.ignored).toBeUndefined();
  });

  // ------------------------------------------------------------
  // 5. project_memory 模式按段落切分
  // ------------------------------------------------------------
  it('import 在 project_memory 模式下按 ## 标题切分，每段带 codex-instruction 标签', async () => {
    projectRoot = await makeTempProjectRoot();
    await copyDir(
      path.join(FIXTURES_ROOT, 'basic'),
      projectRoot,
    );

    const result = await importer.import({
      projectRoot,
      mode: 'project_memory',
    });

    expect(result.mode).toBe('project_memory');
    expect(result.memoryEntries).toBeDefined();
    expect(result.memoryEntries!.length).toBeGreaterThanOrEqual(2);

    // 验证每段都有 codex-instruction 标签
    for (const entry of result.memoryEntries!) {
      expect(entry.tag).toBe('codex-instruction');
      expect(entry.content.length).toBeGreaterThan(0);
    }

    // 验证包含两个 ## 标题对应的段落
    const contents = result.memoryEntries!.map(e => e.content);
    const hasBianma = contents.some(c => c.includes('## 编码规范'));
    const hasCeshi = contents.some(c => c.includes('## 测试规范'));
    expect(hasBianma).toBe(true);
    expect(hasCeshi).toBe(true);

    // project_memory 模式不应返回 systemPromptContent
    expect(result.systemPromptContent).toBeUndefined();
    expect(result.ignored).toBeUndefined();
  });

  // ------------------------------------------------------------
  // 6. ignore 模式
  // ------------------------------------------------------------
  it('import 在 ignore 模式下返回 ignored: true 且不导入内容', async () => {
    projectRoot = await makeTempProjectRoot();
    await copyDir(
      path.join(FIXTURES_ROOT, 'basic'),
      projectRoot,
    );

    const result = await importer.import({
      projectRoot,
      mode: 'ignore',
    });

    expect(result.mode).toBe('ignore');
    expect(result.ignored).toBe(true);
    expect(result.importedFiles).toHaveLength(0);
    expect(result.totalBytes).toBe(0);
    expect(result.systemPromptContent).toBeUndefined();
    expect(result.memoryEntries).toBeUndefined();
  });

  // ------------------------------------------------------------
  // 7. 自定义 memoryTag
  // ------------------------------------------------------------
  it('import 传入自定义 memoryTag 时每段使用自定义标签', async () => {
    projectRoot = await makeTempProjectRoot();
    await copyDir(
      path.join(FIXTURES_ROOT, 'basic'),
      projectRoot,
    );

    const result = await importer.import({
      projectRoot,
      mode: 'project_memory',
      memoryTag: 'custom-codex-tag',
    });

    expect(result.memoryEntries).toBeDefined();
    expect(result.memoryEntries!.length).toBeGreaterThan(0);
    for (const entry of result.memoryEntries!) {
      expect(entry.tag).toBe('custom-codex-tag');
    }
  });

  // ------------------------------------------------------------
  // 8. hasUpdates 检测 mtime 变化
  // ------------------------------------------------------------
  it('hasUpdates 在文件 mtime 变化时返回 true，未变化时返回 false', async () => {
    projectRoot = await makeTempProjectRoot();
    await copyDir(
      path.join(FIXTURES_ROOT, 'basic'),
      projectRoot,
    );

    // 首次扫描，记录 mtime
    const scan1 = await importer.scan(projectRoot);
    expect(scan1.found).toBe(true);

    const lastSeen: Record<string, number> = {};
    for (const [i, relPath] of scan1.files.entries()) {
      const stat = await fs.stat(scan1.absolutePaths[i]!);
      lastSeen[relPath] = stat.mtimeMs;
    }

    // 未变化时应返回 false
    const noUpdate = await importer.hasUpdates(projectRoot, lastSeen);
    expect(noUpdate).toBe(false);

    // 修改文件内容并确保 mtime 变化
    const filePath = path.join(projectRoot, '.codex', 'instructions.md');
    // 等待一小段时间确保 mtime 精度差异
    await new Promise(resolve => setTimeout(resolve, 50));
    await fs.writeFile(
      filePath,
      '## 更新后的内容\n\n新增规范内容\n',
      'utf-8',
    );

    // 修改后应返回 true
    const hasUpdate = await importer.hasUpdates(projectRoot, lastSeen);
    expect(hasUpdate).toBe(true);
  });

  // ------------------------------------------------------------
  // 8b. hasUpdates 在新增文件时返回 true
  // ------------------------------------------------------------
  it('hasUpdates 在 .codex/ 新增文件时返回 true', async () => {
    projectRoot = await makeTempProjectRoot();
    await copyDir(
      path.join(FIXTURES_ROOT, 'basic'),
      projectRoot,
    );

    const scan1 = await importer.scan(projectRoot);
    const lastSeen: Record<string, number> = {};
    for (const [i, relPath] of scan1.files.entries()) {
      const stat = await fs.stat(scan1.absolutePaths[i]!);
      lastSeen[relPath] = stat.mtimeMs;
    }

    // 新增 codex.md
    await fs.writeFile(
      path.join(projectRoot, '.codex', 'codex.md'),
      '# 新增文件\n',
      'utf-8',
    );

    const hasUpdate = await importer.hasUpdates(projectRoot, lastSeen);
    expect(hasUpdate).toBe(true);
  });

  // ------------------------------------------------------------
  // 9. 空文件不导致崩溃，记入 warnings
  // ------------------------------------------------------------
  it('空 markdown 文件不导致崩溃且记入 warnings', async () => {
    projectRoot = await makeTempProjectRoot();
    const codexDir = path.join(projectRoot, '.codex');
    await fs.mkdir(codexDir, { recursive: true });
    // 写一个空文件
    await fs.writeFile(
      path.join(codexDir, 'empty.md'),
      '',
      'utf-8',
    );
    // 写一个有内容的文件
    await fs.writeFile(
      path.join(codexDir, 'instructions.md'),
      '## 有效内容\n\n这是有效内容\n',
      'utf-8',
    );

    const result = await importer.import({
      projectRoot,
      mode: 'system_prompt',
    });

    // 不应崩溃
    expect(result.mode).toBe('system_prompt');
    // 应有 warnings 提示空文件
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some(w => w.includes('empty.md'))).toBe(true);
    // 仍应返回有效内容
    expect(result.systemPromptContent).toContain('有效内容');
  });

  // ------------------------------------------------------------
  // 9b. 无 .md 文件时 scan 返回 found: false
  // ------------------------------------------------------------
  it('.codex/ 目录存在但无 .md 文件时 scan 返回 found: false', async () => {
    projectRoot = await makeTempProjectRoot();
    const codexDir = path.join(projectRoot, '.codex');
    await fs.mkdir(codexDir, { recursive: true });
    // 只放非 md 文件
    await fs.writeFile(
      path.join(codexDir, 'config.json'),
      '{"key":"value"}',
      'utf-8',
    );
    await fs.writeFile(
      path.join(codexDir, 'notes.txt'),
      'some notes',
      'utf-8',
    );

    const result = await importer.scan(projectRoot);

    expect(result.found).toBe(false);
    expect(result.files).toHaveLength(0);
    expect(result.content).toBe('');
  });

  // ------------------------------------------------------------
  // 额外：未找到 .codex/ 时 import 返回空结果
  // ------------------------------------------------------------
  it('未找到 .codex/ 目录时 import 返回空结果不报错', async () => {
    projectRoot = await makeTempProjectRoot();

    const result = await importer.import({
      projectRoot,
      mode: 'project_memory',
    });

    expect(result.mode).toBe('project_memory');
    expect(result.importedFiles).toHaveLength(0);
    expect(result.totalBytes).toBe(0);
    expect(result.memoryEntries).toBeUndefined();
  });
});
