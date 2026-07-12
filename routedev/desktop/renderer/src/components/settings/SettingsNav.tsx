// desktop/renderer/src/components/settings/SettingsNav.tsx
// Phase 74-G：设置页左侧标签导航栏（mainTabs + advancedTabs + 高级折叠）
// 从 SettingsPage.tsx 迁移

import {
  Server, Palette, Route, Zap, Plug, GraduationCap, Sparkles, Radio,
  Target, FileText, BookOpen, Webhook, Brain, BarChart3, Map as MapIcon,
  Shield, ShoppingBag, Users, Gauge, ShieldCheck, Split, CheckCircle2,
  Folder, Archive, Info, ChevronDown, ChevronRight, Layers,
} from 'lucide-react';

/** 设置页所有 Tab id（mainTabs + advancedTabs） */
export type TabId =
  | 'providers' | 'router' | 'security'
  | 'commands' | 'optimization' | 'execution' | 'memory'
  | 'mcp' | 'skills' | 'channels' | 'appearance' | 'sounds' | 'archived' | 'about'
  | 'codemap' | 'hooks' | 'expertise'
  | 'policies' | 'market' | 'subagents'
  | 'persona' | 'voice'
  | 'conversation' | 'experiment'
  | 'goal'
  // Phase 51 新增 tab
  | 'reviewer' | 'delegation'
  // Phase 52 配置补 UI 入口（I-1）
  | 'resultSchema' | 'configLayering'
  // Phase 53 集成 tab（Phase 60 合并 Phase 52）
  | 'phase53Integration'
  // Phase 81 Task 5：能力分层（Core / Extended / Standard / Freeze）
  | 'packs';

interface SettingsNavProps {
  /** 当前激活的 Tab id */
  activeTab: TabId;
  /** 切换 Tab handler */
  setActiveTab: (tab: TabId) => void;
  /** 高级设置折叠状态 */
  advancedExpanded: boolean;
  /** 切换高级设置折叠状态 */
  setAdvancedExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
}

/**
 * 设置页左侧标签导航栏
 * Tab 分组：常用 → 不常用 → 高级设置（折叠）
 *  - 常用：模型配置、外观、路由、执行、插件MCP、提示音
 *  - 不常用：Skill、记忆检查点、可观测性、命令工具
 *  - 高级：安全设置、渠道集成、归档对话、关于
 */
export function SettingsNav({ activeTab, setActiveTab, advancedExpanded, setAdvancedExpanded }: SettingsNavProps) {
  const mainTabs = [
    { id: 'providers', label: '模型配置', icon: Server },
    { id: 'appearance', label: '外观', icon: Palette },
    { id: 'router', label: '路由规则', icon: Route },
    { id: 'execution', label: '执行', icon: Zap },
    { id: 'mcp', label: '插件与 MCP (Pack)', icon: Plug },
    // CLI 退役遗留，桌面端不消费 — 隐藏 Tab（sounds 配置运行时无消费方）
    // { id: 'sounds', label: '提示音', icon: Bell },
    { id: 'expertise', label: '引导 (Freeze)', icon: GraduationCap },
    { id: 'persona', label: '角色设定', icon: Sparkles },
    { id: 'voice', label: '语音', icon: Radio },
    { id: 'goal', label: '目标流程 (Pack)', icon: Target },
    { id: 'conversation', label: '对话', icon: FileText },
    { id: 'skills', label: '技能', icon: BookOpen },
    { id: 'hooks', label: '钩子', icon: Webhook },
    { id: 'memory', label: '记忆', icon: Brain },
    { id: 'optimization', label: '统计', icon: BarChart3 },
    { id: 'commands', label: '命令与工具', icon: Target },
    { id: 'codemap', label: '代码地图 (Pack)', icon: MapIcon },
    { id: 'policies', label: '策略引擎', icon: Shield },
    { id: 'market', label: '市场', icon: ShoppingBag },
    { id: 'subagents', label: '子 Agent (Pack)', icon: Users },
  ] as const;

  const advancedTabs = [
    { id: 'experiment', label: '并行实验', icon: Gauge },
    { id: 'reviewer', label: '代码审查', icon: ShieldCheck },
    { id: 'delegation', label: '任务委托', icon: Split },
    { id: 'phase53Integration', label: '安全与治理', icon: ShieldCheck },
    { id: 'resultSchema', label: '结果格式', icon: CheckCircle2 },
    { id: 'configLayering', label: '配置分层', icon: Folder },
    { id: 'packs', label: '能力分层', icon: Layers },
    { id: 'security', label: '安全设置', icon: Shield },
    // CLI 退役遗留，桌面端不消费 — 隐藏 Tab（无 Webhook 服务器消费 channels 配置）
    // { id: 'channels', label: '渠道', icon: Radio },
    { id: 'archived', label: '归档', icon: Archive },
    { id: 'about', label: '关于', icon: Info },
  ] as const;

  return (
    <nav className="w-40 shrink-0 flex flex-col gap-1 overflow-y-auto py-2">
      {/* 常用 + 不常用 Tab */}
      {mainTabs.map((tab) => {
        const Icon = tab.icon;
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as TabId)}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
              active
                ? 'bg-rd-surfaceHighlight text-rd-text font-medium'
                : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text'
            }`}
          >
            <Icon size={16} />
            <span className="truncate">{tab.label}</span>
          </button>
        );
      })}

      {/* 高级设置标题行（点击展开/折叠，无分隔线，与 mainTabs 同级） */}
      <button
        type="button"
        onClick={() => setAdvancedExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 pt-2 pb-1 text-xs text-rd-textMuted hover:text-rd-text"
      >
        {advancedExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>高级</span>
      </button>

      {/* 高级设置子项（展开时显示，样式与 mainTabs 完全一致） */}
      {advancedExpanded && (
        <div className="flex flex-col gap-1">
          {advancedTabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabId)}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-rd-surfaceHighlight text-rd-text font-medium'
                    : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text'
                }`}
              >
                <Icon size={16} />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </nav>
  );
}
