// desktop/renderer/src/components/chat/TaskBlock.tsx
// 任务块：一次 sendMessage 产生的所有消息（user + tool calls + assistant）归为一组
// - 任务完成后默认折叠为一行"任务耗时：X秒"
// - 展开后：用户消息 → 工具调用组（按工具名分组）→ assistant 回复
// - 任务进行中时展开显示，工具调用区域限制最大高度避免连成一大坨
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致
// C-V1：虚拟滚动兼容——onVisible 回调 + 固定可测量高度结构，为 @tanstack/virtual 预留

import { useMemo, useRef, useEffect, memo } from 'react';
import type { ChatMessage } from '../../store/useRouteDevStore.js';
import type { OutputStyle, ToolCallItem } from '../ToolCallCard.js';
import { ExecutionProcess, parseReasoningSteps } from './ExecutionProcess.js';
import { MessageBubble } from './MessageBubble.js';

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
    <div ref={containerRef} className="space-y-2">
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
