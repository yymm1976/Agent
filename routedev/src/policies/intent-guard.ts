// src/policies/intent-guard.ts
// 意图护栏
//
// 设计目标：
//   1. 提供内置危险意图规则（删除生产配置、force push、rm -rf 等）
//   2. 命中后通过 PolicyEngine 统一调度，返回 block=true 的 PolicyEvalResult
//
// 与 PolicyEngine 的关系：
//   - IntentGuard 提供规则库（BUILTIN_RULES）
//   - PolicyEngine 负责调度（evaluateInput 遍历 policies 数组直接处理）
//
// 注：静态 evaluate / isBlocked / getBlockReason / matchKeywords 已作为死代码删除
//     （PolicyEngine 内部通过 evaluateAction 遍历 policies 数组直接处理，不走这些静态方法）

import type { Policy } from './policy-engine.js';

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
