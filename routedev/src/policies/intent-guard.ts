// src/policies/intent-guard.ts
// 意图护栏
//
// 设计目标：
//   1. 提供内置危险意图规则（删除生产配置、force push、rm -rf 等）
//   2. evaluate 方法对用户输入做关键字匹配
//   3. 命中后返回 block=true 的 PolicyEvalResult
//
// 与 PolicyEngine 的关系：
//   - IntentGuard 提供规则库（BUILTIN_RULES）
//   - PolicyEngine 负责调度（evaluateInput 内部调用 IntentGuard.evaluate）
//   - 也可独立使用：直接调用 IntentGuard.evaluate(userInput, policies)

import type { Policy, PolicyEvalResult } from './policy-engine.js';

// ============================================================
// IntentGuard
// ============================================================

export class IntentGuard {
  /**
   * 内置危险意图规则
   *
   * priority=100 保证优先于其他策略评估
   */
  static readonly BUILTIN_RULES: Policy[] = [
    {
      id: 'block-delete-prod-config',
      type: 'intent_guard',
      name: '禁止删除生产配置',
      enabled: true,
      priority: 100,
      trigger: {
        mode: 'keyword',
        keywords: ['删除', '清空', '重置', '.env', 'production', '生产环境'],
      },
      action: {
        block: true,
        response: '该操作可能影响生产环境，请确认后手动执行。',
      },
    },
    {
      id: 'block-force-push',
      type: 'intent_guard',
      name: '禁止 force push',
      enabled: true,
      priority: 100,
      trigger: {
        mode: 'keyword',
        keywords: ['force push', 'push --force', 'push -f'],
      },
      action: {
        block: true,
        response: '禁止 force push，请使用 --force-with-lease 或联系管理员。',
      },
    },
    {
      id: 'block-rm-rf',
      type: 'intent_guard',
      name: '禁止 rm -rf',
      enabled: true,
      priority: 100,
      trigger: {
        mode: 'keyword',
        keywords: ['rm -rf', 'rmdir /s', 'del /f /s /q'],
      },
      action: {
        block: true,
        response: '禁止递归删除操作。',
      },
    },
  ];

  /**
   * 评估用户输入
   *
   * 只评估 type='intent_guard' 且 enabled=true 的策略
   * 关键字匹配（大小写不敏感，子串匹配）
   *
   * @returns 所有命中的策略结果（matched=true）；未命中不返回
   */
  static evaluate(userInput: string, policies: Policy[]): PolicyEvalResult[] {
    if (!userInput) return [];

    const lowerInput = userInput.toLowerCase();
    const results: PolicyEvalResult[] = [];

    // 按 priority 降序评估
    const sorted = [...policies]
      .filter((p) => p.type === 'intent_guard' && p.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const policy of sorted) {
      const matched = IntentGuard.matchKeywords(policy.trigger.keywords ?? [], lowerInput);
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
   * 判断是否被阻止
   */
  static isBlocked(results: PolicyEvalResult[]): boolean {
    return results.some((r) => r.action.block === true);
  }

  /**
   * 获取阻止原因（取第一个 block=true 的 response）
   */
  static getBlockReason(results: PolicyEvalResult[]): string | undefined {
    const blocked = results.find((r) => r.action.block === true);
    return blocked?.action.response;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 关键字匹配（大小写不敏感，子串匹配） */
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
 * 创建内置 Intent Guard 策略列表
 *
 * 返回 BUILTIN_RULES 的深拷贝，避免外部修改影响内置规则
 */
export function createBuiltinIntentGuardPolicies(): Policy[] {
  return IntentGuard.BUILTIN_RULES.map((p) => ({
    ...p,
    trigger: { ...p.trigger, keywords: p.trigger.keywords ? [...p.trigger.keywords] : undefined },
    action: { ...p.action },
  }));
}
