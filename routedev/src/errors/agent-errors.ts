// src/errors/agent-errors.ts
// GA Hardening 第4项：类型化错误体系（AgentError hierarchy）
//
// 目标：核心控制流（重试/取消/协议判定）用错误类型驱动，不再用消息字符串正则。
// 统一继承 RouteDevError（携带稳定 code=KIND_ERROR），与既有错误体系共享基类。
//
// 每个错误类别携带 retryable 语义：
//   - 401/403（AuthError）、协议损坏（ProtocolError）、工具被拒（ToolRejectedError）、
//     验证失败（VerificationError）、用户取消（CancellationError）、内部不变量
//     破坏（InternalInvariantError）→ 重试无意义，retryable=false
//   - 429/529（RateLimitError）、超时（TimeoutError）、provider 不可用
//     （ProviderUnavailableError）→ 瞬时故障，retryable=true

import { RouteDevError } from '../utils/errors.js';

export type AgentErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'provider_unavailable'
  | 'protocol'
  | 'tool_execution'
  | 'tool_rejected'
  | 'verification'
  | 'cancelled'
  | 'timeout'
  | 'internal_invariant';

/** AgentError 基类——所有内部错误继承此类型 */
export abstract class AgentError extends RouteDevError {
  readonly kind: AgentErrorKind;
  /** 该错误类别是否值得重试（类型化判定，替代消息正则） */
  readonly retryable: boolean;

  protected constructor(kind: AgentErrorKind, retryable: boolean, message: string, cause?: unknown) {
    super(message, `${kind.toUpperCase()}_ERROR`, { cause });
    this.kind = kind;
    this.retryable = retryable;
  }

  /** 是否可重试（供重试策略类型化判定） */
  get isRetryable(): boolean {
    return this.retryable;
  }
}

/** 认证失败（401/403）——重试无意义，必须停止重试 */
export class AuthError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('auth', false, message, cause);
  }
}

/** 速率限制（429/529）——瞬时过载，可重试 */
export class RateLimitError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('rate_limit', true, message, cause);
  }
}

/** Provider 不可用（网络错误/连接拒绝/DNS）——瞬时故障，可重试 */
export class ProviderUnavailableError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('provider_unavailable', true, message, cause);
  }
}

/** 协议错误（流不完整/非法响应/模型拒绝请求）——重试通常无意义 */
export class ProtocolError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('protocol', false, message, cause);
  }
}

/** 工具执行失败（已隔离的错误，语义上不是控制流异常） */
export class ToolExecutionError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('tool_execution', false, message, cause);
  }
}

/** 工具被权限/用户拒绝 */
export class ToolRejectedError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('tool_rejected', false, message, cause);
  }
}

/** 验证失败（完成度/代码验证未通过） */
export class VerificationError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('verification', false, message, cause);
  }
}

/** 用户取消（AbortSignal）——重试无意义 */
export class CancellationError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('cancelled', false, message, cause);
  }
}

/** 超时（408/请求超时）——瞬时故障，可重试 */
export class TimeoutError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('timeout', true, message, cause);
  }
}

/** 内部不变量破坏（不可能发生的状态）——重试无意义，应修复代码 */
export class InternalInvariantError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('internal_invariant', false, message, cause);
  }
}

/**
 * 类型化重试判定：
 * 1. AgentError → 直接用 retryable（核心控制流，不碰消息字符串）
 * 2. 外部 SDK 错误（非 AgentError）→ 消息正则兜底（无法类型化的外部错误）
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof AgentError) return error.retryable;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('timeout')
      || msg.includes('econnreset')
      || msg.includes('rate limit')
      || msg.includes('529')
      || msg.includes('overloaded');
  }
  return false;
}

/** 是否认证错误（401/403）——任何情况下都不得重试 */
export function isAuthError(error: unknown): boolean {
  return error instanceof AgentError && error.kind === 'auth';
}
