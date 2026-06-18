// tests/tools/adapter.test.ts
// ToolRegistryAdapter 单元测试

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistryAdapter } from '../../src/tools/adapter.js';
import { FileReadTool } from '../../src/tools/builtin/file-read.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

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
    const executor = new ToolExecutor(registry);
    const adapter = new ToolRegistryAdapter(registry, executor, context);

    const defs = adapter.getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('file_read');
  });

  it('should execute registered tools', async () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    const executor = new ToolExecutor(registry);
    const adapter = new ToolRegistryAdapter(registry, executor, context);

    const result = await adapter.executeTool('file_read', 'call-1', {
      path: 'package.json',
    });

    expect(result).toContain('routedev');
  });

  it('should return error for unregistered tools', async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    const adapter = new ToolRegistryAdapter(registry, executor, context);

    const result = await adapter.executeTool('nonexistent', 'call-1', {});

    expect(result).toContain('工具错误');
  });

  it('should check tool existence', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    const executor = new ToolExecutor(registry);
    const adapter = new ToolRegistryAdapter(registry, executor, context);

    expect(adapter.hasTool('file_read')).toBe(true);
    expect(adapter.hasTool('nonexistent')).toBe(false);
  });
});
