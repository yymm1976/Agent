// desktop/renderer/src/pages/NewTaskPage.tsx
// 新建任务页面：居中输入框 + 下方项目文件夹选择器
// 用户发送第一条消息后才真正创建对话，避免空白对话堆积
// 不发送消息直接切换走，不保存任何内容

import { useState, useRef, useEffect } from 'react';
import { Send, FolderOpen, ChevronDown, FolderPlus, Sparkles } from 'lucide-react';
import { Textarea } from '../components/ui/textarea.js';
import { Button } from '../components/ui/button.js';
import { useProjectsStore } from '../store/useProjectsStore.js';

interface NewTaskPageProps {
  /** 预选项目 ID（来自项目右侧+按钮），未传则默认"未分类" */
  initialProjectId?: string;
  /** 发送消息：text 为用户输入，projectId 为选中的目标项目（null 表示未分类） */
  onSend: (text: string, projectId: string) => void;
  /** 取消新建，返回当前对话 */
  onCancel: () => void;
}

export function NewTaskPage({ initialProjectId, onSend, onCancel }: NewTaskPageProps) {
  const { projects, addProject, ensureDefaultProject } = useProjectsStore();
  const [input, setInput] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectId ?? '');
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 进入页面自动聚焦输入框
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // 点击外部关闭项目下拉菜单
  useEffect(() => {
    if (!projectMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setProjectMenuOpen(false);
      }
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [projectMenuOpen]);

  // 提交消息
  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    // 确定目标项目：选了用选的，没选用"未分类"
    const targetProjectId = selectedProjectId || ensureDefaultProject();
    onSend(trimmed, targetProjectId);
  };

  // 选择文件夹新建项目
  const handleSelectFolder = async () => {
    const folderPath = await window.routedev.fs.selectFolder();
    if (!folderPath) return;
    const projectName = folderPath.replace(/\\/g, '/').split('/').pop() || '新项目';
    const newProjectId = addProject(projectName, folderPath);
    setSelectedProjectId(newProjectId);
    setProjectMenuOpen(false);
  };

  // 选中的项目名（用于按钮显示）
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const projectLabel = selectedProject
    ? selectedProject.name
    : '未分类（不关联项目文件夹）';

  // 键盘快捷键：Enter 发送，Shift+Enter 换行，Escape 取消
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="flex h-full flex-col bg-rd-surface">
      {/* 顶部标题栏 */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-rd-border px-6">
        <Sparkles size={18} className="text-rd-primary" />
        <span className="text-base font-semibold text-rd-text">新建任务</span>
        <span className="ml-2 text-xs text-rd-textSubtle">输入问题开始一段新对话</span>
      </div>

      {/* 居中内容区 */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
        <div className="flex w-full max-w-3xl flex-col gap-4">
          {/* 输入框卡片 */}
          <div className="rounded-2xl border border-rd-border bg-rd-background shadow-rdMd focus-within:border-rd-primary/40">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="描述你的任务... Enter 发送 · Shift+Enter 换行 · Esc 取消"
              rows={8}
              className="min-h-[180px] resize-none border-0 bg-transparent px-5 py-4 text-base leading-7 shadow-none focus-visible:ring-0"
            />
            {/* 底部操作栏 */}
            <div className="flex items-center justify-between gap-3 border-t border-rd-border px-3 py-2.5">
              {/* 项目选择器 */}
              <div className="relative min-w-0" ref={menuRef}>
                <button
                  type="button"
                  onClick={() => setProjectMenuOpen(!projectMenuOpen)}
                  className="flex h-9 max-w-full items-center gap-2 rounded-xl border border-rd-border bg-rd-surface px-3 text-sm text-rd-textMuted transition hover:border-rd-borderHover hover:bg-rd-surfaceHover hover:text-rd-text"
                  title="选择关联项目"
                >
                  <FolderOpen size={15} className="shrink-0" />
                  <span className="truncate">{projectLabel}</span>
                  <ChevronDown size={14} className="shrink-0" />
                </button>
                {projectMenuOpen && (
                  <div className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-72 overflow-y-auto rounded-xl border border-rd-border bg-rd-background p-1 shadow-rdLg">
                    {/* 未分类选项 */}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedProjectId('');
                        setProjectMenuOpen(false);
                      }}
                      className={[
                        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition',
                        !selectedProjectId
                          ? 'bg-rd-primary/10 font-medium text-rd-primary'
                          : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
                      ].join(' ')}
                    >
                      <FolderOpen size={14} className="shrink-0 opacity-60" />
                      <span className="truncate">未分类（不关联项目文件夹）</span>
                    </button>
                    {/* 已有项目列表 */}
                    {projects.length > 0 && (
                      <div className="my-1 border-t border-rd-border" />
                    )}
                    {projects.map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        onClick={() => {
                          setSelectedProjectId(p.id);
                          setProjectMenuOpen(false);
                        }}
                        className={[
                          'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition',
                          selectedProjectId === p.id
                            ? 'bg-rd-primary/10 font-medium text-rd-primary'
                            : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
                        ].join(' ')}
                      >
                        <FolderOpen size={14} className="shrink-0 opacity-60" />
                        <span className="truncate">{p.name}</span>
                        {p.path && (
                          <span className="ml-auto shrink-0 text-xs text-rd-textSubtle" title={p.path}>
                            {p.path.replace(/\\/g, '/').split('/').pop()}
                          </span>
                        )}
                      </button>
                    ))}
                    {/* 分隔线 + 选择文件夹新建项目 */}
                    <div className="my-1 border-t border-rd-border" />
                    <button
                      type="button"
                      onClick={handleSelectFolder}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rd-primary transition hover:bg-rd-primary/10"
                    >
                      <FolderPlus size={14} className="shrink-0" />
                      <span>选择文件夹新建项目</span>
                    </button>
                  </div>
                )}
              </div>

              {/* 发送按钮 */}
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={!input.trim()}
                className="h-9 shrink-0 rounded-xl px-5"
              >
                <Send size={15} />
                <span>发送</span>
              </Button>
            </div>
          </div>

          {/* 提示文案 */}
          <p className="text-center text-xs text-rd-textSubtle">
            发送后将自动创建对话{selectedProjectId ? `并关联到「${selectedProject?.name}」` : '，不关联项目文件夹'}
            <button
              onClick={onCancel}
              className="ml-2 text-rd-primary hover:underline"
            >
              取消新建
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
