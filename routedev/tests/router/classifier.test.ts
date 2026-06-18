// tests/router/classifier.test.ts
// 混合场景分类器单元测试

import { describe, it, expect } from 'vitest';
import { ScenarioClassifier } from '../../src/router/classifier.js';

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

    it('should classify /save as medium', async () => {
      const result = await classifier.classify({ query: '/save' });
      expect(result.tier).toBe('medium');
    });

    it('should classify /verify as complex', async () => {
      const result = await classifier.classify({ query: '/verify' });
      expect(result.tier).toBe('complex');
    });
  });

  describe('Keyword matching', () => {
    it('should classify git as medium', async () => {
      const result = await classifier.classify({ query: 'git status' });
      expect(result.tier).toBe('medium');
      expect(result.source).toBe('rule');
    });

    it('should classify npm as medium', async () => {
      const result = await classifier.classify({ query: 'npm install' });
      expect(result.tier).toBe('medium');
    });

    it('should classify 分析 as reasoning', async () => {
      const result = await classifier.classify({ query: '分析一下这个架构' });
      expect(result.tier).toBe('reasoning');
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
});
