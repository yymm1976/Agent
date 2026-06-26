// src/agents/delegation-gate.ts
// 委托门控：父 Agent 在派发子 Agent 前必须通过的门控检查
//
// 解决问题：子 Agent 派发缺乏统一约束，容易出现在缺少 design_doc / diff 等
// 必需输入时强行创建 executor / reviewer，或并行数量失控，或共享上下文包过小
// 导致子 Agent 无法有效工作。
//
// 门控检查项：
//   1. 当前该角色的并行子 Agent 数量是否已达上限
//   2. 必需输入（design_doc / write_file_list / diff / task_description）是否齐备
//   3. 共享上下文包是否足够（estimatedTokens >= 100）

/** 子 Agent 角色 */
export type AgentRole = 'researcher' | 'executor' | 'reviewer' | 'custom';

/** 委托门控规则（按角色配置） */
interface DelegationGateRules {
  researcher: {
    when: string[]; // ['need_facts', 'impact_analysis', 'unknown_domain']
    maxParallel: number;
    requires: string[]; // ['task_description']
  };
  executor: {
    when: string[];
    maxParallel: number;
    requires: string[]; // ['design_doc', 'write_file_list']
  };
  reviewer: {
    when: string[];
    maxParallel: number;
    requires: string[]; // ['diff', 'design_doc']
  };
  custom: {
    when: string[];
    maxParallel: number;
    requires: string[];
  };
}

/** 默认门控规则 */
export const DEFAULT_GATE_RULES: DelegationGateRules = {
  researcher: { when: ['need_facts', 'impact_analysis', 'unknown_domain'], maxParallel: 3, requires: ['task_description'] },
  executor: { when: ['design_confirmed', 'task_isolated'], maxParallel: 2, requires: ['design_doc', 'write_file_list'] },
  reviewer: { when: ['after_execution', 'before_merge'], maxParallel: 2, requires: ['diff', 'design_doc'] },
  custom: { when: ['manual'], maxParallel: 2, requires: ['task_description'] },
};

/** 委托任务描述 */
export interface DelegationTask {
  id: string;
  description: string;
  designDoc?: string;
  writeFiles?: string[];
  diff?: string;
  taskDescription: string;
}

/** 活跃子 Agent（用于门控并行计数） */
interface ActiveSubAgent {
  id: string;
  role: AgentRole;
  taskId: string;
  status: string;
}

/** 父 Agent（持有活跃子 Agent 列表） */
export interface ParentAgent {
  id: string;
  activeSubAgents: ActiveSubAgent[];
}

/** 共享上下文包信息 */
export interface ContextPackageInfo {
  metadata: {
    estimatedTokens: number;
  };
}

/** 门控结果 */
type GateResult =
  | { ok: true; reason: string }
  | { ok: false; reason: string };

/** 共享上下文包最小 token 阈值 */
const MIN_CONTEXT_TOKENS = 100;

/**
 * 委托门控
 * 在父 Agent 派发子 Agent 之前调用 checkDelegationEligibility 进行检查
 */
export class DelegationGate {
  private rules: DelegationGateRules;

  constructor(rules?: Partial<DelegationGateRules>) {
    this.rules = { ...DEFAULT_GATE_RULES, ...rules };
  }

  /**
   * 检查委托是否满足门控条件
   * @returns ok=true 通过；ok=false 拒绝并给出原因
   */
  checkDelegationEligibility(
    parent: ParentAgent,
    role: AgentRole,
    task: DelegationTask,
    contextPackage: ContextPackageInfo,
  ): GateResult {
    const roleRules = this.rules[role];

    // 1. 检查当前并行数量
    const activeCount = parent.activeSubAgents.filter(a => a.role === role).length;
    if (activeCount >= roleRules.maxParallel) {
      return { ok: false, reason: `${role} 并行数量已达上限 ${roleRules.maxParallel}` };
    }

    // 2. 检查必需输入
    for (const req of roleRules.requires) {
      if (req === 'design_doc' && !task.designDoc) {
        return { ok: false, reason: `创建 ${role} 需要 design_doc` };
      }
      if (req === 'write_file_list' && (!task.writeFiles || task.writeFiles.length === 0)) {
        return { ok: false, reason: `创建 ${role} 需要 write_file_list` };
      }
      if (req === 'diff' && !task.diff) {
        return { ok: false, reason: `创建 ${role} 需要 diff` };
      }
      if (req === 'task_description' && !task.taskDescription) {
        return { ok: false, reason: `创建 ${role} 需要 task_description` };
      }
    }

    // 3. 检查上下文包是否足够
    if (contextPackage.metadata.estimatedTokens < MIN_CONTEXT_TOKENS) {
      return { ok: false, reason: '共享上下文包过小，子 Agent 无法有效工作' };
    }

    return { ok: true, reason: `${role} 委托通过门控` };
  }

  /** 获取当前规则 */
  getRules(): DelegationGateRules {
    return this.rules;
  }

  /** 更新规则（浅合并） */
  updateRules(rules: Partial<DelegationGateRules>): void {
    this.rules = { ...this.rules, ...rules };
  }

  /**
   * 生成 Policy Engine 的委托约束 Playbook prompt
   * 静态方法：返回包含门控规则的约束文本，供父 Agent 在派发前阅读
   */
  static getDelegationPlaybookPrompt(): string {
    const r = DEFAULT_GATE_RULES;
    const lines: string[] = [];
    lines.push('# 委托门控 Playbook');
    lines.push('');
    lines.push('父 Agent 在派发子 Agent 前必须通过 DelegationGate.checkDelegationEligibility 检查。');
    lines.push('门控三项检查：并行数量上限、必需输入、共享上下文包大小（>= 100 tokens）。');
    lines.push('');
    lines.push('## 角色门控规则');
    lines.push(`- researcher: maxParallel=${r.researcher.maxParallel}, requires=[${r.researcher.requires.join(', ')}], when=[${r.researcher.when.join(', ')}]`);
    lines.push(`- executor: maxParallel=${r.executor.maxParallel}, requires=[${r.executor.requires.join(', ')}], when=[${r.executor.when.join(', ')}]`);
    lines.push(`- reviewer: maxParallel=${r.reviewer.maxParallel}, requires=[${r.reviewer.requires.join(', ')}], when=[${r.reviewer.when.join(', ')}]`);
    lines.push(`- custom: maxParallel=${r.custom.maxParallel}, requires=[${r.custom.requires.join(', ')}], when=[${r.custom.when.join(', ')}]`);
    lines.push('');
    lines.push('## 必需输入说明');
    lines.push('- design_doc：executor / reviewer 必须提供设计文档');
    lines.push('- write_file_list：executor 必须提供待写入文件清单');
    lines.push('- diff：reviewer 必须提供待审查 diff');
    lines.push('- task_description：所有角色必须提供任务描述');
    lines.push('');
    lines.push('## 拒绝策略');
    lines.push('任一检查不通过时返回 ok=false，父 Agent 不得派发，需补齐输入或等待并行槽位释放。');
    return lines.join('\n');
  }
}
