// desktop/renderer/src/components/chat/MessageList.tsx
// 消息列表：按 taskId 分组渲染 TaskBlock + 独立消息 MessageBubble
// 封装消息回调（复制/删除/重试/分叉）+ ref 管理 + fallback 复制
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致

import { useRef, useCallback, useMemo } from 'react';
import type { ChatMessage } from '../../store/useRouteDevStore.js';
import type { OutputStyle } from '../ToolCallCard.js';
import { TaskBlock } from './TaskBlock.js';
import { MessageBubble } from './MessageBubble.js';

export function MessageList({
  messages,
  isProcessing,
  outputStyle,
  deleteMessage,
  retryMessage,
  currentProjectId,
  currentConversationId,
  forkConversationFromMessage,
}: {
  messages: ChatMessage[];
  isProcessing: boolean;
  outputStyle?: OutputStyle;
  deleteMessage: (messageId: string) => void;
  retryMessage: (messageId: string) => void;
  currentProjectId: string | null;
  currentConversationId: string | null;
  forkConversationFromMessage: (
    sourceProjectId: string,
    sourceConvId: string,
    upToMessageId: string,
    targetProjectId?: string,
  ) => string;
}) {
  // 消息 ID -> DOM 元素映射，用于跳转
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // 复制文本到剪贴板的 fallback 方案：当 navigator.clipboard 不可用时使用
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
      if (!ok) console.warn('[ChatPage] execCommand copy 返回 false，文本可能未复制');
    } catch (err) {
      console.error('[ChatPage] fallback copy 失败:', err);
    }
  }, []);

  // 消息回调
  const handleCopy = useCallback((msg: ChatMessage) => {
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
  }, [fallbackCopy]);

  const handleTaskDelete = useCallback((msg: ChatMessage) => {
    if (confirm('确定删除该任务块？将一并删除提问、思考过程、工具调用与回复。')) {
      deleteMessage(msg.id);
    }
  }, [deleteMessage]);

  const handleMsgDelete = useCallback((msg: ChatMessage) => {
    if (confirm('确定删除该消息？删除后下次对话不会注入此消息作为上下文。')) {
      deleteMessage(msg.id);
    }
  }, [deleteMessage]);

  const handleRetry = useCallback((msg: ChatMessage) => {
    if (confirm('重试将删除该消息及其后的所有消息，并重新发送。继续？')) {
      retryMessage(msg.id);
    }
  }, [retryMessage]);

  const handleFork = useCallback((msg: ChatMessage) => {
    if (!currentProjectId || !currentConversationId) return;
    forkConversationFromMessage(currentProjectId, currentConversationId, msg.id);
  }, [currentProjectId, currentConversationId, forkConversationFromMessage]);

  // 设置消息 ref 的回调
  const setMessageRef = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) messageRefs.current.set(id, el);
    else messageRefs.current.delete(id);
  }, []);

  // 按 taskId 分组消息：有 taskId 的消息归入对应任务块，无 taskId 的独立渲染
  const messageGroups = useMemo(() => {
    const groups: { taskId: string | null; msgs: ChatMessage[] }[] = [];
    for (const msg of messages) {
      const tid = msg.taskId ?? null;
      const last = groups[groups.length - 1];
      if (last && last.taskId === tid) last.msgs.push(msg);
      else groups.push({ taskId: tid, msgs: [msg] });
    }
    return groups;
  }, [messages]);

  return (
    <>
      {messageGroups.map((group) => {
        if (group.taskId) {
          // 有 taskId 的消息：用 TaskBlock 渲染
          return (
            <TaskBlock
              key={`task-${group.taskId}`}
              taskMessages={group.msgs}
              outputStyle={outputStyle}
              isProcessing={isProcessing}
              messageRef={setMessageRef}
              onCopy={handleCopy}
              onDelete={handleTaskDelete}
              onRetry={handleRetry}
              onFork={handleFork}
            />
          );
        }
        // 无 taskId 的独立消息：保持原有渲染
        return group.msgs.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            messageRef={setMessageRef(msg.id)}
            outputStyle={outputStyle}
            disabled={isProcessing}
            onCopy={() => handleCopy(msg)}
            onDelete={() => handleMsgDelete(msg)}
            onRetry={() => handleRetry(msg)}
            onFork={() => handleFork(msg)}
          />
        ));
      })}
    </>
  );
}
