// src/agent/session-status-aggregator.ts
// Phase 77 借鉴点 4：Voice Memo 式会话状态卡
//
// 职责：
//   - 把分散在 goal-persistence / blackboard 中的会话状态聚合成统一 SessionStatus
//   - 供 IPC session:get-status 调用，驱动渲染层 SessionStatusCard 就地刷新
//
// 设计参考：HomeRail Voice Memo 卡片模式（标题 + 状态徽章 + 摘要 + 事实标签 + 待办列表 + 下一步）
//
// 与 GoalExecutionCard 的区别：
//   - GoalExecutionCard 消费 GoalEvent 流（实时步骤状态）
//   - SessionStatusCard 消费聚合快照（含 blackboard facts / open questions / token 预算）
//   两者互补：状态卡提供"会话全局视角"，执行卡提供"步骤时序视角"

import type { PersistedGoal } from './goal-persistence.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 待办条目（映射自 goal.plan.steps） */
export interface SessionStatusTodo {
  text: string;
  done: boolean;
}

/** 会话状态卡数据模型 */
export interface SessionStatus {
  /** 标题（goal.spec.goal 目标描述） */
  title: string;
  /** 状态：idle=无活跃目标，executing/paused/completed/failed 来自 goal.status */
  status: 'idle' | 'executing' | 'paused' | 'completed' | 'failed';
  /** 摘要：目标描述 + 完成步数 / 总步数 */
  summary: string;
  /** 已知事实（来自 blackboard.projectFacts，最多 8 条） */
  knownFacts: string[];
  /** 未决问题（status='blocked' 的步骤描述，最多 8 条） */
  openQuestions: string[];
  /** 待办列表（goal.plan.steps 映射，最多 10 条） */
  todos: SessionStatusTodo[];
  /** 下一步动作（当前 in_progress 步骤的 description，无则 null） */
  nextAction: string | null;
  /** 已用 Token */
  tokenUsed: number;
  /** Token 预算 */
  tokenBudget: number;
  /** 更新时间（ISO 8601） */
  updatedAt: string;
}

// ============================================================
// 聚合器依赖接口
// ============================================================

/**
 * goalPersistence 依赖（ duck-typed，与 GoalPersistence 实例兼容）
 *
 * 接受 GoalPersistence 实例，或任何具有相同方法签名的对象。
 */
export interface SessionStatusGoalPersistence {
  load(id: string): Promise<PersistedGoal | null>;
  listResumable(): Promise<PersistedGoal[]>;
}

/**
 * blackboard 依赖（duck-typed）
 *
 * 适配 Blackboard.getSnapshot() 返回的 BlackboardSnapshot 结构。
 * Blackboard 实际方法名是 getSnapshot()（非 getProjectFacts/getCompletedSteps），
 * 此处从 snapshot 中提取 projectFacts 和 completedSteps。
 */
export interface SessionStatusBlackboard {
  getSnapshot(): {
    currentGoal: { description: string; status: string } | null;
    completedSteps: { key: string; value: string }[];
    projectFacts: { key: string; value: string }[];
  };
}

/** 聚合器入参 */
export interface AggregateSessionStatusDeps {
  goalPersistence?: SessionStatusGoalPersistence;
  /** 当前活跃 goal ID；无则返回 idle 状态 */
  currentGoalId?: string | null;
  blackboard?: SessionStatusBlackboard;
}

// ============================================================
// 常量
// ============================================================

/** 已知事实最大条数 */
const MAX_KNOWN_FACTS = 8;
/** 未决问题最大条数 */
const MAX_OPEN_QUESTIONS = 8;
/** 待办列表最大条数 */
const MAX_TODOS = 10;

// ============================================================
// 聚合器
// ============================================================

/**
 * 聚合会话状态
 *
 * 行为：
 *   - 无 currentGoalId → 返回 idle 状态
 *   - goalPersistence.load 失败或返回 null → 返回 idle 状态
 *   - 正常 → 从 goal + blackboard 聚合各字段
 *
 * fail-open：goalPersistence 或 blackboard 缺失时不抛错，返回降级状态。
 *
 * @param deps 聚合依赖
 * @returns 会话状态快照
 */
export async function aggregateSessionStatus(deps: AggregateSessionStatusDeps): Promise<SessionStatus> {
  const { goalPersistence, currentGoalId, blackboard } = deps;

  // 无活跃 goal → idle
  if (!currentGoalId || !goalPersistence) {
    return buildIdleStatus();
  }

  let goal: PersistedGoal | null = null;
  try {
    goal = await goalPersistence.load(currentGoalId);
  } catch (e) {
    // load 失败降级为 idle（持久化层错误不应阻塞 UI）
    logger.warn('goal 加载失败，降级为 idle', { error: e instanceof Error ? e.message : String(e) });
    return buildIdleStatus();
  }

  if (!goal) {
    return buildIdleStatus();
  }

  // ===== 提取 blackboard 事实 =====
  let factsValues: string[] = [];
  if (blackboard) {
    try {
      const snapshot = blackboard.getSnapshot();
      factsValues = snapshot.projectFacts.map((f) => `${f.key}: ${f.value}`);
    } catch (e) {
      // 黑板读取失败忽略，事实列表降级为空
      logger.warn('黑板读取失败，事实列表降级为空', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ===== 计算 steps 派生字段 =====
  const steps = goal.plan.steps;
  const totalSteps = steps.length;
  const completedSteps = steps.filter((s) => s.status === 'completed').length;

  // 已知事实（最多 8 条）
  const knownFacts = factsValues.slice(0, MAX_KNOWN_FACTS);

  // 未决问题：status='blocked' 的步骤描述（最多 8 条）
  // 注：PersistedGoal.plan.steps[].status 是 string 类型，'blocked' 为约定值
  const openQuestions = steps
    .filter((s) => s.status === 'blocked')
    .map((s) => s.description)
    .slice(0, MAX_OPEN_QUESTIONS);

  // 待办列表：所有步骤映射为 {text, done}（最多 10 条）
  const todos = steps
    .map((s) => ({ text: s.description, done: s.status === 'completed' }))
    .slice(0, MAX_TODOS);

  // 下一步：当前 in_progress 步骤的 description
  const inProgressStep = steps.find((s) => s.status === 'in_progress');
  const nextAction = inProgressStep ? inProgressStep.description : null;

  // 状态映射：goal-persistence 的 GoalPlanStatus 为
  // 'planning' | 'executing' | 'paused' | 'completed' | 'failed'
  // SessionStatus.status 不含 'planning'，将其映射为 'executing'
  const status = mapGoalStatus(goal.status);

  // 摘要
  const summary = `${goal.spec.goal}（${completedSteps}/${totalSteps} 步已完成）`;

  return {
    title: goal.spec.goal,
    status,
    summary,
    knownFacts,
    openQuestions,
    todos,
    nextAction,
    tokenUsed: goal.tokenUsed,
    tokenBudget: goal.tokenBudget,
    updatedAt: new Date(goal.updatedAt).toISOString(),
  };
}

// ============================================================
// 内部辅助
// ============================================================

/** 构造 idle 状态（无活跃 goal 时返回） */
function buildIdleStatus(): SessionStatus {
  return {
    title: '',
    status: 'idle',
    summary: '当前无活跃目标',
    knownFacts: [],
    openQuestions: [],
    todos: [],
    nextAction: null,
    tokenUsed: 0,
    tokenBudget: 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 映射 goal-persistence 的 GoalPlanStatus 到 SessionStatus.status
 *
 * - 'planning' → 'executing'（计划阶段视为执行中，无独立 idle 值）
 * - 'executing' → 'executing'
 * - 'paused' → 'paused'
 * - 'completed' → 'completed'
 * - 'failed' → 'failed'
 * - 其他未知值 → 'idle'（防御性降级）
 */
function mapGoalStatus(
  goalStatus: string,
): 'idle' | 'executing' | 'paused' | 'completed' | 'failed' {
  switch (goalStatus) {
    case 'executing':
    case 'planning':
      return 'executing';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}
