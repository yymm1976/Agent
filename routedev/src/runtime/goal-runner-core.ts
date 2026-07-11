// src/runtime/goal-runner-core.ts
// 目标运行器核心模块：类型定义、依赖接口、共享上下文、主入口工厂
// 从原 goal-runner.ts 拆分（Phase 79 Task 2），行为不变仅文件拆分
//
// 职责：
//   - 定义 GoalRunnerDeps 依赖注入接口
//   - 定义 GoalRunnerCtx 共享上下文（跨模块状态 + 函数引用）
//   - 实现 createGoalRunner 工厂：构建 ctx → 组装各子模块函数 → 返回公共 API

import type { LLMMessage, ILLMClient, ScenarioTier, RoutingResult } from '../router/types.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { TokenTracker } from '../router/tracker.js';
import type { ReActAgentLoop } from '../agent/loop.js';
import type { TokenProfiler } from '../agent/token-profiler.js';
import type { CheckpointManager } from '../harness/checkpoint-manager.js';
import type { ContextManager } from '../agent/memory/context-manager.js';
import type { AppConfig } from '../config/schema.js';
import type { GoalPlan, GoalPlanStatus, GoalStep, PlanStep, GoalEvent } from '../agent/goal-types.js';
// Phase 55 Task 9：DualLoop + BoundedRecovery 替代迭代闭环
import type { DualLoopOrchestrator } from '../agent/dual-loop-orchestrator.js';
import type { DualLoopParams } from '../agent/dual-loop-types.js';
// Phase 55：DagEngine 真实类型（替代 unknown 占位，适配 execute(workflow, executor) 签名）
import type { DagEngine, DagWorkflow, DagNode } from '../agent/workflow/dag-engine.js';
// Phase 32 Task 1.4：接入 CompletionGate（独立代码验证门）
import type { CompletionGate } from '../agent/completion-gate.js';
// Phase 50 Task 1：接入核心模块（默认 enabled: false，开关在 config.goalIntegration）
import type { GoalAuditor } from '../agent/goal-audit.js';
import type { GoalPersistence, PersistedGoal } from '../agent/goal-persistence.js';
// Phase 54 Task 1/4：多 Agent 编排 + 统一审查器接入
import type { Blackboard } from '../agent/multi/blackboard.js';
import type { UnifiedReviewer } from '../agent/unified-reviewer.js';
import type { StepExecutionResult } from '../agent/task-orchestrator-types.js';
// Phase 55 Task 11：CompositionalRouter（组合式路由器，跨领域任务分解 + Skill 检索）
import type { CompositionalRouterInstance } from './app-init.js';
// Phase 55 Task 11：CompositionalRouter 底层类型（AtomicSubTask 用于 decomposeFn 签名）
import type { AtomicSubTask } from '../skills/compositional-router.js';
// Phase 53 P5：步骤级钩子运行器（pre-step/post-step/on-complete）
import type { HookRunner, HookContext, StepResult } from '../agent/hooks.js';
// Phase 61：ACRouter 闭环模型路由
import type { RoutingHistory, RoutingRecord } from '../router/routing-history.js';
import type { RoutingMemory } from '../router/routing-memory.js';
import type { ExecutionVerifier } from '../router/execution-verifier.js';
import type { RoutingRegretTracker } from '../router/regret-tracker.js';
import type { RoutingOrchestrator } from '../router/orchestrator.js';
// Phase 58：统一路径路由器（合并 execution-router + level-path-router）
import type { PathRouter } from '../agent/path-router.js';
// Phase 54 Task 5：自主度行为映射（auto/semi/manual → 具体行为开关）
import type { AutonomyMode } from '../config/schema.js';

import { logger } from '../utils/logger.js';
import { GoalGateManager } from '../agent/goal-gates.js';

// 各子模块工厂（运行期 import，confirm/scheduler/recovery 仅 import type GoalRunnerCtx，无运行期循环依赖）
import { createConfirmFunctions } from './goal-runner-confirm.js';
import { createSchedulerFunctions } from './goal-runner-scheduler.js';
import { createRecoveryFunctions } from './goal-runner-recovery.js';

/** 上下文文本/诊断片段截断长度上限（step.result / taskSignature / args JSON 等） */
export const MAX_CONTEXT_ITEMS = 200;

/** GoalRunner 依赖的外部对象（由 App.tsx 注入） */
export interface GoalRunnerDeps {
  classifier: ScenarioClassifier;
  modelRouter: ModelRouter;
  clientManager: LLMClientManager;
  tracker: TokenTracker;
  agentLoop: ReActAgentLoop;
  checkpointManager: CheckpointManager;
  contextManager: ContextManager;
  config: AppConfig;
  /** Phase 30：系统提示词改为 ref（支持 PromptTemplateManager 异步渲染后更新） */
  systemPromptRef: { current: string };
  /** 对话历史 ref（会被读写） */
  conversationHistoryRef: { current: LLMMessage[] };
  /** 工具确认 pending ref（会被读写） */
  // Phase 54：resolve 扩展为接收 payload（ask_user 用户回答内容通过 payload 传回）
  pendingConfirmRef: { current: { resolve: (approved: boolean | { approved: boolean; payload?: unknown }) => void; toolName: string } | null };
  /** 中断控制器 ref（会被读写） */
  abortControllerRef: { current: AbortController | null };
  /** 当前计划 ref（会被读写） */
  currentPlanRef: { current: GoalPlan | null };
  /** 添加系统消息 */
  addSystemMessage: (content: string) => void;
  /** 请求用户编辑计划步骤（Phase 20：返回修改后的步骤或 null 表示取消） */
  requestPlanEdit: (plan: GoalPlan) => Promise<PlanStep[] | null>;
  /** 设置处理状态 */
  setIsProcessing: (v: boolean) => void;
  // F-022：setTodayTokensUsed 字段已移除（goal-bridge.ts 从未传入此字段）
  /** Phase 30：Token Profiler（可选） */
  profiler?: TokenProfiler;
  /** Phase 32 Task 1.4：独立代码验证门（typecheck/lint/tests 兜底，可选） */
  completionGate?: CompletionGate;
  /** Phase 50 Task 1：核心模块实例（由 app-init.ts 在开关开启时创建并注入，可选） */
  goalAuditor?: GoalAuditor;
  goalPersistence?: GoalPersistence;
  // Phase 59：goalPromptBuilder 已删除（批次1 无价值 Integration）
  // Phase 58：orchestrator/workerExecutor 接口字段已删除（executeWorkerStep 死方法清理）
  /**
   * Phase 54 Task 1：跨 Worker 共享状态（currentGoal/completedSteps/projectFacts）
   */
  blackboard?: Blackboard;
  /**
   * Phase 54 Task 4：统一审查器（可选，注入后 verifyPlan 调用 review() 获得 reviewerResult）
   * GoalAuditor.audit 的第三层（reviewer_agent）需要此结果
   */
  unifiedReviewer?: UnifiedReviewer;
  /** Phase 58：统一路径路由器（合并原 executionRouter + levelPathRouter） */
  pathRouter?: PathRouter;
  // Phase 59：difficultyAssessor/stateMigration 接口字段已删除（接线冗余，goal-runner 内部直接 new）
  /**
   * Phase 55 Task 9：DualLoopOrchestrator ref（异步创建，通过 ref 延迟绑定）
   * app-init.ts 中 DualLoopOrchestrator 在动态 import 的 .then() 回调内创建，
   * 此时 createGoalRunner 已被调用，故用 ref 让 /goal 实际触发时读取最新引用。
   * BoundedRecovery 已在 orchestrator 内部启用（setBoundedRecovery 注入配置）。
   */
  dualLoopOrchestratorRef?: { current: DualLoopOrchestrator | null };
  /**
   * Phase 55：DAG 引擎（由 app-init.ts 注入，可选，未注入时降级到单 Agent）
   * 真实签名 execute(workflow: DagWorkflow, executor: (node, action) => Promise<unknown>)
   */
  dagEngine?: DagEngine;
  /**
   * Phase 55 Task 11：CompositionalRouter 实例（由 app-init.ts 注入，可选）
   * 未注入时 executePlanWithCompose 降级到 executePlanWithDag
   * 跨领域任务（uniqueDomains > dagMaxDomains）走此路径：SAD 分解 + Skill 检索 + DAG 组合
   */
  compositionalRouter?: CompositionalRouterInstance;
  /** 生成消息 ID */
  nextId: () => string;
  /**
   * Phase 54：Goal 执行结构化事件回调（Electron 端注入，驱动 GoalExecutionCard 就地刷新）
   * 可选——CLI 端不传，行为不变；Electron 端注入后与 addSystemMessage 并存
   * goalId 由 engine-bridge 生成并注入，所有事件共用同一个 goalId
   */
  onGoalEvent?: (event: GoalEvent) => void;
  /** Phase 54：Goal 唯一标识（由 engine-bridge 生成注入，onGoalEvent 事件携带） */
  goalId?: string;
  /**
   * Phase 54：工具确认/用户提问触发器（Electron 端注入，复用 sendChat 的 onToolConfirmRequest）
   * clarifyGoalIfNeeded 检测到模糊参数时通过此回调触发 ask_user UI
   * CLI 端不传——澄清环节跳过，直接用原描述
   */
  onToolConfirmRequest?: (toolName: string, params: Record<string, unknown>) => void;
  /**
   * Phase 53 P5：步骤级钩子运行器（可选，未注入时 /goal 不触发步骤级 hook）
   *
   * 接入点：
   *   - executeSingleStep 开头触发 pre-step（abort→抛 PlanAbortError，skip→返回占位内容）
   *   - executeSingleStep 结尾触发 post-step（可修改结果，retry 硬上限 1 次）
   *   - executeGoalPlan 末尾触发 on-complete（覆盖 single/dag/compose/legacy 全部路径）
   *
   * 注：pre-tool-call/post-tool-call/on-session-start/on-session-end 已通过 agentLoop.run
   * 间接复用 AgentLoop.fireHookSafe，此处仅补充步骤级 hook，不重复触发工具级 hook
   */
  hookRunner?: HookRunner;
  // Phase 61：ACRouter 闭环模型路由（可选，由 app-init.ts 注入）
  routingHistory?: RoutingHistory;
  routingMemory?: RoutingMemory;
  executionVerifier?: ExecutionVerifier;
  routingRegretTracker?: RoutingRegretTracker;
  routingOrchestrator?: RoutingOrchestrator;
  // Phase 65：记忆系统（可选，由 app-init.ts 注入）
  memoryStore?: import('../memory/memory-store.js').MemoryStore;
  hybridRetriever?: import('../memory/hybrid-retriever.js').HybridRetriever;
  localMaintenance?: import('../memory/local-maintenance.js').LocalMaintenancePolicy;
  // Phase 68：知识图谱（可选，由 app-init.ts 注入）
  provenanceGraph?: import('../memory/provenance-graph.js').ProvenanceGraph;
  kanObstacleChecker?: import('../skills/kan-obstacle-checker.js').KanObstacleChecker;
  quantitativeGate?: import('../agent/quantitative-gate.js').QuantitativeGate;
  classifyOperation?: (signal: import('../skills/operation-classifier.js').OperationSignal, sessionId: string) => import('../skills/operation-classifier.js').OperationClassification;
}

/**
 * 共享上下文：在 createGoalRunner 中创建，传递给各子模块的函数工厂
 *
 * 包含：
 *   - deps：原始依赖注入（各模块按需解构使用）
 *   - 共享状态：emit / gid / gateManager / goalCfg / goalIntegration
 *   - 跨模块函数引用：createGoalRunner 组装后填充，各模块通过 ctx.xxx 调用
 *
 * 设计说明：原 goal-runner.ts 是单个 2000+ 行的闭包，所有函数共享 createGoalRunner
 * 作用域内的变量。拆分为多文件后，用 ctx 对象替代闭包作用域，行为完全等价。
 */
export interface GoalRunnerCtx {
  /** 原始依赖注入 */
  deps: GoalRunnerDeps;
  /** 结构化事件发射器（安全调用 onGoalEvent，CLI 端未注入时为 no-op） */
  emit: (event: GoalEvent) => void;
  /** Goal 唯一标识（Electron 端由 engine-bridge 注入；CLI 端用 nextId 生成临时 id） */
  gid: string;
  /** 验收门控管理器（Phase 21 Task 2：计划确认后冻结验收门控） */
  gateManager: GoalGateManager;
  /** Goal 配置缓存（config.goal） */
  goalCfg: AppConfig['goal'];
  /** Goal 集成开关缓存（config.goalIntegration） */
  goalIntegration: AppConfig['goalIntegration'];
  // F-023：currentGoalSpec 字段已移除（该字段永远为 null，无实际消费方）

  // ===== 跨模块函数引用（createGoalRunner 中组装后填充） =====
  /** 保存 plan 修订历史到 JSONL（confirm 模块） */
  savePlanRevision: (beforeSteps: GoalStep[], afterSteps: GoalStep[], reason: string) => Promise<void>;
  /** 处理 /goal 命令：解析目标、分解步骤、请求用户确认（confirm 模块） */
  handleGoalCommand: (text: string) => Promise<void>;
  /** 执行目标计划：逐步骤运行 Agent Loop，支持中断 + 检查点 + 压缩（scheduler 模块） */
  executeGoalPlan: (plan: GoalPlan) => Promise<void>;
  /** 验证目标完成度（LLM 验证）（recovery 模块） */
  verifyPlan: (plan: GoalPlan) => Promise<boolean>;
  /** 运行独立代码验证门（typecheck/lint/tests）（recovery 模块） */
  runCompletionGate: (plan: GoalPlan) => Promise<void>;
  /** 旧迭代闭环 fallback（DualLoop 未启用或异常时使用）（recovery 模块） */
  legacyIterativeLoop: (plan: GoalPlan) => Promise<void>;
  /** DualLoop 双循环恢复（含 BoundedRecovery）（recovery 模块） */
  runDualLoopPlan: (plan: GoalPlan, orchestrator: DualLoopOrchestrator) => Promise<boolean>;
  /** 从持久化的 PersistedGoal 恢复执行（recovery 模块） */
  resumeGoalPlan: (persistedGoal: PersistedGoal) => Promise<void>;
}

/** 创建目标运行器 */
export function createGoalRunner(deps: GoalRunnerDeps) {
  const { onGoalEvent, goalId: depsGoalId, nextId, config } = deps;

  // Phase 54：emit 辅助函数——安全调用 onGoalEvent（CLI 端未注入时为 no-op）
  const emit = (event: GoalEvent): void => {
    if (onGoalEvent) {
      try {
        onGoalEvent(event);
      } catch (err) {
        logger.warn('[goal-runner] onGoalEvent 调用失败（非阻塞）', { error: String(err) });
      }
    }
  };

  // Phase 54：goalId 统一来源——提升到 createGoalRunner 顶部，供所有闭包内函数复用
  // Electron 端由 engine-bridge 注入 depsGoalId；CLI 端用 nextId 生成临时 id
  const gid = depsGoalId ?? nextId();

  // Phase 21 Task 2：GoalGateManager 管理冻结的验收门控
  const gateManager = new GoalGateManager(process.cwd());
  // Phase 43：缓存 goal 配置，避免多处重复访问
  const goalCfg = config.goal;
  // Phase 50 Task 1：缓存 goalIntegration 开关（默认全部 false，渐进接入）
  const goalIntegration = config.goalIntegration;
  // F-023：currentGoalSpec 变量已移除（永远为 null，无实际消费方）

  // 构建共享上下文（函数字段稍后由各模块工厂填充）
  // 用 as GoalRunnerCtx 断言：此时 ctx 缺少函数字段，但函数在调用时已全部填充
  const ctx = {
    deps,
    emit,
    gid,
    gateManager,
    goalCfg,
    goalIntegration,
  } as GoalRunnerCtx;

  // 组装各模块函数——顺序无关，函数在调用时 ctx 已全部填充
  // 各模块函数闭包引用 ctx（按引用），Object.assign 后即可看到其他模块的函数
  Object.assign(ctx, createConfirmFunctions(ctx));
  Object.assign(ctx, createSchedulerFunctions(ctx));
  Object.assign(ctx, createRecoveryFunctions(ctx));

  return {
    handleGoalCommand: ctx.handleGoalCommand,
    executeGoalPlan: ctx.executeGoalPlan,
    resumeGoalPlan: ctx.resumeGoalPlan,
  };
}
