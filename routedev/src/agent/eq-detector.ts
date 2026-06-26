// src/agent/eq-detector.ts
// EQ 感知与节奏调节：根据用户交互信号推断情绪状态，调整 Agent 的语气、详略与确认强度。
// 信号维度：连续编辑、连续回滚、中断次数、重复提问、响应延迟趋势、最近错误严重度。
// 状态：calm（平静）/ focused（专注）/ frustrated（受挫）/ confused（困惑）/ rushed（急促）。

/** 用户交互信号 */
export interface UserInteractionSignals {
  consecutiveEdits: number;
  consecutiveRollbacks: number;
  interruptionCount: number;
  repeatedPrompts: number;
  responseLatencyTrend: 'up' | 'down' | 'stable';
  lastErrorSeverity?: 'low' | 'medium' | 'high';
}

/** EQ 状态 */
type EQState = 'calm' | 'focused' | 'frustrated' | 'confused' | 'rushed';

/** EQ 调整建议 */
interface EQAdjustment {
  state: EQState;
  tone: 'supportive' | 'concise' | 'mentor';
  verbosity: number; // 0.0 ~ 1.0
  confirmationLevel: 'normal' | 'increased' | 'reduced';
  shouldPreviewImpact: boolean;
  shouldAskClarification: boolean;
  reason: string;
}

/** 高风险动作关键词（命中即强制额外确认） */
const HIGH_RISK_KEYWORDS = [
  'delete',
  'remove',
  'drop',
  'reset',
  'rollback',
  'force-push',
  'forcePush',
  'purge',
  'overwrite',
  'deploy',
  'destroy',
  'format',
];

function isHighRisk(action: string): boolean {
  const lower = action.toLowerCase();
  return HIGH_RISK_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

export class EQDetector {
  private signals: UserInteractionSignals = {
    consecutiveEdits: 0,
    consecutiveRollbacks: 0,
    interruptionCount: 0,
    repeatedPrompts: 0,
    responseLatencyTrend: 'stable',
  };

  /** 记录一次编辑（连续编辑计数 +1） */
  recordEdit(): void {
    this.signals.consecutiveEdits += 1;
  }

  /** 记录一次回滚（连续回滚计数 +1） */
  recordRollback(): void {
    this.signals.consecutiveRollbacks += 1;
  }

  /** 记录一次中断 */
  recordInterruption(): void {
    this.signals.interruptionCount += 1;
  }

  /** 记录一次重复提问 */
  recordRepeatedPrompt(): void {
    this.signals.repeatedPrompts += 1;
  }

  /** 记录一次错误及其严重度 */
  recordError(severity: 'low' | 'medium' | 'high'): void {
    this.signals.lastErrorSeverity = severity;
  }

  /** 更新响应延迟趋势 */
  setLatencyTrend(trend: 'up' | 'down' | 'stable'): void {
    this.signals.responseLatencyTrend = trend;
  }

  /** 重置所有信号 */
  reset(): void {
    this.signals = {
      consecutiveEdits: 0,
      consecutiveRollbacks: 0,
      interruptionCount: 0,
      repeatedPrompts: 0,
      responseLatencyTrend: 'stable',
    };
  }

  /** 获取当前信号快照 */
  getSignals(): UserInteractionSignals {
    return { ...this.signals };
  }

  /** 分析当前 EQ 状态并给出调整建议 */
  analyze(): EQAdjustment {
    const s = this.signals;

    // 优先级 1：受挫——连续回滚、连续编辑、高危错误
    if (s.consecutiveRollbacks >= 2) {
      return {
        state: 'frustrated',
        tone: 'supportive',
        verbosity: 0.6,
        confirmationLevel: 'increased',
        shouldPreviewImpact: true,
        shouldAskClarification: false,
        reason: `连续回滚 ${s.consecutiveRollbacks} 次，可能对当前方向不满意`,
      };
    }
    if (s.consecutiveEdits >= 3) {
      return {
        state: 'frustrated',
        tone: 'supportive',
        verbosity: 0.6,
        confirmationLevel: 'increased',
        shouldPreviewImpact: true,
        shouldAskClarification: false,
        reason: `连续编辑 ${s.consecutiveEdits} 次，建议换一种实现思路`,
      };
    }
    if (s.lastErrorSeverity === 'high') {
      return {
        state: 'frustrated',
        tone: 'supportive',
        verbosity: 0.6,
        confirmationLevel: 'increased',
        shouldPreviewImpact: true,
        shouldAskClarification: false,
        reason: '最近发生高危错误，需要更稳妥的推进方式',
      };
    }

    // 优先级 2：急促——频繁中断
    if (s.interruptionCount >= 2) {
      return {
        state: 'rushed',
        tone: 'concise',
        verbosity: 0.2,
        confirmationLevel: 'reduced',
        shouldPreviewImpact: false,
        shouldAskClarification: false,
        reason: `中断 ${s.interruptionCount} 次，节奏偏快，精简输出减少打扰`,
      };
    }

    // 优先级 3：困惑——重复提问
    if (s.repeatedPrompts >= 2) {
      return {
        state: 'confused',
        tone: 'mentor',
        verbosity: 0.7,
        confirmationLevel: 'normal',
        shouldPreviewImpact: false,
        shouldAskClarification: true,
        reason: `重复提问 ${s.repeatedPrompts} 次，需要更清晰的方向引导`,
      };
    }

    // 默认：有编辑活动 → 专注；否则 → 平静
    if (s.consecutiveEdits > 0) {
      return {
        state: 'focused',
        tone: 'concise',
        verbosity: 0.4,
        confirmationLevel: 'normal',
        shouldPreviewImpact: false,
        shouldAskClarification: false,
        reason: '正在专注推进，按需提供信息',
      };
    }
    return {
      state: 'calm',
      tone: 'supportive',
      verbosity: 0.5,
      confirmationLevel: 'normal',
      shouldPreviewImpact: false,
      shouldAskClarification: false,
      reason: '一切顺利',
    };
  }

  /** 根据当前状态返回节奏建议文本 */
  getRhythmAdvice(): string {
    const adj = this.analyze();
    switch (adj.state) {
      case 'frustrated':
        return '检测到你可能遇到阻碍，建议先暂停回顾。我会更谨慎地预览每一步的影响，并主动提供备选方案。';
      case 'rushed':
        return '节奏偏快，我会精简输出、减少确认打扰，优先把核心结果交付给你。';
      case 'confused':
        return '似乎需要更清晰的方向，我会以引导方式帮你梳理目标，先确认需求再动手。';
      case 'focused':
        return '保持专注，我按需提供信息，不打断你的推进节奏。';
      case 'calm':
      default:
        return '一切顺利，随时可以开始下一步。';
    }
  }

  /** 判断是否需要增加确认步骤 */
  needsExtraConfirmation(action: string): boolean {
    // 高风险动作总是需要额外确认
    if (isHighRisk(action)) return true;
    const adj = this.analyze();
    // 受挫状态增加确认；急促状态不增加（除非高风险，已在上面处理）
    if (adj.state === 'frustrated') return true;
    return false;
  }
}
