// tests/tools/adapter.test.ts
// ToolRegistryAdapter 单元测试

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistryAdapter } from '../../src/tools/adapter.js';
import { FileReadTool } from '../../src/tools/builtin/file-read.js';
import type { ToolExecutionContext, ISecurityChecker } from '../../src/tools/types.js';

// F-001 后 ToolExecutor 在 securityChecker 未注入时 fail-closed，
// 测试需注入 always-allow mock 才能走真实工具路径
const alwaysAllowChecker = {
  checkFilePath: () => ({ allowed: true, requiresConfirmation: false }),
  checkCommand: () => ({ allowed: true, requiresConfirmation: false }),
  checkNetworkRequest: async () => ({ allowed: true, requiresConfirmation: false }),
} as unknown as ISecurityChecker;

function makeExecutor(registry: ToolRegistry): ToolExecutor {
  const executor = new ToolExecutor(registry);
  executor.setSecurityChecker(alwaysAllowChecker);
  return executor;
}

describe('ToolRegistryAdapter', () => {
  const context: ToolExecutionContext = {
    workingDirectory: process.cwd(),
    allowedDirectories: [process.cwd()],
    environment: {},
    timeoutMs: 30000,
  };

  it('should return tool definitions from registry', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    const executor = makeExecutor(registry);
    const adapter = new ToolRegistryAdapter(registry, executor, context);

    const defs = adapter.getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('file_read');
  });

  it('should execute registered tools', async () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    const executor = makeExecutor(registry);
    const adapter = new ToolRegistryAdapter(registry, executor, context);

    const result = await adapter.executeTool('file_read', 'call-1', {
      path: 'package.json',
    });

    expect(result).toContain('routedev');
  });

  it('should return error for unregistered tools', async () => {
    const registry = new ToolRegistry();
    const executor = makeExecutor(registry);
    const adapter = new ToolRegistryAdapter(registry, executor, context);

    const result = await adapter.executeTool('nonexistent', 'call-1', {});

    expect(result).toContain('工具错误');
  });

  it('should check tool existence', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    const executor = makeExecutor(registry);
    const adapter = new ToolRegistryAdapter(registry, executor, context);

    expect(adapter.hasTool('file_read')).toBe(true);
    expect(adapter.hasTool('nonexistent')).toBe(false);
  });

  it('B-16: workspace 隔离——callOptions.workspace 覆盖工作目录与目录边界（审查 I2 修复）', async () => {
    // 用一个记录实际执行上下文的假工具验证合并行为
    let seenWorkingDirectory = '';
    let seenAllowed: string[] = [];
    const captureTool = {
      definition: {
        name: 'capture_cwd',
        description: 'capture',
        parameters: { type: 'object', properties: {}, required: [] as string[] },
      },
      validateArgs: () => ({ valid: true, errors: [] as string[] }),
      async execute(_args: Record<string, unknown>, ctx: ToolExecutionContext) {
        seenWorkingDirectory = ctx.workingDirectory;
        seenAllowed = [...ctx.allowedDirectories];
        return { success: true, output: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.register(captureTool as never);
    const executor = makeExecutor(registry);
    const adapter = new ToolRegistryAdapter(registry, executor, context);

    await adapter.executeTool('capture_cwd', 'call-1', {}, {
      workspace: { workingDirectory: 'C:/worktrees/exp-9', allowedDirectories: ['C:/worktrees/exp-9'] },
    });

    expect(seenWorkingDirectory).toBe('C:/worktrees/exp-9');
    expect(seenAllowed).toEqual(['C:/worktrees/exp-9']);
  });
});
