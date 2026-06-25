// tests/phase37/experiment-worktree.test.ts
// Phase 37 Task 3：ExperimentManager 实验分支管理测试
// 使用真实临时 Git 仓库验证 worktree 创建、列表、对比、采纳、丢弃

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExperimentManager } from '../../src/harness/experiment-manager.js';

// 检测系统是否安装了 git
const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_GIT)('ExperimentManager 实验分支管理', () => {
  let tmpDir: string;

  beforeEach(() => {
    // 在临时目录创建 git 仓库
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-exp-'));
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    // 创建 .gitignore（排除 .routedev/ 工具元数据目录）并初始提交
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.routedev/\n');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(() => {
    // 清理临时目录（包括 worktree）
    try {
      // 先清理可能存在的 worktree，避免 Windows 文件锁
      execFileSync('git', ['worktree', 'prune'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // 忽略
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createExperiment：创建实验分支和 worktree', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('test-experiment');

    expect(exp.id).toMatch(/^exp-\d{3}$/);
    expect(exp.name).toBe('test-experiment');
    expect(exp.branch).toBe(`experiment/${exp.id}`);
    expect(exp.worktreePath).toBe(path.join(tmpDir, '.routedev', 'experiments', exp.id));
    expect(exp.status).toBe('active');
    expect(exp.runCount).toBe(0);
    expect(exp.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    // worktree 目录应存在
    expect(fs.existsSync(exp.worktreePath)).toBe(true);
    // worktree 中应有 README.md（继承自基础 commit）
    expect(fs.existsSync(path.join(exp.worktreePath, 'README.md'))).toBe(true);
    // 注册表应持久化
    const registryPath = path.join(tmpDir, '.routedev', 'experiment-registry.json');
    expect(fs.existsSync(registryPath)).toBe(true);
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(registry.length).toBe(1);
    expect(registry[0].id).toBe(exp.id);
  });

  it('listExperiments：列出所有实验', async () => {
    const manager = new ExperimentManager(tmpDir);
    await manager.createExperiment('exp-a');
    await manager.createExperiment('exp-b');
    await manager.createExperiment('exp-c');

    const list = manager.listExperiments();
    expect(list.length).toBe(3);
    expect(list[0].name).toBe('exp-a');
    expect(list[1].name).toBe('exp-b');
    expect(list[2].name).toBe('exp-c');
    // ID 应递增
    expect(list[0].id).toBe('exp-001');
    expect(list[1].id).toBe('exp-002');
    expect(list[2].id).toBe('exp-003');

    // 重新加载（从注册表）应保持一致
    const reloaded = new ExperimentManager(tmpDir);
    const reloadedList = reloaded.listExperiments();
    expect(reloadedList.length).toBe(3);
    expect(reloadedList[0].id).toBe('exp-001');
    expect(reloadedList[2].id).toBe('exp-003');
  });

  it('compareExperiments：对比两个实验差异', async () => {
    const manager = new ExperimentManager(tmpDir);
    const expA = await manager.createExperiment('exp-a');
    const expB = await manager.createExperiment('exp-b');

    // 在 expA 的 worktree 中添加文件并提交
    fs.writeFileSync(path.join(expA.worktreePath, 'feature-a.txt'), 'feature a content');
    execFileSync('git', ['add', '.'], { cwd: expA.worktreePath });
    execFileSync('git', ['commit', '-m', 'add feature-a'], { cwd: expA.worktreePath });

    // 在 expB 的 worktree 中添加不同的文件并提交
    fs.writeFileSync(path.join(expB.worktreePath, 'feature-b.txt'), 'feature b content');
    execFileSync('git', ['add', '.'], { cwd: expB.worktreePath });
    execFileSync('git', ['commit', '-m', 'add feature-b'], { cwd: expB.worktreePath });

    const diff = await manager.compareExperiments(expA.id, expB.id);
    expect(diff.expA.id).toBe(expA.id);
    expect(diff.expB.id).toBe(expB.id);
    // 两个实验各有不同的文件，diff 应有变更
    expect(diff.filesChanged).toBeGreaterThan(0);
    expect(diff.additions).toBeGreaterThan(0);
    // diff 摘要应包含文件名
    expect(diff.diffSummary).toContain('feature-b.txt');
  });

  it('adoptExperiment：采纳实验（合并到主分支）', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('exp-to-adopt');

    // 在实验 worktree 中添加文件并提交
    fs.writeFileSync(path.join(exp.worktreePath, 'new-feature.txt'), 'new feature');
    execFileSync('git', ['add', '.'], { cwd: exp.worktreePath });
    execFileSync('git', ['commit', '-m', 'add new-feature'], { cwd: exp.worktreePath });

    // 采纳实验
    const result = await manager.adoptExperiment(exp.id);
    expect(result.success).toBe(true);
    expect(result.conflict).toBeUndefined();
    expect(result.message).toContain('已采纳');

    // 主工作区应有 new-feature.txt（合并后）
    expect(fs.existsSync(path.join(tmpDir, 'new-feature.txt'))).toBe(true);

    // 实验状态应为 adopted
    const updated = manager.getExperiment(exp.id);
    expect(updated?.status).toBe('adopted');

    // 合并提交应存在（--no-ff 保留合并记录）
    const log = execFileSync('git', ['log', '--oneline', '-5'], { cwd: tmpDir }).toString();
    expect(log).toContain('采纳实验');
  });

  it('discardExperiment：丢弃实验（清理 worktree 和分支）', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('exp-to-discard');

    // 确认 worktree 存在
    expect(fs.existsSync(exp.worktreePath)).toBe(true);

    // 丢弃实验
    await manager.discardExperiment(exp.id);

    // worktree 目录应被删除
    expect(fs.existsSync(exp.worktreePath)).toBe(false);

    // 实验状态应为 discarded
    const updated = manager.getExperiment(exp.id);
    expect(updated?.status).toBe('discarded');

    // 分支应被删除
    const branches = execFileSync('git', ['branch', '--list'], { cwd: tmpDir }).toString();
    expect(branches).not.toContain(exp.branch);
  });

  it('runInExperiment：记录任务运行', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('exp-run');

    expect(exp.runCount).toBe(0);

    // 运行任务
    const result = await manager.runInExperiment(exp.id, '实现功能 X');
    expect(result.success).toBe(true);
    expect(result.tokenUsage).toBe(0);

    // runCount 和 lastRunAt 应更新
    const updated = manager.getExperiment(exp.id);
    expect(updated?.runCount).toBe(1);
    expect(updated?.lastRunAt).toBeDefined();
  });
});
