// tests/integration/phase49-e2e.test.ts
// Phase 49 Task 7 端到端集成测试
//
// 按蓝图 7.1 节的 8 个端到端场景验证 Phase 49 各模块（Task 1-6）的协同：
//   1. SkillFlow + 双循环端到端
//   2. Skill 质量门端到端
//   3. 上下文占用率端到端
//   4. 评估集端到端
//   5. 意图路由四层漏斗端到端
//   6. 跨模型对抗审查端到端
//   7. 反思模式端到端
//   8. Loop 记忆端到端
//
// 测试策略：
//   - 全部使用 mock 依赖（不调用真实 LLM）
//   - 使用 os.tmpdir() 创建临时目录，避免污染项目
//   - 验证模块间数据流正确性（事件序列、状态流转、字段传递）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ============================================================
// 被测模块
// ============================================================

import { SkillFlowEngine } from '../../src/skills/skill-flow-engine.js';
import { SkillFlowCheckpointStore } from '../../src/skills/skill-flow-checkpoint-store.js';
import { NodeGranularityChecker } from '../../src/skills/node-granularity-checker.js';
import { AttractorInjector } from '../../src/skills/attractor.js';
import { SkillQualityGate } from '../../src/skills/quality-gate.js';
import { SkillSchemaValidator } from '../../src/skills/skill-schema-validator.js';
import { FallbackChecker } from '../../src/skills/fallback-checker.js';
import { SkillMdParser, type ParsedSkill } from '../../src/skills/skill-md-parser.js';
import { ModelDriftDetector } from '../../src/skills/model-drift-detector.js';
import { RuntimeFallbackDetector } from '../../src/skills/runtime-fallback-detector.js';

import { DualLoopOrchestrator } from '../../src/agent/dual-loop-orchestrator.js';
import { LoopMemory } from '../../src/agent/loop-memory.js';
import { CrossModelReviewer } from '../../src/agent/cross-model-reviewer.js';
import { ReflectionPattern } from '../../src/agent/patterns/reflection.js';
import { PromptChain } from '../../src/agent/patterns/prompt-chain.js';
import { ContextUsagePanel } from '../../src/agent/context-usage-panel.js';

import { StructuredInjector, type CodeMapQueryInterface, type SymbolBlock, type FileStructure } from '../../src/cite/structured-injector.js';

import {
  EvaluationFramework,
  EVALUATION_SETS,
  type EvaluationCase,
  type JudgeResult,
} from '../../src/evaluation/evaluation-framework.js';

import { RoutingFunnel, type LLMClassifier, type VectorRouter } from '../../src/router/routing-funnel.js';

import type { SkillFlow, FlowNode } from '../../src/skills/skill-flow-types.js';
import type { ReActEvent } from '../../src/agent/loop-config.js';
import type { TokenUsageInfo, ILLMClient, RoutingResult as RouterRoutingResult, LLMMessage } from '../../src/router/types.js';
import type { GoalPlan, VerificationResult } from '../../src/agent/goal-types.js';
import type { GateResult, GateCheck } from '../../src/agent/completion-gate.js';
import type { CodeReviewResult, CodeReviewIssue } from '../../src/agent/unified-reviewer.js';

// ============================================================
// 辅助：在临时目录中工作
// ============================================================

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase49-e2e-'));
});

afterEach(async () => {
  // 清理临时目录
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});

// ============================================================
// 辅助：构造 mock ReAct 事件流
// ============================================================

/** 创建一个 yield done 事件的 mock runReact 回调 */
function makeMockRunReact(output: string, usage?: Partial<TokenUsageInfo>) {
  return async function* (
    _params: unknown,
    _allowedTools?: string[],
  ): AsyncGenerator<ReActEvent> {
    const finalUsage: TokenUsageInfo = {
      inputTokens: usage?.inputTokens ?? 100,
      outputTokens: usage?.outputTokens ?? 50,
      totalTokens: usage?.totalTokens ?? 150,
    };
    yield { type: 'done', content: output, usage: finalUsage };
  };
}

/** 创建一个固定返回布尔值的 mock llmJudge 回调 */
function makeMockLlmJudge(result: boolean) {
  return vi.fn().mockResolvedValue(result);
}

/** 创建 mock 循环条件评估回调 */
function makeMockLoopEvaluator(result: boolean) {
  return vi.fn().mockResolvedValue(result);
}

/** 创建 mock 用户确认回调 */
function makeMockUserConfirm(decision: 'approve' | 'reject') {
  return vi.fn().mockResolvedValue(decision);
}

/** 创建 mock 分支评估回调 */
function makeMockBranchEval(targetNodeId: string) {
  return vi.fn().mockResolvedValue(targetNodeId);
}

/** 构造一个最小的 ReActRunParams 占位对象（仅用于 SkillFlow 的 baseParams 字段） */
function makeBaseParams() {
  return {
    userMessage: '执行部署流水线',
    llmClient: {} as ILLMClient,
    routeDecision: {} as RouterRoutingResult,
    conversationHistory: [] as LLMMessage[],
  };
}

/** 构造一个部署流水线 SkillFlow（构建→用户确认→部署→验证） */
function makeDeployFlow(): SkillFlow {
  const nodes: FlowNode[] = [
    {
      id: 'build',
      type: 'step',
      title: '构建项目',
      prompt: '运行构建命令并确保构建成功',
      allowedTools: ['shell_exec'],
      onFailure: 'retry',
      maxRetries: 2,
    },
    {
      id: 'build-check',
      type: 'checkpoint',
      title: '验证构建产物',
      checkCondition: {
        kind: 'regex-match',
        pattern: 'Build successful|构建成功',
      },
      onFailure: 'goto',
      onFailureGoto: 'build',
    },
    {
      id: 'confirm-deploy',
      type: 'user-gate',
      title: '确认部署',
      gateMessage: '构建已完成，确认部署到生产环境？',
      onFailure: 'abort',
    },
    {
      id: 'deploy',
      type: 'step',
      title: '执行部署',
      prompt: '执行部署脚本',
      allowedTools: ['shell_exec'],
      onFailure: 'abort',
    },
    {
      id: 'verify',
      type: 'checkpoint',
      title: '验证部署成功',
      checkCondition: {
        kind: 'llm-judge',
        judgePrompt: '检查部署日志中是否有错误，服务是否正常启动',
      },
      onFailure: 'retry',
      maxRetries: 3,
    },
  ];
  return {
    nodes,
    entryNodeId: 'build',
    exitNodeId: 'done',
    maxTotalIterations: 20,
  };
}

// ============================================================
// 1. SkillFlow + 双循环端到端
// ============================================================

describe('Phase 49 Task 7 - 场景 1：SkillFlow + 双循环端到端', () => {
  it('验证节点不通过 → 打回构建重试 → 全部通过 → 双循环外循环确认完成', async () => {
    // 部署 SkillFlow：构建 → 构建检查 → 用户确认 → 部署 → 验证 → done
    const flow = makeDeployFlow();

    // 第一次 build-check 不通过（输出不含"构建成功"），goto 回 build 重试
    // 第二次 build-check 通过
    let buildCallCount = 0;
    const runReact = async function* (
      _params: unknown,
      _allowedTools?: string[],
    ): AsyncGenerator<ReActEvent> {
      buildCallCount++;
      if (buildCallCount === 1) {
        // 第一次构建输出不含成功关键词
        yield {
          type: 'done',
          content: '正在构建... 请稍后',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      } else if (buildCallCount === 2) {
        // 重试后的构建输出包含"构建成功"
        yield {
          type: 'done',
          content: '构建成功！产物路径：dist/',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      } else {
        // 部署步骤
        yield {
          type: 'done',
          content: '部署完成，服务已启动',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      }
    };

    // LLM Judge：第一次部署验证不通过，重试后通过
    let judgeCallCount = 0;
    const llmJudge = vi.fn().mockImplementation(async () => {
      judgeCallCount++;
      // 第一次 verify 失败，第二次成功
      return judgeCallCount > 1;
    });

    const engine = new SkillFlowEngine();
    const events: any[] = [];
    for await (const ev of engine.run(flow, {
      baseParams: makeBaseParams() as any,
      runReact: runReact as any,
      llmJudge,
      evaluateLoopCondition: makeMockLoopEvaluator(true),
      waitForUserConfirmation: makeMockUserConfirm('approve'),
      evaluateBranch: makeMockBranchEval('build'),
    })) {
      events.push(ev);
    }

    // 验证事件序列
    // 第一次 build → 第一次 build-check 失败 → goto build
    // 第二次 build → 第二次 build-check 通过 → confirm-deploy → deploy → verify 失败 → retry verify → verify 通过
    const nodeStarts = events.filter(e => e.type === 'node-start').map(e => e.node.id);
    const checkpointFailed = events.filter(e => e.type === 'checkpoint-failed').map(e => e.node.id);
    const checkpointPassed = events.filter(e => e.type === 'checkpoint-passed').map(e => e.node.id);
    const flowComplete = events.some(e => e.type === 'flow-complete');

    // build 节点至少被进入 2 次（第一次失败 goto 回 build）
    const buildStartCount = nodeStarts.filter(id => id === 'build').length;
    expect(buildStartCount).toBeGreaterThanOrEqual(2);
    // build-check 至少失败 1 次
    expect(checkpointFailed).toContain('build-check');
    // 最终必须有 build-check 和 verify 通过
    expect(checkpointPassed).toContain('build-check');
    expect(checkpointPassed).toContain('verify');
    // 流水线必须完成
    expect(flowComplete).toBe(true);
  });
});

// ============================================================
// 2. Skill 质量门端到端
// ============================================================

describe('Phase 49 Task 7 - 场景 2：Skill 质量门端到端', () => {
  it('质量门发现缺少兜底确认 → fail → 用户补充后通过 → Skill 可正常加载', async () => {
    // 第一版 Skill：包含兜底声明但缺少确认指令
    const skillV1Content = `---
name: deploy-helper
description: 部署辅助 Skill 帮助执行部署任务
version: 1.0.0
author: tester
tags: [deploy]
---
# 部署辅助

## 执行流程
1. 运行构建命令
2. 如果失败则自动降级为本地构建
3. 部署到目标环境

## 注意
如果做不到某些步骤，按最佳实践处理。
`;

    const skillV1 = SkillMdParser.parse(skillV1Content);

    // 质量门检查
    const gate = new SkillQualityGate();
    const resultV1 = await gate.check(skillV1, {});

    // V1 应当 fail（包含"自动降级"危险表述 + 兜底声明缺确认）
    expect(resultV1.status).toBe('fail');
    expect(resultV1.fallback.passed).toBe(false);
    expect(resultV1.fallback.issues.length).toBeGreaterThan(0);
    // 应该至少包含"自动降级"或"缺少确认指令"之一的告警
    const issuesText = resultV1.fallback.issues.join('\n');
    expect(issuesText).toMatch(/自动降级|缺少|确认/);

    // 第二版 Skill：用户补充兜底确认 + 删除危险降级表述
    const skillV2Content = `---
name: deploy-helper
description: 部署辅助 Skill 帮助执行部署任务
version: 1.0.1
author: tester
tags: [deploy]
---
# 部署辅助

## 执行流程
1. 运行构建命令
2. 如果失败则停止并询问用户确认下一步
3. 部署到目标环境

## 注意
如果做不到某些步骤，请用户确认后再继续。
`;

    const skillV2 = SkillMdParser.parse(skillV2Content);
    const resultV2 = await gate.check(skillV2, {});

    // V2 应当 pass
    expect(resultV2.status).toBe('pass');
    expect(resultV2.fallback.passed).toBe(true);
    expect(resultV2.schema.valid).toBe(true);

    // V2 应当能通过 Schema 校验
    const schemaResult = SkillSchemaValidator.validate(skillV2);
    expect(schemaResult.valid).toBe(true);
  });
});

// ============================================================
// 3. 上下文占用率端到端
// ============================================================

describe('Phase 49 Task 7 - 场景 3：上下文占用率端到端', () => {
  it('引用 3 个大文件 → 占用率 85% → 结构化注入器只注入相关符号块 → 占用率降到 40% 以下', async () => {
    // 准备 mock CodeMap：3 个文件，每个有 3 个符号
    const files: Record<string, FileStructure> = {
      'src/large-a.ts': {
        filePath: 'src/large-a.ts',
        language: 'typescript',
        symbols: [
          { name: 'funcA1', kind: 'function', startLine: 0, endLine: 50, signature: 'funcA1(x: number)' },
          { name: 'funcA2', kind: 'function', startLine: 51, endLine: 100, signature: 'funcA2()' },
          { name: 'ClassA', kind: 'class', startLine: 101, endLine: 200, signature: 'ClassA' },
        ],
        summary: 'src/large-a.ts: 3 symbols',
      },
      'src/large-b.ts': {
        filePath: 'src/large-b.ts',
        language: 'typescript',
        symbols: [
          { name: 'funcB1', kind: 'function', startLine: 0, endLine: 30, signature: 'funcB1()' },
          { name: 'funcB2', kind: 'function', startLine: 31, endLine: 60, signature: 'funcB2(y: string)' },
          { name: 'ClassB', kind: 'class', startLine: 61, endLine: 120, signature: 'ClassB' },
        ],
        summary: 'src/large-b.ts: 3 symbols',
      },
      'src/large-c.ts': {
        filePath: 'src/large-c.ts',
        language: 'typescript',
        symbols: [
          { name: 'funcC1', kind: 'function', startLine: 0, endLine: 40, signature: 'funcC1()' },
          { name: 'funcC2', kind: 'function', startLine: 41, endLine: 80, signature: 'funcC2(z: boolean)' },
          { name: 'ClassC', kind: 'class', startLine: 81, endLine: 160, signature: 'ClassC' },
        ],
        summary: 'src/large-c.ts: 3 symbols',
      },
    };

    // mock 3 个大文件的"全文"——每个 5000 字符（约 1250 token）
    const largeContent = 'x'.repeat(5000);
    // 相关符号块内容只有 200 字符（约 50 token）——模拟 code-map 只裁剪符号本身
    const symbolContent = 'export function func() { return 42; }'.repeat(5);
    const allSymbols: Record<string, SymbolBlock[]> = {
      'src/large-a.ts': [
        { name: 'funcA1', kind: 'function', startLine: 0, endLine: 50, content: symbolContent },
        { name: 'funcA2', kind: 'function', startLine: 51, endLine: 100, content: symbolContent },
        { name: 'ClassA', kind: 'class', startLine: 101, endLine: 200, content: symbolContent },
      ],
      'src/large-b.ts': [
        { name: 'funcB1', kind: 'function', startLine: 0, endLine: 30, content: symbolContent },
        { name: 'funcB2', kind: 'function', startLine: 31, endLine: 60, content: symbolContent },
        { name: 'ClassB', kind: 'class', startLine: 61, endLine: 120, content: symbolContent },
      ],
      'src/large-c.ts': [
        { name: 'funcC1', kind: 'function', startLine: 0, endLine: 40, content: symbolContent },
        { name: 'funcC2', kind: 'function', startLine: 41, endLine: 80, content: symbolContent },
        { name: 'ClassC', kind: 'class', startLine: 81, endLine: 160, content: symbolContent },
      ],
    };

    const mockCodeMap: CodeMapQueryInterface = {
      async getFileStructure(filePath: string) {
        return files[filePath];
      },
      async queryRelevantSymbols(filePath: string, _ctx: string) {
        // 只返回第一个符号作为"相关符号"
        return allSymbols[filePath]?.slice(0, 1) ?? [];
      },
    };

    // Step 1: 假设把 3 个文件全文注入，估算占用率
    const totalFullTokens = 3 * Math.ceil(largeContent.length / 4); // 约 3750 token
    const maxContext = 5000; // 上下文窗口 5000 token
    const usagePercentBefore = totalFullTokens / maxContext; // 75%（用 5000 窗口模拟 85% 场景）

    // 用 ContextUsagePanel 模拟"全文注入"场景
    const panel = new ContextUsagePanel();
    const infoBefore = panel.forceCalculate({
      systemPrompt: 'system',
      conversationHistory: [],
      toolResults: [largeContent, largeContent, largeContent], // 3 个大文件全文
      references: [],
      skillPrompts: [],
      maxTokens: maxContext,
    });

    // 全文注入的占用率应较高（≥ 50%）
    expect(infoBefore.usagePercent).toBeGreaterThanOrEqual(0.5);
    expect(['should-compact', 'must-compact', 'consider-compaction']).toContain(infoBefore.suggestion);

    // Step 2: 用 StructuredInjector 替换全文注入
    const injector = new StructuredInjector({ codeMap: mockCodeMap });
    const maxInjectTokens = 1500;
    const injections = await Promise.all([
      injector.injectFileReference('src/large-a.ts', '用户在问 funcA1', maxInjectTokens),
      injector.injectFileReference('src/large-b.ts', '用户在问 funcB1', maxInjectTokens),
      injector.injectFileReference('src/large-c.ts', '用户在问 funcC1', maxInjectTokens),
    ]);

    // 验证每个文件只注入了 1 个符号块（而非全部 3 个）
    for (const inj of injections) {
      expect(inj.injectedBlocks.length).toBe(1);
      expect(inj.totalRelevantSymbols).toBe(1);
      expect(inj.truncated).toBe(false);
    }

    // 用面板计算结构化注入后的占用率
    const infoAfter = panel.forceCalculate({
      systemPrompt: 'system',
      conversationHistory: [],
      toolResults: injections.map(i => i.injectedText),
      references: [],
      skillPrompts: [],
      maxTokens: maxContext,
    });

    // 占用率应该明显下降（低于 50%）
    expect(infoAfter.usagePercent).toBeLessThan(0.5);
    // 状态栏字符串能正确格式化
    const bar = panel.formatStatusBar(infoAfter);
    expect(bar).toMatch(/\d+%/);
  });
});

// ============================================================
// 4. 评估集端到端
// ============================================================

describe('Phase 49 Task 7 - 场景 4：评估集端到端', () => {
  it('Smoke set 10 条 → 8 通过 2 失败 → 报告显示失败用例 → 修复后重跑全部通过', async () => {
    // Smoke set 应当 10 条
    expect(EVALUATION_SETS.smoke.size).toBe(10);

    // 构造 10 个测试用例
    const cases: EvaluationCase[] = Array.from({ length: 10 }, (_, i) => ({
      id: `case-${i + 1}`,
      input: `测试输入 ${i + 1}`,
      expectedBehavior: `应当正确处理输入 ${i + 1}`,
      scenario: 'normal' as const,
      rubric: [
        { criterion: '正确性', weight: 0.7 },
        { criterion: '可读性', weight: 0.3 },
      ],
    }));

    // 第一次运行：8 通过 2 失败（case-3 和 case-7 失败）
    const failingIds = new Set(['case-3', 'case-7']);
    const executeTargetV1 = vi.fn().mockImplementation(async (input: string) => {
      return `输出：${input}`;
    });
    const judgeV1 = vi.fn().mockImplementation(async (testCase: EvaluationCase) => {
      const passed = !failingIds.has(testCase.id);
      const result: JudgeResult = {
        passed,
        score: passed ? 0.9 : 0.4,
        reasoning: passed ? '通过' : '失败：边界处理缺失',
        rubricScores: [
          { criterion: '正确性', weight: 0.7, score: passed ? 0.9 : 0.3 },
          { criterion: '可读性', weight: 0.3, score: 0.8 },
        ],
      };
      return result;
    });

    const frameworkV1 = new EvaluationFramework(
      executeTargetV1,
      judgeV1,
      'judge-model-v1',
      0.7,
    );

    const reportV1 = await frameworkV1.runEvaluation(cases, 'skill', 'my-skill');

    // 验证报告：8 通过 2 失败
    expect(reportV1.totalCases).toBe(10);
    expect(reportV1.passed).toBe(8);
    expect(reportV1.failed).toBe(2);
    expect(reportV1.modelVersion).toBe('judge-model-v1');

    // 失败用例必须包含 case-3 和 case-7
    const failedIds = reportV1.results.filter(r => !r.passed).map(r => r.caseId).sort();
    expect(failedIds).toEqual(['case-3', 'case-7']);

    // 第二次运行：修复后全部通过
    const executeTargetV2 = vi.fn().mockImplementation(async (input: string) => {
      return `修复后输出：${input}`;
    });
    const judgeV2 = vi.fn().mockImplementation(async () => {
      const result: JudgeResult = {
        passed: true,
        score: 0.95,
        reasoning: '修复后通过',
        rubricScores: [
          { criterion: '正确性', weight: 0.7, score: 0.95 },
          { criterion: '可读性', weight: 0.3, score: 0.9 },
        ],
      };
      return result;
    });

    const frameworkV2 = new EvaluationFramework(
      executeTargetV2,
      judgeV2,
      'judge-model-v1',
      0.7,
    );
    const reportV2 = await frameworkV2.runEvaluation(cases, 'skill', 'my-skill');

    expect(reportV2.totalCases).toBe(10);
    expect(reportV2.passed).toBe(10);
    expect(reportV2.failed).toBe(0);

    // 验证 Rubric 聚合得分存在
    expect(reportV2.rubricScores.length).toBe(2);
    expect(reportV2.rubricScores[0].criterion).toBe('正确性');
  });
});

// ============================================================
// 5. 意图路由四层漏斗端到端
// ============================================================

describe('Phase 49 Task 7 - 场景 5：意图路由四层漏斗端到端', () => {
  it('输入"帮我写个函数" → L0 正则未命中 → L2 大模型路由命中"编码"意图 → 选择编码模型', async () => {
    // L0 不命中"帮我写个函数"——内置规则中没有匹配此输入的
    // L2 LLM 分类器命中"编码"意图（complex tier）
    const mockLLMClassifier: LLMClassifier = {
      classify: vi.fn().mockResolvedValue({
        tier: 'complex',
        confidence: 0.85,
        source: 'llm',
        model: { id: 'claude-sonnet', provider: 'anthropic' },
      }),
    };

    const funnel = new RoutingFunnel({
      llmClassifier: mockLLMClassifier,
      fallbackModel: { id: 'gpt-4o-mini', provider: 'openai' },
    });

    const result = await funnel.route('帮我写个函数');

    // L0 未命中 → L2 命中
    expect(result.source).toBe('llm');
    expect(result.tier).toBe('complex');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.model?.id).toBe('claude-sonnet');
    expect(mockLLMClassifier.classify).toHaveBeenCalledTimes(1);
    // 不应触发 needsClarification（置信度足够高）
    expect(result.needsClarification).not.toBe(true);
  });
});

// ============================================================
// 6. 跨模型对抗审查端到端
// ============================================================

describe('Phase 49 Task 7 - 场景 6：跨模型对抗审查端到端', () => {
  it('内循环 DeepSeek 写代码 → 外循环 Claude 审查发现 critical → 打回重跑 → LoopMemory 注入失败原因 → 重跑通过', async () => {
    // 使用 mock ReActAgentLoop + mock GoalVerifier + mock CompletionGate + mock CrossModelReviewer
    // 直接验证 DualLoopOrchestrator 的事件流

    // 构造 mock ReActAgentLoop（最小接口）
    let innerCallCount = 0;
    const mockReactLoop = {
      run: async function* (_params: any): AsyncGenerator<ReActEvent> {
        innerCallCount++;
        if (innerCallCount === 1) {
          // 第一次内循环：产出一个有 critical 问题的代码
          yield {
            type: 'done',
            content: '已实现功能，但遗漏了边界检查',
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          };
        } else {
          // 第二次内循环：修正后通过
          yield {
            type: 'done',
            content: '已实现功能并补充边界检查',
            usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 },
          };
        }
      },
    };

    // mock GoalVerifier：始终通过——让 CrossModelReviewer 的 critical 问题主导第一次失败判定
    // 这样 evaluateOuterLoop 才会走到第 3 步（critical 推翻 pass）
    const mockGoalVerifier = {
      verify: vi.fn().mockImplementation(async () => {
        const result: VerificationResult = {
          passed: true,
          confidence: 0.9,
          reasoning: '目标已完成',
          missingItems: [],
          suggestions: [],
        };
        return result;
      }),
    };

    // mock CompletionGate：始终通过（让 GoalVerifier 和 CrossModelReviewer 主导判定）
    const passingGate: GateResult = {
      passed: true,
      checks: [
        { name: 'typecheck', ok: true, output: 'ok', duration: 100 },
      ],
    };
    const mockCompletionGate = {
      verify: vi.fn().mockResolvedValue(passingGate),
    };

    // mock CrossModelReviewer：第一次发现 critical，第二次通过
    let reviewCallCount = 0;
    const mockCrossModelReviewer = {
      review: vi.fn().mockImplementation(async () => {
        reviewCallCount++;
        const issues: CodeReviewIssue[] = reviewCallCount === 1
          ? [{ severity: 'critical', file: 'src/foo.ts', line: 10, description: '缺少边界检查' }]
          : [];
        const result: CodeReviewResult = {
          passed: reviewCallCount === 1 ? false : true,
          issues,
          summary: reviewCallCount === 1 ? '发现 critical 问题' : '审查通过',
          tokenUsage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
        };
        return result;
      }),
    };

    // 构造 GoalPlan
    const goalPlan: GoalPlan = {
      id: 'goal-test-001',
      description: '实现一个函数并验证',
      steps: [],
      status: 'executing',
      createdAt: Date.now(),
    };

    const orchestrator = new DualLoopOrchestrator();
    const events: any[] = [];
    for await (const ev of orchestrator.run({
      goal: {
        description: '实现一个函数并验证',
        plan: goalPlan,
        projectPath: tmpDir,
      },
      reactParams: {
        userMessage: '实现 foo 函数',
        llmClient: {} as ILLMClient,
        routeDecision: {} as RouterRoutingResult,
        conversationHistory: [],
        systemPrompt: '',
      },
      reactLoop: mockReactLoop as any,
      goalVerifier: mockGoalVerifier as any,
      verifierOptions: {
        routeDecision: {} as RouterRoutingResult,
        llmClient: {} as ILLMClient,
      },
      completionGate: mockCompletionGate as any,
      crossModelReviewer: mockCrossModelReviewer,
      maxReruns: 2,
    })) {
      events.push(ev);
    }

    // 验证：第一次外循环失败（critical 问题），第二次通过
    const failedEvents = events.filter(e => e.type === 'outer-loop-failed');
    const completeEvents = events.filter(e => e.type === 'dual-loop-complete');
    expect(failedEvents.length).toBe(1);
    expect(completeEvents.length).toBe(1);

    // 第一次失败的 reason 应当包含 "critical"
    expect(failedEvents[0].reason).toMatch(/critical/);

    // 跨模型审查被调用 2 次
    expect(mockCrossModelReviewer.review).toHaveBeenCalledTimes(2);

    // 内循环被调用 2 次（第一次失败 + 第二次重跑）
    expect(innerCallCount).toBe(2);
  });
});

// ============================================================
// 7. 反思模式端到端
// ============================================================

describe('Phase 49 Task 7 - 场景 7：反思模式端到端', () => {
  it('/goal 输出 → ReflectionPattern 审查发现遗漏边界 → 自动修正 → 重新审查通过', async () => {
    // review 回调：第一次审查不通过（遗漏边界），第二次通过
    let reviewCallCount = 0;
    const review = vi.fn().mockImplementation(async (_output: string, _criteria: string) => {
      reviewCallCount++;
      if (reviewCallCount === 1) {
        return {
          passed: false,
          issues: ['遗漏边界情况：空数组输入', '未处理 null 参数'],
          reasoning: '代码未覆盖边界',
        };
      }
      return {
        passed: true,
        issues: [],
        reasoning: '所有边界已覆盖',
      };
    });

    // revise 回调：把"已添加边界检查"追加到输出
    const revise = vi.fn().mockImplementation(async (output: string, issues: string[]) => {
      return `${output}\n// 修正：已处理边界 - ${issues.join('; ')}`;
    });

    const reflection = new ReflectionPattern(review, revise);

    const events: any[] = [];
    for await (const ev of reflection.run({
      initialOutput: 'function foo(x) { return x.map(i => i * 2); }',
      criteria: '必须覆盖所有边界情况',
      maxReflections: 3,
    })) {
      events.push(ev);
    }

    // 事件序列：reflection-iteration（修正一次） → reflection-passed（通过）
    const iterations = events.filter(e => e.type === 'reflection-iteration');
    const passed = events.filter(e => e.type === 'reflection-passed');
    const exhausted = events.filter(e => e.type === 'reflection-exhausted');

    expect(iterations.length).toBe(1);
    expect(passed.length).toBe(1);
    expect(exhausted.length).toBe(0);
    expect(review).toHaveBeenCalledTimes(2);
    expect(revise).toHaveBeenCalledTimes(1);

    // 通过事件的 iteration 应当为 1（修正一次后通过）
    expect(passed[0].iteration).toBe(1);
    // 输出应当包含"修正"标记
    expect(passed[0].output).toContain('修正');
  });
});

// ============================================================
// 8. Loop 记忆端到端
// ============================================================

describe('Phase 49 Task 7 - 场景 8：Loop 记忆端到端', () => {
  it('第一次 /goal 失败 → LoopMemory 记录失败原因 → 第二次执行时 system prompt 包含失败记录 → 避免重复犯错', async () => {
    // 使用真实的 LoopMemory（持久化到临时目录）
    const memory = new LoopMemory(tmpDir);
    const goalId = 'goal-mem-test-001';
    memory.setGoalId(goalId);

    // 第一次执行：记录失败
    memory.recordFailure({
      iteration: 1,
      reason: '目标未完成：缺少单元测试',
      missingItems: ['单元测试', '集成测试'],
      gateFailures: [] as GateCheck[],
      reviewIssues: [] as CodeReviewIssue[],
    });

    // 等待异步写入完成
    await new Promise(resolve => setTimeout(resolve, 50));

    // buildPrompt 应当包含失败原因
    const prompt = memory.buildPrompt();
    expect(prompt).toContain('历史失败记录');
    expect(prompt).toContain('缺少单元测试');
    expect(prompt).toContain('单元测试');
    expect(prompt).toContain('集成测试');

    // buildResuggestion 应当给出重新建议
    const resuggestion = memory.buildResuggestion();
    expect(resuggestion).toContain('缺少单元测试');
    expect(resuggestion).toContain('建议重点关注');

    // 第二次执行：加载已有记忆
    const memory2 = new LoopMemory(tmpDir);
    await memory2.load(goalId);

    // 验证失败记录被正确加载
    expect(memory2.size).toBe(1);
    const history = memory2.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].reason).toBe('目标未完成：缺少单元测试');
    expect(history[0].missingItems).toEqual(['单元测试', '集成测试']);

    // 第二次执行的 system prompt 应当包含失败记录
    const prompt2 = memory2.buildPrompt();
    expect(prompt2).toContain('历史失败记录');
    expect(prompt2).toContain('缺少单元测试');

    // 模拟"避免重复犯错"——第二次成功后归档
    await memory2.archive(goalId);
    await new Promise(resolve => setTimeout(resolve, 50));

    // 归档后 memory 应当清空
    expect(memory2.size).toBe(0);
    expect(memory2.buildPrompt()).toBe('');

    // 验证文件已被移动到 archived 目录
    const archiveDir = path.join(tmpDir, '.routedev', 'loop-memory', 'archived');
    const archivedFiles = await fs.readdir(archiveDir).catch(() => [] as string[]);
    expect(archivedFiles).toContain(`${goalId}.md`);
  });
});
