// tests/harness/checkpoint.test.ts
// CheckpointManager 单元测试（使用真实临时 Git 仓库）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { CheckpointManager } from '../../src/harness/checkpoint-manager.js';
import type { CheckpointManagerConfig } from '../../src/harness/types.js';

const HAS_GIT = (() => {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function createTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-cp-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  // 初始 commit（让 HEAD 存在）
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -q -m "initial"', { cwd: dir });
  return dir;
}

function makeManager(workingDirectory: string): CheckpointManager {
  const config: CheckpointManagerConfig = {
    enabled: true,
    maxCheckpoints: 5,
    workingDirectory,
  };
  // 使用每个测试独立的存储目录，避免元数据冲突
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-cp-store-'));
  return new CheckpointManager(config, storageDir);
}

describe.skipIf(!HAS_GIT)('CheckpointManager', () => {
  let tempDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    tempDir = createTempRepo();
    manager = makeManager(tempDir);
    await manager.init();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should initialize successfully in a git repo', () => {
    expect(manager.isEnabled).toBe(true);
  });

  it('should return 0 checkpoints initially', () => {
    expect(manager.count).toBe(0);
    expect(manager.list()).toEqual([]);
  });

  it('should create a checkpoint when there are changes', async () => {
    fs.writeFileSync(path.join(tempDir, 'new.txt'), 'hello');
    const cp = await manager.create({ description: 'first' });
    expect(cp).not.toBeNull();
    expect(cp!.id).toMatch(/^[a-f0-9]+$/);
    expect(cp!.description).toBe('first');
    expect(cp!.gitCommitHash).toMatch(/^[a-f0-9]{40}$/);
    expect(manager.count).toBe(1);
  });

  it('should not create checkpoint when no changes', async () => {
    const cp = await manager.create({ description: 'no changes' });
    expect(cp).toBeNull();
    expect(manager.count).toBe(0);
  });

  it('should list checkpoints in order', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.txt'), '1');
    await manager.create({ description: 'cp 1' });
    fs.writeFileSync(path.join(tempDir, 'b.txt'), '2');
    await manager.create({ description: 'cp 2' });
    fs.writeFileSync(path.join(tempDir, 'c.txt'), '3');
    await manager.create({ description: 'cp 3' });

    const list = manager.list();
    expect(list.length).toBe(3);
    expect(list[0].description).toBe('cp 1');
    expect(list[2].description).toBe('cp 3');
  });

  it('should rollback to a checkpoint', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'a1');
    const cp1 = await manager.create({ description: 'first' });

    fs.writeFileSync(path.join(tempDir, 'b.txt'), 'b1');
    const cp2 = await manager.create({ description: 'second' });

    expect(fs.existsSync(path.join(tempDir, 'b.txt'))).toBe(true);

    // 回滚到第一个
    const success = await manager.rollback(cp1!.id);
    expect(success).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'b.txt'))).toBe(false);
    // 第一个之后的检查点被清理
    const list = manager.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(cp1!.id);
  });

  it('should fail to rollback to non-existent checkpoint', async () => {
    const success = await manager.rollback('nonexistent');
    expect(success).toBe(false);
  });

  it('should save and load GoalPlan', async () => {
    const plan = {
      id: 'test-goal-1',
      description: 'test goal',
      steps: [
        { id: 1, description: 'step 1', status: 'pending', dependencies: [] },
      ],
      status: 'pending' as const,
      createdAt: Date.now(),
    };

    await manager.saveGoalPlan(plan);
    const loaded = await manager.loadGoalPlan();
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('test-goal-1');
    expect(loaded!.description).toBe('test goal');
  });

  it('should return null when no GoalPlan saved', async () => {
    const loaded = await manager.loadGoalPlan();
    expect(loaded).toBeNull();
  });

  it('should clear GoalPlan', async () => {
    const plan = {
      id: 'g1',
      description: 'x',
      steps: [],
      status: 'pending' as const,
      createdAt: Date.now(),
    };
    await manager.saveGoalPlan(plan);
    await manager.clearGoalPlan();
    const loaded = await manager.loadGoalPlan();
    expect(loaded).toBeNull();
  });

  it('should prune checkpoints beyond maxCheckpoints', async () => {
    // maxCheckpoints: 5
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(tempDir, `file-${i}.txt`), `content ${i}`);
      await manager.create({ description: `cp ${i}` });
    }
    // 创建 8 个后，应保留最近 5 个
    expect(manager.count).toBe(5);
    const list = manager.list();
    expect(list[0].description).toBe('cp 3');
    expect(list[4].description).toBe('cp 7');
  });

  it('should track files snapshot', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tempDir, 'b.txt'), 'b');
    const cp = await manager.create({ description: 'multi-file' });
    expect(cp!.filesSnapshot.length).toBeGreaterThanOrEqual(2);
    expect(cp!.filesSnapshot).toContain('a.txt');
    expect(cp!.filesSnapshot).toContain('b.txt');
  });
});
