// desktop/shared/ipc-types.ts
// IPC 通信类型定义（主进程 / preload / 渲染进程三方共享单一真相源）
//
// 设计原则：
//   1. 持久层类型（AgentProfile / GoalEvent / SessionStatus / TraceSession / CompletionStatus 等）
//      在 src/ 下定义，本文件通过 type-only re-export 暴露，避免重复定义导致字段漂移
//   2. IPC 专属类型（DTO / Payload / Result / 命名空间 API）在此定义
//   3. 修改字段时必须同步：src/agents/profiles/types.ts ↔ 此处 AgentProfileDetail/Summary

// ============================================================
// 从 src/ 引入持久层类型（先 import type 引入本地作用域，再 re-export 供外部消费）
// ============================================================

// 配置类型（中转层 desktop/shared/config-types.ts 已 re-export AppConfig 等，此处直接转出）
import type { AppConfig } from './config-types.js';
export type { AppConfig } from './config-types.js';
export { AppConfigSchema } from './config-types.js';

// AgentProfile 持久层类型（src/agents/profiles/types.ts 是真相源）
import type {
  AgentProfile,
  AgentRole,
  AgentOutputFormat,
  AgentProfileValidationError,
} from '../../src/agents/profiles/types.js';
export type {
  AgentProfile,
  AgentRole,
  AgentOutputFormat,
  AgentProfileValidationError,
} from '../../src/agents/profiles/types.js';

// 版本管理类型（src/agents/profiles/version-types.ts 是真相源）
// 注意：VersionSource / VersionMeta / VersionRecord / FieldChange / FieldDiff 直接 re-export，
// 确保 IPC 层与持久层字段命名完全一致
import type {
  VersionSource,
  FieldChange,
  VersionMeta,
  VersionRecord,
  FieldDiff,
} from '../../src/agents/profiles/version-types.js';
export type {
  VersionSource,
  FieldChange,
  VersionMeta,
  VersionRecord,
  FieldDiff,
} from '../../src/agents/profiles/version-types.js';

// Goal 相关类型
import type { GoalEvent } from '../../src/agent/goal-types.js';
export type { GoalEvent } from '../../src/agent/goal-types.js';

// 会话状态卡类型（Phase 77）
import type {
  SessionStatus,
  SessionStatusTodo,
} from '../../src/agent/session-status-aggregator.js';
export type {
  SessionStatus,
  SessionStatusTodo,
} from '../../src/agent/session-status-aggregator.js';

// 完成门状态
import type { CompletionStatus } from '../../src/agent/completion-gate.js';
export type { CompletionStatus } from '../../src/agent/completion-gate.js';

// Token Profile 快照
import type { TokenProfileSnapshot } from '../../src/agent/token-profiler.js';
export type { TokenProfileSnapshot } from '../../src/agent/token-profiler.js';

// Trace 会话与 Span
import type {
  TraceSession,
  TraceSpan,
  TrajectorySummary,
} from '../../src/harness/trace-types.js';
export type {
  TraceSession,
  TraceSpan,
  TrajectorySummary,
} from '../../src/harness/trace-types.js';

// 评分卡（Phase 77）
import type {
  Scorecard,
  ScorecardCheck,
  ScorecardQualitySignal,
} from '../../src/harness/scorecard.js';
export type {
  Scorecard,
  ScorecardCheck,
  ScorecardQualitySignal,
} from '../../src/harness/scorecard.js';

// 时间线事件（trace-replayer.ts）
import type { TimelineEvent } from '../../src/harness/trace-replayer.js';
export type { TimelineEvent } from '../../src/harness/trace-replayer.js';

// Token 使用信息（tracker.ts）
import type { TokenUsageInfo } from '../../src/router/types.js';
export type { TokenUsageInfo } from '../../src/router/types.js';

// ============================================================
// Phase 96+ A3.3：实时费用 + 缓存命中率统计快照（UI StatsBar 消费）
// ============================================================

/** 缓存命中统计的统一视图（session 累计 + turn 单轮） */
export interface CacheStatsView {
  hit: number;
  miss: number;
  total: number;
  hitRate: number;
}

/** 会话费用统计（美元） */
export interface SessionCostView {
  /** 会话累计总费用（美元） */
  totalUsd: number;
  /** 按模型 ID 聚合的费用 */
  byModel: Record<string, number>;
}

/**
 * 统计快照（一次性返回 UI 所需的全部统计字段，避免多次 IPC 往返）
 *
 * 数据源：
 *   - tokens / cost / activeModels：tracker.ts
 *   - cache：cache-optimizer.ts
 *   - budgetUsagePercent：tracker.getUsagePercent()
 */
export interface StatsSnapshot {
  /** 累计 token 使用（按模型/Agent/Step 的细分由 byModel 间接暴露） */
  tokens: TokenUsageInfo;
  /** 会话费用（美元）+ 按模型聚合 */
  cost: SessionCostView;
  /** 缓存命中统计（session 累计 + turn 单轮） */
  cache: {
    session: CacheStatsView;
    turn: CacheStatsView;
  };
  /** 日预算使用百分比（0-1+，超过 1 表示超限） */
  budgetUsagePercent: number;
  /** 当前活跃模型 ID 列表（曾使用过的模型，按首次调用顺序） */
  activeModels: string[];
  /** 快照生成时间（ISO 字符串，UI 据此判断数据新鲜度） */
  updatedAt: string;
}

// ============================================================
// 通用 IPC 类型
// ============================================================

export interface IpcResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================
// Agent Profile 角色常量
// ============================================================

/** 子 Agent 全部角色（与 src/agents/profiles/types.ts AgentRole 一一对应） */
export const AGENT_PROFILE_ROLES = [
  'researcher',
  'executor',
  'reviewer',
  'planner',
  'verifier',
  'synthesizer',
  'review-planner',
  'custom',
] as const;

/** 角色字面量类型（从 AGENT_PROFILE_ROLES 推导，与 src/ AgentRole 等价） */
export type AgentProfileRole = (typeof AGENT_PROFILE_ROLES)[number];

// ============================================================
// Agent Profile IPC DTO（与 AgentProfile 字段完全对齐）
// ============================================================

/**
 * Agent Profile 详情（IPC 传输 DTO）
 * 与 src/agents/profiles/types.ts AgentProfile 字段完全一致，
 * 避免渲染层访问字段时出现 model vs modelId 等命名漂移
 */
export type AgentProfileDetail = import('../../src/agents/profiles/types.js').AgentProfile;

/**
 * Agent Profile 摘要（列表展示用，不含 systemPrompt）
 * 字段从 AgentProfile 投影而来，仅保留列表展示所需字段
 */
export interface AgentProfileSummary {
  id: string;
  name: string;
  type: 'agent-profile';
  version: string;
  role: AgentProfileRole;
  modelId: string;
  description: string;
  allowedTools: string[];
  forbiddenTools: string[];
  boundSkills: string[];
  canChallenge: boolean;
  challengeSeverity: 'blocking' | 'warning';
  outputFormat: import('../../src/agents/profiles/types.js').AgentOutputFormat;
  maxTokens: number;
  maxSteps: number;
  isBuiltin: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Profile 操作结果 */
export interface ProfileOpResult {
  success: boolean;
  id?: string;
  error?: string;
  /** 校验错误明细（save 时可能携带） */
  errors?: string[];
}

/**
 * Profile 保存载荷
 * 即完整 AgentProfile 字段集合（与 AgentProfileDetail 同构）
 */
export type ProfileSavePayload = AgentProfileDetail;

// ============================================================
// 应用 / 窗口 / 引擎状态 IPC 类型
// ============================================================

export interface AppInfo {
  version: string;
  name: string;
  platform: string;
  electronVersion: string;
  nodeVersion: string;
}

export type EngineStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface EngineState {
  status: EngineStatus;
  port: number | null;
  pid: number | null;
  error: string | null;
  uptime: number | null;
}

export type WindowAction = 'minimize' | 'maximize' | 'close' | 'hide' | 'show';

export interface WindowState {
  isMaximized: boolean;
  isMinimized: boolean;
  isFullScreen: boolean;
  isFocused: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface ProjectInfo {
  path: string;
  name: string;
  hasGit: boolean;
  hasPackageJson: boolean;
  lastOpened?: number;
}

export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
}

export interface UpdateProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

// ============================================================
// 终端 / 对话框 / 通知 IPC 类型
// ============================================================

export interface TerminalCreateOptions {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  pid: number;
  createdAt: number;
}

export interface TerminalData {
  id: string;
  data: string;
}

export interface TerminalExit {
  id: string;
  exitCode: number;
  signal?: number;
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: { name: string; extensions: string[] }[];
  properties?: Array<
    | 'openFile'
    | 'openDirectory'
    | 'multiSelections'
    | 'showHiddenFiles'
    | 'createDirectory'
    | 'promptToCreate'
  >;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface DialogResult {
  canceled: boolean;
  filePaths?: string[];
  filePath?: string;
}

export interface NotificationOptions {
  title: string;
  body: string;
  silent?: boolean;
  icon?: string;
}

// ============================================================
// Chat / 工具 / 计划编辑 / 命令 Payload
// ============================================================

/** 聊天发送载荷 */
export interface ChatSendPayload {
  text: string;
}

/** 工具确认请求载荷（renderer → main 回传确认结果） */
export interface ToolConfirmPayload {
  requestId: string;
  approved: boolean;
  payload?: unknown;
}

/** 命令执行载荷（slash 命令） */
export interface CommandExecutePayload {
  text: string;
}

/** 工具执行载荷（IPC 直接调用工具，受限） */
export interface ToolExecutePayload {
  name: string;
  args: Record<string, unknown>;
  requestId?: string;
}

/** Chat 流式事件 payload（main → renderer） */
export type ChatStreamPayload =
  | { type: 'text_delta'; chunk: string }
  | { type: 'reasoning_delta'; reasoning: string }
  | { type: 'tool_start'; toolName: string; toolArgs?: Record<string, unknown>; toolCallId?: string }
  | { type: 'tool_done'; toolName: string; toolResult?: unknown; isError?: boolean; toolCallId?: string }
  | { type: 'tool_call_delta'; toolName: string; toolCallId: string; chunk: string }
  | {
      type: 'progress';
      progress: {
        label: string;
        current: number;
        total: number;
        modelId?: string;
        tier?: string;
      };
    }
  | { type: 'error'; error: string }
  | { type: 'done'; completionStatus?: CompletionStatus }
  | {
      type: 'micro_summary';
      microSummary: import('../../src/agent/micro-summary.js').MicroSummary;
    }
  | { type: 'thinking'; message: string }
  | { type: 'escalation'; reason: string; iterations?: number };

export interface RemoteGatewayStatus {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  baseUrl: string;
  transport: 'lan' | 'tailscale';
  engineAvailable: boolean;
  deviceCount: number;
}

export interface RemotePairingView {
  qrDataUrl: string;
  expiresAt: string;
  baseUrl: string;
  desktopName: string;
  transport: 'lan' | 'https';
}

// ============================================================
// 计划编辑 Payload（StepEditor 半自动 / 手动模式）
// ============================================================

/** 计划编辑请求载荷（main → renderer，触发 StepEditor 显示） */
export interface PlanEditRequestPayload {
  requestId: string;
  plan: {
    description: string;
    verificationCriteria?: string;
    steps: Array<{
      id: number;
      description: string;
      acceptanceCriteria?: string;
      dependencies: number[];
      suggestedRole?: 'researcher' | 'executor' | 'reviewer';
    }>;
  };
}

/** 计划编辑响应载荷（renderer → main，回传编辑后的步骤） */
export interface PlanEditResponsePayload {
  requestId: string;
  steps: PlanEditRequestPayload['plan']['steps'] | null;
}

// ============================================================
// Config / MCP / Skill / Hook / Experiment / Goal / Trace 专属类型
// ============================================================

/** 配置保存结果 */
export interface ConfigSaveResult {
  success: boolean;
  error?: string;
  /** 是否需要重新加载引擎（providers/路由规则变更等） */
  needsReload?: boolean;
  /** 安全配置弱化告警（detectConfigWeakening 检测到的弱化项，含字段/旧值/新值/原因） */
  weakening?: Array<{ field: string; oldValue: unknown; newValue: unknown; reason: string }>;
}

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

/** Skill 安装载荷 */
export interface SkillInstallPayload {
  name: string;
  description: string;
  keywords?: string[];
  content: string;
  source?: string;
  /** 安装指定版本（marketManager.install 用） */
  version?: string;
}

/** Skill 创建载荷（skill:create IPC handler 用） */
export interface SkillCreatePayload {
  name: string;
  description: string;
  keywords: string[];
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

/** MCP 服务器连接状态条目 */
export interface MCPServerStatus {
  id: string;
  connected: boolean;
  error?: string;
}

/** MCP 整体状态 */
export interface MCPStatus {
  connected: boolean;
  servers: MCPServerStatus[];
}

/** MCP 连接 / 断开操作结果 */
export interface MCPConnectionResult {
  success: boolean;
  error?: string;
  status?: MCPStatus;
}

/** MCP 服务器市场目录条目 */
export interface MCPCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  category: 'filesystem' | 'database' | 'browser' | 'search' | 'devtool' | 'communication' | 'other';
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  requiredEnv?: string[];
  requiredHeaders?: string[];
  homepage?: string;
  requiresApiKey: boolean;
  popularity: number;
}

/** MCP 目录查询结果 */
export interface MCPCatalogResult {
  entries: MCPCatalogEntry[];
  total: number;
}

/** MCP 安装载荷 */
export interface MCPInstallPayload {
  catalogId: string;
  customId?: string;
  envValues?: Record<string, string>;
  headerValues?: Record<string, string>;
}

/** MCP 安装结果 */
export interface MCPInstallResult {
  success: boolean;
  error?: string;
  serverId?: string;
  connected?: boolean;
}

/** Hook 配置信息（IPC 传输用） */
export interface HookInfo {
  id: string;
  name: string;
  event: string;
  enabled: boolean;
  command?: string;
  condition?: { toolName?: string; filePattern?: string };
  failBehavior?: 'warn' | 'block' | 'silent';
  priority?: number;
  description?: string;
  isTemplate?: boolean;
}

/** 实验分支信息（IPC 传输用） */
export interface ExperimentInfo {
  id: string;
  name: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  baseCommit: string;
  status: 'active' | 'adopted' | 'discarded';
  createdAt: number;
  runCount: number;
  lastRunAt?: number;
  tokenUsage?: number;
  /** 实验运行耗时（毫秒），运行中可能为 undefined */
  duration?: number;
  /** 实验目标任务描述 */
  task?: string;
  /** 实验过程中修改的文件路径列表 */
  modifiedFiles?: string[];
  /** 实验错误信息（运行失败时携带） */
  error?: string;
}

/** Checkpoint 信息（IPC 传输用） */
export interface CheckpointInfo {
  id: string;
  createdAt: number;
  description: string;
  filesChanged?: string[];
  /** 创建时间戳（与 createdAt 同义，renderer 优先使用此字段展示） */
  timestamp?: number;
  /** 摘要描述（renderer 优先使用此字段，回退到 description） */
  summary?: string;
  /** 统计信息（文件变更数、token 使用量等） */
  stats?: { filesChanged: number; tokensUsed: number };
  /** 是否自动创建（true=对话过程中自动产生，false=用户手动创建） */
  isAutoCreated?: boolean;
}

/** 可恢复 Goal IPC 信息（扁平化，剥离嵌套 goal 对象） */
export interface ResumableGoalIpcInfo {
  id: string;
  spec: import('../../src/agent/goal-types.js').FivePartGoalSpec;
  status: string;
  completedSteps: number;
  totalSteps: number;
  tokenUsed: number;
  tokenBudget: number;
  updatedAt: number;
  isStale: boolean;
}

// ============================================================
// Follow-up 队列类型
// ============================================================

/** Follow-up 出队模式 */
export type FollowUpMode = 'all' | 'one-at-a-time';

/** Follow-up 队列条目（与 ChatBridge.getFollowUpQueue 返回结构一致） */
export interface FollowUpItem {
  role: 'follow_up';
  content: string;
  enqueuedAt: number;
}

/** Agent 队列状态 */
export interface AgentQueueStatus {
  followUp: number;
}

// ============================================================
// 主进程 → 渲染进程事件
// ============================================================

/** 主进程推送到渲染进程的事件通道联合类型 */
export type MainToRendererEvent =
  | { channel: 'chat:stream'; payload: ChatStreamPayload }
  | {
      channel: 'chat:tool-confirm-request';
      payload: { requestId: string; toolName: string; params: Record<string, unknown> };
    }
  | { channel: 'token:profile'; payload: TokenProfileSnapshot }
  | { channel: 'trace:event'; payload: import('../../src/harness/trace-types.js').TraceSpan }
  | { channel: 'config:reloaded'; payload: AppConfig }
  | { channel: 'goal:event'; payload: GoalEvent }
  | { channel: 'plan:edit-request'; payload: PlanEditRequestPayload };

/** MainToRendererEvent.channel 字面量联合（供 on/off 订阅使用） */
export type MainToRendererChannel = MainToRendererEvent['channel'];

// ============================================================
// IPC 通道名称常量
// ============================================================

export const IpcChannels = {
  // 应用
  APP_GET_INFO: 'app:get-info',
  APP_GET_PATH: 'app:get-path',
  APP_QUIT: 'app:quit',
  APP_RELAUNCH: 'app:relaunch',

  // 窗口
  WINDOW_ACTION: 'window:action',
  WINDOW_GET_STATE: 'window:get-state',
  WINDOW_STATE_CHANGED: 'window:state-changed',

  // 引擎
  ENGINE_GET_STATE: 'engine:get-state',
  ENGINE_START: 'engine:start',
  ENGINE_STOP: 'engine:stop',
  ENGINE_RESTART: 'engine:restart',
  ENGINE_STATE_CHANGED: 'engine:state-changed',

  // 终端
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_DESTROY: 'terminal:destroy',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_LIST: 'terminal:list',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_TITLE: 'terminal:title',

  // 对话框
  DIALOG_OPEN: 'dialog:open',
  DIALOG_SAVE: 'dialog:save',
  DIALOG_MESSAGE: 'dialog:message',

  // 通知
  NOTIFICATION_SHOW: 'notification:show',

  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  SHELL_OPEN_PATH: 'shell:open-path',
  SHELL_SHOW_ITEM: 'shell:show-item-in-folder',

  // 剪贴板
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
  CLIPBOARD_READ_TEXT: 'clipboard:read-text',

  // 项目
  PROJECT_OPEN: 'project:open',
  PROJECT_GET_RECENT: 'project:get-recent',
  PROJECT_ADD_RECENT: 'project:add-recent',

  // 更新
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_DOWNLOADED: 'update:downloaded',
  UPDATE_ERROR: 'update:error',

  // Agent Profile
  PROFILE_LIST: 'profile:list',
  PROFILE_GET: 'profile:get',
  PROFILE_SAVE: 'profile:save',
  PROFILE_DELETE: 'profile:delete',
  PROFILE_DUPLICATE: 'profile:duplicate',
  PROFILE_IMPORT: 'profile:import',
  PROFILE_LIST_VERSIONS: 'profile:list-versions',
  PROFILE_GET_VERSION: 'profile:get-version',
  PROFILE_ROLLBACK: 'profile:rollback',
  PROFILE_DIFF_VERSIONS: 'profile:diff-versions',
  PROFILE_DIFF_CURRENT_WITH: 'profile:diff-current-with',

  // 存储
  STORE_GET: 'store:get',
  STORE_SET: 'store:set',
  STORE_DELETE: 'store:delete',

  // Phase 96+ A3.3：实时费用 + 缓存命中率统计
  STATS_GET_SNAPSHOT: 'stats:get-snapshot',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

// ============================================================
// RouteDevAPI：preload 暴露给渲染进程的完整 API 契约
// ============================================================

/**
 * window.routedev 类型定义
 * 渲染进程通过此 API 与主进程通信，所有 IPC 调用与事件订阅均经此入口
 */
export interface RouteDevAPI {
  // ===== 事件订阅 =====
  /** 订阅主进程推送事件 */
  on: <T = unknown>(
    channel: MainToRendererChannel,
    callback: (payload: T) => void,
  ) => () => void;
  /** 取消订阅（与 on 返回的 unsubscribe 函数等价，提供显式取消入口） */
  off: (channel: MainToRendererChannel, callback: (payload: unknown) => void) => void;

  // ===== 应用 / 平台 =====
  getAppInfo: () => Promise<AppInfo>;
  getPath: (name: string) => Promise<string>;
  quit: () => Promise<void>;
  relaunch: () => Promise<void>;
  platform: NodeJS.Platform;
  isElectron: true;

  // ===== 窗口 =====
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    restoreFocus: () => Promise<void>;
    action: (action: WindowAction) => Promise<void>;
    getState: () => Promise<WindowState>;
    onStateChanged: (callback: (state: WindowState) => void) => () => void;
  };

  // ===== 引擎 =====
  getEngineState: () => Promise<EngineState>;
  startEngine: () => Promise<void>;
  stopEngine: () => Promise<void>;
  restartEngine: () => Promise<void>;
  onEngineStateChanged: (callback: (state: EngineState) => void) => () => void;

  // ===== 终端 =====
  createTerminal: (options?: TerminalCreateOptions) => Promise<TerminalInfo>;
  destroyTerminal: (id: string) => Promise<void>;
  writeTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  listTerminals: () => Promise<TerminalInfo[]>;
  onTerminalData: (callback: (data: TerminalData) => void) => () => void;
  onTerminalExit: (callback: (data: TerminalExit) => void) => () => void;
  onTerminalTitle: (callback: (data: { id: string; title: string }) => void) => () => void;

  // ===== 对话框 / 通知 / Shell / 剪贴板 =====
  openDialog: (options?: OpenDialogOptions) => Promise<DialogResult>;
  saveDialog: (options?: SaveDialogOptions) => Promise<DialogResult>;
  showMessage: (options: {
    type?: 'none' | 'info' | 'error' | 'question' | 'warning';
    title?: string;
    message: string;
    detail?: string;
    buttons?: string[];
  }) => Promise<number>;
  showNotification: (options: NotificationOptions) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  openPath: (path: string) => Promise<string>;
  showItemInFolder: (path: string) => Promise<void>;
  writeClipboard: (text: string) => Promise<void>;
  readClipboard: () => Promise<string>;

  // ===== 项目 =====
  project: {
    open: () => Promise<ProjectInfo | null>;
    getRecent: () => Promise<ProjectInfo[]>;
    addRecent: (path: string) => Promise<void>;
    setCwd: (cwd: string) => void;
  };

  // ===== 更新 =====
  checkForUpdates: () => Promise<UpdateInfo | null>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateProgress: (callback: (progress: UpdateProgress) => void) => () => void;
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateError: (callback: (error: string) => void) => () => void;

  // ===== 存储 =====
  storeGet: <T>(key: string) => Promise<T | undefined>;
  storeSet: <T>(key: string, value: T) => Promise<void>;
  storeDelete: (key: string) => Promise<void>;

  // ===== 文件系统（受限） =====
  fs: {
    read: (filePath: string) => Promise<{ data: string; error?: string }>;
    selectFolder: (defaultPath?: string) => Promise<string | null>;
    openFolder: (filePath: string) => Promise<boolean>;
  };

  // ===== Chat / 命令 / 工具 / 计划编辑 =====
  chat: {
    send: (payload: ChatSendPayload) => void;
    confirmTool: (payload: ToolConfirmPayload) => void;
    stop: (requestId?: string) => void;
    generateTitle: (userMessage: string, assistantReply?: string) => Promise<string>;
    /** 同步当前对话历史到主进程引擎（切换对话/分支后调用，让 engine 沿用正确上下文） */
    syncHistory: (
      messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>,
    ) => void;
    /** Phase 97 Part B：列出 Turn 快照（对话级撤销入口，sessionId 缺省返回全部） */
    listTurnSnapshots: (
      sessionId?: string,
    ) => Promise<import('../../src/harness/turn-snapshot.js').TurnSnapshot[]>;
    /** Phase 97 Part B：恢复指定 turn 的快照（回退对话时同步恢复文件） */
    restoreTurn: (
      turnId: string,
      sessionId?: string,
    ) => Promise<import('../../src/harness/turn-snapshot.js').RestoreResult | null>;
  };
  /** Phase 97 Part C：统一中断队列（渲染层重载后 reclaim 恢复未处理中断） */
  interruption: {
    reclaim: (sessionId?: string) => Promise<import('../../src/agent/interruption.js').Interruption[]>;
    list: (sessionId?: string) => Promise<import('../../src/agent/interruption.js').Interruption[]>;
  };
  /** Phase 97 Part E：子会话可见性（列表/详情/停止）+ 状态聚合（H） */
  agent: {
    listSubagents: (parentSessionId?: string) => Promise<import('../main/bridges/agent-bridge.js').SubagentView[]>;
    getSubagent: (childSessionId: string) => Promise<import('../main/bridges/agent-bridge.js').SubagentView | null>;
    stopSubagent: (childSessionId: string) => Promise<boolean>;
    /** Phase 97 Part H：Agent 状态聚合快照（AgentIsland 渲染唯一数据源） */
    getStatus: () => Promise<import('../main/agent-status-service.js').AgentStatusSnapshot>;
    /** follow-up 队列（旧领域，保留兼容） */
    followUp: (content: string) => void;
    clearAllQueues: () => void;
    setFollowUpMode: (mode: FollowUpMode) => void;
    queueStatus: () => Promise<AgentQueueStatus>;
    getFollowUpQueue: () => Promise<FollowUpItem[]>;
    removeFollowUp: (index: number) => Promise<boolean>;
  };
  /** Phase 97 Part G：输入框结构化引用解析 */
  composer: {
    resolve: (text: string) => Promise<import('../../src/agent/context/composer-reference.js').ComposerReference[]>;
  };
  command: {
    execute: (payload: CommandExecutePayload | string) => Promise<unknown>;
  };
  tool: {
    execute: (payload: ToolExecutePayload) => Promise<unknown>;
  };
  plan: {
    respondEdit: (payload: PlanEditResponsePayload) => void;
    /** 获取指定 goal 的 plan 修订历史（main 从 .routedev/plan-revisions/<goalId>.jsonl 读取） */
    getRevisions: (
      goalId: string,
    ) => Promise<{ ok: boolean; revisions?: unknown[]; error?: string }>;
    /** 触发指定 goal 的 plan 遗漏点检查（LLM 调用，结果异步返回） */
    checkOmissions: (
      goalId: string,
    ) => Promise<{
      ok: boolean;
      result?: { omissions: unknown[]; summary: string };
      error?: string;
    }>;
  };

  // ===== Config =====
  config: {
    get: () => Promise<AppConfig>;
    save: (config: AppConfig) => Promise<ConfigSaveResult>;
    reload: () => Promise<AppConfig>;
  };

  remote: {
    status: () => Promise<RemoteGatewayStatus>;
    restart: () => Promise<RemoteGatewayStatus>;
    stop: () => Promise<RemoteGatewayStatus>;
    createPairing: () => Promise<RemotePairingView>;
    listDevices: () => Promise<import('./remote-protocol.js').RemoteDevice[]>;
    revokeDevice: (deviceId: string) => Promise<boolean>;
    updateDeviceScopes: (
      deviceId: string,
      scopes: import('./remote-protocol.js').RemoteDeviceScope[],
    ) => Promise<import('./remote-protocol.js').RemoteDevice | null>;
  };

  // ===== MCP =====
  mcp: {
    status: () => Promise<MCPStatus>;
    /** 获取 MCP 工具列表（main 返回 { tools: MCPToolInfo[] } 包裹结构） */
    tools: () => Promise<{ tools: MCPToolInfo[] }>;
    connect: (serverId: string) => Promise<MCPConnectionResult>;
    disconnect: (serverId: string) => Promise<MCPConnectionResult>;
    install: (payload: MCPInstallPayload) => Promise<MCPInstallResult>;
    catalog: {
      list: (category?: string) => Promise<MCPCatalogResult>;
      search: (query: string) => Promise<MCPCatalogResult>;
    };
  };

  // ===== Skill =====
  skill: {
    list: () => Promise<SkillInfo[]>;
    preview: (name: string) => Promise<SkillPreview | null>;
    toggle: (name: string, enabled: boolean) => Promise<boolean>;
    create: (payload: {
      name: string;
      description: string;
      keywords: string[];
      content: string;
    }) => Promise<{ success: boolean; error?: string; path?: string }>;
    delete: (name: string) => Promise<{ success: boolean; error?: string }>;
    reload: () => Promise<{ count: number }>;
    /** Skill 路由匹配（main 返回 { skills: SkillInfo[] } 包裹结构） */
    route: (taskDescription: string) => Promise<{ skills: SkillInfo[] }>;
  };

  // ===== Hook =====
  hook: {
    list: () => Promise<HookInfo[]>;
    toggle: (hookId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    create: (payload: unknown) => Promise<{ success: boolean; hookId?: string; error?: string }>;
    delete: (hookId: string) => Promise<{ success: boolean; error?: string }>;
  };

  // ===== Experiment =====
  experiment: {
    list: () => Promise<ExperimentInfo[]>;
    adopt: (id: string) => Promise<{ success: boolean; error?: string }>;
    discard: (id: string) => Promise<{ success: boolean; error?: string }>;
    getDiff: (id: string) => Promise<{ diff: string; filesChanged: number; error?: string }>;
  };

  // ===== Goal =====
  goal: {
    listResumable: () => Promise<ResumableGoalIpcInfo[]>;
    resume: (goalId: string) => Promise<{ success: boolean; error?: string }>;
    discard: (goalId: string) => Promise<{ success: boolean; error?: string }>;
  };

  // ===== Trace =====
  trace: {
    listSessions: (limit?: number) => Promise<TraceSession[]>;
    replay: (sessionId: string, step?: number) => Promise<TimelineEvent[]>;
    scorecard: (sessionId: string) => Promise<Scorecard | null>;
  };

  // ===== Checkpoint =====
  checkpoint: {
    list: (projectId?: string) => Promise<CheckpointInfo[]>;
    rollback: (checkpointId: string) => Promise<{ success: boolean; error?: string }>;
  };

  // ===== Session 状态卡 =====
  session: {
    getStatus: () => Promise<SessionStatus>;
  };

  // ===== Phase 96+ A3.3：实时费用 + 缓存命中率统计 =====
  stats: {
    /** 获取当前会话的统计快照（token / 费用 / 缓存命中 / 预算使用率） */
    getSnapshot: () => Promise<StatsSnapshot>;
  };

  // ===== Agent Profile =====
  profile: {
    list: () => Promise<AgentProfileSummary[]>;
    get: (id: string) => Promise<AgentProfileDetail | null>;
    save: (profile: ProfileSavePayload) => Promise<ProfileOpResult>;
    delete: (id: string) => Promise<ProfileOpResult>;
    duplicate: (id: string, newName: string) => Promise<ProfileOpResult>;
    /** 弹出文件选择对话框导入 SKILL.md（无参数） */
    import: () => Promise<ProfileOpResult>;
    /** 列出版本历史（时间倒序） */
    listVersions: (profileId: string) => Promise<VersionMeta[]>;
    /** 获取指定版本完整记录 */
    getVersion: (profileId: string, versionId: string) => Promise<VersionRecord | null>;
    /** 回滚到指定版本 */
    rollback: (profileId: string, versionId: string) => Promise<ProfileOpResult>;
    /** 比较两个版本的字段差异 */
    diffVersions: (
      profileId: string,
      fromVersionId: string,
      toVersionId: string,
    ) => Promise<FieldDiff[]>;
    /** 比较当前 Profile 与指定历史版本 */
    diffCurrentWith: (
      profileId: string,
      targetVersionId: string,
    ) => Promise<FieldDiff[]>;
  };
}

// ============================================================
// 全局 Window 声明
// ============================================================

declare global {
  interface Window {
    routedev: RouteDevAPI;
  }
}
