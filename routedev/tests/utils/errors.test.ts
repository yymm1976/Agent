// tests/utils/errors.test.ts
// Phase 26 Task 7：自定义错误类体系测试
// TD-22：toErrorMessage 工具函数测试

import { describe, it, expect } from 'vitest';
import {
  RouteDevError,
  ConfigValidationError,
  toErrorMessage,
} from '../../src/utils/errors.js';

describe('自定义错误类体系', () => {
  it('RouteDevError 应携带 code 字段', () => {
    const err = new RouteDevError('test message', 'TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.name).toBe('RouteDevError');
    expect(err instanceof Error).toBe(true);
  });

  it('ConfigValidationError 应携带 field', () => {
    const err = new ConfigValidationError('budget.dailyLimit', 'must be positive');
    expect(err.field).toBe('budget.dailyLimit');
    expect(err.code).toBe('CONFIG_VALIDATION_ERROR');
    expect(err instanceof RouteDevError).toBe(true);
  });

  it('instanceof 应正确识别子类', () => {
    const err = new ConfigValidationError('shell_exec', 'timeout');
    expect(err instanceof ConfigValidationError).toBe(true);
    expect(err instanceof RouteDevError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe('toErrorMessage（TD-22）', () => {
  it('Error 对象提取 message', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('RouteDevError 提取 message', () => {
    expect(toErrorMessage(new RouteDevError('custom', 'CODE'))).toBe('custom');
  });

  it('字符串直接返回', () => {
    expect(toErrorMessage('string error')).toBe('string error');
  });

  it('null/undefined 返回字符串形式', () => {
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });

  it('普通对象尝试 message 属性', () => {
    expect(toErrorMessage({ message: 'obj msg' })).toBe('obj msg');
  });

  it('无 message 属性的对象 JSON 序列化', () => {
    expect(toErrorMessage({ code: 500 })).toBe('{"code":500}');
  });

  it('数字转字符串', () => {
    expect(toErrorMessage(42)).toBe('42');
  });
});
