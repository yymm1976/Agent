// tests/agent/execution-orchestrator.test.ts
// Phase 31 Task 4：执行编排（单/多 Agent 自适应）测试

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ExecutionOrchestrator,
  createExecutionOrchestrator,
  anyNeedsSubAgent,
  type ExecutionOrchestratorDeps,
} from '../../src/agent/execution-orchestrator.js';
import type { GoalPlan, GoalStep } from '../../src/agent/goal-types.js';
import type { StepComplexity } from '../../src/agent/task-orchestrator-types.js';
import type { TokenTracker } from '../../src/router/tracker.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { ReActEvent } from '../../src/agent/loop-config.js';

// 模拟 ReActAgentLoop
function createMockAgentLoop(events: ReActEvent[] = []) {
  return {
    run: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  };
}

// 模拟 TokenTracker
function createMockTracker(): TokenTracker {
  return {
    record: vi.fn(),
    getUsagePercent: vi.fn().mockReturnValue(0),
    checkBudget: vi.fn().mockReturnValue(true),
  } as unknown as TokenTracker;
}

// 模拟配置
function createMockConfig(): AppConfig {
  return {
    optimization: {
      workflow: { unifiedPipeline: true, autoRequirements: true, reviewOnComplete: true, reviewMode: 'builtin', reviewModel: 'auto', reviewStrictness: 'medium' },
      safety: { readBeforeWrite: true, maxToolOutputChars: 16000, completionGate: true, gateTimeout: 180000, gateRetry: 1 },
    },
  } as unknown as AppConfig;
}

function makeStep(id: number, description: string = `step ${id}`): GoalStep {
  return { id, description, status: 'pending' } as GoalStep;
}

function makePlan(steps: GoalStep[], description: string = 'test plan'): GoalPlan {
  return { id: 'plan-1', description, steps, status: 'pending' } as GoalPlan;
}

function makeComplexity(overrides: Partial<StepComplexity> = {}): StepComplexity {
  return {
    stepId: 1,
    complexity: 'simple',
    estimatedFiles: 1,
    needsSubAgent: false,
    recommendedRole: 'coder',
    parallelizable: false,
    dependencies: [],
    ...overrides,
  };
}

describe('ExecutionOrchestrator (Phase 31 Task 4)', () => {
  let deps: ExecutionOrchestratorDeps;

  beforeEach(() => {
    deps = {
      agentLoop: createMockAgentLoop([
        { type: 'text_delta', text: '执行完成' } as ReActEvent,
        { type: 'done', content: '执行完成', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } } as ReActEvent,
      ]) as any,
      tracker: createMockTracker(),
      config: createMockConfig(),
      systemPromptRef: { current: 'test system prompt' },
      signal: undefined,
      onProgress: vi.fn(),
      addSystemMessage: vi.fn(),
    };
  });

  // ============================================================
  // anyNeedsSubAgent
  // ============================================================
  describe('anyNeedsSubAgent', () => {
    it('所有步骤都不需要子 Agent 时返回 false', () => {
      const map = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1, needsSubAgent: false })],
        [2, makeComplexity({ stepId: 2, needsSubAgent: false })],
      ]);
      expect(anyNeedsSubAgent(map)).toBe(false);
    });

    it('任一步骤需要子 Agent 时返回 true', () => {
      const map = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1, needsSubAgent: false })],
        [2, makeComplexity({ stepId: 2, needsSubAgent: true })],
      ]);
      expect(anyNeedsSubAgent(map)).toBe(true);
    });

    it('空 Map 返回 false', () => {
      expect(anyNeedsSubAgent(new Map())).toBe(false);
    });
  });

  // ============================================================
  // 单 Agent 路径
  // ============================================================
  describe('单 Agent 执行路径', () => {
    it('所有步骤 simple 时走单 Agent 路径', async () => {
      const plan = makePlan([makeStep(1), makeStep(2)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1, needsSubAgent: false })],
        [2, makeComplexity({ stepId: 2, needsSubAgent: false })],
      ]);

      const orchestrator = new ExecutionOrchestrator(deps);
      const result = await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {} as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      expect(result.mode).toBe('single');
      expect(result.results.length).toBe(2);
      expect(result.failedStepIds.length).toBe(0);
    });

    it('单 Agent 路径正确累加 Token', async () => {
      const plan = makePlan([makeStep(1), makeStep(2)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1 })],
      ]);

      const orchestrator = new ExecutionOrchestrator(deps);
      const result = await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {} as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      // 每步 150 token，2 步共 300
      expect(result.totalUsage.totalTokens).toBe(300);
      expect(result.totalUsage.inputTokens).toBe(200);
      expect(result.totalUsage.outputTokens).toBe(100);
    });

    it('单 Agent 路径触发 onProgress 回调', async () => {
      const plan = makePlan([makeStep(1)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1 })],
      ]);

      const orchestrator = new ExecutionOrchestrator(deps);
      await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {} as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      expect(deps.onProgress).toHaveBeenCalled();
    });

    it('单 Agent 路径记录 Token 到 tracker', async () => {
      const plan = makePlan([makeStep(1)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1 })],
      ]);

      const orchestrator = new ExecutionOrchestrator(deps);
      await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {} as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      expect(deps.tracker.record).toHaveBeenCalled();
    });

    it('中止信号在执行前触发时返回空结果', async () => {
      const plan = makePlan([makeStep(1)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1 })],
      ]);

      const abortController = new AbortController();
      abortController.abort();
      deps.signal = abortController.signal;

      const orchestrator = new ExecutionOrchestrator(deps);
      const result = await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {} as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      expect(result.results.length).toBe(0);
      expect(result.totalUsage.totalTokens).toBe(0);
    });
  });

  // ============================================================
  // 多 Agent 路径
  // ============================================================
  describe('多 Agent 执行路径', () => {
    it('任一步骤 needsSubAgent 时走多 Agent 路径', async () => {
      const plan = makePlan([makeStep(1), makeStep(2)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1, needsSubAgent: true, complexity: 'complex' })],
        [2, makeComplexity({ stepId: 2, needsSubAgent: false, complexity: 'simple' })],
      ]);

      const orchestrator = new ExecutionOrchestrator(deps);
      // Orchestrator.plan 内部 catch 错误并返回 fallback 串行计划，不会抛错
      // 因此 mode 仍为 'multi'（执行路径是 executeMultiAgent，内部按 fallback 计划串行执行）
      const result = await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {
          complete: vi.fn().mockRejectedValue(new Error('mock LLM error')),
        } as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      expect(result.mode).toBe('multi');
    });

    it('多 Agent 路径触发 addSystemMessage', async () => {
      const plan = makePlan([makeStep(1), makeStep(2)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1, needsSubAgent: true })],
        [2, makeComplexity({ stepId: 2, needsSubAgent: false })],
      ]);

      const orchestrator = new ExecutionOrchestrator(deps);
      await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {
          complete: vi.fn().mockRejectedValue(new Error('mock error')),
        } as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      // 即使回退，也应触发 addSystemMessage
      expect(deps.addSystemMessage).toHaveBeenCalled();
    });
  });

  // ============================================================
  // 错误处理
  // ============================================================
  describe('错误处理', () => {
    it('步骤执行失败时记录失败但不中断后续步骤', async () => {
      // 第一个步骤失败，第二个成功
      let callCount = 0;
      deps.agentLoop = {
        run: async function* () {
          callCount++;
          if (callCount === 1) {
            throw new Error('step 1 failed');
          }
          yield { type: 'done', content: 'ok', usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 } } as ReActEvent;
        },
      } as any;

      const plan = makePlan([makeStep(1), makeStep(2)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1 })],
        [2, makeComplexity({ stepId: 2 })],
      ]);

      const orchestrator = new ExecutionOrchestrator(deps);
      const result = await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {} as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      expect(result.results.length).toBe(2);
      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(true);
      expect(result.failedStepIds).toEqual([1]);
    });
  });

  // ============================================================
  // 工厂函数
  // ============================================================
  describe('工厂函数', () => {
    it('createExecutionOrchestrator 返回实例', () => {
      const orchestrator = createExecutionOrchestrator(deps);
      expect(orchestrator).toBeInstanceOf(ExecutionOrchestrator);
    });
  });

  // ============================================================
  // 结果结构
  // ============================================================
  describe('结果结构', () => {
    it('返回完整的 ExecutionOrchestrationResult', async () => {
      const plan = makePlan([makeStep(1)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1 })],
      ]);

      const orchestrator = new ExecutionOrchestrator(deps);
      const result = await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {} as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('totalUsage');
      expect(result).toHaveProperty('modifiedFiles');
      expect(result).toHaveProperty('mode');
      expect(result).toHaveProperty('failedStepIds');
    });

    it('modifiedFiles 去重', async () => {
      // 两个步骤都修改同一文件
      deps.agentLoop = {
        run: async function* () {
          yield {
            type: 'tool_call_result',
            toolName: 'file_write',
            toolCallId: 'tc-1',
            result: 'modified src/a.ts',
            isError: false,
          } as ReActEvent;
          yield { type: 'done', content: 'ok', usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 } } as ReActEvent;
        },
      } as any;

      const plan = makePlan([makeStep(1), makeStep(2)]);
      const complexityMap = new Map<number, StepComplexity>([
        [1, makeComplexity({ stepId: 1 })],
        [2, makeComplexity({ stepId: 2 })],
      ]);

      const orchestrator = new ExecutionOrchestrator(deps);
      const result = await orchestrator.execute({
        plan,
        complexityMap,
        llmClient: {} as any,
        routeDecision: { model: { id: 'test-model' } } as any,
        conversationHistory: [],
      });

      // 两个步骤都匹配到 a.ts，但 modifiedFiles 应去重
      // 注意：正则可能匹配多个，这里验证数组没有重复
      const uniqueFiles = new Set(result.modifiedFiles);
      expect(uniqueFiles.size).toBe(result.modifiedFiles.length);
    });
  });
});
