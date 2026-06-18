// tests/channels/message-router.test.ts
// MessageRouter 单元测试

import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../../src/channels/message-router.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse, ClassificationResult, RoutingResult } from '../../src/router/types.js';
import type { ScenarioTier } from '../../src/router/types.js';
import type { TokenTracker } from '../../src/router/tracker.js';
import type { ModelRouter } from '../../src/router/router.js';
import type { ScenarioClassifier } from '../../src/router/classifier.js';
import type { ChannelMessage } from '../../src/channels/types.js';

function makeMockClient(response: string = '模拟回复'): ILLMClient {
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

function makeMockRouter(): ModelRouter {
  return {
    route: vi.fn(async (): Promise<RoutingResult> => ({
      model: { id: 'mock-model', contextWindow: 128000 } as any,
      providerId: 'mock-provider',
      fallbackUsed: false,
      originalTier: 'simple' as ScenarioTier,
      degraded: false,
    })),
  } as unknown as ModelRouter;
}

function makeMockClassifier(): ScenarioClassifier {
  return {
    classify: vi.fn(async (): Promise<ClassificationResult> => ({
      tier: 'simple',
      confidence: 0.9,
      matchedRule: 'mock',
    })),
  } as unknown as ScenarioClassifier;
}

function makeMockTracker(): TokenTracker {
  return {
    record: vi.fn(),
  } as unknown as TokenTracker;
}

function makeConfig() {
  return {
    maxResponseLength: 2000,
    contextTtlMs: 2 * 60 * 60 * 1000,
    contextWindow: 1000,
    compressionThreshold: 0.8,
  };
}

function makeMessage(text: string = 'hello'): ChannelMessage {
  return {
    id: 'msg-1',
    channelType: 'wechat-work',
    sender: { id: 'user-1', name: 'User 1' },
    receiver: { id: 'bot-1', name: 'Bot' },
    text,
    isGroup: false,
    timestamp: Date.now(),
  };
}

describe('MessageRouter', () => {
  describe('handleMessage', () => {
    it('should call LLM and return response', async () => {
      const client = makeMockClient('AI 回复');
      const router = new MessageRouter(makeConfig(), {
        llmClient: client,
        router: makeMockRouter(),
        classifier: makeMockClassifier(),
        tracker: makeMockTracker(),
      });
      const response = await router.handleMessage(makeMessage('hello'));
      expect(response).toBe('AI 回复');
      expect(client.complete).toHaveBeenCalled();
    });

    it('should track token usage', async () => {
      const tracker = makeMockTracker();
      const router = new MessageRouter(makeConfig(), {
        llmClient: makeMockClient(),
        router: makeMockRouter(),
        classifier: makeMockClassifier(),
        tracker,
      });
      await router.handleMessage(makeMessage('hello'));
      expect(tracker.record).toHaveBeenCalled();
    });

    it('should create user context on first message', async () => {
      const router = new MessageRouter(makeConfig(), {
        llmClient: makeMockClient(),
        router: makeMockRouter(),
        classifier: makeMockClassifier(),
        tracker: makeMockTracker(),
      });
      expect(router.getUserCount()).toBe(0);
      await router.handleMessage(makeMessage('hello'));
      expect(router.getUserCount()).toBe(1);
    });

    it('should accumulate user history', async () => {
      const router = new MessageRouter(makeConfig(), {
        llmClient: makeMockClient(),
        router: makeMockRouter(),
        classifier: makeMockClassifier(),
        tracker: makeMockTracker(),
      });
      await router.handleMessage(makeMessage('msg 1'));
      await router.handleMessage(makeMessage('msg 2'));
      const ctx = router.getUserContext('wechat-work:user-1');
      expect(ctx).toBeDefined();
      expect(ctx!.totalMessages).toBe(2);
    });

    it('should return error message on routing failure', async () => {
      const classifier: ScenarioClassifier = {
        classify: vi.fn(async () => { throw new Error('routing failed'); }),
      } as unknown as ScenarioClassifier;
      const router = new MessageRouter(makeConfig(), {
        llmClient: makeMockClient(),
        router: makeMockRouter(),
        classifier,
        tracker: makeMockTracker(),
      });
      const response = await router.handleMessage(makeMessage('hello'));
      expect(response).toContain('路由服务');
    });

    it('should return error message on LLM failure', async () => {
      const client: ILLMClient = {
        isReady: () => true,
        complete: vi.fn(async () => { throw new Error('LLM down'); }),
        stream: vi.fn(async function* () { /* */ }),
      };
      const router = new MessageRouter(makeConfig(), {
        llmClient: client,
        router: makeMockRouter(),
        classifier: makeMockClassifier(),
        tracker: makeMockTracker(),
      });
      const response = await router.handleMessage(makeMessage('hello'));
      expect(response).toContain('错误');
    });
  });

  describe('splitLongResponse', () => {
    it('should not split short text', () => {
      const router = new MessageRouter(makeConfig(), {
        llmClient: makeMockClient(),
        router: makeMockRouter(),
        classifier: makeMockClassifier(),
        tracker: makeMockTracker(),
      });
      const chunks = router.splitLongResponse('short');
      expect(chunks).toEqual(['short']);
    });

    it('should split long text on newlines', () => {
      const router = new MessageRouter(
        { ...makeConfig(), maxResponseLength: 50 },
        {
          llmClient: makeMockClient(),
          router: makeMockRouter(),
          classifier: makeMockClassifier(),
          tracker: makeMockTracker(),
        },
      );
      const longText = 'Line 1 with more text\nLine 2 with more text\nLine 3 with more text\nLine 4 with more text\nLine 5 with more text';
      const chunks = router.splitLongResponse(longText);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(50));
    });

    it('should split on Chinese punctuation if no newlines', () => {
      const router = new MessageRouter(
        { ...makeConfig(), maxResponseLength: 20 },
        {
          llmClient: makeMockClient(),
          router: makeMockRouter(),
          classifier: makeMockClassifier(),
          tracker: makeMockTracker(),
        },
      );
      const longText = '第一句话很长很长的内容。第二句话也很长。第三句话也是。第四句。';
      const chunks = router.splitLongResponse(longText);
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('cleanupExpiredContexts', () => {
    it('should remove expired contexts', () => {
      const router = new MessageRouter(
        { ...makeConfig(), contextTtlMs: 100 },
        {
          llmClient: makeMockClient(),
          router: makeMockRouter(),
          classifier: makeMockClassifier(),
          tracker: makeMockTracker(),
        },
      );
      // 直接调用 add
      router['userContexts'].set('user-1', {
        userId: 'user-1',
        channelType: 'wechat-work',
        history: [],
        lastActiveAt: Date.now() - 1000,
        totalMessages: 1,
      });
      const removed = router.cleanupExpiredContexts();
      expect(removed).toBe(1);
      expect(router.getUserCount()).toBe(0);
    });

    it('should keep non-expired contexts', () => {
      const router = new MessageRouter(makeConfig(), {
        llmClient: makeMockClient(),
        router: makeMockRouter(),
        classifier: makeMockClassifier(),
        tracker: makeMockTracker(),
      });
      router['userContexts'].set('user-1', {
        userId: 'user-1',
        channelType: 'wechat-work',
        history: [],
        lastActiveAt: Date.now(),
        totalMessages: 1,
      });
      const removed = router.cleanupExpiredContexts();
      expect(removed).toBe(0);
      expect(router.getUserCount()).toBe(1);
    });
  });

  describe('reset', () => {
    it('should clear all user contexts', async () => {
      const router = new MessageRouter(makeConfig(), {
        llmClient: makeMockClient(),
        router: makeMockRouter(),
        classifier: makeMockClassifier(),
        tracker: makeMockTracker(),
      });
      await router.handleMessage(makeMessage('hello'));
      expect(router.getUserCount()).toBe(1);
      router.reset();
      expect(router.getUserCount()).toBe(0);
    });
  });
});