// tests/cli/service-context.test.ts
// createServiceContext 单元测试（Phase 0c Task 3）
// 验证 ServiceContext 装配入口的完整性

import { describe, it, expect, vi } from 'vitest';
import { createServiceContext, type ServiceContextDeps } from '../../src/cli/service-context.js';
import type { ServiceContext } from '../../src/cli/service-context.js';

// 创建最小化的 mock deps，所有字段用 stub
function createMockDeps(overrides?: Partial<ServiceContextDeps>): ServiceContextDeps {
  const trace = {
    getSessionId: vi.fn(() => 'test-session-123'),
  } as unknown as ServiceContextDeps['trace'];

  const base: ServiceContextDeps = {
    config: { version: 1 } as ServiceContextDeps['config'],
    clientManager: {} as ServiceContextDeps['clientManager'],
    router: {} as ServiceContextDeps['router'],
    tracker: {} as ServiceContextDeps['tracker'],
    agentLoop: { updateToolExecutor: vi.fn() } as unknown as ServiceContextDeps['agentLoop'],
    checkpointWriter: {} as ServiceContextDeps['checkpointWriter'],
    contextManager: {} as ServiceContextDeps['contextManager'],
    branchManager: {} as ServiceContextDeps['branchManager'],
    vision: {} as ServiceContextDeps['vision'],
    initAnalyzer: {} as ServiceContextDeps['initAnalyzer'],
    dream: {} as ServiceContextDeps['dream'],
    goalParser: {} as ServiceContextDeps['goalParser'],
    goalVerifier: {} as ServiceContextDeps['goalVerifier'],
    blackboard: {} as ServiceContextDeps['blackboard'],
    orchestrator: {} as ServiceContextDeps['orchestrator'],
    workerExecutor: {} as ServiceContextDeps['workerExecutor'],
    trace,
    audit: {} as ServiceContextDeps['audit'],
    prompts: {} as ServiceContextDeps['prompts'],
    projectMemory: {} as ServiceContextDeps['projectMemory'],
    toolExecutor: {} as ServiceContextDeps['toolExecutor'],
    checkpointManager: {} as ServiceContextDeps['checkpointManager'],
    mcpManager: {} as ServiceContextDeps['mcpManager'],
    commandBridge: {} as ServiceContextDeps['commandBridge'],
    workModeController: {} as ServiceContextDeps['workModeController'],
    cwd: '/test/cwd',
  };
  return { ...base, ...overrides };
}

describe('Phase 0c Task 3: createServiceContext 装配入口', () => {
  it('返回完整的 ServiceContext 对象（所有必填字段非 undefined）', () => {
    const deps = createMockDeps();
    const ctx = createServiceContext(deps);

    // 验证所有必填字段
    expect(ctx.config).toBeDefined();
    expect(ctx.clientManager).toBeDefined();
    expect(ctx.router).toBeDefined();
    expect(ctx.tracker).toBeDefined();
    expect(ctx.agentLoop).toBeDefined();
    expect(ctx.checkpointWriter).toBeDefined();
    expect(ctx.checkpointManager).toBeDefined();
    expect(ctx.contextManager).toBeDefined();
    expect(ctx.branchManager).toBeDefined();
    expect(ctx.vision).toBeDefined();
    expect(ctx.initAnalyzer).toBeDefined();
    expect(ctx.dream).toBeDefined();
    expect(ctx.goalParser).toBeDefined();
    expect(ctx.goalVerifier).toBeDefined();
    expect(ctx.blackboard).toBeDefined();
    expect(ctx.orchestrator).toBeDefined();
    expect(ctx.workerExecutor).toBeDefined();
    expect(ctx.trace).toBeDefined();
    expect(ctx.audit).toBeDefined();
    expect(ctx.prompts).toBeDefined();
    expect(ctx.projectMemory).toBeDefined();
    expect(ctx.toolExecutor).toBeDefined();
    expect(ctx.mcpManager).toBeDefined();
    expect(ctx.commandBridge).toBeDefined();
    expect(ctx.workModeController).toBeDefined();
    expect(ctx.sessionId).toBe('test-session-123');
    expect(ctx.cwd).toBe('/test/cwd');
  });

  it('sessionId 从 trace.getSessionId() 读取', () => {
    const deps = createMockDeps({
      trace: { getSessionId: vi.fn(() => 'custom-id') } as unknown as ServiceContextDeps['trace'],
    });
    const ctx = createServiceContext(deps);
    expect(ctx.sessionId).toBe('custom-id');
  });

  it('trace.getSessionId() 返回 null 时使用 fallback sessionId', () => {
    const deps = createMockDeps({
      trace: { getSessionId: vi.fn(() => null) } as unknown as ServiceContextDeps['trace'],
    });
    const ctx = createServiceContext(deps);
    // fallback 格式: cli-{timestamp}
    expect(ctx.sessionId).toMatch(/^cli-\d+$/);
  });

  it('未提供 pluginRegistry 时 ctx.pluginRegistry 为 undefined', () => {
    const deps = createMockDeps();
    const ctx = createServiceContext(deps);
    expect(ctx.pluginRegistry).toBeUndefined();
  });

  it('提供 pluginRegistry 时正确传递', () => {
    const mockRegistry = { id: 'mock-registry' } as unknown as ServiceContextDeps['pluginRegistry'];
    const deps = createMockDeps({ pluginRegistry: mockRegistry });
    const ctx = createServiceContext(deps);
    expect(ctx.pluginRegistry).toBe(mockRegistry);
  });

  it('未提供 setToolExecutor 时使用默认实现（更新 ctx.toolExecutor + agentLoop）', () => {
    const updateToolExecutor = vi.fn();
    const deps = createMockDeps({
      agentLoop: { updateToolExecutor } as unknown as ServiceContextDeps['agentLoop'],
    });
    const ctx = createServiceContext(deps);

    const newExecutor = { id: 'new-exec' } as unknown as ServiceContext['toolExecutor'];
    ctx.setToolExecutor(newExecutor);

    expect(updateToolExecutor).toHaveBeenCalledWith(newExecutor);
    expect(ctx.toolExecutor).toBe(newExecutor);
  });

  it('提供自定义 setToolExecutor 时使用自定义实现', () => {
    const customSetToolExecutor = vi.fn();
    const deps = createMockDeps({ setToolExecutor: customSetToolExecutor });
    const ctx = createServiceContext(deps);

    const newExecutor = { id: 'new-exec' } as unknown as ServiceContext['toolExecutor'];
    ctx.setToolExecutor(newExecutor);

    expect(customSetToolExecutor).toHaveBeenCalledWith(newExecutor);
  });

  it('deps 对象的所有字段正确映射到 ctx', () => {
    const mockConfig = { version: 42 } as ServiceContextDeps['config'];
    const mockRouter = { id: 'router-1' } as unknown as ServiceContextDeps['router'];
    const deps = createMockDeps({ config: mockConfig, router: mockRouter });
    const ctx = createServiceContext(deps);

    expect(ctx.config).toBe(mockConfig);
    expect(ctx.router).toBe(mockRouter);
  });
});
