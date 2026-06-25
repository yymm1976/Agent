// src/policies/tool-guide.ts
// 工具增强
//
// 设计目标：
//   1. 提供内置工具使用指南（如 git_op 安全指南）
//   2. 命中后返回 extraContext（追加到工具描述）
//   3. getExtraContext 聚合所有命中的上下文

import type { Policy, PolicyEvalResult } from './policy-engine.js';

// ============================================================
// ToolGuide
// ============================================================

export class ToolGuide {
  /**
   * 内置工具指南
   *
   * priority=30 低于 Playbook（50），属于工具调用阶段的辅助提示
   */
  static readonly BUILTIN_GUIDES: Policy[] = [
    {
      id: 'git-op-guide',
      type: 'tool_guide',
      name: 'git_op 安全指南',
      enabled: true,
      priority: 30,
      trigger: {
        mode: 'keyword',
        keywords: ['git_op'],
      },
      action: {
        extraContext: '执行 git push 前必须先跑 typecheck 和 tests；禁止 force push。',
      },
    },
  ];

  /**
   * 评估工具调用
   *
   * 只评估 type='tool_guide' 且 enabled=true 的策略
   * 匹配对象是工具名（toolName）
   */
  static evaluate(toolName: string, policies: Policy[]): PolicyEvalResult[] {
    if (!toolName) return [];

    const lowerName = toolName.toLowerCase();
    const results: PolicyEvalResult[] = [];

    const sorted = [...policies]
      .filter((p) => p.type === 'tool_guide' && p.enabled)
      .sort((a, b) => b.priority - a.priority);

    for (const policy of sorted) {
      const matched = ToolGuide.matchKeywords(policy.trigger.keywords ?? [], lowerName);
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
   * 从评估结果中提取所有 extraContext
   *
   * 用于追加到工具描述或调用上下文
   */
  static getExtraContext(results: PolicyEvalResult[]): string {
    return results
      .filter((r) => r.matched && r.action.extraContext)
      .map((r) => r.action.extraContext as string)
      .join('\n');
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
 * 创建内置 Tool Guide 策略列表
 *
 * 返回 BUILTIN_GUIDES 的深拷贝
 */
export function createBuiltinToolGuidePolicies(): Policy[] {
  return ToolGuide.BUILTIN_GUIDES.map((p) => ({
    ...p,
    trigger: { ...p.trigger, keywords: p.trigger.keywords ? [...p.trigger.keywords] : undefined },
    action: { ...p.action },
  }));
}
