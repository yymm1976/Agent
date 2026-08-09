// evals/repo-tasks/runner/mock-provider.ts
// GA Eval Phase A：deterministic mock LLM provider——用于 harness 自测与 CI 确定性验证。
//
// 定位：验证 runner 流程/评分/事件断言/报告输出（fault injection 用确定性脚本），
// 不用于评真实 Agent 能力（真实能力由 opt-in DeepSeek smoke 验证）。
//
// 行为（按 taskId）：
// - 默认：两轮——第一轮无工具纯文本（声明无法完成），第二轮结束。→ checks fail
//   （验证评分 fail 路径 + 报告完整性）
// - L2-07：模拟 provider 瞬时故障——第一次流式调用抛 RateLimitError（调用
//   options.onRetry 触发 llm_retry 事件），第二次成功。验证 RunEventLog
//   llm_retry 断言 + 有限退避语义在 mock 下成立。

import type { ILLMClient, LLMRequestOptions, LLMResponse, LLMStreamEvent, TokenUsageInfo } from '../../../src/router/types.js';
import { RateLimitError } from '../../../src/errors/agent-errors.js';

const ZERO_USAGE: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export function createMockClient(taskId: string): ILLMClient {
  const failFirst = taskId === 'L2-07';
  let streamCalls = 0;

  return {
    protocol: 'openai' as const,
    providerId: 'mock-eval',
    isReady: () => true,
    async complete(options: LLMRequestOptions): Promise<LLMResponse> {
      return { content: '（mock provider：未修改任何文件）', toolCalls: [], usage: ZERO_USAGE, finishReason: 'stop', model: 'mock-model' };
    },
    async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent> {
      streamCalls += 1;
      if (failFirst && streamCalls === 1) {
        // 模拟请求阶段瞬时故障：先调 onRetry（loop 记录 llm_retry），再抛错
        options.onRetry?.({ error: new RateLimitError('429 mock transient'), attempt: 1 });
        throw new RateLimitError('429 mock transient');
      }
      // 第一轮：无工具文本（声明无法完成——mock 不承担真实修复）
      yield { type: 'text_delta', text: '（mock provider）任务无法由 deterministic mock 完成，跳过修改。' };
      yield { type: 'done', finishReason: 'stop' };
    },
    getModels: async () => [],
  } as ILLMClient;
}
