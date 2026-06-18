// tests/cli/commands/work-modes.test.ts
// /build /plan /compose 命令测试（Phase 20 Task 2）

import { describe, it, expect, vi } from 'vitest';
import { buildCommand, planCommand, composeCommand } from '../../../src/cli/commands/work-modes.js';
import type { ServiceContext } from '../../../src/cli/service-context.js';

function buildMockCtx(): ServiceContext {
  return {
    commandBridge: {
      setWorkMode: vi.fn(),
    } as any,
  } as ServiceContext;
}

describe('工作模式命令', () => {
  it('/build 命令调用 setWorkMode("build") 并返回确认信息', async () => {
    const ctx = buildMockCtx();
    const result = await buildCommand.handler('', ctx);
    expect(result.type).toBe('handled');
    expect(ctx.commandBridge.setWorkMode).toHaveBeenCalledWith('build');
    expect(result.messages![0]).toContain('Build');
  });

  it('/plan 命令调用 setWorkMode("plan") 并返回确认信息', async () => {
    const ctx = buildMockCtx();
    const result = await planCommand.handler('', ctx);
    expect(result.type).toBe('handled');
    expect(ctx.commandBridge.setWorkMode).toHaveBeenCalledWith('plan');
    expect(result.messages![0]).toContain('Plan');
  });

  it('/compose 命令调用 setWorkMode("compose") 并返回确认信息', async () => {
    const ctx = buildMockCtx();
    const result = await composeCommand.handler('', ctx);
    expect(result.type).toBe('handled');
    expect(ctx.commandBridge.setWorkMode).toHaveBeenCalledWith('compose');
    expect(result.messages![0]).toContain('Compose');
  });
});
