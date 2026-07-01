// tests/agent/multi/orchestrator.test.ts
// Orchestrator 单元测试

import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../../src/agent/multi/orchestrator.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse } from '../../../src/router/types.js';
import type { GoalPlan } from '../../../src/agent/goal-types.js';

function makeMockClient(response: string): ILLMClient {
  return {
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => ({
      content: response,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    })),
    stream: vi.fn(async function* () { /* */ }),
  };
}

function makeGoalPlan(steps: string[]): GoalPlan {
  return {
    id: 'plan-1',
    description: 'test goal',
    steps: steps.map((desc, i) => ({
      id: i + 1,
      description: desc,
      status: 'pending' as const,
      dependencies: [],
    })),
    status: 'pending',
    createdAt: Date.now(),
  };
}

describe('Orchestrator', () => {
  describe('plan with LLM success', () => {
    it('should produce execution plan from LLM response', async () => {
      const mockJson = JSON.stringify([
        { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: ['auth.ts'] },
        { stepId: 2, dependsOn: [1], assignedRole: 'tester', likelyFiles: ['auth.test.ts'] },
        { stepId: 3, dependsOn: [1, 2], assignedRole: 'reviewer', likelyFiles: ['auth.ts'] },
      ]);
      const client = makeMockClient('```json\n' + mockJson + '\n```');
      const orch = new Orchestrator(client, 'test-model');
      const plan = await orch.plan(makeGoalPlan([
        '创建 auth 模块',
        '写测试',
        '审查',
      ]));
      expect(plan.dependencies.length).toBe(3);
      expect(plan.dependencies[0].assignedRole).toBe('coder');
      expect(plan.executionOrder.length).toBe(3);
      expect(plan.parallelGroups.length).toBeGreaterThan(0);
    });

    it('should parse raw JSON without code block', async () => {
      const mockJson = JSON.stringify([
        { stepId: 1, dependsOn: [], assignedRole: 'searcher', likelyFiles: [] },
      ]);
      const client = makeMockClient(mockJson);
      const orch = new Orchestrator(client, 'test-model');
      const plan = await orch.plan(makeGoalPlan(['搜索资料']));
      expect(plan.dependencies[0].assignedRole).toBe('searcher');
    });

    it('should fall back to coder for invalid role', async () => {
      const mockJson = JSON.stringify([
        { stepId: 1, dependsOn: [], assignedRole: 'invalid_role', likelyFiles: [] },
      ]);
      const client = makeMockClient(mockJson);
      const orch = new Orchestrator(client, 'test-model');
      const plan = await orch.plan(makeGoalPlan(['任务']));
      expect(plan.dependencies[0].assignedRole).toBe('coder');
    });
  });

  describe('plan with LLM failure', () => {
    it('should fall back to serial plan when LLM returns invalid JSON', async () => {
      const client = makeMockClient('not json at all');
      const orch = new Orchestrator(client, 'test-model');
      const plan = await orch.plan(makeGoalPlan(['step 1', 'step 2']));
      expect(plan.dependencies.length).toBe(2);
      expect(plan.parallelGroups).toEqual([[1], [2]]);
      // Phase 54：LLM 失败路径从 fallbackPlan 改为 heuristicPlan，文案 'Fallback' → '启发式分析'
      expect(plan.analysisNotes).toContain('启发式分析');
    });

    it('should fall back when LLM throws', async () => {
      const client: ILLMClient = {
        isReady: () => true,
        complete: vi.fn(async () => { throw new Error('network'); }),
        stream: vi.fn(async function* () { /* */ }),
      };
      const orch = new Orchestrator(client, 'test-model');
      const plan = await orch.plan(makeGoalPlan(['a']));
      expect(plan.parallelGroups).toEqual([[1]]);
    });

    it('should fall back when LLM returns empty array', async () => {
      const client = makeMockClient('[]');
      const orch = new Orchestrator(client, 'test-model');
      const plan = await orch.plan(makeGoalPlan(['x']));
      // Phase 54：LLM 失败路径从 fallbackPlan 改为 heuristicPlan，文案 'Fallback' → '启发式分析'
      expect(plan.analysisNotes).toContain('启发式分析');
    });
  });

  describe('topologicalSort (via plan)', () => {
    it('should linearize chain dependencies', async () => {
      const mockJson = JSON.stringify([
        { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: [] },
        { stepId: 2, dependsOn: [1], assignedRole: 'coder', likelyFiles: [] },
        { stepId: 3, dependsOn: [2], assignedRole: 'coder', likelyFiles: [] },
      ]);
      const client = makeMockClient(mockJson);
      const orch = new Orchestrator(client, 'test-model');
      const plan = await orch.plan(makeGoalPlan(['a', 'b', 'c']));
      expect(plan.executionOrder).toEqual([1, 2, 3]);
    });

    it('should handle no-dependency case with parallel group', async () => {
      const mockJson = JSON.stringify([
        { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: [] },
        { stepId: 2, dependsOn: [], assignedRole: 'coder', likelyFiles: [] },
      ]);
      const client = makeMockClient(mockJson);
      const orch = new Orchestrator(client, 'test-model');
      const plan = await orch.plan(makeGoalPlan(['a', 'b']));
      // 1 和 2 都在第 0 层 → 一个并行组
      expect(plan.parallelGroups[0].sort()).toEqual([1, 2]);
    });
  });
});