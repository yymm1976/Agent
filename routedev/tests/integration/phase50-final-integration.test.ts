// tests/integration/phase50-final-integration.test.ts
// Phase 50 Task 10：最终集成测试（端到端完整性验证）
//
// 测试目标（对应蓝图 10.1 节）：
//   1. /goal 流程端到端：GoalPromptBuilder → GoalPersistence → GoalAuditor → RequirementChangeAnalyzer 四模块串联
//   2. 子 Agent 委托端到端：wrapSpawnAgentWithDelegation 一次启用 5 开关，验证全链路调用
//   3. UI 组件端到端：/resume /trace /diff 命令触发 CommandBridge 回调
//   4. 死代码清理后构建通过：已删除文件不存在 + 关键模块可动态 import（运行时代理 typecheck）
//   5. export 清理后构建通过：关键模块可动态 import（运行时代理 typecheck）
//
// 与 phase50-integration.test.ts 的区别：
//   - phase50-integration.test.ts 聚焦单模块接入行为（开关 on/off 时模块被调用/不调用）
//   - 本文件聚焦多模块串联的端到端完整性（验证模块间协同工作）

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { GoalPromptBuilder } from '../../src/agent/goal-prompt-builder.js';
import { GoalPersistence } from '../../src/agent/goal-persistence.js';
import { GoalAuditor } from '../../src/agent/goal-audit.js';
import { analyzeChangeImpact, isRequirementChange } from '../../src/agent/requirement-change.js';
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
import { resumeCommand } from '../../src/cli/commands/resume.js';
import { traceCommand } from '../../src/cli/commands/trace.js';
import { diffCommand } from '../../src/cli/commands/diff.js';
// E11 更新：durable-executor 已删除，改用 PersistedGoal 类型
import type { PersistedGoal } from '../../src/agent/goal-persistence.js';
import type { TraceSpan } from '../../src/harness/trace-types.js';
import type { ServiceContext } from '../../src/cli/service-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

// ============================================================
// 辅助函数
// ============================================================

/** 创建临时目录 */
async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `routedev-phase50-final-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 断言文件不存在 */
function expectFileNotToExist(relativePath: string): void {
  const absPath = path.join(projectRoot, relativePath);
  if (fsSync.existsSync(absPath)) {
    throw new Error(`文件不应存在但已存在: ${relativePath}`);
  }
}

/** 创建 mock spawn 内部函数 */
function makeInnerSpawnFn(): SpawnAgentFunction & { calls: SpawnAgentParams[] } {
  const calls: SpawnAgentParams[] = [];
  const fn = vi.fn(async (params: SpawnAgentParams | string, _options?: { systemPrompt?: string; maxIterations?: number }) => {
    const normalized = typeof params === 'string' ? { description: params, prompt: params } : params;
    calls.push(normalized);
    return {
      success: true,
      result: 'inner spawn result',
      tokenUsage: { inputTokens: 100, outputTokens: 200 },
    };
  }) as SpawnAgentFunction & { calls: SpawnAgentParams[] };
  fn.calls = calls;
  return fn;
}

/** 创建测试用 PersistedGoal（替代旧 ExecutionSnapshot） */
function makeGoal(overrides: Partial<PersistedGoal> = {}): PersistedGoal {
  return {
    id: 'plan-final-001',
    spec: { goal: '端到端测试目标', context: '', steps: [], done: '', verification: '' },
    plan: {
      steps: [
        { id: '1', description: 'step1', status: 'completed', dependencies: [] },
        { id: '2', description: 'step2', status: 'completed', dependencies: [] },
        { id: '3', description: 'step3', status: 'completed', dependencies: [] },
      ],
    },
    status: 'paused',
    checkpointIds: [],
    createdAt: Date.now() - 60000,
    updatedAt: Date.now() - 30000,
    tokenUsed: 1000,
    tokenBudget: 10000,
    ...overrides,
  };
}

/** 创建测试用 TraceSpan */
function makeTraceSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: 1,
    sessionId: 'session-final-001',
    type: 'tool_call',
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    durationMs: 100,
    payload: {
      type: 'tool_call',
      toolName: 'file_read',
      toolCallId: 'call-final-001',
      result: '文件内容',
      isError: false,
    },
    status: 'completed',
    ...overrides,
  };
}

// ============================================================
// 1. /goal 流程端到端（4 模块串联）
// ============================================================

describe('Phase 50 Task 10 - /goal 流程端到端', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1.1 GoalPromptBuilder → GoalPersistence → GoalAuditor → RequirementChangeAnalyzer 四模块串联', async () => {
    const tmpDir = await makeTempDir();

    // 步骤 1：GoalPromptBuilder 构造五段式 spec
    const builder = new GoalPromptBuilder();
    const spec = await builder.build('实现用户登录功能，新增 OAuth 支持');
    expect(spec.goal).toContain('用户登录');
    expect(spec.doneWhen).toBeInstanceOf(Array);
    expect(spec.tokenBudget).toBeGreaterThan(0);

    // 步骤 2：GoalPersistence 保存 spec 到 .routedev/goals/
    const persistence = new GoalPersistence(tmpDir);
    const goalId = `goal-final-${Date.now()}`;
    await persistence.save({
      id: goalId,
      spec,
      plan: {
        steps: [
          { id: '1', description: '步骤1', status: 'pending', dependencies: [] },
          { id: '2', description: '步骤2', status: 'pending', dependencies: ['1'] },
        ],
      },
      status: 'pending',
      checkpointIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tokenUsed: 0,
      tokenBudget: spec.tokenBudget,
    });

    // 验证文件已持久化
    const loaded = await persistence.load(goalId);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(goalId);
    expect(loaded!.spec.goal).toContain('用户登录');

    // 步骤 3：GoalAuditor 审计（CompletionGate 全通过 + VerifierLLM 通过）
    const auditor = new GoalAuditor({
      completionGate: { enabled: true, runTypecheck: true, runLint: true, runTests: true },
      verifierLlm: { enabled: true },
      reviewerAgent: { enabled: false },
      arbitration: 'completion_gate_first',
    });
    const auditOutcome = await auditor.audit({
      spec: { doneWhen: spec.doneWhen.length > 0 ? spec.doneWhen : ['功能可用'] },
      typecheckPassed: true,
      lintPassed: true,
      testsPassed: true,
      verifierResult: { passed: true, evidence: ['所有完成标准已满足'] },
    });
    expect(auditOutcome.overallPassed).toBe(true);
    expect(auditOutcome.results.length).toBeGreaterThanOrEqual(2);

    // 步骤 4：RequirementChangeAnalyzer 分析需求变更
    const before = '实现用户登录功能';
    const after = '实现用户登录功能，新增 OAuth 第三方登录';
    // isRequirementChange 接收 { role, content } 对象（仅 user 角色消息变更才算）
    expect(isRequirementChange({ role: 'user', content: before }, { role: 'user', content: after })).toBe(true);
    const change = {
      type: 'edit' as const,
      targetNodeId: 'node-1',
      before,
      after,
      impactedBranches: [],
      timestamp: Date.now(),
    };
    const impact = analyzeChangeImpact(change, {
      description: before,
      steps: [{ id: 1, description: '步骤1', status: 'pending' }],
    });
    expect(impact.severity).toBe('major');
    expect(impact.needsReplan).toBe(true);

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('1.2 全部开关关闭时，/goal 流程降级到原行为不崩溃', async () => {
    const tmpDir = await makeTempDir();
    // 即使所有 Phase 50 模块都未启用，原 /goal 流程应正常工作
    const builder = new GoalPromptBuilder();
    const spec = await builder.build('简单任务');
    expect(spec.goal).toBe('简单任务');

    // GoalPersistence 在空目录下 save/load 正常
    const persistence = new GoalPersistence(tmpDir);
    await persistence.save({
      id: 'test-degraded',
      spec,
      plan: { steps: [] },
      status: 'pending',
      checkpointIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tokenUsed: 0,
      tokenBudget: 50000,
    });
    const loaded = await persistence.load('test-degraded');
    expect(loaded).not.toBeNull();

    // GoalAuditor 最小配置（仅 CompletionGate）
    const auditor = new GoalAuditor({
      completionGate: { enabled: true, runTypecheck: false, runLint: false, runTests: false },
      verifierLlm: { enabled: false },
      reviewerAgent: { enabled: false },
      arbitration: 'completion_gate_first',
    });
    const outcome = await auditor.audit({
      spec: { doneWhen: ['done'] },
    });
    expect(outcome).toBeDefined();
    expect(outcome.results.length).toBe(1);

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// 2. 子 Agent 委托端到端（5 模块串联）
// ============================================================

describe('Phase 50 Task 10 - 子 Agent 委托端到端', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('2.1 一次性启用 5 开关：contextPacker → gate → enforcer → lifecycle → scoreCard 全链路调用', async () => {
    const innerFn = makeInnerSpawnFn();
    const contextPacker = new ContextPacker();
    const gate = new DelegationGate();
    const lifecycle = new SubAgentLifecycle();
    const collector = new SubAgentScoreCardCollector();

    const deps: DelegationIntegrationDeps = {
      contextPackerEnabled: true,
      contextPacker,
      delegationGateEnabled: true,
      delegationGate: gate,
      delegationEnforcerEnabled: true,
      lifecycleEnabled: true,
      lifecycle,
      scoreCardEnabled: true,
      scoreCardCollector: collector,
      parentAgent: { id: 'parent-e2e', activeSubAgents: [] },
    };

    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);

    // 用 researcher 角色触发（requires=task_description，prompt 非空 → gate 通过）
    const result = await wrapped({
      description: '研究任务',
      prompt: '调研 OAuth 2.0 最佳实践',
      subagentType: 'researcher',
    });

    // 整体应成功
    expect(result.success).toBe(true);
    expect(innerFn).toHaveBeenCalledTimes(1);

    // 验证 contextPacker 附加了上下文包
    expect(innerFn.calls[0].prompt).toContain('上下文包');
    expect(innerFn.calls[0].prompt).toContain('调研 OAuth');

    // 验证 lifecycle 注册并转换到 completed
    const allAgents = lifecycle.getAll();
    expect(allAgents.length).toBe(1);
    expect(allAgents[0].status).toBe('completed');
    expect(allAgents[0].tokenUsed).toBe(300);

    // 验证 scoreCard 收集了评分卡
    expect(collector.size).toBe(1);
    const cards = collector.getAllCards();
    expect(cards[0].role).toBe('researcher');
    expect(cards[0].parentSatisfaction).toBe('accepted');
  });

  it('2.2 委托链中某模块失败时，后续模块仍可降级执行（不阻塞）', async () => {
    const innerFn = makeInnerSpawnFn();
    const contextPacker = new ContextPacker();
    // 让 contextPacker.pack 抛异常
    vi.spyOn(contextPacker, 'pack').mockRejectedValueOnce(new Error('pack e2e failure'));

    const lifecycle = new SubAgentLifecycle();
    const collector = new SubAgentScoreCardCollector();

    const deps: DelegationIntegrationDeps = {
      contextPackerEnabled: true,
      contextPacker,
      delegationGateEnabled: false, // gate 关闭
      delegationEnforcerEnabled: false,
      lifecycleEnabled: true,
      lifecycle,
      scoreCardEnabled: true,
      scoreCardCollector: collector,
    };

    const wrapped = wrapSpawnAgentWithDelegation(innerFn, deps);
    const result = await wrapped({
      description: '降级测试',
      prompt: '执行任务',
      subagentType: 'coder',
    });

    // 整体仍应成功（contextPacker 失败不阻塞）
    expect(result.success).toBe(true);
    expect(innerFn).toHaveBeenCalledTimes(1);
    // prompt 未被附加上下文（因 pack 失败降级）
    expect(innerFn.calls[0].prompt).toBe('执行任务');

    // lifecycle 仍注册并完成
    expect(lifecycle.getAll().length).toBe(1);
    expect(lifecycle.getAll()[0].status).toBe('completed');

    // scoreCard 仍收集
    expect(collector.size).toBe(1);
  });
});

// ============================================================
// 3. UI 组件端到端（命令触发 CommandBridge 回调）
// ============================================================

describe('Phase 50 Task 10 - UI 组件端到端', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('3.1 /resume 多快照 + resumePicker 开关开启时触发 showResumePicker 回调', async () => {
    // E11 更新：durableExecutor → GoalPersistence.listResumable
    const goals: PersistedGoal[] = [
      makeGoal({ id: 'plan-a', spec: { goal: '任务A', context: '', steps: [], done: '', verification: '' } }),
      makeGoal({ id: 'plan-b', spec: { goal: '任务B', context: '', steps: [], done: '', verification: '' } }),
    ];
    const { GoalPersistence } = await import('../../src/agent/goal-persistence.js');
    vi.spyOn(GoalPersistence.prototype, 'listResumable').mockResolvedValue(goals);
    const showResumePicker = vi.fn();
    const ctx = {
      cwd: '/tmp/test-routedev',
      commandBridge: {
        addSystemMessage: vi.fn(),
        showResumePicker,
      },
      config: {
        ui: {
          components: {
            resumePicker: true,
          },
        },
      },
    } as unknown as ServiceContext;

    const result = await resumeCommand.handler('', ctx);
    expect(result.type).toBe('handled');
    expect(showResumePicker).toHaveBeenCalledTimes(1);
    expect(showResumePicker).toHaveBeenCalledWith(goals);
  });

  it('3.2 /trace view tracePanel 开关开启时触发 showTracePanel 回调', async () => {
    const spans = [makeTraceSpan()];
    const showTracePanel = vi.fn();
    const ctx = {
      trace: {
        getSessionId: vi.fn(() => 'session-e2e'),
        getSpans: vi.fn(() => spans),
      },
      audit: {},
      tracker: {},
      commandBridge: {
        addSystemMessage: vi.fn(),
        showTracePanel,
      },
      config: {
        ui: {
          outputStyle: 'standard',
          components: {
            tracePanel: true,
          },
        },
      },
    } as unknown as ServiceContext;

    // /trace view 子命令才触发 TracePanel 组件渲染
    await traceCommand.handler('view', ctx);
    expect(showTracePanel).toHaveBeenCalledTimes(1);
  });

  it('3.3 /diff diffView 开关开启且有变更时触发 showDiffView 回调', async () => {
    // /diff 命令依赖 git，需在临时 git 仓库中测试
    const tmpDir = await makeTempDir();
    const { execSync } = await import('node:child_process');
    // 初始化临时 git 仓库并制造一个变更
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email test@test.com', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name test', { cwd: tmpDir, stdio: 'ignore' });
    fsSync.writeFileSync(path.join(tmpDir, 'file.txt'), 'initial\n');
    execSync('git add file.txt && git commit -m init', { cwd: tmpDir, stdio: 'ignore' });
    fsSync.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified\n');

    const showDiffView = vi.fn();
    const ctx = {
      cwd: tmpDir,
      commandBridge: {
        addSystemMessage: vi.fn(),
        showDiffView,
      },
      config: {
        ui: {
          components: {
            diffView: true,
          },
        },
      },
    } as unknown as ServiceContext;

    const result = await diffCommand.handler('', ctx);
    expect(result.type).toBe('handled');
    expect(showDiffView).toHaveBeenCalledTimes(1);
    // 第一个参数是 diff 文本
    expect(typeof showDiffView.mock.calls[0][0]).toBe('string');
    expect(showDiffView.mock.calls[0][0]).toContain('file.txt');

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });
});

// ============================================================
// 4. 死代码清理后构建通过（已删除文件不存在 + 关键模块可 import）
// ============================================================

describe('Phase 50 Task 10 - 死代码清理后构建通过', () => {
  // 18 个源文件 + 7 个 barrel 文件（Task 8 删除）
  const deletedFiles = [
    // 源文件
    'src/agent/types.ts',
    'src/router/reasoning-mode.ts',
    'src/utils/stall-detector.ts',
    'src/utils/error-messages.ts',
    'src/config/codegraph-manager.ts',
    'src/harness/tracing-executor.ts',
    // E11 移除：experiment-runner.ts 已重写为活代码（不再是死代码）
    'src/hooks/market-manager.ts',
    'src/hooks/generator.ts',
    'src/plugins/sdk.ts',
    'src/cli/wizard.tsx',
    // barrel 文件
    'src/cite/index.ts',
    'src/import/index.ts',
    'src/macros/index.ts',
    'src/mcp/index.ts',
    'src/skills/index.ts',
    'src/agent/patterns/index.ts',
    'src/evaluation/index.ts',
  ];

  it('4.1 所有已删除的源文件和 barrel 文件不再存在', () => {
    const errors: string[] = [];
    for (const file of deletedFiles) {
      try {
        expectFileNotToExist(file);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    expect(errors, `仍存在应已删除的文件:\n${errors.join('\n')}`).toEqual([]);
  });

  it('4.2 关键模块可动态 import（运行时代理 typecheck）', async () => {
    // 验证 Phase 50 接入的模块均可正常 import（间接验证无残留 broken import）
    const modules = [
      '../../src/agent/goal-audit.js',
      '../../src/agent/goal-persistence.js',
      '../../src/agent/goal-prompt-builder.js',
      '../../src/agent/requirement-change.js',
      '../../src/agent/multi/orchestrator.js',
      '../../src/agent/multi/orchestrator-strategy.js',
      '../../src/agent/multi/state-graph.js',
      '../../src/agents/context-packer.js',
      '../../src/agents/delegation-gate.js',
      '../../src/agents/delegation-enforcer.js',
      '../../src/agents/sub-agent-lifecycle.js',
      '../../src/agents/sub-agent-score-card.js',
      '../../src/tools/builtin/spawn-agent.js',
      '../../src/cli/commands/resume.js',
      '../../src/cli/commands/trace.js',
      '../../src/cli/commands/diff.js',
      '../../src/hooks/registry.js',
      '../../src/config/schema.js',
    ];
    for (const mod of modules) {
      await expect(import(mod)).resolves.toBeDefined();
    }
  });

  it('4.3 claude-plugin-importer 的 convertFromClaudeConfig bug 已修复', async () => {
    // Bug 1：原调用 bridge.convertFromClaudeConfig(...)，但该方法不存在 → 改为 importFromClaudeConfig
    // 验证实际调用点使用 importFromClaudeConfig（注释中保留旧名用于说明修复原因，属于预期）
    const source = await fs.readFile(
      path.join(projectRoot, 'src/import/claude-plugin-importer.ts'),
      'utf-8',
    );
    // 实际调用应使用 importFromClaudeConfig（await bridge.importFromClaudeConfig(...)）
    expect(source).toMatch(/await\s+bridge\.importFromClaudeConfig\(/);
    // 不应存在对 convertFromClaudeConfig 的实际调用（排除注释行）
    const codeLines = source.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    expect(codeOnly).not.toMatch(/bridge\.convertFromClaudeConfig\(/);
  });
});

// ============================================================
// 5. export 清理后构建通过（关键模块可 import）
// ============================================================

describe('Phase 50 Task 10 - export 清理后构建通过', () => {
  it('5.1 Phase 50 接入模块的 public API 仍可正常 import', async () => {
    // 验证 Task 9 export 清理后，被外部使用的 export 仍可正常导入
    const { GoalAuditor } = await import('../../src/agent/goal-audit.js');
    const { GoalPersistence } = await import('../../src/agent/goal-persistence.js');
    const { GoalPromptBuilder } = await import('../../src/agent/goal-prompt-builder.js');
    const { analyzeChangeImpact } = await import('../../src/agent/requirement-change.js');
    const { wrapSpawnAgentWithDelegation } = await import('../../src/tools/builtin/spawn-agent.js');
    const { ContextPacker } = await import('../../src/agents/context-packer.js');
    const { DelegationGate } = await import('../../src/agents/delegation-gate.js');
    const { SubAgentLifecycle } = await import('../../src/agents/sub-agent-lifecycle.js');
    const { SubAgentScoreCardCollector } = await import('../../src/agents/sub-agent-score-card.js');
    const { Orchestrator } = await import('../../src/agent/multi/orchestrator.js');
    const { StrategySelector } = await import('../../src/agent/multi/orchestrator-strategy.js');
    const { resumeCommand } = await import('../../src/cli/commands/resume.js');
    const { traceCommand } = await import('../../src/cli/commands/trace.js');
    const { diffCommand } = await import('../../src/cli/commands/diff.js');

    // 验证所有 import 都是定义的（非 undefined）
    expect(GoalAuditor).toBeDefined();
    expect(GoalPersistence).toBeDefined();
    expect(GoalPromptBuilder).toBeDefined();
    expect(analyzeChangeImpact).toBeDefined();
    expect(wrapSpawnAgentWithDelegation).toBeDefined();
    expect(ContextPacker).toBeDefined();
    expect(DelegationGate).toBeDefined();
    expect(SubAgentLifecycle).toBeDefined();
    expect(SubAgentScoreCardCollector).toBeDefined();
    expect(Orchestrator).toBeDefined();
    expect(StrategySelector).toBeDefined();
    expect(resumeCommand).toBeDefined();
    expect(traceCommand).toBeDefined();
    expect(diffCommand).toBeDefined();
  });

  it('5.2 配置 schema 包含 Phase 50 所有新增字段', async () => {
    const { AppConfigSchema } = await import('../../src/config/schema.js');
    const parsed = AppConfigSchema.parse({});

    // goalIntegration（Task 1）
    expect(parsed.goalIntegration).toBeDefined();
    // E11 更新：audit/persistence 默认值 Phase 47/54 修复为 true（功能必需）
    expect(parsed.goalIntegration.auditEnabled).toBe(true);
    expect(parsed.goalIntegration.persistenceEnabled).toBe(true);
    expect(parsed.goalIntegration.promptBuilderEnabled).toBe(false);
    expect(parsed.goalIntegration.requirementChangeEnabled).toBe(false);

    // orchestrationIntegration（Task 2）
    expect(parsed.orchestrationIntegration).toBeDefined();
    expect(parsed.orchestrationIntegration.strategyEnabled).toBe(false);
    expect(parsed.orchestrationIntegration.stateGraphEnabled).toBe(false);
    expect(parsed.orchestrationIntegration.branchOrchestrationEnabled).toBe(false);

    // delegationIntegration（Task 3）
    expect(parsed.delegationIntegration).toBeDefined();
    // E11 更新：5 个子开关默认值已修复为 true
    expect(parsed.delegationIntegration.contextPackerEnabled).toBe(true);
    expect(parsed.delegationIntegration.delegationGateEnabled).toBe(true);
    expect(parsed.delegationIntegration.delegationEnforcerEnabled).toBe(true);
    expect(parsed.delegationIntegration.lifecycleEnabled).toBe(true);
    expect(parsed.delegationIntegration.scoreCardEnabled).toBe(true);

    // ui.components（Task 7）
    expect(parsed.ui?.components).toBeDefined();
    expect(parsed.ui?.components?.branchSwitcher).toBe(true);
    expect(parsed.ui?.components?.resumePicker).toBe(true);
    expect(parsed.ui?.components?.progressBar).toBe(true);
    expect(parsed.ui?.components?.tracePanel).toBe(false);
    expect(parsed.ui?.components?.disclosureLevel).toBe(true);
    expect(parsed.ui?.components?.diffView).toBe(true);
    expect(parsed.ui?.components?.configReloadNotice).toBe(true);
  });
});
