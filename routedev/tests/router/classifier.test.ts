// tests/router/classifier.test.ts
// 混合场景分类器单元测试

import { describe, it, expect } from 'vitest';
import { ScenarioClassifier } from '../../src/router/classifier.js';
import type { ILLMClient, LLMResponse, LLMStreamEvent } from '../../src/router/types.js';

describe('ScenarioClassifier', () => {
  const classifier = new ScenarioClassifier({
    classifierModel: 'gpt-4o-mini',
  });

  describe('Command matching', () => {
    it('should classify /help as simple', async () => {
      const result = await classifier.classify({ query: '/help' });
      expect(result.tier).toBe('simple');
      expect(result.source).toBe('rule');
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('should classify /status as simple', async () => {
      const result = await classifier.classify({ query: '/status' });
      expect(result.tier).toBe('simple');
    });

    it('Phase 81: /save 收敛为 complex（原 medium）', async () => {
      // 三级路由简化：medium → complex
      const result = await classifier.classify({ query: '/save' });
      expect(result.tier).toBe('complex');
    });

    it('should classify /verify as complex', async () => {
      const result = await classifier.classify({ query: '/verify' });
      expect(result.tier).toBe('complex');
    });
  });

  describe('Keyword matching', () => {
    it('Phase 81: git 收敛为 complex（原 medium）', async () => {
      // 三级路由简化：medium → complex
      const result = await classifier.classify({ query: 'git status' });
      expect(result.tier).toBe('complex');
      expect(result.source).toBe('rule');
    });

    it('Phase 81: npm 收敛为 complex（原 medium）', async () => {
      // 三级路由简化：medium → complex
      const result = await classifier.classify({ query: 'npm install' });
      expect(result.tier).toBe('complex');
    });

    it('Phase 81: 分析 收敛为 complex（原 reasoning）', async () => {
      // 三级路由简化：reasoning → complex
      const result = await classifier.classify({ query: '分析一下这个架构' });
      expect(result.tier).toBe('complex');
    });

    it('should classify 重构 as complex', async () => {
      const result = await classifier.classify({ query: '重构这个模块' });
      expect(result.tier).toBe('complex');
    });

    it('should classify 读取 as simple', async () => {
      const result = await classifier.classify({ query: '读取配置文件' });
      expect(result.tier).toBe('simple');
    });
  });

  describe('Length heuristic', () => {
    it('should classify short query as simple', async () => {
      const result = await classifier.classify({ query: 'hi' });
      expect(result.tier).toBe('simple');
    });

    it('should classify long query as complex', async () => {
      const longQuery = 'a'.repeat(600);
      const result = await classifier.classify({ query: longQuery });
      expect(result.tier).toBe('complex');
    });
  });

  describe('Default fallback', () => {
    it('should return complex for unmatched query without LLM (Phase 29 conservative fallback)', async () => {
      // 中等长度、无关键词的查询
      // Phase 29 Task 4：回退策略从 simple 改为 complex（保守策略：不确定时用强模型兜底）
      const result = await classifier.classify({ query: 'some random text here' });
      expect(result.tier).toBe('complex');
      expect(result.confidence).toBe(0.3);
    });
  });

  // ============================================================
  // Phase 81 Task 2：三级路由简化测试
  // 验证：simple/complex 二分 + override + 被旁路层不调用
  // ============================================================
  describe('Phase 81: 三级路由简化', () => {
    it('LLM 兜底分类器默认旁路（配置 llmClient 但 llmClassifierEnabled 未设时不调用 LLM）', async () => {
      // 构造记录调用次数的 mock LLM 客户端
      let callCount = 0;
      const mockLLMClient: ILLMClient = {
        protocol: 'openai',
        providerId: 'test-mock',
        isReady: () => true,
        complete: async (): Promise<LLMResponse> => {
          callCount++;
          return {
            content: '{"tier":"simple","confidence":0.9,"reasoning":"mock"}',
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            finishReason: 'stop',
            model: 'mock',
          };
        },
        stream: async function* (): AsyncGenerator<LLMStreamEvent, void, unknown> {
          yield { type: 'text_delta', text: '' };
        },
      };

      // llmClassifierEnabled 未设（默认 false）：LLM 应被旁路
      const bypassClassifier = new ScenarioClassifier({
        classifierModel: 'gpt-4o-mini',
        llmClient: mockLLMClient,
        // llmClassifierEnabled 故意不设，默认 false → LLM 旁路
      });

      const result = await bypassClassifier.classify({ query: '读取配置文件' });
      // LLM 未被调用（被旁路）
      expect(callCount).toBe(0);
      // 走关键词匹配，读取 → simple
      expect(result.tier).toBe('simple');
      expect(result.source).toBe('rule');
    });

    it('llmClassifierEnabled=true 时调用 LLM 分类，结果经 tier 收敛', async () => {
      let callCount = 0;
      const mockLLMClient: ILLMClient = {
        protocol: 'openai',
        providerId: 'test-mock',
        isReady: () => true,
        complete: async (): Promise<LLMResponse> => {
          callCount++;
          return {
            content: '{"tier":"medium","confidence":0.9,"reasoning":"mock"}',
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            finishReason: 'stop',
            model: 'mock',
          };
        },
        stream: async function* (): AsyncGenerator<LLMStreamEvent, void, unknown> {
          yield { type: 'text_delta', text: '' };
        },
      };

      const enabledClassifier = new ScenarioClassifier({
        classifierModel: 'gpt-4o-mini',
        llmClient: mockLLMClient,
        llmClassifierEnabled: true,
      });

      const result = await enabledClassifier.classify({ query: '这是一个需要分类的查询' });
      // LLM 被调用
      expect(callCount).toBe(1);
      // LLM 返回 medium，经 tier 收敛 → complex
      expect(result.tier).toBe('complex');
      expect(result.source).toBe('llm');
    });

    it('simpleRoutingEnabled=false 时回退四级 tier（git → medium）', async () => {
      // 关闭三级路由简化，medium 保持 medium
      const fourTierClassifier = new ScenarioClassifier({
        classifierModel: 'gpt-4o-mini',
        simpleRoutingEnabled: false,
      });

      const result = await fourTierClassifier.classify({ query: 'git status' });
      // 简化关闭：git → medium（四级路由）
      expect(result.tier).toBe('medium');
    });

    it('simpleRoutingEnabled=false 时 reasoning 保持 reasoning', async () => {
      // 关闭三级路由简化，reasoning 保持 reasoning
      const fourTierClassifier = new ScenarioClassifier({
        classifierModel: 'gpt-4o-mini',
        simpleRoutingEnabled: false,
      });

      const result = await fourTierClassifier.classify({ query: '分析一下这个架构' });
      // 简化关闭：分析 → reasoning（四级路由）
      expect(result.tier).toBe('reasoning');
    });
  });
});
