// tests/policies/policy-engine.test.ts
// 策略引擎测试
//
// 覆盖：
//   14. PolicyEngine 按优先级排序
//   15. PolicyEngine enable/disable 策略
//   16. PolicyEngine 导入导出
//
// Phase 50 Task 8：已移除 ReasoningMode 测试（reasoning-mode.ts 已作为死代码删除）
// 本任务：已移除 IntentGuard/Playbook/ToolGuide/ToolApproval 的静态方法测试
//        （这些静态 evaluate 方法作为死代码删除，PolicyEngine 内部通过 evaluateAction 直接处理）

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PolicyEngine,
  type Policy,
} from '../../src/policies/policy-engine.js';

// ============================================================
// PolicyEngine 测试
// ============================================================

describe('PolicyEngine', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  describe('按优先级排序', () => {
    it('应按 priority 降序评估', () => {
      const low: Policy = {
        id: 'low',
        type: 'intent_guard',
        name: '低优先级',
        enabled: true,
        priority: 10,
        trigger: { mode: 'keyword', keywords: ['test'] },
        action: { response: 'low' },
      };
      const high: Policy = {
        id: 'high',
        type: 'intent_guard',
        name: '高优先级',
        enabled: true,
        priority: 100,
        trigger: { mode: 'keyword', keywords: ['test'] },
        action: { response: 'high' },
      };

      engine.addPolicy(low);
      engine.addPolicy(high);

      const results = engine.evaluateInput('test');
      // 高优先级应在前面
      expect(results[0].policyId).toBe('high');
      expect(results[1].policyId).toBe('low');
    });

    it('list() 应返回按优先级排序的策略', () => {
      engine.addPolicy({
        id: 'a',
        type: 'intent_guard',
        name: 'A',
        enabled: true,
        priority: 1,
        trigger: { mode: 'always' },
        action: {},
      });
      engine.addPolicy({
        id: 'b',
        type: 'intent_guard',
        name: 'B',
        enabled: true,
        priority: 100,
        trigger: { mode: 'always' },
        action: {},
      });

      const list = engine.list();
      expect(list[0].id).toBe('b');
      expect(list[1].id).toBe('a');
    });
  });

  describe('enable/disable 策略', () => {
    it('禁用的策略不应参与评估', () => {
      engine.addPolicy({
        id: 'p1',
        type: 'intent_guard',
        name: 'P1',
        enabled: true,
        priority: 100,
        trigger: { mode: 'keyword', keywords: ['danger'] },
        action: { block: true, response: 'blocked' },
      });

      // 启用时命中
      let results = engine.evaluateInput('danger operation');
      expect(results.some((r) => r.matched)).toBe(true);

      // 禁用后不命中
      engine.disablePolicy('p1');
      results = engine.evaluateInput('danger operation');
      expect(results.every((r) => !r.matched)).toBe(true);

      // 重新启用
      engine.enablePolicy('p1');
      results = engine.evaluateInput('danger operation');
      expect(results.some((r) => r.matched)).toBe(true);
    });
  });

  describe('导入导出', () => {
    it('应能导出所有策略', () => {
      engine.addPolicy({
        id: 'p1',
        type: 'intent_guard',
        name: 'P1',
        enabled: true,
        priority: 100,
        trigger: { mode: 'keyword', keywords: ['a', 'b'] },
        action: { block: true },
      });
      engine.addPolicy({
        id: 'p2',
        type: 'playbook',
        name: 'P2',
        enabled: false,
        priority: 50,
        trigger: { mode: 'always' },
        action: { injectPrompt: 'prompt' },
      });

      const exported = engine.exportAll();
      expect(exported.length).toBe(2);
      expect(exported.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    });

    it('应能导入策略并覆盖现有', () => {
      engine.addPolicy({
        id: 'old',
        type: 'intent_guard',
        name: 'Old',
        enabled: true,
        priority: 1,
        trigger: { mode: 'always' },
        action: {},
      });

      const newPolicies: Policy[] = [
        {
          id: 'new1',
          type: 'playbook',
          name: 'New1',
          enabled: true,
          priority: 50,
          trigger: { mode: 'keyword', keywords: ['x'] },
          action: { injectPrompt: 'p' },
        },
        {
          id: 'new2',
          type: 'tool_guide',
          name: 'New2',
          enabled: true,
          priority: 30,
          trigger: { mode: 'keyword', keywords: ['y'] },
          action: { extraContext: 'c' },
        },
      ];

      engine.importAll(newPolicies);

      const list = engine.list();
      expect(list.length).toBe(2);
      expect(list.map((p) => p.id).sort()).toEqual(['new1', 'new2']);
      expect(engine.get('old')).toBeUndefined();
    });

    it('addPolicy 同 id 应覆盖', () => {
      engine.addPolicy({
        id: 'dup',
        type: 'intent_guard',
        name: 'V1',
        enabled: true,
        priority: 10,
        trigger: { mode: 'always' },
        action: { response: 'v1' },
      });
      engine.addPolicy({
        id: 'dup',
        type: 'intent_guard',
        name: 'V2',
        enabled: true,
        priority: 20,
        trigger: { mode: 'always' },
        action: { response: 'v2' },
      });

      const list = engine.list();
      expect(list.length).toBe(1);
      expect(list[0].name).toBe('V2');
      expect(list[0].priority).toBe(20);
    });

    it('removePolicy 应能移除策略', () => {
      engine.addPolicy({
        id: 'rm',
        type: 'intent_guard',
        name: 'RM',
        enabled: true,
        priority: 10,
        trigger: { mode: 'always' },
        action: {},
      });

      engine.removePolicy('rm');
      expect(engine.get('rm')).toBeUndefined();
      expect(engine.list().length).toBe(0);
    });
  });

  describe('evaluateToolCall', () => {
    it('应只评估 tool_guide 和 tool_approval 类型', () => {
      engine.addPolicy({
        id: 'ig',
        type: 'intent_guard',
        name: 'IG',
        enabled: true,
        priority: 100,
        trigger: { mode: 'keyword', keywords: ['file_write'] },
        action: { block: true },
      });
      engine.addPolicy({
        id: 'tg',
        type: 'tool_guide',
        name: 'TG',
        enabled: true,
        priority: 30,
        trigger: { mode: 'keyword', keywords: ['file_write'] },
        action: { extraContext: 'ctx' },
      });

      const results = engine.evaluateToolCall('file_write', {});
      // 只返回 tool_guide 的结果
      expect(results.length).toBe(1);
      expect(results[0].policyId).toBe('tg');
    });
  });
});
