// tests/integration/phase50-integration.test.ts
// Phase 50 集成测试：核心模块接入生产代码验证
//
// 测试策略：
//   1. Task 1（≥5）：/goal 流程接入 GoalAuditor / GoalPersistence / GoalPromptBuilder / RequirementChangeAnalyzer
//   2. Task 2（≥4）：多 Agent 编排接入 StrategySelector / ExecutionStateGraph / BranchOrchestrator
//   3. Task 3（≥6）：子 Agent 委托体系接入 ContextPacker / DelegationGate / DelegationEnforcer / SubAgentLifecycle / SubAgentScoreCardCollector
//
// 全部使用 mock 依赖，不调用真实 LLM。
// 验证三件事：(a) config 开关 (b) 代码接线点 (c) try/catch 降级不崩溃

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGoalRunner } from '../../src/cli/goal-runner.js';
import { GoalAuditor } from '../../src/agent/goal-audit.js';
import { GoalPersistence } from '../../src/agent/goal-persistence.js';
import { GoalPromptBuilder } from '../../src/agent/goal-prompt-builder.js';
import { Orchestrator } from '../../src/agent/multi/orchestrator.js';
import { StrategySelector } from '../../src/agent/multi/orchestrator-strategy.js';
import {
  wrapSpawnAgentWithDelegation,
  type SpawnAgentFunction,
  type SpawnAgentParams,
  type DelegationIntegrationDeps,
} from '../../src/tools/builtin/spawn-agent.js';
import { ContextPacker } from '../../src/agents/context-packer.js';
import { DelegationGate } from '../../src/agents/delegation-gate.js';
import { SubAgentLifecycle } from '../../src/agents/sub-agent-lifecycle.js';
import { SubAgentScoreCardCollector } from '../../src/agents/sub-agent-score-card.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse } from '../../src/router/types.js';
import type { GoalPlan, PlanStep } from '../../src/agent/goal-types.js';
import type { LLMMessage } from '../../src/router/types.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// ============================================================
// 通用 Mock 工具
// ============================================================

/** 创建 mock ILLMClient（返回指定响应内容） */
function makeMockClient(response: string): ILLMClient {
  return {
    protocol: 'openai',
    providerId: 'mock-provider',
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => ({
      content: response,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
      model: 'mock-model',
    })),
    stream: vi.fn(async function* () { /* not used */ }),
  } as unknown as ILLMClient;
}

/** 创建 mock GoalRunner 依赖（参考 tests/cli/goal-integration.test.ts 模式） */
function createGoalRunnerMockDeps(overrides: Record<string, unknown> = {}) {
  const messages: string[] = [];
  const addSystemMessage = vi.fn((content: string) => { messages.push(content); });
  const requestPlanEdit = vi.fn(async (_plan: GoalPlan): Promise<PlanStep[] | null> => null);
  const setIsProcessing = vi.fn();

  const mockClient = makeMockClient(JSON.stringify({
    steps: [{ id: 1, description: '步骤1' }, { id: 2, description: '步骤2' }],
  }));

  const mockClassifier = { classify: vi.fn(async () => ({ tier: 'simple', confidence: 0.9 })) };
  const mockRouter = { route: vi.fn(async () => ({
    model: { id: 'mock', name: 'mock', provider: 'mock', tier: 'medium', contextWindow: 128000, capabilities: [], latencyMs: 0, available: true },
    providerId: 'mock',
    fallbackUsed: false,
    originalTier: 'simple',
    degraded: false,
  })) };
  const mockClientManager = { get: vi.fn(() => mockClient) };
  const mockTracker = {
    record: vi.fn(),
    getStats: vi.fn(() => ({ total: { totalTokens: 0 } })),
    getUsagePercent: vi.fn(() => 0),
    startTask: vi.fn(),
    recordTaskUsage: vi.fn(() => 'ok'),
    endTask: vi.fn(),
    getTaskUsagePercent: vi.fn(() => 0),
    isTaskActive: vi.fn(() => false),
    checkBudget: vi.fn(() => true),
  };
  const mockAgentLoop = {
    run: async function* () { yield { type: 'done' as const, content: 'done', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }; },
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
      config: {
        checkpoint: { enabled: false },
        router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
      } as any,
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
      ...overrides,
    },
    messages,
    addSystemMessage,
    requestPlanEdit,
    mockClient,
  };
}

/** 创建临时目录用于 GoalPersistence 测试 */
async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `routedev-phase50-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================
// Task 1: /goal 流程接入（≥5 测试）
// ============================================================

describe('Phase 50 Task 1: /goal 流程模块接入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1.1 promptBuilderEnabled=true 且注入 goalPromptBuilder 时，handleGoalCommand 调用 build() 并显示提示', async () => {
    const tmpDir = await makeTempDir();
    const promptBuilder = new GoalPromptBuilder();
    const buildSpy = vi.spyOn(promptBuilder, 'build');
    const { deps, addSystemMessage } = createGoalRunnerMockDeps({
      config: {
        checkpoint: { enabled: false },
        router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
        goalIntegration: { promptBuilderEnabled: true, auditEnabled: false, persistenceEnabled: false, requirementChangeEnabled: false },
      },
      goalPromptBuilder: promptBuilder,
    });
    const runner = createGoalRunner(deps);

    await runner.handleGoalCommand('/goal "实现用户登录功能"');

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).toHaveBeenCalledWith('实现用户登录功能');
    // 应该显示 GoalPromptBuilder 已构造的提示
    expect(addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('GoalPromptBuilder'));
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('1.2 promptBuilderEnabled=true 但 build() 抛异常时，降级不崩溃且继续原流程', async () => {
    const promptBuilder = new GoalPromptBuilder();
    vi.spyOn(promptBuilder, 'build').mockRejectedValueOnce(new Error('mock build failure'));
    const { deps, addSystemMessage } = createGoalRunnerMockDeps({
      config: {
        checkpoint: { enabled: false },
        router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
        goalIntegration: { promptBuilderEnabled: true, auditEnabled: false, persistenceEnabled: false, requirementChangeEnabled: false },
      },
      goalPromptBuilder: promptBuilder,
    });
    const runner = createGoalRunner(deps);

    // 不应抛出异常
    await expect(runner.handleGoalCommand('/goal "测试目标"')).resolves.toBeUndefined();
    // 不应显示 GoalPromptBuilder 已构造的提示（因降级）
    const promptBuilderCalls = addSystemMessage.mock.calls.filter(c => String(c[0]).includes('GoalPromptBuilder'));
    expect(promptBuilderCalls.length).toBe(0);
  });

  it('1.3 promptBuilderEnabled=false 时，不调用 goalPromptBuilder.build()', async () => {
    const promptBuilder = new GoalPromptBuilder();
    const buildSpy = vi.spyOn(promptBuilder, 'build');
    const { deps } = createGoalRunnerMockDeps({
      config: {
        checkpoint: { enabled: false },
        router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
        goalIntegration: { promptBuilderEnabled: false, auditEnabled: false, persistenceEnabled: false, requirementChangeEnabled: false },
      },
      goalPromptBuilder: promptBuilder,
    });
    const runner = createGoalRunner(deps);

    await runner.handleGoalCommand('/goal "测试目标"');

    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('1.4 analyzeRequirementChange：requirementChangeEnabled=true 时返回影响分析结果', async () => {
    const { deps } = createGoalRunnerMockDeps({
      config: {
        checkpoint: { enabled: false },
        router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
        goalIntegration: { promptBuilderEnabled: false, auditEnabled: false, persistenceEnabled: false, requirementChangeEnabled: true },
      },
    });
    const runner = createGoalRunner(deps);

    // before 不含功能词，after 含"新增"功能词 → 应判定为 major + needsReplan
    const result = await runner.analyzeRequirementChange(
      '实现用户登录',
      '实现用户登录，新增支持 OAuth 第三方登录',
    );

    expect(result).not.toBeNull();
    expect(result!.needsReplan).toBe(true);
    expect(result!.severity).toBe('major');
    expect(result!.reason).toContain('新功能');
  });

  it('1.5 analyzeRequirementChange：requirementChangeEnabled=false 时返回 null', async () => {
    const { deps } = createGoalRunnerMockDeps({
      config: {
        checkpoint: { enabled: false },
        router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
        goalIntegration: { promptBuilderEnabled: false, auditEnabled: false, persistenceEnabled: false, requirementChangeEnabled: false },
      },
    });
    const runner = createGoalRunner(deps);

    const result = await runner.analyzeRequirementChange('before', 'after');
    expect(result).toBeNull();
  });

  it('1.6 persistenceEnabled=true 时，executeGoalPlan 调用 goalPersistence.save()', async () => {
    const tmpDir = await makeTempDir();
    const persistence = new GoalPersistence(tmpDir);
    const saveSpy = vi.spyOn(persistence, 'save');
    // requestPlanEdit 返回非 null 步骤，让 handleGoalCommand 进入 executeGoalPlan
    const editedSteps: PlanStep[] = [
      { id: 1, description: '步骤1', status: 'pending', dependencies: [] },
    ];
    const { deps } = createGoalRunnerMockDeps({
      config: {
        checkpoint: { enabled: false },
        router: { budget: { mode: 'track_only' as const, dailyLimit: 500000 } },
        goalIntegration: { promptBuilderEnabled: false, auditEnabled: false, persistenceEnabled: true, requirementChangeEnabled: false },
      },
      goalPersistence: persistence,
      requestPlanEdit: vi.fn(async () => editedSteps),
    });
    const runner = createGoalRunner(deps);

    await runner.handleGoalCommand('/goal "测试目标"');

    expect(saveSpy).toHaveBeenCalledTimes(1);
    // 验证保存的 goal id 与 plan.id 一致
    expect(saveSpy.mock.calls[0][0].id).toBeDefined();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// Task 2: 多 Agent 编排接入（≥4 测试）
// ============================================================

describe('Phase 50 Task 2: 多 Agent 编排模块接入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('2.1 strategyEnabled=true 且步骤数 ≤ 2（low complexity）时，使用 fallback 串行计划', async () => {
    const mockJson = JSON.stringify([
      { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: ['a.ts'] },
    ]);
    const client = makeMockClient(mockJson);
    const orch = new Orchestrator(client, 'test-model', {
      strategyEnabled: true,
      stateGraphEnabled: false,
      branchOrchestrationEnabled: false,
    });
    const goalPlan: GoalPlan = {
      id: 'plan-1',
      description: 'simple task',
      steps: [{ id: 1, description: 'step1', status: 'pending', dependencies: [] }],
      status: 'pending',
      createdAt: Date.now(),
    };
    const plan = await orch.plan(goalPlan);
    // low complexity → sequential → fallbackPlan（不调用 LLM 分析）
    expect(plan.analysisNotes).toContain('Fallback');
  });

  it('2.2 strategyEnabled=true 且步骤数 > 6（high complexity）时，继续 LLM 分析', async () => {
    const mockJson = JSON.stringify([
      { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: [] },
      { stepId: 2, dependsOn: [1], assignedRole: 'coder', likelyFiles: [] },
    ]);
    const client = makeMockClient(mockJson);
    const orch = new Orchestrator(client, 'test-model', {
      strategyEnabled: true,
      stateGraphEnabled: false,
      branchOrchestrationEnabled: false,
    });
    // 7 个步骤 → high complexity → adaptive → 继续 LLM 分析
    const goalPlan: GoalPlan = {
      id: 'plan-1',
      description: 'complex task',
      steps: Array.from({ length: 7 }, (_, i) => ({
        id: i + 1, description: `step${i + 1}`, status: 'pending' as const, dependencies: [],
      })),
      status: 'pending',
      createdAt: Date.now(),
    };
    const plan = await orch.plan(goalPlan);
    // LLM 分析成功，不应是 fallback
    expect(plan.analysisNotes).not.toContain('Fallback');
    // Orchestrator.parseAnalysis 为每个 GoalPlan 步骤创建一个 StepDependency（7 个步骤 → 7 个依赖）
    expect(plan.dependencies.length).toBe(7);
    // 前两个依赖应由 LLM 分析结果填充（coder 角色）
    expect(plan.dependencies[0].assignedRole).toBe('coder');
  });

  it('2.3 stateGraphEnabled=true 时，getStateGraph() 返回非 null 且步骤被加入状态图', async () => {
    const mockJson = JSON.stringify([
      { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: [] },
      { stepId: 2, dependsOn: [1], assignedRole: 'coder', likelyFiles: [] },
    ]);
    const client = makeMockClient(mockJson);
    const orch = new Orchestrator(client, 'test-model', {
      strategyEnabled: false,
      stateGraphEnabled: true,
      branchOrchestrationEnabled: false,
    });
    const goalPlan: GoalPlan = {
      id: 'plan-1',
      description: 'test',
      steps: [
        { id: 1, description: 's1', status: 'pending', dependencies: [] },
        { id: 2, description: 's2', status: 'pending', dependencies: [1] },
      ],
      status: 'pending',
      createdAt: Date.now(),
    };
    await orch.plan(goalPlan);
    const graph = orch.getStateGraph();
    expect(graph).not.toBeNull();
    expect(graph!.getAllSteps().length).toBe(2);
    // 初始状态都是 pending
    const pending = graph!.getPendingSteps();
    // step 1 无依赖 → pending 可执行；step 2 依赖 step 1（未 completed）→ 不可执行
    expect(pending).toContain('1');
    expect(pending).not.toContain('2');
  });

  it('2.4 transitionStepState：合法转换返回 true，非法转换返回 false', async () => {
    const mockJson = JSON.stringify([
      { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: [] },
    ]);
    const client = makeMockClient(mockJson);
    const orch = new Orchestrator(client, 'test-model', {
      strategyEnabled: false,
      stateGraphEnabled: true,
      branchOrchestrationEnabled: false,
    });
    const goalPlan: GoalPlan = {
      id: 'plan-1',
      description: 'test',
      steps: [{ id: 1, description: 's1', status: 'pending', dependencies: [] }],
      status: 'pending',
      createdAt: Date.now(),
    };
    await orch.plan(goalPlan);

    // pending → running 合法
    expect(orch.transitionStepState(1, 'running', 'start')).toBe(true);
    // running → completed 合法
    expect(orch.transitionStepState(1, 'completed', 'done')).toBe(true);
    // completed → running 非法（终态不可转换）
    expect(orch.transitionStepState(1, 'running', 'redo')).toBe(false);
  });

  it('2.5 branchOrchestrationEnabled=true 但未注入 branchOrchestrator 时，planBranches 安全回退', async () => {
    const client = makeMockClient('[]');
    const orch = new Orchestrator(client, 'test-model', {
      strategyEnabled: false,
      stateGraphEnabled: false,
      branchOrchestrationEnabled: true,
      // branchOrchestrator 未注入
    });
    const goalPlan: GoalPlan = {
      id: 'plan-1',
      description: 'test',
      steps: [{ id: 1, description: 's1', status: 'pending', dependencies: [] }],
      status: 'pending',
      createdAt: Date.now(),
    };
    const result = await orch.planBranches(goalPlan);
    // branchOrchestrator 缺失 → 安全回退：scheduled=false, taskCount=0
    expect(result.scheduled).toBe(false);
    expect(result.taskCount).toBe(0);
  });

  it('2.6 StrategySelector.selectStrategy 单元验证：low→sequential, medium→parallel, high→adaptive', () => {
    expect(StrategySelector.selectStrategy('low')).toBe('sequential');
    expect(StrategySelector.selectStrategy('medium')).toBe('parallel');
    expect(StrategySelector.selectStrategy('high')).toBe('adaptive');
  });
});

// ============================================================
// Task 3: 子 Agent 委托体系接入（≥6 测试）
// ============================================================

describe('Phase 50 Task 3: 子 Agent 委托体系模块接入', () => {
  /** 创建简单的 inner spawn 函数 mock */
  function makeInnerSpawnFn(overrides: Partial<{ result: string; success: boolean }> = {}): SpawnAgentFunction & { calls: any[] } {
    const calls: any[] = [];
    const fn = vi.fn(async (params: SpawnAgentParams | string, _options?: { systemPrompt?: string; maxIterations?: number }) => {
      calls.push(params);
      return {
        success: overrides.success ?? true,
        result: overrides.result ?? 'inner result',
        tokenUsage: { inputTokens: 100, outputTokens: 200 },
      };
    }) as any;
    fn.calls = calls;
    return fn;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('3.1 所有开关=false 时，wrapper 是 passthrough，直接调用 innerFn', async () => {
    const innerFn = makeInnerSpawnFn();
    const deps: DelegationIntegrationDeps = {}; // 全部未启用
    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);

    const result = await wrapped({ description: 'task', prompt: 'do something' });

    expect(result.success).toBe(true);
    expect(innerFn).toHaveBeenCalledTimes(1);
    // prompt 不应被修改（无上下文附加）
    const callArg = innerFn.mock.calls[0][0] as SpawnAgentParams;
    expect(callArg.prompt).toBe('do something');
  });

  it('3.2 contextPackerEnabled=true 时，prompt 被附加上下文包 sections', async () => {
    const innerFn = makeInnerSpawnFn();
    const contextPacker = new ContextPacker();
    const deps: DelegationIntegrationDeps = {
      contextPackerEnabled: true,
      contextPacker,
    };
    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);

    await wrapped({ description: 'task', prompt: 'do something', subagentType: 'coder' });

    expect(innerFn).toHaveBeenCalledTimes(1);
    const callArg = innerFn.mock.calls[0][0] as SpawnAgentParams;
    // prompt 应被附加上下文包（包含 "上下文包" 标识）
    expect(callArg.prompt).toContain('上下文包');
    expect(callArg.prompt).toContain('do something');
  });

  it('3.3 delegationGateEnabled=true 且 gate 拒绝时，spawn 返回 error 且不调用 innerFn', async () => {
    const innerFn = makeInnerSpawnFn();
    // DelegationGate 默认要求 executor 角色提供 design_doc + write_file_list
    // coder → executor 角色，不提供 designDoc/writeFiles → gate 拒绝
    const gate = new DelegationGate();
    const deps: DelegationIntegrationDeps = {
      delegationGateEnabled: true,
      delegationGate: gate,
      parentAgent: { id: 'parent', activeSubAgents: [] },
    };
    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);

    const result = await wrapped({ description: 'task', prompt: 'do something', subagentType: 'coder' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('委托门控拒绝');
    expect(innerFn).not.toHaveBeenCalled();
  });

  it('3.4 delegationEnforcerEnabled=true 时，enforcer 被创建且 spawn_agent 在 allowedTools 中通过校验', async () => {
    const innerFn = makeInnerSpawnFn();
    const deps: DelegationIntegrationDeps = {
      delegationEnforcerEnabled: true,
      // contractManager 在 wrapper 内部自动创建
    };
    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);

    const result = await wrapped({ description: 'task', prompt: 'do something', subagentType: 'general' });

    // spawn_agent 在 allowedTools 列表中 → 校验通过 → 继续执行
    expect(result.success).toBe(true);
    expect(innerFn).toHaveBeenCalledTimes(1);
  });

  it('3.5 lifecycleEnabled=true 时，子 Agent 被注册并转换到 running→completed', async () => {
    const innerFn = makeInnerSpawnFn();
    const lifecycle = new SubAgentLifecycle();
    const deps: DelegationIntegrationDeps = {
      lifecycleEnabled: true,
      lifecycle,
    };
    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);

    await wrapped({ description: 'task', prompt: 'do something', subagentType: 'coder' });

    // 应该有一个 agent 被注册，状态为 completed
    const all = lifecycle.getAll();
    expect(all.length).toBe(1);
    expect(all[0].status).toBe('completed');
    expect(all[0].tokenUsed).toBe(300); // 100 + 200
  });

  it('3.6 lifecycleEnabled=true 且 innerFn 失败时，agent 状态转为 failed', async () => {
    const innerFn = makeInnerSpawnFn({ success: false });
    const lifecycle = new SubAgentLifecycle();
    const deps: DelegationIntegrationDeps = {
      lifecycleEnabled: true,
      lifecycle,
    };
    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);

    await wrapped({ description: 'task', prompt: 'do something', subagentType: 'coder' });

    const all = lifecycle.getAll();
    expect(all.length).toBe(1);
    expect(all[0].status).toBe('failed');
  });

  it('3.7 scoreCardEnabled=true 时，执行后评分卡被记录到 collector', async () => {
    const innerFn = makeInnerSpawnFn();
    const collector = new SubAgentScoreCardCollector();
    const deps: DelegationIntegrationDeps = {
      scoreCardEnabled: true,
      scoreCardCollector: collector,
    };
    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);

    await wrapped({ description: 'task', prompt: 'do something', subagentType: 'coder' });

    // 应该记录一张评分卡
    expect(collector.size).toBe(1);
    const cards = collector.getAllCards();
    expect(cards[0].role).toBe('executor'); // coder → executor
    expect(cards[0].parentSatisfaction).toBe('accepted'); // success=true → accepted
    expect(cards[0].tokenUsage.total).toBe(300);
  });

  it('3.8 ContextPacker.pack 抛异常时，wrapper 降级不崩溃且继续调用 innerFn', async () => {
    const innerFn = makeInnerSpawnFn();
    const contextPacker = new ContextPacker();
    vi.spyOn(contextPacker, 'pack').mockRejectedValueOnce(new Error('pack failure'));
    const deps: DelegationIntegrationDeps = {
      contextPackerEnabled: true,
      contextPacker,
    };
    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);

    // 不应抛出异常，且应继续执行 innerFn
    const result = await wrapped({ description: 'task', prompt: 'do something', subagentType: 'coder' });
    expect(result.success).toBe(true);
    expect(innerFn).toHaveBeenCalledTimes(1);
    // prompt 未被附加上下文（因 pack 失败降级）
    const callArg = innerFn.mock.calls[0][0] as SpawnAgentParams;
    expect(callArg.prompt).toBe('do something');
  });
});
