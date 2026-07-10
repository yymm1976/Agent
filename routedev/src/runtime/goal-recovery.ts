// src/runtime/goal-recovery.ts
// Phase 77：冷启动恢复——借鉴 HomeRail 的 recoverAllActiveRuns()
//
// 职责：
//   - detectResumableGoals：扫描 .routedev/goals/ 下 status=executing/paused 的 goal
//   - validateResumable：识别"部分完成"状态的 goal（plan.steps 含 status 字段且非全部 completed）
//   - shouldRecover：综合判定是否值得恢复（status/未完成步骤/token 预算/陈旧度）
//   - detectResumableGoalsOnStartup：启动时 fail-open 调用入口
//
// 注意：GoalPersistence.listResumable() 在 Phase 40 已实现但从未被调用——
//       本模块即"接口就绪缺触发器"的触发器（Phase 77 借鉴点 7）

import type { GoalPersistence, PersistedGoal } from '../agent/goal-persistence.js';
import { logger } from '../utils/logger.js';

/** 可恢复 goal 的展示信息（驱动 UI 提示条） */
export interface ResumableGoalInfo {
  /** 持久化的 goal 数据 */
  goal: PersistedGoal;
  /** 已完成步骤数 */
  completedSteps: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 是否陈旧（超过 24 小时无更新） */
  isStale: boolean;
}

/** 陈旧阈值：24 小时（毫秒） */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Token 预算接近耗尽阈值：95% */
const TOKEN_BUDGET_NEAR_EXHAUSTION_RATIO = 0.95;

/**
 * Goal 恢复管理器
 *
 * 实例化位置：
 *   - app-init.ts 启动时调用 detectResumableGoalsOnStartup（fail-open）
 *   - engine-bridge.ts IPC goal:list-resumable 时按需 new
 */
export class GoalRecoveryManager {
  constructor(private goalPersistence: GoalPersistence) {}

  /**
   * 检测所有可恢复的 goal
   *
   * 流程：
   *   1. 调用 goalPersistence.listResumable()（Phase 40 已实现）
   *   2. 对每个 goal 计算 completedSteps/totalSteps
   *   3. 判断 isStale（updatedAt 超过 24 小时）
   *   4. validateResumable 过滤掉无效条目
   *
   * fail-open：任何异常只记日志返回空数组
   */
  async detectResumableGoals(): Promise<ResumableGoalInfo[]> {
    try {
      const goals = await this.goalPersistence.listResumable();
      const now = Date.now();
      const infos: ResumableGoalInfo[] = [];
      for (const goal of goals) {
        if (!this.validateResumable(goal)) continue;
        const totalSteps = goal.plan.steps.length;
        const completedSteps = goal.plan.steps.filter(s => s.status === 'completed').length;
        // PersistedGoal.updatedAt 在 save 时被写成 Date.now()（number），
        // 但旧数据可能存在 ISO 字符串——同时兼容
        // 经 number | string 中间类型，让 typeof 缩窄在分支内生效，无需双重断言
        const updatedAt: number | string = goal.updatedAt;
        const updatedMs = typeof updatedAt === 'number'
          ? updatedAt
          : new Date(updatedAt).getTime();
        const isStale = Number.isFinite(updatedMs) && (now - updatedMs) > STALE_THRESHOLD_MS;
        infos.push({ goal, completedSteps, totalSteps, isStale });
      }
      return infos;
    } catch (err) {
      logger.warn('Phase77 GoalRecoveryManager.detectResumableGoals failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * 校验单个 goal 是否可恢复
   *
   * 校验项：
   *   - plan.steps 必须存在且为数组
   *   - 每个 step 必须有 status 字段
   *   - 识别"部分完成"状态：至少有 1 个 step 已完成且至少有 1 个 step 未完成
   *     （全部 completed 说明 goal 状态字段过时，不应再恢复；
   *      全部 pending 说明从未开始执行，恢复等同于重新执行，不优先恢复）
   *
   * @param goal 待校验的持久化 goal
   */
  validateResumable(goal: PersistedGoal): boolean {
    if (!goal || !goal.plan || !Array.isArray(goal.plan.steps)) return false;
    if (goal.plan.steps.length === 0) return false;
    for (const step of goal.plan.steps) {
      if (typeof step.status !== 'string') return false;
    }
    const hasCompleted = goal.plan.steps.some(s => s.status === 'completed');
    const hasIncomplete = goal.plan.steps.some(s => s.status !== 'completed');
    return hasCompleted && hasIncomplete;
  }

  /**
   * 判断是否应自动恢复该 goal
   *
   * 条件（全部满足）：
   *   1. status 为 'executing' 或 'paused'
   *   2. 存在未完成步骤
   *   3. tokenUsed < tokenBudget * 0.95（未接近预算耗尽）
   *   4. !isStale（24 小时内有更新）
   *
   * 注意：本方法仅作"是否值得恢复"的判定，实际是否恢复由用户/UI 决定
   *
   * @param info 待判定的可恢复 goal 信息
   */
  shouldRecover(info: ResumableGoalInfo): boolean {
    const { goal, completedSteps, totalSteps, isStale } = info;
    if (goal.status !== 'executing' && goal.status !== 'paused') return false;
    if (completedSteps >= totalSteps) return false;
    if (goal.tokenBudget > 0 && goal.tokenUsed >= goal.tokenBudget * TOKEN_BUDGET_NEAR_EXHAUSTION_RATIO) {
      return false;
    }
    return !isStale;
  }
}

/**
 * 启动时检测可恢复 goal（fail-open 入口）
 *
 * 设计原则：
 *   - 任何异常只记日志返回空数组，绝不阻塞应用启动
 *   - 仅检测，不自动恢复——结果供渲染层查询并展示提示条
 *
 * @param goalPersistence 持久化实例
 * @returns 可恢复 goal 信息列表（空数组表示无可恢复项或检测失败）
 */
export async function detectResumableGoalsOnStartup(
  goalPersistence: GoalPersistence,
): Promise<ResumableGoalInfo[]> {
  const manager = new GoalRecoveryManager(goalPersistence);
  return manager.detectResumableGoals();
}
