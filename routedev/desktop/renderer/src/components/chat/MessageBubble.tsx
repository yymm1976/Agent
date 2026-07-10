// desktop/renderer/src/components/chat/MessageBubble.tsx
// 用户/助手消息气泡：Markdown 渲染、工具调用卡片、Goal 卡片、操作按钮
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致

import { useState, useEffect, useCallback, memo } from 'react';
import {
  Sparkles, Wrench, Copy, Trash2, RefreshCw, GitFork, Check,
} from 'lucide-react';
import type { ChatMessage } from '../../store/useRouteDevStore.js';
import type { OutputStyle } from '../ToolCallCard.js';
import type { PlanStep } from '../../../../../src/agent/plan-diff.js';
import type { OmissionResult } from '../../../../../src/agent/omission-checker.js';
import { MarkdownRenderer } from '../MarkdownRenderer.js';
import { ToolCallCard } from '../ToolCallCard.js';
import { GoalExecutionCard } from '../GoalExecutionCard.js';
import { useRouteDevStore } from '../../store/useRouteDevStore.js';

/** Phase 54：Goal marker 消息渲染——从 store 订阅对应 GoalExecution，用 GoalExecutionCard 展示 */
function GoalMessageBubble({ goalId }: { goalId: string }) {
  // C-V2：细粒度 selector——仅订阅当前 goalId 对应的 GoalExecution，避免全量 goalExecutions 变化触发重渲染
  const execution = useRouteDevStore(state =>
    state.goalExecutions.find(g => g.goalId === goalId),
  );
  // Phase 71：加载 plan 修订历史 + 提供遗漏点检查回调
  // PlanRevision 与 GoalExecutionCard 内部 interface PlanRevision 结构一致
  type LocalPlanRevision = { before: PlanStep[]; after: PlanStep[]; revisedAt: string };
  const [planRevisions, setPlanRevisions] = useState<LocalPlanRevision[]>([]);
  useEffect(() => {
    // 异步加载修订历史，fail-open（无历史则空数组）
    let cancelled = false;
    window.routedev?.plan?.getRevisions?.(goalId).then((res: { ok: boolean; revisions?: unknown[] }) => {
      if (cancelled || !res?.ok || !Array.isArray(res.revisions)) return;
      // 服务端返回 JSON 解析结果，结构信任 + cast（fail-open：非法结构会被 GoalExecutionCard 忽略）
      setPlanRevisions(res.revisions as LocalPlanRevision[]);
    }).catch(e => console.warn('[MessageBubble] planRevisions 加载失败:', e));
    return () => { cancelled = true; };
  }, [goalId]);

  const handleCheckOmissions = useCallback(async (): Promise<OmissionResult> => {
    const res = await window.routedev?.plan?.checkOmissions?.(goalId);
    if (!res?.ok) return { omissions: [], summary: '检查失败' };
    // 服务端返回 OmissionResult 形状（结构信任 + cast）
    return (res.result ?? { omissions: [], summary: '检查未执行' }) as OmissionResult;
  }, [goalId]);

  if (!execution) {
    return <div className="text-xs text-rd-textMuted px-1 py-2">目标执行中…</div>;
  }
  return (
    <GoalExecutionCard
      execution={execution}
      planRevisions={planRevisions.length > 0 ? planRevisions : undefined}
      onCheckOmissions={handleCheckOmissions}
    />
  );
}

const MessageBubble = memo(function MessageBubble({
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
});

export { MessageBubble };
