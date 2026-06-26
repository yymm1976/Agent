// src/agent/context-usage-panel.ts
// 上下文占用率面板（Phase 49 Task 4.2）
//
// 设计目标（蓝图 4.2）：
//   1. 把 context-compaction 的 soft_notify 数据推送到 UI
//   2. 计算各分项 token 占用（systemPrompt / 历史 / 工具结果 / 引用 / Skill）
//   3. 按 50%/80%/90% 三级阈值给出建议动作
//   4. 格式化为状态栏字符串，供 ChatView 渲染
//
// 陷阱 #144：上下文占用率面板更新可能影响性能
//   - 200K+ 上下文的 token 计数成为瓶颈
//   - 解法：缓存 token 计数结果（Map），面板更新频率限制为每 3 轮一次
//
// 与 context-compaction.ts 的关系：
//   - context-compaction 负责"压缩执行"（L1-L5）
//   - context-usage-panel 负责"占用可视化"（只读，不压缩）
//   - 两者共享三级阈值（50%/80%/90%），但职责不同

import type { LLMMessage, ContentPart } from '../router/types.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 上下文占用率信息（蓝图 4.2） */
export interface ContextUsageInfo {
  /** 当前 token 数 */
  currentTokens: number;
  /** 上下文窗口大小 */
  maxTokens: number;
  /** 占用率（0-1） */
  usagePercent: number;
  /** 分项占用 */
  breakdown: {
    systemPrompt: number;
    conversationHistory: number;
    toolResults: number;
    references: number;
    skillPrompts: number;
  };
  /** 建议动作 */
  suggestion: 'ok' | 'consider-compaction' | 'should-compact' | 'must-compact';
}

/** calculate 入参 */
export interface ContextUsageParams {
  systemPrompt: string;
  conversationHistory: LLMMessage[];
  toolResults: string[];
  references: string[];
  skillPrompts: string[];
  maxTokens: number;
}

// ============================================================
// 常量
// ============================================================

/** 阈值（与 context-compaction.ts 三级阈值一致） */
const THRESHOLD_CONSIDER = 0.5; // 50%
const THRESHOLD_SHOULD = 0.8; // 80%
const THRESHOLD_MUST = 0.9; // 90%

/** 面板更新频率限制（陷阱 #144）：每 N 轮才更新一次 */
const UPDATE_INTERVAL = 3;

/** 状态栏进度条总长度 */
const STATUS_BAR_WIDTH = 20;

// ============================================================
// ContextUsagePanel
// ============================================================

/**
 * 上下文占用率面板
 *
 * 使用方式：
 *   const panel = new ContextUsagePanel();
 *   const info = panel.calculate({ systemPrompt, conversationHistory, ... });
 *   const bar = panel.formatStatusBar(info);
 */
export class ContextUsagePanel {
  /** 陷阱 #144：token 计数缓存，key 为输入字符串的引用（避免重复扫描长文本） */
  private tokenCache = new Map<string, number>();

  /** 更新计数器：用于限制面板更新频率（每 UPDATE_INTERVAL 轮才真正更新） */
  private updateCounter = 0;

  /** 上一次计算的结果缓存（未到更新轮时返回此结果） */
  private lastInfo: ContextUsageInfo | null = null;

  /**
   * 计算上下文占用率
   *
   * 陷阱 #144：面板更新频率限制为每 3 轮一次
   *   - counter % 3 !== 0 时返回上一次的结果（若无则强制计算一次）
   *   - 这样 200K+ 上下文的 token 扫描不会每轮都触发
   *
   * @param params 上下文各分项内容 + maxTokens
   * @returns ContextUsageInfo
   */
  calculate(params: ContextUsageParams): ContextUsageInfo {
    this.updateCounter++;

    // 陷阱 #144：未到更新轮且已有缓存结果 → 直接返回
    if (this.lastInfo && this.updateCounter % UPDATE_INTERVAL !== 0) {
      logger.debug('ContextUsagePanel: skip update (throttled)', {
        counter: this.updateCounter,
      });
      return this.lastInfo;
    }

    const info = this.computeInfo(params);
    this.lastInfo = info;
    return info;
  }

  /**
   * 强制立即计算（绕过频率限制）
   *
   * 用于用户主动请求查看占用率、或外部检测到上下文剧变的场景
   */
  forceCalculate(params: ContextUsageParams): ContextUsageInfo {
    const info = this.computeInfo(params);
    this.lastInfo = info;
    return info;
  }

  /**
   * 重置计数器（用于新会话开始）
   */
  reset(): void {
    this.updateCounter = 0;
    this.lastInfo = null;
    this.tokenCache.clear();
  }

  /**
   * 格式化为状态栏字符串
   *
   * 输出示例：
   *   "[══════════════░░░░░░░░░░] 52% ── 建议压缩"
   *
   * @param info ContextUsageInfo
   * @returns 状态栏字符串
   */
  formatStatusBar(info: ContextUsageInfo): string {
    const percent = Math.round(info.usagePercent * 100);
    const filled = Math.round((percent / 100) * STATUS_BAR_WIDTH);
    const empty = STATUS_BAR_WIDTH - filled;
    const bar = '═'.repeat(filled) + '░'.repeat(empty);
    const hint = this.suggestionToHint(info.suggestion);
    return `[${bar}] ${percent}% ── ${hint}`;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 实际计算占用率（无频率限制） */
  private computeInfo(params: ContextUsageParams): ContextUsageInfo {
    const systemPromptTokens = this.estimateTokensCached(params.systemPrompt);
    const conversationHistoryTokens = this.estimateMessagesTokens(params.conversationHistory);
    const toolResultsTokens = this.sumTokens(params.toolResults);
    const referencesTokens = this.sumTokens(params.references);
    const skillPromptsTokens = this.sumTokens(params.skillPrompts);

    const currentTokens =
      systemPromptTokens +
      conversationHistoryTokens +
      toolResultsTokens +
      referencesTokens +
      skillPromptsTokens;

    const usagePercent = params.maxTokens > 0 ? currentTokens / params.maxTokens : 0;
    const suggestion = this.decideSuggestion(usagePercent);

    return {
      currentTokens,
      maxTokens: params.maxTokens,
      usagePercent,
      breakdown: {
        systemPrompt: systemPromptTokens,
        conversationHistory: conversationHistoryTokens,
        toolResults: toolResultsTokens,
        references: referencesTokens,
        skillPrompts: skillPromptsTokens,
      },
      suggestion,
    };
  }

  /** 根据占用率判定建议动作 */
  private decideSuggestion(usagePercent: number): ContextUsageInfo['suggestion'] {
    if (usagePercent >= THRESHOLD_MUST) return 'must-compact';
    if (usagePercent >= THRESHOLD_SHOULD) return 'should-compact';
    if (usagePercent >= THRESHOLD_CONSIDER) return 'consider-compaction';
    return 'ok';
  }

  /** suggestion → 状态栏提示文本 */
  private suggestionToHint(suggestion: ContextUsageInfo['suggestion']): string {
    switch (suggestion) {
      case 'ok':
        return '上下文充足';
      case 'consider-compaction':
        return '建议压缩';
      case 'should-compact':
        return '建议压缩';
      case 'must-compact':
        return '即将强制压缩';
    }
  }

  /** 估算消息列表的 token 总数 */
  private estimateMessagesTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateMessageTokens(msg);
    }
    return total;
  }

  /** 估算单条消息的 token 数 */
  private estimateMessageTokens(msg: LLMMessage): number {
    if (typeof msg.content === 'string') {
      return this.estimateTokensCached(msg.content);
    }
    if (Array.isArray(msg.content)) {
      let total = 0;
      for (const part of msg.content) {
        total += this.estimatePartTokens(part);
      }
      return total;
    }
    return 0;
  }

  /** 估算 ContentPart 的 token 数 */
  private estimatePartTokens(part: ContentPart): number {
    switch (part.type) {
      case 'text':
        return this.estimateTokensCached(part.text);
      case 'tool_result':
        return this.estimateTokensCached(part.content);
      case 'tool_use':
        return this.estimateTokensCached(part.name + JSON.stringify(part.arguments));
      case 'image':
        // 图片按保守估值
        return 256;
      default:
        return 0;
    }
  }

  /** 对字符串数组求 token 总和 */
  private sumTokens(texts: string[]): number {
    let total = 0;
    for (const t of texts) {
      total += this.estimateTokensCached(t);
    }
    return total;
  }

  /**
   * 带缓存的 token 估算（陷阱 #144）
   *
   * 缓存策略：
   *   - key 为字符串本身（同一字符串多次出现只算一次）
   *   - 长度 <= 32 的短字符串不缓存（缓存开销大于收益）
   *   - 长字符串缓存结果，避免重复扫描
   */
  private estimateTokensCached(text: string): number {
    if (!text) return 0;
    // 短字符串不缓存
    if (text.length <= 32) {
      return estimateTokensSimple(text);
    }
    const cached = this.tokenCache.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const tokens = estimateTokensSimple(text);
    this.tokenCache.set(text, tokens);
    return tokens;
  }
}

// ============================================================
// token 估算（简单启发式，蓝图 4.2 要求）
// ============================================================

/**
 * 简单 token 估算
 *
 * 蓝图 4.2 要求的启发式：
 *   - 英文约 4 字符/token
 *   - 中文约 2 字符/token
 *
 * 注：与 utils/token-estimate.ts 的实现不同（后者用 1.5x CJK + 4x other）
 * 这里按蓝图要求用 2 字符/token 估算 CJK，更保守。
 *
 * 判定 CJK：统一表意文字 + 扩展A区 + 兼容表意文字
 */
export function estimateTokensSimple(text: string): number {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const otherChars = text.length - cjkChars;
  // 中文 2 字符/token，英文 4 字符/token
  return Math.ceil(cjkChars / 2 + otherChars / 4);
}
