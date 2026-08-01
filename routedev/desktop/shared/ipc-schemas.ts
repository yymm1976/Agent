// desktop/shared/ipc-schemas.ts
// Phase 93 Task 5：IPC payload Zod 运行时校验 schemas
//
// 用途：为渲染层 useRouteDevStore 的 IPC 事件回调提供运行时校验，防止跨进程通信
// 数据被篡改或格式不兼容导致 UI 异常。
//
// 设计要点：
//   1. 仅覆盖 main → renderer 方向的 IPC 事件 payload（renderer → main 的 payload
//      是渲染层构造的对象字面量，不属于反序列化边界）
//   2. fail-open：校验失败时返回带 type 字段的 fallback 对象，避免 store 抛错
//   3. 宽松校验：ChatStreamPayload 是 discriminated union，严格校验会导致
//      新增事件类型时立即失败，改用 z.object({ type: z.string() }).passthrough()
//      + 业务层 switch case 兜底
//   4. 共享层文件：渲染层 / 主层均可 import，不引入 src/ 运行时代码

import { z } from 'zod';

function warnInvalidPayload(message: string, details?: unknown): void {
  // 共享模块会进入 renderer bundle，不能依赖 Node-only 的 Winston。
  console.warn(message, details);
}

// ============================================================
// ChatStreamPayload 校验
// ============================================================

/** ChatStreamPayload 顶层 schema（宽松校验 type 字段，passthrough 保留其余） */
const ChatStreamPayloadSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

/** fail-open fallback：未知事件类型 */
const STREAM_FALLBACK = { type: 'unknown', chunk: '' } as const;

/**
 * 校验 ChatStreamPayload
 *
 * fail-open 策略：校验失败时返回 fallback 对象（type='unknown'），
 * 让 handleStream 的 switch case 静默忽略
 */
export function parseChatStreamPayload(raw: unknown) {
  try {
    return ChatStreamPayloadSchema.parse(raw);
  } catch (err) {
    warnInvalidPayload('[ipc-schema] ChatStreamPayload 校验失败，使用 fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return STREAM_FALLBACK;
  }
}

// ============================================================
// ToolConfirmPayload 校验
// ============================================================

/** 工具确认请求 payload schema */
const ToolConfirmRequestSchema = z
  .object({
    requestId: z.string(),
    toolName: z.string(),
    params: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();

/** fail-open fallback：空确认请求 */
const TOOL_CONFIRM_FALLBACK = {
  requestId: '',
  toolName: 'unknown',
  params: {},
} as const;

/**
 * 校验工具确认请求 payload
 *
 * fail-open 策略：校验失败时返回 fallback（requestId 为空字符串），
 * _setPendingConfirm 会写入空 requestId，用户无法 confirm 但不崩溃
 */
export function parseToolConfirmRequest(raw: unknown) {
  try {
    return ToolConfirmRequestSchema.parse(raw);
  } catch (err) {
    warnInvalidPayload('[ipc-schema] ToolConfirmRequest 校验失败，使用 fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return TOOL_CONFIRM_FALLBACK;
  }
}

// ============================================================
// 通用对象校验（TokenProfileSnapshot / TraceSpan / GoalEvent / PlanEditRequest / AppConfig）
// ============================================================

/**
 * 通用 fail-open 对象校验
 *
 * 这类 payload 结构复杂且频繁演进（TraceSpan / GoalEvent 等），严格 schema 维护成本高。
 * 实际业务层（store._addTokenSnapshot / _addTraceEvent / _handleGoalEvent 等）已对字段
 * 缺失做容错处理。此处仅校验是对象，防止 null/undefined/string 等非对象类型导致
 * store 抛 TypeError。
 *
 * @param raw 原始数据
 * @param fallback 校验失败时的默认值
 * @param caller 调用方标识（日志定位用）
 */
export function parseObjectPayload<T extends object>(
  raw: unknown,
  fallback: T,
  caller?: string,
): T {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as T;
  }
  warnInvalidPayload('[ipc-schema] payload 非对象类型，使用 fallback', {
    caller: caller ?? 'parseObjectPayload',
    actualType: Array.isArray(raw) ? 'array' : typeof raw,
  });
  return fallback;
}
