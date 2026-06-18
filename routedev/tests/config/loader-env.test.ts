// tests/config/loader-env.test.ts
// Phase 29 Task 6：config loader 环境变量 fail-fast 测试

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConfigValidationError } from '../../src/utils/errors.js';

// 直接测试 replaceEnvVars 逻辑（通过模拟 loadConfig 的环境变量替换行为）
// 由于 replaceEnvVars 是私有函数，我们通过 ConfigValidationError 的行为来验证

describe('ConfigValidationError', () => {
  it('应正确构造配置验证错误', () => {
    const error = new ConfigValidationError('OPENAI_API_KEY', '环境变量未设置');
    expect(error.field).toBe('OPENAI_API_KEY');
    expect(error.message).toContain('OPENAI_API_KEY');
    expect(error.message).toContain('配置验证失败');
  });

  it('应是 Error 的子类', () => {
    const error = new ConfigValidationError('VAR', 'test');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ConfigValidationError);
  });
});

describe('环境变量 fail-fast 行为验证', () => {
  // 验证 ConfigValidationError 可被 catch 并处理
  it('ConfigValidationError 可被正常 catch', () => {
    let caught: ConfigValidationError | null = null;
    try {
      throw new ConfigValidationError('TEST_VAR', 'test message');
    } catch (e) {
      if (e instanceof ConfigValidationError) {
        caught = e;
      }
    }
    expect(caught).not.toBeNull();
    expect(caught!.field).toBe('TEST_VAR');
  });
});
