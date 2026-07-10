// desktop/main/bridges/engine-context.ts
// 引擎共享上下文：所有 delegate bridge 共享同一份 EngineContext 实例
// 持有 AppDependencies、EngineBridgeOptions 以及跨 bridge 共享的可变状态
// 设计说明：原 engine-bridge.ts 中 RouteDevEngine 持有大量 private 字段（config/deps/conversationHistory 等），
// 拆分为 delegate 后这些字段需要被多个 bridge 读写，因此提取为 EngineContext 由各 bridge 共享引用。

import type { AppConfig } from '../../shared/config-types.js';
import type { LLMMessage, ScenarioTier } from '../../../src/router/types.js';
import type { LLMClientManager } from '../../../src/router/llm/index.js';
import type { TokenTracker } from '../../../src/router/tracker.js';
import type { ScenarioClassifier } from '../../../src/router/classifier.js';
import type { ModelRouter } from '../../../src/router/router.js';
import type { AppDependencies } from '../../../src/runtime/app-init.js';
import type { ChatStreamPayload, GoalEvent, PlanEditRequestPayload } from '../../shared/ipc-types.js';
import type { TokenProfileSnapshot } from '../../../src/agent/token-profiler.js';
import type { TraceSpan } from '../../../src/harness/trace-types.js';
import type { AgentProfileManager } from '../../../src/agents/profiles/manager.js';
// 仅用于 GoalRunner 类型推导（ReturnType<typeof createGoalRunner>），用 import type 避免运行期依赖
import type { createGoalRunner } from '../../../src/runtime/goal-runner.js';
import type { ChatBridge } from './chat-bridge.js';
import type { ConfigBridge } from './config-bridge.js';
import type { MCPBridge } from './mcp-bridge.js';
import type { SkillBridge } from './skill-bridge.js';
import type { ExperimentBridge } from './experiment-bridge.js';
import type { GoalBridge } from './goal-bridge.js';

/** GoalRunner 实例类型（goal-runner.ts 未导出类型，用 ReturnType 推导） */
export type GoalRunner = ReturnType<typeof createGoalRunner>;

/** 工具确认回调的 resolver 类型（与 sendChat / GoalRunner 共享 ref 的元素类型一致） */
export type PendingConfirmEntry = {
  resolve: (result: boolean | { approved: boolean; payload?: unknown }) => void;
  toolName: string;
};

/** Skill 信息（IPC 传输用，剥离 content 避免大对象） */
export interface SkillInfo {
  name: string;
  description: string;
  routingKeywords: string[];
  enabled: boolean;
  sourcePath: string;
}

/** Skill 预览结果（含完整 content） */
export interface SkillPreview extends SkillInfo {
  content: string;
}

/** MCP 工具信息（IPC 传输用） */
export interface MCPToolInfo {
  /** 工具全名（含命名空间前缀 mcp__serverId__toolName） */
  name: string;
  /** 工具描述 */
  description: string;
  /** 所属 MCP 服务器 ID */
  serverId: string;
}

export interface EngineBridgeOptions {
  cwd: string;
  onStream: (payload: ChatStreamPayload) => void;
  onTokenProfile?: (snapshot: TokenProfileSnapshot) => void;
  /**
   * 工具确认请求回调
   * G-004 修复：新增 requestId 参数，标识是哪次并发聊天触发的确认请求，
   * 前端据此在 confirm-tool 回传中带上 requestId，实现精准 resolve
   */
  onToolConfirmRequest: (requestId: string, toolName: string, params: Record<string, unknown>) => void;
  onConfigReloaded?: (config: AppConfig) => void;
  /** Trace 事件回调：每次 TraceCollector 记录 span 时触发 */
  onTraceEvent?: (span: TraceSpan) => void;
  /** Phase 54：Goal 执行结构化事件回调（驱动渲染层 GoalExecutionCard 就地刷新） */
  onGoalEvent?: (event: GoalEvent) => void;
  /**
   * Phase 54：计划编辑请求回调（semi/manual 模式触发 StepEditor）
   * 主进程通过此回调把 plan 推送到渲染层，渲染层编辑后通过 plan:edit-response 回传
   */
  onPlanEditRequest?: (requestId: string, plan: PlanEditRequestPayload['plan']) => void;
}

/**
 * 引擎共享上下文
 *
 * 由 RouteDevEngine 持有，所有 delegate bridge 通过构造函数接收同一引用。
 * 桥接方法直接读写 ctx 上的字段，等价于原 RouteDevEngine 的 this.xxx 访问。
 *
 * 生命周期：
 *   1. RouteDevEngine 构造时创建 ctx（仅 config/options 有值，其余为 null/默认值）
 *   2. initialize() 填充 deps/clientManager/classifier/modelRouter/tracker/profileManager
 *   3. 运行期间 sendChat/goal 等方法读写 conversationHistory/abortControllers/currentModel 等可变状态
 *   4. destroy() 清理 deps 等资源，把字段重置为 null
 */
export class EngineContext {
  // ===== 配置与选项 =====
  // F-021：config 运行期可被 reloadConfig 替换，不加 readonly
  config: AppConfig;
  // F-021：options 引用构造后不变（内部 cwd 等属性可变），加 readonly
  readonly options: EngineBridgeOptions;

  // ===== 依赖（initialize 后赋值，destroy 后置 null） =====
  // F-021：以下字段在 initialize/destroy 中被重新赋值，不加 readonly
  deps: AppDependencies | null = null;
  clientManager: LLMClientManager | null = null;
  classifier: ScenarioClassifier | null = null;
  modelRouter: ModelRouter | null = null;
  tracker: TokenTracker | null = null;
  // Phase 48 Task 4：AgentProfileManager 实例（在 initialize() 中创建，懒加载避免阻塞启动）
  profileManager: AgentProfileManager | null = null;

  // ===== 对话状态（sendChat / executeCommand / syncConversationHistory 读写） =====
  // F-021：以下字段在运行期被频繁读写，不加 readonly
  conversationHistory: LLMMessage[] = [];
  currentModel = '';
  currentTier: ScenarioTier = 'simple';
  isDegraded = false;

  // ===== 工具确认 / 中断控制器（G-004：并发 requestId 隔离） =====
  /**
   * G-004 修复：按 requestId 索引的中断控制器 Map
   * 替代原共享单例 abortController，避免并发 sendChat 互相覆盖导致中断错乱。
   * 通过 setAbortController / getAbortController / clearAbortController 访问，
   * 不直接暴露 Map 引用（F-021 要求）。
   */
  private readonly abortControllers: Map<string, AbortController> = new Map();
  /**
   * G-004 修复：按 requestId 索引的工具确认 Map
   * 替代原共享单例 pendingConfirmRef，避免并发 sendChat 工具确认张冠李戴。
   * 通过 setPendingConfirm / getPendingConfirm / clearPendingConfirm 访问。
   */
  private readonly pendingConfirms: Map<string, PendingConfirmEntry> = new Map();
  /**
   * 保留 abortControllerRef 作为兼容——GoalRunner 仍通过 { current: T | null } 接口访问中断控制器
   * stopGeneration 时同时 abort 此 ref，让 GoalRunner 步骤循环检测到 aborted 后中止
   * F-021：引用构造后不变，加 readonly
   */
  readonly abortControllerRef: { current: AbortController | null } = { current: null };

  // ===== Goal 运行状态（GoalBridge 读写，sendChat/executeCommand 间接读取） =====
  /**
   * Phase 54：GoalRunner 实例（懒初始化）
   * 首次执行 /goal 命令时创建，复用 deps/classifier/modelRouter/clientManager/tracker
   * addSystemMessage 通过 onStream(text_delta) 推送到渲染进程
   */
  goalRunner: GoalRunner | null = null;
  /**
   * Phase 54：计划编辑请求的 resolver Map（按 requestId 索引）
   * requestPlanEdit 发送 IPC 请求后存入 resolver，resolvePlanEdit 收到响应时取出并 resolve
   * 渲染层 StepEditor 确认/取消 → IPC plan:edit-response → resolvePlanEdit → goal-runner Promise
   * F-021：Map 引用构造后不变，加 readonly
   */
  readonly pendingPlanEditResolvers: Map<string, (result: PlanEditRequestPayload['plan']['steps'] | null) => void> = new Map();
  /**
   * Phase 77：当前活跃 goal ID（用于 session:get-status 聚合）
   * executeGoalCommand 中赋值，goal 完成后保留以供状态卡展示最终态（completed/failed）
   * 下次 /goal 命令覆盖为新 goalId
   */
  currentGoalId: string | null = null;

  // ===== Bridge 互相引用（RouteDevEngine 构造完所有 bridge 后注入） =====
  // 用于跨 bridge 调用，例如 ChatBridge.executeCommand 需要 GoalBridge.executeGoalCommand
  // F-021：构造后被 RouteDevEngine 注入，不加 readonly
  bridges: EngineBridges | null = null;

  constructor(config: AppConfig, options: EngineBridgeOptions) {
    this.config = config;
    this.options = options;
  }

  // ============================================================
  // G-004：并发 requestId 隔离的辅助方法
  // 所有对 abortControllers / pendingConfirms 的访问均通过以下方法，
  // 不直接暴露 Map 引用（F-021 变更追踪要求）
  // ============================================================

  /** 设置指定 requestId 的中断控制器 */
  setAbortController(requestId: string, controller: AbortController): void {
    this.abortControllers.set(requestId, controller);
  }

  /** 获取指定 requestId 的中断控制器 */
  getAbortController(requestId: string): AbortController | undefined {
    return this.abortControllers.get(requestId);
  }

  /** 清除指定 requestId 的中断控制器（不 abort，仅从 Map 移除） */
  clearAbortController(requestId: string): void {
    this.abortControllers.delete(requestId);
  }

  /**
   * 中断并清除所有中断控制器（用于 stopGeneration 无 requestId 时或 destroy）
   * 逐个 abort 后清空 Map，确保进行中的 LLM 请求被中止
   */
  clearAllAbortControllers(): void {
    for (const controller of this.abortControllers.values()) {
      try { controller.abort(); } catch { /* 忽略 abort 异常 */ }
    }
    this.abortControllers.clear();
  }

  /** 设置指定 requestId 的工具确认 entry */
  setPendingConfirm(requestId: string, entry: PendingConfirmEntry): void {
    this.pendingConfirms.set(requestId, entry);
  }

  /** 获取指定 requestId 的工具确认 entry */
  getPendingConfirm(requestId: string): PendingConfirmEntry | undefined {
    return this.pendingConfirms.get(requestId);
  }

  /** 清除指定 requestId 的工具确认 entry（不 resolve，仅从 Map 移除） */
  clearPendingConfirm(requestId: string): void {
    this.pendingConfirms.delete(requestId);
  }

  /**
   * 清除所有工具确认 entry（用于 stopGeneration 无 requestId 时）
   * 对每个 entry resolve(false) 以释放阻塞的 Promise，避免线程泄漏
   */
  clearAllPendingConfirms(): void {
    for (const entry of this.pendingConfirms.values()) {
      try { entry.resolve({ approved: false }); } catch { /* 忽略 resolve 异常 */ }
    }
    this.pendingConfirms.clear();
  }
}

/**
 * Bridge 互相引用的集合类型
 * 仅用 import type 引用各 bridge 类，编译期擦除，避免运行期循环依赖
 */
export interface EngineBridges {
  chat: ChatBridge;
  config: ConfigBridge;
  mcp: MCPBridge;
  skill: SkillBridge;
  experiment: ExperimentBridge;
  goal: GoalBridge;
}
