// evals/repo-tasks/runner/mock-provider.ts
// GA Eval Integrity Closure：deterministic mock LLM provider——用于 Harness Conformance
// Suite（CI 可跑，不计入模型能力分数）。
//
// L2-07 fault fidelity（P1-EVAL-06 修复）：真 request-stage provider retry——
// mock 客户端内部复用 RetryPolicy/withRetry 语义：loop 发起一次 stream()，
// provider 内部 attempt1 FAIL（RateLimitError）→ onRetry → attempt2 SUCCESS。
// Loop 从不收到第一次 provider error（llm_failed=0），RunEventLog 记 llm_retry=1。

import type { ILLMClient, LLMRequestOptions, LLMResponse, LLMStreamEvent, TokenUsageInfo } from '../../../src/router/types.js';
import { RateLimitError } from '../../../src/errors/agent-errors.js';
import { QuerySourceAwareRetryPolicy } from '../../../src/utils/retry.js';

const ZERO_USAGE: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export function createMockClient(taskId: string): ILLMClient {
  const failFirst = taskId === 'L2-07';
  // L2-07：provider 内部重试策略（真实链路同款 QuerySourceAwareRetryPolicy）
  const retryPolicy = failFirst
    ? new QuerySourceAwareRetryPolicy({ querySource: 'repl_main_thread', maxRetries: 2, baseDelayMs: 1 })
    : null;

  return {
    protocol: 'openai' as const,
    providerId: 'mock-eval',
    isReady: () => true,
    async complete(options: LLMRequestOptions): Promise<LLMResponse> {
      return { content: '（mock provider：未修改任何文件）', toolCalls: [], usage: ZERO_USAGE, finishReason: 'stop', model: 'mock-model' };
    },
    async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
      if (failFirst && retryPolicy) {
        // 请求阶段 retry（与 OpenAIClient.stream 的 withRetry 一致语义）：
        // create() 第一次抛 RateLimitError → policy 重试（onRetry 触发 llm_retry）→ 第二次成功
        // loop 只收到一次成功的流（provider 错误不泄漏到 loop 层）
        let attempts = 0;
        await retryPolicy.execute(async () => {
          attempts += 1;
          if (attempts === 1) throw new RateLimitError('503 mock transient');
          return null;
        }, { onRetry: options.onRetry });
      }
      yield { type: 'text_delta', text: '（mock provider）任务无法由 deterministic mock 完成，跳过修改。' };
      yield { type: 'done', finishReason: 'stop' };
    },
    getModels: async () => [],
  } as ILLMClient;
}
