// tests/agent/vision/vision.test.ts
// VisionAssistant 单元测试

import { describe, it, expect, vi } from 'vitest';
import { VisionAssistant } from '../../../src/agent/vision.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse, ImageContent } from '../../../src/router/types.js';
import type { ProviderConfig, ModelConfig } from '../../../src/config/schema.js';

function makeMockClient(response: string = '测试描述'): ILLMClient {
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

function makeProviderConfig(modelId: string, capabilities: Array<'multimodal' | 'code' | 'reasoning' | 'vision' | 'fast'> = []): ProviderConfig {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    protocol: 'openai',
    baseUrl: 'https://api.test.com',
    apiKey: 'test-key',
    enabled: true,
    models: [{
      id: modelId,
      name: 'Test Model',
      provider: 'test-provider',
      tier: 'complex',
      contextWindow: 128000,
      capabilities,
      latencyMs: 100,
      available: true,
    }],
  };
}

describe('VisionAssistant', () => {
  describe('findVisionModel', () => {
    it('should find a model with multimodal capability', () => {
      const client = makeMockClient();
      const getter = () => client;
      const va = new VisionAssistant([makeProviderConfig('vision-model', ['multimodal'])], getter);
      const result = va.findVisionModel();
      expect(result).not.toBeNull();
      expect(result!.model.id).toBe('vision-model');
    });

    it('should return null when no model has multimodal capability', () => {
      const client = makeMockClient();
      const va = new VisionAssistant([makeProviderConfig('code-only', ['code'])], () => client);
      const result = va.findVisionModel();
      expect(result).toBeNull();
    });

    it('should return null when model is not available', () => {
      const config = makeProviderConfig('vision-model', ['multimodal']);
      config.models[0].available = false;
      const client = makeMockClient();
      const va = new VisionAssistant([config], () => client);
      expect(va.findVisionModel()).toBeNull();
    });

    it('should return null when client is not ready', () => {
      const client: ILLMClient = { isReady: () => false, complete: vi.fn(), stream: vi.fn(async function* () {}) };
      const va = new VisionAssistant([makeProviderConfig('vision-model', ['multimodal'])], () => client);
      expect(va.findVisionModel()).toBeNull();
    });
  });

  describe('analyze', () => {
    it('should call LLM with image content and return description', async () => {
      const client = makeMockClient('这是图片描述');
      const getter = () => client;
      const va = new VisionAssistant([makeProviderConfig('vision', ['multimodal'])], getter);
      const result = await va.analyze(
        [{ data: 'aGVsbG8=', mediaType: 'image/png' }],
        '分析这张图',
      );
      expect(result).not.toBeNull();
      expect(result!.description).toBe('这是图片描述');
      expect(result!.modelId).toBe('vision');
      expect(client.complete).toHaveBeenCalled();
    });

    it('should return null when no vision model', async () => {
      const client = makeMockClient();
      const va = new VisionAssistant([makeProviderConfig('code-only', ['code'])], () => client);
      const result = await va.analyze(
        [{ data: 'aGVsbG8=', mediaType: 'image/png' }],
        'test',
      );
      expect(result).toBeNull();
    });

    it('should return null on LLM error', async () => {
      const client: ILLMClient = {
        isReady: () => true,
        complete: vi.fn(async () => { throw new Error('LLM down'); }),
        stream: vi.fn(async function* () { /* */ }),
      };
      const va = new VisionAssistant([makeProviderConfig('vision', ['multimodal'])], () => client);
      const result = await va.analyze(
        [{ data: 'aGVsbG8=', mediaType: 'image/png' }],
        'test',
      );
      expect(result).toBeNull();
    });
  });

  describe('extractImageReferences', () => {
    it('should extract @filename.png references', () => {
      const refs = VisionAssistant.extractImageReferences('看看 @screenshot.png 这个界面');
      expect(refs).toEqual(['screenshot.png']);
    });

    it('should extract multiple references', () => {
      const refs = VisionAssistant.extractImageReferences('比较 @a.png 和 @b.jpg');
      expect(refs).toEqual(['a.png', 'b.jpg']);
    });

    it('should support absolute paths', () => {
      const refs = VisionAssistant.extractImageReferences('查看 @C:/path/to/file.png');
      expect(refs.length).toBeGreaterThan(0);
      expect(refs[0]).toMatch(/\.png$/);
    });

    it('should return empty array when no references', () => {
      expect(VisionAssistant.extractImageReferences('普通文本')).toEqual([]);
    });
  });

  describe('needsVision', () => {
    it('should return true for Chinese vision keywords', () => {
      expect(VisionAssistant.needsVision('看看这个截图')).toBe(true);
      expect(VisionAssistant.needsVision('帮我分析这张图片')).toBe(true);
    });

    it('should return true for English vision keywords', () => {
      expect(VisionAssistant.needsVision('look at this screenshot')).toBe(true);
      expect(VisionAssistant.needsVision('analyze this image')).toBe(true);
    });

    it('should return false for normal text', () => {
      expect(VisionAssistant.needsVision('帮我写一个函数')).toBe(false);
    });
  });
});
