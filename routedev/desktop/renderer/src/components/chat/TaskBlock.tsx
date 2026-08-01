// desktop/renderer/src/components/chat/TaskBlock.tsx
// 任务块：一次 sendMessage 产生的所有消息（user + tool calls + assistant）归为一组
// - 任务完成后默认折叠为一行"任务耗时：X秒"
// - 展开后：用户消息 → 工具调用组（按工具名分组）→ assistant 回复
// - 任务进行中时展开显示，工具调用区域限制最大高度避免连成一大坨
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致
// C-V1：虚拟滚动兼容——onVisible 回调 + 固定可测量高度结构，为 @tanstack/virtual 预留

import { useMemo, useRef, useEffect, useState, memo } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  XCircle,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  FileCode2,
  ExternalLink,
} from 'lucide-react';
import type { ChatMessage } from '../../store/useRouteDevStore.js';
import type { CompletionStatus } from '../../../../shared/ipc-types.js';
import type { OutputStyle, ToolCallItem } from '../ToolCallCard.js';
import { ExecutionProcess, parseReasoningSteps } from './ExecutionProcess.js';
import { MessageBubble } from './MessageBubble.js';

// Phase 91：完成状态标签——仅本轮发生代码修改时显示，避免普通问答噪音
const COMPLETION_STATUS_META: Record<CompletionStatus, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  completed_verified: { label: '已验证', icon: CheckCircle2, cls: 'text-rd-success' },
  completed_with_warnings: { label: '验证有警告', icon: AlertCircle, cls: 'text-rd-warning' },
  completed_unverified: { label: '未验证', icon: HelpCircle, cls: 'text-rd-textSubtle' },
  verification_failed: { label: '验证失败', icon: XCircle, cls: 'text-rd-danger' },
  execution_failed: { label: '执行失败', icon: XCircle, cls: 'text-rd-danger' },
  cancelled: { label: '已取消', icon: XCircle, cls: 'text-rd-textSubtle' },
  blocked: { label: '阻塞', icon: AlertCircle, cls: 'text-rd-warning' },
  recovery_available: { label: '可恢复', icon: AlertCircle, cls: 'text-rd-warning' },
};

function CompletionStatusBadge({ status }: { status: CompletionStatus }) {
  const meta = COMPLETION_STATUS_META[status];
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <div className={`flex items-center gap-1 px-1 py-0.5 text-xs ${meta.cls}`}>
      <Icon size={12} />
      <span>{meta.label}</span>
    </div>
  );
}

interface TaskArtifact {
  path: string;
  name: string;
  version: number;
}

function extractTaskArtifacts(messages: ChatMessage[]): TaskArtifact[] {
  const artifacts = new Map<string, TaskArtifact>();
  for (const message of messages) {
    if (
      message.role !== 'system'
      || message.toolStatus !== 'completed'
      || !['file_write', 'file_edit'].includes(message.toolName ?? '')
      || !message.toolArgs
    ) {
      continue;
    }

    const path = ['filePath', 'path', 'file', 'filename', 'outputPath']
      .map((key) => message.toolArgs?.[key])
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (!path) continue;

    const existing = artifacts.get(path);
    artifacts.set(path, {
      path,
      name: path.split(/[\\/]/).pop() || path,
      version: (existing?.version ?? 0) + 1,
    });
  }
  return [...artifacts.values()];
}

function TaskArtifacts({ messages }: { messages: ChatMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const artifacts = useMemo(() => extractTaskArtifacts(messages), [messages]);
  if (artifacts.length === 0) return null;

  return (
    <section className="rounded-xl bg-rd-surface/55 px-3 py-2.5" aria-label="本轮产物">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-sm text-rd-text transition-colors hover:text-rd-accent"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <FileCode2 size={15} className="text-rd-accent" />
        <span className="font-medium">{artifacts.length} 个文件已更改</span>
        <span className="ml-auto text-rd-text-muted">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          {artifacts.map((artifact) => (
            <button
              key={artifact.path}
              type="button"
              className="group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-rd-surface-hover"
              onClick={() => window.routedev.fs.openFolder(artifact.path)}
              title={artifact.path}
            >
              <FileCode2 size={14} className="shrink-0 text-rd-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-rd-text">{artifact.name}</span>
                <span className="block truncate text-xs text-rd-text-muted">{artifact.path}</span>
              </span>
              {artifact.version > 1 && (
                <span className="rounded-md bg-rd-background/70 px-1.5 py-0.5 text-[11px] text-rd-text-muted">
                  ×{artifact.version}
                </span>
              )}
              <ExternalLink size={13} className="shrink-0 text-rd-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export const TaskBlock = memo(function TaskBlock({
  taskMessages,
  outputStyle,
  isProcessing,
  onCopy,
  onDelete,
  onRetry,
  onFork,
  messageRef,
  onVisible,
}: {
  taskMessages: ChatMessage[];
  outputStyle?: OutputStyle;
  isProcessing: boolean;
  onCopy?: (msg: ChatMessage) => void;
  onDelete?: (msg: ChatMessage) => void;
  onRetry?: (msg: ChatMessage) => void;
  onFork?: (msg: ChatMessage) => void;
  messageRef?: (id: string) => (el: HTMLDivElement | null) => void;
  /**
   * C-V1：虚拟滚动兼容回调
   * 当 TaskBlock 可见性变化时通知父组件（IntersectionObserver 驱动）
   * 为后续引入 @tanstack/virtual 预留，当前未实际接入
   */
  onVisible?: (isVisible: boolean) => void;
}) {
  // C-V1：可见性观察 ref——配合 onVisible 回调，为虚拟滚动预留接口
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onVisible || !containerRef.current) return;
    const el = containerRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          onVisible(entry.isIntersecting);
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible]);

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
        // Phase 96 P1-1：透传流式增量输出缓冲
        deltaBuffer: m.toolDeltaBuffer,
      });
    }
    return groups;
  }, [toolMsgs]);

  // 最新 assistant 消息（流式输出中）
  const latestAssistant = assistantMsgs[assistantMsgs.length - 1];
  const hasAssistantContent = latestAssistant && (latestAssistant.content || latestAssistant.isStreaming);
  const reasoningText = assistantMsgs.map((m) => m.reasoning).filter(Boolean).join('\n\n');

  // 中间自言自语：从 latestAssistant 读取（_addToolStart 时封存的文本块）
  const intermediateThoughts = latestAssistant?.intermediateThoughts ?? [];
  const progressEvents = latestAssistant?.progressEvents ?? [];

  // Phase 91：本轮发生代码修改时显示完成状态——避免普通问答噪音
  const hasFileEdit = toolMsgs.some(m => m.toolName === 'file_write' || m.toolName === 'file_edit');
  const completionStatus = hasFileEdit && isCompleted && latestAssistant?.completionStatus
    ? latestAssistant.completionStatus
    : null;

  // 思考步骤：从 reasoningText 解析
  const thinkingSteps = useMemo(
    () => parseReasoningSteps(reasoningText, isRunning),
    [reasoningText, isRunning],
  );
  // 始终显示：用户消息 → 执行过程 → assistant 回复
  return (
    <div ref={containerRef} className="space-y-4">
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
        intermediateThoughts={intermediateThoughts}
        progressEvents={progressEvents}
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
          {completionStatus && <CompletionStatusBadge status={completionStatus} />}
        </>
      )}

      {isCompleted && <TaskArtifacts messages={toolMsgs} />}
    </div>
  );
}, (prevProps, nextProps) => {
  // 自定义比较：浅比较关键字段，避免引用类型 props 导致不必要重渲染
  return (
    prevProps.isProcessing === nextProps.isProcessing &&
    prevProps.outputStyle === nextProps.outputStyle &&
    prevProps.taskMessages === nextProps.taskMessages &&
    prevProps.taskMessages.length === nextProps.taskMessages.length &&
    prevProps.onCopy === nextProps.onCopy &&
    prevProps.onDelete === nextProps.onDelete &&
    prevProps.onRetry === nextProps.onRetry &&
    prevProps.onFork === nextProps.onFork &&
    prevProps.messageRef === nextProps.messageRef &&
    prevProps.onVisible === nextProps.onVisible
  );
});
