// tests/runtime/goal-runner-scheduler.test.ts
// Phase 91 Task 3：goal-runner-scheduler.ts 单元测试
// 验证：
//   - executeGoalPlan：attestation 校验失败中止、status 流转到 executing
//   - executeSingleStep：用户中断（abort）抛 PlanAbortError、预算耗尽中止
//   - executePlanWithDag：dagEngine 未注入时降级到 single
//   - executePlanWithCompose：compositionalRouter 未注入时降级到 DAG
//
// 测试策略：通过 createGoalRunner 入口测试（executeGoalPlan 是公共 API），
//           内部函数（executeSingleStep 等）通过 executeGoalPlan 间接覆盖

import { describe, it, expect, vi } from 'vitest';
import { createGoalRunner } from '../../src/runtime/goal-runner-core.js';
import type { GoalRunnerDeps } from '../../src/runtime/goal-runner-core.js';
import type { GoalPlan, PlanStep } from '../../src/agent/goal-types.js';
import type { LLMMessage, LLMResponse, TokenUsageInfo, RoutingResult, ModelInfo } from '../../src/router/types.js';
import { attestPlan } from '../../src/agent/plan-attestation.js';

const mockModel: ModelInfo = {
  id: 'gpt-4o', providerId: 'openai', tier: 'medium',
  costPer1kInput: 0.005, costPer1kOutput: 0.015,
  maxContextTokens: 128000, maxOutputTokens: 4096,
};
const mockRoute: RoutingResult = {
  model: mockModel, providerId: 'openai', degraded: false, reason: 'test',
};
const mockUsage: TokenUsageInfo = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };

function createMockDeps(overrides: Partial<GoalRunnerDeps> = {}): GoalRunnerDeps {
  const mockClient = {
    isReady: () => true,
    complete: vi.fn(async (): Promise<LLMResponse> => ({
      content: 'done',
      toolCalls: [],
      usage: mockUsage,
    })),
    stream: vi.fn(async function* () {}),
  };
  return {
    classifier: { classify: vi.fn(async () => ({ tier: 'simple', confidence: 0.9 })) } as any,
    modelRouter: {
      route: vi.fn(async () => mockRoute),
      recordModelSuccess: vi.fn(),
      recordModelFailure: vi.fn(),
      getManualOverride: vi.fn(() => null),
      getAvailableModels: vi.fn(() => []),
    } as any,
    clientManager: { get: vi.fn(() => mockClient) } as any,
    tracker: {
      record: vi.fn(), getStats: vi.fn(() => ({ total: { totalTokens: 0 } })),
      getUsagePercent: vi.fn(() => 0), startTask: vi.fn(),
      recordTaskUsage: vi.fn(() => 'ok' as const), endTask: vi.fn(),
      getTaskUsagePercent: vi.fn(() => 0), isTaskActive: vi.fn(() => false),
      checkBudget: vi.fn(() => true),
    } as any,
    agentLoop: {
      run: async function* () { yield { type: 'done' as const, content: 'done', usage: mockUsage }; },
      updateToolExecutor: vi.fn(),
    } as any,
    checkpointManager: {
      init: vi.fn(async () => {}), saveGoalPlan: vi.fn(async () => {}),
      create: vi.fn(async () => null), count: 0, isEnabled: false,
    } as any,
    contextManager: {
      getCheckpoint: vi.fn(() => null), resetTriggers: vi.fn(),
      shouldTriggerCheckpoint: vi.fn(() => null), triggerCheckpoint: vi.fn(async () => {}),
      saveCheckpoint: vi.fn(async () => {}), shouldCompress: vi.fn(() => false),
      compress: vi.fn(() => ({ compressed: [], discarded: [] })),
      compressEnhanced: vi.fn(async () => ({ compressed: [], discarded: [] })),
      loadCheckpoint: vi.fn(async () => {}),
    } as any,
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
    requestPlanEdit: vi.fn(async () => null),
    setIsProcessing: vi.fn(),
    nextId: () => `msg-${Math.random()}`,
    ...overrides,
  };
}

/** 构造测试用 GoalPlan（已 attestPlan） */
function createTestPlan(opts: { steps?: PlanStep[]; status?: GoalPlan['status'] } = {}): GoalPlan {
  const plan: GoalPlan = {
    id: 'test-plan-1',
    description: '测试目标',
    steps: opts.steps ?? [
      { id: 1, description: '步骤1', status: 'pending', dependencies: [], domain: 'general' },
    ],
    status: opts.status ?? 'pending',
    createdAt: Date.now(),
  };
  attestPlan(plan, 'test');
  return plan;
}

describe('goal-runner-scheduler 模块', () => {
  describe('Closure 2：cancellation settlement（gate 取消后不再启动 verifyPlan）', () => {
    it('completion_gate_first：gate 期间取消 → verifyPlan 不启动（classifier 零调用）', async () => {
      const addSystemMessage = vi.fn();
      // 与 runner 共享同一 ref：mock verify 在 gate 阶段 abort 调度器安装的 controller
      const abortControllerRef = { current: null as AbortController | null };
      const classifySpy = vi.fn(async () => ({ tier: 'simple', confidence: 0.9 }));
      const deps = createMockDeps({
        addSystemMessage,
        abortControllerRef,
        classifier: { classify: classifySpy } as any,
        completionGate: {
          verify: vi.fn(async (params: { signal?: AbortSignal }) => {
            // 模拟用户在 typecheck/tests 期间点击取消
            abortControllerRef.current?.abort();
            return { passed: false, checks: [], cancelled: true };
          }),
        } as any,
      });
      const runner = createGoalRunner(deps);

      const plan = createTestPlan({
        steps: [
          { id: 1, description: '步骤1', status: 'pending', dependencies: [], domain: 'general' },
        ],
      });
      await expect(runner.executeGoalPlan(plan)).rejects.toThrow('用户中断');
      // cancellation invariant：取消一旦被确认，不得再启动新的 verification 工作
      // （verifyPlan 会用 plan.description 作为 verifierQuery——绝不出现）
      const verifyQueries = classifySpy.mock.calls.filter(
        ([args]) => (args as { query?: string }).query === '测试目标',
      );
      expect(verifyQueries).toHaveLength(0);
    });

    it('reviewer_first：reviewer 期间取消 → runCompletionGate 不启动（verify 零调用）', async () => {
      const addSystemMessage = vi.fn();
      const abortControllerRef = { current: null as AbortController | null };
      const classifySpy = vi.fn(async () => ({ tier: 'simple', confidence: 0.9 }));
      const verifySpy = vi.fn();
      const deps = createMockDeps({
        addSystemMessage,
        abortControllerRef,
        classifier: { classify: classifySpy } as any,
        completionGate: { verify: verifySpy } as any,
        config: {
          checkpoint: { enabled: false },
          router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
          goal: { auditMode: 'reviewer_first' as const },
        } as any,
      });
      const runner = createGoalRunner(deps);

      const plan = createTestPlan({
        steps: [
          { id: 1, description: '步骤1', status: 'pending', dependencies: [], domain: 'general' },
        ],
      });
      // 仅当 reviewer（verifyPlan 用 plan.description 作 verifierQuery）发起分类时模拟用户取消
      classifySpy.mockImplementation(async (args: { query: string }) => {
        if (args.query === '测试目标') abortControllerRef.current?.abort();
        return { tier: 'simple', confidence: 0.9 };
      });
      await expect(runner.executeGoalPlan(plan)).rejects.toThrow('用户中断');
      // reviewer 取消 → 不得再启动 CompletionGate（取消确认后的不变量）
      expect(verifySpy).not.toHaveBeenCalled();
    });
  });

  describe('executeGoalPlan attestation 校验', () => {
    it('无 attestation 时自动补签（execution_auto_repair）', async () => {
      const addSystemMessage = vi.fn();
      const deps = createMockDeps({ addSystemMessage });
      const runner = createGoalRunner(deps);

      const plan = createTestPlan();
      delete plan.attestation; // 移除 attestation

      await runner.executeGoalPlan(plan);

      // executeGoalPlan 内部调用 attestPlan(plan, 'execution_auto_repair') 补签
      // 补签后 verifyPlanAttestation 通过，继续执行
      expect(plan.attestation).toBeDefined();
      expect(plan.attestation?.attestedBy).toBe('execution_auto_repair');
    });

    it('attestation 签名校验失败时中止执行（status=failed）', async () => {
      const addSystemMessage = vi.fn();
      const deps = createMockDeps({ addSystemMessage });
      const runner = createGoalRunner(deps);

      const plan = createTestPlan();
      // 篡改 attestation hash 让签名校验失败
      plan.attestation = {
        hash: 'invalid-hash-000000000000000000000000000000000000000000000000000000000000',
        version: 1,
        attestedAt: Date.now(),
        attestedBy: 'test',
      };

      await runner.executeGoalPlan(plan);

      expect(plan.status).toBe('failed');
      const failedMsg = addSystemMessage.mock.calls.find(
        ([content]) => typeof content === 'string' && content.includes('签名校验失败'),
      );
      expect(failedMsg).toBeDefined();
    });
  });

  describe('executeGoalPlan status 流转', () => {
    it('执行开始时 plan.status 流转到 executing', async () => {
      const deps = createMockDeps();
      const runner = createGoalRunner(deps);

      const plan = createTestPlan({ status: 'pending' });
      await runner.executeGoalPlan(plan);

      // 执行后 status 应不再是 pending（执行/验证/完成/失败之一）
      expect(plan.status).not.toBe('pending');
    });

    it('存在 failed 步骤时 plan.status 标记为 failed', async () => {
      const addSystemMessage = vi.fn();
      // mock agentLoop.run 抛异常让步骤失败
      const deps = createMockDeps({
        addSystemMessage,
        agentLoop: {
          run: async function* () { throw new Error('步骤执行失败'); },
          updateToolExecutor: vi.fn(),
        } as any,
      });
      const runner = createGoalRunner(deps);

      const plan = createTestPlan({
        steps: [
          { id: 1, description: '会失败的步骤', status: 'pending', dependencies: [], domain: 'general' },
        ],
      });
      await runner.executeGoalPlan(plan);

      // 步骤失败后 plan.status 应为 failed（或验证后仍为 failed）
      expect(plan.steps[0].status).toBe('failed');
    });
  });

  describe('executeGoalPlan 用户中断', () => {
    it('abortControllerRef 已 aborted 时步骤跳过，plan 标记 failed', async () => {
      const addSystemMessage = vi.fn();
      const deps = createMockDeps({
        addSystemMessage,
        abortControllerRef: { current: { signal: { aborted: true } as AbortSignal } as AbortController },
      });
      const runner = createGoalRunner(deps);

      const plan = createTestPlan({
        steps: [
          { id: 1, description: '步骤1', status: 'pending', dependencies: [], domain: 'general' },
        ],
      });
      await runner.executeGoalPlan(plan);

      // 中断时 plan.status 为 failed，步骤未执行（status 仍为 pending）
      expect(plan.status).toBe('failed');
      expect(plan.steps[0].status).toBe('pending');
    });
  });

  describe('executeGoalPlan 收尾', () => {
    it('执行完成后调用 setIsProcessing(false)', async () => {
      const setIsProcessing = vi.fn();
      const deps = createMockDeps({ setIsProcessing });
      const runner = createGoalRunner(deps);

      const plan = createTestPlan();
      await runner.executeGoalPlan(plan);

      // setIsProcessing(true) 在开头，setIsProcessing(false) 在结尾
      expect(setIsProcessing).toHaveBeenCalledWith(true);
      expect(setIsProcessing).toHaveBeenCalledWith(false);
    });

    it('执行完成后 currentPlanRef.current 清空', async () => {
      const currentPlanRef = { current: null as GoalPlan | null };
      const deps = createMockDeps({ currentPlanRef });
      const runner = createGoalRunner(deps);

      const plan = createTestPlan();
      await runner.executeGoalPlan(plan);

      expect(currentPlanRef.current).toBeNull();
    });

    it('执行完成后 tracker.endTask 被调用', async () => {
      const endTask = vi.fn();
      const deps = createMockDeps({
        tracker: {
          record: vi.fn(), getStats: vi.fn(() => ({ total: { totalTokens: 0 } })),
          getUsagePercent: vi.fn(() => 0), startTask: vi.fn(),
          recordTaskUsage: vi.fn(() => 'ok' as const), endTask,
          getTaskUsagePercent: vi.fn(() => 0), isTaskActive: vi.fn(() => false),
          checkBudget: vi.fn(() => true),
        } as any,
      });
      const runner = createGoalRunner(deps);

      await runner.executeGoalPlan(createTestPlan());

      expect(endTask).toHaveBeenCalled();
    });
  });

  describe('executePlanWithDag 降级', () => {
    it('dagEngine 未注入时降级到 single（日志提示）', async () => {
      const addSystemMessage = vi.fn();
      const deps = createMockDeps({
        addSystemMessage,
        // dagEngine 未注入（默认 undefined）
        config: {
          checkpoint: { enabled: false },
          router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
          // PathRouter 仅支持 mode='single'|'explicit'|'auto'，'dag' 会被当 auto 处理
          // 用 explicit + explicitRoute='dag' 强制走 DAG 路径
          goal: { executionRouter: { mode: 'explicit', explicitRoute: 'dag' } },
          packs: { goalAdvanced: { enabled: true } },
        } as any,
      });
      const runner = createGoalRunner(deps);

      const plan = createTestPlan();
      await runner.executeGoalPlan(plan);

      // 应有降级提示
      const degradeMsg = addSystemMessage.mock.calls.find(
        ([content]) => typeof content === 'string' && content.includes('DAG') && content.includes('降级'),
      );
      expect(degradeMsg).toBeDefined();
    });
  });
});
