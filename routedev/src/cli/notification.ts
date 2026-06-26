// src/cli/notification.ts
// 统一通知系统（Phase 25 Task 7）
// 定义通知分级、样式与 bell 输出，供所有 UI 组件和命令使用

import type { RoutingResult } from '../router/types.js';

/** 通知级别 */
export type NotificationLevel = 'critical' | 'important' | 'normal' | 'subtle';

/** 通知选项 */
export interface NotificationOptions {
  /** 通知级别 */
  level: NotificationLevel;
  /** 通知内容 */
  message: string;
  /** 是否触发终端 bell（默认仅 critical） */
  bell?: boolean;
}

/** 通知前缀 */
const LEVEL_PREFIX: Record<NotificationLevel, string> = {
  critical: '❗',
  important: '⚠️',
  normal: 'ℹ️',
  subtle: '·',
};

/** 终端 bell 字符 */
export const BELL_CHAR = '\x07';

/**
 * 格式化通知消息
 * @param options 通知选项
 * @returns 带前缀的格式化字符串
 */
export function formatNotification(options: NotificationOptions): string {
  const prefix = LEVEL_PREFIX[options.level];
  return `${prefix} ${options.message}`;
}

/**
 * 生成带可选 bell 的通知字符串
 * @param options 通知选项
 * @returns 格式化后的通知字符串
 */
export function notify(options: NotificationOptions): string {
  const text = formatNotification(options);
  if (options.bell ?? options.level === 'critical') {
    return `${BELL_CHAR}${text}`;
  }
  return text;
}

/**
 * 根据路由决策生成降级/回退通知
 * 当模型降级或 fallback 被使用时返回警告字符串，否则返回 null
 */
export function notifyRoutingFallback(routeDecision: RoutingResult): string | null {
  // fallbackUsed 优先级高于 degraded：显式回退场景优先展示回退信息
  if (routeDecision.fallbackUsed) {
    return notify({
      level: 'important',
      message: `模型回退：首选模型不可用，已使用 fallback 模型 ${routeDecision.model.id}`,
      bell: false,
    });
  }
  if (routeDecision.degraded) {
    const reason = routeDecision.degradationReason ?? '未知原因';
    return notify({
      level: 'important',
      message: `模型降级：当前请求已降级到 ${routeDecision.model.id}。原因: ${reason}`,
      bell: false,
    });
  }
  return null;
}
