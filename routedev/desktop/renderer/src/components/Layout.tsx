// desktop/renderer/src/components/Layout.tsx
// 应用整体布局：左侧项目侧边栏（可缩进、宽度可调）+ 分隔条 + 主内容区 + 分隔条 + 右侧任务监控面板（可缩进）
// 移除旧顶部标题栏，设置入口集成到侧边栏顶部

import { useState, useEffect, type ReactNode } from 'react';
import { PanelLeftOpen, PanelRightOpen, Activity } from 'lucide-react';
import { ProjectSidebar } from './ProjectSidebar.js';
import { ResizableSplitter } from './ResizableSplitter.js';
import { TaskMonitorPanel, hasTaskContent } from './TaskMonitorPanel.js';
import type { ChatMessage } from '../store/useRouteDevStore.js';
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

const SIDEBAR_WIDTH_KEY = 'routedev-sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 240;
const RIGHT_PANEL_WIDTH_KEY = 'routedev-right-panel-width';
const DEFAULT_RIGHT_PANEL_WIDTH = 280;
const SIDEBAR_COLLAPSED_KEY = 'routedev-sidebar-collapsed';
const RIGHT_PANEL_COLLAPSED_KEY = 'routedev-right-panel-collapsed';
/** 右侧面板手动开关状态（用户主动打开/关闭，独立于自动呼出） */
const RIGHT_PANEL_MANUAL_KEY = 'routedev-right-panel-manual';

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
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY) === 'true';
  });
  // 右侧面板手动开关：用户主动打开时为 true，主动关闭时为 false
  // null 表示未手动操作过，由 hasContent 自动决定
  const [manualOverride, setManualOverride] = useState<boolean | null>(() => {
    const saved = localStorage.getItem(RIGHT_PANEL_MANUAL_KEY);
    return saved === null ? null : saved === 'true';
  });

  // 根据消息流判断是否有任务监控内容
  const [hasContent, setHasContent] = useState(false);
  useEffect(() => {
    setHasContent(hasTaskContent(messages ?? []));
  }, [messages]);

  // 右侧面板是否显示：手动开关优先，否则根据内容自动决定
  const showRightPanel = manualOverride !== null ? manualOverride : hasContent;

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
    localStorage.setItem(RIGHT_PANEL_COLLAPSED_KEY, String(rightPanelCollapsed));
  }, [rightPanelCollapsed]);
  useEffect(() => {
    if (manualOverride !== null) {
      localStorage.setItem(RIGHT_PANEL_MANUAL_KEY, String(manualOverride));
    }
  }, [manualOverride]);

  useEffect(() => {
    if (hasContent) {
      setManualOverride(true);
      setRightPanelCollapsed(false);
    }
  }, [hasContent, messages?.length]);

  useKeyboardShortcuts({
    onOpenSettings: () => onOpenSettings(),
    onNewTask: () => onOpenNewTask(),
    onToggleSidebar: () => setManualOverride((prev) => !prev),
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
    <div className="flex h-full w-full bg-rd-background px-3 pb-3 pt-0 text-rd-text">
      {/* 左侧项目侧边栏（固定渲染，用宽度/透明度过渡，避免条件卸载导致无动画） */}
      <div
        style={{ width: sidebarCollapsed ? 48 : sidebarWidth }}
        className="mr-3 shrink-0 overflow-hidden rounded-2xl bg-rd-surface transition-[width,transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
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

      {/* 主内容区（浮动面板） */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-rd-surface transition-all duration-200 ease-out">
        {children}
      </main>

      {/* 右侧任务监控面板手动开关按钮（仅当面板完全隐藏时显示，让用户主动打开） */}
      {!showRightPanel && (
        <button
          onClick={() => {
            setManualOverride(true);
            setRightPanelCollapsed(false);
          }}
          title="打开任务监控面板"
          className="ml-3 flex w-12 shrink-0 flex-col items-center justify-start rounded-2xl bg-rd-surface py-3 text-rd-textMuted transition-all duration-200 ease-out hover:bg-rd-surfaceHover hover:text-rd-primary"
        >
          <Activity size={18} />
          <span className="mt-1 text-[10px] writing-vertical-rl">监控</span>
        </button>
      )}

      {/* 右侧任务监控面板 */}
      {showRightPanel && (
        <>
          {!rightPanelCollapsed && (
            <ResizableSplitter
              width={rightPanelWidth}
              minWidth={200}
              maxWidth={480}
              onWidthChange={setRightPanelWidth}
              align="right"
            />
          )}
          <div
            style={{ width: rightPanelCollapsed ? 48 : rightPanelWidth }}
            className="ml-3 shrink-0 overflow-hidden rounded-2xl bg-rd-surface transition-[width,transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
          >
          {rightPanelCollapsed ? (
          <div className="flex h-full w-12 flex-col items-center py-3">
            <button
              onClick={() => setRightPanelCollapsed(false)}
              title="展开任务监控"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-rd-textMuted transition hover:bg-rd-surfaceHover hover:text-rd-primary"
            >
              <PanelRightOpen size={18} />
            </button>
          </div>
          ) : (
            <div className="h-full w-full rd-panel-slide-in">
              <TaskMonitorPanel
                messages={messages ?? []}
                onCollapse={() => setRightPanelCollapsed(true)}
              />
            </div>
          )}
          </div>
        </>
      )}
    </div>
  );
}
