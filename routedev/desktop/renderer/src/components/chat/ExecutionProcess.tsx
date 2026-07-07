// desktop/renderer/src/components/chat/ExecutionProcess.tsx
// 执行过程：思考层 + 动作层折叠树
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致

import { useState, useEffect } from 'react';
import {
  Wrench, Brain, ChevronRight, ChevronDown,
  CheckCircle2, XCircle, Loader2,
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
  // 按换行分割，再按中文句号/英文句号分割
  const rawLines = reasoningText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  // 进一步按句号拆分过长的行
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

function buildProcessSummary(totalToolCalls: number, duration: number, hasReasoning: boolean): string {
  const parts = ['过程记录'];
  if (hasReasoning) parts.push('含思考');
  if (totalToolCalls > 0) parts.push(`${totalToolCalls} 次操作`);
  if (duration > 0) parts.push(formatDuration(duration));
  return parts.join(' · ');
}

function countToolStatus(items: ToolCallItem[]): { success: number; error: number; running: number } {
  return items.reduce(
    (acc, item) => {
      if (item.status === 'completed') acc.success += 1;
      else if (item.status === 'error') acc.error += 1;
      else acc.running += 1;
      return acc;
    },
    { success: 0, error: 0, running: 0 },
  );
}

/**
 * 树枝节点：在连续竖线（由父容器 border-l 提供）上挂一个带水平连接线的子项。
 * 竖线颜色使用主题专属 --rd-tree-line，比背景浅一点且不抢戏，各主题单独适配。
 */
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

/** 状态图标 */
function StatusDot({ status }: { status: 'running' | 'completed' | 'error' | 'active' | 'done' }) {
  if (status === 'running' || status === 'active') {
    return <Loader2 size={12} className="shrink-0 animate-spin text-rd-primary" />;
  }
  if (status === 'error') {
    return <XCircle size={12} className="shrink-0 text-rd-danger" />;
  }
  return <CheckCircle2 size={12} className="shrink-0 text-rd-success" />;
}

/** 过程记录入口：一行摘要，点击展开/折叠整棵树 */
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

export function ExecutionProcess({
  toolGroups,
  thinkingSteps,
  isRunning,
  isCompleted,
  duration,
}: {
  toolGroups: Record<string, ToolCallItem[]>;
  thinkingSteps: ThinkingStep[];
  isRunning: boolean;
  isCompleted: boolean;
  duration: number;
}) {
  const [expanded, setExpanded] = useState(!isCompleted);
  const [expandedSection, setExpandedSection] = useState<'thinking' | 'actions' | null>(null);

  useEffect(() => {
    if (isCompleted) setExpanded(false);
    else if (isRunning) setExpanded(true);
  }, [isCompleted, isRunning]);

  // 子 Agent 单独拎出来作为支线
  const spawnAgentItems = toolGroups.spawn_agent || [];
  // 动作层：工具 + 命令合并
  const actionGroups = Object.entries(toolGroups).filter(([toolName]) => toolName !== 'spawn_agent');
  const totalActions = actionGroups.reduce((sum, [, items]) => sum + items.length, 0);

  const thinkingActive = isRunning && thinkingSteps.length > 0;

  // 过程摘要：思考 N 段 · M 次操作 · K 个子 Agent · 12 秒
  const parts: string[] = [];
  if (thinkingSteps.length > 0) parts.push(`思考 ${thinkingSteps.length} 段`);
  if (totalActions > 0) parts.push(`${totalActions} 次操作`);
  if (spawnAgentItems.length > 0) parts.push(`${spawnAgentItems.length} 个子 Agent`);
  if (duration > 0) parts.push(formatDuration(duration));
  const processSummary = parts.join(' · ') || '过程记录';

  if (totalActions === 0 && thinkingSteps.length === 0 && spawnAgentItems.length === 0) return null;

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
          <FoldableSection
            icon={<Brain size={13} />}
            title="思考"
            summary={thinkingSteps.length > 0 ? `${thinkingSteps.length} 段` : '无'}
            expanded={expandedSection === 'thinking'}
            onToggle={() => setExpandedSection((v) => v === 'thinking' ? null : 'thinking')}
            disabled={thinkingSteps.length === 0}
            running={thinkingActive}
          >
            {thinkingSteps.map((step, idx) => (
              <ThinkingStepRow key={`${step.text}-${idx}`} step={step} />
            ))}
          </FoldableSection>

          <FoldableSection
            icon={<Wrench size={13} />}
            title="动作"
            summary={totalActions > 0 ? `${totalActions} 次` : '无'}
            expanded={expandedSection === 'actions'}
            onToggle={() => setExpandedSection((v) => v === 'actions' ? null : 'actions')}
            disabled={totalActions === 0}
          >
            <div className="space-y-1">
              {actionGroups.map(([toolName, items]) => (
                <ActionSummaryRow key={toolName} toolName={toolName} items={items} />
              ))}
            </div>
          </FoldableSection>

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
