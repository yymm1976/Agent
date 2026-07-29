// tests/agents/profiles-version.test.ts
// Agent Profile 版本管理测试
//
// 覆盖：
//   1. VersionManager 保存/列出/加载/回滚版本
//   2. 版本保留策略（最多保留 20 个版本，对齐 MAX_VERSIONS_PER_PROFILE）
//   3. 字段变更追踪与 changeSummary
//   4. AgentProfileManager 集成：saveProfile 自动生成版本
//   5. rollback 回滚操作
//   6. 删除 Profile 同时删除版本目录

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VersionManager } from '../../src/agents/profiles/version-manager.js';
import { type AgentProfile } from '../../src/agents/profiles/types.js';
import { AgentProfileManager } from '../../src/agents/profiles/manager.js';
import { RESEARCHER_PROFILE } from '../../src/agents/profiles/builtin-templates.js';

// ============================================================
// 工具
// ============================================================

async function makeTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `routedev-version-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 构造一个合法的 AgentProfile（基于 researcher 模板） */
function makeValidProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    ...RESEARCHER_PROFILE,
    id: 'test-version-profile',
    name: 'Test Version Profile',
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
// VersionManager 独立测试
// ============================================================

describe('VersionManager', () => {
  let rootDir: string;
  let vm: VersionManager;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    vm = new VersionManager(rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('1. saveVersion 保存版本并返回 versionId', async () => {
    const profile = makeValidProfile({ id: 'profile-1', name: 'v1' });
    const versionId = await vm.saveVersion(profile, 'test_save', undefined);
    expect(versionId).toBeTruthy();
    expect(typeof versionId).toBe('string');
    expect(versionId.length).toBeGreaterThan(0);
  });

  it('2. listVersions 列出保存的版本', async () => {
    const profile = makeValidProfile({ id: 'profile-list', name: 'v1' });
    await vm.saveVersion(profile, 'test_list', undefined);
    const records = await vm.listVersions(profile.id);
    expect(records.length).toBe(1);
    expect(records[0].profileId).toBe(profile.id);
    expect(records[0].source).toBe('test_list');
    expect(records[0].fieldChanges).toEqual([]);
    expect(records[0].changeSummary).toBe('');
    expect(records[0].versionId).toBeTruthy();
  });

  it('3. 多次保存产生多个版本', async () => {
    const profile = makeValidProfile({ id: 'profile-multi', name: 'v1' });
    await vm.saveVersion(profile, 'test_multi', undefined);

    const profile2 = { ...profile, name: 'v2', updatedAt: Date.now() };
    await vm.saveVersion(profile2, 'test_multi', profile);

    const records = await vm.listVersions(profile.id);
    expect(records.length).toBe(2);
    // 最近的在前
    expect(records[0].timestamp).toBeGreaterThanOrEqual(records[1].timestamp);
  });

  it('4. loadVersion 返回指定版本的 snapshot', async () => {
    const profile = makeValidProfile({ id: 'profile-load', name: 'v1' });
    const versionId = await vm.saveVersion(profile, 'test_load', undefined);
    const record = await vm.loadVersion(profile.id, versionId);
    expect(record).toBeTruthy();
    // loadVersion 返回 VersionRecord（含 meta + snapshot），snapshot 才是 AgentProfile 快照
    expect(record?.snapshot?.name).toBe('v1');
    expect(record?.meta?.profileId).toBe(profile.id);
  });

  it('5. loadVersion 不存在的版本抛错', async () => {
    await expect(
      vm.loadVersion('nonexistent', 'no-such-version'),
    ).rejects.toThrow();
  });

  it('6. 版本保留策略：超过 maxVersionsPerProfile 个版本时删除旧版本', async () => {
    // 默认 maxVersionsPerProfile = 20
    const profile = makeValidProfile({ id: 'profile-retention', name: 'v0' });
    let prev: AgentProfile | undefined;
    // 保存 25 个版本
    for (let i = 0; i < 25; i++) {
      const p = { ...profile, name: `v${i}`, updatedAt: 1700000000000 + i * 1000 };
      await vm.saveVersion(p, 'test_retention', prev);
      prev = p;
    }
    const records = await vm.listVersions(profile.id);
    expect(records.length).toBeLessThanOrEqual(20);
  });

  it('7. 首次保存（无前快照）fieldChanges 为空', async () => {
    const profile = makeValidProfile({ id: 'profile-field', name: 'v1' });
    await vm.saveVersion(profile, 'test_field', undefined);
    const records = await vm.listVersions(profile.id);
    expect(records[0].fieldChanges).toEqual([]);
    expect(records[0].changeSummary).toBe('');
  });

  it('8. 第二次保存记录字段变更', async () => {
    const profile = makeValidProfile({ id: 'profile-field2', name: 'v1', maxSteps: 20 });
    await vm.saveVersion(profile, 'test_field2', undefined);

    const profile2: AgentProfile = {
      ...profile,
      name: 'v2',
      maxSteps: 30,
      description: '新描述',
      updatedAt: Date.now(),
    };
    await vm.saveVersion(profile2, 'test_field2', profile);

    const records = await vm.listVersions(profile.id);
    // 最新版本在前，取第 0 条
    const latest = records[0];
    expect(latest.fieldChanges.length).toBeGreaterThanOrEqual(2); // name + maxSteps
    const changedFields = latest.fieldChanges.map((f) => f.field);
    expect(changedFields).toContain('name');
    expect(changedFields).toContain('maxSteps');
    // changeSummary 非空
    expect(latest.changeSummary.length).toBeGreaterThan(0);
  });

  it('9. deleteAllVersions 删除版本目录', async () => {
    const profile = makeValidProfile({ id: 'profile-del', name: 'v1' });
    await vm.saveVersion(profile, 'test_del', undefined);
    const versionsDir = path.join(rootDir, '.routedev', 'skills', 'agents', profile.id, 'versions');
    expect(fsSync.existsSync(versionsDir)).toBe(true);

    await vm.deleteAllVersions(profile.id);
    expect(fsSync.existsSync(versionsDir)).toBe(false);
  });

  it('10. deleteAllVersions 不存在的 Profile 不抛错', async () => {
    // 不应抛出异常
    await expect(vm.deleteAllVersions('nonexistent')).resolves.toBeUndefined();
  });

  it('11. rollbackTo 返回回滚后的 Profile', async () => {
    const profile = makeValidProfile({ id: 'profile-rollback', name: 'v1' });
    const versionId = await vm.saveVersion(profile, 'test_rollback', undefined);

    const profile2: AgentProfile = { ...profile, name: 'v2', updatedAt: Date.now() };
    await vm.saveVersion(profile2, 'test_rollback', profile);

    // 回滚到 v1
    const rolled = await vm.rollbackTo(profile.id, versionId);
    expect(rolled.name).toBe('v1');
    expect(rolled.id).toBe(profile.id);
  });

  it('12. rollbackTo 不存在的版本抛错', async () => {
    const profile = makeValidProfile({ id: 'profile-rollback-fail', name: 'v1' });
    await vm.saveVersion(profile, 'test_rollback_fail', undefined);

    await expect(
      vm.rollbackTo(profile.id, 'nonexistent-version'),
    ).rejects.toThrow();
  });

  it('13. 并行保存不冲突（基本并发安全）', async () => {
    const profile = makeValidProfile({ id: 'profile-concurrent', name: 'v1' });
    const promises = [];
    for (let i = 0; i < 10; i++) {
      const p = { ...profile, name: `v${i}`, updatedAt: 1700000000000 + i * 1000 };
      promises.push(vm.saveVersion(p, 'test_concurrent', profile));
    }
    await Promise.all(promises);
    const records = await vm.listVersions(profile.id);
    // 最多保留 20 个，这里共 11 个（1 原始 + 10 并行）
    expect(records.length).toBeGreaterThanOrEqual(10);
    expect(records.length).toBeLessThanOrEqual(20);
  });
});

// ============================================================
// AgentProfileManager + VersionManager 集成测试
// ============================================================

describe('AgentProfileManager 版本管理集成', () => {
  let rootDir: string;
  let manager: AgentProfileManager;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    manager = new AgentProfileManager(rootDir);
    await manager.loadAll();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('14. getVersionManager 返回 VersionManager 实例', () => {
    const vm = manager.getVersionManager();
    expect(vm).toBeInstanceOf(VersionManager);
  });

  it('15. saveProfile 自动生成版本快照', async () => {
    const profile = makeValidProfile({ id: 'integ-save', name: 'integ-v1' });
    await manager.saveProfile(profile);

    const vm = manager.getVersionManager();
    const records = await vm.listVersions('integ-save');
    expect(records.length).toBe(1);
    expect(records[0].source).toBe('programmatic_write');
    expect(records[0].profileId).toBe('integ-save');
  });

  it('16. 多次 saveProfile 产生多个版本（含 fieldChanges）', async () => {
    const profile = makeValidProfile({ id: 'integ-multi', name: 'v1' });
    await manager.saveProfile(profile);

    const profile2: AgentProfile = {
      ...profile,
      name: 'v2',
      maxSteps: 50,
      updatedAt: Date.now(),
    };
    await manager.saveProfile(profile2);

    const vm = manager.getVersionManager();
    const records = await vm.listVersions('integ-multi');
    expect(records.length).toBe(2);

    // 最新版本应有 fieldChanges
    const latest = records[0];
    expect(latest.fieldChanges.length).toBeGreaterThanOrEqual(1);
    const fields = latest.fieldChanges.map((f) => f.field);
    expect(fields).toContain('name');
  });

  it('17. rollback 回滚 Profile 到指定版本', async () => {
    const profile = makeValidProfile({ id: 'integ-rollback', name: 'v1', maxSteps: 20 });
    await manager.saveProfile(profile);

    // 修改并保存
    const profile2: AgentProfile = {
      ...profile,
      name: 'v2',
      maxSteps: 50,
      updatedAt: Date.now(),
    };
    await manager.saveProfile(profile2);

    // 确认当前为 v2
    const before = await manager.getProfile('integ-rollback');
    expect(before?.name).toBe('v2');
    expect(before?.maxSteps).toBe(50);

    // 获取版本 ID
    const vm = manager.getVersionManager();
    const records = await vm.listVersions('integ-rollback');
    const oldest = records[records.length - 1]; // 最早的版本

    // 回滚到 v1
    const rolled = await manager.rollback('integ-rollback', oldest.versionId);
    expect(rolled.name).toBe('v1');
    expect(rolled.maxSteps).toBe(20);
    expect(rolled.isBuiltin).toBe(false);

    // 验证缓存已更新
    const after = await manager.getProfile('integ-rollback');
    expect(after?.name).toBe('v1');
  });

  it('18. rollback 不存在的版本抛错', async () => {
    const profile = makeValidProfile({ id: 'integ-rollback-fail', name: 'v1' });
    await manager.saveProfile(profile);

    await expect(
      manager.rollback('integ-rollback-fail', 'no-such-version'),
    ).rejects.toThrow();
  });

  it('19. deleteProfile 删除整个目录（含版本子目录）', async () => {
    const profile = makeValidProfile({ id: 'integ-delete', name: 'v1' });
    await manager.saveProfile(profile);

    // 确认目录存在
    const profileDir = path.join(rootDir, '.routedev', 'skills', 'agents', 'integ-delete');
    expect(fsSync.existsSync(profileDir)).toBe(true);

    await manager.deleteProfile('integ-delete');
    expect(fsSync.existsSync(profileDir)).toBe(false);

    // 版本管理器中的版本也被清除（目录删除了）
    const vm = manager.getVersionManager();
    const records = await vm.listVersions('integ-delete');
    expect(records).toEqual([]);
  });

  it('20. duplicateProfile 保留角色的同时生成新版本历史', async () => {
    await manager.loadAll();
    const copy = await manager.duplicateProfile('builtin-researcher', 'Version Copy');
    expect(copy.isBuiltin).toBe(false);
    expect(copy.role).toBe('researcher');

    // 新 Profile 有版本快照
    const vm = manager.getVersionManager();
    const records = await vm.listVersions(copy.id);
    expect(records.length).toBe(1);
    expect(records[0].source).toBe('programmatic_write');
  });

  it('21. importProfile 导入后生成版本快照', async () => {
    // 先导出一个
    const profile = makeValidProfile({ id: 'export-src', name: 'Export' });
    await manager.saveProfile(profile);
    const exportPath = path.join(rootDir, 'exported', 'export-src.md');
    await manager.exportProfile('export-src', exportPath);

    // 再导入
    const imported = await manager.importProfile(exportPath);
    expect(imported.isBuiltin).toBe(false);

    // 导入应有版本快照
    const vm = manager.getVersionManager();
    const records = await vm.listVersions(imported.id);
    expect(records.length).toBe(1);
    expect(records[0].source).toBe('programmatic_write');
  });

  it('22. saveProfile 可标记 user_edit 来源（UI 保存路径）', async () => {
    const profile = makeValidProfile({ id: 'integ-user-edit', name: 'ui-v1' });
    await manager.saveProfile(profile, 'user_edit');

    const vm = manager.getVersionManager();
    const records = await vm.listVersions('integ-user-edit');
    expect(records.length).toBe(1);
    expect(records[0].source).toBe('user_edit');
  });

  it('23. diffVersions / diffCurrentWith 返回字段级差异', async () => {
    const profile = makeValidProfile({ id: 'integ-diff', name: 'diff-v1', maxSteps: 10 });
    await manager.saveProfile(profile);

    const profile2: AgentProfile = {
      ...profile,
      name: 'diff-v2',
      maxSteps: 30,
      updatedAt: Date.now(),
    };
    await manager.saveProfile(profile2);

    const vm = manager.getVersionManager();
    const records = await vm.listVersions('integ-diff');
    expect(records.length).toBe(2);

    const newest = records[0];
    const oldest = records[records.length - 1];

    // 两个历史版本 diff
    const versionDiffs = await vm.diffVersions('integ-diff', oldest.versionId, newest.versionId);
    const versionFields = versionDiffs.map((d) => d.field);
    expect(versionFields).toContain('name');
    expect(versionFields).toContain('maxSteps');

    const nameDiff = versionDiffs.find((d) => d.field === 'name');
    expect(nameDiff?.before).toBe('diff-v1');
    expect(nameDiff?.after).toBe('diff-v2');

    // 当前内存 Profile 与历史版本 diff
    const current = await manager.getProfile('integ-diff');
    expect(current).toBeTruthy();
    const currentDiffs = await vm.diffCurrentWith('integ-diff', current!, oldest.versionId);
    const currentFields = currentDiffs.map((d) => d.field);
    expect(currentFields).toContain('name');
    expect(currentFields).toContain('maxSteps');
  });
});
