// src/agents/delegation-contract.ts
// 委托契约 + Challenge 质疑机制
// Task 3：父 Agent 向子 Agent 下发契约，子 Agent 可质疑

export interface DelegationContract {
  taskId: string;
  parentAgentId: string;
  childAgentId: string;
  profileId: string;

  grant: {
    readFiles: string[];
    writeFiles?: string[];
    allowedTools: string[];
    forbiddenTools?: string[];
    maxTokens: number;
    maxSteps: number;
    canChallenge: boolean;
  };

  obligation: {
    mustFollowDesign: boolean;
    mustReportProgress: boolean;
    mustNotAlterGoal: boolean;
    challengeChannel: 'parent_only';
  };

  deliverable: {
    format: string;
    successCriteria: string[];
    failureCriteria: string[];
  };
}

export interface ChallengeRequest {
  taskId: string;
  role: string;
  type: 'design_conflict' | 'missing_info' | 'out_of_scope' | 'tool_unavailable' | 'ethical_concern';
  severity: 'blocking' | 'warning';
  description: string;
  evidence: string[];
  proposedOptions?: string[];
}

export type ParentResponse =
  | { action: 'clarify'; newInstructions: string }
  | { action: 'revise_design'; newDesignDoc: string }
  | { action: 'proceed'; reason: string }
  | { action: 'abort'; reason: string };

/** 反死循环：单任务最多质疑次数 */
const MAX_CHALLENGES = 3;

export class DelegationContractManager {
  private contracts: Map<string, DelegationContract> = new Map();
  private challenges: Map<string, ChallengeRequest[]> = new Map();
  private challengeResponses: Map<string, ParentResponse> = new Map();
  private challengeCount: Map<string, number> = new Map();

  createContract(contract: DelegationContract): void {
    this.contracts.set(contract.taskId, contract);
  }

  getContract(taskId: string): DelegationContract | undefined {
    return this.contracts.get(taskId);
  }

  revokeContract(taskId: string): void {
    this.contracts.delete(taskId);
    this.challenges.delete(taskId);
    this.challengeResponses.delete(taskId);
    this.challengeCount.delete(taskId);
  }

  /** 提交质疑；返回是否接受 */
  submitChallenge(taskId: string, challenge: ChallengeRequest): { accepted: boolean; reason?: string } {
    const contract = this.contracts.get(taskId);
    if (!contract) {
      return { accepted: false, reason: `契约不存在: taskId=${taskId}` };
    }
    if (!contract.grant.canChallenge) {
      return { accepted: false, reason: '该契约未授权质疑权利 (canChallenge=false)' };
    }
    const count = this.challengeCount.get(taskId) ?? 0;
    if (count >= MAX_CHALLENGES) {
      return { accepted: false, reason: `质疑次数已达上限 ${MAX_CHALLENGES}（反死循环保护）` };
    }
    this.challengeCount.set(taskId, count + 1);
    const list = this.challenges.get(taskId) ?? [];
    list.push(challenge);
    this.challenges.set(taskId, list);
    // 新质疑提交后清除旧回应，使其进入 pending 状态
    this.challengeResponses.delete(taskId);
    return { accepted: true };
  }

  /** 获取未回应的质疑 */
  getPendingChallenges(taskId: string): ChallengeRequest[] {
    if (this.challengeResponses.has(taskId)) return [];
    return (this.challenges.get(taskId) ?? []).slice();
  }

  respondToChallenge(taskId: string, response: ParentResponse): void {
    this.challengeResponses.set(taskId, response);
  }

  getChallengeResponse(taskId: string): ParentResponse | undefined {
    return this.challengeResponses.get(taskId);
  }

  getChallengeCount(taskId: string): number {
    return this.challengeCount.get(taskId) ?? 0;
  }

  /** 契约注入 system prompt */
  static formatContractForPrompt(contract: DelegationContract): string {
    const role = contract.profileId;
    const readFiles = contract.grant.readFiles.join(', ') || '（无）';
    const writeFiles = (contract.grant.writeFiles ?? []).join(', ') || '（无）';
    const allowedTools = contract.grant.allowedTools.join(', ') || '（无）';
    const maxTokens = contract.grant.maxTokens;
    const maxSteps = contract.grant.maxSteps;

    return [
      '【委托契约】',
      `- 你的角色：${role}`,
      `- 允许读取的文件：${readFiles}`,
      `- 允许修改的文件：${writeFiles}`,
      `- 允许使用的工具：${allowedTools}`,
      `- Token 预算：${maxTokens}`,
      `- 最大步数：${maxSteps}`,
      '',
      '【服从义务】',
      '- 你必须完成父 Agent 委托的任务',
      '- 你必须严格遵循设计文档和边界',
      '- 你无权修改任务目标、范围或优先级',
      '',
      '【质疑权利】',
      '- 如果你发现设计冲突、信息不足、权限不够或任务不可行',
      '- 请使用 challenge() 工具向父 Agent 反馈',
      '- 在父 Agent 回应前，你必须停止执行',
    ].join('\n');
  }

  /** 验证契约完整性，返回错误信息列表（空数组表示通过） */
  static validateContract(contract: DelegationContract): string[] {
    const errors: string[] = [];
    if (!contract.taskId) errors.push('taskId 不能为空');
    if (!contract.parentAgentId) errors.push('parentAgentId 不能为空');
    if (!contract.childAgentId) errors.push('childAgentId 不能为空');
    if (!contract.profileId) errors.push('profileId 不能为空');
    if (!contract.grant.readFiles || contract.grant.readFiles.length === 0) {
      errors.push('readFiles 不能为空');
    }
    if (!contract.grant.allowedTools || contract.grant.allowedTools.length === 0) {
      errors.push('allowedTools 不能为空');
    }
    if (contract.grant.maxTokens <= 0) errors.push('maxTokens 必须大于 0');
    if (contract.grant.maxSteps <= 0) errors.push('maxSteps 必须大于 0');
    if (!contract.deliverable.format) errors.push('deliverable.format 不能为空');
    if (contract.obligation.challengeChannel !== 'parent_only') {
      errors.push('challengeChannel 必须为 parent_only');
    }
    return errors;
  }
}
