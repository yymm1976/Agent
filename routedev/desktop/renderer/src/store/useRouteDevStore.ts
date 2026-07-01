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
  /** 本条 assistant 回复匹配到的任务层级 */
  tier?: string;
  isStreaming?: boolean;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  toolStatus?: ToolCallStatus;
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
}

export interface PendingConfirm {
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

  // ===== 内部操作 =====
  _appendTextDelta: (chunk: string) => void;
  _flushPendingDelta: () => void;
  _appendReasoningDelta: (chunk: string) => void;
  _flushPendingReasoning: () => void;
  _startAssistantMessage: () => void;
  _finishAssistantMessage: () => void;
  _addToolStart: (toolName: string, args?: Record<string, unknown>) => void;
  _addToolDone: (toolName: string, result: unknown) => void;
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

  // ===== 操作 =====
  sendMessage: (text) => {
    const state = get();
    if (!text.trim() || state.isProcessing) return;
    const trimmed = text.trim();
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
    });
    window.routedev.chat.send({ text: trimmed } as ChatSendPayload);
  },

  confirmTool: (approved, payload) => {
    set({ pendingConfirm: null });
    window.routedev.chat.confirmTool({ approved, payload } as ToolConfirmPayload);
  },

  clearMessages: () => {
    set({ messages: [] });
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
      set({
        messages: state.messages.map((m) =>
          m.id === state._assistantId
            ? { ...m, isStreaming: false, content: state._assistantBuffer, reasoning: state._reasoningBuffer || undefined }
            : m,
        ),
        _assistantId: null,
        _assistantBuffer: '',
        _pendingDelta: '',
        _rafHandle: null,
        _reasoningBuffer: '',
        _pendingReasoning: '',
        _reasoningRafHandle: null,
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
      set({ config: cfg });
    }
    return result;
  },

  reloadConfig: async () => {
    const cfg = await window.routedev.config.reload();
    set({ config: cfg });
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

  _finishAssistantMessage: () => {
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
      isProcessing: false,
      _currentTaskId: null,
      _currentTaskStartTime: null,
    });
  },

  _addToolStart: (toolName, args) => {
    const state = get();
    const taskId = state._currentTaskId ?? undefined;
    set({
      messages: [
        ...state.messages,
        {
          id: `tool-${Date.now()}`,
          role: 'system',
          content: '',
          toolName,
          toolArgs: args,
          toolStatus: 'running',
          taskId,
          timestamp: Date.now(),
        },
      ],
    });
  },

  _addToolDone: (toolName, result) => {
    set((state) => {
      const newMessages = [...state.messages];
      // 从后往前查找匹配的 running 状态工具消息
      for (let i = newMessages.length - 1; i >= 0; i--) {
        const m = newMessages[i];
        if (m.toolName === toolName && m.toolStatus === 'running') {
          // 启发式检测结果是否为错误
          const isError =
            typeof result === 'string'
              ? /error|fail|exception/i.test(result)
              : result !== null &&
                typeof result === 'object' &&
                'error' in (result as Record<string, unknown>);
          newMessages[i] = {
            ...m,
            toolStatus: isError ? 'error' : 'completed',
            toolResult: result,
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
            toolStatus: 'completed' as const,
            taskId: state._currentTaskId ?? undefined,
            timestamp: Date.now(),
          },
        ],
      };
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
      // 追加错误信息到当前 assistant 消息
      const finalContent = state._assistantBuffer + `\n⚠️ ${error}`;
      const finalReasoning = state._reasoningBuffer || undefined;
      set({
        messages: state.messages.map((m) =>
          m.id === state._assistantId
            ? { ...m, content: finalContent, reasoning: finalReasoning, error: true, isStreaming: false }
            : m,
        ),
        isProcessing: false,
        _assistantId: null,
        _assistantBuffer: '',
        _pendingDelta: '',
        _rafHandle: null,
        _reasoningBuffer: '',
        _pendingReasoning: '',
        _reasoningRafHandle: null,
      });
    } else {
      // 无正在进行的 assistant 消息，创建新的错误消息
      set({
        messages: [
          ...state.messages,
          { id: `err-${Date.now()}`, role: 'system', content: error, error: true },
        ],
        isProcessing: false,
        _pendingDelta: '',
        _rafHandle: null,
        _reasoningBuffer: '',
        _pendingReasoning: '',
        _reasoningRafHandle: null,
      });
    }
  },

  _setProcessing: (processing) => set({ isProcessing: processing }),

  _setPendingConfirm: (confirm) => set({ pendingConfirm: confirm }),

  _addTokenSnapshot: (snapshot) => {
    const state = get();
    set({
      tokenSnapshots: [...state.tokenSnapshots, snapshot],
      // 同步更新 currentTier（来自路由决策）
      currentTier: snapshot.routeDecision ?? state.currentTier,
    });
  },

  _addTraceEvent: (span) => {
    const state = get();
    set({ traceEvents: [...state.traceEvents, span] });
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
        goalExecutions: [...state.goalExecutions, newExec],
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

  _setConfig: (config) => set({ config }),

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
        store.getState()._addToolStart(payload.toolName!, payload.toolArgs);
        break;
      case 'tool_done':
        store.getState()._addToolDone(payload.toolName!, payload.toolResult);
        break;
      case 'progress':
        // 进度文案存入瞬态字段，不污染对话历史
        store.setState((state) => ({
          progressLabel: payload.progress?.label ?? null,
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
      case 'done':
        // 重置进度文案并完成 assistant 消息
        store.setState({ progressLabel: null });
        store.getState()._finishAssistantMessage();
        // 异步生成对话标题（仅首条消息时触发，避免每次都调用 LLM）
        void maybeGenerateTitle();
        break;
    }
  };

  // 工具调用确认请求
  const handleToolConfirm = (raw: unknown) => {
    const payload = raw as { toolName: string; params: Record<string, unknown> };
    store.getState()._setPendingConfirm({ toolName: payload.toolName, params: payload.params });
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
