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

function makeManager(workingDirectory: string): { manager: CheckpointManager; storageDir: string } {
  const config: CheckpointManagerConfig = {
    enabled: true,
    maxCheckpoints: 5,
    workingDirectory,
  };
  // 使用每个测试独立的存储目录，避免元数据冲突
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-cp-store-'));
  const manager = new CheckpointManager(config, storageDir);
  return { manager, storageDir };
}

describe.skipIf(!HAS_GIT)('CheckpointManager', () => {
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
    // Windows 下 git 进程可能仍锁定目录，使用重试 + try/catch 避免 EBUSY 导致级联失败
    for (const dir of [tempDir, storageDir]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
          break;
        } catch {
          // EBUSY/EPERM：最后一次尝试仍失败则忽略，让 OS 在后续清理
        }
      }
    }
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
  }, 20000);

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
  }, 20000);

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
      const filePath = path.join(tempDir, `file-${i}.txt`);
      // 使用 fd + fsync 确保文件写入落盘，避免并行模式下 git.status 看不到新文件
      const fd = fs.openSync(filePath, 'w');
      fs.writeFileSync(fd, `content ${i}`);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      await manager.create({ description: `cp ${i}` });
    }
    // 创建 8 个后，应保留最近 5 个
    expect(manager.count).toBe(5);
    const list = manager.list();
    expect(list[0].description).toBe('cp 3');
    expect(list[4].description).toBe('cp 7');
  }, 30000); // 并行模式下 git 操作慢，需更长超时

  it('should track files snapshot', async () => {
    for (const name of ['a.txt', 'b.txt']) {
      const fd = fs.openSync(path.join(tempDir, name), 'w');
      fs.writeFileSync(fd, name[0]);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
    const cp = await manager.create({ description: 'multi-file' });
    expect(cp!.filesSnapshot.length).toBeGreaterThanOrEqual(2);
    expect(cp!.filesSnapshot).toContain('a.txt');
    expect(cp!.filesSnapshot).toContain('b.txt');
  }, 15000);
});
