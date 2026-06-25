// src/agent/token-profiler.ts
// Phase 30 Task 1：Token 可观测性基础设施
//
// 核心哲学："不测量就不知道钱花在哪"——给每个"用水点"装分表
// 五个分表：系统提示词、对话历史、工具定义、工具返回、用户消息
//
// 设计要点：
//   1. 使用 estimateTokens（CJK 感知启发式），非精确计算
//   2. 纯 CPU 计算，< 1ms/次，零外部 API 调用
//   3. profiler 参数可选，不传则零开销
//   4. 会话级累计，压缩时不重置（借鉴 Reasonix Layer 5）

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { estimateTokens } from '../utils/token-estimate.js';
import { estimateMessagesTokens } from '../router/token-counter.js';
import type { LLMMessage } from '../router/types.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/**
 * Token Profile 快照（一次 LLM 调用前的五分表读数）
 */
export interface TokenProfileSnapshot {
  /** 系统提示词 token 数 */
  systemPrompt: number;
  /** 对话历史 token 数 */
  conversationHistory: number;
  /** 工具定义 token 数 */
  toolDefinitions: number;
  /** 本轮累积的工具返回 token 数 */
  toolResults: number;
  /** 当前用户消息 token 数 */
  userMessage: number;

  /** 以上五项之和 */
  totalEstimated: number;
  /** 第几轮 ReAct 迭代（从 0 开始） */
  iterationIndex: number;
  /** 使用的模型 ID */
  modelId: string;
  /** 路由结果（simple/complex/...） */
  routeDecision: string;
  /** Unix ms 时间戳 */
  timestamp: number;
}

/**
 * Profiling 参数
 */
export interface ProfileParams {
  systemPrompt?: string;
  messages: LLMMessage[];
  tools?: unknown[];
  userMessage: string;
  iterationIndex: number;
  modelId: string;
  routeDecision: string;
}

/**
 * 会话汇总统计
 */
export interface TokenProfileSummary {
  /** 本次会话总 LLM 调用次数 */
  totalCalls: number;
  /** 总估算 token 数 */
  totalEstimatedTokens: number;
  /** 各组件平均 token 数 */
  avgByComponent: {
    systemPrompt: number;
    conversationHistory: number;
    toolDefinitions: number;
    toolResults: number;
    userMessage: number;
  };
  /** 各组件平均占比（0-1） */
  avgRatioByComponent: {
    systemPrompt: number;
    conversationHistory: number;
    toolDefinitions: number;
    toolResults: number;
    userMessage: number;
  };
  /** 最大消耗者 Top 3（按平均 token 数降序） */
  topConsumers: Array<{ component: string; avgTokens: number; ratio: number }>;
}

// ============================================================
// TokenProfiler 实现
// ============================================================

/**
 * Token Profiler
 *
 * 在每次 LLM 调用前，用 estimateTokens() 估算各组件的 token 占比
 * 借鉴 Reasonix 的会话级累计计数器：压缩时不重置
 */
export class TokenProfiler {
  /** 会话级快照日志（压缩时不重置） */
  private sessionLog: TokenProfileSnapshot[] = [];

  /**
   * 生成一次 LLM 调用前的 Token 快照
   *
   * 五个分表：
   *   1. systemPrompt — 系统提示词
   *   2. conversationHistory — 对话历史（全部 messages）
   *   3. toolDefinitions — 工具定义 JSON
   *   4. toolResults — 本轮累积的工具返回（messages 中 role=tool 或含 tool_result 的消息）
   *   5. userMessage — 当前用户消息
   */
  profile(params: ProfileParams): TokenProfileSnapshot {
    const systemPromptTokens = params.systemPrompt
      ? estimateTokens(params.systemPrompt)
      : 0;

    // 对话历史 token 数（含格式开销）
    const conversationHistoryTokens = estimateMessagesTokens(params.messages);

    // 工具定义 token 数
    const toolDefinitionsTokens = params.tools
      ? estimateTokens(JSON.stringify(params.tools))
      : 0;

    // 本轮累积的工具返回 token 数
    // 遍历 messages 中 role=tool 或含 tool_result 内容块的消息
    const toolResultsTokens = this.estimateToolResultsTokens(params.messages);

    // 当前用户消息 token 数
    const userMessageTokens = estimateTokens(params.userMessage);

    const totalEstimated =
      systemPromptTokens +
      conversationHistoryTokens +
      toolDefinitionsTokens +
      toolResultsTokens +
      userMessageTokens;

    const snapshot: TokenProfileSnapshot = {
      systemPrompt: systemPromptTokens,
      conversationHistory: conversationHistoryTokens,
      toolDefinitions: toolDefinitionsTokens,
      toolResults: toolResultsTokens,
      userMessage: userMessageTokens,
      totalEstimated,
      iterationIndex: params.iterationIndex,
      modelId: params.modelId,
      routeDecision: params.routeDecision,
      timestamp: Date.now(),
    };

    this.sessionLog.push(snapshot);
    return snapshot;
  }

  /**
   * 估算 messages 中工具返回的 token 数
   *
   * 工具返回通过 content 数组中的 tool_result 内容块传递（Anthropic 格式）
   * OpenAI 格式的 role=tool 在本项目中未使用（MessageRole 只有 system/user/assistant）
   */
  private estimateToolResultsTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // content 数组中含 tool_result（Anthropic 格式）
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_result') {
            total += estimateTokens(part.content);
          }
        }
      }
    }
    return total;
  }

  /**
   * 获取本次会话全部快照
   */
  getSessionLog(): TokenProfileSnapshot[] {
    return [...this.sessionLog];
  }

  /**
   * 获取会话汇总统计
   */
  getSummary(): TokenProfileSummary {
    const totalCalls = this.sessionLog.length;
    if (totalCalls === 0) {
      return {
        totalCalls: 0,
        totalEstimatedTokens: 0,
        avgByComponent: {
          systemPrompt: 0,
          conversationHistory: 0,
          toolDefinitions: 0,
          toolResults: 0,
          userMessage: 0,
        },
        avgRatioByComponent: {
          systemPrompt: 0,
          conversationHistory: 0,
          toolDefinitions: 0,
          toolResults: 0,
          userMessage: 0,
        },
        topConsumers: [],
      };
    }

    const sums = {
      systemPrompt: 0,
      conversationHistory: 0,
      toolDefinitions: 0,
      toolResults: 0,
      userMessage: 0,
    };
    let totalEstimatedTokens = 0;

    for (const snap of this.sessionLog) {
      sums.systemPrompt += snap.systemPrompt;
      sums.conversationHistory += snap.conversationHistory;
      sums.toolDefinitions += snap.toolDefinitions;
      sums.toolResults += snap.toolResults;
      sums.userMessage += snap.userMessage;
      totalEstimatedTokens += snap.totalEstimated;
    }

    const avgByComponent = {
      systemPrompt: Math.round(sums.systemPrompt / totalCalls),
      conversationHistory: Math.round(sums.conversationHistory / totalCalls),
      toolDefinitions: Math.round(sums.toolDefinitions / totalCalls),
      toolResults: Math.round(sums.toolResults / totalCalls),
      userMessage: Math.round(sums.userMessage / totalCalls),
    };

    // 计算占比（基于总 token 数，避免单次快照的五项之和为 0 的除零问题）
    const grandTotal =
      sums.systemPrompt +
      sums.conversationHistory +
      sums.toolDefinitions +
      sums.toolResults +
      sums.userMessage;
    const avgRatioByComponent = {
      systemPrompt: grandTotal > 0 ? sums.systemPrompt / grandTotal : 0,
      conversationHistory: grandTotal > 0 ? sums.conversationHistory / grandTotal : 0,
      toolDefinitions: grandTotal > 0 ? sums.toolDefinitions / grandTotal : 0,
      toolResults: grandTotal > 0 ? sums.toolResults / grandTotal : 0,
      userMessage: grandTotal > 0 ? sums.userMessage / grandTotal : 0,
    };

    // Top 3 消耗者
    const consumers = [
      { component: '系统提示词', avgTokens: avgByComponent.systemPrompt, ratio: avgRatioByComponent.systemPrompt },
      { component: '对话历史', avgTokens: avgByComponent.conversationHistory, ratio: avgRatioByComponent.conversationHistory },
      { component: '工具定义', avgTokens: avgByComponent.toolDefinitions, ratio: avgRatioByComponent.toolDefinitions },
      { component: '工具返回', avgTokens: avgByComponent.toolResults, ratio: avgRatioByComponent.toolResults },
      { component: '用户消息', avgTokens: avgByComponent.userMessage, ratio: avgRatioByComponent.userMessage },
    ]
      .sort((a, b) => b.avgTokens - a.avgTokens)
      .slice(0, 3);

    return {
      totalCalls,
      totalEstimatedTokens,
      avgByComponent,
      avgRatioByComponent,
      topConsumers: consumers,
    };
  }

  /**
   * 将会话快照写入磁盘（JSONL 格式）
   *
   * @param outputDir 输出目录
   * @param sessionId 会话 ID
   * @returns 写入的文件路径
   */
  async persistSession(outputDir: string, sessionId: string): Promise<string> {
    if (this.sessionLog.length === 0) {
      return '';
    }

    try {
      await fs.mkdir(outputDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const filename = `session-${sessionId}-${date}.jsonl`;
      const filePath = path.join(outputDir, filename);

      const lines = this.sessionLog.map(snap => JSON.stringify(snap)).join('\n');
      await fs.writeFile(filePath, lines, 'utf-8');

      logger.info('Token profile session persisted', {
        filePath,
        snapshots: this.sessionLog.length,
      });
      return filePath;
    } catch (err) {
      logger.warn('Token profile persist failed', { error: String(err) });
      return '';
    }
  }

  /**
   * 重置会话日志（新会话时调用）
   *
   * 注意：会话级累计不因压缩重置，仅在新会话启动时重置
   */
  reset(): void {
    this.sessionLog = [];
  }

  /**
   * 获取最近 N 次快照
   */
  getRecentSnapshots(count: number): TokenProfileSnapshot[] {
    return this.sessionLog.slice(-count);
  }
}

// ============================================================
// /token 命令输出格式化
// ============================================================

/**
 * 格式化 /token 命令的文本输出
 *
 * 输出示例：
 *   📊 Token 用量分析（本次会话）
 *   ───────────────────────────
 *   总计：~45,200 tokens（12 次 LLM 调用）
 *
 *   各组件平均占比：
 *     系统提示词   ██████████░░░░  38%  (17,176)
 *     对话历史     ██████░░░░░░░░  24%  (10,848)
 *     ...
 */
export function formatTokenProfileText(profiler: TokenProfiler): string {
  const summary = profiler.getSummary();

  if (summary.totalCalls === 0) {
    return '📊 Token 用量分析\n───────────────────────────\n暂无数据（本次会话尚未发起 LLM 调用）';
  }

  const lines: string[] = [];
  lines.push('📊 Token 用量分析（本次会话）');
  lines.push('───────────────────────────');
  lines.push(`总计：~${summary.totalEstimatedTokens.toLocaleString()} tokens（${summary.totalCalls} 次 LLM 调用）`);
  lines.push('');
  lines.push('各组件平均占比：');

  // 文字饼图（14 格进度条）
  const components: Array<{ name: string; ratio: number; tokens: number }> = [
    { name: '系统提示词', ratio: summary.avgRatioByComponent.systemPrompt, tokens: summary.avgByComponent.systemPrompt },
    { name: '对话历史', ratio: summary.avgRatioByComponent.conversationHistory, tokens: summary.avgByComponent.conversationHistory },
    { name: '工具定义', ratio: summary.avgRatioByComponent.toolDefinitions, tokens: summary.avgByComponent.toolDefinitions },
    { name: '工具返回', ratio: summary.avgRatioByComponent.toolResults, tokens: summary.avgByComponent.toolResults },
    { name: '用户消息', ratio: summary.avgRatioByComponent.userMessage, tokens: summary.avgByComponent.userMessage },
  ];

  for (const comp of components) {
    const filled = Math.round(comp.ratio * 14);
    const bar = '█'.repeat(filled) + '░'.repeat(14 - filled);
    const percent = (comp.ratio * 100).toFixed(0).padStart(2);
    const tokens = comp.tokens.toLocaleString().padStart(7);
    lines.push(`  ${comp.name.padEnd(6)} ${bar}  ${percent}%  (${tokens})`);
  }

  lines.push('');
  // 优化建议
  if (summary.topConsumers.length > 0) {
    const top = summary.topConsumers[0];
    lines.push(`💡 优化建议：${top.component}占比最高（${(top.ratio * 100).toFixed(0)}%），考虑精简或启用缓存`);
  }

  return lines.join('\n');
}
