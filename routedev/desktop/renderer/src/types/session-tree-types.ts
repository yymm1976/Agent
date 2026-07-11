// desktop/renderer/src/types/session-tree-types.ts
// Phase 84 Task 3：Session Tree IPC 通道类型定义
//
// 定义渲染进程与主进程之间的会话树通信契约。
// 主进程（engine-bridge）后续注册对应 IPC handler，渲染进程通过 window.routedev 调用。
//
// 通道列表：
//   session:tree          — 获取当前会话树结构
//   session:switch-branch — 切换活跃分支
//   session:fork          — 从指定节点创建新分支
//   session:clone         — 克隆当前活跃分支到新会话树
//
// 集成步骤（主 Agent 后续完成）：
//   1. 在 desktop/preload/index.ts 的 session 命名空间下添加以下方法
//   2. 在 desktop/main/engine-bridge.ts 注册对应 IPC handler
//   3. 在 desktop/shared/ipc-types.ts 的 RouteDevAPI.session 中扩展类型

import type { SessionTreeData } from '../../../../src/session/session-tree.js';

/** Session Tree IPC 通道名 */
export const SESSION_TREE_CHANNELS = {
  /** 获取当前会话树结构（返回 SessionTreeData 序列化数据） */
  GET_TREE: 'session:tree',
  /** 切换活跃分支（参数：branchId） */
  SWITCH_BRANCH: 'session:switch-branch',
  /** 从指定节点创建新分支（参数：nodeId，返回新分支 ID） */
  FORK: 'session:fork',
  /** 克隆当前活跃分支到新会话树（返回新会话树数据） */
  CLONE: 'session:clone',
} as const;

/** session:tree 响应数据（无请求参数） */
export type SessionTreeGetResult = SessionTreeData | null;

/** session:switch-branch 请求参数 */
export interface SessionSwitchBranchParams {
  /** 目标分支 ID */
  branchId: string;
}

/** session:switch-branch 响应数据（成功后返回更新后的树结构） */
export type SessionSwitchBranchResult = SessionTreeData;

/** session:fork 请求参数 */
export interface SessionForkParams {
  /** 分叉点节点 ID */
  nodeId: string;
}

/** session:fork 响应数据（返回新分支 ID 和更新后的树结构） */
export interface SessionForkResult {
  /** 新分支 ID */
  branchId: string;
  /** 更新后的树结构 */
  tree: SessionTreeData;
}

/** session:clone 响应数据（返回新会话树结构，无请求参数） */
export type SessionCloneResult = SessionTreeData;

/**
 * Session Tree IPC API 接口（供 preload 暴露）
 *
 * 扩展 window.routedev.session 命名空间，与现有 getStatus 方法并存。
 */
export interface SessionTreeIPC {
  /** 获取当前会话树结构 */
  getTree: () => Promise<SessionTreeGetResult>;
  /** 切换活跃分支 */
  switchBranch: (branchId: string) => Promise<SessionSwitchBranchResult>;
  /** 从指定节点创建新分支 */
  fork: (nodeId: string) => Promise<SessionForkResult>;
  /** 克隆当前活跃分支到新会话树 */
  clone: () => Promise<SessionCloneResult>;
}
