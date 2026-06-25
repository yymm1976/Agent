// tests/cli/goal-integration.test.ts
// /goal 集成测试（Phase 20 Task 5）
// 验证计划生成后通过 requestPlanEdit 渲染 StepEditor，用户确认/取消后的行为

import { describe, it, expect, vi } from 'vitest';
import { createGoalRunner } from '../../src/cli/goal-runner.js';
import type { GoalPlan, PlanStep } from '../../src/agent/goal-types.js';
import type { LLMMessage, LLMResponse, TokenUsageInfo, RoutingResult, ModelInfo } from '../../src/router/types.js';

const mockModel: ModelInfo = {
  id: 'gpt-4o', providerId: 'openai', tier: 'medium',
  costPer1kInput: 0.005, costPer1kOutput: 0.015,
  maxContextTokens: 128000, maxOutputTokens: 4096,
};

const mockRoute: RoutingResult = {
  model: mockModel, providerId: 'openai', degraded: false, reason: 'test',
};

const mockUsage: TokenUsageInfo = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };

function createMockDeps(requestPlanEditResult: PlanStep[] | null) {
  const messages: string[] = [];
  const addSystemMessage = vi.fn((content: string) => { messages.push(content); });
  const requestPlanEdit = vi.fn(async (_plan: GoalPlan) => requestPlanEditResult);
  const setIsProcessing = vi.fn();

  const mockClient = {
    isReady: () => true,
    complete: vi.fn(async (): Promise<LLMResponse> => ({
      content: JSON.stringify({ steps: [{ id: 1, description: '步骤1' }, { id: 2, description: '步骤2' }] }),
      toolCalls: [],
      usage: mockUsage,
    })),
    stream: vi.fn(async function* () { /* not used */ }),
  };

  const mockClassifier = { classify: vi.fn(async () => ({ tier: 'simple', confidence: 0.9 })) };
  const mockRouter = { route: vi.fn(async () => mockRoute) };
  const mockClientManager = { get: vi.fn(() => mockClient) };
  const mockTracker = {
    record: vi.fn(),
    getStats: vi.fn(() => ({ total: { totalTokens: 0 } })),
    getUsagePercent: vi.fn(() => 0),
    // Phase 31/32 P0 接线：任务级 Token 预算 API
    startTask: vi.fn(),
    recordTaskUsage: vi.fn(() => 'ok'),
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
    loadCheckpoint: vi.fn(async () => {}),
  };

  return {
    deps: {
      classifier: mockClassifier as any,
      modelRouter: mockRouter as any,
      clientManager: mockClientManager as any,
      tracker: mockTracker as any,
      agentLoop: mockAgentLoop as any,
      checkpointManager: mockCheckpointManager as any,
      contextManager: mockContextManager as any,
      config: { checkpoint: { enabled: false }, router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } } } as any,
      systemPromptRef: { current: '' },
      conversationHistoryRef: { current: [] as LLMMessage[] },
      pendingConfirmRef: { current: null },
      abortControllerRef: { current: null },
      currentPlanRef: { current: null as GoalPlan | null },
      awaitingGoalConfirmRef: { current: null },
      addSystemMessage,
      requestPlanEdit,
      setIsProcessing,
      nextId: () => `msg-${Math.random()}`,
    },
    messages,
    requestPlanEdit,
    addSystemMessage,
  };
}

describe('/goal 集成 StepEditor', () => {
  it('用户确认编辑后的计划，开始执行', async () => {
    const editedSteps: PlanStep[] = [
      { id: 1, description: '编辑后的步骤1', status: 'pending', dependencies: [] },
      { id: 2, description: '编辑后的步骤2', status: 'pending', dependencies: [] },
    ];
    const { deps, requestPlanEdit, addSystemMessage } = createMockDeps(editedSteps);
    const runner = createGoalRunner(deps);

    await runner.handleGoalCommand('/goal "测试目标"');

    // requestPlanEdit 被调用
    expect(requestPlanEdit).toHaveBeenCalledTimes(1);
    // 确认消息被添加
    expect(addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('计划已确认'));
  });

  it('用户取消编辑，目标中止', async () => {
    const { deps, requestPlanEdit, addSystemMessage } = createMockDeps(null);
    const runner = createGoalRunner(deps);

    await runner.handleGoalCommand('/goal "测试目标"');

    // requestPlanEdit 被调用
    expect(requestPlanEdit).toHaveBeenCalledTimes(1);
    // 取消消息被添加
    expect(addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('已取消'));
  });
});
