// desktop/renderer/src/store/useRouteDevStore.ts
// Zustand store：集中管理 RouteDev 渲染进程状态，替代 useState/useRef
// IPC 事件订阅通过 initIPCListeners() 在 App.tsx 中初始化

import { create } from 'zustand';
import type {
  AppConfig,
  ChatSendPayload,
  ChatStreamPayload,
  ConfigSaveResult,
  ToolConfirmPayload,
  TokenProfileSnapshot,
  GoalEvent,
  CompletionStatus,
} from '../../../shared/ipc-types.js';
import type { TraceSpan } from '../../../../src/harness/trace-types.js';
// 静态导入 useProjectsStore：该 store 仅导入本文件的类型（编译后移除），运行时无循环依赖
import { useProjectsStore } from './useProjectsStore.js';

// ===== 类型定义（从 hook 迁移，保持兼容） =====
export type MessageRole = 'user' | 'assistant' | 'system';

// 工具调用状态
export type ToolCallStatus = 'running' | 'completed' | 'error';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** 模型推理过程（DeepSeek-R1 等 reasoning 模型的思考过程，显示在折叠区内） */
  reasoning?: string;
  /**
   * 中间自言自语：ReAct 循环里每轮工具调用前 LLM 输出的说明性文字
   * 在 _addToolStart 时从 _assistantBuffer 封存，清空 buffer 让后续 text_delta 重新累积为最终输出
   * 只有最后一轮（无后续 tool_call）的 text_delta 才会保留在 content 上
   */
  intermediateThoughts?: { id: string; text: string; timestamp: number }[];
  /** 执行过程中的工作流状态；与工具调用一起按真实时间顺序呈现。 */
  progressEvents?: { id: string; text: string; timestamp: number }[];
  /** 本条 assistant 回复匹配到的任务层级 */
  tier?: string;
  isStreaming?: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  toolStatus?: ToolCallStatus;
  /**
   * Phase 96 P1-1：工具调用 ID，用于关联 tool_call_delta 增量输出
   * 仅在 tool_start 事件携带 toolCallId 时填充
   */
  toolCallId?: string;
  /**
   * Phase 96 P1-1：工具执行增量输出缓冲（shell_exec 等长任务的实时 stdout/stderr）
   * tool_call_delta 事件追加到此字段，tool_done 时清空并写入 toolResult
   */
  toolDeltaBuffer?: string;
  error?: boolean;
  /** 任务 ID：同一次 sendMessage 产生的所有消息共享同一 taskId */
  taskId?: string;
  /** 消息创建时间戳（毫秒） */
  timestamp?: number;
  /** 任务开始时间（仅 user 消息记录，用于计算耗时） */
  taskStartTime?: number;
  /** 任务总耗时（毫秒，仅任务完成的标记消息） */
  taskDuration?: number;
  /** 任务是否已完成（用于折叠判断） */
  taskCompleted?: boolean;
  /** Phase 54：Goal 执行标识——非空时用 GoalExecutionCard 替代文本渲染 */
  goalId?: string;
  /** Phase 91：任务完成状态（仅本轮发生代码修改且 done 事件携带时设置） */
  completionStatus?: CompletionStatus;
}

export interface PendingConfirm {
  /** G-004 修复：关联的聊天请求 ID，confirmTool 回传时带上以精准 resolve */
  requestId: string;
  toolName: string;
  params: Record<string, unknown>;
}

// ===== Phase 54：Goal 执行聚合状态（渲染层消费，按 goalId 聚合 GoalEvent） =====
export interface GoalStepState {
  id: number;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  durationMs?: number;
  /** Phase 54：步骤开始时间戳（运行态实时耗时计算用） */
  startedAt?: number;
  /** 多 Agent 路径的 Worker 活动日志（按时间线累积） */
  activities: { role: string; activity: string; timestamp: number }[];
}

export interface GoalExecution {
  goalId: string;
  description: string;
  autonomyMode: string;
  verificationCriteria?: string;
  steps: GoalStepState[];
  status: 'running' | 'completed' | 'failed';
  verification?: { passed: boolean; confidence: number; reasoning: string; missingItems: string[] };
  done?: { success: boolean; totalDurationMs: number; summary: string };
  createdAt: number;
}

// ===== Store 状态接口 =====
export interface RouteDevState {
  // ===== 状态 =====
  messages: ChatMessage[];
  isProcessing: boolean;
  currentModel: string;
  currentTier: string;
  config: AppConfig | null;
  configLoading: boolean;
  configError: string | null;  // 配置加载失败时的错误信息，用于显示错误页面而非 SetupWizard
  // Bug #5 修复：标记用户是否曾配置过 provider，避免保存错误导致 providers 清空时误触发 SetupWizard
  hasEverHadProviders: boolean;
  pendingConfirm: PendingConfirm | null;
  tokenSnapshots: TokenProfileSnapshot[];
  traceEvents: TraceSpan[];
  // Phase 54：Goal 执行聚合状态（按 goalId 索引，驱动 GoalExecutionCard 就地刷新）
  goalExecutions: GoalExecution[];
  /**
   * Phase 54：待编辑的计划（semi/manual 模式触发 StepEditor 显示）
   * 由 plan:edit-request 事件设置；confirmPlanEdit/cancelPlanEdit 后清空
   */
  pendingPlanEdit: {
    requestId: string;
    plan: {
      description: string;
      verificationCriteria?: string;
      steps: { id: number; description: string; acceptanceCriteria?: string; dependencies: number[]; suggestedRole?: 'researcher' | 'executor' | 'reviewer' }[];
    };
  } | null;
  // 瞬态进度文案（不落盘到对话历史）
  progressLabel: string | null;

  // ===== 操作 =====
  sendMessage: (text: string) => void;
  confirmTool: (approved: boolean, payload?: unknown) => void;
  clearMessages: () => void;
  stopGeneration: () => void;
  saveConfig: (config: AppConfig) => Promise<ConfigSaveResult>;
  reloadConfig: () => Promise<void>;
  executeCommand: (text: string) => Promise<unknown>;
  /** 删除单条消息（从当前对话消息列表中移除） */
  deleteMessage: (messageId: string) => void;
  /**
   * 重试某条消息：删除该消息及其后所有消息，重新发送
   * - 若 messageId 是用户消息：删除该消息及之后所有消息，重新发送该用户消息
   * - 若 messageId 是助手消息：删除该消息及之后所有消息，重新发送上一条用户消息
   */
  retryMessage: (messageId: string) => void;

  // Phase 54：计划编辑（StepEditor）操作
  /** 用户确认计划编辑，回传编辑后的步骤列表到主进程 */
  confirmPlanEdit: (steps: { id: number; description: string; acceptanceCriteria?: string; dependencies: number[]; suggestedRole?: 'researcher' | 'executor' | 'reviewer' }[]) => void;
  /** 用户取消计划编辑，回传 null 到主进程 */
  cancelPlanEdit: () => void;

  // ===== 内部状态 =====
  _assistantBuffer: string;
  _assistantId: string | null;
  /** 当前任务 ID（一次 sendMessage 对应一个任务） */
  _currentTaskId: string | null;
  /** 当前任务开始时间戳 */
  _currentTaskStartTime: number | null;
  /** 待刷新到 messages 的文本增量缓冲（rAF 节流用） */
  _pendingDelta: string;
  /** 流式刷新调度句柄（null 表示无待执行刷新） */
  _rafHandle: number | null;
  /** 推理过程累积缓冲（reasoning 模型的思考过程） */
  _reasoningBuffer: string;
  /** 待刷新到 messages 的推理增量缓冲（rAF 节流用） */
  _pendingReasoning: string;
  /** reasoning 流式刷新调度句柄 */
  _reasoningRafHandle: number | null;
  /**
   * 中间自言自语累积列表：每次 _addToolStart 时从 _assistantBuffer 封存
   * 任务完成时写到 latestAssistant.intermediateThoughts，渲染时按时间顺序穿插在工具调用之间
   */
  _intermediateThoughts: { id: string; text: string; timestamp: number }[];
  /** 当前任务的工作流状态历史；完成时封存到 assistant 消息。 */
  _progressEvents: { id: string; text: string; timestamp: number }[];

  // ===== 内部操作 =====
  _appendTextDelta: (chunk: string) => void;
  _flushPendingDelta: () => void;
  _appendReasoningDelta: (chunk: string) => void;
  _flushPendingReasoning: () => void;
  _appendProgressEvent: (text: string) => void;
  _startAssistantMessage: () => void;
  _finishAssistantMessage: (completionStatus?: CompletionStatus) => void;
  _addToolStart: (toolName: string, args?: Record<string, unknown>, toolCallId?: string) => void;
  _addToolDone: (toolName: string, result: unknown, isError?: boolean, toolCallId?: string) => void;
  /** Phase 96 P1-1：追加工具执行增量输出到对应 tool 消息的 toolDeltaBuffer */
  _appendToolDelta: (toolCallId: string, chunk: string) => void;
  _setError: (error: string) => void;
  _setProcessing: (processing: boolean) => void;
  _setPendingConfirm: (confirm: PendingConfirm | null) => void;
  _addTokenSnapshot: (snapshot: TokenProfileSnapshot) => void;
  _addTraceEvent: (span: TraceSpan) => void;
  /** Phase 54：处理 Goal 执行结构化事件（聚合到 goalExecutions） */
  _handleGoalEvent: (event: GoalEvent) => void;
  /** Phase 54：设置待编辑计划（由 plan:edit-request 事件触发） */
  _setPendingPlanEdit: (planEdit: RouteDevState['pendingPlanEdit']) => void;
  _setConfig: (config: AppConfig) => void;
  _setConfigLoading: (loading: boolean) => void;
  _setCurrentModel: (model: string) => void;
}

// ===== 创建 Store =====
export const useRouteDevStore = create<RouteDevState>((set, get) => ({
  // 状态初始值
  messages: [],
  isProcessing: false,
  currentModel: '',
  currentTier: '',
  config: null,
  configLoading: true,
  configError: null,
  hasEverHadProviders: false,
  pendingConfirm: null,
  tokenSnapshots: [],
  traceEvents: [],
  goalExecutions: [],
  pendingPlanEdit: null,
  progressLabel: null,

  // 内部状态初始值
  _assistantBuffer: '',
  _assistantId: null,
  _currentTaskId: null,
  _currentTaskStartTime: null,
  _pendingDelta: '',
  _rafHandle: null,
  _reasoningBuffer: '',
  _pendingReasoning: '',
  _reasoningRafHandle: null,
  _intermediateThoughts: [],
  _progressEvents: [],

  // ===== 操作 =====
  sendMessage: (text) => {
    const state = get();
    if (!text.trim() || state.isProcessing) return;
    const trimmed = text.trim();

    // F-007 修复：slash 命令（非 /goal）路由到 command.execute
    // /goal 仍走 chat:send（engine-bridge.ts 会拦截并交由 GoalRunner 执行）
    // 之前所有 slash 命令都被当普通文本发给 LLM，导致 /clear /status /mcp 等命令不生效
    if (trimmed.startsWith('/') && !trimmed.startsWith('/goal')) {
      const now = Date.now();
      const taskId = `task-${now}`;
      const userMsg: ChatMessage = {
        id: `u-${now}`,
        role: 'user',
        content: trimmed,
        taskId,
        timestamp: now,
        taskStartTime: now,
      };
      set({
        messages: [...state.messages, userMsg],
        _currentTaskId: taskId,
      });
      // 异步执行命令，结果作为 assistant 消息追加显示
      void window.routedev.command.execute({ text: trimmed }).then((result: unknown) => {
        const r = result as { ok?: boolean; message?: string } | null;
        const content = r?.message ?? (r?.ok ? '命令已执行' : '命令执行失败');
        const ts = Date.now();
        set((s) => ({
          messages: [...s.messages, {
            id: `a-${ts}`,
            role: 'assistant' as const,
            content,
            taskId,
            timestamp: ts,
          }],
          _currentTaskId: null,
        }));
      }).catch((err: unknown) => {
        const ts = Date.now();
        set((s) => ({
          messages: [...s.messages, {
            id: `a-${ts}`,
            role: 'assistant' as const,
            content: `命令执行失败: ${err instanceof Error ? err.message : String(err)}`,
            error: true,
            taskId,
            timestamp: ts,
          }],
          _currentTaskId: null,
        }));
      });
      return;
    }

    const now = Date.now();
    const taskId = `task-${now}`;
    const userMsg: ChatMessage = {
      id: `u-${now}`,
      role: 'user',
      content: trimmed,
      taskId,
      timestamp: now,
      taskStartTime: now,
    };
    const assistantMsg: ChatMessage = {
      id: `a-${now}`,
      role: 'assistant',
      content: '',
      isStreaming: true,
      taskId,
      timestamp: now,
    };
    set({
      messages: [...state.messages, userMsg, assistantMsg],
      isProcessing: true,
      _assistantId: assistantMsg.id,
      _assistantBuffer: '',
      _currentTaskId: taskId,
      _currentTaskStartTime: now,
      _reasoningBuffer: '',
      _pendingReasoning: '',
      _reasoningRafHandle: null,
      _intermediateThoughts: [],
      _progressEvents: [],
      _progressEvents: [],
    });
    window.routedev.chat.send({ text: trimmed } as ChatSendPayload);
  },

  confirmTool: (approved, payload) => {
    // G-004 修复：从 pendingConfirm 中取出 requestId，回传给主进程以精准 resolve
    const { pendingConfirm } = get();
    set({ pendingConfirm: null });
    if (pendingConfirm) {
      window.routedev.chat.confirmTool({ requestId: pendingConfirm.requestId, approved, payload } as ToolConfirmPayload);
    }
  },

  clearMessages: () => {
    // G-008：清空对话时同步清空遥测与 Goal 集合，避免无界增长残留
    set({ messages: [], tokenSnapshots: [], traceEvents: [], goalExecutions: [] });
    window.routedev.command.execute({ text: '/clear' });
  },

  deleteMessage: (messageId) => {
    const state = get();
    const target = state.messages.find((m) => m.id === messageId);
    if (!target) {
      set({ messages: state.messages.filter((m) => m.id !== messageId) });
      return;
    }
    // Phase 54 修复：TaskBlock 按 taskId 聚合渲染 reasoning（ChatPage.tsx reasoningText），
    // 删除单条消息后剩余消息仍属同 task，会继续显示思考过程。
    // 因此有 taskId 的消息按整组删除（与 retryMessage 行为一致），无 taskId 的独立消息按单条删除。
    const newMessages = target.taskId
      ? state.messages.filter((m) => m.taskId !== target.taskId)
      : state.messages.filter((m) => m.id !== messageId);
    set({ messages: newMessages });
  },

  retryMessage: (messageId) => {
    const state = get();
    if (state.isProcessing) return;
    const msgIndex = state.messages.findIndex((m) => m.id === messageId);
    if (msgIndex < 0) return;
    const targetMsg = state.messages[msgIndex];
    // 确定要重试的用户消息文本，以及保留消息的截断位置
    // cutIndex 之前的消息会被保留（slice(0, cutIndex)），cutIndex 及之后全部删除
    let userText = '';
    let cutIndex = msgIndex;
    if (targetMsg.role === 'user') {
      // 用户消息重试：删除该消息及之后所有消息，重新发送该用户消息
      // slice(0, msgIndex) 不包含该 user 消息，正确
      userText = targetMsg.content;
      cutIndex = msgIndex;
    } else if (targetMsg.role === 'assistant') {
      // 助手消息重试：找到该助手消息对应的上一条用户消息
      // 截断位置设为该用户消息的索引，这样 slice(0, cutIndex) 不包含该 user 消息
      // 避免保留旧 user 消息后又追加新 user 消息导致重复
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (state.messages[i].role === 'user') {
          userText = state.messages[i].content;
          cutIndex = i;
          break;
        }
      }
    }
    if (!userText.trim()) return;
    // 删除截断位置及之后所有消息（覆盖之前的回复，避免重复）
    const keptMessages = state.messages.slice(0, cutIndex);
    // 创建新的用户消息 + 空助手消息（流式占位）
    const now = Date.now();
    const taskId = `task-${now}`;
    const userMsg: ChatMessage = {
      id: `u-${now}`,
      role: 'user',
      content: userText.trim(),
      taskId,
      timestamp: now,
      taskStartTime: now,
    };
    const assistantMsg: ChatMessage = {
      id: `a-${now}`,
      role: 'assistant',
      content: '',
      isStreaming: true,
      taskId,
      timestamp: now,
    };
    set({
      messages: [...keptMessages, userMsg, assistantMsg],
      isProcessing: true,
      _assistantId: assistantMsg.id,
      _assistantBuffer: '',
      _currentTaskId: taskId,
      _currentTaskStartTime: now,
      _reasoningBuffer: '',
      _pendingReasoning: '',
      _reasoningRafHandle: null,
      _intermediateThoughts: [],
    });
    window.routedev.chat.send({ text: userText.trim() } as ChatSendPayload);
  },

  stopGeneration: () => {
    // 直接通过 IPC 中断生成，不依赖 /stop 命令
    window.routedev.chat.stop();
    set({ isProcessing: false });
    // 清理流式状态
    const state = get();
    if (state._rafHandle !== null) {
      window.clearTimeout(state._rafHandle);
    }
    if (state._reasoningRafHandle !== null) {
      window.clearTimeout(state._reasoningRafHandle);
    }
    // Phase 54 修复兜底：终止时把所有 running 的 GoalExecution 标记为终止
    // 防止 abort 后 done 事件漏发导致 GoalExecutionCard 卡在转圈状态
    const runningGoals = state.goalExecutions.filter(g => g.status === 'running');
    if (runningGoals.length > 0) {
      set({
        goalExecutions: state.goalExecutions.map(g =>
          g.status === 'running'
            ? {
                ...g,
                status: 'failed' as const,
                done: {
                  success: false,
                  totalDurationMs: Date.now() - g.createdAt,
                  summary: `${g.steps.filter(s => s.status === 'completed').length}/${g.steps.length} 步骤完成 · 用户已终止`,
                },
              }
            : g,
        ),
      });
    }
    if (state._assistantId) {
      const finalThoughts = state._intermediateThoughts;
      const finalProgressEvents = state._progressEvents;
      set({
        messages: state.messages.map((m) =>
          m.id === state._assistantId
            ? {
                ...m,
                isStreaming: false,
                content: state._assistantBuffer,
                reasoning: state._reasoningBuffer || undefined,
                ...(finalThoughts.length > 0 ? { intermediateThoughts: finalThoughts } : {}),
                ...(finalProgressEvents.length > 0 ? { progressEvents: finalProgressEvents } : {}),
              }
            : m,
        ),
        _assistantId: null,
        _assistantBuffer: '',
        _pendingDelta: '',
        _rafHandle: null,
        _reasoningBuffer: '',
        _pendingReasoning: '',
        _reasoningRafHandle: null,
        _intermediateThoughts: [],
      });
    }
  },

  // Phase 54：用户确认计划编辑——回传编辑后的步骤到主进程，清空 pendingPlanEdit
  confirmPlanEdit: (steps) => {
    const { pendingPlanEdit } = get();
    if (!pendingPlanEdit) return;
    window.routedev.plan.respondEdit({ requestId: pendingPlanEdit.requestId, steps });
    set({ pendingPlanEdit: null });
  },

  // Phase 54：用户取消计划编辑——回传 null 到主进程，清空 pendingPlanEdit
  cancelPlanEdit: () => {
    const { pendingPlanEdit } = get();
    if (!pendingPlanEdit) return;
    window.routedev.plan.respondEdit({ requestId: pendingPlanEdit.requestId, steps: null });
    set({ pendingPlanEdit: null });
  },

  saveConfig: async (cfg) => {
    const result = await window.routedev.config.save(cfg);
    if (result.success) {
      // 保存成功后从磁盘重新加载（主进程会脱敏返回），
      // 确保 store.config 与磁盘一致，同时让主进程的掩码回填结果反映到 store
      try {
        const diskConfig = await window.routedev.config.reload();
        // Bug #5：一旦磁盘有 provider 就标记 hasEverHadProviders，防止后续保存错误清空时误触发 SetupWizard
        const hadProviders = Array.isArray(diskConfig.providers) && diskConfig.providers.length > 0;
        set((prev) => ({
          config: diskConfig,
          hasEverHadProviders: prev.hasEverHadProviders || hadProviders,
        }));
      } catch {
        // Bug 修复：reload 失败时用 config:get 从磁盘加载（不触发 engine.reloadConfig），
        // 而非用 cleanedDraft（含掩码 apiKey）覆盖，避免掩码值污染 store.config
        // config:save 已成功写入磁盘且 engine.updateConfig 已更新引擎内存配置，
        // 仅 deps 重建失败（LLM 客户端/分类器），不影响配置正确性
        try {
          const diskConfig = await window.routedev.config.get();
          const hadProviders = Array.isArray(diskConfig.providers) && diskConfig.providers.length > 0;
          set((prev) => ({
            config: diskConfig,
            hasEverHadProviders: prev.hasEverHadProviders || hadProviders,
          }));
        } catch {
          // config:get 也失败：不更新 config，保持旧值
          // 用户可手动重启应用恢复
        }
      }
    }
    return result;
  },

  reloadConfig: async () => {
    const cfg = await window.routedev.config.reload();
    const hadProviders = Array.isArray(cfg.providers) && cfg.providers.length > 0;
    set((prev) => ({
      config: cfg,
      hasEverHadProviders: prev.hasEverHadProviders || hadProviders,
    }));
  },

  executeCommand: (text) => {
    return window.routedev.command.execute({ text });
  },

  // ===== 内部操作 =====
  _appendTextDelta: (chunk) => {
    const state = get();
    if (!state._assistantId) return;
    // 累积到 pendingDelta 缓冲区，不立即触发 setState
    // 这样高频 IPC 事件（text_delta）不会每次都触发 React 重渲染
    const pending = state._pendingDelta + chunk;
    // 同步更新 buffer（用于 done 时最终一致性校验）
    const buffer = state._assistantBuffer + chunk;
    set({ _pendingDelta: pending, _assistantBuffer: buffer });
    // 若无待执行刷新，调度短间隔刷新；不用 rAF，避免窗口失焦时 rAF 暂停导致回切后一次性喷发
    if (state._rafHandle === null) {
      const handle = window.setTimeout(() => {
        get()._flushPendingDelta();
      }, 33);
      set({ _rafHandle: handle });
    }
  },

  _flushPendingDelta: () => {
    const state = get();
    if (state._rafHandle !== null) {
      window.clearTimeout(state._rafHandle);
    }
    if (!state._assistantId) {
      set({ _pendingDelta: '', _rafHandle: null });
      return;
    }
    const delta = state._pendingDelta;
    if (!delta) {
      set({ _rafHandle: null });
      return;
    }
    // 一次性将累积的 delta 刷新到 messages，触发一次重渲染
    set({
      _pendingDelta: '',
      _rafHandle: null,
      messages: state.messages.map((m) =>
        m.id === state._assistantId ? { ...m, content: state._assistantBuffer } : m,
      ),
    });
  },

  _appendReasoningDelta: (chunk: string) => {
    const state = get();
    if (!state._assistantId) return;
    // 累积推理过程到缓冲区，使用 rAF 节流
    const pending = state._pendingReasoning + chunk;
    const buffer = state._reasoningBuffer + chunk;
    set({ _pendingReasoning: pending, _reasoningBuffer: buffer });
    if (state._reasoningRafHandle === null) {
      const handle = window.setTimeout(() => {
        get()._flushPendingReasoning();
      }, 33);
      set({ _reasoningRafHandle: handle });
    }
  },

  _flushPendingReasoning: () => {
    const state = get();
    if (state._reasoningRafHandle !== null) {
      window.clearTimeout(state._reasoningRafHandle);
    }
    if (!state._assistantId) {
      set({ _pendingReasoning: '', _reasoningRafHandle: null });
      return;
    }
    if (!state._pendingReasoning) {
      set({ _reasoningRafHandle: null });
      return;
    }
    set({
      _pendingReasoning: '',
      _reasoningRafHandle: null,
      messages: state.messages.map((m) =>
        m.id === state._assistantId ? { ...m, reasoning: state._reasoningBuffer } : m,
      ),
    });
  },

  _appendProgressEvent: (text) => {
    const normalized = text.trim();
    const state = get();
    if (!normalized || !state._assistantId) return;

    // 相同的流式状态会重复抵达；只保留一次，避免时间线变成噪声。
    const last = state._progressEvents[state._progressEvents.length - 1];
    if (last?.text === normalized) return;

    const event = { id: `progress-${Date.now()}`, text: normalized, timestamp: Date.now() };
    const progressEvents = [...state._progressEvents, event];
    set({
      progressLabel: normalized,
      _progressEvents: progressEvents,
      messages: state.messages.map((message) =>
        message.id === state._assistantId ? { ...message, progressEvents } : message,
      ),
    });
  },

  _startAssistantMessage: () => {
    // 创建新的 assistant 消息，设置 _assistantId
    const state = get();
    const now = Date.now();
    const taskId = state._currentTaskId ?? `task-${now}`;
    const assistantMsg: ChatMessage = {
      id: `a-${now}`,
      role: 'assistant',
      content: '',
      isStreaming: true,
      taskId,
      timestamp: now,
    };
    set({
      messages: [...state.messages, assistantMsg],
      _assistantId: assistantMsg.id,
      _assistantBuffer: '',
    });
  },

  _finishAssistantMessage: (completionStatus) => {
    // 清除 _assistantId 和 _assistantBuffer，标记消息完成
    // 同时计算任务耗时并标记该任务下所有消息为已完成
    const state = get();
    if (!state._assistantId) return;
    // 完成前先 flush 待处理的 delta，避免最后一段文本丢失
    if (state._rafHandle !== null) {
      window.clearTimeout(state._rafHandle);
    }
    if (state._reasoningRafHandle !== null) {
      window.clearTimeout(state._reasoningRafHandle);
    }
    const finalContent = state._assistantBuffer;
    const finalReasoning = state._reasoningBuffer;
    const finalThoughts = state._intermediateThoughts;
    const finalProgressEvents = state._progressEvents;
    const startTime = state._currentTaskStartTime;
    const duration = startTime ? Date.now() - startTime : 0;
    const taskId = state._currentTaskId;
    set({
      // 标记同任务下所有消息为已完成，并记录耗时（仅在 user 消息上记录 taskDuration）
      messages: state.messages.map((m) => {
        if (m.id === state._assistantId) {
          return {
            ...m,
            isStreaming: false,
            content: finalContent,
            reasoning: finalReasoning || undefined,
            // 中间自言自语：仅在封存过时才挂载，避免空数组污染
            ...(finalThoughts.length > 0 ? { intermediateThoughts: finalThoughts } : {}),
            ...(finalProgressEvents.length > 0 ? { progressEvents: finalProgressEvents } : {}),
            // Phase 91：在 assistant 消息上记录完成状态（仅 done 事件携带时）
            ...(completionStatus ? { completionStatus } : {}),
          };
        }
        // 给 user 消息（任务起始）记录耗时和完成标记
        if (taskId && m.taskId === taskId && m.role === 'user') {
          return { ...m, taskCompleted: true, taskDuration: duration };
        }
        // 同任务的其他消息标记完成
        if (taskId && m.taskId === taskId) {
          return { ...m, taskCompleted: true };
        }
        return m;
      }),
      _assistantId: null,
      _assistantBuffer: '',
      _pendingDelta: '',
      _rafHandle: null,
      _reasoningBuffer: '',
      _pendingReasoning: '',
      _reasoningRafHandle: null,
      _intermediateThoughts: [],
      _progressEvents: [],
      isProcessing: false,
      _currentTaskId: null,
      _currentTaskStartTime: null,
    });
  },

  _addToolStart: (toolName, args, toolCallId) => {
    const state = get();
    const taskId = state._currentTaskId ?? undefined;
    const now = Date.now();

    // 关键修复：在创建 tool 消息前，把当前 _assistantBuffer 内容封存为一条中间自言自语
    // 否则所有 text_delta 会累积到最终输出，导致中间说明文字和最终回答混在一起
    // 封存后清空 buffer，让后续 text_delta 重新累积为最终输出
    const currentText = state._assistantBuffer.trim();
    const assistantId = state._assistantId;
    const pendingDelta = state._pendingDelta;
    const rafHandle = state._rafHandle;

    // 清理待刷新的 rAF，避免封存后被旧 delta 覆盖
    if (rafHandle !== null) {
      window.clearTimeout(rafHandle);
    }

    const newIntermediate = currentText
      ? [...state._intermediateThoughts, { id: `thought-${now}`, text: currentText, timestamp: now - 1 }]
      : state._intermediateThoughts;

    set({
      _intermediateThoughts: newIntermediate,
      _assistantBuffer: '',
      _pendingDelta: '',
      _rafHandle: null,
      // 同步把 latestAssistant.content 清空（已封存到 intermediateThoughts）
      // 这样 UI 上文字会"消失"并出现在折叠的思考块里，符合用户期望
      messages: assistantId
        ? state.messages.map((m) =>
          m.id === assistantId ? { ...m, content: '' } : m,
        )
        : state.messages,
    });

    // pendingDelta 在封存后已丢弃（已通过 currentText 包含），无需再 flush
    void pendingDelta;

    set({
      messages: [
        ...get().messages,
        {
          id: `tool-${now}`,
          role: 'system',
          content: '',
          toolName,
          toolArgs: args,
          toolStatus: 'running',
          // Phase 96 P1-1：记录 toolCallId 以关联后续 tool_call_delta 增量输出
          toolCallId,
          toolDeltaBuffer: '',
          taskId,
          timestamp: now,
        },
      ],
    });
  },

  _addToolDone: (toolName, result, isError, toolCallId) => {
    set((state) => {
      const newMessages = [...state.messages];
      // 从后往前查找匹配的 running 状态工具消息
      // Phase 96 P1-1：优先用 toolCallId 精准匹配，回退到 toolName+running
      for (let i = newMessages.length - 1; i >= 0; i--) {
        const m = newMessages[i];
        const matchById = toolCallId && m.toolCallId === toolCallId;
        const matchByName = !toolCallId && m.toolName === toolName && m.toolStatus === 'running';
        if ((matchById || matchByName) && m.toolStatus === 'running') {
          // 优先使用工具返回的 isError 字段（真实成功/失败标志）
          // 仅在未提供时回退到结构化 error 字段检测，禁止用文本启发式（避免列出 ErrorHandler.ts 等误判）
          const finalIsError = isError !== undefined
            ? isError
            : result !== null &&
              typeof result === 'object' &&
              'error' in (result as Record<string, unknown>) &&
              Boolean((result as Record<string, unknown>).error);
          newMessages[i] = {
            ...m,
            toolStatus: finalIsError ? 'error' : 'completed',
            toolResult: result,
            // Phase 96 P1-1：工具完成时清空 delta buffer，避免重复展示
            toolDeltaBuffer: undefined,
          };
          return { messages: newMessages };
        }
      }
      // 未找到匹配的 running 工具，创建新的已完成消息
      return {
        messages: [
          ...newMessages,
          {
            id: `tool-done-${Date.now()}`,
            role: 'system' as const,
            content: '',
            toolName,
            toolResult: result,
            toolStatus: (isError ? 'error' : 'completed') as ToolCallStatus,
            taskId: state._currentTaskId ?? undefined,
            timestamp: Date.now(),
          },
        ],
      };
    });
  },

  // Phase 96 P1-1：追加工具增量输出到对应 tool 消息
  // 同步更新（shell_exec 的 stdout chunk 频率远低于 LLM token 流，无需 rAF 节流）
  _appendToolDelta: (toolCallId, chunk) => {
    set((state) => {
      const newMessages = [...state.messages];
      // 优先按 toolCallId 精准匹配，回退到"最近一个同名 running 工具"
      let targetIdx = -1;
      if (toolCallId) {
        for (let i = newMessages.length - 1; i >= 0; i--) {
          if (newMessages[i].toolCallId === toolCallId && newMessages[i].toolStatus === 'running') {
            targetIdx = i;
            break;
          }
        }
      }
      if (targetIdx === -1) {
        // 回退：找最近一个 running 工具（无 toolCallId 时的兼容路径）
        for (let i = newMessages.length - 1; i >= 0; i--) {
          if (newMessages[i].toolStatus === 'running') {
            targetIdx = i;
            break;
          }
        }
      }
      if (targetIdx === -1) return state; // 无目标工具，丢弃 chunk
      const prev = newMessages[targetIdx];
      // 限制 buffer 大小，避免超长输出拖慢渲染（保留尾部 64KB）
      const MAX_BUFFER = 65536;
      const prevBuffer = prev.toolDeltaBuffer ?? '';
      const newBuffer = (prevBuffer + chunk).slice(-MAX_BUFFER);
      newMessages[targetIdx] = { ...prev, toolDeltaBuffer: newBuffer };
      return { messages: newMessages };
    });
  },

  _setError: (error) => {
    const state = get();
    // 错误前先 flush 待处理的 delta，避免丢失已生成内容
    if (state._rafHandle !== null) {
      window.clearTimeout(state._rafHandle);
    }
    if (state._reasoningRafHandle !== null) {
      window.clearTimeout(state._reasoningRafHandle);
    }
    if (state._assistantId) {
      // 先封存当前 assistant 消息（保留已生成内容，不追加错误文本）
      const finalContent = state._assistantBuffer;
      const finalReasoning = state._reasoningBuffer || undefined;
      const finalThoughts = state._intermediateThoughts;
      const finalProgressEvents = state._progressEvents;
      // 再追加一条独立的错误系统消息，避免错误与正常输出堆叠在一起
      set({
        messages: [
          ...state.messages.map((m) =>
            m.id === state._assistantId
              ? {
                  ...m,
                  content: finalContent,
                  reasoning: finalReasoning,
                  isStreaming: false,
                  ...(finalThoughts.length > 0 ? { intermediateThoughts: finalThoughts } : {}),
                  ...(finalProgressEvents.length > 0 ? { progressEvents: finalProgressEvents } : {}),
                }
              : m,
          ),
          { id: `err-${Date.now()}`, role: 'system', content: error, error: true, timestamp: Date.now() },
        ],
        isProcessing: false,
        _assistantId: null,
        _assistantBuffer: '',
        _pendingDelta: '',
        _rafHandle: null,
        _reasoningBuffer: '',
        _pendingReasoning: '',
        _reasoningRafHandle: null,
        _intermediateThoughts: [],
        _progressEvents: [],
        _progressEvents: [],
      });
    } else {
      // 无正在进行的 assistant 消息，创建新的错误消息
      set({
        messages: [
          ...state.messages,
          { id: `err-${Date.now()}`, role: 'system', content: error, error: true, timestamp: Date.now() },
        ],
        isProcessing: false,
        _pendingDelta: '',
        _rafHandle: null,
        _reasoningBuffer: '',
        _pendingReasoning: '',
        _reasoningRafHandle: null,
        _intermediateThoughts: [],
        _progressEvents: [],
      });
    }
  },

  _setProcessing: (processing) => set({ isProcessing: processing }),

  _setPendingConfirm: (confirm) => set({ pendingConfirm: confirm }),

  _addTokenSnapshot: (snapshot) => {
    const state = get();
    set({
      tokenSnapshots: [...state.tokenSnapshots, snapshot].slice(-200),
      // 同步更新 currentTier（来自路由决策）
      currentTier: snapshot.routeDecision ?? state.currentTier,
    });
  },

  _addTraceEvent: (span) => {
    const state = get();
    // G-008：保留最近 500 条 trace 事件，避免遥测集合无界增长
    set({ traceEvents: [...state.traceEvents, span].slice(-500) });
  },

  // Phase 54：聚合 GoalEvent 到 goalExecutions（按 goalId 索引，就地刷新）
  _handleGoalEvent: (event) => {
    const state = get();
    const existing = state.goalExecutions.find(g => g.goalId === event.goalId);

    // plan_created：新建 GoalExecution 条目 + 把 goalId 打到最近的 user 消息上（合并渲染）
    // Phase 54 修复：原方案插入独立 goal marker system 消息，会排在 user 消息的 actions 下方
    // 改为把 goalId 打到 /goal 命令的 user 消息上，MessageBubble 检测到 goalId 时用 GoalExecutionCard 取代 user 气泡
    if (event.type === 'plan_created') {
      const now = Date.now();
      const newExec: GoalExecution = {
        goalId: event.goalId,
        description: event.description,
        autonomyMode: event.autonomyMode,
        verificationCriteria: event.verificationCriteria,
        steps: event.steps.map(s => ({
          id: s.id,
          description: s.description,
          status: 'pending' as const,
          activities: [],
        })),
        status: 'running',
        createdAt: now,
      };
      // 找到最近的 user 消息，给它打上 goalId（从后往前找）
      const messages = [...state.messages];
      let userMsgIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          userMsgIdx = i;
          break;
        }
      }
      if (userMsgIdx >= 0) {
        // 合并方案：把 goalId 打到 user 消息上，渲染时用 GoalExecutionCard 取代 user 气泡
        messages[userMsgIdx] = { ...messages[userMsgIdx], goalId: event.goalId };
      } else {
        // 降级方案：找不到 user 消息（异常情况），插入独立 goal marker system 消息
        messages.push({
          id: `goal-marker-${event.goalId}`,
          role: 'system',
          content: event.description,
          goalId: event.goalId,
          timestamp: now,
        });
      }
      set({
        goalExecutions: [...state.goalExecutions, newExec].slice(-50),
        messages,
      });
      return;
    }

    // 其余事件需要已有 GoalExecution（若不存在则忽略，防御性编程）
    if (!existing) return;

    const updated = { ...existing, steps: existing.steps.map(s => ({ ...s, activities: [...s.activities] })) };

    switch (event.type) {
      case 'plan_confirmed':
        // 计划确认后状态不变（保持 running），仅触发刷新
        break;

      case 'step_update': {
        const step = updated.steps.find(s => s.id === event.stepId);
        if (step) {
          step.status = event.status;
          if (event.error) step.error = event.error;
          if (event.durationMs !== undefined) step.durationMs = event.durationMs;
          // Phase 54：running 时记录开始时间戳（供 GoalExecutionCard 显示实时耗时）
          if (event.status === 'running' && !step.startedAt) {
            step.startedAt = Date.now();
          }
          // 完成/失败时清空 startedAt（避免后续误显示）
          if (event.status === 'completed' || event.status === 'failed') {
            step.startedAt = undefined;
          }
        }
        break;
      }

      case 'agent_activity': {
        const step = updated.steps.find(s => s.id === event.stepId);
        if (step) {
          step.activities.push({
            role: event.role,
            activity: event.activity,
            timestamp: event.timestamp,
          });
          // G-008：每个 step 保留最近 100 条活动，避免 Goal 活动无界增长
          if (step.activities.length > 100) {
            step.activities = step.activities.slice(-100);
          }
        }
        break;
      }

      case 'verification':
        updated.verification = {
          passed: event.passed,
          confidence: event.confidence,
          reasoning: event.reasoning,
          missingItems: event.missingItems,
        };
        break;

      case 'done':
        updated.status = event.success ? 'completed' : 'failed';
        updated.done = {
          success: event.success,
          totalDurationMs: event.totalDurationMs,
          summary: event.summary,
        };
        break;
    }

    set({ goalExecutions: state.goalExecutions.map(g => g.goalId === event.goalId ? updated : g) });
  },

  // Phase 54：设置待编辑计划（由 plan:edit-request 事件触发，驱动 StepEditor 显示）
  _setPendingPlanEdit: (planEdit) => set({ pendingPlanEdit: planEdit }),

  _setConfig: (config) => set((prev) => ({
    config,
    // Bug #5：首次加载时如果磁盘有 provider，标记 hasEverHadProviders
    hasEverHadProviders: prev.hasEverHadProviders || (Array.isArray(config.providers) && config.providers.length > 0),
  })),

  _setConfigLoading: (loading) => set({ configLoading: loading }),

  _setCurrentModel: (model) => set({ currentModel: model }),
}));

// ===== IPC 事件订阅初始化 =====
// 在 App.tsx 的 useEffect 中调用一次，返回清理函数
export function initIPCListeners(): () => void {
  const store = useRouteDevStore;

  /**
   * 异步生成对话标题：仅在对话首条消息完成后触发
   * 使用杂活模型（路由模型）生成简洁标题，失败时静默回退
   */
  async function maybeGenerateTitle(): Promise<void> {
    try {
      const projState = useProjectsStore.getState();
      const { currentProjectId, currentConversationId } = projState;
      if (!currentProjectId || !currentConversationId) return;

      const project = projState.projects.find((p) => p.id === currentProjectId);
      const conv = project?.conversations.find((c) => c.id === currentConversationId);
      if (!conv) return;

      // 仅在对话首条用户消息时生成标题（此时 user 消息数 <= 1）
      const userMsgCount = conv.messages.filter((m) => m.role === 'user').length;
      if (userMsgCount > 1) return;

      // 获取首条用户消息和助手回复
      const firstUserMsg = conv.messages.find((m) => m.role === 'user');
      const lastAssistantMsg = [...conv.messages].reverse().find((m) => m.role === 'assistant');
      if (!firstUserMsg) return;

      const title = await window.routedev.chat.generateTitle(
        firstUserMsg.content,
        lastAssistantMsg?.content,
      );
      if (title && title.trim()) {
        useProjectsStore.getState().renameConversation(currentProjectId, currentConversationId, title.trim());
      }
    } catch (err) {
      console.error('[maybeGenerateTitle] 生成标题失败:', err);
    }
  }

  // 处理聊天流式事件
  const handleStream = (raw: unknown) => {
    const payload = raw as ChatStreamPayload;
    switch (payload.type) {
      case 'text_delta':
        store.getState()._appendTextDelta(payload.chunk ?? '');
        break;
      case 'reasoning_delta':
        // 推理过程增量：累积到 reasoning buffer，rAF 节流刷新到 UI
        store.getState()._appendReasoningDelta(payload.reasoning ?? '');
        break;
      case 'tool_start':
        store.getState()._addToolStart(payload.toolName!, payload.toolArgs, payload.toolCallId);
        break;
      case 'tool_call_delta':
        // Phase 96 P1-1：工具执行增量输出（shell_exec 等长任务的实时 stdout/stderr）
        store.getState()._appendToolDelta(payload.toolCallId, payload.chunk ?? '');
        break;
      case 'tool_done':
        store.getState()._addToolDone(payload.toolName!, payload.toolResult, payload.isError, payload.toolCallId);
        break;
      case 'progress':
        // 同时保留到当前任务，完成后可按时间线回看。
        if (payload.progress?.label) {
          store.getState()._appendProgressEvent(payload.progress.label);
        }
        store.setState((state) => ({
          currentModel: payload.progress?.modelId ?? state.currentModel,
          currentTier: payload.progress?.tier ?? state.currentTier,
          messages: payload.progress?.tier
            ? state.messages.map((m) =>
              m.id === state._assistantId ? { ...m, tier: payload.progress?.tier } : m,
            )
            : state.messages,
        }));
        break;
      case 'error':
        // 重置进度文案并设置错误
        store.setState({ progressLabel: null });
        store.getState()._setError(payload.error ?? '未知错误');
        break;
      case 'thinking':
        // 思考阶段提示也属于可回看的工作流状态。
        if (payload.message) {
          store.getState()._appendProgressEvent(payload.message);
        }
        break;
      case 'escalation':
        // 升级事件（达到 maxIterations 等）：作为独立系统消息显示，不追加到 assistant 文本
        store.setState((state) => ({
          messages: [
            ...state.messages,
            {
              id: `escalation-${Date.now()}`,
              role: 'system',
              content: payload.reason ?? '任务因预算耗尽而中断',
              error: true,
              timestamp: Date.now(),
            },
          ],
        }));
        break;
      case 'done':
        // 重置进度文案并完成 assistant 消息
        store.setState({ progressLabel: null });
        store.getState()._finishAssistantMessage(payload.completionStatus);
        // 异步生成对话标题（仅首条消息时触发，避免每次都调用 LLM）
        void maybeGenerateTitle();
        break;
    }
  };

  // 工具调用确认请求
  // G-004 修复：从事件中提取 requestId，存入 pendingConfirm 供 confirmTool 回传
  const handleToolConfirm = (raw: unknown) => {
    const payload = raw as { requestId: string; toolName: string; params: Record<string, unknown> };
    store.getState()._setPendingConfirm({ requestId: payload.requestId, toolName: payload.toolName, params: payload.params });
  };

  // Token 快照事件
  const handleTokenProfile = (raw: unknown) => {
    const payload = raw as TokenProfileSnapshot;
    store.getState()._addTokenSnapshot(payload);
  };

  // Trace 事件
  const handleTraceEvent = (raw: unknown) => {
    const payload = raw as TraceSpan;
    store.getState()._addTraceEvent(payload);
  };

  // Phase 54：Goal 执行结构化事件
  const handleGoalEvent = (raw: unknown) => {
    const payload = raw as GoalEvent;
    store.getState()._handleGoalEvent(payload);
  };

  // Phase 54：计划编辑请求（semi/manual 模式触发 StepEditor 显示）
  const handlePlanEditRequest = (raw: unknown) => {
    const payload = raw as { requestId: string; plan: import('../../../shared/ipc-types.js').PlanEditRequestPayload['plan'] };
    store.getState()._setPendingPlanEdit({ requestId: payload.requestId, plan: payload.plan });
  };

  // 配置热重载事件
  const handleConfigReloaded = (raw: unknown) => {
    const payload = raw as AppConfig;
    store.getState()._setConfig(payload);
  };

  const api = window.routedev;
  api.on('chat:stream', handleStream);
  api.on('chat:tool-confirm-request', handleToolConfirm);
  api.on('token:profile', handleTokenProfile);
  api.on('trace:event', handleTraceEvent);
  api.on('config:reloaded', handleConfigReloaded);
  api.on('goal:event', handleGoalEvent);
  api.on('plan:edit-request', handlePlanEditRequest);

  // 返回清理函数
  return () => {
    api.off('chat:stream', handleStream);
    api.off('chat:tool-confirm-request', handleToolConfirm);
    api.off('token:profile', handleTokenProfile);
    api.off('trace:event', handleTraceEvent);
    api.off('config:reloaded', handleConfigReloaded);
    api.off('goal:event', handleGoalEvent);
    api.off('plan:edit-request', handlePlanEditRequest);
  };
}

// ===== 加载初始配置 =====
// 在 App.tsx 的 useEffect 中调用一次
// 失败时记录错误但不抛出，避免 config 保持 null 导致误显示 SetupWizard 覆盖用户配置
export async function loadInitialConfig(): Promise<void> {
  const store = useRouteDevStore;
  try {
    const cfg = await window.routedev.config.get();
    store.getState()._setConfig(cfg);
    store.getState()._setCurrentModel(cfg.providers[0]?.models[0]?.id ?? '');
  } catch (err) {
    // 配置加载失败（YAML 损坏/验证失败）：记录错误，不覆盖配置文件
    // config 保持 null，但 configLoading 设为 false，App 会显示错误提示而非 SetupWizard
    console.error('[loadInitialConfig] 配置加载失败:', err);
    store.getState()._setConfigLoading(false);
    // 设置一个错误标记，App 据此显示错误页面而非 SetupWizard
    store.setState({ configError: err instanceof Error ? err.message : String(err) });
    return;
  }
  store.getState()._setConfigLoading(false);
}
