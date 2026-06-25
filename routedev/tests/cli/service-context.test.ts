// tests/cli/service-context.test.ts
// createServiceContext 单元测试（Phase 0c Task 3）
// 验证 ServiceContext 装配入口的完整性
// CommandBridge 接口契约测试：验证桥接方法签名与行为约定

import { describe, it, expect, vi } from 'vitest';
import { createServiceContext, type ServiceContextDeps, type CommandBridge } from '../../src/cli/service-context.js';
import type { ServiceContext } from '../../src/cli/service-context.js';
import type { GoalPlan, PlanStep } from '../../src/agent/goal-types.js';
import type { AutonomyMode, OutputStyle } from '../../src/config/schema.js';
import type { WorkMode } from '../../src/agent/work-modes.js';
import type { ScenarioTier } from '../../src/router/types.js';

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

// ============================================================
// CommandBridge 接口契约测试
// CommandBridge 是命令与 UI 之间的桥接接口，定义了命令影响 UI 的所有方法
// 这里通过构建符合接口的 mock 实现来验证契约（方法存在性、参数传递、返回类型）
// ============================================================

/** 创建一个完整的 mock CommandBridge 实现 */
function createMockCommandBridge(overrides?: Partial<CommandBridge>): CommandBridge {
  const bridge: CommandBridge = {
    addSystemMessage: vi.fn(),
    clearChat: vi.fn(),
    setAutonomyMode: vi.fn(),
    setWorkMode: vi.fn(),
    requestAbort: vi.fn(),
    requestConfirm: vi.fn().mockResolvedValue(true),
    requestPlanEdit: vi.fn().mockResolvedValue(null),
    exit: vi.fn(),
    startGoal: vi.fn(),
    getState: vi.fn().mockReturnValue({
      currentModel: 'test-model',
      currentTier: 'simple' as ScenarioTier,
      isDegraded: false,
      autonomyMode: 'semi' as AutonomyMode,
      conversationHistoryLength: 0,
      mcpConnectedCount: 0,
      mcpTotalToolCount: 0,
    }),
    setOutputStyle: vi.fn(),
  };
  return { ...bridge, ...overrides };
}

/** 创建一个 mock GoalPlan 用于 requestPlanEdit 测试 */
function createMockGoalPlan(): GoalPlan {
  return {
    id: 'plan-001',
    description: '测试目标',
    steps: [
      { id: 1, description: '步骤一', status: 'pending', dependencies: [] },
      { id: 2, description: '步骤二', status: 'pending', dependencies: [1] },
    ],
    status: 'pending',
    createdAt: Date.now(),
  };
}

describe('CommandBridge 接口契约', () => {
  it('包含所有必需的方法', () => {
    const bridge = createMockCommandBridge();
    // 验证所有接口方法都存在且为函数
    expect(typeof bridge.addSystemMessage).toBe('function');
    expect(typeof bridge.clearChat).toBe('function');
    expect(typeof bridge.setAutonomyMode).toBe('function');
    expect(typeof bridge.setWorkMode).toBe('function');
    expect(typeof bridge.requestAbort).toBe('function');
    expect(typeof bridge.requestConfirm).toBe('function');
    expect(typeof bridge.requestPlanEdit).toBe('function');
    expect(typeof bridge.exit).toBe('function');
    expect(typeof bridge.startGoal).toBe('function');
    expect(typeof bridge.getState).toBe('function');
    expect(typeof bridge.setOutputStyle).toBe('function');
  });

  describe('addSystemMessage', () => {
    it('调用并传递 content 参数', () => {
      const bridge = createMockCommandBridge();
      bridge.addSystemMessage('系统通知');
      expect(bridge.addSystemMessage).toHaveBeenCalledWith('系统通知');
    });

    it('空字符串也能正常传递', () => {
      const bridge = createMockCommandBridge();
      bridge.addSystemMessage('');
      expect(bridge.addSystemMessage).toHaveBeenCalledWith('');
    });
  });

  describe('clearChat', () => {
    it('调用无参数', () => {
      const bridge = createMockCommandBridge();
      bridge.clearChat();
      expect(bridge.clearChat).toHaveBeenCalledWith();
    });
  });

  describe('setAutonomyMode', () => {
    it.each(['auto', 'semi', 'manual'] as AutonomyMode[])('接受 autonomy mode: %s', (mode) => {
      const bridge = createMockCommandBridge();
      bridge.setAutonomyMode(mode);
      expect(bridge.setAutonomyMode).toHaveBeenCalledWith(mode);
    });
  });

  describe('setWorkMode', () => {
    it.each(['build', 'plan', 'compose'] as WorkMode[])('接受 work mode: %s', (mode) => {
      const bridge = createMockCommandBridge();
      bridge.setWorkMode(mode);
      expect(bridge.setWorkMode).toHaveBeenCalledWith(mode);
    });
  });

  describe('requestAbort', () => {
    it('调用无参数', () => {
      const bridge = createMockCommandBridge();
      bridge.requestAbort();
      expect(bridge.requestAbort).toHaveBeenCalledWith();
    });
  });

  describe('requestConfirm', () => {
    it('返回 Promise<boolean>', async () => {
      const bridge = createMockCommandBridge();
      const result = bridge.requestConfirm('确认执行？');
      expect(result).toBeInstanceOf(Promise);
      const value = await result;
      expect(typeof value).toBe('boolean');
    });

    it('用户确认时返回 true', async () => {
      const bridge = createMockCommandBridge({
        requestConfirm: vi.fn().mockResolvedValue(true),
      });
      const ok = await bridge.requestConfirm('是否继续？');
      expect(ok).toBe(true);
      expect(bridge.requestConfirm).toHaveBeenCalledWith('是否继续？');
    });

    it('用户拒绝时返回 false', async () => {
      const bridge = createMockCommandBridge({
        requestConfirm: vi.fn().mockResolvedValue(false),
      });
      const ok = await bridge.requestConfirm('是否删除文件？');
      expect(ok).toBe(false);
    });
  });

  describe('requestPlanEdit', () => {
    it('返回 Promise<PlanStep[] | null>', async () => {
      const bridge = createMockCommandBridge();
      const plan = createMockGoalPlan();
      const result = bridge.requestPlanEdit(plan);
      expect(result).toBeInstanceOf(Promise);
      await result; // 不抛错即类型正确
    });

    it('用户取消时返回 null', async () => {
      const bridge = createMockCommandBridge({
        requestPlanEdit: vi.fn().mockResolvedValue(null),
      });
      const plan = createMockGoalPlan();
      const edited = await bridge.requestPlanEdit(plan);
      expect(edited).toBeNull();
      expect(bridge.requestPlanEdit).toHaveBeenCalledWith(plan);
    });

    it('用户编辑后返回修改的步骤数组', async () => {
      const modifiedSteps: PlanStep[] = [
        { id: 1, description: '修改后的步骤一', status: 'pending', dependencies: [] },
        { id: 2, description: '修改后的步骤二', status: 'pending', dependencies: [1] },
      ];
      const bridge = createMockCommandBridge({
        requestPlanEdit: vi.fn().mockResolvedValue(modifiedSteps),
      });
      const plan = createMockGoalPlan();
      const edited = await bridge.requestPlanEdit(plan);
      expect(edited).not.toBeNull();
      expect(edited).toHaveLength(2);
      expect(edited![0].description).toBe('修改后的步骤一');
    });
  });

  describe('exit', () => {
    it('调用无参数', () => {
      const bridge = createMockCommandBridge();
      bridge.exit();
      expect(bridge.exit).toHaveBeenCalledWith();
    });
  });

  describe('startGoal', () => {
    it('调用并传递目标文本', () => {
      const bridge = createMockCommandBridge();
      bridge.startGoal('完成用户认证模块');
      expect(bridge.startGoal).toHaveBeenCalledWith('完成用户认证模块');
    });
  });

  describe('getState', () => {
    it('返回包含所有必需字段的状态快照', () => {
      const bridge = createMockCommandBridge();
      const state = bridge.getState();
      expect(state).toHaveProperty('currentModel');
      expect(state).toHaveProperty('currentTier');
      expect(state).toHaveProperty('isDegraded');
      expect(state).toHaveProperty('autonomyMode');
      expect(state).toHaveProperty('conversationHistoryLength');
      expect(state).toHaveProperty('mcpConnectedCount');
      expect(state).toHaveProperty('mcpTotalToolCount');
    });

    it('currentModel 为字符串', () => {
      const bridge = createMockCommandBridge();
      const state = bridge.getState();
      expect(typeof state.currentModel).toBe('string');
    });

    it('currentTier 为合法的 ScenarioTier', () => {
      const bridge = createMockCommandBridge();
      const state = bridge.getState();
      expect(['simple', 'medium', 'complex', 'reasoning']).toContain(state.currentTier);
    });

    it('isDegraded 为布尔值', () => {
      const bridge = createMockCommandBridge();
      const state = bridge.getState();
      expect(typeof state.isDegraded).toBe('boolean');
    });

    it('autonomyMode 为合法的 AutonomyMode', () => {
      const bridge = createMockCommandBridge();
      const state = bridge.getState();
      expect(['auto', 'semi', 'manual']).toContain(state.autonomyMode);
    });

    it('conversationHistoryLength 为非负数字', () => {
      const bridge = createMockCommandBridge();
      const state = bridge.getState();
      expect(typeof state.conversationHistoryLength).toBe('number');
      expect(state.conversationHistoryLength).toBeGreaterThanOrEqual(0);
    });

    it('mcpConnectedCount 和 mcpTotalToolCount 为非负数字', () => {
      const bridge = createMockCommandBridge();
      const state = bridge.getState();
      expect(typeof state.mcpConnectedCount).toBe('number');
      expect(state.mcpConnectedCount).toBeGreaterThanOrEqual(0);
      expect(typeof state.mcpTotalToolCount).toBe('number');
      expect(state.mcpTotalToolCount).toBeGreaterThanOrEqual(0);
    });

    it('反映降级状态', () => {
      const bridge = createMockCommandBridge({
        getState: vi.fn().mockReturnValue({
          currentModel: 'fallback-model',
          currentTier: 'medium' as ScenarioTier,
          isDegraded: true,
          autonomyMode: 'semi' as AutonomyMode,
          conversationHistoryLength: 5,
          mcpConnectedCount: 2,
          mcpTotalToolCount: 10,
        }),
      });
      const state = bridge.getState();
      expect(state.isDegraded).toBe(true);
      expect(state.currentModel).toBe('fallback-model');
    });
  });

  describe('setOutputStyle', () => {
    it.each(['minimal', 'standard', 'verbose'] as OutputStyle[])('接受 output style: %s', (style) => {
      const bridge = createMockCommandBridge();
      bridge.setOutputStyle(style);
      expect(bridge.setOutputStyle).toHaveBeenCalledWith(style);
    });
  });

  describe('作为 ServiceContext 的一部分', () => {
    it('能注入 createServiceContext 并被读取', () => {
      const bridge = createMockCommandBridge();
      const deps = createMockDeps({ commandBridge: bridge });
      const ctx = createServiceContext(deps);
      expect(ctx.commandBridge).toBe(bridge);
    });

    it('注入后调用方法能正确转发', () => {
      const bridge = createMockCommandBridge();
      const deps = createMockDeps({ commandBridge: bridge });
      const ctx = createServiceContext(deps);

      ctx.commandBridge.addSystemMessage('测试消息');
      ctx.commandBridge.clearChat();
      ctx.commandBridge.setAutonomyMode('auto');
      ctx.commandBridge.exit();

      expect(bridge.addSystemMessage).toHaveBeenCalledWith('测试消息');
      expect(bridge.clearChat).toHaveBeenCalled();
      expect(bridge.setAutonomyMode).toHaveBeenCalledWith('auto');
      expect(bridge.exit).toHaveBeenCalled();
    });
  });
});
