// desktop/renderer/src/pages/ChatPage.tsx
// 对话页面：消息气泡、Markdown 渲染、工具调用卡片、文件拖拽、命令补全
// 左侧消息导航线段（hover 预览 + 点击跳转）+ 顶部跳到底部按钮
// 顶部状态栏：项目名 + 打开文件夹 + 自主度切换（Badge 点击弹菜单）
// 排队队列：引擎工作时可提前输入下一条消息，Enter 进入队列

import { useRef, useState, useEffect, useMemo, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Send, Square, Sparkles, AlertCircle, Wrench, UploadCloud,
  ArrowDown, FolderOpen, X, Edit3, Clock, Zap, BookOpen, Plug,
  Copy, Trash2, RefreshCw, GitFork, Check, ChevronRight, ChevronDown, Timer,
  Brain, Terminal, CheckCircle2, XCircle, Loader2, History,
} from 'lucide-react';
import type { ChatMessage, PendingConfirm } from '../hooks/useRouteDev.js';
import type { AppConfig, AutonomyMode } from '../../../../src/config/schema.js';
import type { TokenProfileSnapshot } from '../../../../src/agent/token-profiler.js';
import type { ConfigSaveResult, SkillInfo, MCPToolInfo } from '../../../shared/ipc-types.js';
import { MarkdownRenderer } from '../components/MarkdownRenderer.js';
import { ActionSummaryRow, SubAgentRow, ToolCallCard, getToolLabel, type OutputStyle, type ToolCallItem } from '../components/ToolCallCard.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';
import { Textarea } from '../components/ui/textarea.js';
import { NeuralNetworkBackground } from '../components/NeuralNetworkBackground.js';
import { CheckpointTimeline } from '../components/CheckpointTimeline.js';
import { useProjectsStore } from '../store/useProjectsStore.js';
import { useRouteDevStore } from '../store/useRouteDevStore.js';
import { GoalExecutionCard } from '../components/GoalExecutionCard.js';
import { StepEditor } from '../components/StepEditor.js';

interface ChatPageProps {
  messages: ChatMessage[];
  isProcessing: boolean;
  currentModel: string;
  pendingConfirm: PendingConfirm | null;
  config: AppConfig | null;
  tokenSnapshots: TokenProfileSnapshot[];
  sendMessage: (text: string) => void;
  confirmTool: (approved: boolean, payload?: unknown) => void;
  stopGeneration: () => void;
  saveConfig: (config: AppConfig) => Promise<ConfigSaveResult>;
  /** 删除单条消息 */
  deleteMessage: (messageId: string) => void;
  /** 重试某条消息（覆盖后续消息） */
  retryMessage: (messageId: string) => void;
}

// 支持的命令列表（Phase 37：扩展为动态获取 + 静态兜底）
// Phase 54：补全 /goal 命令（之前缺失导致斜杠命令列表不显示 /goal，且 /goal 输入后无补全）
const STATIC_COMMANDS = ['/clear', '/status', '/mcp', '/compact', '/help', '/skill', '/skills', '/goal'];
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  '/clear': '清空对话',
  '/status': '查看状态',
  '/mcp': 'MCP 状态',
  '/compact': '压缩上下文',
  '/help': '帮助',
  '/skill': 'Skill 管理',
  '/skills': 'Skill 列表',
  '/goal': '目标分解与执行（多 Agent 协作）',
};

// 自主度模式标签
const AUTONOMY_LABELS: Record<AutonomyMode, string> = {
  auto: '全自动',
  semi: '半自动',
  manual: '手动确认',
};

/** 格式化耗时（毫秒）为可读字符串 */
function formatDuration(ms: number): string {
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
interface ThinkingStep {
  text: string;
  status: 'pending' | 'active' | 'done';
}

function parseReasoningSteps(reasoningText: string, isThinking: boolean): ThinkingStep[] {
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

function ExecutionProcess({
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

/**
 * 任务块：一次 sendMessage 产生的所有消息（user + tool calls + assistant）归为一组
 * - 任务完成后默认折叠为一行"任务耗时：X秒"
 * - 展开后：用户消息 → 工具调用组（按工具名分组）→ assistant 回复
 * - 任务进行中时展开显示，工具调用区域限制最大高度避免连成一大坨
 */
function TaskBlock({
  taskMessages,
  outputStyle,
  isProcessing,
  onCopy,
  onDelete,
  onRetry,
  onFork,
  messageRef,
}: {
  taskMessages: ChatMessage[];
  outputStyle?: OutputStyle;
  isProcessing: boolean;
  onCopy?: (msg: ChatMessage) => void;
  onDelete?: (msg: ChatMessage) => void;
  onRetry?: (msg: ChatMessage) => void;
  onFork?: (msg: ChatMessage) => void;
  messageRef?: (id: string) => (el: HTMLDivElement | null) => void;
}) {
  // 分离消息：user / assistant / tool
  const userMsg = taskMessages.find(m => m.role === 'user');
  const assistantMsgs = taskMessages.filter(m => m.role === 'assistant');
  const toolMsgs = taskMessages.filter(m => m.role === 'system' && m.toolName && m.toolStatus);
  const systemMsgs = taskMessages.filter(m => m.role === 'system' && !m.toolName);

  // 判断任务是否完成
  const isCompleted = userMsg?.taskCompleted === true;
  const isRunning = isProcessing && !isCompleted;
  const duration = userMsg?.taskDuration ?? 0;

  // 按工具名分组
  const toolGroups = useMemo(() => {
    const groups: Record<string, ToolCallItem[]> = {};
    for (const m of toolMsgs) {
      const name = m.toolName!;
      if (!groups[name]) groups[name] = [];
      groups[name].push({
        id: m.id,
        toolName: name,
        status: m.toolStatus!,
        args: m.toolArgs,
        result: m.toolResult,
        timestamp: m.timestamp,
      });
    }
    return groups;
  }, [toolMsgs]);

  // 最新 assistant 消息（流式输出中）
  const latestAssistant = assistantMsgs[assistantMsgs.length - 1];
  const hasAssistantContent = latestAssistant && (latestAssistant.content || latestAssistant.isStreaming);
  const reasoningText = assistantMsgs.map((m) => m.reasoning).filter(Boolean).join('\n\n');

  // 思考步骤：从 reasoningText 解析
  const thinkingSteps = useMemo(
    () => parseReasoningSteps(reasoningText, isRunning),
    [reasoningText, isRunning],
  );
  // 始终显示：用户消息 → 执行过程 → assistant 回复
  return (
    <div className="space-y-2">
      {/* 用户消息（始终显示） */}
      {userMsg && (
        <MessageBubble
          message={userMsg}
          messageRef={messageRef?.(userMsg.id)}
          outputStyle={outputStyle}
          disabled={isProcessing}
          onCopy={() => onCopy?.(userMsg)}
          onDelete={() => onDelete?.(userMsg)}
          onRetry={() => onRetry?.(userMsg)}
          onFork={() => onFork?.(userMsg)}
        />
      )}

      {/* 系统消息（非工具调用） */}
      {systemMsgs.map(m => (
        <MessageBubble
          key={m.id}
          message={m}
          messageRef={messageRef?.(m.id)}
          outputStyle={outputStyle}
          disabled={isProcessing}
        />
      ))}

      {/* 执行过程：在最终回答前，统一三层结构 */}
      <ExecutionProcess
        toolGroups={toolGroups}
        thinkingSteps={thinkingSteps}
        isRunning={isRunning}
        isCompleted={isCompleted}
        duration={duration}
      />

      {/* assistant 回复（始终显示） */}
      {hasAssistantContent && (
        <>
          <MessageBubble
            message={latestAssistant}
            messageRef={messageRef?.(latestAssistant.id)}
            outputStyle={outputStyle}
            disabled={isProcessing}
            onCopy={() => onCopy?.(latestAssistant)}
            onDelete={() => onDelete?.(latestAssistant)}
            onRetry={() => onRetry?.(latestAssistant)}
            onFork={() => onFork?.(latestAssistant)}
          />
        </>
      )}
    </div>
  );
}

/** Phase 54：Goal marker 消息渲染——从 store 订阅对应 GoalExecution，用 GoalExecutionCard 展示 */
function GoalMessageBubble({ goalId }: { goalId: string }) {
  const execution = useRouteDevStore(state =>
    state.goalExecutions.find(g => g.goalId === goalId),
  );
  if (!execution) {
    return <div className="text-xs text-rd-textMuted px-1 py-2">目标执行中…</div>;
  }
  return <GoalExecutionCard execution={execution} />;
}

function MessageBubble({
  message,
  messageRef,
  outputStyle,
  onCopy,
  onDelete,
  onRetry,
  onFork,
  disabled,
}: {
  message: ChatMessage;
  messageRef?: (el: HTMLDivElement | null) => void;
  outputStyle?: OutputStyle;
  onCopy?: () => void;
  onDelete?: () => void;
  onRetry?: () => void;
  onFork?: () => void;
  disabled?: boolean;
}) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isSystem = message.role === 'system';
  const [copied, setCopied] = useState(false);
  // 复制成功反馈：2 秒后恢复图标
  const handleCopyClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onCopy?.();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // 复制后立即让按钮失去焦点，避免焦点留在按钮上导致后续输入框无法选中
    e.currentTarget.blur();
  };

  // 操作按钮组（hover 显示）：复制、重试、分支、删除
  // 工具调用消息（system + toolName）不显示操作按钮
  // Phase 54 修复：/goal 命令的 user 消息有 goalId 时不显示 actions（goal 卡片取代 user 气泡）
  const showActions = !disabled && (isUser || isAssistant) && !message.isStreaming
    && !message.goalId;
  const actions = showActions ? (
    <div className={[
      'flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100',
      isUser ? 'justify-end' : 'justify-start',
    ].join(' ')}>
      <button
        onClick={handleCopyClick}
        title="复制内容"
        className="flex h-8 w-8 items-center justify-center rounded-md text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
      >
        {copied ? <Check size={16} className="text-rd-primary" /> : <Copy size={16} />}
      </button>
      {onRetry && (
        <button
          onClick={onRetry}
          title="重试（覆盖后续消息）"
          className="flex h-8 w-8 items-center justify-center rounded-md text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
        >
          <RefreshCw size={16} />
        </button>
      )}
      {onFork && (
        <button
          onClick={onFork}
          title="从此处分叉新对话"
          className="flex h-8 w-8 items-center justify-center rounded-md text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
        >
          <GitFork size={16} />
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          title="删除任务块（含提问、思考过程、工具调用与回复）"
          className="flex h-8 w-8 items-center justify-center rounded-md text-rd-textSubtle transition hover:bg-rd-danger/10 hover:text-rd-danger"
        >
          <Trash2 size={16} />
        </button>
      )}
    </div>
  ) : null;

  // 工具调用消息：渲染为折叠卡片
  if (isSystem && message.toolName && message.toolStatus) {
    return (
      <div ref={messageRef} className="flex w-full justify-start">
        <div className="w-full">
          <ToolCallCard
            toolName={message.toolName}
            status={message.toolStatus}
            args={message.toolArgs}
            result={message.toolResult}
          />
        </div>
      </div>
    );
  }

  // Phase 54 修复：/goal 命令的 user 消息有 goalId 时，用 GoalExecutionCard 取代 user 气泡
  // 这样 goal 卡片就是 user 消息本身，不会被 actions 隔开
  if (isUser && message.goalId) {
    return (
      <div ref={messageRef} className="flex w-full justify-end">
        <div className="w-full">
          <GoalMessageBubble goalId={message.goalId} />
        </div>
      </div>
    );
  }

  // Phase 54 降级：独立 goal marker system 消息（找不到 user 消息时插入）
  if (isSystem && message.goalId) {
    return (
      <div ref={messageRef} className="flex w-full justify-start">
        <div className="w-full">
          <GoalMessageBubble goalId={message.goalId} />
        </div>
      </div>
    );
  }

  if (isUser) {
    return (
      <div ref={messageRef} className="group flex w-full items-end justify-end gap-2">
        <div className="flex max-w-[92%] flex-col items-end gap-1">
          <div className="rounded-rd bg-rd-primary px-4 py-3 text-rd-primaryForeground shadow-rd">
            <div className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</div>
          </div>
          {actions}
        </div>
      </div>
    );
  }

  if (isAssistant) {
    return (
      <div ref={messageRef} className="group flex w-full items-start gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rd-primary text-rd-primaryForeground">
          <Sparkles size={14} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <div className="w-full rounded-rd bg-rd-surfaceHover px-4 py-3 text-rd-text shadow-rd">
            {message.content ? <MarkdownRenderer content={message.content} /> : null}
          </div>
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div ref={messageRef} className="group flex w-full items-start gap-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rd-surfaceHover text-rd-textMuted">
        <Wrench size={14} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <div className="w-full rounded-rd border border-rd-border bg-rd-surface px-4 py-3 text-rd-textMuted shadow-rd">
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</div>
        </div>
        {actions}
      </div>
    </div>
  );
}

function ToolConfirmDialog({
  pending,
  onConfirm,
}: {
  pending: PendingConfirm;
  onConfirm: (approved: boolean, payload?: unknown) => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [collapsed, setCollapsed] = useState(false);
  const rawQuestions = Array.isArray(pending.params.questions)
    ? pending.params.questions
    : pending.params.question
      ? [pending.params.question]
      : [];
  const questions = rawQuestions
    .map((item) => typeof item === 'string' ? item : String((item as Record<string, unknown>)?.question ?? (item as Record<string, unknown>)?.content ?? ''))
    .filter(Boolean);
  const isQuestionMode = pending.toolName === 'ask_user' || pending.toolName === 'ask_question' || questions.length > 0;

  if (isQuestionMode) {
    const currentQuestion = questions[questionIndex] ?? '请回答问题';
    return (
      <div className="absolute inset-x-0 bottom-24 z-20 mx-auto w-full max-w-2xl px-4">
        <div className="rounded-2xl border border-rd-primary/30 bg-rd-surface shadow-rdLg">
          <div className="flex items-center justify-between gap-2 border-b border-rd-border/50 px-4 py-3">
            <div className="flex items-center gap-2 text-rd-primary">
              <AlertCircle size={16} />
              <span className="text-sm font-semibold">需要你回答</span>
              {questions.length > 1 && (
                <span className="text-xs text-rd-textSubtle">
                  第 {questionIndex + 1} / {questions.length} 个
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setCollapsed((current) => !current)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
              title={collapsed ? '展开' : '折叠'}
            >
              {collapsed ? <ChevronDown size={14} /> : <ChevronRight size={14} className="-rotate-90" />}
            </button>
          </div>
          {!collapsed && (
            <>
              <div className="space-y-3 px-4 py-3">
                <div className="text-sm leading-relaxed text-rd-text">
                  {currentQuestion}
                </div>
                <Textarea
                  value={answers[questionIndex] ?? ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [questionIndex]: e.target.value }))}
                  placeholder="在这里输入你的回答..."
                  className="min-h-28"
                />
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-rd-border/50 px-4 py-3">
                {questions.length > 1 ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={questionIndex === 0}
                      onClick={() => setQuestionIndex((idx) => Math.max(0, idx - 1))}
                    >
                      上一个
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={questionIndex >= questions.length - 1}
                      onClick={() => setQuestionIndex((idx) => Math.min(questions.length - 1, idx + 1))}
                    >
                      下一个
                    </Button>
                  </div>
                ) : (
                  <div />
                )}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => onConfirm(false)}>取消</Button>
                  <Button size="sm" onClick={() => onConfirm(true, { answers, questions })}>提交</Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-x-0 bottom-24 z-10 mx-auto w-full max-w-2xl px-4">
      <Card className="border-rd-warning/30 shadow-lg">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 text-rd-warning">
            <AlertCircle size={18} />
            <CardTitle className="text-base">工具调用需要确认</CardTitle>
          </div>
          <CardDescription>
            工具名：
            <code className="ml-1 rounded bg-rd-surface px-1 py-0.5 font-mono text-rd-primary">
              {pending.toolName}
            </code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-40 overflow-auto rounded-lg bg-rd-surface p-3 text-xs text-rd-textMuted">
            {JSON.stringify(pending.params, null, 2)}
          </pre>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" onClick={() => onConfirm(false)}>
            拒绝
          </Button>
          <Button onClick={() => onConfirm(true)}>批准</Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export function ChatPage({
  messages,
  isProcessing,
  currentModel,
  pendingConfirm,
  config,
  tokenSnapshots,
  sendMessage,
  confirmTool,
  stopGeneration,
  saveConfig,
  deleteMessage,
  retryMessage,
}: ChatPageProps) {
  const [input, setInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuVisible, setCommandMenuVisible] = useState(false);
  // Phase 54 修复：命令菜单位置状态（用 Portal 渲染到 body，避免被祖先 overflow-hidden 裁剪）
  const [commandMenuPos, setCommandMenuPos] = useState<{ top: number; left: number } | null>(null);
  // Phase 54 修复：IME 组合状态——组合期间不触发命令菜单，避免中文输入法干扰
  const [isComposing, setIsComposing] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  // 排队队列：引擎工作时用户提前输入的消息
  const [queue, setQueue] = useState<string[]>([]);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [editingQueueIdx, setEditingQueueIdx] = useState<number | null>(null);
  const [editingQueueValue, setEditingQueueValue] = useState('');
  // 自主度下拉菜单
  const [autonomyMenuOpen, setAutonomyMenuOpen] = useState(false);
  // 输入区高度（可拖动上边框调整）
  // 使用 v2 后缀避免读取到旧版本存储的小高度值
  // 最小值保护：防止 localStorage 中存储了 0 或负数导致输入区不可见
  const [inputHeight, setInputHeight] = useState<number>(() => {
    const saved = localStorage.getItem('routedev-input-height-v2');
    if (saved) {
      const n = Number(saved);
      if (!isNaN(n) && n >= 140) return Math.min(n, 640);
    }
    // 清除旧版本 key
    localStorage.removeItem('routedev-input-height');
    return 180;
  });
  const [isResizing, setIsResizing] = useState(false);
  // Phase 37：已启用的 Skill 列表和 MCP 工具列表（用于输入框上方 Badge 显示）
  const [enabledSkills, setEnabledSkills] = useState<SkillInfo[]>([]);
  const [mcpTools, setMcpTools] = useState<MCPToolInfo[]>([]);
  const [showSkillBar, setShowSkillBar] = useState(true);
  // Phase 47 Task 6：检查点时间轴面板（右侧可折叠面板）
  const [showCheckpointPanel, setShowCheckpointPanel] = useState(false);

  // 从 useProjectsStore 获取当前项目信息
  const { projects, currentProjectId, currentConversationId, forkConversationFromMessage } = useProjectsStore();
  const currentProject = projects.find((p) => p.id === currentProjectId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 消息 ID -> DOM 元素映射，用于跳转
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // 自动滚动到底部（仅当用户已在底部附近时）
  const isNearBottomRef = useRef(true);
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  // 切换对话时自动聚焦输入框，避免焦点丢失导致无法点击输入框
  // 无论 isProcessing 状态如何都聚焦：排队队列模式允许用户在引擎工作时输入下一条消息
  // 延迟一帧执行，确保 DOM 已完成渲染
  useEffect(() => {
    const timer = setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [currentConversationId]);

  // 切换对话时重置可能残留的 local state，避免旧对话的状态泄漏到新对话
  // 这些状态可能导致输入框被遮挡或交互异常（数十版本顽固 Bug 的根因之一）
  useEffect(() => {
    setDragOver(false);
    setCommandMenuVisible(false);
    setAutonomyMenuOpen(false);
  }, [currentConversationId]);

  // Phase 37：加载已启用的 Skill 列表和 MCP 工具列表
  useEffect(() => {
    const loadSkillsAndMcp = async () => {
      try {
        const [skills, mcpResult] = await Promise.all([
          window.routedev.skill.list(),
          window.routedev.mcp.tools(),
        ]);
        setEnabledSkills(skills.filter((s) => s.enabled));
        setMcpTools(mcpResult.tools);
      } catch (err) {
        console.error('加载 Skill/MCP 状态失败:', err);
      }
    };
    loadSkillsAndMcp();
    // 每 30 秒刷新一次（MCP 连接状态可能变化）
    const timer = setInterval(loadSkillsAndMcp, 30000);
    return () => clearInterval(timer);
  }, []);

  // 监听滚动位置，决定是否显示"跳到底部"按钮
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distFromBottom < 100;
    setShowScrollBottom(distFromBottom > 200);
  }, []);

  // 跳到底部
  const jumpToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);

  // 输入变化时重置命令选择索引
  useEffect(() => {
    setCommandIndex(0);
  }, [input]);

  // 引擎处理完成后，自动发送队列中的下一条消息
  const prevProcessingRef = useRef(isProcessing);
  useEffect(() => {
    // 从 processing 变为非 processing 时，发送队列第一条
    if (prevProcessingRef.current && !isProcessing && queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      // 延迟发送，避免引擎状态切换竞争
      setTimeout(() => sendMessage(next), 100);
    }
    prevProcessingRef.current = isProcessing;
  }, [isProcessing, queue, sendMessage]);

  // 从 tokenSnapshots 获取最新快照
  const latestSnapshot = tokenSnapshots[tokenSnapshots.length - 1];
  const latestTier = latestSnapshot?.routeDecision;
  const tokenUsage = latestSnapshot?.totalEstimated ?? 0;
  const autonomyMode = config?.autonomy?.defaultMode;

  // 命令补全：过滤匹配的命令
  const filteredCommands = useMemo(
    () => STATIC_COMMANDS.filter((cmd) => cmd.startsWith(input)),
    [input],
  );
  const showCommands =
    commandMenuVisible &&
    !isComposing && // Phase 54 修复：IME 组合期间不显示命令菜单
    input.startsWith('/') &&
    !input.includes(' ') &&
    filteredCommands.length > 0;
  // Phase 54 修复：showCommands 为 true 时，计算 textarea 位置，用 Portal 渲染菜单到 body
  // 根因：命令菜单原用 absolute bottom-full 定位，但祖先容器有 overflow-hidden 会裁剪掉菜单
  // 用 Portal 渲染到 document.body 并用 fixed 定位，完全绕开祖先 overflow 限制
  useLayoutEffect(() => {
    if (showCommands && textareaRef.current) {
      const rect = textareaRef.current.getBoundingClientRect();
      setCommandMenuPos({ top: rect.top, left: rect.left });
    } else {
      setCommandMenuPos(null);
    }
  }, [showCommands]);
  const activeCommandIndex = Math.min(
    commandIndex,
    Math.max(0, filteredCommands.length - 1),
  );

  // 提交消息：引擎工作时进入队列，否则直接发送
  const handleSubmit = () => {
    if (!input.trim()) return;
    if (isProcessing) {
      // 引擎工作中：加入排队队列
      setQueue((prev) => [...prev, input]);
      setInput('');
      setQueueExpanded(true);
    } else {
      sendMessage(input);
      setInput('');
      // 发送后跳到底部
      isNearBottomRef.current = true;
      setTimeout(jumpToBottom, 50);
    }
  };

  // 自主度切换
  const handleAutonomyChange = async (mode: AutonomyMode) => {
    setAutonomyMenuOpen(false);
    if (!config || config.autonomy.defaultMode === mode) return;
    const newConfig: AppConfig = {
      ...config,
      autonomy: { ...config.autonomy, defaultMode: mode },
    };
    await saveConfig(newConfig);
  };

  // 拖动调整输入区高度
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startY = e.clientY;
    const startHeight = inputHeight;
    let nextHeight = startHeight;
    const onMove = (moveE: MouseEvent) => {
      const delta = startY - moveE.clientY;
      nextHeight = Math.max(140, Math.min(640, startHeight + delta));
      setInputHeight(nextHeight);
    };
    const onUp = () => {
      setIsResizing(false);
      localStorage.setItem('routedev-input-height-v2', String(nextHeight));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // 打开项目文件夹
  const handleOpenProjectFolder = async () => {
    if (currentProject?.path) {
      await window.routedev.fs.openFolder(currentProject.path);
    }
  };

  // 队列操作
  const removeQueueItem = (idx: number) => {
    setQueue((prev) => prev.filter((_, i) => i !== idx));
  };

  const startEditQueueItem = (idx: number) => {
    setEditingQueueIdx(idx);
    setEditingQueueValue(queue[idx]);
  };

  const confirmEditQueueItem = () => {
    if (editingQueueIdx === null) return;
    const trimmed = editingQueueValue.trim();
    setQueue((prev) => {
      const next = [...prev];
      if (trimmed) {
        next[editingQueueIdx] = trimmed;
      } else {
        next.splice(editingQueueIdx, 1);
      }
      return next;
    });
    setEditingQueueIdx(null);
    setEditingQueueValue('');
  };

  const selectCommand = (cmd: string) => {
    setInput(cmd + ' ');
    setCommandMenuVisible(false);
    textareaRef.current?.focus();
  };

  // 文件拖拽处理
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      const filePath = (file as File & { path?: string }).path;
      void filePath;
      if (file.type.startsWith('image/')) {
        setInput((prev) => {
          const prefix = prev && !prev.endsWith(' ') ? ' ' : '';
          return prev + prefix + `@${file.name}`;
        });
      }
    }
  };

  // 复制文本到剪贴板的 fallback 方案：当 navigator.clipboard 不可用时使用
  // 解决 Electron renderer 中安全上下文缺失或权限被拒导致复制失败的问题
  const fallbackCopy = useCallback((text: string) => {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!ok) {
        console.warn('[ChatPage] execCommand copy 返回 false，文本可能未复制');
      }
    } catch (err) {
      console.error('[ChatPage] fallback copy 失败:', err);
    }
  }, []);

  // 设置消息 ref 的回调
  const setMessageRef = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) {
      messageRefs.current.set(id, el);
    } else {
      messageRefs.current.delete(id);
    }
  }, []);

  // 关闭自主度菜单（点击外部）
  useEffect(() => {
    if (!autonomyMenuOpen) return;
    const close = () => setAutonomyMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [autonomyMenuOpen]);

  // 监听快捷键事件（由 useKeyboardShortcuts 通过 window 自定义事件派发）
  useEffect(() => {
    const focusInput = () => {
      const textarea = document.querySelector('textarea[data-chat-input]') as HTMLTextAreaElement | null;
      if (textarea) {
        textarea.focus();
      }
    };

    const stopGen = () => {
      stopGeneration();
    };

    window.addEventListener('routedev:focus-chat-input', focusInput);
    window.addEventListener('routedev:stop-generation', stopGen);

    return () => {
      window.removeEventListener('routedev:focus-chat-input', focusInput);
      window.removeEventListener('routedev:stop-generation', stopGen);
    };
  }, [stopGeneration]);

  return (
    <Card
      className="relative flex h-full flex-col overflow-hidden rounded-none border-0 bg-rd-surface p-0 shadow-none"
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 状态栏 */}
      <div className="flex h-14 shrink-0 items-center justify-between px-5">
        <div className="flex items-center gap-2 overflow-x-auto">
          {/* 当前项目名 + 打开文件夹按钮 */}
          {currentProject && (
            <Badge variant="default" className="shrink-0 gap-1.5">
              <span className="max-w-[120px] truncate">{currentProject.name}</span>
              {currentProject.path && (
                <button
                  onClick={handleOpenProjectFolder}
                  title={`打开: ${currentProject.path}`}
                  className="ml-0.5 flex h-5 w-5 items-center justify-center rounded hover:bg-rd-surfaceHighlight"
                >
                  <FolderOpen size={14} />
                </button>
              )}
            </Badge>
          )}
          {tokenUsage > 0 && (
            <Badge variant="primary" className="shrink-0">
              Tokens: {tokenUsage.toLocaleString()}
            </Badge>
          )}
        </div>
        {/* Phase 47 Task 6：检查点面板切换按钮 */}
        <button
          type="button"
          onClick={() => setShowCheckpointPanel(!showCheckpointPanel)}
          title={showCheckpointPanel ? '隐藏检查点面板' : '显示检查点面板'}
          className={[
            'flex h-8 w-8 items-center justify-center rounded-md transition',
            showCheckpointPanel
              ? 'bg-rd-primary/10 text-rd-primary'
              : 'text-rd-textSubtle hover:bg-rd-surfaceHover hover:text-rd-text',
          ].join(' ')}
        >
          <History size={16} />
        </button>
      </div>

      {/* 消息区 */}
      <div className="relative flex min-h-0 flex-1">
        {/* 消息列表 */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 space-y-2.5 overflow-y-auto px-5 py-4"
        >
          {messages.length === 0 ? (
            <div className="relative flex h-full items-start justify-center pt-[18%]">
              <NeuralNetworkBackground />
              <h1 className="relative z-10 select-none text-5xl font-black tracking-tight text-rd-primary/20">
                RouteDev
              </h1>
            </div>
          ) : (
            (() => {
              // 按 taskId 分组消息：有 taskId 的消息归入对应任务块，无 taskId 的独立渲染
              const groups: { taskId: string | null; msgs: ChatMessage[] }[] = [];
              for (const msg of messages) {
                const tid = msg.taskId ?? null;
                const last = groups[groups.length - 1];
                if (last && last.taskId === tid) {
                  last.msgs.push(msg);
                } else {
                  groups.push({ taskId: tid, msgs: [msg] });
                }
              }

              return groups.map((group) => {
                if (group.taskId) {
                  // 有 taskId 的消息：用 TaskBlock 渲染
                  return (
                    <TaskBlock
                      key={`task-${group.taskId}`}
                      taskMessages={group.msgs}
                      outputStyle={config?.ui?.outputStyle}
                      isProcessing={isProcessing}
                      messageRef={setMessageRef}
                      onCopy={(msg) => {
                        const text = msg.content || '';
                        if (!text) return;
                        if (navigator.clipboard && window.isSecureContext) {
                          navigator.clipboard.writeText(text).catch((err) => {
                            console.error('[ChatPage] clipboard API 失败，尝试 fallback:', err);
                            fallbackCopy(text);
                          });
                        } else {
                          fallbackCopy(text);
                        }
                      }}
                      onDelete={(msg) => {
                        if (confirm('确定删除该任务块？将一并删除提问、思考过程、工具调用与回复。')) {
                          deleteMessage(msg.id);
                        }
                      }}
                      onRetry={(msg) => {
                        if (confirm('重试将删除该消息及其后的所有消息，并重新发送。继续？')) {
                          retryMessage(msg.id);
                        }
                      }}
                      onFork={(msg) => {
                        if (!currentProjectId || !currentConversationId) return;
                        const newConvId = forkConversationFromMessage(
                          currentProjectId,
                          currentConversationId,
                          msg.id,
                        );
                        if (newConvId) {
                          // 分支创建后，App.tsx 的对话切换 useEffect 会自动加载新对话的消息
                        }
                      }}
                    />
                  );
                }
                // 无 taskId 的独立消息：保持原有渲染
                return group.msgs.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    messageRef={setMessageRef(msg.id)}
                    outputStyle={config?.ui?.outputStyle}
                    disabled={isProcessing}
                    onCopy={() => {
                      const text = msg.content || '';
                      if (!text) return;
                      if (navigator.clipboard && window.isSecureContext) {
                        navigator.clipboard.writeText(text).catch((err) => {
                          console.error('[ChatPage] clipboard API 失败，尝试 fallback:', err);
                          fallbackCopy(text);
                        });
                      } else {
                        fallbackCopy(text);
                      }
                    }}
                    onDelete={() => {
                      if (confirm('确定删除该消息？删除后下次对话不会注入此消息作为上下文。')) {
                        deleteMessage(msg.id);
                      }
                    }}
                    onRetry={() => {
                      if (confirm('重试将删除该消息及其后的所有消息，并重新发送。继续？')) {
                        retryMessage(msg.id);
                      }
                    }}
                    onFork={() => {
                      if (!currentProjectId || !currentConversationId) return;
                      const newConvId = forkConversationFromMessage(
                        currentProjectId,
                        currentConversationId,
                        msg.id,
                      );
                      if (newConvId) {
                        // 分支创建后，App.tsx 的对话切换 useEffect 会自动加载新对话的消息
                      }
                    }}
                  />
                ));
              });
            })()
          )}
        </div>

        {/* 跳到底部按钮 */}
        {showScrollBottom && (
          <button
            onClick={jumpToBottom}
            title="跳到底部"
            className={[
              'absolute bottom-4 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-rd-border bg-rd-background text-rd-textMuted shadow-rdMd transition hover:text-rd-primary hover:border-rd-primary/30',
              showCheckpointPanel ? 'right-[21rem]' : 'right-6',
            ].join(' ')}
          >
            <ArrowDown size={16} />
          </button>
        )}

        {/* Phase 47 Task 6：检查点时间轴面板（右侧可折叠） */}
        {showCheckpointPanel && (
          <div className="relative flex w-80 shrink-0 flex-col border-l border-rd-border bg-rd-surface">
            <CheckpointTimeline projectId={currentProjectId ?? undefined} />
          </div>
        )}
      </div>

      {/* 拖拽提示遮罩 */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-rd-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-rd-primary">
            <UploadCloud size={48} />
            <p className="text-lg font-medium">松开以添加文件</p>
          </div>
        </div>
      )}

      {/* 工具确认弹窗 */}
      {pendingConfirm && <ToolConfirmDialog pending={pendingConfirm} onConfirm={confirmTool} />}

      {/* Phase 54：计划编辑器（semi/manual 模式触发，用户审查/修改 /goal 步骤） */}
      <StepEditor />

      {/* 排队队列显示（引擎工作时） */}
      {queue.length > 0 && (
        <div className="bg-rd-surface/50">
          <button
            onClick={() => setQueueExpanded(!queueExpanded)}
            className="flex w-full items-center gap-2 px-4 py-1.5 text-xs text-rd-textMuted transition hover:bg-rd-surfaceHover"
          >
            <Clock size={12} className="text-rd-primary" />
            <span>排队队列: {queue.length} 条消息</span>
            <ChevronDown size={12} className={['transition-transform', queueExpanded ? 'rotate-180' : ''].join(' ')} />
          </button>
          {queueExpanded && (
            <div className="max-h-40 overflow-y-auto px-4 pb-2">
              {queue.map((item, idx) => (
                <div key={idx} className="mb-1 flex items-start gap-2 rounded border border-rd-border bg-rd-background px-2 py-1.5">
                  <span className="mt-0.5 text-xs font-medium text-rd-textSubtle">#{idx + 1}</span>
                  {editingQueueIdx === idx ? (
                    <input
                      autoFocus
                      value={editingQueueValue}
                      onChange={(e) => setEditingQueueValue(e.target.value)}
                      onBlur={confirmEditQueueItem}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') confirmEditQueueItem();
                        if (e.key === 'Escape') setEditingQueueIdx(null);
                      }}
                      className="min-w-0 flex-1 rounded border border-rd-primary bg-rd-background px-1 py-0.5 text-xs text-rd-text outline-none"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-xs text-rd-text">{item}</span>
                  )}
                  {editingQueueIdx !== idx && (
                    <>
                      <button
                        onClick={() => startEditQueueItem(idx)}
                        title="编辑"
                        className="flex h-4 w-4 items-center justify-center text-rd-textSubtle hover:text-rd-primary"
                      >
                        <Edit3 size={11} />
                      </button>
                      <button
                        onClick={() => removeQueueItem(idx)}
                        title="移除"
                        className="flex h-4 w-4 items-center justify-center text-rd-textSubtle hover:text-rd-danger"
                      >
                        <X size={11} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="bg-rd-surfaceHover" style={{ height: inputHeight }}>
        <div
          onMouseDown={handleResizeStart}
          className={[
            'flex h-2 cursor-row-resize items-center justify-center transition',
            isResizing ? 'bg-rd-primary/20' : 'bg-transparent hover:bg-rd-surfaceHover',
          ].join(' ')}
          title="拖动调整输入区高度"
        >
          <div className="h-0.5 w-12 rounded-full bg-rd-textSubtle/35" />
        </div>
        <div className="flex h-[calc(100%-8px)] p-4 pt-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
            className="flex h-full w-full flex-col overflow-hidden rounded-rdLg border border-rd-border bg-rd-surface shadow-rd transition"
          >
            {/* Phase 37：Skill/MCP 状态栏——显示已启用的 Skill 和已连接的 MCP 工具 */}
            {showSkillBar && (enabledSkills.length > 0 || mcpTools.length > 0) && (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-rd-border/50 px-4 py-2">
                {enabledSkills.length > 0 && (
                  <>
                    <span className="flex items-center gap-1 text-xs font-medium text-rd-textSubtle">
                      <BookOpen size={12} /> Skill:
                    </span>
                    {enabledSkills.map((s) => (
                      <span
                        key={s.name}
                        className="rounded-md bg-rd-primary/10 px-2 py-0.5 text-xs text-rd-primary"
                        title={s.description}
                      >
                        {s.name}
                      </span>
                    ))}
                  </>
                )}
                {mcpTools.length > 0 && (
                  <>
                    <span className="flex items-center gap-1 text-xs font-medium text-rd-textSubtle ml-2">
                      <Plug size={12} /> MCP:
                    </span>
                    {mcpTools.slice(0, 6).map((t) => (
                      <span
                        key={t.name}
                        className="rounded-md bg-rd-surfaceHover px-2 py-0.5 text-xs text-rd-textSubtle"
                        title={t.description}
                      >
                        {t.name.replace('mcp__', '').replace('__', '.')}
                      </span>
                    ))}
                    {mcpTools.length > 6 && (
                      <span className="text-xs text-rd-textSubtle">+{mcpTools.length - 6}</span>
                    )}
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setShowSkillBar(false)}
                  className="ml-auto text-rd-textSubtle hover:text-rd-text"
                  title="隐藏状态栏"
                >
                  <X size={12} />
                </button>
              </div>
            )}
            <div className="relative min-h-0 flex-1">
            {showCommands && commandMenuPos && createPortal(
              <Card
                className="fixed z-[9999] mb-2 w-72 overflow-hidden border-rd-border/80 bg-rd-background p-1 shadow-rdLg"
                style={{ top: commandMenuPos.top - 8, left: commandMenuPos.left, transform: 'translateY(-100%)' }}
              >
                {filteredCommands.map((cmd, idx) => (
                  <Button
                    key={cmd}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => selectCommand(cmd)}
                    className={[
                      'flex w-full items-center justify-start gap-2 px-3 py-2 text-left text-sm',
                      idx === activeCommandIndex
                        ? 'bg-rd-primary/10 text-rd-primary'
                        : 'text-rd-text',
                    ].join(' ')}
                  >
                    <span className="font-mono">{cmd}</span>
                    <span className="ml-auto text-xs text-rd-textMuted">
                      {COMMAND_DESCRIPTIONS[cmd]}
                    </span>
                  </Button>
                ))}
              </Card>,
              document.body,
            )}
            <Textarea
              ref={textareaRef}
              data-chat-input
              value={input}
              // 防御性点击处理：确保点击输入框时立即聚焦，避免焦点被其他元素劫持
              // 这是"新建对话后输入框不可点击"顽固 Bug 的防御性修复
              onMouseDown={(e) => {
                // 允许默认聚焦行为，但确保 textarea 获得焦点
                if (document.activeElement !== e.currentTarget) {
                  e.currentTarget.focus();
                }
              }}
              onChange={(e) => {
                setInput(e.target.value);
                setCommandMenuVisible(true);
              }}
              onCompositionStart={() => {
                setIsComposing(true);
              }}
              onCompositionEnd={(e) => {
                setIsComposing(false);
                // compositionEnd 后手动同步输入框当前值（IME 最终输出）
                const v = (e.target as HTMLTextAreaElement).value;
                setInput(v);
                setCommandMenuVisible(true);
              }}
              onKeyDown={(e) => {
                if (showCommands) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCommandIndex((prev) => (prev + 1) % filteredCommands.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCommandIndex(
                      (prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length,
                    );
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    selectCommand(filteredCommands[activeCommandIndex]);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setCommandMenuVisible(false);
                    return;
                  }
                } else {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }
              }}
              placeholder={isProcessing ? '输入下一条消息（Enter 加入排队队列）... Shift+Enter 换行' : '输入问题或拖拽图片开始... Shift+Enter 换行，输入 / 查看命令'}
              rows={6}
              className="h-full min-h-0 resize-none border-0 bg-transparent px-4 py-4 text-base leading-7 shadow-none focus-visible:ring-0"
            />
            </div>
            <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                {autonomyMode && (
                  <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setAutonomyMenuOpen(!autonomyMenuOpen)}
                      title={`自主度: ${AUTONOMY_LABELS[autonomyMode]}`}
                    >
                      <Zap size={14} />
                      <span>{AUTONOMY_LABELS[autonomyMode]}</span>
                      <ChevronDown size={14} />
                    </Button>
                    {autonomyMenuOpen && (
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-44 overflow-hidden rounded-xl border border-rd-border bg-rd-background p-1 shadow-rdLg">
                        <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-rd-textSubtle">自主度</div>
                        {(Object.keys(AUTONOMY_LABELS) as AutonomyMode[]).map((mode) => (
                          <button
                            type="button"
                            key={mode}
                            onClick={() => handleAutonomyChange(mode)}
                            className={[
                              'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition',
                              autonomyMode === mode ? 'bg-rd-primary/10 font-semibold text-rd-primary' : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
                            ].join(' ')}
                          >
                            <span>{AUTONOMY_LABELS[mode]}</span>
                            {autonomyMode === mode && <span>✓</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <span className="truncate text-xs text-rd-textSubtle">Enter 发送 · Shift+Enter 换行 · 输入 / 查看命令</span>
              </div>
              {isProcessing ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={stopGeneration}
                  title="停止生成"
                  className="h-11 gap-2 rounded-rdLg px-5"
                >
                  <Square size={16} fill="currentColor" />
                  停止
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={!input.trim()}
                  className="h-11 gap-2 rounded-rdLg px-5"
                >
                  <Send size={16} />
                  发送
                </Button>
              )}
            </div>
          </form>
        </div>
      </div>
    </Card>
  );
}
