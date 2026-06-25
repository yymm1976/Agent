// tests/harness/experiment-manager.test.ts
// Phase 39 Task 3：ExperimentManager 增强功能测试
// 测试 createExperiment、adoptExperiment（merge/cherry-pick）、discardExperiment、
// listExperiments、getModifiedFiles、getExperimentModifiedFiles、getExperimentDiff
//
// 使用真实临时 Git 仓库验证

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExperimentManager } from '../../src/harness/experiment-manager.js';
import type { ExperimentRunnerLike, ExperimentRunResult } from '../../src/harness/experiment-manager.js';

// 检测系统是否安装了 git
const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_GIT)('ExperimentManager Phase 39 增强', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-exp39-'));
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.routedev/\n');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
    fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'existing content');
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(() => {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // 忽略
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createExperiment：创建实验分支和 worktree', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('test-feature');

    expect(exp.id).toMatch(/^exp-\d{3}$/);
    expect(exp.branch).toBe(`experiment/${exp.id}`);
    expect(exp.status).toBe('active');
    expect(fs.existsSync(exp.worktreePath)).toBe(true);
    // worktree 中应继承基础文件
    expect(fs.existsSync(path.join(exp.worktreePath, 'README.md'))).toBe(true);
  });

  it('adoptExperiment merge 策略：全量合并到当前分支', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('merge-test');

    // 在实验 worktree 中添加文件并提交
    fs.writeFileSync(path.join(exp.worktreePath, 'feature.txt'), 'new feature');
    execFileSync('git', ['add', 'feature.txt'], { cwd: exp.worktreePath });
    execFileSync('git', ['commit', '-m', 'add feature'], { cwd: exp.worktreePath });

    // 采纳实验（默认 merge 策略）
    const result = await manager.adoptExperiment(exp.id);
    expect(result.success).toBe(true);
    expect(result.conflict).toBeUndefined();
    expect(result.message).toContain('已采纳');

    // 主工作区应有 feature.txt
    expect(fs.existsSync(path.join(tmpDir, 'feature.txt'))).toBe(true);

    // 实验状态应为 adopted
    const updated = manager.getExperiment(exp.id);
    expect(updated?.status).toBe('adopted');
  });

  it('adoptExperiment cherry-pick 策略：选择性合并指定文件', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('cherry-pick-test');

    // 在实验 worktree 中添加多个文件并提交
    fs.writeFileSync(path.join(exp.worktreePath, 'file-a.txt'), 'content A');
    fs.writeFileSync(path.join(exp.worktreePath, 'file-b.txt'), 'content B');
    fs.writeFileSync(path.join(exp.worktreePath, 'file-c.txt'), 'content C');
    execFileSync('git', ['add', 'file-a.txt', 'file-b.txt', 'file-c.txt'], { cwd: exp.worktreePath });
    execFileSync('git', ['commit', '-m', 'add files'], { cwd: exp.worktreePath });

    // cherry-pick 只采纳 file-a 和 file-c
    const result = await manager.adoptExperiment(exp.id, {
      strategy: 'cherry-pick',
      fileFilter: ['file-a.txt', 'file-c.txt'],
    });

    expect(result.success).toBe(true);
    expect(result.adoptedFiles).toBeDefined();
    expect(result.adoptedFiles!).toContain('file-a.txt');
    expect(result.adoptedFiles!).toContain('file-c.txt');
    expect(result.adoptedFiles!.length).toBe(2);

    // 主工作区应有 file-a 和 file-c，但不应有 file-b
    expect(fs.existsSync(path.join(tmpDir, 'file-a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'file-c.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'file-b.txt'))).toBe(false);

    // 实验状态应为 adopted
    const updated = manager.getExperiment(exp.id);
    expect(updated?.status).toBe('adopted');
  });

  it('adoptExperiment cherry-pick 策略：无 fileFilter 时返回失败', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('cherry-pick-empty');

    const result = await manager.adoptExperiment(exp.id, {
      strategy: 'cherry-pick',
      fileFilter: [],
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('fileFilter');
  });

  it('discardExperiment：清理 worktree 和分支', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('discard-test');

    expect(fs.existsSync(exp.worktreePath)).toBe(true);

    await manager.discardExperiment(exp.id);

    expect(fs.existsSync(exp.worktreePath)).toBe(false);
    const updated = manager.getExperiment(exp.id);
    expect(updated?.status).toBe('discarded');

    const branches = execFileSync('git', ['branch', '--list'], { cwd: tmpDir }).toString();
    expect(branches).not.toContain(exp.branch);
  });

  it('listExperiments：列出所有实验', async () => {
    const manager = new ExperimentManager(tmpDir);
    await manager.createExperiment('exp-a');
    await manager.createExperiment('exp-b');

    const list = manager.listExperiments();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe('exp-001');
    expect(list[1].id).toBe('exp-002');
  });

  it('getModifiedFiles：获取 worktree 中的变更文件列表', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('modified-files-test');

    // 在 worktree 中创建未跟踪文件
    fs.writeFileSync(path.join(exp.worktreePath, 'new-file.txt'), 'new');
    // 修改已有文件
    fs.writeFileSync(path.join(exp.worktreePath, 'README.md'), '# Modified');

    const modified = await manager.getModifiedFiles(exp.worktreePath);
    expect(modified).toContain('new-file.txt');
    expect(modified).toContain('README.md');
  });

  it('getExperimentModifiedFiles：获取实验分支相对 base 的变更文件', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('branch-diff-test');

    // 在实验 worktree 中添加文件并提交
    fs.writeFileSync(path.join(exp.worktreePath, 'new-feature.txt'), 'feature');
    execFileSync('git', ['add', 'new-feature.txt'], { cwd: exp.worktreePath });
    execFileSync('git', ['commit', '-m', 'add feature'], { cwd: exp.worktreePath });

    const modified = await manager.getExperimentModifiedFiles(exp.id);
    expect(modified).toContain('new-feature.txt');
  });

  it('getExperimentDiff：获取实验分支的 diff 内容', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('diff-test');

    // 在实验 worktree 中添加文件并提交
    fs.writeFileSync(path.join(exp.worktreePath, 'diff-file.txt'), 'diff content');
    execFileSync('git', ['add', 'diff-file.txt'], { cwd: exp.worktreePath });
    execFileSync('git', ['commit', '-m', 'add diff-file'], { cwd: exp.worktreePath });

    const diff = await manager.getExperimentDiff(exp.id);
    expect(diff).toContain('diff-file.txt');
    expect(diff).toContain('+diff content');

    // 指定文件的 diff
    const fileDiff = await manager.getExperimentDiff(exp.id, 'diff-file.txt');
    expect(fileDiff).toContain('diff-file.txt');
  });

  it('runInExperiment：注入 runner 时在 worktree 中执行', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('runner-test');

    // 创建 mock runner
    const mockRunner: ExperimentRunnerLike = {
      runInWorktree: async (worktreePath: string, task: string) => {
        // 模拟在 worktree 中创建文件
        fs.writeFileSync(path.join(worktreePath, 'runner-output.txt'), task);
        const result: ExperimentRunResult = {
          success: true,
          result: `任务完成: ${task}`,
          tokenUsage: 100,
          modifiedFiles: ['runner-output.txt'],
        };
        return result;
      },
    };
    manager.setExperimentRunner(mockRunner);

    const result = await manager.runInExperiment(exp.id, '实现功能 X');

    expect(result.success).toBe(true);
    expect(result.result).toContain('任务完成');
    expect(result.tokenUsage).toBe(100);
    expect(result.modifiedFiles).toContain('runner-output.txt');

    // worktree 中应有 runner 创建的文件
    expect(fs.existsSync(path.join(exp.worktreePath, 'runner-output.txt'))).toBe(true);

    // 实验的 tokenUsage 应累计
    const updated = manager.getExperiment(exp.id);
    expect(updated?.tokenUsage).toBe(100);
  });

  it('runInExperiment：未注入 runner 时回退到记录模式', async () => {
    const manager = new ExperimentManager(tmpDir);
    const exp = await manager.createExperiment('no-runner-test');

    const result = await manager.runInExperiment(exp.id, '实现功能 Y');

    expect(result.success).toBe(true);
    expect(result.tokenUsage).toBe(0);
    expect(result.modifiedFiles).toEqual([]);

    const updated = manager.getExperiment(exp.id);
    expect(updated?.runCount).toBe(1);
  });
});
