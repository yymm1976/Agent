// src/agent/path-router.ts
// Phase 58：统一路径路由器，合并 execution-router + level-path-router
//
// 单一真相源：所有 /goal 执行路径判定走这里。
// 优先级：难度路由（difficultyRouting.enabled + plan.difficultyAssessment）
//         > explicit 模式 > auto 启发式 > 默认 'single'
//
// Phase 58 改动：
//   - 删除 'legacy' 路径（executePlanWithMultiAgent 已删）
//   - ExecutionRouterOptions.mode 从 'auto'|'legacy'|'explicit' 收窄为 'auto'|'explicit'|'single'
//   - route() 未注入路由器时回退到 'single'（而非 'legacy'）
//   - 合并 LevelPathRouter 的 selectPath / detectLevelSwitch 到此类

import type { GoalPlan } from './goal-types.js';
import type { DifficultyLevel } from './difficulty-assessor.js';

// ============================================================
// 类型定义
// ============================================================

/**
 * 执行路径（Phase 58：删除 'legacy'）
 * - single：单 Agent 串行
 * - dag：DAG 引擎并行
 * - compose：CompositionalRouter 组合式多 Agent
 */
export type ExecutionRoute = 'single' | 'dag' | 'compose';

/** ExecutionRouter 选项（Phase 58：mode 删除 'legacy'；F-012 新增 'single'） */
export interface ExecutionRouterOptions {
  /** 判定模式：auto（自动判定）/ explicit（显式指定）/ single（强制单 Agent） */
  mode: 'auto' | 'explicit' | 'single';
  /** mode=explicit 时生效，指定具体路径 */
  explicitRoute?: ExecutionRoute;
  /** 单 Agent 路径的最大步数（默认 2） */
  singleAgentMaxSteps: number;
  /** DAG 路径的最大领域数（超过则升级到 compose，默认 1） */
  dagMaxDomains: number;
}

/** 难度路由选择结果（保留 preStages/postStages 用于 L5 研究/批判阶段） */
export interface LevelPathSelection {
  route: ExecutionRoute;
  preStages: Array<'researcher'>;
  postStages: Array<'critic'>;
  reason: string;
}

/** 动态升降级信号 */
export interface LevelSwitchSignals {
  failureCount: number;
  contextUsagePercent: number;
  crossDomain: boolean;
  unresolvedBlockers: number;
}

/** 动态升降级建议 */
export interface LevelSwitchSuggestion {
  from: DifficultyLevel;
  to: DifficultyLevel;
  reason: string;
}

// ============================================================
// PathRouter
// ============================================================

/**
 * 统一路径路由器（Phase 58 合并 ExecutionRouter + LevelPathRouter）
 *
 * 三类方法：
 *   1. selectPath(level)：难度路由 L1-L5 → LevelPathSelection（含 preStages/postStages）
 *   2. route(plan, options)：启发式路由，按 steps/domains/dependencies 判定
 *   3. detectLevelSwitch(level, signals)：动态升降级检测
 *
 * goal-runner.ts 调用顺序：
 *   - 若 difficultyRouting.enabled && plan.difficultyAssessment → selectPath() 优先
 *   - 否则 → route()
 *   - 未注入 pathRouter 时 → 默认 'single'（Phase 58：原为 'legacy'）
 */
export class PathRouter {
  // ===== 难度路由（原 LevelPathRouter.selectPath） =====

  /**
   * L1-L5 → 路径映射
   * - L1/L2 → single
   * - L3 → dag
   * - L4 → compose
   * - L5 → compose + researcher 前置 + critic 后置
   */
  selectPath(level: DifficultyLevel): LevelPathSelection {
    if (level === 'L1' || level === 'L2') {
      return { route: 'single', preStages: [], postStages: [], reason: `${level} 使用单 Agent 串行路径` };
    }
    if (level === 'L3') {
      return { route: 'dag', preStages: [], postStages: [], reason: 'L3 使用 DAG 路径' };
    }
    if (level === 'L4') {
      return { route: 'compose', preStages: [], postStages: [], reason: 'L4 使用组合式多 Agent 路径' };
    }
    return { route: 'compose', preStages: ['researcher'], postStages: ['critic'], reason: 'L5 使用研究前置与批判后置路径' };
  }

  // ===== 启发式路由（原 ExecutionRouter.route） =====

  /**
   * 按 plan 的 steps/domains/dependencies 判定路径
   *
   * mode=explicit → 返回 explicitRoute
   * mode=auto → 启发式判定
   */
  route(plan: GoalPlan, options: ExecutionRouterOptions): ExecutionRoute {
    // F-012：mode=single 强制单 Agent 路径（goalAdvanced pack 未启用时使用）
    if (options.mode === 'single') {
      return 'single';
    }

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

  // ===== 动态升降级（原 LevelPathRouter.detectLevelSwitch） =====

  /**
   * 动态升降级检测
   *
   * 触发条件（任一满足即建议升级）：
   *   - failureCount >= 2
   *   - unresolvedBlockers > 0
   *   - contextUsagePercent >= 0.85
   *   - crossDomain 且当前为 L1/L2/L3 → 升级到 L4
   *
   * @param currentLevel 当前难度等级
   * @param signals 执行信号
   * @returns 升级建议（null 表示无需切换）
   */
  detectLevelSwitch(
    currentLevel: DifficultyLevel,
    signals: LevelSwitchSignals,
  ): LevelSwitchSuggestion | null {
    if (signals.failureCount >= 2 || signals.unresolvedBlockers > 0 || signals.contextUsagePercent >= 0.85) {
      const to = currentLevel === 'L5' ? 'L5' : this.nextLevel(currentLevel);
      if (to !== currentLevel) {
        return { from: currentLevel, to, reason: '失败、阻塞或上下文压力触发升级' };
      }
    }
    if (signals.crossDomain && (currentLevel === 'L1' || currentLevel === 'L2' || currentLevel === 'L3')) {
      return { from: currentLevel, to: 'L4', reason: '跨领域信号触发升级到组合路径' };
    }
    return null;
  }

  /** 计算下一个难度等级（L1→L2→...→L5） */
  private nextLevel(level: DifficultyLevel): DifficultyLevel {
    const levels: DifficultyLevel[] = ['L1', 'L2', 'L3', 'L4', 'L5'];
    return levels[Math.min(levels.indexOf(level) + 1, levels.length - 1)];
  }
}
