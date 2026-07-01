// src/policies/policy-engine.ts
// 策略引擎核心
//
// 设计目标：
//   1. 统一管理四类策略：intent_guard / playbook / tool_guide / tool_approval
//   2. 按优先级排序评估
//   3. evaluateInput 评估用户输入（Intent Guard + Playbook）
//   4. evaluateToolCall 评估工具调用（Tool Guide + Tool Approval）
//   5. 支持启用/禁用、增删、导入/导出
//
// 评估顺序：高优先级先评估，但所有匹配的策略都会返回（不短路）
// 这样调用方可以聚合多个策略的 action（如同时注入 prompt 和要求审批）

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

export type PolicyType = 'intent_guard' | 'playbook' | 'tool_guide' | 'tool_approval';

export interface PolicyTrigger {
  mode: 'keyword' | 'semantic' | 'always';
  keywords?: string[];
  semanticQuery?: string;
}

export interface PolicyAction {
  block?: boolean;
  response?: string;
  injectPrompt?: string;
  toolDescription?: string;
  extraContext?: string;
  requireApproval?: boolean;
  approvalMessage?: string;
}

export interface Policy {
  id: string;
  type: PolicyType;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  trigger: PolicyTrigger;
  action: PolicyAction;
}

export interface PolicyEvalResult {
  matched: boolean;
  action: PolicyAction;
  policyId: string;
  policyName: string;
}

/**
 * Phase 53 Task 3：Agent 动作描述（动作级策略评估的输入）
 * 区别于 evaluateToolCall 的工具级粒度，evaluateAction 评估更通用的动作语义
 */
export interface AgentAction {
  /** 工具名（如 "file_write"） */
  toolName: string;
  /** 动作描述（如 "修改 .env 文件" / "执行 rm -rf 命令"） */
  description: string;
  /** 工具参数（可选，用于更精细的策略匹配） */
  args?: Record<string, unknown>;
}

/**
 * Phase 53 Task 3：策略决策（evaluateAction 的返回值）
 * 借鉴 AGT 的 fail-closed 模式：无匹配规则时默认 deny
 */
export interface PolicyDecision {
  /** 是否拒绝执行 */
  denied: boolean;
  /** 拒绝原因（denied=true 时非空） */
  reason: string | null;
  /** 匹配的策略数量 */
  matchedPolicies: number;
}

// ============================================================
// PolicyEngine
// ============================================================

export class PolicyEngine {
  private policies: Policy[] = [];
  /** 标记是否需要重新排序 */
  private dirty = false;
  /**
   * Phase 53 Task 3：默认策略（fail-closed 控制）
   * 无匹配规则时：'deny' → 拒绝，'allow' → 允许
   * 默认 'deny'（借鉴 AGT 的 fail-closed 原则）
   */
  private defaultPolicy: 'deny' | 'allow' = 'deny';

  /**
   * 添加策略
   *
   * 如果 id 已存在，覆盖旧策略
   */
  addPolicy(policy: Policy): void {
    const idx = this.policies.findIndex((p) => p.id === policy.id);
    if (idx >= 0) {
      this.policies[idx] = policy;
    } else {
      this.policies.push(policy);
    }
    this.dirty = true;
    logger.debug('PolicyEngine: policy added', { id: policy.id, type: policy.type });
  }

  /**
   * 移除策略
   */
  removePolicy(id: string): void {
    const before = this.policies.length;
    this.policies = this.policies.filter((p) => p.id !== id);
    const removed = this.policies.length < before;
    if (removed) {
      logger.debug('PolicyEngine: policy removed', { id });
    }
  }

  /**
   * 启用策略
   */
  enablePolicy(id: string): void {
    const p = this.policies.find((p) => p.id === id);
    if (p) {
      p.enabled = true;
      logger.debug('PolicyEngine: policy enabled', { id });
    }
  }

  /**
   * 禁用策略
   */
  disablePolicy(id: string): void {
    const p = this.policies.find((p) => p.id === id);
    if (p) {
      p.enabled = false;
      logger.debug('PolicyEngine: policy disabled', { id });
    }
  }

  /**
   * 评估用户输入（Intent Guard + Playbook）
   *
   * 只评估 type 为 intent_guard 或 playbook 的策略
   */
  evaluateInput(userInput: string): PolicyEvalResult[] {
    this.sortByPriority();
    const results: PolicyEvalResult[] = [];

    for (const policy of this.policies) {
      if (!policy.enabled) continue;
      if (policy.type !== 'intent_guard' && policy.type !== 'playbook') continue;

      const matched = this.matchTrigger(policy.trigger, userInput);
      results.push({
        matched,
        action: matched ? policy.action : {},
        policyId: policy.id,
        policyName: policy.name,
      });
    }

    return results;
  }

  /**
   * 评估工具调用（Tool Guide + Tool Approval）
   *
   * 只评估 type 为 tool_guide 或 tool_approval 的策略
   * 匹配对象是工具名（toolName）
   */
  evaluateToolCall(toolName: string, _args: Record<string, unknown>): PolicyEvalResult[] {
    this.sortByPriority();
    const results: PolicyEvalResult[] = [];

    for (const policy of this.policies) {
      if (!policy.enabled) continue;
      if (policy.type !== 'tool_guide' && policy.type !== 'tool_approval') continue;

      const matched = this.matchTrigger(policy.trigger, toolName);
      results.push({
        matched,
        action: matched ? policy.action : {},
        policyId: policy.id,
        policyName: policy.name,
      });
    }

    return results;
  }

  /**
   * Phase 53 Task 3：评估 Agent 动作的策略合规性（动作级，区别于 evaluateToolCall 的工具级）
   *
   * 与 evaluateToolCall 的差异：
   *   - evaluateToolCall 匹配工具名（如 "file_write"）
   *   - evaluateAction 匹配动作描述（如 "修改 .env 文件"、"执行 rm 命令"）
   *
   * Fail-closed 默认策略：无匹配规则时返回 deny（受 config.policyEngine.defaultPolicy 控制）
   *
   * @param action 动作对象（toolName + args + 描述）
   * @returns PolicyDecision，deny 时包含 reason
   */
  evaluateAction(action: AgentAction): PolicyDecision {
    this.sortByPriority();

    // 构造匹配文本：工具名 + 动作描述
    const matchText = [action.toolName, action.description].filter(Boolean).join(' ');

    let denyReason: string | null = null;
    let anyMatched = false;

    // 按 priority 顺序评估所有匹配的策略
    // 冲突解决策略：deny-overrides（任一 deny 则整体 deny）
    for (const policy of this.policies) {
      if (!policy.enabled) continue;
      // 动作级策略：评估 intent_guard / playbook / tool_guide / tool_approval 全部
      const matched = this.matchTrigger(policy.trigger, matchText);
      if (!matched) continue;

      anyMatched = true;
      if (policy.action.block && denyReason === null) {
        // deny-overrides：第一个 block 即拒绝
        denyReason = policy.action.response ?? `Policy "${policy.name}" blocked this action`;
      }
    }

    // Fail-closed：无匹配规则时按 defaultPolicy 决定
    // 注意：defaultPolicy 由调用方通过 setDefaultPolicy 注入，默认 'deny'
    if (!anyMatched) {
      if (this.defaultPolicy === 'deny') {
        return {
          denied: true,
          reason: `No matching policy, fail-closed (defaultPolicy=deny)`,
          matchedPolicies: 0,
        };
      }
      // defaultPolicy === 'allow'：允许
      return {
        denied: false,
        reason: null,
        matchedPolicies: 0,
      };
    }

    return {
      denied: denyReason !== null,
      reason: denyReason,
      matchedPolicies: anyMatched ? 1 : 0,
    };
  }

  /** Phase 53 Task 3：设置默认策略（fail-closed 控制） */
  setDefaultPolicy(policy: 'deny' | 'allow'): void {
    this.defaultPolicy = policy;
  }

  /**
   * 按优先级排序（高优先级在前）
   *
   * priority 数值越大优先级越高
   */
  private sortByPriority(): void {
    if (!this.dirty) return;
    this.policies.sort((a, b) => b.priority - a.priority);
    this.dirty = false;
  }

  /**
   * 导出所有策略
   */
  exportAll(): Policy[] {
    return this.policies.map((p) => ({
      ...p,
      trigger: { ...p.trigger, keywords: p.trigger.keywords ? [...p.trigger.keywords] : undefined },
      action: { ...p.action },
    }));
  }

  /**
   * 导入策略（覆盖现有）
   */
  importAll(policies: Policy[]): void {
    this.policies = policies.map((p) => ({
      ...p,
      trigger: { ...p.trigger, keywords: p.trigger.keywords ? [...p.trigger.keywords] : undefined },
      action: { ...p.action },
    }));
    this.dirty = true;
    logger.info('PolicyEngine: policies imported', { count: this.policies.length });
  }

  /** 获取所有策略（按当前顺序） */
  list(): Policy[] {
    this.sortByPriority();
    return [...this.policies];
  }

  /** 按 id 获取策略 */
  get(id: string): Policy | undefined {
    return this.policies.find((p) => p.id === id);
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 判断 trigger 是否匹配输入
   *
   * - mode='always'：始终匹配
   * - mode='keyword'：keywords 中任一关键字在输入中出现（子串匹配，大小写不敏感）
   * - mode='semantic'：当前实现退化为关键字匹配（无 embedding）
   */
  private matchTrigger(trigger: PolicyTrigger, input: string): boolean {
    if (trigger.mode === 'always') return true;

    const keywords = trigger.keywords ?? [];
    if (keywords.length === 0) return false;

    const lowerInput = input.toLowerCase();
    for (const kw of keywords) {
      if (!kw) continue;
      if (lowerInput.includes(kw.toLowerCase())) {
        return true;
      }
    }
    return false;
  }
}
