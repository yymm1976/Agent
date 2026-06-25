// tests/integration/phase47-task8.test.ts
// Phase 47 Task 8 集成测试：AGENTS.local.md 与 CLAUDE.md fallback 兼容
//
// 测试策略：
//   1. AGENTS.md 存在时正常加载
//   2. AGENTS.local.md 存在时与 AGENTS.md 合并（local 内容在后）
//   3. AGENTS.override.md 存在时跳过 AGENTS.md（陷阱 #140 验证）
//   4. AGENTS.md 不存在时 fallback 到 CLAUDE.md
//   5. 超过 maxBytes 时截断并警告
//   6. Schema 配置验证 - projectDoc 默认值
//   7. mergeDocs / truncateDoc 单元行为

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  loadProjectDoc,
  mergeDocs,
  truncateDoc,
  DEFAULT_PROJECT_DOC_CONFIG,
} from '../../src/memory/project-memory.js';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// ============================================================
// 工具函数
// ============================================================

async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-phase47-task8-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeFile(dir: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, name), content, 'utf-8');
}

// ============================================================
// 1. AGENTS.md 存在时正常加载
// ============================================================
describe('Phase 47 Task 8 - AGENTS.md 正常加载', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('仅 AGENTS.md 存在时返回其内容', async () => {
    await writeFile(tmpDir, 'AGENTS.md', '# Project Agents\n\n- Use TypeScript');
    const doc = await loadProjectDoc(tmpDir);
    expect(doc).not.toBeNull();
    expect(doc).toContain('Project Agents');
    expect(doc).toContain('Use TypeScript');
  });

  it('没有任何项目文档时返回 null', async () => {
    const doc = await loadProjectDoc(tmpDir);
    expect(doc).toBeNull();
  });
});

// ============================================================
// 2. AGENTS.local.md 与 AGENTS.md 合并（local 在后）
// ============================================================
describe('Phase 47 Task 8 - AGENTS.local.md 合并', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('AGENTS.local.md 内容在 AGENTS.md 之后（覆盖语义）', async () => {
    await writeFile(tmpDir, 'AGENTS.md', '# Base\n\nbase content');
    await writeFile(tmpDir, 'AGENTS.local.md', '# Local\n\nlocal override');
    const doc = await loadProjectDoc(tmpDir);
    expect(doc).not.toBeNull();
    // base 在前，local 在后
    const baseIdx = doc!.indexOf('base content');
    const localIdx = doc!.indexOf('local override');
    expect(baseIdx).toBeGreaterThan(-1);
    expect(localIdx).toBeGreaterThan(-1);
    expect(baseIdx).toBeLessThan(localIdx);
  });

  it('仅 AGENTS.local.md 存在时（base 缺失）fallback 到 CLAUDE.md', async () => {
    // 加载优先级：base 存在才合并 local；base 缺失则走 fallback 链
    await writeFile(tmpDir, 'AGENTS.local.md', '# Local Only\n\nlocal content');
    await writeFile(tmpDir, 'CLAUDE.md', '# Claude\n\nCLAUDE_FALLBACK');
    const doc = await loadProjectDoc(tmpDir);
    expect(doc).not.toBeNull();
    // 应该 fallback 到 CLAUDE.md，而不是单独加载 AGENTS.local.md
    expect(doc).toContain('CLAUDE_FALLBACK');
  });
});

// ============================================================
// 3. AGENTS.override.md 存在时跳过 AGENTS.md（陷阱 #140）
// ============================================================
describe('Phase 47 Task 8 - AGENTS.override.md 跳过 AGENTS.md（陷阱 #140）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('override 存在时跳过 AGENTS.md，只加载 override + local', async () => {
    await writeFile(tmpDir, 'AGENTS.md', '# Base\n\nBASE_CONTENT_SHOULD_NOT_APPEAR');
    await writeFile(tmpDir, 'AGENTS.override.md', '# Override\n\nOVERRIDE_CONTENT');
    await writeFile(tmpDir, 'AGENTS.local.md', '# Local\n\nLOCAL_CONTENT');

    const doc = await loadProjectDoc(tmpDir);
    expect(doc).not.toBeNull();
    // override 内容应出现
    expect(doc).toContain('OVERRIDE_CONTENT');
    // local 内容应出现（在 override 之后）
    expect(doc).toContain('LOCAL_CONTENT');
    // base 内容不应出现（陷阱 #140：override 跳过 base）
    expect(doc).not.toContain('BASE_CONTENT_SHOULD_NOT_APPEAR');

    // 验证顺序：override 在 local 之前
    const overrideIdx = doc!.indexOf('OVERRIDE_CONTENT');
    const localIdx = doc!.indexOf('LOCAL_CONTENT');
    expect(overrideIdx).toBeLessThan(localIdx);
  });

  it('仅 override 存在时（无 local）跳过 base，只返回 override', async () => {
    await writeFile(tmpDir, 'AGENTS.md', '# Base\n\nBASE_NOT_USED');
    await writeFile(tmpDir, 'AGENTS.override.md', '# Override Only\n\nOVERRIDE_ONLY');

    const doc = await loadProjectDoc(tmpDir);
    expect(doc).not.toBeNull();
    expect(doc).toContain('OVERRIDE_ONLY');
    expect(doc).not.toContain('BASE_NOT_USED');
  });
});

// ============================================================
// 4. AGENTS.md 不存在时 fallback 到 CLAUDE.md
// ============================================================
describe('Phase 47 Task 8 - fallback 到 CLAUDE.md', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('AGENTS.md 不存在时 fallback 到 CLAUDE.md', async () => {
    await writeFile(tmpDir, 'CLAUDE.md', '# Claude\n\nclaude base content');
    const doc = await loadProjectDoc(tmpDir);
    expect(doc).not.toBeNull();
    expect(doc).toContain('claude base content');
  });

  it('CLAUDE.md + CLAUDE.local.md 合并（local 在后）', async () => {
    await writeFile(tmpDir, 'CLAUDE.md', '# Claude Base\n\nCLAUDE_BASE');
    await writeFile(tmpDir, 'CLAUDE.local.md', '# Claude Local\n\nCLAUDE_LOCAL');

    const doc = await loadProjectDoc(tmpDir);
    expect(doc).not.toBeNull();
    expect(doc).toContain('CLAUDE_BASE');
    expect(doc).toContain('CLAUDE_LOCAL');

    // 验证顺序：base 在前，local 在后
    const baseIdx = doc!.indexOf('CLAUDE_BASE');
    const localIdx = doc!.indexOf('CLAUDE_LOCAL');
    expect(baseIdx).toBeLessThan(localIdx);
  });

  it('AGENTS.md 优先级高于 CLAUDE.md（同时存在时加载 AGENTS.md）', async () => {
    await writeFile(tmpDir, 'AGENTS.md', '# Agents\n\nAGENTS_CONTENT');
    await writeFile(tmpDir, 'CLAUDE.md', '# Claude\n\nCLAUDE_CONTENT_NOT_USED');

    const doc = await loadProjectDoc(tmpDir);
    expect(doc).not.toBeNull();
    expect(doc).toContain('AGENTS_CONTENT');
    expect(doc).not.toContain('CLAUDE_CONTENT_NOT_USED');
  });
});

// ============================================================
// 5. 超过 maxBytes 时截断并警告
// ============================================================
describe('Phase 47 Task 8 - maxBytes 截断', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('超过 maxBytes 时截断并附加截断提示', async () => {
    // 构造一个超过 1024 字节的文档
    const longContent = '# Long Doc\n\n' + 'x'.repeat(2000);
    await writeFile(tmpDir, 'AGENTS.md', longContent);

    const doc = await loadProjectDoc(tmpDir, {
      filenames: ['AGENTS.md', 'AGENTS.local.md', 'AGENTS.override.md'],
      fallbackFilenames: ['CLAUDE.md', 'CLAUDE.local.md'],
      maxBytes: 1024,
    });
    expect(doc).not.toBeNull();
    // 截断后字节数应不超过 maxBytes
    const actualBytes = Buffer.byteLength(doc!, 'utf-8');
    expect(actualBytes).toBeLessThanOrEqual(1024);
    // 应包含截断提示
    expect(doc).toContain('truncated');
  });

  it('未超过 maxBytes 时原样返回', async () => {
    const shortContent = '# Short Doc\n\nshort content';
    await writeFile(tmpDir, 'AGENTS.md', shortContent);

    const doc = await loadProjectDoc(tmpDir, {
      filenames: ['AGENTS.md', 'AGENTS.local.md', 'AGENTS.override.md'],
      fallbackFilenames: ['CLAUDE.md', 'CLAUDE.local.md'],
      maxBytes: 32768,
    });
    expect(doc).not.toBeNull();
    expect(doc).not.toContain('truncated');
    expect(doc).toContain('short content');
  });
});

// ============================================================
// 6. Schema 配置验证 - projectDoc 默认值
// ============================================================
describe('Phase 47 Task 8 - Schema projectDoc 配置', () => {
  it('projectDoc.filenames 默认包含 AGENTS.md / AGENTS.local.md / AGENTS.override.md', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.projectDoc).toBeDefined();
    expect(config.projectDoc.filenames).toContain('AGENTS.md');
    expect(config.projectDoc.filenames).toContain('AGENTS.local.md');
    expect(config.projectDoc.filenames).toContain('AGENTS.override.md');
  });

  it('projectDoc.fallbackFilenames 默认包含 CLAUDE.md / CLAUDE.local.md', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.projectDoc.fallbackFilenames).toContain('CLAUDE.md');
    expect(config.projectDoc.fallbackFilenames).toContain('CLAUDE.local.md');
  });

  it('projectDoc.maxBytes 默认 32768（对齐 Codex 32KiB）', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.projectDoc.maxBytes).toBe(32768);
  });

  it('DEFAULT_CONFIG 包含 projectDoc 配置', () => {
    expect(DEFAULT_CONFIG.projectDoc).toBeDefined();
    expect(DEFAULT_CONFIG.projectDoc.maxBytes).toBe(32768);
  });

  it('用户自定义 projectDoc 配置可覆盖默认值', () => {
    const config = AppConfigSchema.parse({
      projectDoc: {
        maxBytes: 65536,
      },
    }) as AppConfig;
    expect(config.projectDoc.maxBytes).toBe(65536);
    // 自定义 maxBytes 时，filenames 仍使用默认值（preprocess 保证）
    expect(config.projectDoc.filenames).toContain('AGENTS.md');
  });
});

// ============================================================
// 7. mergeDocs / truncateDoc 单元行为
// ============================================================
describe('Phase 47 Task 8 - mergeDocs / truncateDoc 单元', () => {
  it('mergeDocs: base + local 拼接，local 在后', () => {
    const merged = mergeDocs('BASE', 'LOCAL');
    expect(merged).not.toBeNull();
    expect(merged).toContain('BASE');
    expect(merged).toContain('LOCAL');
    expect(merged!.indexOf('BASE')).toBeLessThan(merged!.indexOf('LOCAL'));
  });

  it('mergeDocs: base 为 null 时只返回 local', () => {
    const merged = mergeDocs(null, 'LOCAL');
    expect(merged).toBe('LOCAL');
  });

  it('mergeDocs: 两者都为 null/空时返回 null', () => {
    expect(mergeDocs(null, null)).toBeNull();
    expect(mergeDocs('', '')).toBeNull();
    expect(mergeDocs('   ', '   ')).toBeNull();
  });

  it('truncateDoc: 未超限时原样返回', () => {
    const doc = 'short content';
    const truncated = truncateDoc(doc, 32768);
    expect(truncated).toBe(doc);
  });

  it('truncateDoc: 超限时截断并附加提示', () => {
    const doc = 'x'.repeat(2000);
    const truncated = truncateDoc(doc, 1024);
    expect(Buffer.byteLength(truncated, 'utf-8')).toBeLessThanOrEqual(1024);
    expect(truncated).toContain('truncated');
  });

  it('truncateDoc: 默认 maxBytes 为 32768', () => {
    const doc = 'x'.repeat(100);
    const truncated = truncateDoc(doc);
    expect(truncated).toBe(doc);
  });

  it('DEFAULT_PROJECT_DOC_CONFIG 与 schema 默认值一致', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(DEFAULT_PROJECT_DOC_CONFIG.filenames).toEqual(config.projectDoc.filenames);
    expect(DEFAULT_PROJECT_DOC_CONFIG.fallbackFilenames).toEqual(config.projectDoc.fallbackFilenames);
    expect(DEFAULT_PROJECT_DOC_CONFIG.maxBytes).toBe(config.projectDoc.maxBytes);
  });
});
