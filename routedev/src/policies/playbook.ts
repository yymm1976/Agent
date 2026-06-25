// src/policies/playbook.ts
// SOP 注入
//
// 设计目标：
//   1. 提供内置 SOP（API 设计、数据库迁移等）
//   2. 命中后返回 injectPrompt（步骤说明）
//   3. getPrompts 聚合所有命中的 prompt 供调用方注入

import type { Policy, PolicyEvalResult } from './policy-engine.js';

// ============================================================
// Playbook
// ============================================================

export class Playbook {
  /**
   * 内置 SOP
   *
   * priority=50 低于 IntentGuard（100），保证危险操作优先阻断
   */
  static readonly BUILTIN_PLAYBOOKS: Policy[] = [
    {
      id: 'api-design-sop',
      type: 'playbook',
      name: 'API 设计 SOP',
      enabled: true,
      priority: 50,
      trigger: {
        mode: 'keyword',
        keywords: ['设计 API', '新增接口', 'REST API', 'API 设计'],
      },
      action: {
        injectPrompt:
          '请按以下步骤设计 API：\n1. 先定义 OpenAPI schema\n2. 再写 handler 单元测试\n3. 最后实现 handler 并接入路由',
      },
    },
    {
      id: 'db-migration-sop',
      type: 'playbook',
      name: '数据库迁移 SOP',
      enabled: true,
      priority: 50,
      trigger: {
        mode: 'keyword',
        keywords: ['数据库迁移', 'migration', 'schema 变更'],
      },
      action: {
        injectPrompt:
          '请按以下步骤执行数据库迁移：\n1. 先创建迁移文件\n2. 在测试环境验证\n3. 更新相关模型和类型\n4. 更新文档',
      },
    },
  ];

  /**
   * 评估用户输入
   *
   * 只评估 type='playbook' 且 enabled=true 的策略
   */
  static evaluate(userInput: string, policies: Policy[]): PolicyEvalResult[] {
    if (!userInput) return [];

    const lowerInput = userInput.toLowerCase();
    const results: PolicyEvalResult[] = [];

    const sorted = [...policies]
      .filter((p) => p.type === 'playbook' && p.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const policy of sorted) {
      const matched = Playbook.matchKeywords(policy.trigger.keywords ?? [], lowerInput);
      if (matched) {
        results.push({
          matched: true,
          action: policy.action,
          policyId: policy.id,
          policyName: policy.name,
        });
      }
    }

    return results;
  }

  /**
   * 从评估结果中提取所有 injectPrompt
   *
   * 用于将命中的 SOP 注入到 LLM 上下文
   */
  static getPrompts(results: PolicyEvalResult[]): string[] {
    return results
      .filter((r) => r.matched && r.action.injectPrompt)
      .map((r) => r.action.injectPrompt as string);
  }

  // ============================================================
  // 内部方法
  // ============================================================

  private static matchKeywords(keywords: string[], lowerInput: string): boolean {
    if (keywords.length === 0) return false;
    for (const kw of keywords) {
      if (!kw) continue;
      if (lowerInput.includes(kw.toLowerCase())) {
        return true;
      }
    }
    return false;
  }
}

// ============================================================
// 工厂函数（供 app-init.ts feature-detect 加载）
// ============================================================

/**
 * 创建内置 Playbook 策略列表
 *
 * 返回 BUILTIN_PLAYBOOKS 的深拷贝
 */
export function createBuiltinPlaybookPolicies(): Policy[] {
  return Playbook.BUILTIN_PLAYBOOKS.map((p) => ({
    ...p,
    trigger: { ...p.trigger, keywords: p.trigger.keywords ? [...p.trigger.keywords] : undefined },
    action: { ...p.action },
  }));
}
