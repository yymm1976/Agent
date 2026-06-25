// tests/phase37/requirements-clarifier.test.ts
// Phase 37 Task 1：RequirementsClarifier 单元测试
// 覆盖：模糊度分析、阈值边界、enrichGoal、LLM 失败降级、maxQuestions 限制

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequirementsClarifier } from '../../src/agent/requirements-clarifier.js';
import type { ILLMClient, LLMResponse } from '../../src/router/types.js';

// --- Mock 工厂 ---

/** 创建 mock LLM 客户端，complete 返回指定内容 */
function makeLlmClient(responseContent: string): ILLMClient {
  const response: LLMResponse = {
    content: responseContent,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
    model: 'test-classifier',
  };
  return {
    protocol: 'openai',
    providerId: 'test',
    complete: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
  };
}

/** 创建抛异常的 mock LLM 客户端（用于测试降级） */
function makeFailingLlmClient(error: Error): ILLMClient {
  return {
    protocol: 'openai',
    providerId: 'test',
    complete: vi.fn().mockRejectedValue(error),
    stream: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
  };
}

/** 低模糊度 LLM 响应（清晰目标） */
const LOW_SCORE_JSON = JSON.stringify({
  score: 0.1,
  reasoning: '目标明确，有具体文件和函数名',
  questions: [],
});

/** 高模糊度 LLM 响应（模糊目标） */
const HIGH_SCORE_JSON = JSON.stringify({
  score: 0.85,
  reasoning: '缺少具体对象和范围，包含歧义词',
  questions: [
    {
      id: 'q1',
      question: '你想优化哪个模块？',
      context: '目标未指明具体对象',
      optional: false,
      type: 'text',
    },
    {
      id: 'q2',
      question: '优化的标准是什么？',
      context: '目标未给出验收标准',
      optional: true,
      type: 'text',
    },
  ],
});

/** enrichGoal 的 LLM 响应 */
const ENRICH_JSON = JSON.stringify({
  enrichedGoal: '在 src/utils.ts 中添加 SHA256 哈希函数，使用 Node.js crypto 模块，返回 hex 字符串',
});

// --- 测试 ---

describe('RequirementsClarifier', () => {
  const defaultOptions = {
    llmClient: makeLlmClient(HIGH_SCORE_JSON),
    modelId: 'test-classifier',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('模糊度分析', () => {
    it('清晰目标应返回低模糊度（score < threshold）', async () => {
      const llmClient = makeLlmClient(LOW_SCORE_JSON);
      const clarifier = new RequirementsClarifier({ ...defaultOptions, llmClient });
      const result = await clarifier.clarify('在 src/utils.ts 中添加一个 SHA256 哈希函数');

      expect(result.score).toBeLessThan(0.4);
      expect(result.needsClarification).toBe(false);
      expect(result.questions).toHaveLength(0);
    });

    it('模糊目标应返回高模糊度（score >= threshold）', async () => {
      const llmClient = makeLlmClient(HIGH_SCORE_JSON);
      const clarifier = new RequirementsClarifier({ ...defaultOptions, llmClient });
      const result = await clarifier.clarify('优化项目');

      expect(result.score).toBeGreaterThanOrEqual(0.4);
      expect(result.needsClarification).toBe(true);
      expect(result.questions.length).toBeGreaterThan(0);
    });
  });

  describe('阈值边界', () => {
    it('模糊度 < threshold 时 needsClarification=false', async () => {
      // score=0.3，threshold=0.4 → 不需要澄清
      const json = JSON.stringify({ score: 0.3, reasoning: '基本清晰', questions: [] });
      const llmClient = makeLlmClient(json);
      const clarifier = new RequirementsClarifier({
        ...defaultOptions,
        llmClient,
        threshold: 0.4,
      });
      const result = await clarifier.clarify('读取 config.json 文件');

      expect(result.score).toBe(0.3);
      expect(result.needsClarification).toBe(false);
    });

    it('模糊度 >= threshold 时 needsClarification=true', async () => {
      // score=0.5，threshold=0.4 → 需要澄清
      const json = JSON.stringify({
        score: 0.5,
        reasoning: '部分模糊',
        questions: [
          { id: 'q1', question: '具体要做什么？', context: '动作不明确', optional: false, type: 'text' },
        ],
      });
      const llmClient = makeLlmClient(json);
      const clarifier = new RequirementsClarifier({
        ...defaultOptions,
        llmClient,
        threshold: 0.4,
      });
      const result = await clarifier.clarify('修改一些东西');

      expect(result.score).toBe(0.5);
      expect(result.needsClarification).toBe(true);
      expect(result.questions.length).toBeGreaterThan(0);
    });
  });

  describe('enrichGoal', () => {
    it('应将回答合并到目标文本', async () => {
      const llmClient = makeLlmClient(ENRICH_JSON);
      const clarifier = new RequirementsClarifier({ ...defaultOptions, llmClient });
      const enriched = await clarifier.enrichGoal('在 src/utils.ts 中添加哈希函数', {
        q1: 'SHA256',
        q2: '使用 crypto 模块，返回 hex 字符串',
      });

      expect(enriched).toContain('SHA256');
      expect(enriched).toContain('crypto');
      expect(enriched).toContain('hex');
    });

    it('无回答时直接返回原文', async () => {
      const llmClient = makeLlmClient(ENRICH_JSON);
      const clarifier = new RequirementsClarifier({ ...defaultOptions, llmClient });
      const original = '在 src/utils.ts 中添加哈希函数';
      const enriched = await clarifier.enrichGoal(original, {});

      expect(enriched).toBe(original);
      // 无回答时不应调用 LLM
      expect(llmClient.complete).not.toHaveBeenCalled();
    });
  });

  describe('LLM 失败降级', () => {
    it('LLM 调用失败时使用基于规则的模糊度检测', async () => {
      const llmClient = makeFailingLlmClient(new Error('network error'));
      const clarifier = new RequirementsClarifier({ ...defaultOptions, llmClient });
      // "优化" 是 VAGUE_ACTION_WORDS 中的词，"这个" 是 AMBIGUOUS_WORDS 中的词
      const result = await clarifier.clarify('优化这个项目');

      // 规则检测应识别出"优化"和"这个"两个歧义词，score = 0.2 * 2 = 0.4
      expect(result.score).toBeGreaterThanOrEqual(0.2);
      // 包含歧义词，应触发澄清（score >= threshold 0.4）
      expect(result.needsClarification).toBe(true);
      // 应生成规则化问题
      expect(result.questions.length).toBeGreaterThan(0);
      // 问题应包含对模糊动作或指代词的澄清
      const allQuestions = result.questions.map((q) => q.question).join(' ');
      expect(
        allQuestions.includes('操作') || allQuestions.includes('对象') || allQuestions.includes('验证'),
      ).toBe(true);
    });

    it('enrichGoal LLM 失败时降级为简单拼接', async () => {
      const llmClient = makeFailingLlmClient(new Error('enrich failed'));
      const clarifier = new RequirementsClarifier({ ...defaultOptions, llmClient });
      const enriched = await clarifier.enrichGoal('优化项目', {
        q1: '优化数据库查询性能',
      });

      // 降级拼接应包含原始目标和回答
      expect(enriched).toContain('优化项目');
      expect(enriched).toContain('优化数据库查询性能');
      expect(enriched).toContain('补充');
    });
  });

  describe('maxQuestions 限制', () => {
    it('追问问题数量不超过 maxQuestions', async () => {
      // LLM 返回 5 个问题，但 maxQuestions=2
      const json = JSON.stringify({
        score: 0.9,
        reasoning: '极度模糊',
        questions: [
          { id: 'q1', question: '问题1', context: '理由1', optional: false, type: 'text' },
          { id: 'q2', question: '问题2', context: '理由2', optional: false, type: 'text' },
          { id: 'q3', question: '问题3', context: '理由3', optional: true, type: 'text' },
          { id: 'q4', question: '问题4', context: '理由4', optional: true, type: 'text' },
          { id: 'q5', question: '问题5', context: '理由5', optional: true, type: 'text' },
        ],
      });
      const llmClient = makeLlmClient(json);
      const clarifier = new RequirementsClarifier({
        ...defaultOptions,
        llmClient,
        maxQuestions: 2,
      });
      const result = await clarifier.clarify('搞一下那个东西');

      expect(result.needsClarification).toBe(true);
      expect(result.questions.length).toBeLessThanOrEqual(2);
    });

    it('规则降级也遵守 maxQuestions 限制', async () => {
      const llmClient = makeFailingLlmClient(new Error('fail'));
      const clarifier = new RequirementsClarifier({
        ...defaultOptions,
        llmClient,
        maxQuestions: 1,
      });
      // 包含多个歧义词，但 maxQuestions=1
      const result = await clarifier.clarify('优化这个项目的一些东西');

      expect(result.questions.length).toBeLessThanOrEqual(1);
    });
  });

  describe('skipIfConfident', () => {
    it('置信度高时自动跳过（score < 0.2）', async () => {
      const json = JSON.stringify({
        score: 0.1,
        reasoning: '非常清晰',
        questions: [
          { id: 'q1', question: '多余问题', context: '不应出现', optional: true, type: 'text' },
        ],
      });
      const llmClient = makeLlmClient(json);
      const clarifier = new RequirementsClarifier({
        ...defaultOptions,
        llmClient,
        skipIfConfident: true,
      });
      const result = await clarifier.clarify('在 src/utils.ts 中添加 SHA256 函数');

      // score < 0.2，即使 LLM 返回了问题也应跳过
      expect(result.needsClarification).toBe(false);
      expect(result.questions).toHaveLength(0);
    });

    it('skipIfConfident=false 时不跳过高置信度', async () => {
      // score=0.1 但 threshold=0.05 → score >= threshold 仍需澄清
      const json = JSON.stringify({
        score: 0.1,
        reasoning: '基本清晰',
        questions: [
          { id: 'q1', question: '确认问题', context: '确认', optional: true, type: 'text' },
        ],
      });
      const llmClient = makeLlmClient(json);
      const clarifier = new RequirementsClarifier({
        ...defaultOptions,
        llmClient,
        threshold: 0.05,
        skipIfConfident: false,
      });
      const result = await clarifier.clarify('读取文件');

      // skipIfConfident=false，score=0.1 >= threshold=0.05 → 需要澄清
      expect(result.needsClarification).toBe(true);
      expect(result.questions.length).toBeGreaterThan(0);
    });
  });
});
