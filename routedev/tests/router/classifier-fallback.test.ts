// tests/router/classifier-fallback.test.ts
// Phase 29 Task 6：TaskClassifier fallback 策略测试

import { describe, it, expect } from 'vitest';
import { ScenarioClassifier } from '../../src/router/classifier.js';
import type { ILLMClient, LLMResponse, LLMStreamEvent } from '../../src/router/types.js';

/** 模拟总是失败的 LLM 客户端 */
class FailingLLMClient implements ILLMClient {
  readonly protocol = 'openai' as const;
  readonly providerId = 'test-failing';

  isReady(): boolean { return true; }

  async complete(): Promise<LLMResponse> {
    throw new Error('LLM service unavailable');
  }

  async *stream(): AsyncGenerator<LLMStreamEvent, void, unknown> {
    throw new Error('LLM service unavailable');
  }
}

describe('ScenarioClassifier Phase 29 fallback 策略', () => {
  it('LLM 分类失败时应回退到 complex（保守策略）', async () => {
    const classifier = new ScenarioClassifier({
      llmClient: new FailingLLMClient(),
      classifierModel: 'gpt-4',
    });

    // 使用长查询（>20 字符）避免触发长度启发式
    const result = await classifier.classify({
      query: '这是一个需要分类的查询，长度超过二十个字符以避免触发长度启发式',
    });

    expect(result.tier).toBe('complex');
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.source).toBe('rule');
  });

  it('LLM 分类失败时不应回退到 simple', async () => {
    const classifier = new ScenarioClassifier({
      llmClient: new FailingLLMClient(),
      classifierModel: 'gpt-4',
    });

    const result = await classifier.classify({
      query: '这是一个需要分类的查询，长度超过二十个字符以避免触发长度启发式',
    });

    expect(result.tier).not.toBe('simple');
  });
});
