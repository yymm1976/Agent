// src/agent/persona-engine.ts
// 人格化系统提示词引擎（Phase 57 简化版）
//
// 核心能力：
//   1. buildPersonaFragment：根据 intensity + 用户信号构建人格片段（注入 system prompt）
//   2. resolveDynamicTone：根据用户交互信号临时切换语气（急躁→简洁，困惑→导师）
//   3. shouldConfirm：判断当前轮次是否需要用户确认
//   4. estimateTokenOverhead：估算人格片段的 token 开销
//   5. validateSafety：验证人格片段不覆盖安全约束（静态方法）
//
// Phase 57 简化要点：
//   - 删除 persona-templates.ts，不再有内置人格对象（COLLABORATOR/MENTOR/HACKER）
//   - systemPromptAppend 直接从 config.persona.systemPromptAppend 读取（用户可自定义）
//   - 保留动态语气切换逻辑（基于用户交互信号）
//   - 纯内存对象，无副作用，不依赖外部服务
//   - intensity=none 时不注入任何人格片段（零开销降级）

// ============================================================
// 类型定义
// ============================================================

/** 语气：支持型 / 简洁型 / 俏皮型 / 导师型 */
export type PersonaTone = 'supportive' | 'concise' | 'playful' | 'mentor';

/** 用户交互信号（由上层观察并传入） */
export interface UserInteractionSignals {
  /** 连续编辑次数（高=用户在快速迭代） */
  consecutiveEdits: number;
  /** 连续回退次数（高=用户在反复试错，需安抚） */
  consecutiveRollbacks: number;
  /** 中断次数（高=用户急躁，需加速） */
  interruptionCount: number;
  /** 重复提问次数（高=用户困惑，需澄清） */
  repeatedPrompts: number;
  /** 响应延迟趋势 */
  responseLatencyTrend: 'up' | 'down' | 'stable';
  /** 最近一次错误严重度 */
  lastErrorSeverity?: 'low' | 'medium' | 'high';
}

/** 人格注入强度 */
type PersonaIntensity = 'none' | 'low' | 'medium' | 'high';

// ============================================================
// 常量
// ============================================================

/** 默认语气（替代原 COLLABORATOR_PERSONA.tone） */
const DEFAULT_TONE: PersonaTone = 'supportive';

/** 高风险操作关键词（命中即强制确认） */
const HIGH_RISK_ACTIONS: readonly string[] = [
  'rm',
  'delete',
  'remove',
  'format',
  'drop',
  'truncate',
  'force',
  'reset',
  'rollback',
  'deploy',
  'publish',
  'release',
  'migrate',
];

/**
 * 安全约束绕过模式（validateSafety 检测）
 * 命中任一模式即视为可能绕过安全约束
 */
const SAFETY_BYPASS_PATTERNS: readonly string[] = [
  'ignore previous',
  'ignore above',
  'ignore all',
  'disregard',
  'forget your instructions',
  'you are not',
  'you are now',
  'new instructions',
  'override',
  'bypass',
  'no restrictions',
  'without limits',
  'jailbreak',
  '扮演',
  '忽略',
  '绕过',
  '无视',
  '覆盖指令',
  '不再受',
  '解除限制',
];

// ============================================================
// PersonaEngine
// ============================================================

/**
 * 人格化系统提示词引擎（Phase 57 简化版）
 *
 * 用法：
 *   const engine = new PersonaEngine(config.persona.systemPromptAppend);
 *   engine.setIntensity('medium');
 *   const fragment = engine.buildPersonaFragment(signals);
 *   // 将 fragment 拼接到 system prompt 末尾
 */
export class PersonaEngine {
  private systemPromptAppend: string;
  private intensity: PersonaIntensity = 'medium';

  constructor(systemPromptAppend: string = '') {
    this.systemPromptAppend = systemPromptAppend;
  }

  /** 设置 system prompt 附加片段（替代原 setPersona） */
  setSystemPromptAppend(text: string): void {
    this.systemPromptAppend = text;
  }

  /** 获取当前 system prompt 附加片段（替代原 getPersona） */
  getSystemPromptAppend(): string {
    return this.systemPromptAppend;
  }

  /** 设置注入强度 */
  setIntensity(intensity: PersonaIntensity): void {
    this.intensity = intensity;
  }

  /** 获取注入强度 */
  getIntensity(): PersonaIntensity {
    return this.intensity;
  }

  /**
   * 构建人格片段（注入 system prompt）
   *
   * 1. intensity=none → 返回空字符串（零开销）
   * 2. systemPromptAppend 为空 → 返回空字符串（未配置人格片段）
   * 3. intensity=low/medium/high → 返回包含 systemPromptAppend 的片段
   * 4. 根据 signals 动态调整语气提示
   *
   * @param signals 用户交互信号（可选）
   * @returns 人格片段文本（空字符串表示不注入）
   */
  buildPersonaFragment(signals?: UserInteractionSignals): string {
    // intensity=none 时不注入
    if (this.intensity === 'none') {
      return '';
    }

    const append = this.systemPromptAppend;
    // 未配置人格片段时不注入
    if (!append) {
      return '';
    }

    const lines: string[] = [];
    // 核心附加片段
    lines.push(append);

    // 根据信号动态调整语气
    if (signals) {
      const dynamicTone = this.resolveDynamicTone(signals);
      // 仅当切换到非默认语气时注入语气提示
      if (dynamicTone !== DEFAULT_TONE) {
        lines.push('');
        lines.push(this.getToneHint(dynamicTone));
      }

      // 错误严重度高时追加安抚提示
      if (signals.lastErrorSeverity === 'high') {
        lines.push('');
        lines.push('- 注意：上一步操作出错，请先确认错误原因再继续，避免重复失败');
      }
    }

    // intensity=low 时只注入附加片段，不附加语气提示
    if (this.intensity === 'low') {
      return append;
    }

    return lines.join('\n');
  }

  /**
   * 动态调整：根据用户信号临时切换语气
   *
   * - consecutiveRollbacks >= 2 → supportive（安抚）
   * - interruptionCount >= 2 → concise（加速）
   * - repeatedPrompts >= 2 → mentor（澄清）
   * - 默认返回 DEFAULT_TONE（supportive）
   *
   * @param signals 用户交互信号
   * @returns 临时语气
   */
  resolveDynamicTone(signals: UserInteractionSignals): PersonaTone {
    // 回退多 → 安抚
    if (signals.consecutiveRollbacks >= 2) {
      return 'supportive';
    }
    // 中断多 → 加速
    if (signals.interruptionCount >= 2) {
      return 'concise';
    }
    // 重复提问 → 澄清
    if (signals.repeatedPrompts >= 2) {
      return 'mentor';
    }
    return DEFAULT_TONE;
  }

  /**
   * 判断当前轮次是否需要确认
   *
   * - 高风险操作总是需要确认
   * - EQ 信号增强：回退多时建议确认
   * - 其余低风险操作默认不强制确认（替代原 confirmationStyle 逻辑）
   *
   * @param action 操作描述（命令或工具名）
   * @param signals 用户交互信号（可选）
   * @returns true 表示需要用户确认
   */
  shouldConfirm(action: string, signals?: UserInteractionSignals): boolean {
    // 高风险操作总是需要确认
    const lowerAction = action.toLowerCase();
    const isHighRisk = HIGH_RISK_ACTIONS.some((kw) =>
      lowerAction.includes(kw.toLowerCase()),
    );
    if (isHighRisk) {
      return true;
    }

    // EQ 信号增强：回退多时建议确认
    if (signals && signals.consecutiveRollbacks >= 2) {
      return true;
    }

    // 默认不强制确认
    return false;
  }

  /**
   * 估算人格片段的 token 开销
   *
   * 粗略估算：字符数 / 4（英文约 4 字符/token，中文约 2 字符/token，取折中）
   * 实际值由 tokenizer 精确计算，此处仅用于预算预估
   *
   * @returns 估算 token 数（>= 0）
   */
  estimateTokenOverhead(): number {
    const fragment = this.buildPersonaFragment();
    if (!fragment) {
      return 0;
    }
    return Math.ceil(fragment.length / 4);
  }

  /**
   * 验证人格片段不覆盖安全约束
   *
   * 检测人格片段是否包含可能绕过安全约束的指令（如"忽略上述指令"、"扮演..."等）
   *
   * @param fragment 人格片段文本
   * @param safetyConstraints 安全约束列表（保留参数，用于未来扩展精确匹配）
   * @returns 警告列表，空数组=安全
   */
  static validateSafety(fragment: string, safetyConstraints: string[]): string[] {
    const warnings: string[] = [];
    const lowerFragment = fragment.toLowerCase();

    // 检测绕过模式
    for (const pattern of SAFETY_BYPASS_PATTERNS) {
      if (lowerFragment.includes(pattern.toLowerCase())) {
        warnings.push(
          `检测到可能绕过安全约束的指令："${pattern}"，人格片段不应包含修改核心指令的内容`,
        );
      }
    }

    // 检测是否与安全约束冲突（精确匹配）
    for (const constraint of safetyConstraints) {
      if (constraint && lowerFragment.includes(constraint.toLowerCase())) {
        warnings.push(
          `人格片段包含安全约束关键词："${constraint}"，可能与之冲突`,
        );
      }
    }

    return warnings;
  }

  /**
   * 获取语气提示文本
   */
  private getToneHint(tone: PersonaTone): string {
    switch (tone) {
      case 'supportive':
        return '【临时语气】用户在反复试错，请用更温和支持的语气回复，主动安抚并提供建议';
      case 'concise':
        return '【临时语气】用户似乎急躁，请加快节奏，只给最关键的信息';
      case 'mentor':
        return '【临时语气】用户可能困惑，请切换为导师模式，主动澄清并解释';
      case 'playful':
        return '【临时语气】轻松氛围，可适度使用俏皮语气';
      default:
        return '';
    }
  }
}
