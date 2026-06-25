// tests/policies/policy-engine.test.ts
// 策略引擎测试
//
// 覆盖：
//   9. IntentGuard keyword 触发精确匹配
//   10. IntentGuard 阻止危险请求
//   11. Playbook 命中后返回 SOP 内容
//   12. Tool Guide 追加工具上下文
//   13. Tool Approval 检测需要审批的工具
//   14. PolicyEngine 按优先级排序
//   15. PolicyEngine enable/disable 策略
//   16. PolicyEngine 导入导出
//   17. ReasoningMode 三种模式配置正确
//   18. ReasoningMode getReasoningConfig 返回正确配置

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PolicyEngine,
  type Policy,
  type PolicyEvalResult,
} from '../../src/policies/policy-engine.js';
import { IntentGuard } from '../../src/policies/intent-guard.js';
import { Playbook } from '../../src/policies/playbook.js';
import { ToolGuide } from '../../src/policies/tool-guide.js';
import { ToolApproval } from '../../src/policies/tool-approval.js';
import {
  MODE_CONFIGS,
  getReasoningConfig,
  getDefaultMode,
  type ReasoningMode,
} from '../../src/router/reasoning-mode.js';

// ============================================================
// IntentGuard 测试
// ============================================================

describe('IntentGuard', () => {
  describe('keyword 触发精确匹配', () => {
    it('应精确匹配关键字（大小写不敏感）', () => {
      const policies: Policy[] = [
        {
          id: 'test-keyword',
          type: 'intent_guard',
          name: '测试关键字',
          enabled: true,
          priority: 100,
          trigger: { mode: 'keyword', keywords: ['Force Push'] },
          action: { block: true, response: 'blocked' },
        },
      ];

      // 大小写不敏感匹配
      const results = IntentGuard.evaluate('please force push to main', policies);
      expect(results.length).toBe(1);
      expect(results[0].policyId).toBe('test-keyword');
      expect(results[0].matched).toBe(true);
      expect(results[0].action.block).toBe(true);
    });

    it('未命中关键字应返回空数组', () => {
      const policies: Policy[] = [
        {
          id: 'test-keyword',
          type: 'intent_guard',
          name: '测试关键字',
          enabled: true,
          priority: 100,
          trigger: { mode: 'keyword', keywords: ['rm -rf'] },
          action: { block: true, response: 'blocked' },
        },
      ];

      const results = IntentGuard.evaluate('hello world', policies);
      expect(results).toEqual([]);
    });

    it('内置规则应能匹配危险关键字', () => {
      const results = IntentGuard.evaluate('请帮我删除 .env 文件', IntentGuard.BUILTIN_RULES);
      expect(results.length).toBeGreaterThan(0);
      expect(IntentGuard.isBlocked(results)).toBe(true);
    });
  });

  describe('阻止危险请求', () => {
    it('应阻止 rm -rf 请求', () => {
      const results = IntentGuard.evaluate('请执行 rm -rf /', IntentGuard.BUILTIN_RULES);
      expect(IntentGuard.isBlocked(results)).toBe(true);
      const reason = IntentGuard.getBlockReason(results);
      expect(reason).toContain('递归删除');
    });

    it('应阻止 force push 请求', () => {
      const results = IntentGuard.evaluate('git push --force origin main', IntentGuard.BUILTIN_RULES);
      expect(IntentGuard.isBlocked(results)).toBe(true);
      expect(IntentGuard.getBlockReason(results)).toContain('force push');
    });

    it('应阻止删除生产环境配置', () => {
      const results = IntentGuard.evaluate('请删除生产环境的 .env', IntentGuard.BUILTIN_RULES);
      expect(IntentGuard.isBlocked(results)).toBe(true);
    });

    it('安全请求不应被阻止', () => {
      const results = IntentGuard.evaluate('请帮我写一个函数', IntentGuard.BUILTIN_RULES);
      expect(IntentGuard.isBlocked(results)).toBe(false);
    });

    it('禁用的策略不应被评估', () => {
      const disabled: Policy[] = IntentGuard.BUILTIN_RULES.map((p) => ({ ...p, enabled: false }));
      const results = IntentGuard.evaluate('rm -rf /', disabled);
      expect(results).toEqual([]);
    });
  });
});

// ============================================================
// Playbook 测试
// ============================================================

describe('Playbook', () => {
  describe('命中后返回 SOP 内容', () => {
    it('应匹配 API 设计关键字并返回 SOP', () => {
      const results = Playbook.evaluate('请帮我设计 API', Playbook.BUILTIN_PLAYBOOKS);
      expect(results.length).toBe(1);
      expect(results[0].policyId).toBe('api-design-sop');
      expect(results[0].action.injectPrompt).toContain('OpenAPI schema');

      const prompts = Playbook.getPrompts(results);
      expect(prompts.length).toBe(1);
      expect(prompts[0]).toContain('OpenAPI');
    });

    it('应匹配数据库迁移关键字并返回 SOP', () => {
      const results = Playbook.evaluate('我需要做数据库迁移', Playbook.BUILTIN_PLAYBOOKS);
      expect(results.length).toBe(1);
      expect(results[0].policyId).toBe('db-migration-sop');
      expect(results[0].action.injectPrompt).toContain('迁移文件');
    });

    it('未命中应返回空数组', () => {
      const results = Playbook.evaluate('今天天气不错', Playbook.BUILTIN_PLAYBOOKS);
      expect(results).toEqual([]);
      expect(Playbook.getPrompts(results)).toEqual([]);
    });
  });
});

// ============================================================
// ToolGuide 测试
// ============================================================

describe('ToolGuide', () => {
  describe('追加工具上下文', () => {
    it('应匹配 git_op 工具并返回 extraContext', () => {
      const results = ToolGuide.evaluate('git_op', ToolGuide.BUILTIN_GUIDES);
      expect(results.length).toBe(1);
      expect(results[0].action.extraContext).toContain('typecheck');

      const ctx = ToolGuide.getExtraContext(results);
      expect(ctx).toContain('git push');
    });

    it('未匹配的工具应返回空', () => {
      const results = ToolGuide.evaluate('unknown_tool', ToolGuide.BUILTIN_GUIDES);
      expect(results).toEqual([]);
      expect(ToolGuide.getExtraContext(results)).toBe('');
    });
  });
});

// ============================================================
// ToolApproval 测试
// ============================================================

describe('ToolApproval', () => {
  describe('检测需要审批的工具', () => {
    it('应检测 file_write 需要审批（启用后）', () => {
      const enabled: Policy[] = ToolApproval.BUILTIN_APPROVALS.map((p) => ({ ...p, enabled: true }));
      const results = ToolApproval.evaluate('file_write', enabled);

      expect(ToolApproval.requiresApproval(results)).toBe(true);
      const msg = ToolApproval.getApprovalMessage(results);
      expect(msg).toContain('修改文件');
    });

    it('应检测 shell_exec 需要审批（启用后）', () => {
      const enabled: Policy[] = ToolApproval.BUILTIN_APPROVALS.map((p) => ({ ...p, enabled: true }));
      const results = ToolApproval.evaluate('execute_command', enabled);

      expect(ToolApproval.requiresApproval(results)).toBe(true);
      expect(ToolApproval.getApprovalMessage(results)).toContain('Shell');
    });

    it('默认禁用时应不要求审批', () => {
      const results = ToolApproval.evaluate('file_write', ToolApproval.BUILTIN_APPROVALS);
      expect(ToolApproval.requiresApproval(results)).toBe(false);
    });

    it('未匹配的工具不应要求审批', () => {
      const enabled: Policy[] = ToolApproval.BUILTIN_APPROVALS.map((p) => ({ ...p, enabled: true }));
      const results = ToolApproval.evaluate('file_read', enabled);
      expect(ToolApproval.requiresApproval(results)).toBe(false);
    });
  });
});

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

// ============================================================
// ReasoningMode 测试
// ============================================================

describe('ReasoningMode', () => {
  describe('三种模式配置正确', () => {
    it('fast 模式应优先成本', () => {
      const cfg = MODE_CONFIGS.fast;
      expect(cfg.mode).toBe('fast');
      expect(cfg.preferCheaper).toBe(true);
      expect(cfg.maxRetries).toBe(1);
      expect(cfg.reasoningEffort).toBe('low');
      expect(cfg.maxTokens).toBe(4096);
    });

    it('balanced 模式应居中', () => {
      const cfg = MODE_CONFIGS.balanced;
      expect(cfg.mode).toBe('balanced');
      expect(cfg.preferCheaper).toBe(false);
      expect(cfg.maxRetries).toBe(2);
      expect(cfg.reasoningEffort).toBe('medium');
      expect(cfg.maxTokens).toBe(8192);
    });

    it('accurate 模式应最大化质量', () => {
      const cfg = MODE_CONFIGS.accurate;
      expect(cfg.mode).toBe('accurate');
      expect(cfg.preferCheaper).toBe(false);
      expect(cfg.maxRetries).toBe(3);
      expect(cfg.reasoningEffort).toBe('high');
      expect(cfg.maxTokens).toBe(16384);
    });

    it('三种模式的 maxTokens 应递增', () => {
      expect(MODE_CONFIGS.fast.maxTokens).toBeLessThan(MODE_CONFIGS.balanced.maxTokens);
      expect(MODE_CONFIGS.balanced.maxTokens).toBeLessThan(MODE_CONFIGS.accurate.maxTokens);
    });
  });

  describe('getReasoningConfig 返回正确配置', () => {
    it('应返回对应模式的配置', () => {
      expect(getReasoningConfig('fast').mode).toBe('fast');
      expect(getReasoningConfig('balanced').mode).toBe('balanced');
      expect(getReasoningConfig('accurate').mode).toBe('accurate');
    });

    it('getDefaultMode 应返回 balanced', () => {
      expect(getDefaultMode()).toBe('balanced');
    });

    it('getReasoningConfig 返回的应是 MODE_CONFIGS 中的对象', () => {
      // 验证引用一致（同一对象）
      expect(getReasoningConfig('fast')).toBe(MODE_CONFIGS.fast);
      expect(getReasoningConfig('balanced')).toBe(MODE_CONFIGS.balanced);
      expect(getReasoningConfig('accurate')).toBe(MODE_CONFIGS.accurate);
    });
  });
});
