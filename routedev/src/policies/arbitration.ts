// src/policies/arbitration.ts
// 策略冲突仲裁
// 当 Policy（安全策略）/ Skill（长期规则）/ Hook（事件响应）三类策略产生冲突时，
// 按优先级仲裁：security > skill > hook
// 设计借鉴 Anthropic Constitutional AI 的"宪法优先"原则

export type PolicyPriority = 'security' | 'skill' | 'hook';

export interface PolicyConflict {
  type: PolicyPriority;
  id: string;
  action: string;
}

export interface ArbitrationResult {
  /** 胜出的策略类型 */
  winner: PolicyPriority;
  /** 仲裁理由（人类可读） */
  reason: string;
  /** 参与冲突的全部策略（含胜出方） */
  conflictingPolicies: PolicyConflict[];
  /** 仲裁时间戳 */
  timestamp: number;
}

/**
 * 策略仲裁器
 * 优先级：Policy（安全） > Skill（长期规则） > Hook（事件响应）
 * 安全策略 block 优先于 Skill injectPrompt
 */
export class PolicyArbitrator {
  /** 优先级顺序：security 最高，hook 最低 */
  static readonly PRIORITY_ORDER: PolicyPriority[] = ['security', 'skill', 'hook'];

  /** 仲裁历史日志（内存，不持久化） */
  private log: ArbitrationResult[] = [];

  /**
   * 仲裁多个冲突策略
   * 按 PRIORITY_ORDER 排序，security 优先级最高
   * @param conflicts 参与冲突的策略列表（至少 2 个才有意义，但 1 个也支持）
   */
  arbitrate(conflicts: PolicyConflict[]): ArbitrationResult {
    // 按 PRIORITY_ORDER 排序，security 优先
    const sorted = [...conflicts].sort((a, b) =>
      PolicyArbitrator.PRIORITY_ORDER.indexOf(a.type) - PolicyArbitrator.PRIORITY_ORDER.indexOf(b.type),
    );
    const winner = sorted[0];
    const result: ArbitrationResult = {
      winner: winner.type,
      reason: `${winner.type} 优先级高于其他策略`,
      conflictingPolicies: conflicts,
      timestamp: Date.now(),
    };
    this.log.push(result);
    return result;
  }

  /**
   * 当 Policy block 与 Skill injectPrompt 冲突时，Policy 优先
   * 典型场景：安全策略阻止某工具调用，但 Skill 想注入提示词引导调用
   * @param blockPolicy 安全策略（action=block）
   * @param injectSkill Skill（action=injectPrompt）
   */
  static resolveBlockVsInject(
    blockPolicy: { id: string },
    injectSkill: { id: string },
  ): ArbitrationResult {
    return {
      winner: 'security',
      reason: '安全策略 block 优先于 Skill injectPrompt',
      conflictingPolicies: [
        { type: 'security', id: blockPolicy.id, action: 'block' },
        { type: 'skill', id: injectSkill.id, action: 'injectPrompt' },
      ],
      timestamp: Date.now(),
    };
  }

  /** 获取仲裁历史日志 */
  getLog(): ArbitrationResult[] {
    return this.log;
  }

  /** 清空仲裁日志 */
  clearLog(): void {
    this.log = [];
  }
}
