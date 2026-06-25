// tests/phase37/selective-rollback.test.ts
// Phase 37 Task 3：选择性回滚测试
// 验证 /rollback file、/rollback preview 子命令
// 使用真实临时 Git 仓库

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CheckpointManager } from '../../src/harness/checkpoint-manager.js';
import { rollbackCommand } from '../../src/cli/commands/rollback.js';
import type { ServiceContext } from '../../src/cli/service-context.js';

// 检测系统是否安装了 git
const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_GIT)('选择性回滚', () => {
  let tmpDir: string;
  let storageDir: string;
  let checkpointManager: CheckpointManager;
  let ctx: ServiceContext;

  beforeEach(async () => {
    // 在临时目录创建 git 仓库
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-rollback-'));
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    // 创建独立的存储目录，避免元数据冲突
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-rollback-store-'));
    checkpointManager = new CheckpointManager(
      { enabled: true, maxCheckpoints: 10, workingDirectory: tmpDir },
      storageDir,
    );
    await checkpointManager.init();

    // 构造 mock ServiceContext（仅包含 rollback 命令需要的字段）
    ctx = {
      cwd: tmpDir,
      checkpointManager,
      commandBridge: {
        requestConfirm: vi.fn().mockResolvedValue(true),
        clearChat: vi.fn(),
        addSystemMessage: vi.fn(),
        setAutonomyMode: vi.fn(),
        setWorkMode: vi.fn(),
        requestAbort: vi.fn(),
        requestPlanEdit: vi.fn(),
        exit: vi.fn(),
        startGoal: vi.fn(),
        getState: vi.fn(),
        setOutputStyle: vi.fn(),
      },
    } as unknown as ServiceContext;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('preview 回滚：显示差异不修改文件', async () => {
    // 创建检查点（包含原始文件，未提交的变更会触发检查点创建）
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'original');
    const cp = await checkpointManager.create({ description: 'original state' });
    expect(cp).not.toBeNull();

    // 修改文件并提交（产生差异）
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified');
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'modify file'], { cwd: tmpDir });

    // 预览回滚
    const result = await rollbackCommand.handler(`preview ${cp!.id}`, ctx);
    expect(result.type).toBe('handled');
    const messages = (result as { messages?: string[] }).messages ?? [];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain('回滚预览');
    // 应包含 diff 内容
    const combined = messages.join('\n');
    expect(combined).toContain('file.txt');

    // 文件不应被修改（仍为 modified）
    expect(fs.readFileSync(path.join(tmpDir, 'file.txt'), 'utf-8')).toBe('modified');
  });

  it('file 回滚：只回滚指定文件', async () => {
    // 创建两个文件（未提交）
    fs.writeFileSync(path.join(tmpDir, 'file-a.txt'), 'a-original');
    fs.writeFileSync(path.join(tmpDir, 'file-b.txt'), 'b-original');

    // 创建检查点（会提交这两个文件，cp.gitCommitHash 指向此提交）
    const cp = await checkpointManager.create({ description: 'before changes' });
    expect(cp).not.toBeNull();

    // 修改两个文件（未提交）
    fs.writeFileSync(path.join(tmpDir, 'file-a.txt'), 'a-modified');
    fs.writeFileSync(path.join(tmpDir, 'file-b.txt'), 'b-modified');

    // 创建第二个检查点（会提交修改）
    await checkpointManager.create({ description: 'after changes' });

    // 只回滚 file-a.txt 到检查点
    const result = await rollbackCommand.handler(
      `file file-a.txt ${cp!.id}`,
      ctx,
    );
    expect(result.type).toBe('handled');
    const messages = (result as { messages?: string[] }).messages ?? [];
    expect(messages[0]).toContain('已回滚');

    // file-a.txt 应恢复为原始内容
    expect(fs.readFileSync(path.join(tmpDir, 'file-a.txt'), 'utf-8')).toBe('a-original');
    // file-b.txt 应保持修改后的内容（未被回滚）
    expect(fs.readFileSync(path.join(tmpDir, 'file-b.txt'), 'utf-8')).toBe('b-modified');
  });

  it('file 回滚前自动创建快照检查点', async () => {
    // 创建初始文件（未提交）
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'original');

    // 创建检查点（会提交 file.txt = "original"）
    const cp = await checkpointManager.create({ description: 'baseline' });
    expect(cp).not.toBeNull();
    const countBefore = checkpointManager.count;

    // 修改文件（不提交，产生未提交变更）
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'dirty-content');

    // 执行 file 回滚
    const result = await rollbackCommand.handler(
      `file file.txt ${cp!.id}`,
      ctx,
    );
    expect(result.type).toBe('handled');
    const messages = (result as { messages?: string[] }).messages ?? [];
    // 应提示已创建快照
    expect(messages[0]).toContain('快照');

    // 检查点数量应增加（快照已创建）
    const countAfter = checkpointManager.count;
    expect(countAfter).toBe(countBefore + 1);

    // 快照检查点应包含"回滚前快照"描述
    const checkpoints = checkpointManager.list();
    const snapshot = checkpoints.find(c => c.description.includes('回滚前快照'));
    expect(snapshot).toBeDefined();

    // file.txt 应恢复为原始内容
    expect(fs.readFileSync(path.join(tmpDir, 'file.txt'), 'utf-8')).toBe('original');
  });
});
