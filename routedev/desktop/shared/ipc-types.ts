// desktop/shared/ipc-types.ts
// 主进程与渲染进程共享的 IPC 类型定义

import type { AppConfig } from '../../src/config/schema.js';
import type { TokenProfileSnapshot } from '../../src/agent/token-profiler.js';
import type { TraceSpan } from '../../src/harness/trace-types.js';

export type { AppConfig, TokenProfileSnapshot };

export interface ChatSendPayload {
  text: string;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatStreamPayload {
  type: 'text_delta' | 'reasoning_delta' | 'tool_start' | 'tool_done' | 'progress' | 'done' | 'error';
  chunk?: string;
  /** 推理过程增量文本（DeepSeek-R1 等 reasoning 模型） */
  reasoning?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  progress?: { current: number; total: number; label: string; modelId?: string; tier?: string };
  error?: string;
}

export interface CommandExecutePayload {
  text: string;
}

export interface ToolExecutePayload {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolConfirmPayload {
  approved: boolean;
  payload?: unknown;
}

export interface ConfigSaveResult {
  success: boolean;
  error?: string;
}

export interface MCPStatus {
  connected: boolean;
  servers: Array<{ id: string; connected: boolean; error?: string }>;
}

// ============================================================
// Phase 37：Skill 管理 IPC 类型
// ============================================================

/** Skill 信息（列表用，不含 content） */
export interface SkillInfo {
  name: string;
  description: string;
  routingKeywords: string[];
  enabled: boolean;
  sourcePath: string;
}

/** Skill 预览（含完整 content） */
export interface SkillPreview extends SkillInfo {
  content: string;
}

/** 创建 Skill 的参数 */
export interface SkillCreatePayload {
  name: string;
  description: string;
  keywords: string[];
  content: string;
}

/** Skill 操作结果 */
export interface SkillOpResult {
  success: boolean;
  error?: string;
  path?: string;
}

/** Skill 路由测试结果 */
export interface SkillRouteResult {
  skills: SkillInfo[];
}

/** MCP 工具信息 */
export interface MCPToolInfo {
  name: string;
  description: string;
  serverId: string;
}

/** MCP 工具列表结果 */
export interface MCPToolsResult {
  tools: MCPToolInfo[];
}

// ============================================================
// MCP 插件市场 IPC 类型
// ============================================================

/** MCP 市场目录条目（内置精选服务器） */
export interface MCPCatalogEntry {
  /** 服务器唯一标识（用作 config 中的 id） */
  id: string;
  /** 显示名称 */
  displayName: string;
  /** 简短描述 */
  description: string;
  /** 分类：filesystem/database/browser/search/devtool/communication/other */
  category: 'filesystem' | 'database' | 'browser' | 'search' | 'devtool' | 'communication' | 'other';
  /** 传输类型 */
  transport: 'stdio' | 'http';
  /** stdio 启动命令（如 npx） */
  command?: string;
  /** stdio 命令参数 */
  args?: string[];
  /** stdio 所需环境变量键名列表（用户安装时需填写值） */
  requiredEnv?: string[];
  /** http 服务器 URL */
  url?: string;
  /** http 请求头键名列表 */
  requiredHeaders?: string[];
  /** 主页 URL（GitHub 仓库或官方文档） */
  homepage: string;
  /** 是否需要 API Key（用于 UI 提示） */
  requiresApiKey: boolean;
  /** 流行度（数字越大越流行，用于排序） */
  popularity: number;
}

/** 市场搜索结果 */
export interface MCPCatalogResult {
  entries: MCPCatalogEntry[];
  total: number;
}

/** 一键安装参数 */
export interface MCPInstallPayload {
  /** 目录条目 id */
  catalogId: string;
  /** 用户填写的环境变量值（key → value） */
  envValues?: Record<string, string>;
  /** 用户填写的 headers 值（key → value） */
  headerValues?: Record<string, string>;
  /** 自定义服务器 id（默认用 catalogId） */
  customId?: string;
}

/** 安装结果 */
export interface MCPInstallResult {
  success: boolean;
  error?: string;
  /** 安装后的服务器 id */
  serverId?: string;
  /** 是否已连接 */
  connected?: boolean;
}

/** 连接/断开结果 */
export interface MCPConnectionResult {
  success: boolean;
  error?: string;
  status?: MCPStatus;
}

// ============================================================
// Phase 39：实验分支 / 代码地图 / Hook IPC 类型
// ============================================================

/** 实验分支信息（列表用，不含 diff 详情） */
export interface ExperimentInfo {
  /** 实验 ID（exp-001, exp-002, ...） */
  id: string;
  /** 实验名称 */
  name: string;
  /** 状态：pending / running / completed / failed / blocked */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  /** 任务描述 */
  task: string;
  /** 修改的文件列表 */
  modifiedFiles: string[];
  /** 累计 token 用量 */
  tokenUsage?: number;
  /** 运行时长（毫秒） */
  duration?: number;
  /** 错误信息（status=failed 时） */
  error?: string;
}

/** CodeGraph 引擎状态 */
export interface CodeGraphStatus {
  /** CodeGraph 是否可用（已安装） */
  available: boolean;
  /** 是否已建立索引 */
  indexed: boolean;
  /** 已索引文件数 */
  fileCount?: number;
  /** 最后更新时间（ISO 字符串） */
  lastUpdated?: string;
}

/** Hook 信息（列表用） */
export interface HookInfo {
  /** Hook 唯一标识 */
  id: string;
  /** Hook 名称 */
  name: string;
  /** 触发事件（如 pre-tool-call / post-tool-call / on-session-start） */
  event: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否为模板（true=来自模板库，false=用户自定义） */
  isTemplate: boolean;
  /** 描述 */
  description: string;
}

// ============================================================
// Phase 47 Task 6：Checkpoint 时间轴 IPC 类型
// ============================================================

/** 检查点信息（IPC 传输用，用于时间轴展示） */
export interface CheckpointInfo {
  /** 检查点唯一 ID */
  id: string;
  /** 创建时间戳 */
  timestamp: number;
  /** 原始描述 */
  description: string;
  /** 语义化摘要（LLM 生成，可能为空，UI 应回退到 description） */
  summary?: string;
  /** 统计信息 */
  stats?: { filesChanged: number; tokensUsed: number };
  /** 是否自动创建 */
  isAutoCreated: boolean;
}

export type MainToRendererEvent =
  | { channel: 'chat:stream'; payload: ChatStreamPayload }
  | { channel: 'chat:tool-confirm-request'; payload: { toolName: string; params: Record<string, unknown> } }
  | { channel: 'token:profile'; payload: TokenProfileSnapshot }
  | { channel: 'trace:event'; payload: TraceSpan }
  | { channel: 'config:reloaded'; payload: AppConfig }
  // Phase 39：实验分支进度事件
  | { channel: 'experiment:progress'; payload: { taskId: string; phase: string; message?: string; modifiedFiles?: string[]; tokenUsage?: number } }
  // Phase 39：实验分支状态变更事件
  | { channel: 'experiment:status'; payload: { taskId: string; status: string } }
  // Phase 39：代码地图索引进度事件
  | { channel: 'codemap:indexing'; payload: { progress: number; fileCount?: number } }
  // Phase 39：Hook 触发事件
  | { channel: 'hook:fired'; payload: { hookName: string; event: string; result?: string } };

export interface RouteDevAPI {
  chat: {
    send: (payload: ChatSendPayload) => void;
    confirmTool: (payload: ToolConfirmPayload) => void;
    /** 停止当前生成（中止进行中的 LLM 请求与 Agent Loop） */
    stop: () => void;
    syncHistory: (messages: ChatHistoryMessage[]) => void;
    /** 使用杂活模型生成对话标题（首条消息后调用），返回标题字符串或 null */
    generateTitle: (userMessage: string, assistantReply?: string) => Promise<string | null>;
  };
  config: {
    get: () => Promise<AppConfig>;
    save: (config: AppConfig) => Promise<ConfigSaveResult>;
    reload: () => Promise<AppConfig>;
  };
  command: {
    execute: (payload: CommandExecutePayload) => Promise<unknown>;
  };
  tool: {
    execute: (payload: ToolExecutePayload) => Promise<unknown>;
  };
  mcp: {
    status: () => Promise<MCPStatus>;
    /** Phase 37：列出所有已连接 MCP 服务器的工具 */
    tools: () => Promise<MCPToolsResult>;
    /** 插件市场：列出内置精选 MCP 服务器目录 */
    catalog: {
      list: (category?: string) => Promise<MCPCatalogResult>;
      /** 按关键词搜索目录 */
      search: (query: string) => Promise<MCPCatalogResult>;
    };
    /** 一键安装：将目录中的服务器添加到配置并连接 */
    install: (payload: MCPInstallPayload) => Promise<MCPInstallResult>;
    /** 连接指定服务器 */
    connect: (serverId: string) => Promise<MCPConnectionResult>;
    /** 断开指定服务器 */
    disconnect: (serverId: string) => Promise<MCPConnectionResult>;
  };
  skill: {
    /** 列出所有 Skill（含启用/禁用状态） */
    list: () => Promise<SkillInfo[]>;
    /** 预览指定 Skill（含完整 content） */
    preview: (name: string) => Promise<SkillPreview | null>;
    /** 启用/禁用 Skill */
    toggle: (name: string, enabled: boolean) => Promise<boolean>;
    /** 创建新 Skill */
    create: (payload: SkillCreatePayload) => Promise<SkillOpResult>;
    /** 删除 Skill */
    delete: (name: string) => Promise<SkillOpResult>;
    /** 重新发现 Skill（从文件系统重新加载） */
    reload: () => Promise<{ count: number }>;
    /** 根据任务描述测试 Skill 路由匹配 */
    route: (taskDescription: string) => Promise<SkillRouteResult>;
  };
  fs: {
    read: (filePath: string) => Promise<{ data: string; error?: string }>;
    /** 弹出文件夹选择对话框，返回选中路径或 null */
    selectFolder: (defaultPath?: string) => Promise<string | null>;
    /** 在系统文件资源管理器中打开指定路径 */
    openFolder: (filePath: string) => Promise<boolean>;
  };
  project: {
    /** 切换项目工作目录，通知 main 进程更新 engine.cwd */
    setCwd: (cwd: string) => void;
  };
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };
  // Phase 39：实验分支管理 API
  experiment: {
    /** 列出所有实验分支 */
    list: () => Promise<ExperimentInfo[]>;
    /** 采纳实验分支（合并到当前分支） */
    adopt: (experimentId: string) => Promise<{ success: boolean; error?: string }>;
    /** 丢弃实验分支（删除 worktree） */
    discard: (experimentId: string) => Promise<{ success: boolean; error?: string }>;
    /** 获取实验分支的 diff */
    getDiff: (experimentId: string) => Promise<{ diff: string; filesChanged: number; error?: string }>;
  };
  // Phase 39：代码地图 API
  codemap: {
    /** 检查 CodeGraph 引擎状态 */
    checkStatus: () => Promise<CodeGraphStatus>;
    /** 安装 CodeGraph 引擎 */
    install: () => Promise<{ success: boolean; error?: string }>;
    /** 启动索引 */
    startIndex: () => Promise<{ success: boolean; error?: string }>;
  };
  // Phase 39：Hook 管理 API
  hook: {
    /** 列出所有 Hook（模板 + 自定义） */
    list: () => Promise<HookInfo[]>;
    /** 启用/禁用 Hook */
    toggle: (hookId: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    /** 创建自定义 Hook（通过自然语言描述生成） */
    create: (description: string) => Promise<{ success: boolean; hookId?: string; error?: string }>;
    /** 删除自定义 Hook */
    delete: (hookId: string) => Promise<{ success: boolean; error?: string }>;
  };
  // Phase 47 Task 6：Checkpoint 时间轴 API
  checkpoint: {
    /** 列出当前项目的所有检查点（用于时间轴展示） */
    list: (projectId?: string) => Promise<CheckpointInfo[]>;
    /** 回滚到指定检查点（破坏性操作，UI 需在调用前确认） */
    rollback: (checkpointId: string) => Promise<{ success: boolean; error?: string }>;
  };
  on: (channel: MainToRendererEvent['channel'], callback: (payload: unknown) => void) => void;
  off: (channel: MainToRendererEvent['channel'], callback: (payload: unknown) => void) => void;
}

declare global {
  interface Window {
    routedev: RouteDevAPI;
  }
}
