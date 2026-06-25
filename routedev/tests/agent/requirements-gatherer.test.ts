// tests/agent/requirements-gatherer.test.ts
// Phase 31 Task 2：RequirementsGatherer 单元测试
// 覆盖：需求摘要生成、澄清问题生成、跳过条件、LLM 失败降级

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequirementsGatherer } from '../../src/agent/requirements-gatherer.js';
import type { ClassificationResult, ILLMClient, LLMResponse, RoutingResult } from '../../src/router/types.js';
import type { ClarifyingQuestion } from '../../src/agent/task-orchestrator-types.js';

// --- Mock 工厂 ---

function makeClassificationResult(
  tier: 'simple' | 'medium' | 'complex' | 'reasoning',
  confidence = 0.8,
): ClassificationResult {
  return { tier, confidence, reasoning: 'mock', source: 'rule' };
}

function makeRoutingResult(): RoutingResult {
  return {
    model: {
      id: 'test-model',
      name: 'Test',
      provider: 'test',
      tier: 'medium',
      contextWindow: 128000,
      capabilities: [],
      latencyMs: 0,
      available: true,
    },
    providerId: 'test',
    fallbackUsed: false,
    originalTier: 'medium',
    degraded: false,
  };
}

function makeLlmClient(responseContent: string): ILLMClient {
  const response: LLMResponse = {
    content: responseContent,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
    model: 'test-model',
  };
  return {
    protocol: 'openai',
    providerId: 'test',
    complete: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
  };
}

const SUMMARY_JSON = JSON.stringify({
  goal: '重构用户认证模块',
  scope: ['src/auth/login.ts', 'src/auth/session.ts'],
  constraints: ['不修改外部 API 接口'],
  acceptanceCriteria: ['登录功能正常', '测试通过'],
  estimatedComplexity: 'medium',
});

const QUESTIONS_JSON = JSON.stringify({
  questions: [
    { id: 1, question: '使用哪种认证方式？', options: ['JWT', 'Session'] },
    { id: 2, question: '是否需要支持 OAuth？' },
  ],
});

const EMPTY_QUESTIONS_JSON = JSON.stringify({ questions: [] });

// --- 测试 ---

describe('RequirementsGatherer', () => {
  let gatherer: RequirementsGatherer;

  beforeEach(() => {
    gatherer = new RequirementsGatherer();
  });

  describe('自动确认路径（medium + confidence ≥ 0.7）', () => {
    it('应生成需求摘要并 yield summary 事件', async () => {
      const llmClient = makeLlmClient(SUMMARY_JSON);
      const gen = gatherer.gather({
        userInput: '重构用户认证模块',
        classification: makeClassificationResult('medium', 0.9),
        llmClient,
        routeDecision: makeRoutingResult(),
      });
      const events = [];
      for await (const ev of gen) events.push(ev);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('summary');
      if (events[0].type === 'summary') {
        expect(events[0].summary.goal).toBe('重构用户认证模块');
        expect(events[0].summary.scope).toContain('src/auth/login.ts');
        expect(events[0].summary.estimatedComplexity).toBe('medium');
        expect(events[0].needsConfirmation).toBe(true);
      }
    });

    it('应将 projectContext 传给 LLM', async () => {
      const llmClient = makeLlmClient(SUMMARY_JSON);
      await gatherer.gather({
        userInput: '修改代码',
        classification: makeClassificationResult('medium', 0.9),
        projectContext: { projectType: 'node', recentTools: ['file_read'], hasGitChanges: true },
        llmClient,
        routeDecision: makeRoutingResult(),
      }).next();
      expect(llmClient.complete).toHaveBeenCalled();
      const call = (llmClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.messages[0].content).toContain('项目类型: node');
      expect(call.messages[0].content).toContain('file_read');
      expect(call.messages[0].content).toContain('Git 有变更: 是');
    });
  });

  describe('主动追问路径（complex 或 confidence < 0.7）', () => {
    it('complex 应先 yield questions 事件', async () => {
      const llmClient = makeLlmClient(QUESTIONS_JSON);
      const gen = gatherer.gather({
        userInput: '重构整个系统',
        classification: makeClassificationResult('complex', 0.9),
        llmClient,
        routeDecision: makeRoutingResult(),
      });
      const events = [];
      for await (const ev of gen) events.push(ev);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('questions');
      if (events[0].type === 'questions') {
        expect(events[0].questions.length).toBe(2);
        expect(events[0].questions[0].question).toContain('认证方式');
        expect(events[0].questions[0].options).toEqual(['JWT', 'Session']);
      }
    });

    it('低 confidence 应触发追问', async () => {
      const llmClient = makeLlmClient(QUESTIONS_JSON);
      const gen = gatherer.gather({
        userInput: '修改一些东西',
        classification: makeClassificationResult('medium', 0.5),
        llmClient,
        routeDecision: makeRoutingResult(),
      });
      const events = [];
      for await (const ev of gen) events.push(ev);
      expect(events[0].type).toBe('questions');
    });

    it('LLM 返回空问题时降级到摘要路径', async () => {
      const llmClient = makeLlmClient(EMPTY_QUESTIONS_JSON);
      const gen = gatherer.gather({
        userInput: '重构系统',
        classification: makeClassificationResult('complex', 0.9),
        llmClient,
        routeDecision: makeRoutingResult(),
      });
      const events = [];
      for await (const ev of gen) events.push(ev);
      // 空问题 → 跳过追问，继续走摘要路径
      // 第二次 complete 调用仍返回空问题 JSON，但 parseSummary 对任何有效 JSON 都能解析出默认值
      // （goal='', scope=[] 等），不抛错，因此 yield summary 事件
      expect(events[0].type).toBe('summary');
    });
  });

  describe('reasoning 跳过', () => {
    it('reasoning 应 yield skipped 事件', async () => {
      const llmClient = makeLlmClient(SUMMARY_JSON);
      const gen = gatherer.gather({
        userInput: '分析架构',
        classification: makeClassificationResult('reasoning', 0.9),
        llmClient,
        routeDecision: makeRoutingResult(),
      });
      const events = [];
      for await (const ev of gen) events.push(ev);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('skipped');
      if (events[0].type === 'skipped') {
        expect(events[0].reason).toContain('规划模式');
      }
      // 不应调用 LLM
      expect(llmClient.complete).not.toHaveBeenCalled();
    });
  });

  describe('LLM 失败降级', () => {
    it('摘要生成失败时应 yield skipped', async () => {
      const llmClient = makeLlmClient('not a json');
      const gen = gatherer.gather({
        userInput: '修改代码',
        classification: makeClassificationResult('medium', 0.9),
        llmClient,
        routeDecision: makeRoutingResult(),
      });
      const events = [];
      for await (const ev of gen) events.push(ev);
      expect(events[0].type).toBe('skipped');
      if (events[0].type === 'skipped') {
        expect(events[0].reason).toContain('失败');
      }
    });

    it('complete 抛异常时应降级 skipped', async () => {
      const llmClient: ILLMClient = {
        protocol: 'openai',
        providerId: 'test',
        complete: vi.fn().mockRejectedValue(new Error('network error')),
        stream: vi.fn(),
        isReady: vi.fn().mockReturnValue(true),
      };
      const gen = gatherer.gather({
        userInput: '修改代码',
        classification: makeClassificationResult('medium', 0.9),
        llmClient,
        routeDecision: makeRoutingResult(),
      });
      const events = [];
      for await (const ev of gen) events.push(ev);
      expect(events[0].type).toBe('skipped');
      if (events[0].type === 'skipped') {
        expect(events[0].reason).toContain('network error');
      }
    });

    it('追问生成失败时应降级到摘要路径', async () => {
      // 第一次调用抛异常（追问），第二次返回有效摘要
      const llmClient: ILLMClient = {
        protocol: 'openai',
        providerId: 'test',
        complete: vi.fn()
          .mockRejectedValueOnce(new Error('questions failed'))
          .mockResolvedValueOnce({
            content: SUMMARY_JSON,
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            finishReason: 'stop',
            model: 'test-model',
          }),
        stream: vi.fn(),
        isReady: vi.fn().mockReturnValue(true),
      };
      const gen = gatherer.gather({
        userInput: '重构系统',
        classification: makeClassificationResult('complex', 0.9),
        llmClient,
        routeDecision: makeRoutingResult(),
      });
      const events = [];
      for await (const ev of gen) events.push(ev);
      // 追问失败 → 降级到摘要
      expect(events[0].type).toBe('summary');
    });
  });

  describe('收集答案后继续生成摘要', () => {
    it('传入 collectedAnswers 时应合并到输入并生成摘要', async () => {
      const llmClient = makeLlmClient(SUMMARY_JSON);
      const answers: ClarifyingQuestion[] = [
        { id: 1, question: '使用哪种认证？', options: ['JWT'] },
      ];
      const gen = gatherer.gather({
        userInput: '重构认证',
        classification: makeClassificationResult('complex', 0.9),
        llmClient,
        routeDecision: makeRoutingResult(),
        collectedAnswers: answers,
      });
      const events = [];
      for await (const ev of gen) events.push(ev);
      // 有 collectedAnswers 时跳过追问，直接生成摘要
      expect(events[0].type).toBe('summary');
      // 验证合并后的输入包含答案
      const call = (llmClient.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.messages[0].content).toContain('用户补充回答');
      expect(call.messages[0].content).toContain('JWT');
    });
  });
});
