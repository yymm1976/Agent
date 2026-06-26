// src/agent/persona-engine.ts
// 人格化系统提示词引擎
//
// 核心能力：
//   1. buildPersonaFragment：根据 intensity + 用户信号构建人格片段（注入 system prompt）
//   2. resolveDynamicTone：根据用户交互信号临时切换语气（急躁→简洁，困惑→导师）
//   3. shouldConfirm：判断当前轮次是否需要用户确认
//   4. estimateTokenOverhead：估算人格片段的 token 开销
//   5. validateSafety：验证人格片段不覆盖安全约束（静态方法）
//
// 设计要点：
//   1. 纯内存对象，无副作用，不依赖外部服务
//   2. intensity=none 时不注入任何人格片段（零开销降级）
//   3. 高风险操作总是需要确认，EQ 信号可增强确认（回退多时）
//   4. 安全验证采用关键词匹配，检测"忽略指令/绕过/扮演"等注入模式

import {
  COLLABORATOR_PERSONA,
  type PersonaConfig,
  type PersonaTone,
} from './persona-templates.js';

// ============================================================
// 类型定义
// ============================================================

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
 * 人格化系统提示词引擎
 *
 * 用法：
 *   const engine = new PersonaEngine();
 *   engine.setIntensity('medium');
 *   const fragment = engine.buildPersonaFragment(signals);
 *   // 将 fragment 拼接到 system prompt 末尾
 */
export class PersonaEngine {
  private currentPersona: PersonaConfig;
  private intensity: PersonaIntensity = 'medium';

  constructor(persona?: PersonaConfig) {
    this.currentPersona = persona ?? COLLABORATOR_PERSONA;
  }

  /** 切换人格 */
  setPersona(persona: PersonaConfig): void {
    this.currentPersona = persona;
  }

  /** 获取当前人格 */
  getPersona(): PersonaConfig {
    return this.currentPersona;
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
   * 2. intensity=low/medium/high → 返回包含 addendum 的片段
   * 3. 根据 signals 动态调整语气提示
   *
   * @param signals 用户交互信号（可选）
   * @returns 人格片段文本（空字符串表示不注入）
   */
  buildPersonaFragment(signals?: UserInteractionSignals): string {
    // intensity=none 时不注入
    if (this.intensity === 'none') {
      return '';
    }

    const persona = this.currentPersona;
    const lines: string[] = [];

    // 人格头部：标识当前人格
    lines.push(`## 人格设定（${persona.name}）`);

    // 核心 addendum
    lines.push(persona.systemPromptAddendum);

    // 根据信号动态调整
    if (signals) {
      const dynamicTone = this.resolveDynamicTone(signals);
      if (dynamicTone !== persona.tone) {
        // 临时切换语气提示
        lines.push('');
        lines.push(this.getToneHint(dynamicTone));
      }

      // 错误严重度高时追加安抚提示
      if (signals.lastErrorSeverity === 'high') {
        lines.push('');
        lines.push('- 注意：上一步操作出错，请先确认错误原因再继续，避免重复失败');
      }
    }

    // intensity=low 时只注入 addendum，不附加语气提示
    if (this.intensity === 'low') {
      return persona.systemPromptAddendum;
    }

    return lines.join('\n');
  }

  /**
   * 动态调整：根据用户信号临时切换语气
   *
   * - consecutiveRollbacks >= 2 → supportive（安抚）
   * - interruptionCount >= 2 → concise（加速）
   * - repeatedPrompts >= 2 → mentor（澄清）
   * - 默认返回当前 persona 的 tone
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
    return this.currentPersona.tone;
  }

  /**
   * 判断当前轮次是否需要确认
   *
   * - 高风险操作总是需要确认
   * - confirmationStyle='ask' → 总是确认
   * - confirmationStyle='suggest' → 建议但不强制（返回 false，由上层决定）
   * - confirmationStyle='inform' → 仅告知（返回 false）
   * - EQ 信号增强：回退多时即使 inform 也建议确认
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

    // ask 风格总是确认
    if (this.currentPersona.confirmationStyle === 'ask') {
      return true;
    }

    // EQ 信号增强：回退多时建议确认（即使 inform/suggest）
    if (signals && signals.consecutiveRollbacks >= 2) {
      return true;
    }

    // suggest / inform 默认不强制确认
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
