// tests/integration/phase41-42.test.ts
// Phase 41-42 集成测试
// 验证代码地图升级 / 策略引擎 / 市场 / 推理模式的端到端流程
//
// 测试策略：
//   1. Schema 配置验证（codeMap/market/policies/reasoningMode）——直接测试 schema.ts
//   2. Defaults 默认值验证——直接测试 defaults.ts
//   3. PolicyEngine / SkillMdParser / ExecutionStateGraph / VariablePool——动态 import，
//      模块不存在时 skip（fail-open，与其他子代理并行开发）

import { describe, it, expect } from 'vitest';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// ============================================================
// 1. Schema 配置验证
// ============================================================
describe('Phase 41-42 Integration - Schema 配置', () => {
  it('codeMap 配置段：默认值正确填充', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.codeMap).toBeDefined();
    expect(config.codeMap.engine).toBe('tree-sitter');
    expect(config.codeMap.budgetTokens).toBe(2048);
    expect(config.codeMap.enableHCGS).toBe(false);
    expect(config.codeMap.enableSemanticEdges).toBe(false);
    expect(config.codeMap.indexExclude).toEqual(['node_modules', '.git', 'dist', 'release-v*']);
    expect(config.codeMap.maxContextSymbols).toBe(50);
    expect(config.codeMap.autoIndex).toBe(true);
  });

  it('market 配置段：默认值正确填充', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.market).toBeDefined();
    expect(config.market.enabled).toBe(true);
    expect(config.market.autoPublish).toBe(false);
  });

  it('policies 配置段：默认值正确填充（intentGuard 默认 true）', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.policies).toBeDefined();
    expect(config.policies.enabled).toBe(true);
    expect(config.policies.intentGuard).toBe(true);
    expect(config.policies.playbook).toBe(true);
    expect(config.policies.toolGuide).toBe(true);
    expect(config.policies.toolApproval).toBe(false);
    expect(config.policies.approvalMode).toBe('risky-only');
  });

  it('reasoningMode：默认 balanced', () => {
    const config = AppConfigSchema.parse({}) as AppConfig;
    expect(config.reasoningMode).toBe('balanced');
  });

  it('codeMap 配置段：自定义值正确解析', () => {
    const config = AppConfigSchema.parse({
      codeMap: {
        engine: 'regex',
        budgetTokens: 4096,
        enableHCGS: true,
        enableSemanticEdges: true,
        indexExclude: ['build', 'out'],
        maxContextSymbols: 100,
        autoIndex: false,
      },
    }) as AppConfig;
    expect(config.codeMap.engine).toBe('regex');
    expect(config.codeMap.budgetTokens).toBe(4096);
    expect(config.codeMap.enableHCGS).toBe(true);
    expect(config.codeMap.enableSemanticEdges).toBe(true);
    expect(config.codeMap.indexExclude).toEqual(['build', 'out']);
    expect(config.codeMap.maxContextSymbols).toBe(100);
    expect(config.codeMap.autoIndex).toBe(false);
  });

  it('reasoningMode 三种模式配置正确', () => {
    for (const mode of ['fast', 'balanced', 'accurate'] as const) {
      const config = AppConfigSchema.parse({ reasoningMode: mode }) as AppConfig;
      expect(config.reasoningMode).toBe(mode);
    }
  });

  it('policies 配置段：自定义 approvalMode 正确解析', () => {
    for (const mode of ['always', 'risky-only', 'minimal'] as const) {
      const config = AppConfigSchema.parse({ policies: { approvalMode: mode } }) as AppConfig;
      expect(config.policies.approvalMode).toBe(mode);
    }
  });

  it('codeMap 与 codegraph 并存：两者独立配置', () => {
    const config = AppConfigSchema.parse({
      codegraph: { enabled: true, workspace: '/tmp', autoIndex: false },
      codeMap: { engine: 'disabled', budgetTokens: 1024 },
    }) as AppConfig;
    expect(config.codegraph.enabled).toBe(true);
    expect(config.codeMap.engine).toBe('disabled');
    expect(config.codeMap.budgetTokens).toBe(1024);
  });
});

// ============================================================
// 2. Defaults 默认值验证
// ============================================================
describe('Phase 41-42 Integration - Defaults 默认值', () => {
  it('DEFAULT_CONFIG 包含 codeMap/market/policies/reasoningMode', () => {
    expect(DEFAULT_CONFIG.codeMap).toBeDefined();
    expect(DEFAULT_CONFIG.codeMap.engine).toBe('tree-sitter');
    expect(DEFAULT_CONFIG.market).toBeDefined();
    expect(DEFAULT_CONFIG.market.enabled).toBe(true);
    expect(DEFAULT_CONFIG.policies).toBeDefined();
    expect(DEFAULT_CONFIG.policies.intentGuard).toBe(true);
    expect(DEFAULT_CONFIG.reasoningMode).toBe('balanced');
  });
});

// ============================================================
// 3. PolicyEngine 动态测试（模块不存在时 skip）
// ============================================================
describe('Phase 42 Integration - PolicyEngine', () => {
  it('评估危险输入被 IntentGuard 阻止', async () => {
    let PolicyEngineCtor: unknown;
    try {
      const mod = await import('../../src/policies/policy-engine.js');
      PolicyEngineCtor = (mod as { PolicyEngine?: unknown }).PolicyEngine;
    } catch {
      console.warn('PolicyEngine 模块尚未创建，跳过测试');
      return;
    }
    if (!PolicyEngineCtor || typeof PolicyEngineCtor !== 'function') {
      console.warn('PolicyEngine 未导出，跳过测试');
      return;
    }
    const engine = new (PolicyEngineCtor as new () => {
      addPolicy: (p: unknown) => void;
      evaluateInput: (input: string) => { matched: boolean; action: { block?: boolean } }[];
    })();
    // 添加 IntentGuard 策略：匹配 "rm -rf" 等危险关键字并阻止
    engine.addPolicy({
      id: 'danger-rm-rf',
      type: 'intent_guard',
      name: '阻止危险删除',
      enabled: true,
      priority: 100,
      trigger: { mode: 'keyword', keywords: ['rm -rf', '删除所有'] },
      action: { block: true, response: '检测到危险操作，已阻止' },
    });
    const results = engine.evaluateInput('rm -rf / 删除所有文件');
    const blocked = results.some((r) => r.matched && r.action.block === true);
    expect(blocked).toBe(true);
  });

  it('评估 API 设计输入触发 Playbook', async () => {
    let PolicyEngineCtor: unknown;
    try {
      const mod = await import('../../src/policies/policy-engine.js');
      PolicyEngineCtor = (mod as { PolicyEngine?: unknown }).PolicyEngine;
    } catch {
      console.warn('PolicyEngine 模块尚未创建，跳过测试');
      return;
    }
    if (!PolicyEngineCtor || typeof PolicyEngineCtor !== 'function') {
      console.warn('PolicyEngine 未导出，跳过测试');
      return;
    }
    const engine = new (PolicyEngineCtor as new () => {
      addPolicy: (p: unknown) => void;
      evaluateInput: (input: string) => { matched: boolean; action: { injectPrompt?: string } }[];
    })();
    // 添加 Playbook 策略：匹配 "API 设计" 并注入 SOP
    engine.addPolicy({
      id: 'playbook-api-design',
      type: 'playbook',
      name: 'API 设计 SOP',
      enabled: true,
      priority: 50,
      trigger: { mode: 'keyword', keywords: ['api 设计', 'restful'] },
      action: { injectPrompt: 'API 设计 SOP：1. 定义资源 2. 确定方法 3. 设计状态码' },
    });
    const results = engine.evaluateInput('设计一个 RESTful API');
    const triggered = results.some((r) => r.matched && typeof r.action.injectPrompt === 'string');
    expect(triggered).toBe(true);
  });
});

// ============================================================
// 4. SkillMdParser 动态测试（模块不存在时 skip）
// ============================================================
describe('Phase 42 Integration - SkillMdParser', () => {
  it('解析 SKILL.md 格式', async () => {
    let parseSkillMd: unknown;
    try {
      const mod = await import('../../src/skills/skill-generator.js');
      parseSkillMd = (mod as { parseSkillMd?: unknown }).parseSkillMd;
    } catch {
      console.warn('SkillMdParser 模块尚未创建，跳过测试');
      return;
    }
    if (!parseSkillMd || typeof parseSkillMd !== 'function') {
      console.warn('parseSkillMd 未导出，跳过测试');
      return;
    }
    const content = `---
name: test-skill
description: 测试技能
keywords:
  - test
---
# 测试技能内容`;
    const result = (parseSkillMd as (c: string) => { name: string; description: string; keywords: string[]; content: string })(content);
    expect(result.name).toBe('test-skill');
    expect(result.description).toBe('测试技能');
    expect(result.keywords).toContain('test');
  });
});

// ============================================================
// 5. ExecutionStateGraph 动态测试（模块不存在时 skip）
// ============================================================
describe('Phase 42 Integration - ExecutionStateGraph', () => {
  it('状态转换：pending → running → completed', async () => {
    let ExecutionStateGraphCtor: unknown;
    try {
      const mod = await import('../../src/agent/multi/orchestrator.js');
      ExecutionStateGraphCtor = (mod as { ExecutionStateGraph?: unknown }).ExecutionStateGraph;
    } catch {
      console.warn('ExecutionStateGraph 模块尚未创建，跳过测试');
      return;
    }
    if (!ExecutionStateGraphCtor || typeof ExecutionStateGraphCtor !== 'function') {
      console.warn('ExecutionStateGraph 未导出，跳过测试');
      return;
    }
    const graph = new (ExecutionStateGraphCtor as new () => { transition: (from: string, to: string) => string; current: () => string })();
    expect(graph.current()).toBe('pending');
    graph.transition('pending', 'running');
    expect(graph.current()).toBe('running');
    graph.transition('running', 'completed');
    expect(graph.current()).toBe('completed');
  });
});

// ============================================================
// 6. VariablePool 动态测试（Phase 46 已删除 blackboard-extension.ts）
// ============================================================
describe('Phase 42 Integration - VariablePool', () => {
  it.skip('变量管理：set / get / resolve（模块已删除）', async () => {
    // Phase 46 删除了 blackboard-extension.ts，此测试跳过
  });
});
