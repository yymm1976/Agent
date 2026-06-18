// tests/prompts/validate.test.ts
// 提示词五块结构验证测试（Phase 24 Task 6）

import { describe, it, expect, beforeEach } from 'vitest';
import { PromptTemplateManager } from '../../src/prompts/manager.js';

describe('提示词五块结构验证 (Phase 24 Task 6)', () => {
  let manager: PromptTemplateManager;

  beforeEach(() => {
    manager = new PromptTemplateManager();
  });

  describe('validate() 单模板验证', () => {
    it('classifier.system 包含 Block 1-4', async () => {
      const result = await manager.validate('classifier.system');
      expect(result.missing).toHaveLength(0);
    });

    it('worker.coder 包含 Block 1-4', async () => {
      const result = await manager.validate('worker.coder');
      expect(result.missing).toHaveLength(0);
    });

    it('worker.tester 包含 Block 1-4', async () => {
      const result = await manager.validate('worker.tester');
      expect(result.missing).toHaveLength(0);
    });

    it('worker.searcher 包含 Block 1-4', async () => {
      const result = await manager.validate('worker.searcher');
      expect(result.missing).toHaveLength(0);
    });

    it('worker.reviewer 包含 Block 1-4', async () => {
      const result = await manager.validate('worker.reviewer');
      expect(result.missing).toHaveLength(0);
    });

    it('不存在的模板返回 missing 包含"模板不存在"', async () => {
      const result = await manager.validate('nonexistent.template');
      expect(result.missing).toContain('模板不存在');
    });
  });

  describe('validateAll() 全量验证', () => {
    it('返回所有模板的验证结果', async () => {
      const results = await manager.validateAll();
      const templateIds = manager.listTemplateIds();
      expect(results.length).toBe(templateIds.length);

      // 每个结果都有 id、missing、hasExample 字段
      for (const r of results) {
        expect(r.id).toBeTruthy();
        expect(Array.isArray(r.missing)).toBe(true);
        expect(typeof r.hasExample).toBe('boolean');
      }
    });

    it('已改造的模板 missing 为空', async () => {
      const results = await manager.validateAll();
      const coderResult = results.find(r => r.id === 'worker.coder');
      expect(coderResult).toBeDefined();
      expect(coderResult!.missing).toHaveLength(0);
    });
  });

  describe('Block 5 示例（可选）', () => {
    it('hasExample 字段正确反映模板是否包含 Block 5', async () => {
      // 当前模板都没有 Block 5（可选）
      const result = await manager.validate('worker.coder');
      expect(result.hasExample).toBe(false);
    });
  });
});
