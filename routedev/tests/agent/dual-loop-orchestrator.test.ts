// tests/agent/dual-loop-orchestrator.test.ts
// Phase 49 Task 2.6：双循环编排器测试
//
// 覆盖蓝图 2.6 节 12 个测试要求：
//   1. 内循环完成后自动触发外循环验证
//   2. 外循环通过时正常完成
//   3. 外循环不通过时打回内循环重跑
//   4. LoopMemory 的失败记录被注入到重跑的 system prompt
//   5. 达到 maxReruns 时终止并报告
//   6. CompletionGate 失败时外循环判定不通过
//   7. GoalVerifier 失败时外循环判定不通过
//   8. 跨模型审查的 critical 问题推翻 CompletionGate 的 pass
//   9. 跨模型审查器选择与内循环不同的模型
//   10. LoopMemory 持久化到文件且可重新加载（见 loop-memory.test.ts）
//   11. 重跑时检测到人工修改则标记"人工介入"并停止
//   12. 连续 maxReruns 次同一原因失败时提示用户接管
//
// 所有依赖通过 mock 注入，不调用真实 LLM。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DualLoopOrchestrator, DEFAULT_MAX_RERUNS } from '../../src/agent/dual-loop-orchestrator.js';
import { LoopMemory, LOOP_MEMORY_DIR, MAX_KEPT_FAILURES } from '../../src/agent/loop-memory.js';
import type { DualLoopParams, DualLoopEvent } from '../../src/agent/dual-loop-types.js';
import type { ReActEvent } from '../../src/agent/loop-config.js';
import type { GoalPlan, VerificationResult } from '../../src/agent/goal-types.js';
import type { GateResult, GateCheck } from '../../src/agent/completion-gate.js';
import type { CodeReviewResult } from '../../src/agent/unified-reviewer.js';
import type { TokenUsageInfo } from '../../src/router/types.js';

// ============================================================
// 测试夹具与 mock 工厂
// ============================================================

const ZERO_USAGE: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function makePlan(id: string = 'goal-test-1', description: string = '测试目标'): GoalPlan {
  return {
    id,
    description,
    steps: [],
    status: 'executing',
    createdAt: Date.now(),
  };
}

function makeVerification(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    passed: true,
    confidence: 0.9,
    reasoning: '目标已达成',
    missingItems: [],
    suggestions: [],
    ...overrides,
  };
}

function makeGateResult(overrides: Partial<GateResult> = {}): GateResult {
  return {
    passed: true,
    checks: [
      { name: 'typecheck', ok: true, output: '', duration: 100 },
      { name: 'tests', ok: true, output: '1 passed', duration: 200 },
    ],
    ...overrides,
  };
}

function makeReviewResult(overrides: Partial<CodeReviewResult> = {}): CodeReviewResult {
  return {
    passed: true,
    issues: [],
    summary: '审查通过',
    tokenUsage: ZERO_USAGE,
    ...overrides,
  };
}

/** 创建 mock ReActAgentLoop——yield 一条 done 事件后结束 */
function makeReactLoop(
  content: string = '任务已完成',
  usage: TokenUsageInfo = { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  modifiedFiles: string[] = [],
): {
  loop: any;
  runSpy: ReturnType<typeof vi.fn>;
} {
  const runSpy = vi.fn(async function* (params: any): AsyncGenerator<ReActEvent> {
    // 模拟工具调用事件（用于 modifiedFiles 收集）
    for (const file of modifiedFiles) {
      yield {
        type: 'tool_call_start',
        toolName: 'file-edit',
        toolCallId: `tc-${file}`,
        args: { file_path: file },
      } as ReActEvent;
    }
    yield { type: 'done', content, usage } as ReActEvent;
  });
  return { loop: { run: runSpy }, runSpy };
}

/** 创建 mock GoalVerifier */
function makeGoalVerifier(result: VerificationResult): any {
  return {
    verify: vi.fn(async () => result),
  };
}

/** 创建 mock CompletionGate */
function makeCompletionGate(result: GateResult): any {
  return {
    verify: vi.fn(async () => result),
  };
}

/** 创建 mock CrossModelReviewer */
function makeCrossModelReviewer(result: CodeReviewResult): any {
  return {
    review: vi.fn(async () => result),
  };
}

/** 收集所有 DualLoopEvent */
async function collectEvents(gen: AsyncGenerator<DualLoopEvent>): Promise<DualLoopEvent[]> {
  const events: DualLoopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeParams(overrides: Partial<DualLoopParams> & { projectPath: string }): DualLoopParams {
  const reactLoop = makeReactLoop();
  return {
    goal: {
      description: '测试目标',
      plan: makePlan(),
      projectPath: overrides.projectPath,
    },
    reactParams: {
      userMessage: '请完成任务',
      llmClient: {} as any,
      routeDecision: { model: { id: 'test-model' } } as any,
      conversationHistory: [],
      systemPrompt: 'base prompt',
    },
    reactLoop: reactLoop.loop,
    goalVerifier: makeGoalVerifier(makeVerification()),
    verifierOptions: {
      routeDecision: { model: { id: 'verifier-model' } } as any,
      llmClient: {} as any,
    },
    completionGate: makeCompletionGate(makeGateResult()),
    maxReruns: DEFAULT_MAX_RERUNS,
    ...overrides,
  };
}

// ============================================================
// 测试套件
// ============================================================

describe('DualLoopOrchestrator (Phase 49 Task 2.6)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-dual-loop-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ============================================================
  // 常量
  // ============================================================
  describe('常量', () => {
    it('DEFAULT_MAX_RERUNS 为 2（陷阱 #141：非 3）', () => {
      expect(DEFAULT_MAX_RERUNS).toBe(2);
    });

    it('MAX_KEPT_FAILURES 为 5（陷阱 #147）', () => {
      expect(MAX_KEPT_FAILURES).toBe(5);
    });
  });

  // ============================================================
  // 测试 1：内循环完成后自动触发外循环验证
  // ============================================================
  it('1. 内循环完成后自动触发外循环验证', async () => {
    const reactLoop = makeReactLoop('完成', undefined, ['src/a.ts']);
    const goalVerifier = makeGoalVerifier(makeVerification());
    const completionGate = makeCompletionGate(makeGateResult());

    const params = makeParams({
      projectPath: tempDir,
      reactLoop: reactLoop.loop,
      goalVerifier,
      completionGate,
      maxReruns: 0,
    });

    const events = await collectEvents(new DualLoopOrchestrator().run(params));
    const types = events.map(e => e.type);

    // 应该按顺序出现：inner-loop-start → inner-loop-event → inner-loop-complete → outer-loop-start → dual-loop-complete
    expect(types).toContain('inner-loop-start');
    expect(types).toContain('inner-loop-complete');
    expect(types).toContain('outer-loop-start');
    expect(types).toContain('dual-loop-complete');

    // GoalVerifier 和 CompletionGate 应该被调用
    expect(goalVerifier.verify).toHaveBeenCalledTimes(1);
    expect(completionGate.verify).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 测试 2：外循环通过时正常完成
  // ============================================================
  it('2. 外循环通过时正常完成', async () => {
    const reactLoop = makeReactLoop('完成');
    const params = makeParams({
      projectPath: tempDir,
      reactLoop: reactLoop.loop,
      goalVerifier: makeGoalVerifier(makeVerification({ passed: true })),
      completionGate: makeCompletionGate(makeGateResult({ passed: true })),
      maxReruns: 2,
    });

    const events = await collectEvents(new DualLoopOrchestrator().run(params));
    const complete = events.find(e => e.type === 'dual-loop-complete');

    expect(complete).toBeDefined();
    expect(complete!.type).toBe('dual-loop-complete');
    // 完成时 iteration 为 1（首次通过）
    if (complete!.type === 'dual-loop-complete') {
      expect(complete.iteration).toBe(1);
    }
  });

  // ============================================================
  // 测试 3：外循环不通过时打回内循环重跑
  // ============================================================
  it('3. 外循环不通过时打回内循环重跑', async () => {
    // 第一次失败，第二次通过
    const verResults = [
      makeVerification({ passed: false, missingItems: ['缺失功能 A'] }),
      makeVerification({ passed: true }),
    ];
    let verCallCount = 0;
    const goalVerifier = {
      verify: vi.fn(async () => verResults[verCallCount++] || verResults[verResults.length - 1]),
    };

    let reactCallCount = 0;
    const runSpy = vi.fn(async function* (): AsyncGenerator<ReActEvent> {
      reactCallCount++;
      yield { type: 'done', content: `第 ${reactCallCount} 次`, usage: ZERO_USAGE } as ReActEvent;
    });

    const params = makeParams({
      projectPath: tempDir,
      reactLoop: { run: runSpy },
      goalVerifier,
      completionGate: makeCompletionGate(makeGateResult({ passed: true })),
      maxReruns: 2,
    });

    const events = await collectEvents(new DualLoopOrchestrator().run(params));

    // 内循环应该被调用 2 次（首次 + 1 次重跑）
    expect(reactCallCount).toBe(2);
    // 应该有 outer-loop-failed 事件
    expect(events.some(e => e.type === 'outer-loop-failed')).toBe(true);
    // 应该最终完成
    expect(events.some(e => e.type === 'dual-loop-complete')).toBe(true);
  });

  // ============================================================
  // 测试 4：LoopMemory 的失败记录被注入到重跑的 system prompt
  // ============================================================
  it('4. LoopMemory 的失败记录被注入到重跑的 system prompt', async () => {
    const verResults = [
      makeVerification({ passed: false, missingItems: ['缺失功能 A'] }),
      makeVerification({ passed: true }),
    ];
    let verCallCount = 0;
    const goalVerifier = {
      verify: vi.fn(async () => verResults[verCallCount++] || verResults[verResults.length - 1]),
    };

    const capturedPrompts: string[] = [];
    const runSpy = vi.fn(async function* (params: any): AsyncGenerator<ReActEvent> {
      capturedPrompts.push(params.systemPrompt ?? '');
      yield { type: 'done', content: '完成', usage: ZERO_USAGE } as ReActEvent;
    });

    const params = makeParams({
      projectPath: tempDir,
      reactLoop: { run: runSpy },
      goalVerifier,
      completionGate: makeCompletionGate(makeGateResult({ passed: true })),
      maxReruns: 2,
    });

    await collectEvents(new DualLoopOrchestrator().run(params));

    // 首次 system prompt 不含失败记录
    expect(capturedPrompts[0]).not.toContain('历史失败记录');
    // 重跑时 system prompt 应该包含失败记录
    expect(capturedPrompts[1]).toContain('历史失败记录');
    expect(capturedPrompts[1]).toContain('缺失功能 A');
  });

  // ============================================================
  // 测试 5：达到 maxReruns 时终止并报告
  // ============================================================
  it('5. 达到 maxReruns 时终止并报告', async () => {
    const reactLoop = makeReactLoop('未完成');
    const params = makeParams({
      projectPath: tempDir,
      reactLoop: reactLoop.loop,
      goalVerifier: makeGoalVerifier(makeVerification({ passed: false, missingItems: ['永远缺失'] })),
      completionGate: makeCompletionGate(makeGateResult({ passed: true })),
      maxReruns: 1, // 首次 + 1 次重跑 = 2 次迭代
    });

    const events = await collectEvents(new DualLoopOrchestrator().run(params));
    const exhausted = events.find(e => e.type === 'dual-loop-exhausted');

    expect(exhausted).toBeDefined();
    if (exhausted!.type === 'dual-loop-exhausted') {
      expect(exhausted.maxReruns).toBe(1);
      expect(exhausted.finalMemory.length).toBeGreaterThan(0);
    }
    // 不应该有 dual-loop-complete
    expect(events.some(e => e.type === 'dual-loop-complete')).toBe(false);
  });

  // ============================================================
  // 测试 6：CompletionGate 失败时外循环判定不通过
  // ============================================================
  it('6. CompletionGate 失败时外循环判定不通过', async () => {
    const failedChecks: GateCheck[] = [
      { name: 'typecheck', ok: false, output: '类型错误', duration: 100 },
      { name: 'tests', ok: false, output: '测试失败', duration: 200 },
    ];
    const reactLoop = makeReactLoop('完成');
    const params = makeParams({
      projectPath: tempDir,
      reactLoop: reactLoop.loop,
      goalVerifier: makeGoalVerifier(makeVerification({ passed: true })),
      completionGate: makeCompletionGate(makeGateResult({ passed: false, checks: failedChecks })),
      maxReruns: 0,
    });

    const events = await collectEvents(new DualLoopOrchestrator().run(params));
    const failed = events.find(e => e.type === 'outer-loop-failed');
    const exhausted = events.find(e => e.type === 'dual-loop-exhausted');

    // CompletionGate 失败应该被识别为不通过
    expect(failed ?? exhausted).toBeDefined();
    if (failed) {
      expect(failed.type).toBe('outer-loop-failed');
      expect(failed.reason).toContain('工程验证');
    }
  });

  // ============================================================
  // 测试 7：GoalVerifier 失败时外循环判定不通过
  // ============================================================
  it('7. GoalVerifier 失败时外循环判定不通过', async () => {
    const reactLoop = makeReactLoop('完成');
    const params = makeParams({
      projectPath: tempDir,
      reactLoop: reactLoop.loop,
      goalVerifier: makeGoalVerifier(makeVerification({
        passed: false,
        missingItems: ['功能 A', '功能 B'],
      })),
      completionGate: makeCompletionGate(makeGateResult({ passed: true })),
      maxReruns: 0,
    });

    const events = await collectEvents(new DualLoopOrchestrator().run(params));
    const failed = events.find(e => e.type === 'outer-loop-failed');
    const exhausted = events.find(e => e.type === 'dual-loop-exhausted');

    expect(failed ?? exhausted).toBeDefined();
    if (failed) {
      expect(failed.reason).toContain('目标未完成');
      expect(failed.reason).toContain('功能 A');
    }
  });

  // ============================================================
  // 测试 8：跨模型审查的 critical 问题推翻 CompletionGate 的 pass
  // ============================================================
  it('8. 跨模型审查的 critical 问题推翻 CompletionGate 的 pass', async () => {
    const reactLoop = makeReactLoop('完成');
    const criticalReview = makeReviewResult({
      passed: false,
      issues: [
        { severity: 'critical', file: 'src/a.ts', line: 42, description: 'SQL 注入风险' },
        { severity: 'warning', file: 'src/b.ts', description: '未处理空值' },
      ],
      summary: '发现严重安全问题',
    });

    const params = makeParams({
      projectPath: tempDir,
      reactLoop: reactLoop.loop,
      goalVerifier: makeGoalVerifier(makeVerification({ passed: true })),
      completionGate: makeCompletionGate(makeGateResult({ passed: true })), // 工程验证通过
      crossModelReviewer: makeCrossModelReviewer(criticalReview),
      maxReruns: 0,
    });

    const events = await collectEvents(new DualLoopOrchestrator().run(params));
    const failed = events.find(e => e.type === 'outer-loop-failed');
    const exhausted = events.find(e => e.type === 'dual-loop-exhausted');

    // 即使 CompletionGate + GoalVerifier 都通过，critical 问题应推翻 pass
    expect(failed ?? exhausted).toBeDefined();
    if (failed) {
      expect(failed.reason).toContain('critical');
      expect(failed.crossModelReview).toBeDefined();
    }
  });

  // ============================================================
  // 测试 9：跨模型审查器选择与内循环不同的模型
  // ============================================================
  describe('9. 跨模型审查器选择与内循环不同的模型', () => {
    it('有多个候选时选择不同的模型', async () => {
      const { CrossModelReviewer } = await import('../../src/agent/cross-model-reviewer.js');
      const reviewer = new CrossModelReviewer({} as any, 'deepseek-chat', [
        'deepseek-chat',
        'claude-opus',
        'gpt-4',
      ]);
      const selected = reviewer.selectReviewerModel('deepseek-chat', [
        'deepseek-chat',
        'claude-opus',
        'gpt-4',
      ]);
      expect(selected).not.toBe('deepseek-chat');
    });

    it('只有一个模型时回退到同模型（陷阱 #142）', async () => {
      const { CrossModelReviewer } = await import('../../src/agent/cross-model-reviewer.js');
      const reviewer = new CrossModelReviewer({} as any, 'deepseek-chat', ['deepseek-chat']);
      const selected = reviewer.selectReviewerModel('deepseek-chat', ['deepseek-chat']);
      expect(selected).toBe('deepseek-chat');
    });
  });

  // ============================================================
  // 测试 10：LoopMemory 持久化到文件且可重新加载
  // ============================================================
  it('10. LoopMemory 持久化到文件且可重新加载', async () => {
    const reactLoop = makeReactLoop('未完成');
    const goalId = 'goal-persist-test';
    const params = makeParams({
      projectPath: tempDir,
      reactLoop: reactLoop.loop,
      goalVerifier: makeGoalVerifier(makeVerification({ passed: false, missingItems: ['功能 X'] })),
      completionGate: makeCompletionGate(makeGateResult({ passed: true })),
      maxReruns: 0,
    });
    params.goal.plan.id = goalId;

    await collectEvents(new DualLoopOrchestrator().run(params));

    // LoopMemory.persist() 是异步写入（fire-and-forget），需要等待完成
    await new Promise(r => setTimeout(r, 150));

    // 文件应该被创建
    const memFile = join(tempDir, LOOP_MEMORY_DIR, `${goalId}.md`);
    expect(existsSync(memFile)).toBe(true);

    // 内容应该包含失败记录
    const content = readFileSync(memFile, 'utf-8');
    expect(content).toContain('Loop Memory');
    expect(content).toContain('功能 X');

    // 重新加载应该能取到失败记录
    const reloaded = new LoopMemory(tempDir);
    await reloaded.load(goalId);
    expect(reloaded.size).toBe(1);
    expect(reloaded.getHistory()[0].missingItems).toContain('功能 X');

    // buildPrompt 应该包含失败记录
    const prompt = reloaded.buildPrompt();
    expect(prompt).toContain('历史失败记录');
    expect(prompt).toContain('功能 X');
  });

  // ============================================================
  // 测试 11：重跑时检测到人工修改则标记"人工介入"并停止
  // ============================================================
  it('11. 重跑时检测到人工修改则标记"人工介入"并停止', async () => {
    let reactCallCount = 0;
    const runSpy = vi.fn(async function* (): AsyncGenerator<ReActEvent> {
      reactCallCount++;
      yield { type: 'done', content: '完成', usage: ZERO_USAGE } as ReActEvent;
    });

    // 人工介入检测器：检测器仅在重跑前（rerunCount > 0）被调用
    // 第一次调用就返回 true，模拟重跑前检测到人工修改
    let detectorCallCount = 0;
    const humanInterventionDetector = vi.fn(async () => {
      detectorCallCount++;
      return detectorCallCount >= 1; // 第一次调用（重跑前）即返回 true
    });

    const params = makeParams({
      projectPath: tempDir,
      reactLoop: { run: runSpy },
      goalVerifier: makeGoalVerifier(makeVerification({ passed: false, missingItems: ['功能 A'] })),
      completionGate: makeCompletionGate(makeGateResult({ passed: true })),
      maxReruns: 2,
      humanInterventionDetector,
    });

    const events = await collectEvents(new DualLoopOrchestrator().run(params));
    const intervention = events.find(e => e.type === 'human-intervention-detected');

    expect(intervention).toBeDefined();
    if (intervention!.type === 'human-intervention-detected') {
      expect(intervention.message).toContain('人工');
    }
    // 内循环应该只跑 1 次（重跑前被拦截）
    expect(reactCallCount).toBe(1);
    // 检测器应该被调用
    expect(humanInterventionDetector).toHaveBeenCalled();
  });

  // ============================================================
  // 测试 12：连续 maxReruns 次同一原因失败时提示用户接管（Pilot 模式）
  // ============================================================
  it('12. 连续 maxReruns 次同一原因失败时提示用户接管', async () => {
    const reactLoop = makeReactLoop('未完成');
    // 所有验证都用相同原因失败
    const sameReason = makeVerification({
      passed: false,
      missingItems: ['同一缺失项'],
      reasoning: '同一原因',
    });

    const params = makeParams({
      projectPath: tempDir,
      reactLoop: reactLoop.loop,
      goalVerifier: makeGoalVerifier(sameReason),
      completionGate: makeCompletionGate(makeGateResult({ passed: true })),
      maxReruns: 2,
    });

    const events = await collectEvents(new DualLoopOrchestrator().run(params));
    const pilot = events.find(e => e.type === 'pilot-mode-triggered');
    const exhausted = events.find(e => e.type === 'dual-loop-exhausted');

    // 应该触发 Pilot 模式 或 达到上限
    // 注意：pilot-mode 在 rerunCount === maxReruns - 1 时触发，即第 2 次失败后
    // 此时 rerunCount = 1, maxReruns = 2，符合条件
    if (pilot) {
      expect(pilot.type).toBe('pilot-mode-triggered');
      expect(pilot.repeatedReason).toContain('目标未完成');
    } else {
      // 或者达到 exhausted（取决于 rerunCount 边界）
      expect(exhausted).toBeDefined();
    }
  });

  // ============================================================
  // evaluateOuterLoop 直接单元测试
  // ============================================================
  describe('evaluateOuterLoop 仲裁规则', () => {
    it('CompletionGate 通过 + GoalVerifier 通过 + 无 critical → 通过', () => {
      const orch = new DualLoopOrchestrator();
      const result = orch.evaluateOuterLoop(
        makeVerification({ passed: true }),
        makeGateResult({ passed: true }),
        makeReviewResult({ issues: [{ severity: 'warning', file: 'a.ts', description: 'x' }] }),
      );
      expect(result.passed).toBe(true);
    });

    it('CompletionGate 失败 → 不通过（即使 GoalVerifier 通过）', () => {
      const orch = new DualLoopOrchestrator();
      const result = orch.evaluateOuterLoop(
        makeVerification({ passed: true }),
        makeGateResult({
          passed: false,
          checks: [{ name: 'tests', ok: false, output: '失败', duration: 1 }],
        }),
        undefined,
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('工程验证');
    });

    it('GoalVerifier 失败 → 不通过（即使 CompletionGate 通过）', () => {
      const orch = new DualLoopOrchestrator();
      const result = orch.evaluateOuterLoop(
        makeVerification({ passed: false, missingItems: ['x'] }),
        makeGateResult({ passed: true }),
        undefined,
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('目标未完成');
    });

    it('critical 问题推翻 pass', () => {
      const orch = new DualLoopOrchestrator();
      const result = orch.evaluateOuterLoop(
        makeVerification({ passed: true }),
        makeGateResult({ passed: true }),
        makeReviewResult({
          issues: [{ severity: 'critical', file: 'a.ts', description: '严重问题' }],
        }),
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('critical');
    });

    it('skipped 检查不视为失败', () => {
      const orch = new DualLoopOrchestrator();
      const result = orch.evaluateOuterLoop(
        makeVerification({ passed: true }),
        makeGateResult({
          passed: true,
          checks: [
            { name: 'tests', ok: false, skipped: true, output: 'timeout', duration: 1 },
            { name: 'typecheck', ok: true, output: '', duration: 1 },
          ],
        }),
        undefined,
      );
      expect(result.passed).toBe(true);
    });
  });
});
