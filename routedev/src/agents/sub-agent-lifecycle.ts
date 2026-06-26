// src/agents/sub-agent-lifecycle.ts
// 子 Agent 生命周期管理：状态机 + 反滥用检测
//
// 解决问题：子 Agent 派发后缺少统一的生命周期跟踪，无法回答「这个子 Agent
// 现在什么状态？是否被频繁 challenge？token 消耗是否过高？」等问题。
//
// 状态转换规则（LEGAL_TRANSITIONS）：
//   pending    → running / blocked / aborted
//   running    → challenged / completed / failed / aborted
//   challenged → running / failed / aborted（父 Agent 回应后继续或终止）
//   completed  → （终态）
//   failed     → （终态）
//   aborted    → （终态）
//   blocked    → pending / aborted（门控解除后回到 pending）

/** 子 Agent 状态 */
type SubAgentStatus =
  | 'pending'
  | 'running'
  | 'challenged'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'blocked';

/** 子 Agent 运行态快照 */
export interface SubAgentState {
  agentId: string;
  taskId: string;
  role: string;
  profileId: string;
  status: SubAgentStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  challengeCount: number;
  tokenUsed: number;
  stepCount: number;
  error?: string;
}

/** 合法的状态转换映射 */
const LEGAL_TRANSITIONS: Record<SubAgentStatus, SubAgentStatus[]> = {
  pending: ['running', 'blocked', 'aborted'],
  running: ['challenged', 'completed', 'failed', 'aborted'],
  challenged: ['running', 'failed', 'aborted'], // 父 Agent 回应后
  completed: [],
  failed: [],
  aborted: [],
  blocked: ['pending', 'aborted'], // 门控解除后回到 pending
};

/** 终态集合 */
const TERMINAL_STATES: SubAgentStatus[] = ['completed', 'failed', 'aborted'];

/**
 * 子 Agent 生命周期管理器
 * 维护所有子 Agent 的状态机，验证转换合法性，累计 token / step / challenge 指标
 */
export class SubAgentLifecycle {
  private agents: Map<string, SubAgentState> = new Map();

  /** 注册新子 Agent（初始状态 pending） */
  register(agentId: string, taskId: string, role: string, profileId: string): void {
    this.agents.set(agentId, {
      agentId,
      taskId,
      role,
      profileId,
      status: 'pending',
      createdAt: Date.now(),
      challengeCount: 0,
      tokenUsed: 0,
      stepCount: 0,
    });
  }

  /**
   * 执行状态转换
   * @returns 转换是否合法并已执行
   */
  transition(agentId: string, to: SubAgentStatus, reason?: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    const from = agent.status;
    if (!this.validateTransition(from, to)) {
      return false;
    }

    agent.status = to;

    // 状态副作用
    if (to === 'running' && !agent.startedAt) {
      agent.startedAt = Date.now();
    }
    if (TERMINAL_STATES.includes(to)) {
      agent.completedAt = Date.now();
    }
    if (to === 'failed' && reason) {
      agent.error = reason;
    }
    if (to === 'aborted' && reason) {
      agent.error = reason;
    }

    return true;
  }

  /** 获取子 Agent 状态 */
  getState(agentId: string): SubAgentState | undefined {
    return this.agents.get(agentId);
  }

  /** 获取所有子 Agent */
  getAll(): SubAgentState[] {
    return Array.from(this.agents.values());
  }

  /** 获取活跃子 Agent（running 或 challenged） */
  getActive(): SubAgentState[] {
    return this.getAll().filter(a => a.status === 'running' || a.status === 'challenged');
  }

  /** 按 taskId 过滤 */
  getByTask(taskId: string): SubAgentState[] {
    return this.getAll().filter(a => a.taskId === taskId);
  }

  /** 该 task 所有子 Agent 是否都到达终态 */
  isComplete(taskId: string): boolean {
    const agents = this.getByTask(taskId);
    if (agents.length === 0) return false;
    return agents.every(a => TERMINAL_STATES.includes(a.status));
  }

  /** 该 task 是否存在失败子 Agent */
  hasFailures(taskId: string): boolean {
    return this.getByTask(taskId).some(a => a.status === 'failed');
  }

  /** 中止子 Agent（从非终态强制转到 aborted） */
  abort(agentId: string, reason?: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (TERMINAL_STATES.includes(agent.status)) return;
    // 直接置为 aborted 并记录原因
    agent.status = 'aborted';
    agent.completedAt = Date.now();
    if (reason) agent.error = reason;
  }

  /** 累计 token 消耗 */
  addTokens(agentId: string, count: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.tokenUsed += count;
  }

  /** 递增步骤计数 */
  incrementStep(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.stepCount += 1;
  }

  /** 递增 challenge 计数（父 Agent 提出质疑） */
  recordChallenge(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.challengeCount += 1;
  }

  /** 验证状态转换是否合法 */
  private validateTransition(from: SubAgentStatus, to: SubAgentStatus): boolean {
    if (from === to) return false;
    const allowed = LEGAL_TRANSITIONS[from] ?? [];
    return allowed.includes(to);
  }
}

/** 反滥用检测器：基于子 Agent 状态指标给出建议 */
export class AntiAbuseDetector {
  /** 默认频繁 challenge 阈值 */
  private static readonly DEFAULT_CHALLENGE_THRESHOLD = 3;
  /** 默认高 token 阈值 */
  private static readonly DEFAULT_TOKEN_THRESHOLD = 10000;
  /** 默认冗余读取阈值 */
  private static readonly DEFAULT_READ_THRESHOLD = 3;

  /**
   * 检测频繁 challenge
   * @param agents 子 Agent 状态列表
   * @param threshold challenge 计数阈值（默认 3）
   */
  static detectFrequentChallenges(
    agents: SubAgentState[],
    threshold: number = AntiAbuseDetector.DEFAULT_CHALLENGE_THRESHOLD,
  ): { agentId: string; challengeCount: number; suggestion: string }[] {
    const result: { agentId: string; challengeCount: number; suggestion: string }[] = [];
    for (const a of agents) {
      if (a.challengeCount >= threshold) {
        result.push({
          agentId: a.agentId,
          challengeCount: a.challengeCount,
          suggestion: `子 Agent ${a.agentId} 被 challenge ${a.challengeCount} 次，建议检查契约清晰度或终止该 Agent`,
        });
      }
    }
    return result;
  }

  /**
   * 检测高 token 低效果
   * @param agents 子 Agent 状态列表
   * @param threshold token 消耗阈值（默认 10000）
   */
  static detectLowEfficiency(
    agents: SubAgentState[],
    threshold: number = AntiAbuseDetector.DEFAULT_TOKEN_THRESHOLD,
  ): { agentId: string; tokenUsed: number; status: string; suggestion: string }[] {
    const result: { agentId: string; tokenUsed: number; status: string; suggestion: string }[] = [];
    for (const a of agents) {
      if (a.tokenUsed >= threshold) {
        result.push({
          agentId: a.agentId,
          tokenUsed: a.tokenUsed,
          status: a.status,
          suggestion: `子 Agent ${a.agentId} 已消耗 ${a.tokenUsed} tokens 仍处于 ${a.status}，建议审查任务范围或中止`,
        });
      }
    }
    return result;
  }

  /**
   * 检测重复读取
   * @param agents 子 Agent 状态列表（含 redundantReads 字段）
   * @param threshold 冗余读取阈值（默认 3）
   */
  static detectRedundantReads(
    agents: Array<SubAgentState & { redundantReads: number }>,
    threshold: number = AntiAbuseDetector.DEFAULT_READ_THRESHOLD,
  ): { agentId: string; redundantReads: number; suggestion: string }[] {
    const result: { agentId: string; redundantReads: number; suggestion: string }[] = [];
    for (const a of agents) {
      if (a.redundantReads >= threshold) {
        result.push({
          agentId: a.agentId,
          redundantReads: a.redundantReads,
          suggestion: `子 Agent ${a.agentId} 重复读取 ${a.redundantReads} 次，建议注入共享上下文包避免重复 IO`,
        });
      }
    }
    return result;
  }
}
