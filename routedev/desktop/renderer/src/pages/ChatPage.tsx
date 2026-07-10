// desktop/renderer/src/pages/ChatPage.tsx
// 对话页面：布局编排 + 状态注入
// Phase 74-C：子组件已抽离到 components/chat/，本文件仅保留布局编排和状态管理
//
// C-V2 性能基座说明：
//   useProjectsStore 已拆分为细粒度 selector，避免全量订阅触发不必要的重渲染
//   useRouteDevStore 在 GoalMessageBubble（components/chat/MessageBubble.tsx）中已使用 selector
//   注意：App.tsx 中 `useRouteDev()` 仍为全量订阅（`<ChatPage {...routeDev} />`），
//   后续 74-D 可改为细粒度 selector + 按需传入 props，进一步减少 ChatPage 重渲染范围

import { useRef, useState, useEffect, useCallback } from 'react';
import { UploadCloud, FolderOpen, History } from 'lucide-react';
import type { ChatMessage, PendingConfirm } from '../hooks/useRouteDev.js';
import type { AppConfig, AutonomyMode } from '../../../shared/config-types.js';
import type { TokenProfileSnapshot } from '../../../../src/agent/token-profiler.js';
import type { ConfigSaveResult, FollowUpItem, FollowUpMode, SessionStatus } from '../../../shared/ipc-types.js';
import { NeuralNetworkBackground } from '../components/NeuralNetworkBackground.js';
import { ArtifactPanel } from '../components/ArtifactPanel.js';
import { StepEditor } from '../components/StepEditor.js';
import { Badge } from '../components/ui/badge.js';
import { Card } from '../components/ui/card.js';
import { useProjectsStore } from '../store/useProjectsStore.js';
import { MessageList } from '../components/chat/MessageList.js';
import { ToolConfirmDialog } from '../components/chat/ToolConfirmDialog.js';
import { InputArea } from '../components/chat/InputArea.js';
import { PendingQueue } from '../components/chat/PendingQueue.js';
import { FollowUpQueue } from '../components/chat/FollowUpQueue.js';
import { ScrollToBottom } from '../components/chat/ScrollToBottom.js';
// Phase 77：运行回放与评分卡 UI
import { ReplayView } from '../components/trace/ReplayView.js';
import { ScorecardView } from '../components/trace/ScorecardView.js';
// Phase 77 借鉴点 7：冷启动恢复提示条
import { RecoveryPrompt } from '../components/goal/RecoveryPrompt.js';
import { SessionStatusCard } from '../components/session/SessionStatusCard.js';

interface ChatPageProps {
  messages: ChatMessage[];
  isProcessing: boolean;
  currentModel: string;
  pendingConfirm: PendingConfirm | null;
  config: AppConfig | null;
  /** F-011：App 仅订阅最后一条 snapshot 传入，避免完整数组订阅触发 App 重渲染 */
  lastTokenSnapshot?: TokenProfileSnapshot;
  sendMessage: (text: string) => void;
  confirmTool: (approved: boolean, payload?: unknown) => void;
  stopGeneration: () => void;
  saveConfig: (config: AppConfig) => Promise<ConfigSaveResult>;
  deleteMessage: (messageId: string) => void;
  retryMessage: (messageId: string) => void;
}

export function ChatPage({
  messages, isProcessing, pendingConfirm, config, lastTokenSnapshot,
  sendMessage, confirmTool, stopGeneration, saveConfig, deleteMessage, retryMessage,
}: ChatPageProps) {
  const [dragOver, setDragOver] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [editingQueueIdx, setEditingQueueIdx] = useState<number | null>(null);
  const [editingQueueValue, setEditingQueueValue] = useState('');
  // Phase 73 Part C：follow-up 队列展示
  const [followUpQueue, setFollowUpQueue] = useState<FollowUpItem[]>([]);
  const [followUpExpanded, setFollowUpExpanded] = useState(false);
  const [followUpMode, setFollowUpModeState] = useState<FollowUpMode>('one-at-a-time');
  const [showCheckpointPanel, setShowCheckpointPanel] = useState(false);
  // Phase 77：运行回放 / 评分卡弹窗
  const [replayOpen, setReplayOpen] = useState(false);
  const [scorecardOpen, setScorecardOpen] = useState(false);
  // Phase 77：会话状态卡数据（每 5 秒轮询 session:get-status，idle 时不渲染卡片）
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);

  // C-V2：细粒度 selector——仅订阅所需字段，避免全量 store 变化触发重渲染
  const projects = useProjectsStore((s) => s.projects);
  const currentProjectId = useProjectsStore((s) => s.currentProjectId);
  const currentConversationId = useProjectsStore((s) => s.currentConversationId);
  const forkConversationFromMessage = useProjectsStore((s) => s.forkConversationFromMessage);
  const selectConversation = useProjectsStore((s) => s.selectConversation);
  const currentProject = projects.find((p) => p.id === currentProjectId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevProcessingRef = useRef(isProcessing);

  // 自动滚动到底部（仅当用户已在底部附近时）
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  // 引擎处理完成后，自动发送队列中的下一条消息
  useEffect(() => {
    if (prevProcessingRef.current && !isProcessing && queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      setTimeout(() => sendMessage(next), 100);
    }
    prevProcessingRef.current = isProcessing;
  }, [isProcessing, queue, sendMessage]);

  // Phase 73 Part C：轮询 follow-up 队列状态（仅 isProcessing 时拉取）
  useEffect(() => {
    if (!isProcessing) { setFollowUpQueue([]); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const items = await window.routedev.agent.getFollowUpQueue();
        if (!cancelled) setFollowUpQueue(items);
      } catch { /* fail-open */ }
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isProcessing]);

  // Phase 77：轮询会话状态卡数据（每 5 秒拉取，goal 执行中/已完成/失败时均展示）
  // 无活跃 goal 时聚合器返回 idle 状态，本组件在 idle 时不渲染卡片
  // F-022：idle 时不启动 interval，避免空转轮询
  useEffect(() => {
    if (!isProcessing) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await window.routedev.session.getStatus();
        if (!cancelled) setSessionStatus(status);
      } catch { /* fail-open */ }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isProcessing]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distFromBottom < 100;
    setShowScrollBottom(distFromBottom > 200);
  }, []);

  const jumpToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);

  // InputArea 提交：引擎工作时进入队列，否则直接发送
  const handleSubmit = useCallback((text: string) => {
    // Phase 77：拦截 /replay /scorecard 命令，直接打开对应弹窗（不进入发送队列）
    const trimmed = text.trim();
    if (trimmed === '/replay' || trimmed.startsWith('/replay ')) {
      setReplayOpen(true);
      return;
    }
    if (trimmed === '/scorecard' || trimmed.startsWith('/scorecard ')) {
      setScorecardOpen(true);
      return;
    }
    if (isProcessing) {
      setQueue((prev) => [...prev, text]);
      setQueueExpanded(true);
    } else {
      sendMessage(text);
      isNearBottomRef.current = true;
      setTimeout(jumpToBottom, 50);
    }
  }, [isProcessing, sendMessage, jumpToBottom]);

  const handleFollowUp = useCallback((text: string) => {
    window.routedev.agent.followUp(text);
    setFollowUpExpanded(true);
  }, []);

  const removeFollowUpItem = useCallback(async (idx: number) => {
    const ok = await window.routedev.agent.removeFollowUp(idx);
    if (ok) setFollowUpQueue((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Phase 71：清空全部 follow-up 队列
  const clearAllFollowUps = useCallback(() => {
    window.routedev.agent.clearAllQueues();
    setFollowUpQueue([]);
    setFollowUpExpanded(false);
  }, []);

  const handleFollowUpModeChange = useCallback((m: FollowUpMode) => {
    setFollowUpModeState(m);
    window.routedev.agent.setFollowUpMode(m);
  }, []);

  // 自主度切换（InputArea 调用，ChatPage 处理 config 保存）
  const handleAutonomyChange = useCallback(async (mode: AutonomyMode) => {
    if (!config || config.autonomy.defaultMode === mode) return;
    const newConfig: AppConfig = { ...config, autonomy: { ...config.autonomy, defaultMode: mode } };
    await saveConfig(newConfig);
  }, [config, saveConfig]);

  const handleOpenProjectFolder = useCallback(async () => {
    if (currentProject?.path) await window.routedev.fs.openFolder(currentProject.path);
  }, [currentProject?.path]);

  // 队列操作
  const removeQueueItem = (idx: number) => setQueue((prev) => prev.filter((_, i) => i !== idx));
  const startEditQueueItem = (idx: number) => { setEditingQueueIdx(idx); setEditingQueueValue(queue[idx] ?? ''); };
  const confirmEditQueueItem = () => {
    if (editingQueueIdx === null) return;
    const trimmed = editingQueueValue.trim();
    setQueue((prev) => {
      const next = [...prev];
      if (trimmed) next[editingQueueIdx] = trimmed; else next.splice(editingQueueIdx, 1);
      return next;
    });
    setEditingQueueIdx(null); setEditingQueueValue('');
  };

  // 文件拖拽处理
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    // 拖拽事件保留在 ChatPage 层（Card 容器），文件处理由 InputArea 消费
  };

  // 监听快捷键事件（由 useKeyboardShortcuts 通过 window 自定义事件派发）
  useEffect(() => {
    const focusInput = () => {
      const textarea = document.querySelector('textarea[data-chat-input]') as HTMLTextAreaElement | null;
      if (textarea) textarea.focus();
    };
    const stopGen = () => stopGeneration();
    window.addEventListener('routedev:focus-chat-input', focusInput);
    window.addEventListener('routedev:stop-generation', stopGen);
    return () => {
      window.removeEventListener('routedev:focus-chat-input', focusInput);
      window.removeEventListener('routedev:stop-generation', stopGen);
    };
  }, [stopGeneration]);

  const outputStyle = config?.ui?.outputStyle;
  const tokenUsage = lastTokenSnapshot?.totalEstimated ?? 0;
  const autonomyMode = config?.autonomy?.defaultMode;

  return (
    <Card
      className="relative flex h-full flex-col overflow-hidden rounded-none border-0 bg-rd-surface p-0 shadow-none"
      onDragOver={handleDragOver} onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave} onDrop={handleDrop}
    >
      {/* 状态栏 */}
      <div className="flex h-14 shrink-0 items-center justify-between px-5">
        <div className="flex items-center gap-2 overflow-x-auto">
          {currentProject && (
            <Badge variant="default" className="shrink-0 gap-1.5">
              <span className="max-w-[120px] truncate">{currentProject.name}</span>
              {currentProject.path && (
                <button onClick={handleOpenProjectFolder} title={`打开: ${currentProject.path}`}
                  className="ml-0.5 flex h-5 w-5 items-center justify-center rounded hover:bg-rd-surfaceHighlight">
                  <FolderOpen size={14} />
                </button>
              )}
            </Badge>
          )}
          {tokenUsage > 0 && (
            <Badge variant="primary" className="shrink-0">Tokens: {tokenUsage.toLocaleString()}</Badge>
          )}
        </div>
        <button type="button" onClick={() => setShowCheckpointPanel(!showCheckpointPanel)}
          title={showCheckpointPanel ? '隐藏检查点面板' : '显示检查点面板'}
          className={['flex h-8 w-8 items-center justify-center rounded-md transition',
            showCheckpointPanel ? 'bg-rd-primary/10 text-rd-primary' : 'text-rd-textSubtle hover:bg-rd-surfaceHover hover:text-rd-text',
          ].join(' ')}>
          <History size={16} />
        </button>
      </div>

      {/* Phase 77 借鉴点 7：冷启动恢复提示条（无可恢复 goal 时不渲染） */}
      <RecoveryPrompt
        onResume={() => { /* goal 恢复后由 onGoalEvent 驱动 UI 切换 */ }}
        onClose={() => { /* 用户可关闭提示条，下次刷新 listResumable 仍会重新拉取 */ }}
      />

      {/* 消息区 */}
      <div className="relative flex min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll}
          className="flex-1 space-y-2.5 overflow-y-auto px-5 py-4">
          {/* Phase 77：Voice Memo 式会话状态卡（无活跃 goal 时不渲染） */}
          {sessionStatus && sessionStatus.status !== 'idle' && (
            <SessionStatusCard status={sessionStatus} />
          )}
          {messages.length === 0 ? (
            <div className="relative flex h-full items-start justify-center pt-[18%]">
              <NeuralNetworkBackground />
              <h1 className="relative z-10 select-none text-5xl font-black tracking-tight text-rd-primary/20">RouteDev</h1>
            </div>
          ) : (
            <MessageList messages={messages} isProcessing={isProcessing} outputStyle={outputStyle}
              deleteMessage={deleteMessage} retryMessage={retryMessage}
              currentProjectId={currentProjectId} currentConversationId={currentConversationId}
              forkConversationFromMessage={forkConversationFromMessage}
              conversations={currentProject?.conversations ?? []}
              onSwitchBranch={(targetConvId) => {
                if (currentProjectId) selectConversation(currentProjectId, targetConvId);
              }} />
          )}
        </div>

        <ScrollToBottom visible={showScrollBottom} onClick={jumpToBottom} rightOffset={showCheckpointPanel} />

        {showCheckpointPanel && (
          <ArtifactPanel
            messages={messages}
            projectId={currentProjectId ?? undefined}
          />
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

      {/* Phase 54：计划编辑器 */}
      <StepEditor />

      {/* Phase 77：运行回放 / 评分卡弹窗（/replay /scorecard 命令触发） */}
      <ReplayView open={replayOpen} onClose={() => setReplayOpen(false)} />
      <ScorecardView open={scorecardOpen} onClose={() => setScorecardOpen(false)} />

      {/* Phase 74-B2：双队列触发器行（浮层式，胶囊触发器水平排列在输入区上方） */}
      {(queue.length > 0 || followUpQueue.length > 0) && (
        <div className="flex shrink-0 items-center gap-2 px-4 py-1.5">
          <PendingQueue items={queue} expanded={queueExpanded}
            onToggle={() => setQueueExpanded(!queueExpanded)} onRemove={removeQueueItem}
            onStartEdit={startEditQueueItem} editingIndex={editingQueueIdx}
            editingValue={editingQueueValue} onEditChange={setEditingQueueValue}
            onConfirmEdit={confirmEditQueueItem} onCancelEdit={() => setEditingQueueIdx(null)} />

          <FollowUpQueue items={followUpQueue} expanded={followUpExpanded}
            onToggle={() => setFollowUpExpanded(!followUpExpanded)}
            mode={followUpMode} onModeChange={handleFollowUpModeChange}
            onRemove={removeFollowUpItem} onClearAll={clearAllFollowUps} />
        </div>
      )}

      {/* 输入区 */}
      <InputArea isProcessing={isProcessing} autonomyMode={autonomyMode}
        onAutonomyChange={handleAutonomyChange} onSubmit={handleSubmit}
        onFollowUp={handleFollowUp} onStop={stopGeneration}
        focusKey={currentConversationId} />
    </Card>
  );
}
