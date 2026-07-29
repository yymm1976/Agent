// desktop/renderer/src/components/settings/SettingsNav.tsx
// 设置页左侧标签导航栏（Phase 88 重构：8 tab，3 分组，突出重点）
// 从 29 个 tab 精简到 8 个，每 tab 内部按 Card 分区

import {
  Server, Palette, Shield, Zap, Users, Plug, BarChart3,
} from 'lucide-react';

/**
 * 设置页所有 Tab id（Phase 88 重构后精简到 8 个）
 *
 * 合并历史：
 * - 模型与路由 ← providers + router
 * - 外观与交互 ← appearance + conversation + persona
 * - 安全与治理 ← security + policies + phase52/53 + expertise + configLayering + resultSchema + packs
 * - 执行与记忆 ← execution + memory
 * - Agent 编排 ← goal + experiment + reviewer + delegation + subagents + commands
 * - 插件生态 ← mcp + skills + hooks + codemap + market
 * - 统计与归档 ← optimization + archived
 * - 关于 ← about
 */
export type TabId =
  | 'models' | 'appearance' | 'security' | 'execution'
  | 'orchestration' | 'plugins' | 'misc' | 'about';

interface SettingsNavProps {
  /** 当前激活的 Tab id */
  activeTab: TabId;
  /** 切换 Tab handler */
  setActiveTab: (tab: TabId) => void;
}

interface NavItem {
  id: TabId;
  label: string;
  icon: typeof Server;
  desc: string;
}

/**
 * 按 3 个分组组织，核心配置突出在顶部
 */
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '常用',
    items: [
      { id: 'models', label: '模型与路由', icon: Server, desc: '连接模型，决定怎么选用' },
      { id: 'appearance', label: '外观与对话', icon: Palette, desc: '主题、字体和对话方式' },
      { id: 'security', label: '安全与权限', icon: Shield, desc: '哪些操作可以自动执行' },
      { id: 'execution', label: '执行与记忆', icon: Zap, desc: '任务恢复和记忆' },
    ],
  },
  {
    title: '按需使用',
    items: [
      { id: 'orchestration', label: '执行自动化', icon: Users, desc: '任务执行和确认方式' },
      { id: 'plugins', label: '工具与扩展', icon: Plug, desc: 'MCP、技能和插件' },
    ],
  },
  {
    title: '数据',
    items: [
      { id: 'misc', label: '数据与归档', icon: BarChart3, desc: '查看用量、管理归档' },
    ],
  },
];

/**
 * 设置页左侧标签导航栏
 * 8 个 tab 按 3 分组扁平展示，核心配置在顶部突出
 */
export function SettingsNav({ activeTab, setActiveTab }: SettingsNavProps) {
  return (
    <nav className="w-48 shrink-0 flex flex-col gap-1 overflow-y-auto py-1">
      {NAV_GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-0.5">
          <div className="px-3 pt-2 pb-1 text-xs font-medium text-rd-textMuted/70 uppercase tracking-wider">
            {group.title}
          </div>
          {group.items.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors text-left ${
                  active
                    ? 'bg-rd-surfaceHighlight text-rd-text font-medium'
                    : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text'
                }`}
              >
                <Icon size={16} className="mt-0.5 shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="truncate">{tab.label}</span>
                  <span className={`text-xs truncate ${active ? 'text-rd-textMuted' : 'text-rd-textMuted/60'}`}>
                    {tab.desc}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
