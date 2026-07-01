// src/policies/tool-guide.ts
// 工具增强
//
// 设计目标：
//   1. 提供内置工具使用指南（如 git_op 安全指南）
//   2. 命中后通过 PolicyEngine 统一调度，返回 extraContext（追加到工具描述）
//
// 注：静态 evaluate / getExtraContext / matchKeywords 已作为死代码删除
//     （PolicyEngine 内部通过 evaluateAction 遍历 policies 数组直接处理）

import type { Policy } from './policy-engine.js';

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
