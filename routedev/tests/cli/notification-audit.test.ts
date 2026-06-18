// tests/cli/notification-audit.test.ts
// 通知持久化到审计日志测试（Phase 27 Task 7）
// 测试 critical/important 级别通知写入审计日志，normal/subtle 不写入

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  notify,
  setAuditLogger,
  formatNotification,
  BELL_CHAR,
} from '../../src/cli/notification.js';
import { AuditLogger } from '../../src/harness/audit-logger.js';
import type { NotificationLevel } from '../../src/cli/notification.js';

// ============================================================
// Mock AuditLogger：捕获 log 调用便于断言
// ============================================================

function createMockAuditLogger(): { logger: AuditLogger; logSpy: ReturnType<typeof vi.fn> } {
  const logSpy = vi.fn();
  const logger = {
    log: logSpy,
  } as unknown as AuditLogger;
  return { logger, logSpy };
}

// ============================================================
// 测试用例
// ============================================================

describe('notification 审计日志: critical/important 写入', () => {
  beforeEach(() => {
    // 每个测试前清除模块级 AuditLogger
    setAuditLogger(null);
  });

  it('critical 级别通知写入审计日志', () => {
    const { logger, logSpy } = createMockAuditLogger();
    setAuditLogger(logger);

    notify({ level: 'critical', message: '致命错误：服务不可用' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [action, target, details] = logSpy.mock.calls[0];
    expect(action).toBe('notification');
    expect(target).toBe('致命错误：服务不可用');
    expect(details.type).toBe('notification');
    expect(details.level).toBe('critical');
    expect(details.message).toBe('致命错误：服务不可用');
    expect(typeof details.timestamp).toBe('number');
  });

  it('important 级别通知写入审计日志', () => {
    const { logger, logSpy } = createMockAuditLogger();
    setAuditLogger(logger);

    notify({ level: 'important', message: '配置变更警告' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [action, , details] = logSpy.mock.calls[0];
    expect(action).toBe('notification');
    expect(details.level).toBe('important');
  });
});

describe('notification 审计日志: normal/subtle 不写入', () => {
  beforeEach(() => {
    setAuditLogger(null);
  });

  it('normal 级别通知不写入审计日志', () => {
    const { logger, logSpy } = createMockAuditLogger();
    setAuditLogger(logger);

    notify({ level: 'normal', message: '路由决策完成' });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('subtle 级别通知不写入审计日志', () => {
    const { logger, logSpy } = createMockAuditLogger();
    setAuditLogger(logger);

    notify({ level: 'subtle', message: '调试信息' });

    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('notification 审计日志: 未注入 AuditLogger', () => {
  beforeEach(() => {
    setAuditLogger(null);
  });

  it('未注入 AuditLogger 时不报错，通知正常返回', () => {
    // 不调用 setAuditLogger，auditLogger 为 null
    const text = notify({ level: 'critical', message: '测试错误' });
    // 通知字符串仍正常生成
    expect(text).toContain('测试错误');
    expect(text.startsWith(BELL_CHAR)).toBe(true);
  });

  it('清除 AuditLogger 后不再写入', () => {
    const { logger, logSpy } = createMockAuditLogger();
    setAuditLogger(logger);

    notify({ level: 'critical', message: '第一次' });
    expect(logSpy).toHaveBeenCalledTimes(1);

    // 清除后不再写入
    setAuditLogger(null);
    notify({ level: 'critical', message: '第二次' });
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

describe('notification 审计日志: 日志格式', () => {
  beforeEach(() => {
    setAuditLogger(null);
  });

  it('日志 details 包含 type/level/message/timestamp 四个字段', () => {
    const { logger, logSpy } = createMockAuditLogger();
    setAuditLogger(logger);

    notify({ level: 'important', message: '格式验证' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const details = logSpy.mock.calls[0][2];
    expect(Object.keys(details).sort()).toEqual(['level', 'message', 'timestamp', 'type']);
    expect(details.type).toBe('notification');
  });

  it('timestamp 为数字类型（毫秒时间戳）', () => {
    const { logger, logSpy } = createMockAuditLogger();
    setAuditLogger(logger);

    const before = Date.now();
    notify({ level: 'critical', message: '时间戳测试' });
    const after = Date.now();

    const details = logSpy.mock.calls[0][2];
    expect(typeof details.timestamp).toBe('number');
    expect(details.timestamp).toBeGreaterThanOrEqual(before);
    expect(details.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('notification 审计日志: 所有级别覆盖', () => {
  beforeEach(() => {
    setAuditLogger(null);
  });

  it('四个级别中只有 critical 和 important 写入审计日志', () => {
    const { logger, logSpy } = createMockAuditLogger();
    setAuditLogger(logger);

    const levels: NotificationLevel[] = ['critical', 'important', 'normal', 'subtle'];
    for (const level of levels) {
      notify({ level, message: `测试-${level}` });
    }

    expect(logSpy).toHaveBeenCalledTimes(2);
    // 第一次调用是 critical
    expect(logSpy.mock.calls[0][2].level).toBe('critical');
    // 第二次调用是 important
    expect(logSpy.mock.calls[1][2].level).toBe('important');
  });
});
