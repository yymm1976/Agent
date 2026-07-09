// desktop/preload/index.ts
// 预加载脚本：在隔离的渲染进程中暴露受控的 RouteDev API

import { contextBridge, ipcRenderer } from 'electron';
import type { RouteDevAPI, MainToRendererEvent } from '../shared/ipc-types.js';

// 维护 callback -> listener 的映射，使 off 可以正确解绑
type ListenerMap = Map<
  string,
  Map<(payload: unknown) => void, (event: Electron.IpcRendererEvent, payload: unknown) => void>
>;

const listenerMap: ListenerMap = new Map();

function getChannelMap(channel: string): Map<(payload: unknown) => void, (event: Electron.IpcRendererEvent, payload: unknown) => void> {
  let map = listenerMap.get(channel);
  if (!map) {
    map = new Map();
    listenerMap.set(channel, map);
  }
  return map;
}

const api: RouteDevAPI = {
  chat: {
    send: (payload) => ipcRenderer.send('chat:send', payload),
    confirmTool: (payload) => ipcRenderer.send('chat:confirm-tool', payload),
    stop: () => ipcRenderer.send('chat:stop'),
    syncHistory: (messages) => ipcRenderer.send('chat:sync-history', messages),
    /** 使用杂活模型生成对话标题（首条消息后调用） */
    generateTitle: (userMessage: string, assistantReply?: string) =>
      ipcRenderer.invoke('chat:generate-title', userMessage, assistantReply),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    reload: () => ipcRenderer.invoke('config:reload'),
  },
  command: {
    execute: (payload) => ipcRenderer.invoke('command:execute', payload),
  },
  tool: {
    execute: (payload) => ipcRenderer.invoke('tool:execute', payload),
  },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    tools: () => ipcRenderer.invoke('mcp:tools'),
    catalog: {
      list: (category?: string) => ipcRenderer.invoke('mcp:catalog:list', category),
      search: (query: string) => ipcRenderer.invoke('mcp:catalog:search', query),
    },
    install: (payload) => ipcRenderer.invoke('mcp:install', payload),
    connect: (serverId: string) => ipcRenderer.invoke('mcp:connect', serverId),
    disconnect: (serverId: string) => ipcRenderer.invoke('mcp:disconnect', serverId),
  },
  skill: {
    list: () => ipcRenderer.invoke('skill:list'),
    preview: (name: string) => ipcRenderer.invoke('skill:preview', name),
    toggle: (name: string, enabled: boolean) => ipcRenderer.invoke('skill:toggle', { name, enabled }),
    create: (payload) => ipcRenderer.invoke('skill:create', payload),
    delete: (name: string) => ipcRenderer.invoke('skill:delete', name),
    reload: () => ipcRenderer.invoke('skill:reload'),
    route: (taskDescription: string) => ipcRenderer.invoke('skill:route', taskDescription),
  },
  fs: {
    read: (filePath: string) => ipcRenderer.invoke('fs:read', filePath),
    selectFolder: (defaultPath?: string) => ipcRenderer.invoke('fs:select-folder', defaultPath),
    openFolder: (filePath: string) => ipcRenderer.invoke('fs:open-folder', filePath),
  },
  project: {
    /** 切换项目工作目录，通知 main 进程更新 engine.cwd */
    setCwd: (cwd: string) => ipcRenderer.send('project:set-cwd', cwd),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  // Phase 39：实验分支管理
  experiment: {
    list: () => ipcRenderer.invoke('experiment:list'),
    adopt: (experimentId: string) => ipcRenderer.invoke('experiment:adopt', experimentId),
    discard: (experimentId: string) => ipcRenderer.invoke('experiment:discard', experimentId),
    getDiff: (experimentId: string) => ipcRenderer.invoke('experiment:get-diff', experimentId),
  },
  // Phase 39：Hook 管理
  hook: {
    list: () => ipcRenderer.invoke('hook:list'),
    toggle: (hookId: string, enabled: boolean) => ipcRenderer.invoke('hook:toggle', { hookId, enabled }),
    create: (payload) => ipcRenderer.invoke('hook:create', payload),
    delete: (hookId: string) => ipcRenderer.invoke('hook:delete', hookId),
  },
  // Phase 47 Task 6：Checkpoint 时间轴
  checkpoint: {
    list: (projectId?: string) => ipcRenderer.invoke('checkpoint:list', projectId),
    rollback: (checkpointId: string) => ipcRenderer.invoke('checkpoint:rollback', checkpointId),
  },
  // Phase 54：计划编辑响应（StepEditor 确认/取消后回传主进程）
  plan: {
    respondEdit: (payload) => ipcRenderer.send('plan:edit-response', payload),
    // Phase 71：读取 plan 修订历史 + 触发遗漏点检查
    getRevisions: (goalId: string) => ipcRenderer.invoke('plan:get-revisions', goalId),
    checkOmissions: (goalId: string) => ipcRenderer.invoke('plan:check-omissions', goalId),
  },
  // Phase 77 借鉴点 7：冷启动恢复——查询/恢复/放弃可恢复 goal
  goal: {
    listResumable: () => ipcRenderer.invoke('goal:list-resumable'),
    resume: (goalId: string) => ipcRenderer.invoke('goal:resume', goalId),
    discard: (goalId: string) => ipcRenderer.invoke('goal:discard', goalId),
  },
  // Phase 73 Part C：Steering / Follow-up 双消息队列 API
  agent: {
    followUp: (content: string) => ipcRenderer.send('agent:followUp', content),
    clearAllQueues: () => ipcRenderer.send('agent:clearAllQueues'),
    setFollowUpMode: (mode: 'all' | 'one-at-a-time') => ipcRenderer.send('agent:setFollowUpMode', mode),
    getQueueStatus: () => ipcRenderer.invoke('agent:queueStatus'),
    getFollowUpQueue: () => ipcRenderer.invoke('agent:getFollowUpQueue'),
    removeFollowUp: (index: number) => ipcRenderer.invoke('agent:removeFollowUp', index),
  },
  // Phase 77 借鉴点 4：Voice Memo 式会话状态卡 API
  session: {
    getStatus: () => ipcRenderer.invoke('session:get-status'),
  },
  on: (channel, callback) => {
    const channelMap = getChannelMap(channel);
    if (channelMap.has(callback)) return;
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      callback(payload as MainToRendererEvent['payload']);
    };
    channelMap.set(callback, listener);
    ipcRenderer.on(channel, listener);
  },
  // Phase 77：运行回放与评分卡 API
  trace: {
    listSessions: (limit?: number) => ipcRenderer.invoke('trace:list-sessions', limit),
    replay: (sessionId: string, step?: number) => ipcRenderer.invoke('trace:replay', sessionId, step),
    scorecard: (sessionId: string) => ipcRenderer.invoke('trace:scorecard', sessionId),
  },
  off: (channel, callback) => {
    const channelMap = listenerMap.get(channel);
    if (!channelMap) return;
    const listener = channelMap.get(callback);
    if (listener) {
      ipcRenderer.removeListener(channel, listener);
      channelMap.delete(callback);
    }
  },
};

contextBridge.exposeInMainWorld('routedev', api);
