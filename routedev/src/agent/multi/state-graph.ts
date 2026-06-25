// src/agent/multi/state-graph.ts
// 图状态机：步骤级状态跟踪 + 合法转换验证
//
// 解决问题：当前多 Agent 编排只有步骤级状态（pending/completed/failed），
// 缺少 awaiting_review / retrying / blocked 等中间状态，无法支撑结构化审查与重试。
//
// 状态转换规则：
//   pending → running（依赖全部 completed）
//   running → awaiting_review（Worker 返回结果且需要审查）
//   running → completed（Worker 返回结果且无需审查）
//   running → retrying（Worker 失败但可重试）
//   running → failed（Worker 失败且不可重试）
//   awaiting_review → completed（用户采纳）
//   awaiting_review → retrying（用户要求重做）
//   awaiting_review → failed（用户丢弃）
//   retrying → running（重试次数未耗尽）
//   retrying → failed（重试次数耗尽）
//   failed → blocked（下游步骤全部 blocked）

import { logger } from '../../utils/logger.js';

/** 步骤状态 */
export type StepStatus =
  | 'pending'
  | 'running'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'retrying';

/** 步骤状态节点 */
export interface StepStateNode {
  stepId: string;
  status: StepStatus;
  retries: number;
  maxRetries: number;
  artifacts?: string[];
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

/** 状态转换记录 */
export interface StepTransition {
  from: StepStatus;
  to: StepStatus;
  condition: string;
}

/** 合法的状态转换映射 */
const LEGAL_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ['running', 'blocked'], // pending → blocked：上游失败时下游直接 blocked
  running: ['awaiting_review', 'completed', 'retrying', 'failed'],
  awaiting_review: ['completed', 'retrying', 'failed'],
  retrying: ['running', 'failed'],
  failed: ['blocked'],
  completed: [],
  blocked: [],
};

/** 默认最大重试次数 */
const DEFAULT_MAX_RETRIES = 2;

export class ExecutionStateGraph {
  private nodes: Map<string, StepStateNode> = new Map();
  private transitions: StepTransition[] = [];
  /** 步骤依赖关系：stepId → 依赖的 stepId 列表 */
  private dependencies: Map<string, string[]> = new Map();

  /**
   * 添加步骤到状态图
   * @param stepId 步骤 ID
   * @param maxRetries 最大重试次数（默认 2）
   * @param dependencies 依赖的步骤 ID 列表
   */
  addStep(stepId: string, maxRetries: number = DEFAULT_MAX_RETRIES, dependencies: string[] = []): void {
    if (this.nodes.has(stepId)) {
      logger.warn('ExecutionStateGraph: step already exists, skipping', { stepId });
      return;
    }
    this.nodes.set(stepId, {
      stepId,
      status: 'pending',
      retries: 0,
      maxRetries,
    });
    this.dependencies.set(stepId, dependencies);
  }

  /**
   * 设置步骤的依赖关系（用于 getPendingSteps 判断依赖是否完成）
   */
  setDependencies(stepId: string, dependencies: string[]): void {
    this.dependencies.set(stepId, dependencies);
  }

  /**
   * 执行状态转换
   * @param stepId 步骤 ID
   * @param to 目标状态
   * @param reason 转换原因（可选，记录到 transitions）
   * @throws 如果步骤不存在或转换非法
   */
  transition(stepId: string, to: StepStatus, reason?: string): void {
    const node = this.nodes.get(stepId);
    if (!node) {
      throw new Error(`ExecutionStateGraph: step not found: ${stepId}`);
    }

    const from = node.status;
    if (!this.validateTransition(from, to)) {
      throw new Error(
        `ExecutionStateGraph: illegal transition ${from} → ${to} for step ${stepId}`,
      );
    }

    // 记录转换
    this.transitions.push({
      from,
      to,
      condition: reason ?? `${from} → ${to}`,
    });

    // 更新节点状态
    node.status = to;

    // 状态副作用
    if (to === 'running' && !node.startedAt) {
      node.startedAt = Date.now();
    }
    if (to === 'retrying') {
      node.retries++;
    }
    if (to === 'completed' || to === 'failed' || to === 'blocked') {
      node.completedAt = Date.now();
    }

    logger.debug('ExecutionStateGraph: transition', { stepId, from, to, reason });
  }

  /** 获取步骤节点 */
  getStep(stepId: string): StepStateNode | undefined {
    return this.nodes.get(stepId);
  }

  /** 获取所有步骤 */
  getAllSteps(): StepStateNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * 获取可执行的 pending 步骤（依赖全部 completed）
   * @returns 依赖已完成的 pending 步骤 ID 列表
   */
  getPendingSteps(): string[] {
    const result: string[] = [];
    for (const [stepId, node] of this.nodes) {
      if (node.status !== 'pending') continue;
      const deps = this.dependencies.get(stepId) ?? [];
      const allDepsCompleted = deps.every(depId => {
        const depNode = this.nodes.get(depId);
        return depNode?.status === 'completed';
      });
      if (allDepsCompleted) {
        result.push(stepId);
      }
    }
    return result;
  }

  /**
   * 标记失败步骤的下游为 blocked
   * 当某步骤 failed 时，所有直接或间接依赖它的 pending 步骤应被标记为 blocked
   */
  blockDownstreamOf(failedStepId: string): void {
    const toBlock: string[] = [];
    for (const [stepId, node] of this.nodes) {
      if (node.status !== 'pending') continue;
      const deps = this.dependencies.get(stepId) ?? [];
      if (deps.includes(failedStepId)) {
        toBlock.push(stepId);
      }
    }
    for (const stepId of toBlock) {
      try {
        this.transition(stepId, 'blocked', `upstream ${failedStepId} failed`);
      } catch {
        // 已经不是 pending 状态则跳过
      }
    }
  }

  /** 是否所有步骤都到达终态 */
  isComplete(): boolean {
    const terminalStates: StepStatus[] = ['completed', 'failed', 'blocked'];
    for (const node of this.nodes.values()) {
      if (!terminalStates.includes(node.status)) return false;
    }
    return true;
  }

  /** 是否存在失败步骤 */
  hasFailures(): boolean {
    for (const node of this.nodes.values()) {
      if (node.status === 'failed' || node.status === 'blocked') return true;
    }
    return false;
  }

  /** 获取所有转换记录 */
  getTransitions(): StepTransition[] {
    return [...this.transitions];
  }

  /**
   * 验证状态转换是否合法
   * @param from 起始状态
   * @param to 目标状态
   * @returns 是否合法
   */
  private validateTransition(from: StepStatus, to: StepStatus): boolean {
    if (from === to) return false;
    const allowed = LEGAL_TRANSITIONS[from] ?? [];
    return allowed.includes(to);
  }
}
