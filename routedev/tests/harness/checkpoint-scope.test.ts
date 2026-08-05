// tests/harness/checkpoint-scope.test.ts
// B-13：checkpoint 恢复范围可解释、可预览
//
// 契约：
// 1. previewDiff：回滚前可预览文件差异（filesAdded/Modified/Deleted + patch）
// 2. 默认 rollback（'files'）不触碰会话状态（GoalPlan）
// 3. 'files+session' 显式恢复创建时快照的 GoalPlan
// 4. 权限授权与远程 ACL 永不随 checkpoint 创建/回滚（类型与元数据均不含权限字段）
//
// 注意：CheckpointManager.create() 仅在存在未提交变更时创建（git add -A && commit），
// 因此每个 create 前必须先修改文件；rollback 要求工作区干净，后续变更需先 commit。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { CheckpointManager } from '../../src/harness/checkpoint-manager.js';
import type { CheckpointManagerConfig, GoalPlan } from '../../src/harness/types.js';

const HAS_GIT = (() => {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-cpscope-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // 关闭 CRLF 转换，保证 diff patch 断言稳定
  execSync('git config core.autocrlf false', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -q -m "initial"', { cwd: dir });
  return dir;
}

function makeManager(workingDirectory: string): { manager: CheckpointManager; storageDir: string } {
  const config: CheckpointManagerConfig = {
    enabled: true,
    maxCheckpoints: 5,
    workingDirectory,
  };
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-cpscope-store-'));
  const manager = new CheckpointManager(config, storageDir);
  return { manager, storageDir };
}

function makeGoalPlan(id: string, description: string): GoalPlan {
  return {
    id,
    description,
    steps: [{ id: 1, description: 'step-1', status: 'pending' }],
    status: 'in_progress',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as GoalPlan;
}

describe.skipIf(!HAS_GIT)('B-13 Checkpoint 恢复范围', () => {
  let tempDir: string;
  let storageDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    tempDir = createTempRepo();
    const result = makeManager(tempDir);
    storageDir = result.storageDir;
    manager = result.manager;
    await manager.init();
  });

  afterEach(() => {
    for (const dir of [tempDir, storageDir]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
          break;
        } catch {
          // EBUSY/EPERM：最后一次尝试仍失败则忽略
        }
      }
    }
  });

  it('previewDiff 返回文件差异与 patch（恢复前可预览）', async () => {
    // cp1：未提交的 a.txt 变更触发创建
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'hello\n');
    const cp1 = await manager.create({ description: 'cp1', isAutoCreated: true });
    expect(cp1).not.toBeNull();

    // cp2：修改 a.txt + 新增 b.txt + 删除 README.md（均未提交）
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'hello world\n');
    fs.writeFileSync(path.join(tempDir, 'b.txt'), 'new\n');
    fs.rmSync(path.join(tempDir, 'README.md'));
    const cp2 = await manager.create({ description: 'cp2', isAutoCreated: true });
    expect(cp2).not.toBeNull();

    const diff = await manager.diff(cp1!.id, cp2!.id);
    expect(diff).not.toBeNull();
    expect(diff!.filesModified).toContain('a.txt');
    expect(diff!.filesAdded).toContain('b.txt');
    expect(diff!.filesDeleted).toContain('README.md');
    expect(diff!.patch).toContain('hello world');
  });

  it('默认 rollback（files）不动会话状态：goalPlan 保持当前值', async () => {
    const goal = makeGoalPlan('goal-1', 'v1');
    await manager.saveGoalPlan(goal);
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'v1\n');
    const cp = await manager.create({ description: 'snapshot', captureSession: true });
    expect(cp?.sessionSnapshot?.goalPlan?.id).toBe('goal-1');

    // 检查点后：文件与 goalPlan 都变化（commit 让工作区干净，满足 rollback 前置检查）
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'v2\n');
    execSync('git add -A && git commit -q -m "v2"', { cwd: tempDir });
    await manager.saveGoalPlan(makeGoalPlan('goal-2', 'v2'));

    const ok = await manager.rollback(cp!.id); // 默认 scope = files
    expect(ok).toBe(true);
    // 文件回滚到 v1
    expect(fs.readFileSync(path.join(tempDir, 'a.txt'), 'utf-8')).toBe('v1\n');
    // 会话状态未被回滚
    const loaded = await manager.loadGoalPlan();
    expect(loaded?.id).toBe('goal-2');
  });

  it('files+session 显式恢复快照的 GoalPlan', async () => {
    const goal = makeGoalPlan('goal-snap', 'snapshot');
    await manager.saveGoalPlan(goal);
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'snap\n');
    const cp = await manager.create({ description: 'snapshot', captureSession: true });
    expect(cp?.sessionSnapshot?.goalPlan?.id).toBe('goal-snap');

    // 检查点后变化（commit 让工作区干净）
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'later\n');
    execSync('git add -A && git commit -q -m "later"', { cwd: tempDir });
    await manager.saveGoalPlan(makeGoalPlan('goal-later', 'later'));

    const ok = await manager.rollback(cp!.id, { scope: 'files+session' });
    expect(ok).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, 'a.txt'), 'utf-8')).toBe('snap\n');
    const restored = await manager.loadGoalPlan();
    expect(restored?.id).toBe('goal-snap');
  });

  it('files+session 但无会话快照时退化为仅文件', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'no-snap\n');
    // 不传 captureSession：检查点无会话快照
    const cp = await manager.create({ description: 'no-snapshot' });
    expect(cp?.sessionSnapshot).toBeUndefined();

    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'later\n');
    execSync('git add -A && git commit -q -m "later"', { cwd: tempDir });

    const ok = await manager.rollback(cp!.id, { scope: 'files+session' });
    expect(ok).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, 'a.txt'), 'utf-8')).toBe('no-snap\n');
  });

  it('权限/ACL 隔离：checkpoint 元数据与回滚路径不含权限字段', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'x\n');
    await manager.create({ description: 'perm', captureSession: true });

    // 元数据落盘内容不含任何权限/ACL 相关字段
    const metaFile = fs.readdirSync(storageDir).find((f) => f.startsWith('metadata-'));
    expect(metaFile).toBeDefined();
    const raw = fs.readFileSync(path.join(storageDir, metaFile!), 'utf-8');
    const records = JSON.parse(raw);
    for (const record of records) {
      const text = JSON.stringify(record);
      expect(text.toLowerCase()).not.toMatch(/permission|acl|allowlist|approval/i);
    }

    // rollback 原型上不存在权限相关方法（类型级隔离：恢复路径只谈文件与 scope）
    const rollbackProto = Object.getOwnPropertyNames(CheckpointManager.prototype);
    expect(rollbackProto.some((m) => /permission|acl/i.test(m))).toBe(false);
    void crypto;
  });
});
