// desktop/renderer/src/components/chat/ExecutionProcess.tsx
// 执行过程：时间线列表——按时间顺序合并中间自言自语 + 工具调用组
// C-V2：从"思考/动作两层折叠"改为时间线，体现 ReAct 循环真实发生顺序
// - intermediateThoughts（每轮工具调用前的说明性文字）独立成折叠条目
// - 同类相邻工具调用合并成一组（如连续多次 code_search 合并为"已搜索 N 次"）
// - reasoning（reasoning 模型的深度思考）单独折叠在时间线末尾，作为整体推理背景

import { useState, useEffect, useMemo } from 'react';
import {
  Activity, Brain, ChevronRight, ChevronDown, Loader2,
} from 'lucide-react';
import type { ToolCallItem } from '../ToolCallCard.js';
import { ActionSummaryRow, SubAgentRow } from '../ToolCallCard.js';

/** 格式化耗时（毫秒）为可读字符串 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}秒`;
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}分${sec}秒`;
}

/**
 * 将 reasoning 文本解析为思考步骤列表
 * 按换行或中文句号分割，过滤空行
 * - 思考中（isThinking=true）：最后一步=active，之前=done
 * - 已完成（isThinking=false）：全部=done
 */
export interface ThinkingStep {
  text: string;
  status: 'pending' | 'active' | 'done';
}

export function parseReasoningSteps(reasoningText: string, isThinking: boolean): ThinkingStep[] {
  if (!reasoningText) return [];
  const rawLines = reasoningText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const steps: string[] = [];
  for (const line of rawLines) {
    const sentences = line.split(/[。.]/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length > 1) {
      steps.push(...sentences.map((s) => s.endsWith('。') || s.endsWith('.') ? s : s + '。'));
    } else {
      steps.push(line);
    }
  }
  if (steps.length === 0) return [];
  return steps.map((text, idx) => {
    let status: ThinkingStep['status'];
    if (!isThinking) {
      status = 'done';
    } else if (idx < steps.length - 1) {
      status = 'done';
    } else {
      status = 'active';
    }
    return { text, status };
  });
}

function TreeBranch({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <span className="absolute -left-3 top-[0.85rem] h-px w-3 bg-rd-tree-line" aria-hidden />
      {children}
    </div>
  );
}

function ProcessEntry({
  summary,
  expanded,
  onToggle,
  isRunning,
}: {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  isRunning: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 py-1 text-left text-xs text-rd-textSubtle transition hover:text-rd-text"
    >
      {expanded
        ? <ChevronDown size={14} className="shrink-0 text-rd-textSubtle" />
        : <ChevronRight size={14} className="shrink-0 text-rd-textSubtle" />}
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      {isRunning && <Loader2 size={12} className="shrink-0 animate-spin text-rd-primary" />}
    </button>
  );
}

/** 思考步骤行 */
function ThinkingStepRow({ step }: { step: ThinkingStep }) {
  return (
    <div className="py-0.5 text-xs leading-relaxed text-rd-textMuted">
      {step.text}
    </div>
  );
}

/** 可折叠区块标题（用于思考/动作层） */
function FoldableSection({
  icon,
  title,
  summary,
  expanded,
  onToggle,
  disabled,
  running,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  disabled?: boolean;
  running?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TreeBranch>
      <button
        type="button"
        onClick={disabled ? undefined : onToggle}
        className={[
          'flex w-full items-center gap-2 py-1 text-left text-xs transition',
          disabled ? 'cursor-default opacity-50' : 'cursor-pointer hover:text-rd-text',
        ].join(' ')}
      >
        <span className="shrink-0 text-rd-textSubtle">{icon}</span>
        <span className="shrink-0 font-medium text-rd-text">{title}</span>
        <span className="min-w-0 flex-1 truncate text-rd-textMuted">{summary}</span>
        {running && <Loader2 size={12} className="shrink-0 animate-spin text-rd-primary" />}
        {!disabled && (expanded
          ? <ChevronDown size={12} className="shrink-0 text-rd-textSubtle" />
          : <ChevronRight size={12} className="shrink-0 text-rd-textSubtle" />)}
      </button>
      {expanded && !disabled && (
        <div className="mt-1 space-y-1">
          {children}
        </div>
      )}
    </TreeBranch>
  );
}

/** 时间线条目：思考块或工具组，按 timestamp 排序合并 */
type TimelineEntry =
  | { kind: 'thought'; id: string; text: string; timestamp: number }
  | { kind: 'progress'; id: string; text: string; timestamp: number }
  | { kind: 'tool-group'; toolName: string; items: ToolCallItem[]; timestamp: number };

/**
 * 把 intermediateThoughts + toolGroups 合并成按时间排序的时间线
 * 同类相邻工具调用合并成一组（如连续多次 code_search 合并）
 * 中间穿插的思考块独立成条
 */
export function buildTimeline(
  intermediateThoughts: { id: string; text: string; timestamp: number }[],
  progressEvents: { id: string; text: string; timestamp: number }[],
  toolGroups: Record<string, ToolCallItem[]>,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...intermediateThoughts.map((thought) => ({ kind: 'thought' as const, ...thought })),
    ...progressEvents.map((progress) => ({ kind: 'progress' as const, ...progress })),
  ];

  for (const items of Object.values(toolGroups)) {
    for (const item of items) {
      entries.push({
        kind: 'tool-group',
        toolName: item.toolName,
        items: [item],
        timestamp: item.timestamp ?? 0,
      });
    }
  }
  entries.sort((a, b) => a.timestamp - b.timestamp);

  // 只合并时间线上真正相邻的同类工具；任何思考或进度事件都会保留顺序边界。
  return entries.reduce<TimelineEntry[]>((merged, entry) => {
    const previous = merged[merged.length - 1];
    if (
      entry.kind === 'tool-group'
      && previous?.kind === 'tool-group'
      && previous.toolName === entry.toolName
    ) {
      previous.items.push(...entry.items);
      return merged;
    }
    merged.push(entry);
    return merged;
  }, []);
}

/** 单条中间自言自语：可折叠展示完整文本 */
function ThoughtEntry({ entry }: { entry: { id: string; text: string; timestamp: number } }) {
  const [expanded, setExpanded] = useState(false);
  // 折叠态显示首行预览，展开态显示完整文本
  const firstLine = entry.text.split('\n')[0] ?? '';
  const preview = firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine;
  return (
    <TreeBranch>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-2 py-1 text-left text-xs transition hover:text-rd-text"
      >
        <Brain size={13} className="shrink-0 text-rd-textSubtle" />
        <span className="shrink-0 font-medium text-rd-text">思考</span>
        <span className="min-w-0 flex-1 truncate text-rd-textMuted">{preview}</span>
        {expanded
          ? <ChevronDown size={12} className="shrink-0 text-rd-textSubtle" />
          : <ChevronRight size={12} className="shrink-0 text-rd-textSubtle" />}
      </button>
      {expanded && (
        <div className="mt-1 rounded-md bg-rd-surfaceHighlight p-3 text-xs leading-relaxed text-rd-textMuted whitespace-pre-wrap">
          {entry.text}
        </div>
      )}
    </TreeBranch>
  );
}

function ProgressEntry({ entry, isActive }: {
  entry: { id: string; text: string; timestamp: number };
  isActive: boolean;
}) {
  return (
    <TreeBranch>
      <div className="flex items-center gap-2 py-1 text-xs">
        {isActive
          ? <Loader2 size={13} className="shrink-0 animate-spin text-rd-primary" />
          : <Activity size={13} className="shrink-0 text-rd-textSubtle" />}
        <span className="shrink-0 font-medium text-rd-text">进度</span>
        <span className="min-w-0 flex-1 truncate text-rd-textMuted" title={entry.text}>{entry.text}</span>
      </div>
    </TreeBranch>
  );
}

export function ExecutionProcess({
  toolGroups,
  thinkingSteps,
  intermediateThoughts,
  progressEvents,
  isRunning,
  isCompleted,
  duration,
}: {
  toolGroups: Record<string, ToolCallItem[]>;
  thinkingSteps: ThinkingStep[];
  intermediateThoughts: { id: string; text: string; timestamp: number }[];
  progressEvents: { id: string; text: string; timestamp: number }[];
  isRunning: boolean;
  isCompleted: boolean;
  duration: number;
}) {
  const [expanded, setExpanded] = useState(!isCompleted);
  const [reasoningExpanded, setReasoningExpanded] = useState(false);

  useEffect(() => {
    if (isCompleted) setExpanded(false);
    else if (isRunning) setExpanded(true);
  }, [isCompleted, isRunning]);

  // 子 Agent 单独拎出来作为支线
  const spawnAgentItems = toolGroups.spawn_agent || [];
  // 动作层：排除 spawn_agent
  const actionToolGroups: Record<string, ToolCallItem[]> = useMemo(() => {
    const result: Record<string, ToolCallItem[]> = {};
    for (const [name, items] of Object.entries(toolGroups)) {
      if (name !== 'spawn_agent') result[name] = items;
    }
    return result;
  }, [toolGroups]);

  // 构建时间线：合并 intermediateThoughts + actionToolGroups
  const timeline = useMemo(
    () => buildTimeline(intermediateThoughts, progressEvents, actionToolGroups),
    [intermediateThoughts, progressEvents, actionToolGroups],
  );

  const totalActions = Object.values(actionToolGroups).reduce((sum, items) => sum + items.length, 0);
  const thinkingActive = isRunning && thinkingSteps.length > 0;

  // 过程摘要：思考 N 段 · M 次操作 · K 个子 Agent · 12 秒
  const parts: string[] = [];
  if (intermediateThoughts.length > 0) parts.push(`思考 ${intermediateThoughts.length} 段`);
  if (progressEvents.length > 0) parts.push(`进度 ${progressEvents.length} 条`);
  if (thinkingSteps.length > 0) parts.push(`推理 ${thinkingSteps.length} 段`);
  if (totalActions > 0) parts.push(`${totalActions} 次操作`);
  if (spawnAgentItems.length > 0) parts.push(`${spawnAgentItems.length} 个子 Agent`);
  if (duration > 0) parts.push(formatDuration(duration));
  const processSummary = parts.join(' · ') || '过程记录';

  if (timeline.length === 0 && thinkingSteps.length === 0 && spawnAgentItems.length === 0) return null;

  return (
    <div className="w-full text-xs">
      <ProcessEntry
        summary={processSummary}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        isRunning={isRunning}
      />

      {expanded && (
        <div className="ml-3 mt-1.5 space-y-1 border-l border-rd-tree-line pl-3">
          {/* 时间线：按真实发生顺序展示思考块 + 工具组 */}
          {timeline.map((entry) => {
            if (entry.kind === 'thought') {
              return <ThoughtEntry key={entry.id} entry={entry} />;
            }
            if (entry.kind === 'progress') {
              return <ProgressEntry
                key={entry.id}
                entry={entry}
                isActive={isRunning && entry.id === progressEvents[progressEvents.length - 1]?.id}
              />;
            }
            return (
              <TreeBranch key={`tg-${entry.toolName}-${entry.timestamp}`}>
                <ActionSummaryRow toolName={entry.toolName} items={entry.items} />
              </TreeBranch>
            );
          })}

          {/* reasoning 模型的深度思考：单独折叠在时间线末尾，作为整体推理背景 */}
          {thinkingSteps.length > 0 && (
            <FoldableSection
              icon={<Brain size={13} />}
              title="推理"
              summary={`${thinkingSteps.length} 段`}
              expanded={reasoningExpanded}
              onToggle={() => setReasoningExpanded(v => !v)}
              disabled={false}
              running={thinkingActive}
            >
              {thinkingSteps.map((step, idx) => (
                <ThinkingStepRow key={`${step.text}-${idx}`} step={step} />
              ))}
            </FoldableSection>
          )}

          {/* 子 Agent：单独支线 */}
          {spawnAgentItems.map((item) => (
            <TreeBranch key={item.id}>
              <SubAgentRow item={item} />
            </TreeBranch>
          ))}
        </div>
      )}
    </div>
  );
}
