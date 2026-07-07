// tests/utils/errors.test.ts
// Phase 26 Task 7：自定义错误类体系测试

import { describe, it, expect } from 'vitest';
import {
  RouteDevError,
  ConfigValidationError,
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
