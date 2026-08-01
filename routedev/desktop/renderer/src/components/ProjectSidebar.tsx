// desktop/renderer/src/components/ProjectSidebar.tsx
// 项目侧边栏：项目树 + 对话列表 + 展开/收起 + 新建任务入口 + 右键菜单 + 拖拽重排序
// 顶部含设置图标 + 缩进按钮
// 新建对话统一走"新建任务"页面，避免空白对话堆积

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Settings, Plus, ChevronRight, ChevronDown, Folder, FolderOpen, MessageSquare,
  Trash2, Edit3, Sparkles, PanelLeftClose, Archive, FolderSearch, Search,
} from 'lucide-react';
import { useProjectsStore } from '../store/useProjectsStore.js';
import { Button } from './ui/button.js';
import { ConfirmDialog } from './ui/dialog.js';
import { SearchCommandPalette } from './SearchCommandPalette.js';

interface ProjectSidebarProps {
  onOpenSettings: () => void;
  /** 打开新建任务页面，可传预选项目 ID */
  onOpenNewTask: (projectId?: string) => void;
  /** 从非 chat 页面返回 chat 页面（点击对话项时触发） */
  onNavigateToChat: () => void;
  /** 缩进侧边栏回调 */
  onCollapse: () => void;
}

// 右键菜单状态
interface ContextMenuState {
  x: number;
  y: number;
  type: 'project' | 'conversation';
  projectId: string;
  conversationId?: string;
}

// 重命名编辑状态
interface RenameState {
  type: 'project' | 'conversation';
  projectId: string;
  conversationId?: string;
  originalName: string;
}

export function ProjectSidebar({ onOpenSettings, onOpenNewTask, onNavigateToChat, onCollapse }: ProjectSidebarProps) {
  const {
    projects, currentProjectId, currentConversationId,
    renameProject, deleteProject, toggleProjectExpanded,
    reorderProjects, setProjectPath,
    renameConversation, archiveConversation, deleteConversation,
    reorderConversations, selectConversation,
  } = useProjectsStore();

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Phase 74-H2：搜索命令面板开关状态
  const [searchOpen, setSearchOpen] = useState(false);
  // 确认对话框状态（替代原生 confirm()，避免 frame:false 窗口失焦 bug）
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    variant: 'default' | 'danger';
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', variant: 'default', onConfirm: () => {} });

  // Phase 74-H2：全局 ⌘K/Ctrl+K 快捷键触发搜索命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 拖拽状态
  const [dragType, setDragType] = useState<'project' | 'conversation' | null>(null);
  const [dragProjectId, setDragProjectId] = useState<string | null>(null);
  const [dragConvId, setDragConvId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // 重命名输入框自动聚焦
  useEffect(() => {
    if (rename && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [rename]);

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [contextMenu]);

  // === 更改项目文件夹 ===
  const handleChangeProjectPath = async (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    const folderPath = await window.routedev.fs.selectFolder(project?.path);
    if (folderPath) {
      setProjectPath(projectId, folderPath);
      window.routedev.project.setCwd(folderPath);
    }
    setContextMenu(null);
  };

  // === 右键菜单处理 ===
  const handleProjectContextMenu = (e: React.MouseEvent, projectId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'project', projectId });
  };

  const handleConvContextMenu = (
    e: React.MouseEvent,
    projectId: string,
    conversationId: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'conversation', projectId, conversationId });
  };

  // === 重命名处理 ===
  const startRename = (state: RenameState) => {
    setRename(state);
    setRenameValue(state.originalName);
    setContextMenu(null);
  };

  const confirmRename = () => {
    if (!rename) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRename(null);
      return;
    }
    if (rename.type === 'project') {
      renameProject(rename.projectId, trimmed);
    } else if (rename.conversationId) {
      renameConversation(rename.projectId, rename.conversationId, trimmed);
    }
    setRename(null);
  };

  const cancelRename = () => setRename(null);

  // === 归档/删除处理 ===
  const handleArchive = () => {
    if (!contextMenu || contextMenu.type !== 'conversation' || !contextMenu.conversationId) return;
    archiveConversation(contextMenu.projectId, contextMenu.conversationId);
    setContextMenu(null);
  };

  const handleDeleteProject = () => {
    if (!contextMenu || contextMenu.type !== 'project') return;
    const projectId = contextMenu.projectId;
    setContextMenu(null);
    setConfirmState({
      open: true,
      title: '删除项目',
      message: '确定删除该项目及其所有对话吗？',
      variant: 'danger',
      onConfirm: () => {
        deleteProject(projectId);
        setConfirmState((s) => ({ ...s, open: false }));
      },
    });
  };

  // === 拖拽重排序 ===
  const handleProjectDragStart = (e: React.DragEvent, index: number) => {
    setDragType('project');
    setDragProjectId(projects[index].id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleConvDragStart = (
    e: React.DragEvent,
    projectId: string,
    convId: string,
  ) => {
    e.stopPropagation();
    setDragType('conversation');
    setDragProjectId(projectId);
    setDragConvId(convId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleProjectDragOver = (e: React.DragEvent, index: number) => {
    if (dragType !== 'project') return;
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleConvDragOver = (e: React.DragEvent, projectId: string, index: number) => {
    if (dragType !== 'conversation' || dragProjectId !== projectId) return;
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleProjectDrop = (e: React.DragEvent, toIndex: number) => {
    if (dragType !== 'project') return;
    e.preventDefault();
    const fromIndex = projects.findIndex((p) => p.id === dragProjectId);
    if (fromIndex >= 0 && fromIndex !== toIndex) {
      reorderProjects(fromIndex, toIndex);
    }
    setDragType(null);
    setDragProjectId(null);
    setDragOverIndex(null);
  };

  const handleConvDrop = (e: React.DragEvent, projectId: string, toIndex: number) => {
    if (dragType !== 'conversation' || dragProjectId !== projectId) return;
    e.preventDefault();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const fromIndex = project.conversations.findIndex((c) => c.id === dragConvId);
    if (fromIndex >= 0 && fromIndex !== toIndex) {
      reorderConversations(projectId, fromIndex, toIndex);
    }
    setDragType(null);
    setDragProjectId(null);
    setDragConvId(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragType(null);
    setDragProjectId(null);
    setDragConvId(null);
    setDragOverIndex(null);
  };

  return (
    <div className="flex h-full flex-col bg-rd-surface">
      {/* 顶部：标题 + 设置 + 缩进，参考桌面工作台的轻量导航 */}
      <div className="flex h-12 shrink-0 items-center gap-1 px-3">
          <span className="flex-1 text-sm font-semibold tracking-tight text-rd-text">工作区</span>
        <button
          onClick={onOpenSettings}
          title="设置"
          className="flex h-8 w-8 items-center justify-center rounded-md text-rd-textMuted transition hover:bg-rd-surfaceHover hover:text-rd-text"
        >
          <Settings size={15} />
        </button>
        <button
          onClick={onCollapse}
          title="缩进侧边栏"
          className="flex h-8 w-8 items-center justify-center rounded-md text-rd-textMuted transition hover:bg-rd-surfaceHover hover:text-rd-text"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* Phase 74-H2：搜索触发器（侧边栏双入口之一，另一个是 ⌘K 快捷键） */}
      <div className="shrink-0 px-2 pb-2">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          title="搜索对话（⌘K）"
          className="flex h-8 w-full items-center gap-2 rounded-md border border-transparent bg-rd-surfaceHover px-2.5 text-xs text-rd-textSubtle transition hover:border-rd-border hover:text-rd-text"
        >
          <Search size={13} />
          <span className="flex-1 text-left">搜索对话...</span>
          <kbd className="rounded border border-rd-border bg-rd-surface px-1 py-0.5 text-[10px] text-rd-textSubtle">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* 项目列表区 */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {projects.map((project, pIdx) => {
          const isCurrentProject = project.id === currentProjectId;
          return (
            <div
              key={project.id}
              draggable={rename?.type !== 'project' || rename.projectId !== project.id}
              onDragStart={(e) => handleProjectDragStart(e, pIdx)}
              onDragOver={(e) => handleProjectDragOver(e, pIdx)}
              onDrop={(e) => handleProjectDrop(e, pIdx)}
              onDragEnd={handleDragEnd}
              onContextMenu={(e) => handleProjectContextMenu(e, project.id)}
              className={[
                'mb-1 transition',
                dragOverIndex === pIdx && dragType === 'project'
                  ? 'bg-rd-primary/10 rounded-xl'
                  : '',
              ].join(' ')}
            >
              {/* 项目标题行 */}
              <div className={[
                'group relative flex h-8 items-center gap-1.5 rounded-md px-2',
                isCurrentProject ? 'text-rd-text' : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
              ].join(' ')}>

                <button
                  onClick={() => toggleProjectExpanded(project.id)}
                  className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded text-rd-textMuted hover:text-rd-text"
                >
                  {project.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                {project.path ? (
                  <FolderOpen size={16} className="relative shrink-0 text-rd-primary/70" />
                ) : (
                  <Folder size={16} className="relative shrink-0 text-rd-primary/70" />
                )}
                {rename?.type === 'project' && rename.projectId === project.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={confirmRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmRename();
                      if (e.key === 'Escape') cancelRename();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="relative min-w-0 flex-1 rounded border border-rd-primary bg-rd-background px-1 py-0.5 text-sm text-rd-text outline-none"
                  />
                ) : (
                  <span
                    className={[
                      'relative min-w-0 flex-1 truncate text-sm',
                      isCurrentProject ? 'font-semibold text-rd-text' : 'font-medium text-rd-textMuted',
                    ].join(' ')}
                    title={project.path || undefined}
                  >
                    {project.name}
                  </span>
                )}
                {/* 加号：跳转到新建任务页面，预选当前项目 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenNewTask(project.id);
                  }}
                  title="新建任务"
                  className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-rd-textSubtle opacity-60 transition hover:bg-rd-surfaceHighlight hover:text-rd-primary group-hover:opacity-100"
                >
                  <Plus size={14} />
                </button>
              </div>

              {/* 对话列表（展开时） */}
              {project.expanded && (
                <div className="ml-5 mt-0.5">
                  {project.conversations.map((conv, cIdx) => {
                    const isCurrent = conv.id === currentConversationId;
                    const isEmpty = conv.messages.length === 0;
                    return (
                      <div
                        key={conv.id}
                        draggable={rename?.conversationId !== conv.id}
                        onDragStart={(e) => handleConvDragStart(e, project.id, conv.id)}
                        onDragOver={(e) => handleConvDragOver(e, project.id, cIdx)}
                        onDrop={(e) => handleConvDrop(e, project.id, cIdx)}
                        onDragEnd={handleDragEnd}
                        onContextMenu={(e) => handleConvContextMenu(e, project.id, conv.id)}
                        onClick={() => {
                          selectConversation(project.id, conv.id);
                          // 点击对话项时返回 chat 页面（处理从 newtask 页面返回的场景）
                          onNavigateToChat();
                        }}
                        className={[
                          'group relative flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 transition',
                          isCurrent
                            ? 'bg-rd-surfaceHighlight text-rd-text'
                            : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
                          dragOverIndex === cIdx && dragType === 'conversation'
                            ? 'bg-rd-primary/10'
                            : '',
                        ].join(' ')}
                      >
                        <MessageSquare size={14} className="relative shrink-0 opacity-60" />
                        {rename?.conversationId === conv.id ? (
                          <input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={confirmRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') confirmRename();
                              if (e.key === 'Escape') cancelRename();
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="relative min-w-0 flex-1 rounded border border-rd-primary bg-rd-background px-1 py-0.5 text-sm text-rd-text outline-none"
                          />
                        ) : (
                          <span className={[
                            'relative min-w-0 flex-1 truncate text-sm',
                            isEmpty ? 'italic opacity-60' : '',
                          ].join(' ')}>
                            {conv.title}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {project.conversations.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-rd-textSubtle">
                      暂无对话，点击 + 新建任务
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部：新建任务按钮 */}
      <div className="shrink-0 p-2">
        <Button
          onClick={() => onOpenNewTask()}
          variant="outline"
          className="h-9 w-full rounded-lg"
        >
          <Sparkles size={16} />
          新建任务
        </Button>
      </div>

      {/* 右键菜单：通过 portal 渲染到 document.body，避免被父级 rd-panel-slide-in 的 transform 包含块和 overflow-hidden 裁剪 */}
      {contextMenu && createPortal(
        <div
          className="rd-popover-enter fixed z-[9999] min-w-[160px] rounded-lg border border-rd-border bg-rd-background py-1 shadow-rdLg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'project' && (
            <>
              <button
                onClick={() => {
                  onOpenNewTask(contextMenu.projectId);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rd-text hover:bg-rd-surfaceHover"
              >
                <Plus size={14} /> 新建任务
              </button>
              <button
                onClick={() => handleChangeProjectPath(contextMenu.projectId)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rd-text hover:bg-rd-surfaceHover"
              >
                <FolderSearch size={14} /> {projects.find(p => p.id === contextMenu.projectId)?.path ? '更改文件夹' : '关联文件夹'}
              </button>
              <div className="my-1 border-t border-rd-border" />
            </>
          )}
          <button
            onClick={() => {
              const proj = projects.find((p) => p.id === contextMenu.projectId);
              const conv = contextMenu.conversationId
                ? proj?.conversations.find((c) => c.id === contextMenu.conversationId)
                : undefined;
              startRename({
                type: contextMenu.type,
                projectId: contextMenu.projectId,
                conversationId: contextMenu.conversationId,
                originalName: conv?.title ?? proj?.name ?? '',
              });
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rd-text hover:bg-rd-surfaceHover"
          >
            <Edit3 size={14} /> 重命名
          </button>
          {contextMenu.type === 'conversation' ? (
            <>
              <button
                onClick={handleArchive}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rd-textMuted hover:bg-rd-surfaceHover"
              >
                <Archive size={14} /> 归档
              </button>
              <button
                onClick={() => {
                  const projectId = contextMenu.projectId;
                  const convId = contextMenu.conversationId!;
                  setContextMenu(null);
                  setConfirmState({
                    open: true,
                    title: '永久删除对话',
                    message: '永久删除该对话？此操作不可恢复。',
                    variant: 'danger',
                    onConfirm: () => {
                      deleteConversation(projectId, convId);
                      setConfirmState((s) => ({ ...s, open: false }));
                    },
                  });
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rd-danger hover:bg-rd-danger/10"
              >
                <Trash2 size={14} /> 永久删除
              </button>
            </>
          ) : (
            <button
              onClick={handleDeleteProject}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-rd-danger hover:bg-rd-danger/10"
            >
              <Trash2 size={14} /> 删除项目
            </button>
          )}
        </div>,
        document.body,
      )}

      {/* Phase 74-H2：搜索命令面板（⌘K 触发，双入口之一） */}
      <SearchCommandPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={(projectId, convId) => {
          selectConversation(projectId, convId);
          onNavigateToChat();
        }}
      />

      {/* 确认对话框（替代原生 confirm()，避免 frame:false 窗口失焦 bug） */}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        variant={confirmState.variant}
        confirmText="删除"
        cancelText="取消"
        onConfirm={confirmState.onConfirm}
        onCancel={() => setConfirmState((s) => ({ ...s, open: false }))}
      />
    </div>
  );
}
