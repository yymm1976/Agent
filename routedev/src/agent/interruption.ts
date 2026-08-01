// src/agent/interruption.ts
// Phase 97 Part C：统一中断（Interruption）类型
//
// 设计目的：
//   把所有需要人工介入的状态收敛为同一抽象：工具权限、向用户提问、计划审批、
//   冲突解决、凭据缺失。任何页面或远程客户端只需消费一个中断队列，
//   不各自注册弹窗路径。渲染层重载后可通过 Broker.reclaim 重新取回未处理中断。

/** 中断种类 */
export type InterruptionKind =
  | 'permission_request'
  | 'ask_user'
  | 'plan_approval'
  | 'conflict_resolution'
  | 'credential_required';

/** 中断状态 */
export type InterruptionStatus = 'pending' | 'resolved' | 'rejected' | 'timed_out';

/** 公共字段 */
export interface BaseInterruption {
  /** 全局唯一中断 id */
  id: string;
  kind: InterruptionKind;
  /** 所属会话 */
  sessionId: string;
  /** 创建时间（毫秒） */
  createdAt: number;
  /** 过期时间（毫秒），超时未处理自动按拒绝处理 */
  expiresAt?: number;
  status: InterruptionStatus;
}

/** 具体中断类型 */
export type Interruption =
  | (BaseInterruption & { kind: 'permission_request'; toolName: string; args: unknown; reason: string })
  | (BaseInterruption & { kind: 'ask_user'; question: string; options?: string[] })
  | (BaseInterruption & { kind: 'plan_approval'; plan: unknown })
  | (BaseInterruption & { kind: 'conflict_resolution'; conflict: unknown })
  | (BaseInterruption & { kind: 'credential_required'; provider: string });

/** 中断解析结果 */
export interface InterruptionResolution {
  approved: boolean;
  payload?: unknown;
}

/** 生成中断 id */
export function createInterruptionId(sessionId: string): string {
  return `${sessionId}-int-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
