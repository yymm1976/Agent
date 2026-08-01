// desktop/renderer/src/components/chat/MessageList.tsx
// 消息列表：按 taskId 分组渲染 TaskBlock + 独立消息 MessageBubble
// 封装消息回调（复制/删除/重试/分叉）+ ref 管理 + fallback 复制
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致
// Phase 74-D：在 fork 点（有分支派生的消息）上方内联渲染 BranchSwitcher

import { useRef, useCallback, useMemo, memo, useState } from 'react';
import { History } from 'lucide-react';
import type { ChatMessage } from '../../store/useRouteDevStore.js';
import type { Conversation } from '../../store/useProjectsStore.js';
import type { OutputStyle } from '../ToolCallCard.js';
import { TaskBlock } from './TaskBlock.js';
import { MessageBubble } from './MessageBubble.js';
import { BranchSwitcher } from './BranchSwitcher.js';
import { ConfirmDialog } from '../ui/dialog.js';
import { Button } from '../ui/button.js';
import { TurnRollbackDialog } from './TurnRollbackDialog.js';

function MessageListImpl({
  messages,
  isProcessing,
  outputStyle,
  conversations,
  onSwitchBranch,
  deleteMessage,
  retryMessage,
  currentProjectId,
  currentConversationId,
  forkConversationFromMessage,
}: {
  messages: ChatMessage[];
  isProcessing: boolean;
  outputStyle?: OutputStyle;
  /** Phase 74-D：同项目所有对话（用于查询 fork 点 + 构建分支组） */
  conversations: Conversation[];
  /** Phase 74-D：切换到目标分支对话 */
  onSwitchBranch: (targetConvId: string) => void;
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

  // 确认对话框状态（替代原生 confirm()，避免 frame:false 窗口失焦 bug）
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    variant: 'default' | 'danger';
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', variant: 'default', onConfirm: () => {} });

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
      if (!ok) {
        // eslint-disable-next-line no-console -- 渲染层日志，logger 为 Node-only 模块无法在浏览器导入
        console.warn('[ChatPage] execCommand copy 返回 false，文本可能未复制');
      }
    } catch (err) {
      // eslint-disable-next-line no-console -- 渲染层日志，logger 为 Node-only 模块无法在浏览器导入
      console.error('[ChatPage] fallback copy 失败:', err);
    }
  }, []);

  // 消息回调
  const handleCopy = useCallback((msg: ChatMessage) => {
    const text = msg.content || '';
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch((err) => {
        // eslint-disable-next-line no-console -- 渲染层日志，logger 为 Node-only 模块无法在浏览器导入
        console.error('[ChatPage] clipboard API 失败，尝试 fallback:', err);
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }, [fallbackCopy]);

  const handleTaskDelete = useCallback((msg: ChatMessage) => {
    setConfirmState({
      open: true,
      title: '删除任务块',
      message: '确定删除该任务块？将一并删除提问、思考过程、工具调用与回复。',
      variant: 'danger',
      onConfirm: () => {
        deleteMessage(msg.id);
        setConfirmState((s) => ({ ...s, open: false }));
      },
    });
  }, [deleteMessage]);

  const handleMsgDelete = useCallback((msg: ChatMessage) => {
    setConfirmState({
      open: true,
      title: '删除消息',
      message: '确定删除该消息？删除后下次对话不会注入此消息作为上下文。',
      variant: 'danger',
      onConfirm: () => {
        deleteMessage(msg.id);
        setConfirmState((s) => ({ ...s, open: false }));
      },
    });
  }, [deleteMessage]);

  const handleRetry = useCallback((msg: ChatMessage) => {
    setConfirmState({
      open: true,
      title: '重试消息',
      message: '重试将删除该消息及其后的所有消息，并重新发送。继续？',
      variant: 'default',
      onConfirm: () => {
        retryMessage(msg.id);
        setConfirmState((s) => ({ ...s, open: false }));
      },
    });
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

  // Phase 97 Part B：对话回滚入口（TurnSnapshotManager 已每 turn capture，renderer 侧仅入口）
  const [rollbackOpen, setRollbackOpen] = useState(false);

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

  // Phase 74-D：fork 点分支组构建
  // 对给定消息 ID，返回从该消息 fork 出去的所有分支（含当前对话自身）
  // 仅当当前对话是源对话（非 fork 产物）且该消息有 fork 产物时返回分支组
  const getBranchGroup = useCallback((msgId: string): {
    branches: Conversation[];
    currentBranch: number;
    branchTitles: string[];
  } | null => {
    if (!currentConversationId) return null;
    const currentConv = conversations.find((c) => c.id === currentConversationId);
    if (!currentConv) return null;
    // 当前对话是 fork 产物时不显示切换器（fork 产物中消息 ID 已重新生成，无法定位 fork 点）
    if (currentConv.forkedFrom) return null;
    // 找到所有从当前对话的这条消息 fork 出去的对话
    const forkedConvs = conversations.filter(
      (c) => c.forkedFrom?.convId === currentConversationId && c.forkedFrom?.upToMessageId === msgId,
    );
    if (forkedConvs.length === 0) return null;
    // 分支组 = [当前对话（源）] + [fork 产物们]，按 createdAt 排序
    const branches = [currentConv, ...forkedConvs].sort((a, b) => a.createdAt - b.createdAt);
    const currentBranch = branches.findIndex((c) => c.id === currentConversationId);
    const branchTitles = branches.map((c) => c.title);
    return { branches, currentBranch, branchTitles };
  }, [conversations, currentConversationId]);

  // Phase 74-D：分支切换——根据方向找到目标分支对话
  const handleSwitchBranch = useCallback((direction: 'prev' | 'next', msgId: string) => {
    const group = getBranchGroup(msgId);
    if (!group) return;
    const { branches, currentBranch } = group;
    const targetIdx = direction === 'prev' ? currentBranch - 1 : currentBranch + 1;
    if (targetIdx < 0 || targetIdx >= branches.length) return;
    onSwitchBranch(branches[targetIdx].id);
  }, [getBranchGroup, onSwitchBranch]);

  return (
    <>
      {/* Phase 97 Part B：消息列表工具条——对话回滚入口 */}
      {messages.length > 0 && (
        <div className="mb-2 flex items-center justify-between border-b border-rd-border pb-2">
          <span className="text-xs text-rd-textMuted">{messages.length} 条消息</span>
          <Button variant="outline" size="sm" onClick={() => setRollbackOpen(true)}>
            <History size={14} className="mr-1" />
            回滚
          </Button>
        </div>
      )}
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
        return group.msgs.map((msg) => {
          // Phase 74-D：检查该消息是否是 fork 点（有分支派生）
          const branchGroup = getBranchGroup(msg.id);
          return (
          <div key={msg.id}>
            {branchGroup && branchGroup.branches.length > 1 && (
              <div className="my-1 flex justify-center">
                <BranchSwitcher
                  branches={branchGroup.branches.length}
                  currentBranch={branchGroup.currentBranch}
                  onSwitch={(dir) => handleSwitchBranch(dir, msg.id)}
                  branchTitles={branchGroup.branchTitles}
                />
              </div>
            )}
            <MessageBubble
              message={msg}
              messageRef={setMessageRef(msg.id)}
              outputStyle={outputStyle}
              disabled={isProcessing}
              onCopy={() => handleCopy(msg)}
              onDelete={() => handleMsgDelete(msg)}
              onRetry={() => handleRetry(msg)}
              onFork={() => handleFork(msg)}
            />
          </div>
          );
        });
      })}

      {/* 确认对话框（替代原生 confirm()，避免 frame:false 窗口失焦 bug） */}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        variant={confirmState.variant}
        confirmText="确认"
        cancelText="取消"
        onConfirm={confirmState.onConfirm}
        onCancel={() => setConfirmState((s) => ({ ...s, open: false }))}
      />

      {/* Phase 97 Part B：对话回滚对话框 */}
      <TurnRollbackDialog open={rollbackOpen} onClose={() => setRollbackOpen(false)} />
    </>
  );
}

// F-035：用 React.memo 包装，避免父组件每次渲染都触发 MessageList 重渲染
export const MessageList = memo(MessageListImpl);
