// tests/cli/commands/output-style.test.ts
// Phase 34 Task 1：/output-style 命令测试

import { describe, it, expect, vi } from 'vitest';
import { outputStyleCommand } from '../../../src/cli/commands/output-style.js';
import type { ServiceContext } from '../../../src/cli/service-context.js';
import type { AppConfig } from '../../../src/config/schema.js';

function createMockContext(outputStyle: AppConfig['ui']['outputStyle'] = 'standard'): ServiceContext {
  return {
    config: { ui: { outputStyle } } as AppConfig,
    commandBridge: {
      setOutputStyle: vi.fn(),
    },
  } as unknown as ServiceContext;
}

describe('/output-style 命令', () => {
  it('无参数时返回当前样式', async () => {
    const ctx = createMockContext('minimal');
    const result = await outputStyleCommand.handler('', ctx);
    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('minimal');
  });

  it('可切换到指定样式', async () => {
    const ctx = createMockContext('standard');
    const result = await outputStyleCommand.handler('verbose', ctx);
    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('standard → verbose');
    expect(ctx.commandBridge.setOutputStyle).toHaveBeenCalledWith('verbose');
  });

  it('支持 next 循环切换', async () => {
    const ctx = createMockContext('minimal');
    const result = await outputStyleCommand.handler('next', ctx);
    expect(result.messages![0]).toContain('minimal → standard');
    expect(ctx.commandBridge.setOutputStyle).toHaveBeenCalledWith('standard');
  });

  it('支持数字兼容输入', async () => {
    const ctx = createMockContext('standard');
    const result = await outputStyleCommand.handler('3', ctx);
    expect(ctx.commandBridge.setOutputStyle).toHaveBeenCalledWith('verbose');
    expect(result.messages![0]).toContain('standard → verbose');
  });

  it('拒绝非法样式并给出用法', async () => {
    const ctx = createMockContext('standard');
    const result = await outputStyleCommand.handler('invalid', ctx);
    expect(result.type).toBe('handled');
    expect(result.messages![0]).toContain('无效');
    expect(ctx.commandBridge.setOutputStyle).not.toHaveBeenCalled();
  });
});
