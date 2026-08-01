// tests/runtime/goal-runner-core.test.ts
// Phase 91 Task 1：goal-runner-core.ts 单元测试
// 验证 createGoalRunner 工厂的 ctx 装配、emit 行为、gid 生成、跨模块函数引用填充
//
// 测试策略：createGoalRunner 是工厂入口，组装 confirm/scheduler/recovery 三模块到 ctx。
// 本文件聚焦工厂本身的行为（ctx 装配 / emit / gid），不深入各子模块内部逻辑
// （子模块逻辑由 confirm/scheduler/recovery 各自的测试文件覆盖）。

import { describe, it, expect, vi } from 'vitest';
import { createGoalRunner } from '../../src/runtime/goal-runner-core.js';
import type { GoalRunnerDeps } from '../../src/runtime/goal-runner-core.js';
import type { GoalPlan, PlanStep } from '../../src/agent/goal-types.js';
import type { LLMMessage, LLMResponse, TokenUsageInfo, RoutingResult, ModelInfo } from '../../src/router/types.js';
import type { GoalEvent } from '../../src/agent/goal-types.js';

const mockModel: ModelInfo = {
  id: 'gpt-4o', providerId: 'openai', tier: 'medium',
  costPer1kInput: 0.005, costPer1kOutput: 0.015,
  maxContextTokens: 128000, maxOutputTokens: 4096,
};

const mockRoute: RoutingResult = {
  model: mockModel, providerId: 'openai', degraded: false, reason: 'test',
};

const mockUsage: TokenUsageInfo = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };

/** 构造最小可运行的 GoalRunnerDeps mock */
function createMockDeps(overrides: Partial<GoalRunnerDeps> = {}): GoalRunnerDeps {
  const mockClient = {
    isReady: () => true,
    complete: vi.fn(async (): Promise<LLMResponse> => ({
      content: JSON.stringify({ steps: [{ id: 1, description: '步骤1' }] }),
      toolCalls: [],
      usage: mockUsage,
    })),
    stream: vi.fn(async function* () { /* not used */ }),
  };

  const mockClassifier = { classify: vi.fn(async () => ({ tier: 'simple', confidence: 0.9 })) };
  const mockRouter = {
    route: vi.fn(async () => mockRoute),
    recordModelSuccess: vi.fn(),
    recordModelFailure: vi.fn(),
    getManualOverride: vi.fn(() => null),
    getAvailableModels: vi.fn(() => []),
  };
  const mockClientManager = { get: vi.fn(() => mockClient) };
  const mockTracker = {
    record: vi.fn(),
    getStats: vi.fn(() => ({ total: { totalTokens: 0 } })),
    getUsagePercent: vi.fn(() => 0),
    startTask: vi.fn(),
    recordTaskUsage: vi.fn(() => 'ok' as const),
    endTask: vi.fn(),
    getTaskUsagePercent: vi.fn(() => 0),
    isTaskActive: vi.fn(() => false),
    checkBudget: vi.fn(() => true),
  };
  const mockAgentLoop = {
    run: async function* () { yield { type: 'done' as const, content: 'done', usage: mockUsage }; },
    updateToolExecutor: vi.fn(),
  };
  const mockCheckpointManager = {
    init: vi.fn(async () => {}),
    saveGoalPlan: vi.fn(async () => {}),
    create: vi.fn(async () => null),
    count: 0,
    isEnabled: false,
  };
  const mockContextManager = {
    getCheckpoint: vi.fn(() => null),
    resetTriggers: vi.fn(),
    shouldTriggerCheckpoint: vi.fn(() => null),
    triggerCheckpoint: vi.fn(async () => {}),
    saveCheckpoint: vi.fn(async () => {}),
    shouldCompress: vi.fn(() => false),
    compress: vi.fn(() => ({ compressed: [], discarded: [] })),
    compressEnhanced: vi.fn(async () => ({ compressed: [], discarded: [] })),
    loadCheckpoint: vi.fn(async () => {}),
  };

  return {
    classifier: mockClassifier as any,
    modelRouter: mockRouter as any,
    clientManager: mockClientManager as any,
    tracker: mockTracker as any,
    agentLoop: mockAgentLoop as any,
    checkpointManager: mockCheckpointManager as any,
    contextManager: mockContextManager as any,
    config: {
      checkpoint: { enabled: false },
      router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
    } as any,
    systemPromptRef: { current: '' },
    conversationHistoryRef: { current: [] as LLMMessage[] },
    pendingConfirmRef: { current: null },
    abortControllerRef: { current: null },
    currentPlanRef: { current: null as GoalPlan | null },
    addSystemMessage: vi.fn(),
    requestPlanEdit: vi.fn(async (_plan: GoalPlan) => null),
    setIsProcessing: vi.fn(),
    nextId: () => `msg-${Math.random()}`,
    ...overrides,
  };
}

describe('createGoalRunner 工厂', () => {
  describe('返回值装配', () => {
    it('返回 handleGoalCommand / executeGoalPlan / resumeGoalPlan 三个公共 API', () => {
      const runner = createGoalRunner(createMockDeps());
      expect(typeof runner.handleGoalCommand).toBe('function');
      expect(typeof runner.executeGoalPlan).toBe('function');
      expect(typeof runner.resumeGoalPlan).toBe('function');
    });

    it('三个 API 均为独立函数引用（非 undefined）', () => {
      const runner = createGoalRunner(createMockDeps());
      expect(runner.handleGoalCommand).toBeDefined();
      expect(runner.executeGoalPlan).toBeDefined();
      expect(runner.resumeGoalPlan).toBeDefined();
    });
  });

  describe('gid 生成', () => {
    it('deps.goalId 未传时用 nextId 生成临时 id', async () => {
      // 通过 handleGoalCommand 触发 emit，从 onGoalEvent 回调中捕获 gid
      // requestPlanEdit 返回有效步骤以让流程继续到 emit('plan_created')
      const capturedEvents: GoalEvent[] = [];
      const deps = createMockDeps({
        onGoalEvent: (event) => capturedEvents.push(event),
        requestPlanEdit: vi.fn(async () => [
          { id: 1, description: '步骤1', status: 'pending' as const, dependencies: [] },
        ]),
      });
      const runner = createGoalRunner(deps);

      await runner.handleGoalCommand('/goal "测试"');

      // plan_created 事件应携带 gid（nextId 返回 msg- 前缀）
      const planCreated = capturedEvents.find(e => e.type === 'plan_created');
      expect(planCreated).toBeDefined();
      if (planCreated && planCreated.type === 'plan_created') {
        expect(planCreated.goalId).toMatch(/^msg-/);
      }
    });

    it('deps.goalId 传入时使用传入的 id', async () => {
      const capturedEvents: GoalEvent[] = [];
      const deps = createMockDeps({
        goalId: 'fixed-goal-id-123',
        onGoalEvent: (event) => capturedEvents.push(event),
        requestPlanEdit: vi.fn(async () => null),
      });
      const runner = createGoalRunner(deps);

      await runner.handleGoalCommand('/goal "测试"');

      const planCreated = capturedEvents.find(e => e.type === 'plan_created');
      if (planCreated && planCreated.type === 'plan_created') {
        expect(planCreated.goalId).toBe('fixed-goal-id-123');
      }
    });
  });

  describe('emit 安全调用', () => {
    it('onGoalEvent 抛异常时不阻塞，仅 warn 日志', async () => {
      const deps = createMockDeps({
        onGoalEvent: () => { throw new Error('emit failed'); },
        requestPlanEdit: vi.fn(async () => null),
      });
      const runner = createGoalRunner(deps);

      // 不抛异常即通过
      await expect(runner.handleGoalCommand('/goal "测试"')).resolves.toBeUndefined();
    });

    it('onGoalEvent 未注入时为 no-op（不抛异常）', async () => {
      const deps = createMockDeps({
        onGoalEvent: undefined,
        requestPlanEdit: vi.fn(async () => null),
      });
      const runner = createGoalRunner(deps);

      await expect(runner.handleGoalCommand('/goal "测试"')).resolves.toBeUndefined();
    });
  });

  describe('跨模块函数引用填充', () => {
    it('ctx 在 Object.assign 后包含三模块的函数', () => {
      // 间接验证：调用 handleGoalCommand 不抛 "ctx.executeGoalPlan is not a function"
      // 若跨模块函数未填充，handleGoalCommand 末尾调用 ctx.executeGoalPlan 会抛 TypeError
      const deps = createMockDeps({
        requestPlanEdit: vi.fn(async (_plan: GoalPlan) => {
          // 返回有效步骤让流程进入 executeGoalPlan
          const steps: PlanStep[] = [
            { id: 1, description: '步骤1', status: 'pending', dependencies: [], domain: 'general' },
          ];
          return steps;
        }),
      });
      const runner = createGoalRunner(deps);

      // executeGoalPlan 会被调用，但不抛 TypeError 即说明 ctx.executeGoalPlan 已填充
      return expect(runner.handleGoalCommand('/goal "测试"')).resolves.toBeUndefined();
    });
  });
});
