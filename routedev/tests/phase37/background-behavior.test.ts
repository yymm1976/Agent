// tests/phase37/background-behavior.test.ts
// Phase 37 Task 2：后台行为配置测试
// 覆盖：BackgroundBehaviorConfigSchema 的默认值、组合校验

import { describe, it, expect } from 'vitest';
import {
  BackgroundBehaviorConfigSchema,
  SchedulerConfigSchema,
} from '../../src/config/schema.js';

describe('Phase 37 Task 2：后台行为配置', () => {
  // ============================================================
  // BackgroundBehaviorConfigSchema
  // ============================================================
  it('1. 配置解析：默认值为 ask/prompt', () => {
    const result = BackgroundBehaviorConfigSchema.parse({});
    expect(result.backgroundBehavior).toBe('ask');
    expect(result.activeTaskOnClose).toBe('prompt');
  });

  it('2. 配置解析：exit/terminate 组合合法', () => {
    const result = BackgroundBehaviorConfigSchema.parse({
      backgroundBehavior: 'exit',
      activeTaskOnClose: 'terminate',
    });
    expect(result.backgroundBehavior).toBe('exit');
    expect(result.activeTaskOnClose).toBe('terminate');
  });

  it('3. 配置校验：exit + continue-in-background 组合应失败', () => {
    const result = BackgroundBehaviorConfigSchema.safeParse({
      backgroundBehavior: 'exit',
      activeTaskOnClose: 'continue-in-background',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // 错误信息应包含组合校验的提示
      const message = result.error.issues.map((i) => i.message).join('; ');
      expect(message).toContain('terminate');
    }
  });

  it('4. 配置校验：minimize-to-tray + continue-in-background 合法', () => {
    const result = BackgroundBehaviorConfigSchema.safeParse({
      backgroundBehavior: 'minimize-to-tray',
      activeTaskOnClose: 'continue-in-background',
    });
    expect(result.success).toBe(true);
  });

  it('5. 配置校验：ask + prompt 合法', () => {
    const result = BackgroundBehaviorConfigSchema.safeParse({
      backgroundBehavior: 'ask',
      activeTaskOnClose: 'prompt',
    });
    expect(result.success).toBe(true);
  });

  it('exit + prompt 组合也应失败（exit 只允许 terminate）', () => {
    const result = BackgroundBehaviorConfigSchema.safeParse({
      backgroundBehavior: 'exit',
      activeTaskOnClose: 'prompt',
    });
    expect(result.success).toBe(false);
  });

  // ============================================================
  // SchedulerConfigSchema（附加测试）
  // ============================================================
  it('SchedulerConfigSchema 默认值正确', () => {
    const result = SchedulerConfigSchema.parse({});
    expect(result.enabled).toBe(true);
    expect(result.maxTasks).toBe(20);
    expect(result.defaultTimezone).toBe('Asia/Shanghai');
  });

  it('SchedulerConfigSchema maxTasks 超出范围应失败', () => {
    const tooMany = SchedulerConfigSchema.safeParse({ maxTasks: 101 });
    expect(tooMany.success).toBe(false);

    const tooFew = SchedulerConfigSchema.safeParse({ maxTasks: 0 });
    expect(tooFew.success).toBe(false);
  });
});
