// src/policies/call-owner-mixin.ts
// Phase 66 Task 3：Call Owner Mixin
//
// 设计目标：
//   1. 静态工具方法，注入 callOwner 字段到 policy
//   2. 判断是否需要 call owner（三分支：always_call/always_pass/conditional）
//   3. 判断是否为高风险动作（默认关键词集）
//   4. fail-open：异常时返回 false（不调用 owner）
//   5. 向后兼容：无 callOwner 字段时按 always_pass 处理

import type { CallOwnerStrategy } from './call-owner-coordinator.js';

// ============================================================
// 默认高风险关键词
// ============================================================

/** 默认高风险关键词：命中任一即视为高风险动作 */
const HIGH_RISK_KEYWORDS: readonly string[] = [
  '删除',
  '执行',
  '修改 .env',
  'rm -rf',
  'format',
  'drop table',
  'force push',
];

// ============================================================
// CallOwnerMixin
// ============================================================

export class CallOwnerMixin {
  /**
   * 判断是否需要 call owner
   * - always_call → true
   * - always_pass → false
   * - conditional → 调用 callOwnerCondition（无 condition 时返回 false）
   * - 无 callOwner 字段 → false（向后兼容，按 always_pass）
   */
  static shouldCallOwner(
    policy: { callOwner?: CallOwnerStrategy; callOwnerCondition?: (action: any) => boolean },
    action: any,
  ): boolean {
    try {
      const strategy = policy?.callOwner;
      if (strategy === 'always_call') return true;
      if (strategy === 'always_pass') return false;
      if (strategy === 'conditional') {
        return policy?.callOwnerCondition
          ? Boolean(policy.callOwnerCondition(action))
          : false;
      }
      // 无 callOwner 字段或未知值：向后兼容，按 always_pass
      return false;
    } catch {
      // fail-open：异常时返回 false
      return false;
    }
  }

  /**
   * 判断是否为高风险动作
   * 命中默认关键词任一即视为高风险（大小写不敏感）
   * 同时检查 description 和 tool 字段
   */
  static isHighRiskAction(action: { description?: string; tool?: string }): boolean {
    try {
      const desc = String(action?.description ?? '');
      const tool = String(action?.tool ?? '');
      const text = `${desc} ${tool}`.toLowerCase();
      if (!text.trim()) return false;
      return HIGH_RISK_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
    } catch {
      // fail-open
      return false;
    }
  }

  /**
   * 注入 callOwner 字段（不修改原 policy，返回新对象）
   * 保留原 policy 所有其他字段
   */
  static inject(policy: any, callOwner: CallOwnerStrategy): any {
    return { ...policy, callOwner };
  }

  /**
   * 按类型批量注入 callOwner
   * 仅匹配 policyType 的 policy 被注入，其他原样返回（浅拷贝）
   */
  static injectBatch(
    policies: any[],
    policyType: string,
    callOwner: CallOwnerStrategy,
  ): any[] {
    return (policies ?? []).map((p) => {
      if (p?.type === policyType) {
        return { ...p, callOwner };
      }
      return p;
    });
  }
}
