// tests/agent/multi/branch-orchestrator.test.ts
// Phase 39 Task 3：BranchOrchestrator 测试
// 测试 planFromGoal、executeAll 依赖顺序、blocked 状态传播
//
// 使用真实临时 Git 仓库 + mock runner 验证

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExperimentManager } from '../../../src/harness/experiment-manager.js';
import type { ExperimentRunnerLike, ExperimentRunResult } from '../../../src/harness/experiment-manager.js';
import { BranchOrchestrator } from '../../../src/agent/multi/branch-orchestrator.js';
import type { BranchTask, RunnerFactory } from '../../../src/agent/multi/branch-orchestrator.js';
import type { GoalPlan } from '../../../src/agent/goal-types.js';

const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** 创建 GoalPlan */
function makeGoalPlan(steps: Array<{ description: string; dependencies?: number[] }>): GoalPlan {
  return {
    id: 'plan-test',
    description: 'test goal',
    steps: steps.map((s, i) => ({
      id: i + 1,
      description: s.description,
      status: 'pending' as const,
      dependencies: s.dependencies ?? [],
    })),
    status: 'pending',
    createdAt: Date.now(),
  };
}

/** 创建 mock runner（返回成功结果） */
function makeSuccessRunner(): ExperimentRunnerLike {
  return {
    runInWorktree: vi.fn(async (_worktreePath: string, task: string) => {
      const result: ExperimentRunResult = {
        success: true,
        result: `完成: ${task}`,
        tokenUsage: 50,
        modifiedFiles: ['output.txt'],
      };
      return result;
    }),
  };
}

/** 创建 mock runner（返回失败结果） */
function makeFailingRunner(): ExperimentRunnerLike {
  return {
    runInWorktree: vi.fn(async () => {
      const result: ExperimentRunResult = {
        success: false,
        result: '执行失败',
        modifiedFiles: [],
        error: '模拟失败',
      };
      return result;
    }),
  };
}

describe.skipIf(!HAS_GIT)('BranchOrchestrator', () => {
  let tmpDir: string;
  let manager: ExperimentManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-branch-orch-'));
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.routedev/\n');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    manager = new ExperimentManager(tmpDir);
  });

  afterEach(() => {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // 忽略
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('planFromGoal：从 GoalPlan 创建分支任务', async () => {
    const runnerFactory: RunnerFactory = () => makeSuccessRunner();
    const orchestrator = new BranchOrchestrator(manager, runnerFactory);

    const goalPlan = makeGoalPlan([
      { description: '步骤一' },
      { description: '步骤二', dependencies: [1] },
      { description: '步骤三', dependencies: [2] },
    ]);

    const tasks = await orchestrator.planFromGoal(goalPlan);

    expect(tasks.length).toBe(3);
    expect(tasks[0].id).toBe('branch-1');
    expect(tasks[1].id).toBe('branch-2');
    expect(tasks[2].id).toBe('branch-3');
    expect(tasks[0].description).toBe('步骤一');
    expect(tasks[0].status).toBe('pending');

    // 声明的依赖关系
    expect(tasks[0].dependsOn).toEqual([]);
    expect(tasks[1].dependsOn).toEqual(['branch-1']);
    expect(tasks[2].dependsOn).toEqual(['branch-2']);
  });

  it('planFromGoal：使用 GoalStep 自身的 dependencies', async () => {
    const runnerFactory: RunnerFactory = () => makeSuccessRunner();
    const orchestrator = new BranchOrchestrator(manager, runnerFactory);

    const goalPlan = makeGoalPlan([
      { description: '步骤一' },
      { description: '步骤二', dependencies: [1] },
      { description: '步骤三', dependencies: [1, 2] },
    ]);

    const tasks = await orchestrator.planFromGoal(goalPlan);

    expect(tasks[0].dependsOn).toEqual([]);
    expect(tasks[1].dependsOn).toEqual(['branch-1']);
    expect(tasks[2].dependsOn).toEqual(['branch-1', 'branch-2']);
  });

  it('executeAll：按依赖顺序执行所有任务', async () => {
    const runnerFactory: RunnerFactory = () => makeSuccessRunner();
    const orchestrator = new BranchOrchestrator(manager, runnerFactory);

    const goalPlan = makeGoalPlan([
      { description: '任务 A' },
      { description: '任务 B', dependencies: [1] },
      { description: '任务 C', dependencies: [2] },
    ]);

    await orchestrator.planFromGoal(goalPlan);

    const progressUpdates: BranchTask[] = [];
    const finalTasks = await orchestrator.executeAll(task => {
      progressUpdates.push({ ...task });
    });

    // 所有任务应完成
    for (const task of finalTasks.values()) {
      expect(task.status).toBe('completed');
      expect(task.experimentId).toBeDefined();
      expect(task.result?.success).toBe(true);
    }

    // 应有进度回调（running + completed）
    const runningUpdates = progressUpdates.filter(t => t.status === 'running');
    const completedUpdates = progressUpdates.filter(t => t.status === 'completed');
    expect(runningUpdates.length).toBe(3);
    expect(completedUpdates.length).toBe(3);
  });

  it('executeAll：依赖任务失败时标记后续任务为 blocked', async () => {
    // 第一个任务失败，后续任务应被 blocked
    let callCount = 0;
    const runnerFactory: RunnerFactory = () => {
      callCount++;
      // 第一个任务失败，后续也失败（但后续不应被执行）
      return makeFailingRunner();
    };
    const orchestrator = new BranchOrchestrator(manager, runnerFactory);

    const goalPlan = makeGoalPlan([
      { description: '任务 A（会失败）' },
      { description: '任务 B（应被 blocked）', dependencies: [1] },
      { description: '任务 C（应被 blocked）', dependencies: [2] },
    ]);

    await orchestrator.planFromGoal(goalPlan);
    await orchestrator.executeAll();

    const tasks = orchestrator.getTasks();

    // 第一个任务应失败
    expect(tasks[0].status).toBe('failed');
    expect(tasks[0].error).toBeDefined();

    // 后续任务应被 blocked
    expect(tasks[1].status).toBe('blocked');
    expect(tasks[2].status).toBe('blocked');

    // 后续任务不应有 experimentId（未创建实验）
    expect(tasks[1].experimentId).toBeUndefined();
    expect(tasks[2].experimentId).toBeUndefined();
  });

  it('executeAll：独立任务（无依赖）不受其他任务失败影响', async () => {
    // 两个独立任务（无 dependencies），第一个失败，第二个仍应执行
    const goalPlan = makeGoalPlan([
      { description: '独立任务 A（会失败）' },
      { description: '独立任务 B（应成功）' },
    ]);

    let callCount = 0;
    const runnerFactory: RunnerFactory = () => {
      callCount++;
      if (callCount === 1) {
        return makeFailingRunner();
      }
      return makeSuccessRunner();
    };
    const orchestrator = new BranchOrchestrator(manager, runnerFactory);

    await orchestrator.planFromGoal(goalPlan);
    await orchestrator.executeAll();

    const tasks = orchestrator.getTasks();

    // 第一个任务失败
    expect(tasks[0].status).toBe('failed');
    // 第二个任务应成功（无依赖，不受影响）
    expect(tasks[1].status).toBe('completed');
    expect(tasks[1].result?.success).toBe(true);
  });

  it('getTasks：返回按 stepIndex 排序的任务列表', async () => {
    const runnerFactory: RunnerFactory = () => makeSuccessRunner();
    const orchestrator = new BranchOrchestrator(manager, runnerFactory);

    const goalPlan = makeGoalPlan([
      { description: '步骤一' },
      { description: '步骤二' },
      { description: '步骤三' },
    ]);

    await orchestrator.planFromGoal(goalPlan);

    const tasks = orchestrator.getTasks();
    expect(tasks.length).toBe(3);
    expect(tasks[0].stepIndex).toBe(0);
    expect(tasks[1].stepIndex).toBe(1);
    expect(tasks[2].stepIndex).toBe(2);
  });
});
