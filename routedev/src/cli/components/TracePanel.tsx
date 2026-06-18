// src/cli/components/TracePanel.tsx
// TracePanel 组件：全链路 Trace 可视化（Phase 23 Task 1）
// 消费 TraceCollector 产出的 TraceSpan，转换为时间线视图并渲染

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TraceSpan, TraceSession } from '../../harness/trace-types.js';

// ============================================================
// 类型定义
// ============================================================

/** Trace 时间线条目分类 */
export type TraceCategory = 'routing' | 'model' | 'tool' | 'assembly' | 'delivery' | 'compose' | 'hook';

/** 单条 Trace 时间线条目 */
export interface TraceTimelineEntry {
  stepIndex: number;
  label: string;
  category: TraceCategory;
  startTimeMs: number;
  durationMs: number;
  metadata: {
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    toolName?: string;
    confidence?: number;
    /** Compose 阶段名 */
    phase?: string;
    /** 钩子事件类型 */
    hookEvent?: string;
    /** 钩子名称 */
    hookName?: string;
  };
}

// ============================================================
// 常量
// ============================================================

/** 条形图最大宽度（字符数） */
const BAR_MAX_WIDTH = 40;
/** 每页显示条目数 */
const PAGE_SIZE = 15;
/** 自动分页阈值 */
const PAGINATION_THRESHOLD = 20;

/** 分类 → 颜色映射 */
const CATEGORY_COLOR: Record<TraceCategory, string> = {
  routing: 'blue',
  model: 'green',
  tool: 'yellow',
  assembly: 'gray',
  delivery: 'magenta',
  compose: 'cyan',
  hook: 'red',
};

/** 填充字符 */
const FILLED_CHAR = '█';
const EMPTY_CHAR = '░';

// ============================================================
// 转换函数
// ============================================================

/**
 * 将 TraceSpan[] 转换为 TraceTimelineEntry[]
 * 处理 span 缺失/乱序的边界情况
 * @param spans 原始 span 列表
 * @param session 可选的会话信息（用于补充路由决策条目）
 */
export function parseTimelineEntries(
  spans: TraceSpan[],
  session?: TraceSession,
): TraceTimelineEntry[] {
  const entries: TraceTimelineEntry[] = [];
  let stepIndex = 0;

  // 如果有路由决策信息，作为第一条 routing 条目
  if (session?.routeDecision) {
    entries.push({
      stepIndex: ++stepIndex,
      label: `Routing Decision → ${session.routeDecision.modelId}`,
      category: 'routing',
      startTimeMs: session.startTime,
      durationMs: 0, // 路由决策耗时未知，设为 0
      metadata: {
        model: session.routeDecision.modelId,
        confidence: session.routeDecision.fallbackUsed ? 0.5 : undefined,
      },
    });
  }

  // 按 startTime 排序（处理乱序）
  const sortedSpans = [...spans].sort((a, b) => a.startTime - b.startTime);

  for (const span of sortedSpans) {
    const durationMs = span.durationMs ?? (span.endTime ? span.endTime - span.startTime : 0);
    const entry = spanToEntry(span, ++stepIndex, durationMs);
    if (entry) entries.push(entry);
  }

  return entries;
}

/** 单个 span → entry 转换 */
function spanToEntry(span: TraceSpan, stepIndex: number, durationMs: number): TraceTimelineEntry | null {
  const base = {
    stepIndex,
    startTimeMs: span.startTime,
    durationMs,
  };

  switch (span.payload.type) {
    case 'llm_call':
      return {
        ...base,
        label: `LLM Call (${span.payload.modelId})`,
        category: 'model',
        metadata: {
          model: span.payload.modelId,
          tokensIn: span.payload.inputTokens,
          tokensOut: span.payload.outputTokens,
        },
      };

    case 'tool_call':
      return {
        ...base,
        label: `Tool: ${span.payload.toolName}`,
        category: 'tool',
        metadata: {
          toolName: span.payload.toolName,
        },
      };

    case 'react_iteration':
      return {
        ...base,
        label: span.payload.thought
          ? `ReAct #${span.payload.iteration}: ${span.payload.thought.slice(0, 40)}`
          : `ReAct Iteration #${span.payload.iteration}`,
        category: 'assembly',
        metadata: {},
      };

    case 'worker_task':
      return {
        ...base,
        label: `Worker [${span.payload.role}]: ${span.payload.description.slice(0, 40)}`,
        category: 'assembly',
        metadata: {},
      };

    case 'goal_step':
      return {
        ...base,
        label: `Goal Step ${span.payload.stepId}/${span.payload.totalSteps}: ${span.payload.description.slice(0, 40)}`,
        category: 'routing',
        metadata: {},
      };

    case 'compose_phase':
      return {
        ...base,
        label: `Compose Phase: ${span.payload.phase}`,
        category: 'compose',
        metadata: {
          phase: span.payload.phase,
        },
      };

    case 'hook':
      return {
        ...base,
        label: `Hook [${span.payload.event}]: ${span.payload.hookName}`,
        category: 'hook',
        metadata: {
          hookEvent: span.payload.event,
          hookName: span.payload.hookName,
        },
      };

    default:
      return null;
  }
}

// ============================================================
// 辅助函数
// ============================================================

/** 计算条形图字符串 */
export function formatTimelineBar(durationMs: number, totalMs: number): string {
  if (totalMs <= 0) return FILLED_CHAR; // 最少 1 格
  const width = Math.max(1, Math.round((durationMs / totalMs) * BAR_MAX_WIDTH));
  return FILLED_CHAR.repeat(width) + EMPTY_CHAR.repeat(BAR_MAX_WIDTH - width);
}

/** 格式化耗时（ms → 人类可读） */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 计算汇总信息 */
export function computeSummary(entries: TraceTimelineEntry[]): {
  totalMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  stepCount: number;
} {
  let totalMs = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  for (const entry of entries) {
    totalMs += entry.durationMs;
    if (entry.metadata.tokensIn) totalTokensIn += entry.metadata.tokensIn;
    if (entry.metadata.tokensOut) totalTokensOut += entry.metadata.tokensOut;
  }

  return {
    totalMs,
    totalTokensIn,
    totalTokensOut,
    stepCount: entries.length,
  };
}

// ============================================================
// 组件
// ============================================================

interface TracePanelProps {
  entries: TraceTimelineEntry[];
  sessionId?: string;
  /** 披露层级：1 摘要 / 2 关键细节 / 3 完整时间线 */
  level?: 1 | 2 | 3;
}

/** TracePanel：全链路 Trace 可视化组件 */
export function TracePanel({ entries, sessionId, level = 2 }: TracePanelProps) {
  const [page, setPage] = useState(0);
  const totalPages = entries.length > PAGINATION_THRESHOLD
    ? Math.ceil(entries.length / PAGE_SIZE)
    : 1;

  useInput((_input, key) => {
    if (totalPages <= 1) return;
    // 修复：Ink 中箭头键通过 key.upArrow/key.downArrow 传递，不是 input 字符串
    if (key.downArrow || _input === 'j') {
      setPage(p => Math.min(p + 1, totalPages - 1));
    } else if (key.upArrow || _input === 'k') {
      setPage(p => Math.max(p - 1, 0));
    }
  });

  // 空数据处理
  if (entries.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red">未找到该会话的 Trace 数据</Text>
      </Box>
    );
  }

  const summary = computeSummary(entries);
  const totalMs = summary.totalMs || 1; // 避免除零

  // L1：仅显示总耗时和步骤数
  if (level === 1) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="cyan" bold>
          └─ Total: {formatDuration(summary.totalMs)} │ Steps: {summary.stepCount} ─┘
        </Text>
      </Box>
    );
  }

  // 分页
  const showPagination = entries.length > PAGINATION_THRESHOLD;
  const startIdx = showPagination ? page * PAGE_SIZE : 0;
  const endIdx = showPagination ? startIdx + PAGE_SIZE : entries.length;
  const visibleEntries = entries.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 标题栏 */}
      <Box>
        <Text color="cyan" bold>
          ┌─ Trace: {sessionId ?? 'session'} ─────────────────────────────────────┐
        </Text>
      </Box>

      {/* 时间线条目 */}
      {visibleEntries.map((entry) => {
        const color = CATEGORY_COLOR[entry.category];
        const bar = formatTimelineBar(entry.durationMs, totalMs);
        return (
          <Box key={entry.stepIndex} flexDirection="column" marginBottom={0}>
            <Box>
              <Text color="gray">#{entry.stepIndex}  </Text>
              <Text color={color} bold>{entry.label.padEnd(36).slice(0, 36)}</Text>
              <Text color="white"> {formatDuration(entry.durationMs).padStart(8)}</Text>
              {level === 3 && entry.metadata.tokensIn !== undefined && entry.metadata.tokensOut !== undefined && (
                <Text color="gray">  tokens: {entry.metadata.tokensIn}→{entry.metadata.tokensOut}</Text>
              )}
              {level === 3 && entry.metadata.confidence !== undefined && (
                <Text color="gray">  confidence={entry.metadata.confidence}</Text>
              )}
              {level === 3 && entry.metadata.toolName && (
                <Text color="gray">  tool={entry.metadata.toolName}</Text>
              )}
              {level === 3 && entry.metadata.phase && (
                <Text color="gray">  phase={entry.metadata.phase}</Text>
              )}
              {level === 3 && entry.metadata.hookEvent && (
                <Text color="gray">  event={entry.metadata.hookEvent}</Text>
              )}
              {level === 3 && entry.metadata.hookName && (
                <Text color="gray">  hook={entry.metadata.hookName}</Text>
              )}
            </Box>
            {level === 3 && (
              <Box paddingLeft={4}>
                <Text color={color}>{bar}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {/* 分页提示 */}
      {showPagination && level === 3 && (
        <Box>
          <Text color="gray">
            页 {page + 1}/{totalPages} — j/k 或 ↑↓ 翻页
          </Text>
        </Box>
      )}

      {/* 汇总行 */}
      <Box>
        <Text color="cyan" bold>
          └─ Total: {formatDuration(summary.totalMs)}{level === 3 && <> │ Model tokens: {summary.totalTokensIn + summary.totalTokensOut}</>} │ Steps: {summary.stepCount} ─┘
        </Text>
      </Box>
    </Box>
  );
}

// ============================================================
// 纯文本渲染（供 /trace view 命令使用）
// ============================================================

/**
 * 将时间线渲染为纯文本字符串（供命令行输出使用）
 * 命令系统返回 string[]，无法直接渲染 React 组件
 * @param level 披露层级：1 摘要 / 2 关键细节 / 3 完整时间线
 */
export function renderTraceTimelineText(entries: TraceTimelineEntry[], sessionId?: string, level: 1 | 2 | 3 = 2): string {
  if (entries.length === 0) {
    return '未找到该会话的 Trace 数据';
  }

  const summary = computeSummary(entries);

  // L1：仅显示总耗时和步骤数
  if (level === 1) {
    return `Total: ${formatDuration(summary.totalMs)} | Steps: ${summary.stepCount}`;
  }

  const totalMs = summary.totalMs || 1;
  const lines: string[] = [];

  lines.push(`┌─ Trace: ${sessionId ?? 'session'} ─────────────────────────────────────┐`);

  for (const entry of entries) {
    const bar = formatTimelineBar(entry.durationMs, totalMs);
    const metaParts: string[] = [];
    if (level === 3 && entry.metadata.tokensIn !== undefined && entry.metadata.tokensOut !== undefined) {
      metaParts.push(`tokens: ${entry.metadata.tokensIn}→${entry.metadata.tokensOut}`);
    }
    if (level === 3 && entry.metadata.confidence !== undefined) {
      metaParts.push(`confidence=${entry.metadata.confidence}`);
    }
    if (level === 3 && entry.metadata.toolName) {
      metaParts.push(`tool=${entry.metadata.toolName}`);
    }
    if (level === 3 && entry.metadata.phase) {
      metaParts.push(`phase=${entry.metadata.phase}`);
    }
    if (level === 3 && entry.metadata.hookEvent) {
      metaParts.push(`event=${entry.metadata.hookEvent}`);
    }
    if (level === 3 && entry.metadata.hookName) {
      metaParts.push(`hook=${entry.metadata.hookName}`);
    }
    const metaStr = metaParts.length > 0 ? `  ${metaParts.join('  ')}` : '';
    lines.push(`#${entry.stepIndex}  ${entry.label.slice(0, 36).padEnd(36)} ${formatDuration(entry.durationMs).padStart(8)}${metaStr}`);
    if (level === 3) {
      lines.push(`    ${bar}`);
    }
  }

  const tokenPart = level === 3 ? ` │ Model tokens: ${summary.totalTokensIn + summary.totalTokensOut}` : '';
  lines.push(`└─ Total: ${formatDuration(summary.totalMs)}${tokenPart} │ Steps: ${summary.stepCount} ─┘`);

  return lines.join('\n');
}
