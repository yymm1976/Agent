// src/agent/multi/types.ts
// 多 Agent 协作的类型定义（Phase 14）
// 蓝图参考：第五节决策 5、第十节 10.2

/** Worker 角色 */
export type WorkerRole = 'coder' | 'searcher' | 'tester' | 'reviewer';

/** 步骤依赖关系（Orchestrator 输出） */
export interface StepDependency {
  /** 步骤 ID（对应 GoalPlan.steps[].id） */
  stepId: number;
  /** 依赖的步骤 ID 列表 */
  dependsOn: number[];
  /** 分配的 Worker 角色 */
  assignedRole: WorkerRole;
  /** 可能涉及的文件（从步骤描述推断） */
  likelyFiles: string[];
  /**
   * 验收标准（Phase 54 Task 3：从 GoalStep.acceptanceCriteria 传递）
   * 供协作剧场面板展示与 GoalAuditor 三层验收使用
   */
  acceptanceCriteria?: string;
}

/** 执行计划（Orchestrator 输出） */
export interface ExecutionPlan {
  /** 步骤依赖图 */
  dependencies: StepDependency[];
  /** 可并行的步骤组（每组内的步骤可以同时执行） */
  parallelGroups: number[][];
  /** 执行顺序（考虑依赖后的拓扑排序） */
  executionOrder: number[];
  /** Orchestrator 的分析备注 */
  analysisNotes: string;
}

/** Blackboard 条目（公共信息） */
export interface BlackboardEntry {
  /** 键 */
  key: string;
  /** 值 */
  value: string;
  /** 来源（哪个 Worker 写入的） */
  source: {
    role: WorkerRole;
    stepId: number;
  };
  /** 写入时间 */
  timestamp: number;
  /** 置信度（0-1） */
  confidence: number;
}

/** Blackboard 快照（给 Worker 读的上下文） */
export interface BlackboardSnapshot {
  /** 当前目标 */
  currentGoal: {
    description: string;
    status: string;
  } | null;
  /** 已完成步骤的结论 */
  completedSteps: BlackboardEntry[];
  /** 项目共识（不变的事实） */
  projectFacts: BlackboardEntry[];
}

/** Worker 任务分配 */
export interface WorkerTask {
  /** 步骤 ID */
  stepId: number;
  /** 步骤描述 */
  description: string;
  /** Worker 角色 */
  role: WorkerRole;
  /** 角色特定的 system prompt 追加内容 */
  rolePrompt: string;
  /** Blackboard 快照（Worker 可读的上下文） */
  blackboardSnapshot: BlackboardSnapshot;
  /**
   * Phase 55 Task 15 修复：所属 Goal ID（可选，由 /goal 路径调用方传入）
   * 注入后 WorkerExecutor.execute() 会在完成时调用 cacheStatsTracker.recordWorkerCacheHit()
   * 未传时跳过 Worker 级别缓存统计（如 unified-reviewer 的 review task）
   */
  goalId?: string;
}

/** Worker 执行结果 */
export interface WorkerResult {
  /** 步骤 ID */
  stepId: number;
  /** 角色 */
  role: WorkerRole;
  /** 是否成功 */
  success: boolean;
  /** 结论摘要（写入 Blackboard 的内容） */
  conclusion: string;
  /** 涉及的文件 */
  modifiedFiles: string[];
  /** token 消耗 */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    /** Phase 55：缓存读取 token 数（命中） */
    cacheReadTokens?: number;
    /** Phase 55：缓存创建 token 数（未命中,新写入） */
    cacheCreationTokens?: number;
  };
  /** 失败时建议的上层动作 */
  suggestedAction?: 'retry' | 'skip' | 'abort';
}

/** 冲突检测结果 */
export interface ConflictResult {
  /** 是否有冲突 */
  hasConflict: boolean;
  /** 冲突的文件列表 */
  conflictingFiles: string[];
  /** 冲突的步骤 ID 对 */
  conflictingSteps: Array<[number, number]>;
  /** 建议 */
  suggestion: string;
}
