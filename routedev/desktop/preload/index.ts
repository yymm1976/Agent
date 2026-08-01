// desktop/preload/index.ts
// Preload 脚本：在主进程与渲染进程之间桥接，通过 contextBridge 暴露 window.routedev API
//
// 设计要点：
//   1. 严格按 desktop/shared/ipc-types.ts 的 RouteDevAPI 接口实现，确保类型契约一致
//   2. 异步操作（查询/保存）走 ipcRenderer.invoke → ipcMain.handle
//   3. 单向通知（fire-and-forget）走 ipcRenderer.send → ipcMain.on
//   4. 事件订阅走 ipcRenderer.on / removeListener，on() 返回 unsubscribe 函数
//   5. profile.import() 不接收参数（主进程会弹出文件选择对话框）

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  RouteDevAPI,
  MainToRendererChannel,
  WindowAction,
  WindowState,
  EngineState,
  TerminalCreateOptions,
  TerminalInfo,
  TerminalData,
  TerminalExit,
  OpenDialogOptions,
  SaveDialogOptions,
  DialogResult,
  NotificationOptions,
  ProjectInfo,
  UpdateInfo,
  UpdateProgress,
  AppInfo,
  AgentProfileDetail,
  AgentProfileSummary,
  ProfileOpResult,
  ProfileSavePayload,
  VersionMeta,
  VersionRecord,
  FieldDiff,
  StatsSnapshot,
} from '../shared/ipc-types.js';

// ============================================================
// 事件订阅辅助
// ============================================================

/**
 * 订阅主进程推送事件（内部实现，接受任意通道字符串）
 * @param channel IPC 通道名（公开 on() 受 RouteDevAPI 类型约束为 MainToRendererChannel；
 *                内部 onStateChanged/onEngineStateChanged 等订阅其它通道）
 * @param callback 收到 payload 时回调
 * @returns unsubscribe 函数（调用后移除监听）
 */
function on<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * 取消订阅（与 on 返回的 unsubscribe 等价，提供显式取消入口）
 * 注意：on() 内部包了一层 listener，off 时无法直接通过 callback 引用移除；
 * 推荐使用 on() 返回的 unsubscribe 函数完成清理，off() 仅作类型兼容
 */
function off(channel: MainToRendererChannel, callback: (payload: unknown) => void): void {
  void channel;
  void callback;
}

// ============================================================
// RouteDevAPI 实现
// ============================================================

const api: RouteDevAPI = {
  // ===== 事件订阅 =====
  on: <T = unknown>(channel: MainToRendererChannel, callback: (payload: T) => void) =>
    on<T>(channel, callback),
  off,

  // ===== 应用 / 平台 =====
  getAppInfo: () => ipcRenderer.invoke('app:get-info') as Promise<AppInfo>,
  getPath: (name: string) => ipcRenderer.invoke('app:get-path', name) as Promise<string>,
  quit: () => ipcRenderer.invoke('app:quit') as Promise<void>,
  relaunch: () => ipcRenderer.invoke('app:relaunch') as Promise<void>,
  platform: process.platform,
  isElectron: true as const,

  // ===== 窗口 =====
  window: {
    minimize: () => {
      ipcRenderer.send('window:minimize');
    },
    maximize: () => {
      ipcRenderer.send('window:maximize');
    },
    close: () => {
      ipcRenderer.send('window:close');
    },
    restoreFocus: () => ipcRenderer.invoke('window:restore-focus') as Promise<void>,
    action: (action: WindowAction) =>
      ipcRenderer.invoke('window:action', action) as Promise<void>,
    getState: () => ipcRenderer.invoke('window:get-state') as Promise<WindowState>,
    onStateChanged: (callback) => on<WindowState>('window:state-changed', callback),
  },

  // ===== 引擎 =====
  getEngineState: () => ipcRenderer.invoke('engine:get-state') as Promise<EngineState>,
  startEngine: () => ipcRenderer.invoke('engine:start') as Promise<void>,
  stopEngine: () => ipcRenderer.invoke('engine:stop') as Promise<void>,
  restartEngine: () => ipcRenderer.invoke('engine:restart') as Promise<void>,
  onEngineStateChanged: (callback) => on<EngineState>('engine:state-changed', callback),

  // ===== 终端 =====
  createTerminal: (options?: TerminalCreateOptions) =>
    ipcRenderer.invoke('terminal:create', options) as Promise<TerminalInfo>,
  destroyTerminal: (id: string) =>
    ipcRenderer.invoke('terminal:destroy', id) as Promise<void>,
  writeTerminal: (id: string, data: string) =>
    ipcRenderer.invoke('terminal:write', id, data) as Promise<void>,
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows) as Promise<void>,
  listTerminals: () => ipcRenderer.invoke('terminal:list') as Promise<TerminalInfo[]>,
  onTerminalData: (callback) => on<TerminalData>('terminal:data', callback),
  onTerminalExit: (callback) => on<TerminalExit>('terminal:exit', callback),
  onTerminalTitle: (callback) => on<{ id: string; title: string }>('terminal:title', callback),

  // ===== 对话框 / 通知 / Shell / 剪贴板 =====
  openDialog: (options?: OpenDialogOptions) =>
    ipcRenderer.invoke('dialog:open', options) as Promise<DialogResult>,
  saveDialog: (options?: SaveDialogOptions) =>
    ipcRenderer.invoke('dialog:save', options) as Promise<DialogResult>,
  showMessage: (options) => ipcRenderer.invoke('dialog:message', options) as Promise<number>,
  showNotification: (options: NotificationOptions) =>
    ipcRenderer.invoke('notification:show', options) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url) as Promise<void>,
  openPath: (path: string) => ipcRenderer.invoke('shell:open-path', path) as Promise<string>,
  showItemInFolder: (path: string) =>
    ipcRenderer.invoke('shell:show-item-in-folder', path) as Promise<void>,
  writeClipboard: (text: string) =>
    ipcRenderer.invoke('clipboard:write-text', text) as Promise<void>,
  readClipboard: () => ipcRenderer.invoke('clipboard:read-text') as Promise<string>,

  // ===== 项目 =====
  project: {
    open: () => ipcRenderer.invoke('project:open') as Promise<ProjectInfo | null>,
    getRecent: () => ipcRenderer.invoke('project:get-recent') as Promise<ProjectInfo[]>,
    addRecent: (path: string) =>
      ipcRenderer.invoke('project:add-recent', path) as Promise<void>,
    setCwd: (cwd: string) => {
      ipcRenderer.send('project:set-cwd', cwd);
    },
  },

  // ===== 更新 =====
  checkForUpdates: () => ipcRenderer.invoke('update:check') as Promise<UpdateInfo | null>,
  downloadUpdate: () => ipcRenderer.invoke('update:download') as Promise<void>,
  installUpdate: () => ipcRenderer.invoke('update:install') as Promise<void>,
  onUpdateAvailable: (callback) => on<UpdateInfo>('update:available', callback),
  onUpdateProgress: (callback) => on<UpdateProgress>('update:progress', callback),
  onUpdateDownloaded: (callback) => on<UpdateInfo>('update:downloaded', callback),
  onUpdateError: (callback) => on<string>('update:error', callback),

  // ===== 存储 =====
  storeGet: <T>(key: string) =>
    ipcRenderer.invoke('store:get', key) as Promise<T | undefined>,
  storeSet: <T>(key: string, value: T) =>
    ipcRenderer.invoke('store:set', key, value) as Promise<void>,
  storeDelete: (key: string) => ipcRenderer.invoke('store:delete', key) as Promise<void>,

  // ===== 文件系统（受限） =====
  fs: {
    read: (filePath: string) =>
      ipcRenderer.invoke('fs:read', filePath) as Promise<{ data: string; error?: string }>,
    selectFolder: (defaultPath?: string) =>
      ipcRenderer.invoke('fs:select-folder', defaultPath) as Promise<string | null>,
    openFolder: (filePath: string) =>
      ipcRenderer.invoke('fs:open-folder', filePath) as Promise<boolean>,
  },

  // ===== Chat / 命令 / 工具 / 计划编辑 =====
  chat: {
    send: (payload) => {
      ipcRenderer.send('chat:send', payload);
    },
    confirmTool: (payload) => {
      ipcRenderer.send('chat:confirm-tool', payload);
    },
    stop: (requestId?: string) => {
      ipcRenderer.send('chat:stop', requestId ? { requestId } : undefined);
    },
    generateTitle: (userMessage: string, assistantReply?: string) =>
      ipcRenderer.invoke('chat:generate-title', userMessage, assistantReply) as Promise<string>,
    syncHistory: (messages) => {
      ipcRenderer.send('chat:sync-history', messages);
    },
    // Phase 97 Part B：对话级撤销（Turn 快照）
    listTurnSnapshots: (sessionId?: string) =>
      ipcRenderer.invoke('chat:list-turn-snapshots', sessionId) as Promise<import('../../src/harness/turn-snapshot.js').TurnSnapshot[]>,
    restoreTurn: (turnId: string, sessionId?: string) =>
      ipcRenderer.invoke('chat:restore-turn', turnId, sessionId) as Promise<import('../../src/harness/turn-snapshot.js').RestoreResult | null>,
  },

  // Phase 97 Part C：统一中断队列（渲染层重载后 reclaim 恢复未处理中断）
  interruption: {
    reclaim: (sessionId?: string) =>
      ipcRenderer.invoke('interruption:reclaim', sessionId) as Promise<import('../../src/agent/interruption.js').Interruption[]>,
    list: (sessionId?: string) =>
      ipcRenderer.invoke('interruption:list', sessionId) as Promise<import('../../src/agent/interruption.js').Interruption[]>,
  },

  // Phase 97 Part E：子会话可见性（列表/详情/停止）
  agent: {
    listSubagents: (parentSessionId?: string) =>
      ipcRenderer.invoke('agent:list-subagents', parentSessionId) as Promise<import('../main/bridges/agent-bridge.js').SubagentView[]>,
    getSubagent: (childSessionId: string) =>
      ipcRenderer.invoke('agent:get-subagent', childSessionId) as Promise<import('../main/bridges/agent-bridge.js').SubagentView | null>,
    stopSubagent: (childSessionId: string) =>
      ipcRenderer.invoke('agent:stop-subagent', childSessionId) as Promise<boolean>,
    // Phase 97 Part H：Agent 状态聚合快照
    getStatus: () =>
      ipcRenderer.invoke('agent:get-status') as Promise<import('../main/agent-status-service.js').AgentStatusSnapshot>,
    // follow-up 队列
    followUp: (content: string) => {
      ipcRenderer.send('agent:followUp', content);
    },
    clearAllQueues: () => {
      ipcRenderer.send('agent:clearAllQueues');
    },
    setFollowUpMode: (mode) => {
      ipcRenderer.send('agent:setFollowUpMode', mode);
    },
    queueStatus: () =>
      ipcRenderer.invoke('agent:queueStatus') as Promise<import('../shared/ipc-types.js').AgentQueueStatus>,
    getFollowUpQueue: () =>
      ipcRenderer.invoke('agent:getFollowUpQueue') as Promise<import('../shared/ipc-types.js').FollowUpItem[]>,
    removeFollowUp: (index: number) =>
      ipcRenderer.invoke('agent:removeFollowUp', index) as Promise<boolean>,
  },

  // Phase 97 Part G：输入框结构化引用解析
  composer: {
    resolve: (text: string) =>
      ipcRenderer.invoke('composer:resolve', text) as Promise<import('../../src/agent/context/composer-reference.js').ComposerReference[]>,
  },
  command: {
    execute: (payload) =>
      ipcRenderer.invoke('command:execute', typeof payload === 'string' ? { text: payload } : payload) as Promise<unknown>,
  },
  tool: {
    execute: (payload) => ipcRenderer.invoke('tool:execute', payload) as Promise<unknown>,
  },
  plan: {
    respondEdit: (payload) => {
      ipcRenderer.send('plan:edit-response', payload);
    },
    getRevisions: (goalId: string) =>
      ipcRenderer.invoke('plan:get-revisions', goalId) as Promise<{
        ok: boolean;
        revisions?: unknown[];
        error?: string;
      }>,
    checkOmissions: (goalId: string) =>
      ipcRenderer.invoke('plan:check-omissions', goalId) as Promise<{
        ok: boolean;
        result?: { omissions: unknown[]; summary: string };
        error?: string;
      }>,
  },

  // ===== Config =====
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<import('../shared/ipc-types.js').AppConfig>,
    save: (config) => ipcRenderer.invoke('config:save', config) as Promise<import('../shared/ipc-types.js').ConfigSaveResult>,
    reload: () => ipcRenderer.invoke('config:reload') as Promise<import('../shared/ipc-types.js').AppConfig>,
  },

  // ===== Android 远程连接 =====
  remote: {
    status: () => ipcRenderer.invoke('remote:status') as Promise<import('../shared/ipc-types.js').RemoteGatewayStatus>,
    restart: () => ipcRenderer.invoke('remote:restart') as Promise<import('../shared/ipc-types.js').RemoteGatewayStatus>,
    stop: () => ipcRenderer.invoke('remote:stop') as Promise<import('../shared/ipc-types.js').RemoteGatewayStatus>,
    createPairing: () => ipcRenderer.invoke('remote:create-pairing') as Promise<import('../shared/ipc-types.js').RemotePairingView>,
    listDevices: () => ipcRenderer.invoke('remote:list-devices') as Promise<import('../shared/remote-protocol.js').RemoteDevice[]>,
    revokeDevice: (deviceId: string) => ipcRenderer.invoke('remote:revoke-device', deviceId) as Promise<boolean>,
    updateDeviceScopes: (deviceId, scopes) =>
      ipcRenderer.invoke('remote:update-device-scopes', { deviceId, scopes }) as Promise<import('../shared/remote-protocol.js').RemoteDevice | null>,
  },

  // ===== MCP =====
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status') as Promise<import('../shared/ipc-types.js').MCPStatus>,
    tools: () =>
      ipcRenderer.invoke('mcp:tools') as Promise<{ tools: import('../shared/ipc-types.js').MCPToolInfo[] }>,
    connect: (serverId: string) =>
      ipcRenderer.invoke('mcp:connect', serverId) as Promise<import('../shared/ipc-types.js').MCPConnectionResult>,
    disconnect: (serverId: string) =>
      ipcRenderer.invoke('mcp:disconnect', serverId) as Promise<import('../shared/ipc-types.js').MCPConnectionResult>,
    install: (payload) =>
      ipcRenderer.invoke('mcp:install', payload) as Promise<import('../shared/ipc-types.js').MCPInstallResult>,
    catalog: {
      list: (category?: string) =>
        ipcRenderer.invoke('mcp:catalog:list', category) as Promise<import('../shared/ipc-types.js').MCPCatalogResult>,
      search: (query: string) =>
        ipcRenderer.invoke('mcp:catalog:search', query) as Promise<import('../shared/ipc-types.js').MCPCatalogResult>,
    },
  },

  // ===== Skill =====
  skill: {
    list: () => ipcRenderer.invoke('skill:list') as Promise<import('../shared/ipc-types.js').SkillInfo[]>,
    preview: (name: string) =>
      ipcRenderer.invoke('skill:preview', name) as Promise<import('../shared/ipc-types.js').SkillPreview | null>,
    toggle: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('skill:toggle', { name, enabled }) as Promise<boolean>,
    create: (payload) =>
      ipcRenderer.invoke('skill:create', payload) as Promise<{ success: boolean; error?: string; path?: string }>,
    delete: (name: string) =>
      ipcRenderer.invoke('skill:delete', name) as Promise<{ success: boolean; error?: string }>,
    reload: () => ipcRenderer.invoke('skill:reload') as Promise<{ count: number }>,
    route: (taskDescription: string) =>
      ipcRenderer.invoke('skill:route', taskDescription) as Promise<{
        skills: import('../shared/ipc-types.js').SkillInfo[];
      }>,
  },

  // ===== Hook =====
  hook: {
    list: () => ipcRenderer.invoke('hook:list') as Promise<import('../shared/ipc-types.js').HookInfo[]>,
    toggle: (hookId: string, enabled: boolean) =>
      ipcRenderer.invoke('hook:toggle', { hookId, enabled }) as Promise<{ success: boolean; error?: string }>,
    create: (payload) =>
      ipcRenderer.invoke('hook:create', payload) as Promise<{ success: boolean; hookId?: string; error?: string }>,
    delete: (hookId: string) =>
      ipcRenderer.invoke('hook:delete', hookId) as Promise<{ success: boolean; error?: string }>,
  },

  // ===== Experiment =====
  experiment: {
    list: () => ipcRenderer.invoke('experiment:list') as Promise<import('../shared/ipc-types.js').ExperimentInfo[]>,
    adopt: (id: string) =>
      ipcRenderer.invoke('experiment:adopt', id) as Promise<{ success: boolean; error?: string }>,
    discard: (id: string) =>
      ipcRenderer.invoke('experiment:discard', id) as Promise<{ success: boolean; error?: string }>,
    getDiff: (id: string) =>
      ipcRenderer.invoke('experiment:get-diff', id) as Promise<{ diff: string; filesChanged: number; error?: string }>,
  },

  // ===== Goal =====
  goal: {
    listResumable: () =>
      ipcRenderer.invoke('goal:list-resumable') as Promise<import('../shared/ipc-types.js').ResumableGoalIpcInfo[]>,
    resume: (goalId: string) =>
      ipcRenderer.invoke('goal:resume', goalId) as Promise<{ success: boolean; error?: string }>,
    discard: (goalId: string) =>
      ipcRenderer.invoke('goal:discard', goalId) as Promise<{ success: boolean; error?: string }>,
  },

  // ===== Trace =====
  trace: {
    listSessions: (limit?: number) =>
      ipcRenderer.invoke('trace:list-sessions', limit) as Promise<import('../shared/ipc-types.js').TraceSession[]>,
    replay: (sessionId: string, step?: number) =>
      ipcRenderer.invoke('trace:replay', sessionId, step) as Promise<import('../shared/ipc-types.js').TimelineEvent[]>,
    scorecard: (sessionId: string) =>
      ipcRenderer.invoke('trace:scorecard', sessionId) as Promise<import('../shared/ipc-types.js').Scorecard | null>,
  },

  // ===== Checkpoint =====
  checkpoint: {
    list: (projectId?: string) =>
      ipcRenderer.invoke('checkpoint:list', projectId) as Promise<import('../shared/ipc-types.js').CheckpointInfo[]>,
    rollback: (checkpointId: string) =>
      ipcRenderer.invoke('checkpoint:rollback', checkpointId) as Promise<{ success: boolean; error?: string }>,
  },

  // ===== Session 状态卡 =====
  session: {
    getStatus: () =>
      ipcRenderer.invoke('session:get-status') as Promise<import('../shared/ipc-types.js').SessionStatus>,
  },

  // ===== Phase 96+ A3.3：实时费用 + 缓存命中率统计 =====
  stats: {
    getSnapshot: () =>
      ipcRenderer.invoke('stats:get-snapshot') as Promise<StatsSnapshot>,
  },

  // ===== Agent Profile =====
  profile: {
    list: () => ipcRenderer.invoke('profile:list') as Promise<AgentProfileSummary[]>,
    get: (id: string) =>
      ipcRenderer.invoke('profile:get', id) as Promise<AgentProfileDetail | null>,
    save: (profile: ProfileSavePayload) =>
      ipcRenderer.invoke('profile:save', profile) as Promise<ProfileOpResult>,
    delete: (id: string) =>
      ipcRenderer.invoke('profile:delete', id) as Promise<ProfileOpResult>,
    duplicate: (id: string, newName: string) =>
      ipcRenderer.invoke('profile:duplicate', id, newName) as Promise<ProfileOpResult>,
    /** 弹出文件选择对话框导入 SKILL.md（无参数） */
    import: () => ipcRenderer.invoke('profile:import') as Promise<ProfileOpResult>,
    /** 列出版本历史（时间倒序） */
    listVersions: (profileId: string) =>
      ipcRenderer.invoke('profile:list-versions', profileId) as Promise<VersionMeta[]>,
    /** 获取指定版本完整记录 */
    getVersion: (profileId: string, versionId: string) =>
      ipcRenderer.invoke('profile:get-version', profileId, versionId) as Promise<VersionRecord | null>,
    /** 回滚到指定版本 */
    rollback: (profileId: string, versionId: string) =>
      ipcRenderer.invoke('profile:rollback', profileId, versionId) as Promise<ProfileOpResult>,
    /** 比较两个版本的字段差异 */
    diffVersions: (profileId: string, fromVersionId: string, toVersionId: string) =>
      ipcRenderer.invoke('profile:diff-versions', profileId, fromVersionId, toVersionId) as Promise<FieldDiff[]>,
    /** 比较当前 Profile 与指定历史版本 */
    diffCurrentWith: (profileId: string, targetVersionId: string) =>
      ipcRenderer.invoke('profile:diff-current-with', profileId, targetVersionId) as Promise<FieldDiff[]>,
  },
};

contextBridge.exposeInMainWorld('routedev', api);

export type { RouteDevAPI };
