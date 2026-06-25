// src/agent/multi/branch-orchestrator.ts
// Phase 39 Task 3：BranchOrchestrator——分支编辑-审查-合并工作流编排器
//
// 协调 /goal 分解 → 创建实验分支 → 按依赖顺序执行 → 收集结果
//
// 设计要点：
// 1. 从 GoalPlan 创建 BranchTask（每个步骤一个分支任务）
// 2. 拓扑排序后按顺序执行（简化：按步骤顺序，每步依赖上一步）
// 3. 依赖的任务失败时，标记后续任务为 blocked
// 4. 每个任务：创建实验分支 → 在 worktree 中执行 → 更新状态
// 5. 提供 getTasks() 供 UI 渲染

import type { GoalPlan } from '../goal-types.js';
import type { ExperimentManager, ExperimentRunResult } from '../../harness/experiment-manager.js';
import type { ExperimentRunnerLike } from '../../harness/experiment-manager.js';
import { logger } from '../../utils/logger.js';

/** 分支任务状态 */
export type BranchTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';

/** 分支任务 */
export interface BranchTask {
  /** 任务 ID（对应 GoalStep.id） */
  id: string;
  /** 任务描述（对应 GoalStep.description） */
  description: string;
  /** 依赖的其他 BranchTask id */
  dependsOn: string[];
  /** 创建后关联的实验 ID */
  experimentId?: string;
  /** 任务状态 */
  status: BranchTaskStatus;
  /** 执行结果（完成后填充） */
  result?: ExperimentRunResult;
  /** 失败原因 */
  error?: string;
  /** 步骤序号（用于排序） */
  stepIndex: number;
}

/** Runner 工厂：根据 BranchTask 创建 ExperimentRunner */
export type RunnerFactory = (task: BranchTask) => ExperimentRunnerLike;

export class BranchOrchestrator {
  private tasks: Map<string, BranchTask> = new Map();
  private experimentManager: ExperimentManager;
  private runnerFactory: RunnerFactory;

  constructor(
    experimentManager: ExperimentManager,
    runnerFactory: RunnerFactory,
  ) {
    this.experimentManager = experimentManager;
    this.runnerFactory = runnerFactory;
  }

  /**
   * 从 GoalPlan 创建分支任务
   * 使用 GoalStep 自身声明的 dependencies 建立依赖关系
   * 若步骤未声明 dependencies（空数组），视为独立任务
   */
  async planFromGoal(goalPlan: GoalPlan): Promise<BranchTask[]> {
    this.tasks.clear();

    for (let i = 0; i < goalPlan.steps.length; i++) {
      const step = goalPlan.steps[i];
      const taskId = `branch-${step.id}`;

      // 使用 GoalStep 声明的 dependencies
      const dependsOn: string[] = (step.dependencies ?? [])
        .map(depId => `branch-${depId}`)
        .filter(depId => {
          // 过滤掉不存在的依赖（如依赖的步骤不在计划中）
          const depStepId = Number(depId.replace('branch-', ''));
          return goalPlan.steps.some(s => s.id === depStepId);
        });

      const task: BranchTask = {
        id: taskId,
        description: step.description,
        dependsOn,
        status: 'pending',
        stepIndex: i,
      };
      this.tasks.set(taskId, task);
    }

    logger.info('BranchOrchestrator: 计划已创建', {
      goalId: goalPlan.id,
      taskCount: this.tasks.size,
    });

    return this.getTasks();
  }

  /**
   * 按依赖顺序执行所有分支任务
   * 拓扑排序后按顺序执行，依赖的任务失败时标记后续任务为 blocked
   *
   * @param onProgress 每个任务状态变化时的回调（供 UI 渲染）
   * @returns 所有任务的最终状态
   */
  async executeAll(
    onProgress?: (task: BranchTask) => void,
  ): Promise<Map<string, BranchTask>> {
    const order = this.topologicalSort();

    for (const taskId of order) {
      const task = this.tasks.get(taskId);
      if (!task) continue;

      // 检查依赖是否全部完成
      const hasFailedDependency = task.dependsOn.some(depId => {
        const dep = this.tasks.get(depId);
        return !dep || dep.status === 'failed' || dep.status === 'blocked';
      });

      if (hasFailedDependency) {
        task.status = 'blocked';
        task.error = '依赖的任务失败或被阻塞';
        onProgress?.(task);
        logger.warn('BranchOrchestrator: 任务被阻塞', {
          taskId,
          dependsOn: task.dependsOn,
        });
        continue;
      }

      // 执行任务
      task.status = 'running';
      onProgress?.(task);

      try {
        const result = await this.executeTask(task);
        task.result = result;
        task.status = result.success ? 'completed' : 'failed';
        if (!result.success) {
          task.error = result.error ?? '执行失败';
        }
      } catch (error: any) {
        task.status = 'failed';
        task.error = error instanceof Error ? error.message : String(error);
        logger.error('BranchOrchestrator: 任务执行异常', {
          taskId,
          error: task.error,
        });
      }

      onProgress?.(task);
    }

    return this.tasks;
  }

  /**
   * 执行单个分支任务
   * 1. 创建实验分支
   * 2. 通过 runnerFactory 创建 ExperimentRunner
   * 3. 调用 runInExperiment 执行
   */
  private async executeTask(task: BranchTask): Promise<ExperimentRunResult> {
    // 创建实验分支
    const experiment = await this.experimentManager.createExperiment(
      `分支任务: ${task.description.slice(0, 60)}`,
    );
    task.experimentId = experiment.id;

    // 创建 runner 并注入到 experimentManager
    const runner = this.runnerFactory(task);
    this.experimentManager.setExperimentRunner(runner);

    // 执行任务
    const result = await this.experimentManager.runInExperiment(
      experiment.id,
      task.description,
    );

    // 执行完成后清除 runner（避免影响后续任务的 runner 注入）
    this.experimentManager.setExperimentRunner(null);

    return result;
  }

  /**
   * 拓扑排序（Kahn 算法）
   * 返回按依赖顺序排列的任务 ID 列表
   */
  private topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();

    for (const [id, task] of this.tasks) {
      inDegree.set(id, task.dependsOn.length);
      for (const dep of task.dependsOn) {
        if (!adj.has(dep)) adj.set(dep, []);
        adj.get(dep)!.push(id);
      }
    }

    // 入度为 0 的节点入队（按 stepIndex 排序保证稳定顺序）
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }
    queue.sort((a, b) => {
      const ta = this.tasks.get(a);
      const tb = this.tasks.get(b);
      return (ta?.stepIndex ?? 0) - (tb?.stepIndex ?? 0);
    });

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      const neighbors = adj.get(current) ?? [];
      // 保持稳定排序
      neighbors.sort((a, b) => {
        const ta = this.tasks.get(a);
        const tb = this.tasks.get(b);
        return (ta?.stepIndex ?? 0) - (tb?.stepIndex ?? 0);
      });
      for (const next of neighbors) {
        const newDegree = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDegree);
        if (newDegree === 0) queue.push(next);
      }
    }

    // 检测循环（未访问的节点）
    if (order.length < this.tasks.size) {
      const cycleTasks = Array.from(this.tasks.keys()).filter(id => !order.includes(id));
      logger.warn('BranchOrchestrator: 依赖图存在循环，跳过循环节点', {
        cycleTasks,
      });
    }

    return order;
  }

  /**
   * 获取所有任务状态（供 UI 渲染）
   * 按 stepIndex 排序
   */
  getTasks(): BranchTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => a.stepIndex - b.stepIndex);
  }

  /** 获取指定任务 */
  getTask(id: string): BranchTask | null {
    return this.tasks.get(id) ?? null;
  }
}
