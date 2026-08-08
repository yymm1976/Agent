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
import { VersionManager, MigrationPlanCorruptError } from '../../src/agents/profiles/version-manager.js';
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

describe('A3 legacy revision migration', () => {
  let tempDir: string;
  let vm: VersionManager;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    vm = new VersionManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** 手工写一个无 revision 的 legacy 版本文件 */
  function writeLegacyVersion(profileId: string, versionId: string, timestamp: number): void {
    const dir = path.join(tempDir, '.routedev', 'skills', 'agents', profileId, 'versions');
    fsSync.mkdirSync(dir, { recursive: true });
    const record = {
      meta: {
        versionId,
        profileId,
        timestamp,
        source: 'user_edit' as const,
        fieldChanges: [],
        changeSummary: 'legacy',
      },
      snapshot: makeValidProfile({ id: profileId, name: versionId }),
    };
    fsSync.writeFileSync(path.join(dir, `${versionId}.json`), JSON.stringify(record, null, 2), 'utf-8');
  }

  function readMeta(profileId: string, versionId: string): { revision?: number; timestamp: number } {
    const raw = fsSync.readFileSync(
      path.join(tempDir, '.routedev', 'skills', 'agents', profileId, 'versions', `${versionId}.json`),
      'utf-8',
    );
    return JSON.parse(raw).meta;
  }

  it('legacy 2 versions → migrate（timestamp ASC 赋号 1,2）', async () => {
    writeLegacyVersion('p1', 'v-older', 1000);
    writeLegacyVersion('p1', 'v-newer', 2000);
    const max = vm.ensureRevisions('p1');
    expect(max).toBe(2);
    expect(readMeta('p1', 'v-older').revision).toBe(1);
    expect(readMeta('p1', 'v-newer').revision).toBe(2);
  });

  it('legacy same timestamp → versionId ASC 确定性', async () => {
    writeLegacyVersion('p1', 'b-ver', 1000);
    writeLegacyVersion('p1', 'a-ver', 1000);
    vm.ensureRevisions('p1');
    expect(readMeta('p1', 'a-ver').revision).toBe(1);
    expect(readMeta('p1', 'b-ver').revision).toBe(2);
  });

  it('migration 幂等（重复调用不重复编号）', async () => {
    writeLegacyVersion('p1', 'v1', 1000);
    writeLegacyVersion('p1', 'v2', 2000);
    vm.ensureRevisions('p1');
    vm.ensureRevisions('p1');
    expect(readMeta('p1', 'v1').revision).toBe(1);
    expect(readMeta('p1', 'v2').revision).toBe(2);
  });

  it('migrate → save new（新版本从 N+1 起）', async () => {
    writeLegacyVersion('p1', 'v1', 1000);
    vm.ensureRevisions('p1');
    const newId = await vm.saveVersion(makeValidProfile({ id: 'p1' }), 'user_edit');
    const newMeta = readMeta('p1', newId);
    expect(newMeta.revision).toBe(2);
  });

  it('20 legacy + new → retention 必须保留 new（不因 legacy timestamp 巨大误删）', async () => {
    for (let i = 0; i < 20; i += 1) {
      writeLegacyVersion('p1', `legacy-${i}`, 1000 + i);
    }
    vm.ensureRevisions('p1');
    const newId = await vm.saveVersion(makeValidProfile({ id: 'p1', name: 'newest' }), 'user_edit');
    const versions = await vm.listVersions('p1');
    // 最新在前：第一个必须是 new（revision 21）
    expect(versions[0]!.versionId).toBe(newId);
    expect(versions[0]!.revision).toBe(21);
  });

  it('migration 中存在 corrupt JSON：跳过不阻塞', async () => {
    writeLegacyVersion('p1', 'v-good', 1000);
    const dir = path.join(tempDir, '.routedev', 'skills', 'agents', 'p1', 'versions');
    fsSync.writeFileSync(path.join(dir, 'corrupt.json'), '{ not json', 'utf-8');
    const max = vm.ensureRevisions('p1');
    expect(max).toBe(1);
    expect(readMeta('p1', 'v-good').revision).toBe(1);
  });

  it('migrate → restart（新 manager 实例）→ 仍正确', async () => {
    writeLegacyVersion('p1', 'v1', 1000);
    writeLegacyVersion('p1', 'v2', 2000);
    vm.ensureRevisions('p1');
    // 模拟重启：新实例
    const vm2 = new VersionManager(tempDir);
    const max2 = vm2.ensureRevisions('p1');
    expect(max2).toBe(2);
    expect(readMeta('p1', 'v1').revision).toBe(1);
    const newId = await vm2.saveVersion(makeValidProfile({ id: 'p1' }), 'programmatic_write');
    expect(readMeta('p1', newId).revision).toBe(3);
  });

  it('P1-1 OLD→FAIL：20 legacy + 1 已 revision 的新版本 → 迁移后新版本仍 newest，retention 保留新版本', async () => {
    // 混合态：先写 20 个 legacy（无 revision），再模拟"旧版 RouteDev"保存一个 revision=1 的新版本
    for (let i = 0; i < 20; i += 1) {
      writeLegacyVersion('p1', `legacy-${i}`, 1000 + i);
    }
    const dir = path.join(tempDir, '.routedev', 'skills', 'agents', 'p1', 'versions');
    const newRecord = {
      meta: { versionId: 'new-v1', profileId: 'p1', timestamp: 9999999999999, revision: 1, source: 'user_edit', fieldChanges: [], changeSummary: 'new' },
      snapshot: makeValidProfile({ id: 'p1', name: 'newest' }),
    };
    fsSync.writeFileSync(path.join(dir, 'new-v1.json'), JSON.stringify(newRecord, null, 2), 'utf-8');

    vm.ensureRevisions('p1');
    const versions = await vm.listVersions('p1');
    // 不变量：newer revision > older revision——new-v1 必须是最新（revision 21）
    expect(versions[0]!.versionId).toBe('new-v1');
    expect(versions[0]!.revision).toBe(21);
    // 20 个 legacy 排在其后（revision 1..20）
    expect(versions[1]!.revision).toBe(20);
    expect(versions[versions.length - 1]!.revision).toBe(1);
    // retention：不超过上限时不删（这里 21 个 > 20 上限——删除最旧，必须保留 new-v1）
    // 直接验证排序后 retention 的删除目标是最旧的 legacy 而非 new-v1
    vm.enforceRetention('p1');
    const after = await vm.listVersions('p1');
    expect(after.some((v) => v.versionId === 'new-v1')).toBe(true); // new 保留
    expect(after.every((v) => v.revision <= after[0]!.revision)).toBe(true); // 排序一致
  });

  it('P1-1：listVersions 在未保存新版本时也先迁移（混合态排序不再跨数值域）', async () => {
    writeLegacyVersion('p1', 'legacy-a', 1000);
    writeLegacyVersion('p1', 'legacy-b', 2000);
    // 不调用 ensureRevisions——listVersions 内部应迁移
    const versions = await vm.listVersions('p1');
    expect(versions.length).toBe(2);
    expect(versions[0]!.versionId).toBe('legacy-b'); // timestamp 大 = 新
    expect(versions[0]!.revision).toBe(2);
    // 迁移 marker 已写——重复调用幂等
    const again = await vm.listVersions('p1');
    expect(again[0]!.revision).toBe(2);
  });

  it('F-011：迁移在第 N 个文件提交后崩溃（plan 已持久化）→ resume 恢复为与 clean migration 完全相同的映射', async () => {
    // 初始：3 个 legacy + 1 个已 revision 的新版本（混合态）
    const setupDir = (profileId: string, base: string) => {
      const dir = path.join(base, '.routedev', 'skills', 'agents', profileId, 'versions');
      fsSync.mkdirSync(dir, { recursive: true });
      const rec = (id: string, ts: number) => ({
        meta: { versionId: id, profileId, timestamp: ts, source: 'user_edit', fieldChanges: [], changeSummary: 'legacy' },
        snapshot: makeValidProfile({ id: profileId, name: id }),
      });
      const rec2 = (id: string, rev: number) => ({
        meta: { versionId: id, profileId, timestamp: 9999999999999, revision: rev, source: 'user_edit', fieldChanges: [], changeSummary: 'new' },
        snapshot: makeValidProfile({ id: profileId, name: id }),
      });
      for (const [id, ts] of [['legacy-a', 1000], ['legacy-b', 2000], ['legacy-c', 3000]]) {
        fsSync.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec(id, ts), null, 2), 'utf-8');
      }
      fsSync.writeFileSync(path.join(dir, 'new-v1.json'), JSON.stringify(rec2('new-v1', 1), null, 2), 'utf-8');
      return dir;
    };

    // 参考：clean migration 的最终映射（4 个文件：legacy-a:1, legacy-b:2, legacy-c:3, new-v1:4）
    const cleanBase = tempDir + '-clean';
    fsSync.mkdirSync(cleanBase, { recursive: true });
    setupDir('p-clean', cleanBase);
    const vmClean = new VersionManager(cleanBase);
    vmClean.ensureRevisions('p-clean');
    const cleanMapping = (await vmClean.listVersions('p-clean')).map((v) => `${v.versionId}:${v.revision}`).sort().join(',');

    // 每个提交点（N=4 文件，崩溃发生在第 1..3 个之后）注入崩溃
    const order = ['legacy-a', 'legacy-b', 'legacy-c', 'new-v1']; // plan 中的执行顺序（legacy 先）
    for (let crashAfter = 1; crashAfter <= 3; crashAfter += 1) {
      const base = tempDir + `-crash-${crashAfter}`;
      fsSync.mkdirSync(base, { recursive: true });
      const versionsDir = setupDir('p1', base);
      // 手工写不可变 plan（模拟 ensureRevisions 第一步已执行）
      const plan = { schema: 2, entries: order.map((f, i) => ({ file: `${f}.json`, targetRevision: i + 1 })) };
      fsSync.writeFileSync(path.join(versionsDir, '.revision-schema-v2.plan.json'), JSON.stringify(plan, null, 2), 'utf-8');
      // 迁移前 crashAfter 个文件（模拟崩溃在 rename #crashAfter 后）
      for (let i = 0; i < crashAfter; i += 1) {
        const f = path.join(versionsDir, `${order[i]}.json`);
        const r = JSON.parse(fsSync.readFileSync(f, 'utf-8'));
        r.meta.revision = i + 1;
        fsSync.writeFileSync(f, JSON.stringify(r, null, 2), 'utf-8');
      }
      // marker 不存在（崩溃未提交）
      // 崩溃恢复：新实例按 plan resume
      const vmResume = new VersionManager(base);
      vmResume.ensureRevisions('p1');
      const resumed = (await vmResume.listVersions('p1')).map((v) => `${v.versionId}:${v.revision}`).sort().join(',');
      // 与 clean migration 完全相同的逐文件映射
      expect(resumed).toBe(cleanMapping);
      const revs = (await vmResume.listVersions('p1')).map((v) => v.revision);
      expect(new Set(revs).size).toBe(revs.length); // 无 collision
      // marker 已提交（迁移完成）
      expect(fsSync.existsSync(path.join(versionsDir, '.revision-schema-v2'))).toBe(true);
      await fs.rm(base, { recursive: true, force: true });
    }
    await fs.rm(cleanBase, { recursive: true, force: true });
  });

  describe('GA Hardening 第5项：corrupt-plan fail-closed', () => {
    let versionsDir: string;

    beforeEach(() => {
      // 3 个 legacy + 半迁移态（legacy-a 已写 revision=1，模拟崩溃后恢复现场）
      writeLegacyVersion('p1', 'legacy-a', 1000);
      writeLegacyVersion('p1', 'legacy-b', 2000);
      writeLegacyVersion('p1', 'legacy-c', 3000);
      versionsDir = path.join(tempDir, '.routedev', 'skills', 'agents', 'p1', 'versions');
      // 半迁移：legacy-a 已被旧 plan 写过 revision=1
      const fa = path.join(versionsDir, 'legacy-a.json');
      const ra = JSON.parse(fsSync.readFileSync(fa, 'utf-8'));
      ra.meta.revision = 1;
      fsSync.writeFileSync(fa, JSON.stringify(ra, null, 2), 'utf-8');
    });

    function snapshotRevisions(): Record<string, number | undefined> {
      const out: Record<string, number | undefined> = {};
      for (const f of fsSync.readdirSync(versionsDir)) {
        if (!f.endsWith('.json')) continue;
        if (f.startsWith('.revision-schema-v2')) continue; // plan/marker 非版本文件
        const r = JSON.parse(fsSync.readFileSync(path.join(versionsDir, f), 'utf-8'));
        out[f] = r.meta.revision;
      }
      return out;
    }

    it('plan JSON 损坏 → 抛 MigrationPlanCorruptError，不重扫/不覆盖/不写 marker', () => {
      fsSync.writeFileSync(path.join(versionsDir, '.revision-schema-v2.plan.json'), '{ broken json', 'utf-8');
      const before = snapshotRevisions();
      expect(() => vm.ensureRevisions('p1')).toThrow(MigrationPlanCorruptError);
      // 任何文件都未被改写（半迁移态保持原样）
      expect(snapshotRevisions()).toEqual(before);
      // marker 未写（迁移未完成）
      expect(fsSync.existsSync(path.join(versionsDir, '.revision-schema-v2'))).toBe(false);
    });

    it('plan schema 不符（未来版本）→ fail-closed 抛错', () => {
      fsSync.writeFileSync(
        path.join(versionsDir, '.revision-schema-v2.plan.json'),
        JSON.stringify({ schema: 3, entries: [] }),
        'utf-8',
      );
      const before = snapshotRevisions();
      expect(() => vm.ensureRevisions('p1')).toThrow(MigrationPlanCorruptError);
      expect(snapshotRevisions()).toEqual(before);
    });

    it('plan 结构非法（entries 缺失/重复 targetRevision）→ fail-closed 抛错', () => {
      const planPath = path.join(versionsDir, '.revision-schema-v2.plan.json');
      // entries 缺失
      fsSync.writeFileSync(planPath, JSON.stringify({ schema: 2 }), 'utf-8');
      expect(() => vm.ensureRevisions('p1')).toThrow(MigrationPlanCorruptError);
      // targetRevision 重复（内部不一致）
      fsSync.writeFileSync(planPath, JSON.stringify({
        schema: 2,
        entries: [
          { file: 'legacy-a.json', targetRevision: 1 },
          { file: 'legacy-b.json', targetRevision: 1 },
        ],
      }), 'utf-8');
      expect(() => vm.ensureRevisions('p1')).toThrow(MigrationPlanCorruptError);
      expect(fsSync.existsSync(path.join(versionsDir, '.revision-schema-v2'))).toBe(false);
    });

    it('错误消息含恢复指引（MIGRATION_PLAN_CORRUPT code）', () => {
      fsSync.writeFileSync(path.join(versionsDir, '.revision-schema-v2.plan.json'), 'not json at all', 'utf-8');
      try {
        vm.ensureRevisions('p1');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(MigrationPlanCorruptError);
        const e = err as MigrationPlanCorruptError;
        expect(e.code).toBe('MIGRATION_PLAN_CORRUPT');
        expect(e.message).toContain('fail-closed');
        expect(e.message).toContain('.revision-schema-v2.plan.json'); // 恢复指引提及 plan 文件
      }
    });

    it('恢复路径：删除损坏 plan 后重试 → 全新扫描正常迁移', () => {
      fsSync.writeFileSync(path.join(versionsDir, '.revision-schema-v2.plan.json'), 'garbage', 'utf-8');
      expect(() => vm.ensureRevisions('p1')).toThrow(MigrationPlanCorruptError);
      // 操作者恢复：删除 plan 文件
      fsSync.unlinkSync(path.join(versionsDir, '.revision-schema-v2.plan.json'));
      const max = vm.ensureRevisions('p1');
      expect(max).toBe(3);
      // 统一 revision 空间无 collision
      const revs = Object.values(snapshotRevisions()).filter((r) => typeof r === 'number');
      expect(new Set(revs).size).toBe(revs.length);
      expect(fsSync.existsSync(path.join(versionsDir, '.revision-schema-v2'))).toBe(true);
    });
  });
});
