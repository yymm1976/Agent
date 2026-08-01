// desktop/renderer/src/components/Layout.tsx
// 应用整体布局：左侧项目侧边栏（可缩进、宽度可调）+ 分隔条 + 主内容区 + 分隔条 + 右侧任务监控面板（可缩进）
// 移除旧顶部标题栏，设置入口集成到侧边栏顶部

import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { ProjectSidebar } from './ProjectSidebar.js';
import { ResizableSplitter } from './ResizableSplitter.js';
import { TaskMonitorPanel } from './TaskMonitorPanel.js';
import { SubagentPanel } from './agent/SubagentPanel.js';
import type { ChatMessage } from '../store/useRouteDevStore.js';
import { useRouteDevStore } from '../store/useRouteDevStore.js';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts.js';

interface LayoutProps {
  children: ReactNode;
  onOpenSettings: () => void;
  /** 打开新建任务页面，可传预选项目 ID */
  onOpenNewTask: (projectId?: string) => void;
  /** 从非 chat 页面（如 newtask）返回 chat 页面（点击侧边栏对话项时触发） */
  onNavigateToChat: () => void;
  /** 当前对话的消息列表（传给右侧任务监控面板） */
  messages?: ChatMessage[];
}

/** 找不到模型配置时的默认上下文窗口（与 TaskMonitorPanel 历史默认一致） */
const DEFAULT_CONTEXT_WINDOW = 128000;

const SIDEBAR_WIDTH_KEY = 'routedev-sidebar-width-v2';
const DEFAULT_SIDEBAR_WIDTH = 220;
const RIGHT_PANEL_WIDTH_KEY = 'routedev-right-panel-width-v2';
const DEFAULT_RIGHT_PANEL_WIDTH = 292;
const SIDEBAR_COLLAPSED_KEY = 'routedev-sidebar-collapsed';
const RIGHT_PANEL_COLLAPSED_KEY = 'routedev-right-panel-collapsed';

interface WorkbenchPanelState {
  rightPanelOpen: boolean;
  openRightPanel: () => void;
}

const WorkbenchPanelContext = createContext<WorkbenchPanelState>({
  rightPanelOpen: true,
  openRightPanel: () => {},
});

export function useWorkbenchPanel(): WorkbenchPanelState {
  return useContext(WorkbenchPanelContext);
}

export function Layout({ children, onOpenSettings, onOpenNewTask, onNavigateToChat, messages }: LayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? Number(saved) : DEFAULT_SIDEBAR_WIDTH;
  });
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    const saved = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
    return saved ? Number(saved) : DEFAULT_RIGHT_PANEL_WIDTH;
  });
  // 侧边栏缩进状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  });
  const [rightPanelOpen, setRightPanelOpen] = useState<boolean>(() => {
    return localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY) !== 'true';
  });

  // 从当前模型配置读取 contextWindow，驱动右侧任务监控面板 token 上限
  const config = useRouteDevStore((s) => s.config);
  const currentModel = useRouteDevStore((s) => s.currentModel);
  const contextWindow = useMemo(() => {
    const providers = config?.providers ?? [];
    if (currentModel) {
      for (const p of providers) {
        const m = p.models?.find((x) => x.id === currentModel);
        if (m?.contextWindow && m.contextWindow > 0) return m.contextWindow;
      }
    }
    for (const p of providers) {
      const m = p.models?.find((x) => x.contextWindow && x.contextWindow > 0);
      if (m?.contextWindow) return m.contextWindow;
    }
    return DEFAULT_CONTEXT_WINDOW;
  }, [config, currentModel]);

  // 持久化
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);
  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_COLLAPSED_KEY, String(!rightPanelOpen));
  }, [rightPanelOpen]);

  const panelContext = useMemo<WorkbenchPanelState>(() => ({
    rightPanelOpen,
    openRightPanel: () => setRightPanelOpen(true),
  }), [rightPanelOpen]);

  useKeyboardShortcuts({
    onOpenSettings: () => onOpenSettings(),
    onNewTask: () => onOpenNewTask(),
    onToggleSidebar: () => setRightPanelOpen((prev) => !prev),
    onFocusInput: () => {
      window.dispatchEvent(new CustomEvent('routedev:focus-chat-input'));
    },
    onStopGeneration: () => {
      window.dispatchEvent(new CustomEvent('routedev:stop-generation'));
    },
    onNextConversation: () => {
      window.dispatchEvent(new CustomEvent('routedev:next-conversation'));
    },
    onPrevConversation: () => {
      window.dispatchEvent(new CustomEvent('routedev:prev-conversation'));
    },
  });

  return (
    <div className="rd-workbench flex h-full w-full bg-rd-background px-1 pb-1 pt-0 text-rd-text">
      {/* 左侧项目侧边栏（固定渲染，用宽度/透明度过渡，避免条件卸载导致无动画） */}
      <div
        style={{ width: sidebarCollapsed ? 48 : sidebarWidth }}
        className="shrink-0 overflow-hidden rounded-lg bg-rd-surface transition-[width,transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
      >
        {sidebarCollapsed ? (
        <div className="flex h-full w-12 flex-col items-center py-3">
          <button
            onClick={() => setSidebarCollapsed(false)}
            title="展开侧边栏"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-rd-textMuted transition hover:bg-rd-surfaceHover hover:text-rd-primary"
          >
            <PanelLeftOpen size={18} />
          </button>
        </div>
        ) : (
        <div className="h-full w-full rd-panel-slide-in">
          <ProjectSidebar
            onOpenSettings={onOpenSettings}
            onOpenNewTask={onOpenNewTask}
            onNavigateToChat={onNavigateToChat}
            onCollapse={() => setSidebarCollapsed(true)}
          />
        </div>
        )}
      </div>
      {!sidebarCollapsed && (
        <>
          <ResizableSplitter
            width={sidebarWidth}
            minWidth={180}
            maxWidth={420}
            onWidthChange={setSidebarWidth}
          />
        </>
      )}

      {/* 主内容区 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg bg-rd-surface transition-all duration-200 ease-out">
        <WorkbenchPanelContext.Provider value={panelContext}>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </WorkbenchPanelContext.Provider>
      </main>

      {/* 右侧任务监控面板 */}
      {rightPanelOpen && (
        <>
          <ResizableSplitter
            width={rightPanelWidth}
            minWidth={240}
            maxWidth={440}
            onWidthChange={setRightPanelWidth}
            align="right"
          />
          <div
            style={{ width: rightPanelWidth }}
            className="shrink-0 overflow-hidden rounded-lg bg-rd-surface transition-[width,transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
          >
            <div className="h-full w-full rd-panel-slide-in">
              <TaskMonitorPanel
                messages={messages ?? []}
                onCollapse={() => setRightPanelOpen(false)}
                maxTokens={contextWindow}
              />
            </div>
          </div>
        </>
      )}

      {/* Phase 97 Part E：子会话面板（固定右下角，不参与布局流） */}
      <SubagentPanel />
    </div>
  );
}
