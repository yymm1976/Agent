// src/agent/execution-router.ts
// Phase 55：/goal 执行路径判定器
// 根据 GoalPlan 的 steps + dependencies + domain 判定走哪条执行路径

import type { GoalPlan } from './goal-types.js';

export type ExecutionRoute = 'single' | 'dag' | 'compose' | 'legacy';

export interface ExecutionRouterOptions {
  /** 判定模式：auto（自动判定）/ legacy（强制旧路径）/ explicit（显式指定） */
  mode: 'auto' | 'legacy' | 'explicit';
  /** mode=explicit 时生效，指定具体路径 */
  explicitRoute?: ExecutionRoute;
  /** 单 Agent 路径的最大步数（默认 2） */
  singleAgentMaxSteps: number;
  /** DAG 路径的最大领域数（超过则升级到 compose，默认 1） */
  dagMaxDomains: number;
}

export class ExecutionRouter {
  route(plan: GoalPlan, options: ExecutionRouterOptions): ExecutionRoute {
    // mode=legacy：直接返回旧路径
    if (options.mode === 'legacy') return 'legacy';

    // mode=explicit：返回用户指定的路径
    if (options.mode === 'explicit' && options.explicitRoute) {
      return options.explicitRoute;
    }

    // mode=auto：按任务复杂度自动判定
    return this.autoRoute(plan, options);
  }

  private autoRoute(plan: GoalPlan, options: ExecutionRouterOptions): ExecutionRoute {
    const { steps, uniqueDomains = [], hasDependencies = false } = plan;

    // 路径 1：单 Agent（1-2 步，无依赖，单领域）
    if (
      steps.length <= options.singleAgentMaxSteps &&
      !hasDependencies &&
      uniqueDomains.length <= options.dagMaxDomains
    ) {
      return 'single';
    }

    // 路径 3：CompositionalRouter（跨领域）
    if (uniqueDomains.length > options.dagMaxDomains) {
      return 'compose';
    }

    // 路径 2：DAG 引擎（3+ 步，有依赖，单领域）
    return 'dag';
  }
}
