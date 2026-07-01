// src/policies/tool-approval.ts
// 工具审批
//
// 设计目标：
//   1. 提供内置审批策略（写文件、网络请求、Shell 命令）
//   2. 默认禁用，由用户在配置中启用
//   3. 命中后通过 PolicyEngine 统一调度，返回 requireApproval=true
//
// 注：静态 evaluate / requiresApproval / getApprovalMessage / matchKeywords 已作为死代码删除
//     （PolicyEngine 内部通过 evaluateAction 遍历 policies 数组直接处理）

import type { Policy } from './policy-engine.js';

// ============================================================
// ToolApproval
// ============================================================

export class ToolApproval {
  /**
   * 内置审批策略
   *
   * priority=40 高于 ToolGuide（30），保证审批优先于指南
   * 默认 enabled=false，用户按需启用
   */
  static readonly BUILTIN_APPROVALS: Policy[] = [
    {
      id: 'approve-write',
      type: 'tool_approval',
      name: '写文件审批',
      enabled: false,
      priority: 40,
      trigger: {
        mode: 'keyword',
        keywords: ['file_write', 'file_edit', 'delete_file'],
      },
      action: {
        requireApproval: true,
        approvalMessage: '即将修改文件，请确认。',
      },
    },
    {
      id: 'approve-network',
      type: 'tool_approval',
      name: '网络请求审批',
      enabled: false,
      priority: 40,
      trigger: {
        mode: 'keyword',
        keywords: ['fetch', 'http_request'],
      },
      action: {
        requireApproval: true,
        approvalMessage: '即将向外部地址发送网络请求，请确认。',
      },
    },
    {
      id: 'approve-shell',
      type: 'tool_approval',
      name: 'Shell 命令审批',
      enabled: false,
      priority: 40,
      trigger: {
        mode: 'keyword',
        keywords: ['execute_command', 'shell_exec'],
      },
      action: {
        requireApproval: true,
        approvalMessage: '即将执行 Shell 命令，请确认。',
      },
    },
  ];
}

// ============================================================
// 工厂函数（供 app-init.ts feature-detect 加载）
// ============================================================

/**
 * 创建内置 Tool Approval 策略列表
 *
 * @param mode 审批模式：
 *   - 'on' / 'enable' / 'true' / 'always'：启用所有审批策略
 *   - 其他（含 'off' / 'disabled'）：保持默认（禁用）
 */
export function createBuiltinToolApprovalPolicies(mode: string): Policy[] {
  const enableAll = ['on', 'enable', 'enabled', 'true', 'always', '1'].includes(
    String(mode || '').toLowerCase(),
  );
  return ToolApproval.BUILTIN_APPROVALS.map((p) => ({
    ...p,
    enabled: enableAll ? true : p.enabled,
    trigger: { ...p.trigger, keywords: p.trigger.keywords ? [...p.trigger.keywords] : undefined },
    action: { ...p.action },
  }));
}
