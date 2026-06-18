// tests/utils/errors.test.ts
// Phase 26 Task 7：自定义错误类体系测试

import { describe, it, expect } from 'vitest';
import {
  RouteDevError,
  ToolExecutionError,
  PermissionDeniedError,
  ConfigValidationError,
  SecurityViolationError,
  LLMError,
  isRouteDevError,
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
