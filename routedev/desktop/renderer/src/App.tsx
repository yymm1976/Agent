// desktop/renderer/src/App.tsx
// 应用根组件：页面路由 + 全局状态透传 + 主题应用 + 对话切换联动

import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { Layout } from './components/Layout.js';
import { TitleBar } from './components/TitleBar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ChatPage } from './pages/ChatPage.js';
import { SetupWizard } from './components/SetupWizard.js';
import { StatusBanner } from './components/StatusBanner.js';
import { type RecentConversation, type SuggestedTask } from './components/DiscoveryPage.js';
import { Button } from './components/ui/button.js';
import { useTheme } from './hooks/useTheme.js';
import { initIPCListeners, loadInitialConfig, useRouteDevStore } from './store/useRouteDevStore.js';
import { useProjectsStore } from './store/useProjectsStore.js';

// F-023：懒加载非首屏页面，减小首屏 bundle 体积
const SettingsPage = lazy(() => import('./pages/SettingsPage.js').then(m => ({ default: m.SettingsPage })));
const NewTaskPage = lazy(() => import('./pages/NewTaskPage.js').then(m => ({ default: m.NewTaskPage })));
const DiscoveryPage = lazy(() => import('./components/DiscoveryPage.js').then(m => ({ default: m.DiscoveryPage })));

type PageId = 'chat' | 'newtask' | 'settings';

export default function App() {
  const [page, setPage] = useState<PageId>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  // 新建任务页面的预选项目 ID（来自项目右侧+按钮）
  const [newTaskInitialProjectId, setNewTaskInitialProjectId] = useState<string | undefined>(undefined);
  // F-047/F-4.01：将原 useRouteDev() 全量订阅改为按字段 selector 订阅，
  // 避免任意 store 字段变化（如 isProcessing / messages 流式更新）都触发 App 重渲染，
  // 进而连带触发 ChatPage / SettingsPage 等子树重渲染。
  // 函数引用（sendMessage / saveConfig 等）在 Zustand 中是稳定的，selector 订阅不会触发重渲染。
  const config = useRouteDevStore((s) => s.config);
  const configLoading = useRouteDevStore((s) => s.configLoading);
  const configError = useRouteDevStore((s) => s.configError);
  const isProcessing = useRouteDevStore((s) => s.isProcessing);
  const currentModel = useRouteDevStore((s) => s.currentModel);
  const pendingConfirm = useRouteDevStore((s) => s.pendingConfirm);
  const lastTokenSnapshot = useRouteDevStore((s) => s.tokenSnapshots.at(-1));
  const sendMessage = useRouteDevStore((s) => s.sendMessage);
  const confirmTool = useRouteDevStore((s) => s.confirmTool);
  const stopGeneration = useRouteDevStore((s) => s.stopGeneration);
  const saveConfig = useRouteDevStore((s) => s.saveConfig);
  const reloadConfig = useRouteDevStore((s) => s.reloadConfig);
  const deleteMessage = useRouteDevStore((s) => s.deleteMessage);
  const retryMessage = useRouteDevStore((s) => s.retryMessage);
  // messages 字段单列：App 自身需要在 effect 中读写它（持久化/切换对话），
  // 也要传给 Layout（messages prop）和 ChatPage（{...routeDev}）
  const routeDevMessages = useRouteDevStore((s) => s.messages);
  // 兼容子组件 props 形状：组装为 routeDev 对象传给 ChatPage / SettingsPage
  const routeDev = {
    config, configLoading, configError,
    isProcessing, currentModel, pendingConfirm, lastTokenSnapshot, messages: routeDevMessages,
    sendMessage, confirmTool, stopGeneration, saveConfig, reloadConfig,
    deleteMessage, retryMessage,
  };

  // 应用主题和字体大小
  useTheme(config);

  // 初始化 IPC 事件订阅 + 加载初始配置 + 加载项目数据（仅执行一次）
  useEffect(() => {
    const cleanup = initIPCListeners();
    void loadInitialConfig();
    useProjectsStore.getState().loadFromStorage();
    return cleanup;
  }, []);

  // Phase 45：功能发现启动提示（showOnStartup）
  // 配置加载后，若启用功能发现且设置了启动时显示，则自动打开发现页
  const discoveryShownRef = useRef(false);
  useEffect(() => {
    if (!config || discoveryShownRef.current) return;
    discoveryShownRef.current = true;
    if (config.discovery?.enabled !== false && config.discovery?.showOnStartup) {
      setDiscoveryOpen(true);
    }
  }, [config]);

  // 对话切换联动：当 currentConversationId 变化时，
  // 保存旧对话消息 + 加载新对话消息到 routeDev store
  const lastConvIdRef = useRef<string | null>(null);
  // 新建任务待发送消息：NewTaskPage 发送时暂存，等对话切换完成后触发 sendMessage
  const pendingSendRef = useRef<string | null>(null);
  const { currentProjectId, currentConversationId, projects, getMessages, setMessages, addConversation } = useProjectsStore();

  useEffect(() => {
    // 删除对话后 currentConversationId 变为 null：清空 routeDevStore 消息，避免界面残留
    // 同时重置 isProcessing 和 pendingConfirm，避免 textarea 的 disabled 状态卡住无法输入
    if (!currentConversationId) {
      useRouteDevStore.setState({
        messages: [],
        isProcessing: false,
        pendingConfirm: null,
        progressLabel: null,
        _assistantId: null,
        _assistantBuffer: '',
        _currentTaskId: null,
        _currentTaskStartTime: null,
      });
      lastConvIdRef.current = null;
      return;
    }
    if (!currentProjectId) return;
    // 切换前：把当前 routeDev messages 写回旧对话
    if (lastConvIdRef.current && lastConvIdRef.current !== currentConversationId) {
      // 找到旧对话所属项目
      for (const p of projects) {
        const oldConv = p.conversations.find((c) => c.id === lastConvIdRef.current);
        if (oldConv) {
          setMessages(p.id, oldConv.id, routeDevMessages);
          break;
        }
      }
    }
    // 加载新对话的消息
    const msgs = getMessages(currentProjectId, currentConversationId);
    // 切换对话时重置所有瞬态状态，避免旧对话的状态泄漏到新对话
    useRouteDevStore.setState({
      messages: msgs,
      isProcessing: false,
      pendingConfirm: null,
      progressLabel: null,
      _assistantId: null,
      _assistantBuffer: '',
      _currentTaskId: null,
      _currentTaskStartTime: null,
      _pendingDelta: '',
      _rafHandle: null,
      _reasoningBuffer: '',
      _pendingReasoning: '',
      _reasoningRafHandle: null,
    });
    lastConvIdRef.current = currentConversationId;
    // 通知 main 进程更新 engine 工作目录为当前项目路径
    // 这样工具调用（file_read/file_write/shell_exec 等）会基于正确的项目路径
    const currentProject = projects.find(p => p.id === currentProjectId);
    if (currentProject?.path) {
      window.routedev?.project?.setCwd?.(currentProject.path);
    }
    window.routedev?.chat?.syncHistory?.(
      msgs
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    );
    // 若有待发送消息（来自 NewTaskPage），在消息加载后触发发送
    if (pendingSendRef.current) {
      const text = pendingSendRef.current;
      pendingSendRef.current = null;
      // 延迟一帧，确保 routeDevStore.messages 已完成加载
      setTimeout(() => {
        useRouteDevStore.getState().sendMessage(text);
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, currentConversationId]);

  // 消息变化时实时写回当前对话（保证流式输出也能持久化）
  useEffect(() => {
    if (!currentProjectId || !currentConversationId) return;
    if (lastConvIdRef.current === currentConversationId) {
      setMessages(currentProjectId, currentConversationId, routeDevMessages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeDevMessages]);

  // 在新建任务页面时，点击侧边栏对话项自动返回 chat 页面
  // 注意：此 effect 仅处理"切换到其他对话"的情况
  // 点击当前对话的情况由 ProjectSidebar 的 onNavigateToChat 回调处理
  useEffect(() => {
    if (page === 'newtask' && currentConversationId && lastConvIdRef.current !== currentConversationId) {
      setPage('chat');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConversationId]);

  if (routeDev.configLoading) {
    return (
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
        <TitleBar />
        <div className="flex min-h-0 items-center justify-center bg-rd-background text-rd-textMuted">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-rd-primary border-t-transparent" />
            <span className="text-sm">正在初始化 RouteDev...</span>
          </div>
        </div>
      </div>
    );
  }

  // 配置加载失败：显示错误页面而非 SetupWizard，避免用户误点"跳过"覆盖已有配置
  if (routeDev.configError) {
    const handleRetry = () => {
      useRouteDevStore.setState({ configError: null, configLoading: true });
      void loadInitialConfig();
    };
    return (
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
        <TitleBar />
        <div className="flex min-h-0 flex-col items-center justify-center bg-rd-background p-8 text-center">
          <AlertCircle size={48} className="mb-4 text-rd-danger" />
          <h2 className="mb-2 text-xl font-semibold text-rd-text">配置加载失败</h2>
          <p className="mb-2 max-w-md text-sm text-rd-textMuted">
            配置文件可能已损坏或格式有误。你的配置文件已自动备份，不会丢失。
          </p>
          <p className="mb-6 max-w-lg rounded-lg bg-rd-surfaceHover p-3 text-left text-xs text-rd-textMuted">
            {routeDev.configError}
          </p>
          <Button onClick={handleRetry}>
            <RotateCcw size={16} /> 重试加载
          </Button>
        </div>
      </div>
    );
  }

  // 首次启动：未配置任何 Provider 且未主动跳过时显示设置向导
  if (!routeDev.config || (routeDev.config.providers.length === 0 && !routeDev.config.general.setupSkipped)) {
    return (
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
        <TitleBar />
        <div className="min-h-0 overflow-hidden">
          <SetupWizard saveConfig={routeDev.saveConfig} />
        </div>
      </div>
    );
  }

  // 新建任务发送：创建空对话 + 暂存消息 + 切换到 chat 页面
  // 对话切换 useEffect 检测到 currentConversationId 变化后会触发 sendMessage
  const handleNewTaskSend = (text: string, projectId: string) => {
    pendingSendRef.current = text;
    addConversation(projectId);
    setPage('chat');
  };

  // 打开新建任务页面，记录预选项目 ID
  const handleOpenNewTask = (projectId?: string) => {
    setNewTaskInitialProjectId(projectId);
    setPage('newtask');
  };

  const handleCloseSettings = () => {
    setSettingsClosing(true);
    window.setTimeout(() => {
      setSettingsOpen(false);
      setSettingsClosing(false);
    }, 180);
  };

  // Phase 45：功能发现页数据准备
  const recentConversations: RecentConversation[] = projects.flatMap(p =>
    p.conversations.map(c => ({
      id: c.id,
      title: c.title || '未命名对话',
      lastActiveAt: c.updatedAt || c.createdAt,
      messageCount: c.messages.length,
    }))
  ).sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 6);
  // F-023：内联 generateSuggestedTasks('unknown') 的结果，避免静态 import DiscoveryPage 模块导致懒加载失效
  const suggestedTasks: SuggestedTask[] = [
    { icon: 'Network', title: '解释项目架构', description: '梳理核心模块与数据流，给出架构概览', prompt: '请解释当前项目的核心架构' },
    { icon: 'GitCompare', title: '审查代码变更', description: '审查当前分支相对主干的代码变更', prompt: '审查当前分支的代码变更' },
    { icon: 'GitBranch', title: '开启分支实验', description: '在隔离分支上尝试新的实现方案', prompt: '为当前需求开启一个实验分支，尝试新的实现方案' },
  ];

  return (
    // 使用 grid 替代 flex-col：确保 wrapper 所在 grid cell 有明确高度（minmax(0,1fr)），
    // Layout 的 h-full 参考的是 grid 明确分配的高度，而非 flex item 的隐式高度，避免频繁重渲染时高度抖动。
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <TitleBar />
      <div className="min-h-0 overflow-hidden">
        <ErrorBoundary>
          <StatusBanner />
          <Layout
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenNewTask={handleOpenNewTask}
            onNavigateToChat={() => setPage('chat')}
            messages={routeDevMessages}
          >
            {page === 'chat' && <ChatPage {...routeDev} />}
            {page === 'newtask' && (
              <Suspense fallback={<div className="flex min-h-0 items-center justify-center text-sm text-rd-textMuted">加载中...</div>}>
                <NewTaskPage
                  initialProjectId={newTaskInitialProjectId}
                  onSend={handleNewTaskSend}
                  onCancel={() => setPage('chat')}
                />
              </Suspense>
            )}
          </Layout>
          {settingsOpen && (
            <div className={`${settingsClosing ? 'rd-modal-backdrop-exit' : 'rd-modal-backdrop-enter'} fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6`}>
              <div className={`${settingsClosing ? 'rd-modal-exit' : 'rd-modal-enter'} h-[90vh] w-[min(1280px,94vw)] overflow-hidden rounded-3xl border border-rd-border bg-rd-background shadow-2xl`}>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-rd-textMuted">加载中...</div>}>
                  <SettingsPage {...routeDev} onBack={handleCloseSettings} />
                </Suspense>
              </div>
            </div>
          )}
          {config?.discovery?.enabled !== false && (
            <Suspense fallback={null}>
              <DiscoveryPage
                open={discoveryOpen}
                onClose={() => setDiscoveryOpen(false)}
                recentConversations={recentConversations}
                suggestedTasks={suggestedTasks}
                onSelectTask={(prompt) => {
                  setDiscoveryOpen(false);
                  setPage('chat');
                  useRouteDevStore.getState().sendMessage(prompt);
                }}
                onSelectConversation={(id) => {
                  setDiscoveryOpen(false);
                  setPage('chat');
                  // 查找并切换对话
                  for (const p of projects) {
                    const conv = p.conversations.find(c => c.id === id);
                    if (conv) {
                      useProjectsStore.getState().selectConversation(p.id, id);
                      break;
                    }
                  }
                }}
                onNewTask={() => {
                  setDiscoveryOpen(false);
                  setPage('newtask');
                }}
                onOpenSettings={() => {
                  setDiscoveryOpen(false);
                  setSettingsOpen(true);
                }}
              />
            </Suspense>
          )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
