// src/agent/micro-summary.ts
// Phase 34 Task 2：微摘要生成器
// 在任务完成后，从 Trace span 和最终回复中提取“任务完成状态 + 摘要 + 关键决策 + 操作按钮”

import type { TraceSpan, TrajectorySummary } from '../harness/trace-types.js';

/** 文件变更摘要 */
interface FileChangeSummary {
  path: string;
  /** 增加行数（粗略估算） */
  added: number;
  /** 删除行数（粗略估算） */
  removed: number;
}

/** 微摘要数据结构 */
export interface MicroSummary {
  /** 任务状态 */
  status: 'success' | 'failure' | 'paused';
  /** 任务标题（用户原始问题或生成的简短描述） */
  title: string;
  /** 步骤数（LLM 迭代 / 工具调用等） */
  stepCount: number;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 文件变更列表 */
  fileChanges: FileChangeSummary[];
  /** 关键决策 */
  keyDecisions: string[];
  /** 统计摘要 */
  trajectory: TrajectorySummary | null;
}

/**
 * 从最终回复文本中提取 <decision> 标签内容
 * 采用“可选提取”策略：模型遵守标签格式时精确提取，否则返回空数组
 * 不在系统提示中强制要求标签，避免影响所有模型输出行为
 */
export function extractDecisions(content: string): string[] {
  const decisions: string[] = [];
  const regex = /<decision>([\s\S]*?)<\/decision>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const text = match[1].trim();
    if (text) {
      // 限制单条决策长度，避免过长摘要
      decisions.push(text.length > 120 ? text.slice(0, 120) + '...' : text);
    }
  }
  return decisions;
}

/**
 * 估算文件变更行数
 * 从工具结果中匹配 "+n/-n" 或 "added/removed" 等常见 diff 输出
 */
function estimateFileChanges(spans: TraceSpan[]): FileChangeSummary[] {
  const changes = new Map<string, FileChangeSummary>();

  for (const span of spans) {
    if (span.payload.type !== 'tool_call') continue;
    const toolName = span.payload.toolName;
    const result = span.payload.result ?? '';
    const args = span.payload.args ?? {};

    // file_write / file_edit 工具
    const pathArg = args.path as string | undefined;
    if (!pathArg) continue;

    if (toolName === 'file_write' || toolName === 'file_edit') {
      const addedMatch = result.match(/\+(\d+)\s*\/\s*-(\d+)/);
      const removedMatch = result.match(/added\s*(\d+).*removed\s*(\d+)/i);
      let added = 0;
      let removed = 0;
      if (addedMatch) {
        added = parseInt(addedMatch[1], 10);
        removed = parseInt(addedMatch[2], 10);
      } else if (removedMatch) {
        added = parseInt(removedMatch[1], 10);
        removed = parseInt(removedMatch[2], 10);
      }

      const existing = changes.get(pathArg);
      if (existing) {
        existing.added += added;
        existing.removed += removed;
      } else {
        changes.set(pathArg, { path: pathArg, added, removed });
      }
    }
  }

  return Array.from(changes.values()).filter(c => c.added > 0 || c.removed > 0);
}

/**
 * 生成任务微摘要
 *
 * @param userInput 用户原始输入
 * @param finalContent 模型最终回复
 * @param spans Trace span 列表
 * @param trajectory Trajectory 汇总指标
 * @param status 完成状态
 */
export function generateMicroSummary(
  userInput: string,
  finalContent: string,
  spans: TraceSpan[],
  trajectory: TrajectorySummary | null,
  status: 'success' | 'failure' | 'paused',
): MicroSummary {
  const title = userInput.slice(0, 60) || '任务';
  const stepCount = trajectory
    ? trajectory.toolCallCount + trajectory.llmCallCount
    : spans.filter(s => s.payload.type === 'tool_call' || s.payload.type === 'llm_call').length;
  const durationMs = trajectory?.durationMs ?? 0;

  let keyDecisions = extractDecisions(finalContent);
  // 如果模型未使用 <decision> 标签，从 finalContent 中尝试提取“关键决策”相关句子作为降级
  if (keyDecisions.length === 0) {
    const fallback = extractDecisionFallback(finalContent);
    if (fallback) keyDecisions = [fallback];
  }

  const fileChanges = estimateFileChanges(spans);

  return {
    status,
    title,
    stepCount,
    durationMs,
    fileChanges,
    keyDecisions,
    trajectory,
  };
}

/**
 * 降级提取：从最终回复中找包含“决定/选择/采用/改为”等关键词的句子
 */
function extractDecisionFallback(content: string): string | null {
  const sentences = content
    .split(/[。！？\n]/)
    .map(s => s.trim())
    .filter(s => s.length > 5 && s.length < 150);

  const keywords = ['决定', '选择', '采用', '改为', '优化', '重构', '使用', '切换到'];
  for (const sentence of sentences) {
    if (keywords.some(k => sentence.includes(k))) {
      return sentence;
    }
  }
  return null;
}
