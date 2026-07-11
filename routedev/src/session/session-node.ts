// src/session/session-node.ts
// Phase 84 Task 1：会话树节点定义
//
// 会话树节点是 SessionTree 的基本组成单元。每个节点有零或一个父节点，
// 零或多个子节点。分支通过 fork 创建：从指定节点分叉出新分支，
// 新旧分支共享 fork 点之前的节点。

/**
 * 会话树节点
 */
export interface SessionNode {
  /** 节点唯一 ID */
  id: string;
  /** 父节点 ID，根节点为 null */
  parentId: string | null;
  /** 消息角色 */
  role: 'user' | 'assistant' | 'toolResult' | 'system';
  /** 消息内容（类型宽松，兼容各种消息格式） */
  content: unknown;
  /** 创建时间戳（毫秒） */
  timestamp: number;
  /** 子节点 ID 列表 */
  children: string[];
  /** 关联的 Checkpoint ID（可选） */
  checkpointId?: string;
  /** 所属分支 ID（fork 时标记） */
  branchId?: string;
}
