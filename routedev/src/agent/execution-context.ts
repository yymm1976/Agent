// src/agent/execution-context.ts
// Phase 97 Part A：统一 Agent 执行上下文
//
// 设计目的：
//   让手动 / 自动化 / 远程 / 子 Agent 委派四类触发来源共用同一执行上下文，
//   保留 sessionId / workspaceId / 权限模式 / 附加资源 / 通知目标。
//   任何执行入口（loop / goal / 远程 / spawn_agent）都显式携带 triggerSource，
//   缺失时以 user 兜底（fail-open，保持兼容）。

/** 触发来源：手动 / 自动化 / 远程 / 子 Agent 委派 */
export type TriggerSource = 'user' | 'automation' | 'remote' | 'delegation';

/** 权限模式：manual 全程确认 / semi 自动放行只读 / auto 高自主 */
export type ExecutionPermissionMode = 'manual' | 'semi' | 'auto';

/** 通知目标：任务完成或需要介入时推送到的位置 */
export interface ExecutionNotificationTarget {
  kind: 'ui' | 'feishu' | 'sse';
  id: string;
}

/** 统一 Agent 执行上下文 */
export interface AgentExecutionContext {
  /** 触发来源 */
  triggerSource: TriggerSource;
  /** 会话 id（必填，事件与持久化的公共关联键） */
  sessionId: string;
  /** 工作区 id（Part D 落地后生效，可为空） */
  workspaceId?: string;
  /** 使用的模型 id */
  model?: string;
  /** 权限模式，默认 semi */
  permissionMode: ExecutionPermissionMode;
  /** 显式附加资源（文件/目录路径，受工作区边界校验） */
  attachedResources: string[];
  /** 通知目标 */
  notificationTarget?: ExecutionNotificationTarget;
}

/** 兜底上下文：触发来源缺失时使用（overrides 用于显式透传 automation/remote/delegation 等来源） */
export function createDefaultExecutionContext(
  sessionId: string,
  overrides?: Partial<AgentExecutionContext>,
): AgentExecutionContext {
  return {
    triggerSource: 'user',
    sessionId,
    permissionMode: 'manual',
    attachedResources: [],
    ...overrides,
  };
}
