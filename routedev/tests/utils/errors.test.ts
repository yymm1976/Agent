// tests/utils/errors.test.ts
// Phase 26 Task 7：自定义错误类体系测试
// Phase 51 Task 9：双受众错误模型（message + details + dev 三层结构）测试

import { describe, it, expect } from 'vitest';
import {
  RouteDevError,
  ToolExecutionError,
  PermissionDeniedError,
  ConfigValidationError,
  SecurityViolationError,
  LLMError,
  isRouteDevError,
  formatErrorForUser,
  formatErrorForDev,
} from '../../src/utils/errors.js';

describe('自定义错误类体系', () => {
  it('RouteDevError 应携带 code 字段', () => {
    const err = new RouteDevError('test message', 'TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.name).toBe('RouteDevError');
    expect(err instanceof Error).toBe(true);
  });

  it('ToolExecutionError 应携带 toolName', () => {
    const err = new ToolExecutionError('file_write', 'disk full');
    expect(err.toolName).toBe('file_write');
    expect(err.code).toBe('TOOL_EXECUTION_ERROR');
    expect(err.message).toContain('file_write');
    expect(err instanceof RouteDevError).toBe(true);
  });

  it('PermissionDeniedError 应携带 rule', () => {
    const err = new PermissionDeniedError('deny-rm-rf-root', 'rm -rf /');
    expect(err.rule).toBe('deny-rm-rf-root');
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err instanceof RouteDevError).toBe(true);
  });

  it('ConfigValidationError 应携带 field', () => {
    const err = new ConfigValidationError('budget.dailyLimit', 'must be positive');
    expect(err.field).toBe('budget.dailyLimit');
    expect(err.code).toBe('CONFIG_VALIDATION_ERROR');
    expect(err instanceof RouteDevError).toBe(true);
  });

  it('SecurityViolationError 应有正确 code', () => {
    const err = new SecurityViolationError('path traversal detected');
    expect(err.code).toBe('SECURITY_VIOLATION');
    expect(err.message).toContain('path traversal');
    expect(err instanceof RouteDevError).toBe(true);
  });

  it('LLMError 应携带 provider 和 statusCode', () => {
    const err = new LLMError('rate limited', 'openai', 429);
    expect(err.provider).toBe('openai');
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('LLM_ERROR');
    expect(err instanceof RouteDevError).toBe(true);
  });

  it('isRouteDevError 类型守卫应正确识别', () => {
    expect(isRouteDevError(new ToolExecutionError('x', 'y'))).toBe(true);
    expect(isRouteDevError(new Error('plain'))).toBe(false);
    expect(isRouteDevError('string error')).toBe(false);
    expect(isRouteDevError(null)).toBe(false);
  });

  it('instanceof 应正确识别子类', () => {
    const err = new ToolExecutionError('shell_exec', 'timeout');
    expect(err instanceof ToolExecutionError).toBe(true);
    expect(err instanceof RouteDevError).toBe(true);
    expect(err instanceof Error).toBe(true);
    // 不应误判为其他子类
    expect(err instanceof PermissionDeniedError).toBe(false);
  });
});

// ============================================================
// Phase 51 Task 9：双受众错误模型（message + details + dev 三层结构）
// ============================================================
describe('Phase 51 Task 9: 双受众错误模型', () => {
  it('RouteDevError.toUserMessage 不含 dev 信息', () => {
    const err = new RouteDevError('工具执行失败', 'TOOL_ERROR', {
      details: '用户可见的细节说明',
      dev: '包含 /src/path/secret.ts 的内部细节',
    });
    const userMsg = err.toUserMessage();
    // 应包含 message 和 details
    expect(userMsg).toContain('工具执行失败');
    expect(userMsg).toContain('用户可见的细节说明');
    // 不应包含 dev 信息
    expect(userMsg).not.toContain('/src/path/secret.ts');
    expect(userMsg).not.toContain('[Dev]');
  });

  it('RouteDevError.toDevMessage 含 dev 信息', () => {
    const err = new RouteDevError('工具执行失败', 'TOOL_ERROR', {
      details: '用户可见细节',
      dev: '开发者向信息：源码路径 /var/secret.ts',
    });
    const devMsg = err.toDevMessage();
    // 应包含 dev 信息
    expect(devMsg).toContain('[Dev]');
    expect(devMsg).toContain('开发者向信息：源码路径 /var/secret.ts');
    // 也应包含用户可见部分
    expect(devMsg).toContain('工具执行失败');
  });

  it('RouteDevError.details 可选字段——未传时 toUserMessage 仅返回 message', () => {
    const err = new RouteDevError('plain message', 'CODE');
    expect(err.details).toBeUndefined();
    expect(err.dev).toBeUndefined();
    expect(err.toUserMessage()).toBe('plain message');
    expect(err.toDevMessage()).toBe('plain message'); // 无 dev，不附加
  });

  it('ToolExecutionError 构造器接收 details/dev/cause', () => {
    const cause = new Error('原始错误');
    const err = new ToolExecutionError('file_write', '写入失败', {
      details: '磁盘已满',
      dev: 'fsync 返回 ENOSPC',
      cause,
    });
    expect(err.toolName).toBe('file_write');
    expect(err.code).toBe('TOOL_EXECUTION_ERROR');
    expect(err.details).toBe('磁盘已满');
    expect(err.dev).toBe('fsync 返回 ENOSPC');
    expect(err.cause).toBe(cause);
    // message 应自动拼接 toolName
    expect(err.message).toContain('file_write');
    expect(err.message).toContain('写入失败');
  });

  it('formatErrorForUser: RouteDevError 返回 toUserMessage（不含 dev）', () => {
    const err = new ToolExecutionError('shell_exec', '命令失败', {
      details: '退出码 127',
      dev: '命令 not found，请检查 PATH',
    });
    const userMsg = formatErrorForUser(err);
    expect(userMsg).toContain('命令失败');
    expect(userMsg).toContain('退出码 127');
    // 严禁泄露 dev 信息
    expect(userMsg).not.toContain('not found');
    expect(userMsg).not.toContain('[Dev]');
  });

  it('formatErrorForUser: 普通 Error 返回 message', () => {
    const err = new Error('普通错误');
    expect(formatErrorForUser(err)).toBe('普通错误');
  });

  it('formatErrorForUser: 非错误值返回 String(value)', () => {
    expect(formatErrorForUser('字符串错误')).toBe('字符串错误');
    expect(formatErrorForUser(42)).toBe('42');
    expect(formatErrorForUser(null)).toBe('null');
  });

  it('formatErrorForDev: RouteDevError 返回 toDevMessage（含 dev）', () => {
    const err = new ToolExecutionError('shell_exec', '命令失败', {
      details: '退出码 127',
      dev: 'PATH 中缺少 /usr/local/bin',
    });
    const devMsg = formatErrorForDev(err);
    expect(devMsg).toContain('退出码 127');
    expect(devMsg).toContain('[Dev]');
    expect(devMsg).toContain('PATH 中缺少 /usr/local/bin');
  });

  it('formatErrorForDev: 普通 Error 返回 message + 堆栈（若有）', () => {
    const err = new Error('普通错误');
    const devMsg = formatErrorForDev(err);
    expect(devMsg).toContain('普通错误');
    // 至少包含 message；堆栈可能存在
    expect(typeof devMsg).toBe('string');
  });

  it('formatErrorForDev: 非错误值返回 String(value)', () => {
    expect(formatErrorForDev('字符串错误')).toBe('字符串错误');
    expect(formatErrorForDev(42)).toBe('42');
  });
});
