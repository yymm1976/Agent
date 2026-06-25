// tests/agents/profiles.test.ts
// Agent Profile 体系测试
//
// 覆盖：
//   1. validateProfile 合法/非法判定
//   2. 内置模板字段断言（researcher / executor / reviewer）
//   3. AgentProfileManager 增删改查
//   4. resolveProfileForTask 角色解析与回退
//   5. SKILL.md 序列化/解析往返一致

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  validateProfile,
  type AgentProfile,
} from '../../src/agents/profiles/types.js';
import {
  RESEARCHER_PROFILE,
  EXECUTOR_PROFILE,
  REVIEWER_PROFILE,
  BUILTIN_PROFILES,
} from '../../src/agents/profiles/builtin-templates.js';
import { AgentProfileManager } from '../../src/agents/profiles/manager.js';

// ============================================================
// 工具
// ============================================================

async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-profile-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 构造一个合法的 AgentProfile（基于 researcher 模板） */
function makeValidProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    ...RESEARCHER_PROFILE,
    id: 'test-profile',
    name: 'Test Profile',
    isBuiltin: false,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    allowedTools: [...RESEARCHER_PROFILE.allowedTools],
    forbiddenTools: [...RESEARCHER_PROFILE.forbiddenTools],
    boundSkills: [],
    ...overrides,
  };
}

// ============================================================
// validateProfile
// ============================================================

describe('validateProfile', () => {
  it('1. 合法 Profile 通过校验', () => {
    const errors = validateProfile(makeValidProfile());
    expect(errors).toEqual([]);
  });

  it('2. 拒绝空 name', () => {
    const errors = validateProfile(makeValidProfile({ name: '' }));
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('name');
  });

  it('3. 拒绝空 modelId', () => {
    const errors = validateProfile(makeValidProfile({ modelId: '' }));
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('modelId');
  });

  it('4. 拒绝 maxTokens <= 0', () => {
    const errors = validateProfile(makeValidProfile({ maxTokens: 0 }));
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('maxTokens');

    const errorsNeg = validateProfile(makeValidProfile({ maxTokens: -100 }));
    expect(errorsNeg.map((e) => e.field)).toContain('maxTokens');
  });

  it('5. 拒绝 maxSteps <= 0', () => {
    const errors = validateProfile(makeValidProfile({ maxSteps: 0 }));
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('maxSteps');

    const errorsNeg = validateProfile(makeValidProfile({ maxSteps: -1 }));
    expect(errorsNeg.map((e) => e.field)).toContain('maxSteps');
  });
});

// ============================================================
// 内置模板字段断言
// ============================================================

describe('内置模板字段', () => {
  it('6. researcher 模板 allowedTools 不含写操作', () => {
    const writeOps = ['file_write', 'file_edit', 'execute_command', 'run_tests'];
    for (const op of writeOps) {
      expect(RESEARCHER_PROFILE.allowedTools).not.toContain(op);
    }
  });

  it('7. executor 模板 allowedTools 含 file_write', () => {
    expect(EXECUTOR_PROFILE.allowedTools).toContain('file_write');
    expect(EXECUTOR_PROFILE.allowedTools).toContain('file_edit');
  });

  it('8. reviewer 模板 allowedTools 不含 file_write', () => {
    expect(REVIEWER_PROFILE.allowedTools).not.toContain('file_write');
    expect(REVIEWER_PROFILE.allowedTools).not.toContain('file_edit');
  });

  it('9. researcher 模板 canChallenge = true', () => {
    expect(RESEARCHER_PROFILE.canChallenge).toBe(true);
  });

  it('10. executor 模板 outputFormat = code_change', () => {
    expect(EXECUTOR_PROFILE.outputFormat).toBe('code_change');
  });

  it('11. reviewer 模板 outputFormat = review_report', () => {
    expect(REVIEWER_PROFILE.outputFormat).toBe('review_report');
  });

  it('内置模板 isBuiltin 全部为 true', () => {
    for (const p of BUILTIN_PROFILES) {
      expect(p.isBuiltin).toBe(true);
    }
  });

  it('内置模板 systemPrompt 含角色定位与禁止事项', () => {
    for (const p of BUILTIN_PROFILES) {
      expect(p.systemPrompt).toContain('角色定位');
      expect(p.systemPrompt).toContain('禁止事项');
      expect(p.systemPrompt).toContain('质疑权利');
    }
  });
});

// ============================================================
// AgentProfileManager
// ============================================================

describe('AgentProfileManager', () => {
  let rootDir: string;
  let manager: AgentProfileManager;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    manager = new AgentProfileManager(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('12. loadAll 加载内置模板', async () => {
    await manager.loadAll();
    const list = await manager.listProfiles();
    const ids = list.map((p) => p.id);
    expect(ids).toContain('builtin-researcher');
    expect(ids).toContain('builtin-executor');
    expect(ids).toContain('builtin-reviewer');
    expect(list.length).toBeGreaterThanOrEqual(3);
  });

  it('13. saveProfile 保存自定义 Profile', async () => {
    const custom = makeValidProfile({ id: 'my-custom-1', name: 'My Custom' });
    await manager.saveProfile(custom);

    // 写盘检查
    const skillMdPath = path.join(rootDir, '.routedev', 'skills', 'agents', 'my-custom-1', 'SKILL.md');
    expect(fsSync.existsSync(skillMdPath)).toBe(true);

    // 重新加载能读到
    const fresh = new AgentProfileManager(rootDir);
    await fresh.loadAll();
    const got = await fresh.getProfile('my-custom-1');
    expect(got).not.toBeNull();
    expect(got?.name).toBe('My Custom');
    expect(got?.isBuiltin).toBe(false);
  });

  it('14. deleteProfile 删除自定义', async () => {
    const custom = makeValidProfile({ id: 'to-delete', name: 'To Delete' });
    await manager.saveProfile(custom);
    expect(await manager.getProfile('to-delete')).not.toBeNull();

    await manager.deleteProfile('to-delete');
    expect(await manager.getProfile('to-delete')).toBeNull();

    // 磁盘也删除
    const dir = path.join(rootDir, '.routedev', 'skills', 'agents', 'to-delete');
    expect(fsSync.existsSync(dir)).toBe(false);
  });

  it('15. deleteProfile 拒绝删除内置', async () => {
    await manager.loadAll();
    await expect(manager.deleteProfile('builtin-researcher')).rejects.toThrow(/builtin/);
    expect(await manager.getProfile('builtin-researcher')).not.toBeNull();
  });

  it('16. duplicateProfile 复制内置为自定义', async () => {
    await manager.loadAll();
    const copy = await manager.duplicateProfile('builtin-researcher', 'My Researcher Copy');
    expect(copy.id).not.toBe('builtin-researcher');
    expect(copy.name).toBe('My Researcher Copy');
    expect(copy.isBuiltin).toBe(false);

    // 缓存中能查到
    const got = await manager.getProfile(copy.id);
    expect(got).not.toBeNull();
    expect(got?.name).toBe('My Researcher Copy');

    // 磁盘也写入
    const dir = path.join(rootDir, '.routedev', 'skills', 'agents', copy.id);
    expect(fsSync.existsSync(dir)).toBe(true);
  });

  it('17. resetBuiltin 重置内置模板', async () => {
    await manager.loadAll();

    // 先复制一个自定义 researcher
    const copy = await manager.duplicateProfile('builtin-researcher', 'Temp Copy');
    expect(await manager.getProfile(copy.id)).not.toBeNull();

    // 重置
    await manager.resetBuiltin('researcher');

    // 自定义版本被删除
    expect(await manager.getProfile(copy.id)).toBeNull();

    // 内置模板仍存在
    const builtin = await manager.getProfile('builtin-researcher');
    expect(builtin).not.toBeNull();
    expect(builtin?.role).toBe('researcher');
  });

  it('18. resolveProfileForTask 按角色返回正确 Profile', async () => {
    await manager.loadAll();

    const researcher = manager.resolveProfileForTask('researcher');
    expect(researcher.role).toBe('researcher');

    const executor = manager.resolveProfileForTask('executor');
    expect(executor.role).toBe('executor');

    const reviewer = manager.resolveProfileForTask('reviewer');
    expect(reviewer.role).toBe('reviewer');
  });

  it('19. resolveProfileForTask 未知角色回退到 executor', async () => {
    await manager.loadAll();
    // custom 角色无内置模板，应回退到 executor
    const fallback = manager.resolveProfileForTask('custom');
    expect(fallback.role).toBe('executor');
  });

  it('20. SKILL.md 序列化/解析往返一致', async () => {
    await manager.loadAll();
    const original = makeValidProfile({
      id: 'roundtrip-profile',
      name: 'Roundtrip',
      systemPrompt: '# 角色\n这是测试用 system prompt。\n\n含多行内容。',
      allowedTools: ['read_file', 'code_map_explore'],
      forbiddenTools: ['file_write'],
      boundSkills: ['skill-a', 'skill-b'],
      maxTokens: 128000,
      maxSteps: 25,
    });
    await manager.saveProfile(original);

    // 重新加载，比对字段
    const fresh = new AgentProfileManager(rootDir);
    await fresh.loadAll();
    const got = await fresh.getProfile('roundtrip-profile');
    expect(got).not.toBeNull();
    if (!got) return;

    expect(got.id).toBe(original.id);
    expect(got.name).toBe(original.name);
    expect(got.type).toBe('agent-profile');
    expect(got.version).toBe(original.version);
    expect(got.role).toBe(original.role);
    expect(got.modelId).toBe(original.modelId);
    expect(got.description).toBe(original.description);
    expect(got.systemPrompt).toBe(original.systemPrompt);
    expect(got.allowedTools).toEqual(original.allowedTools);
    expect(got.forbiddenTools).toEqual(original.forbiddenTools);
    expect(got.canChallenge).toBe(original.canChallenge);
    expect(got.challengeSeverity).toBe(original.challengeSeverity);
    expect(got.outputFormat).toBe(original.outputFormat);
    expect(got.boundSkills).toEqual(original.boundSkills);
    expect(got.maxTokens).toBe(original.maxTokens);
    expect(got.maxSteps).toBe(original.maxSteps);
    expect(got.isBuiltin).toBe(original.isBuiltin);
  });

  it('exportProfile / importProfile 往返', async () => {
    await manager.loadAll();
    const custom = makeValidProfile({ id: 'export-src', name: 'Export Src' });
    await manager.saveProfile(custom);

    const exportPath = path.join(rootDir, 'exported', 'export-src.md');
    await manager.exportProfile('export-src', exportPath);
    expect(fsSync.existsSync(exportPath)).toBe(true);

    const imported = await manager.importProfile(exportPath);
    expect(imported.id).not.toBe('export-src');
    expect(imported.name).toBe('Export Src');
    expect(imported.isBuiltin).toBe(false);
  });
});
