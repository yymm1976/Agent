// desktop/renderer/src/components/DiscoveryPage.tsx
// 发现页：全屏覆盖层，展示推荐任务与最近对话，引导用户下一步操作。

import {
  X,
  Plus,
  Settings,
  Clock,
  MessageSquare,
  FlaskConical,
  FileText,
  ShieldCheck,
  Braces,
  Package,
  Network,
  GitCompare,
  GitBranch,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

export interface SuggestedTask {
  icon: string; // lucide icon name
  title: string;
  description: string;
  prompt: string;
}

export interface RecentConversation {
  id: string;
  title: string;
  lastActiveAt: number;
  messageCount: number;
}

export interface DiscoveryPageProps {
  open: boolean;
  onClose: () => void;
  recentConversations: RecentConversation[];
  suggestedTasks: SuggestedTask[];
  onSelectTask: (prompt: string) => void;
  onSelectConversation: (id: string) => void;
  onNewTask: () => void;
  onOpenSettings: () => void;
}

/** 图标名 → 组件映射 */
const ICON_MAP: Record<string, LucideIcon> = {
  FlaskConical,
  FileText,
  ShieldCheck,
  Braces,
  Package,
  Network,
  GitCompare,
  GitBranch,
  Sparkles,
};

function getIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Sparkles;
}

/** 项目类型 */
export type ProjectType = 'typescript' | 'python' | 'unknown';

/**
 * 根据项目类型生成推荐任务。
 * - TypeScript：添加单元测试、生成 API 文档、检查依赖安全
 * - Python：添加类型注解、生成 requirements.txt
 * - 通用：解释项目架构、审查代码变更、开启分支实验
 */
export function generateSuggestedTasks(projectType: ProjectType): SuggestedTask[] {
  const tasks: SuggestedTask[] = [];

  if (projectType === 'typescript') {
    tasks.push(
      {
        icon: 'FlaskConical',
        title: '添加单元测试',
        description: '为核心模块补充单元测试，提升覆盖率',
        prompt: '为核心模块添加单元测试，优先覆盖最近修改的逻辑',
      },
      {
        icon: 'FileText',
        title: '生成 API 文档',
        description: '从代码注释抽取并生成 API 参考文档',
        prompt: '根据当前代码生成 API 文档',
      },
      {
        icon: 'ShieldCheck',
        title: '检查依赖安全',
        description: '扫描依赖中的已知漏洞并给出升级建议',
        prompt: '检查项目依赖的安全漏洞并给出升级建议',
      },
    );
  } else if (projectType === 'python') {
    tasks.push(
      {
        icon: 'Braces',
        title: '添加类型注解',
        description: '为函数与变量补充类型注解，便于静态检查',
        prompt: '为当前项目的函数和变量添加类型注解',
      },
      {
        icon: 'Package',
        title: '生成 requirements.txt',
        description: '根据导入语句整理依赖清单',
        prompt: '根据项目实际导入生成 requirements.txt',
      },
    );
  }

  // 通用推荐
  tasks.push(
    {
      icon: 'Network',
      title: '解释项目架构',
      description: '梳理核心模块与数据流，给出架构概览',
      prompt: '请解释当前项目的核心架构',
    },
    {
      icon: 'GitCompare',
      title: '审查代码变更',
      description: '审查当前分支相对主干的代码变更',
      prompt: '审查当前分支的代码变更',
    },
    {
      icon: 'GitBranch',
      title: '开启分支实验',
      description: '在隔离分支上尝试新的实现方案',
      prompt: '为当前需求开启一个实验分支，尝试新的实现方案',
    },
  );

  return tasks;
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}

export function DiscoveryPage(props: DiscoveryPageProps) {
  const {
    open,
    onClose,
    recentConversations,
    suggestedTasks,
    onSelectTask,
    onSelectConversation,
    onNewTask,
    onOpenSettings,
  } = props;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center animate-fade-in"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.45)' }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl max-h-[88vh] overflow-hidden rounded-xl border border-rd-border bg-rd-background shadow-rdXl animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题区 */}
        <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-rd-border">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-rd bg-rd-surfaceHighlight text-rd-primary">
              <Sparkles size={20} />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-rd-text">发现</h2>
              <p className="text-sm text-rd-textMuted">
                根据你的项目与习惯，推荐下一步
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-rd text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text transition-colors"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* 可滚动内容区 */}
        <div className="overflow-y-auto px-6 py-5" style={{ maxHeight: 'calc(88vh - 160px)' }}>
          {/* 推荐任务区 */}
          <section>
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-rd-textSubtle">
              推荐任务
            </h3>
            {suggestedTasks.length === 0 ? (
              <p className="text-sm text-rd-textMuted">暂无推荐</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {suggestedTasks.map((task, idx) => {
                  const Icon = getIcon(task.icon);
                  return (
                    <button
                      key={`${task.title}-${idx}`}
                      type="button"
                      onClick={() => onSelectTask(task.prompt)}
                      className="group flex items-start gap-3 p-4 rounded-xl border border-rd-border bg-rd-surface text-left hover:border-rd-primary hover:shadow-rdMd transition-all"
                    >
                      <div className="flex items-center justify-center w-9 h-9 shrink-0 rounded-rd bg-rd-surfaceHighlight text-rd-primary group-hover:bg-rd-primary group-hover:text-rd-primaryForeground transition-colors">
                        <Icon size={18} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-rd-text">{task.title}</div>
                        <div className="mt-0.5 text-xs text-rd-textMuted line-clamp-2">
                          {task.description}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* 最近对话区 */}
          <section className="mt-6">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-rd-textSubtle">
              最近对话
            </h3>
            {recentConversations.length === 0 ? (
              <p className="text-sm text-rd-textMuted">还没有对话记录</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {recentConversations.map((conv) => (
                  <li key={conv.id}>
                    <button
                      type="button"
                      onClick={() => onSelectConversation(conv.id)}
                      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-rd text-left hover:bg-rd-surfaceHover transition-colors"
                    >
                      <MessageSquare size={16} className="shrink-0 text-rd-textSubtle" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-rd-text truncate">{conv.title}</div>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-rd-textMuted">
                          <Clock size={12} />
                          <span>{formatTime(conv.lastActiveAt)}</span>
                          <span>·</span>
                          <span>{conv.messageCount} 条消息</span>
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* 底部操作区 */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-rd-border bg-rd-surface">
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-rd text-sm text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text transition-colors"
          >
            <Settings size={16} />
            设置
          </button>
          <button
            type="button"
            onClick={onNewTask}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-rd bg-rd-primary text-rd-primaryForeground text-sm font-medium hover:bg-rd-primaryHover transition-colors shadow-rdSm"
          >
            <Plus size={16} />
            新建任务
          </button>
        </div>
      </div>
    </div>
  );
}
