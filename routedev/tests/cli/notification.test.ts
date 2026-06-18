// tests/cli/notification.test.ts
// 统一通知系统测试（Phase 25 Task 7）

import { describe, it, expect } from 'vitest';
import { formatNotification, notify, notifyRoutingFallback, BELL_CHAR } from '../../src/cli/notification.js';
import type { RoutingResult } from '../../src/router/types.js';

describe('notification: formatNotification', () => {
  it('critical 级别带前缀', () => {
    expect(formatNotification({ level: 'critical', message: '权限拒绝' })).toContain('权限拒绝');
  });

  it('important 级别带警告前缀', () => {
    expect(formatNotification({ level: 'important', message: '模型降级' })).toContain('模型降级');
  });

  it('normal 级别带信息前缀', () => {
    expect(formatNotification({ level: 'normal', message: '路由决策' })).toContain('路由决策');
  });

  it('subtle 级别带 subtle 前缀', () => {
    expect(formatNotification({ level: 'subtle', message: '调试信息' })).toContain('调试信息');
  });
});

describe('notification: notify', () => {
  it('critical 默认触发 bell', () => {
    const text = notify({ level: 'critical', message: '致命错误' });
    expect(text.startsWith(BELL_CHAR)).toBe(true);
  });

  it('important 默认不触发 bell', () => {
    const text = notify({ level: 'important', message: '配置变更' });
    expect(text.startsWith(BELL_CHAR)).toBe(false);
  });

  it('可显式开启 bell', () => {
    const text = notify({ level: 'important', message: '注意', bell: true });
    expect(text.startsWith(BELL_CHAR)).toBe(true);
  });

  it('可显式关闭 bell', () => {
    const text = notify({ level: 'critical', message: '静默错误', bell: false });
    expect(text.startsWith(BELL_CHAR)).toBe(false);
  });
});

describe('notification: notifyRoutingFallback', () => {
  it('正常路由不返回通知', () => {
    const route = { model: { id: 'gpt-4o' }, providerId: 'openai', fallbackUsed: false, originalTier: 'complex', degraded: false } as unknown as RoutingResult;
    expect(notifyRoutingFallback(route)).toBeNull();
  });

  it('fallback 模型返回警告', () => {
    const route = { model: { id: 'gpt-4o-mini' }, providerId: 'openai', fallbackUsed: true, originalTier: 'complex', degraded: true } as unknown as RoutingResult;
    const text = notifyRoutingFallback(route);
    expect(text).not.toBeNull();
    expect(text).toContain('回退');
  });

  it('降级返回警告并包含原因', () => {
    const route = {
      model: { id: 'gpt-4o-mini' },
      providerId: 'openai',
      fallbackUsed: false,
      originalTier: 'complex',
      degraded: true,
      degradationReason: '预算超限',
    } as unknown as RoutingResult;
    const text = notifyRoutingFallback(route);
    expect(text).not.toBeNull();
    expect(text).toContain('降级');
    expect(text).toContain('预算超限');
  });
});
