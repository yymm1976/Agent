// desktop/renderer/src/components/settings/SettingsAppearanceTab.tsx
// Phase 74-G：外观设置 Tab（主题配色 + 主题色 + 字体大小 + UI 提示 + 通用 + UI 设置）
// 从 SettingsPage.tsx 迁移

import type { AppConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';
import { Input } from '../ui/input.js';
import { SettingsAdvancedSection } from './SettingsAdvancedSection.js';

interface SettingsAppearanceTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新通用配置 */
  updateGeneral: (patch: Partial<AppConfig['general']>) => void;
  /** 更新 UI 配置 */
  updateUi: (patch: Partial<AppConfig['ui']>) => void;
  /** 更新后台行为配置 */
  updateBackgroundBehavior: (patch: Partial<AppConfig['general']['backgroundBehavior']>) => void;
  /** 更新更新策略配置 */
  updateUpdates: (patch: Partial<AppConfig['updates']>) => void;
}

/**
 * 外观设置 Tab
 * 包含：主题配色、主题色（accent color）、字体大小、UI 提示、通用（语言/启动/退出/更新）、UI 设置
 */
export function SettingsAppearanceTab({
  draft,
  updateGeneral,
  updateUi,
  updateBackgroundBehavior,
  updateUpdates,
}: SettingsAppearanceTabProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>主题配色</CardTitle>
          <CardDescription>选择应用的整体配色方案</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {([
              { id: 'white', label: '白色', bg: '#ffffff', fg: '#0f172a', border: '#e2e8f0' },
              { id: 'black', label: '黑色', bg: '#0a0a0a', fg: '#fafafa', border: '#2a2a2a' },
              { id: 'gray', label: '灰色', bg: '#1f2937', fg: '#f3f4f6', border: '#374151' },
              { id: 'blue', label: '蓝色', bg: '#0c1a2e', fg: '#e0f2fe', border: '#1e3a5f' },
            ] as const).map((theme) => {
              const active = draft.general.appearanceTheme === theme.id;
              return (
                <button
                  key={theme.id}
                  onClick={() => updateGeneral({ appearanceTheme: theme.id })}
                  className={[
                    'flex flex-col items-center gap-2 rounded-lg p-3 transition',
                    active ? 'ring-2 ring-rd-primary/40' : 'hover:bg-rd-surfaceHover',
                  ].join(' ')}
                >
                  <div
                    className="flex h-16 w-full items-center justify-center rounded text-sm font-medium"
                    style={{ backgroundColor: theme.bg, color: theme.fg, border: `1px solid ${theme.border}` }}
                  >
                    {theme.label}
                  </div>
                  <span className="text-xs text-rd-textMuted">{theme.label}主题</span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* 主题色（accent color）选择器 */}
      <Card>
        <CardHeader>
          <CardTitle>主题色</CardTitle>
          <CardDescription>自定义应用的主色调，留空使用预设紫色</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            {/* 预设色块 */}
            {([
              { color: '#8b8dff', label: '紫色' },
              { color: '#6366f1', label: '靛蓝' },
              { color: '#3b82f6', label: '蓝色' },
              { color: '#10b981', label: '绿色' },
              { color: '#f59e0b', label: '橙色' },
              { color: '#ef4444', label: '红色' },
              { color: '#ec4899', label: '粉色' },
              { color: '#14b8a6', label: '青色' },
            ] as const).map((preset) => {
              const active = (draft.general.accentColor || '#8b8dff') === preset.color;
              return (
                <button
                  key={preset.color}
                  onClick={() => updateGeneral({ accentColor: preset.color })}
                  className={`flex flex-col items-center gap-1.5 rounded-lg p-2 transition ${
                    active ? 'ring-2 ring-offset-2 ring-offset-rd-surface' : 'hover:bg-rd-surfaceHover'
                  }`}
                  style={active ? { boxShadow: `0 0 0 2px ${preset.color}` } : undefined}
                  title={preset.label}
                >
                  <div
                    className="h-8 w-8 rounded-full"
                    style={{ backgroundColor: preset.color }}
                  />
                  <span className="text-[10px] text-rd-textMuted">{preset.label}</span>
                </button>
              );
            })}
          </div>
          {/* 自定义颜色选择器 */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-rd-textMuted">自定义：</label>
            <input
              type="color"
              value={draft.general.accentColor || '#8b8dff'}
              onChange={(e) => updateGeneral({ accentColor: e.target.value })}
              className="h-8 w-12 cursor-pointer rounded border border-rd-border bg-transparent"
            />
            <Input
              value={draft.general.accentColor}
              onChange={(e) => updateGeneral({ accentColor: e.target.value })}
              placeholder="#8b8dff（留空用预设）"
              className="w-40"
            />
            {draft.general.accentColor && (
              <button
                onClick={() => updateGeneral({ accentColor: '' })}
                className="text-xs text-rd-textMuted hover:text-rd-text"
              >
                重置
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>字体大小</CardTitle>
          <CardDescription>全局基准字号（{draft.general.fontSize}px）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <input
              type="range"
              min="12"
              max="24"
              step="1"
              value={draft.general.fontSize}
              onChange={(e) => updateGeneral({ fontSize: Number(e.target.value) })}
              className="w-full accent-rd-primary"
            />
            <div className="flex justify-between text-xs text-rd-textMuted">
              <span>12px</span>
              <span>14px</span>
              <span>16px</span>
              <span>18px</span>
              <span>20px</span>
              <span>22px</span>
              <span>24px</span>
            </div>
          </div>
          <div className="rounded-lg bg-rd-surfaceHover p-3">
            <span className="text-rd-text" style={{ fontSize: `${draft.general.fontSize}px` }}>
              预览：这是一段示例文字，字号 {draft.general.fontSize}px
            </span>
          </div>
        </CardContent>
      </Card>

      <SettingsAdvancedSection title="界面行为与更新" description="UI 提示开关、通用行为、后台行为、自动更新（已有默认值）">
      <Card>
        <CardHeader>
          <CardTitle>UI 提示</CardTitle>
          <CardDescription>配置变更时的界面提示开关</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="ui-hot-reload-notify">配置热重载提示</Label>
              <p className="text-xs text-rd-textMuted">暂未实现</p>
            </div>
            <Switch
              id="ui-hot-reload-notify"
              checked={draft.ui.hotReloadNotify}
              onCheckedChange={(checked) => updateUi({ hotReloadNotify: checked })}
              disabled
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>通用</CardTitle>
          <CardDescription>语言与启动行为</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="general-language">语言</Label>
            <Select
              id="general-language"
              value={draft.general.language}
              onChange={(e) => updateGeneral({ language: e.target.value as 'zh-CN' | 'en-US' })}
            >
              <SelectItem value="zh-CN">简体中文</SelectItem>
              <SelectItem value="en-US">English</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">界面与系统提示词的语言。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="general-startup">启动行为</Label>
            <Select
              id="general-startup"
              value={draft.general.startupBehavior}
              onChange={(e) => updateGeneral({ startupBehavior: e.target.value as 'restore' | 'project_select' })}
              disabled
            >
              <SelectItem value="restore">恢复上次会话</SelectItem>
              <SelectItem value="project_select">显示项目选择器</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>

          {/* 退出行为设置 */}
          <div className="space-y-2">
            <Label htmlFor="bg-behavior">关闭窗口时</Label>
            <Select
              id="bg-behavior"
              value={draft.general.backgroundBehavior.backgroundBehavior}
              onChange={(e) => {
                const val = e.target.value as 'exit' | 'minimize-to-tray' | 'ask';
                // exit 模式下 activeTaskOnClose 必须为 terminate
                if (val === 'exit') {
                  updateBackgroundBehavior({ backgroundBehavior: val, activeTaskOnClose: 'terminate' });
                } else {
                  updateBackgroundBehavior({ backgroundBehavior: val });
                }
              }}
            >
              <SelectItem value="exit">直接退出（杀掉后台进程）</SelectItem>
              <SelectItem value="minimize-to-tray">最小化到托盘</SelectItem>
              <SelectItem value="ask">每次询问（暂未实现，等同直接退出）</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">默认退出时杀掉所有后台进程（包括 LLM 请求和 MCP 连接），避免文件锁冲突。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bg-active-task">有活跃任务时</Label>
            <Select
              id="bg-active-task"
              value={draft.general.backgroundBehavior.activeTaskOnClose}
              onChange={(e) => updateBackgroundBehavior({ activeTaskOnClose: e.target.value as 'terminate' | 'continue-in-background' | 'prompt' })}
              disabled
            >
              <SelectItem value="terminate">终止任务</SelectItem>
              <SelectItem value="continue-in-background">后台继续</SelectItem>
              <SelectItem value="prompt">提示用户</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>

          {/* Phase 33 Task 3.1：更新策略 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="updates-check">启动时检查更新</Label>
              <p className="text-xs text-rd-textMuted">暂未实现</p>
            </div>
            <Switch
              id="updates-check"
              checked={draft.updates.checkOnStartup}
              onCheckedChange={(checked) => updateUpdates({ checkOnStartup: checked })}
              disabled
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="updates-auto">自动安装更新</Label>
              <p className="text-xs text-rd-textMuted">暂未实现</p>
            </div>
            <Switch
              id="updates-auto"
              checked={draft.updates.autoUpdate}
              onCheckedChange={(checked) => updateUpdates({ autoUpdate: checked })}
              disabled
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>UI 设置</CardTitle>
          <CardDescription>输出样式、终端提示与空闲提示</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ui-output-style">输出样式</Label>
            <Select
              id="ui-output-style"
              value={draft.ui.outputStyle}
              onChange={(e) => updateUi({ outputStyle: e.target.value as 'minimal' | 'standard' | 'verbose' })}
              disabled
            >
              <SelectItem value="minimal">摘要</SelectItem>
              <SelectItem value="standard">关键细节</SelectItem>
              <SelectItem value="verbose">完整数据</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="ui-bell">启用终端 Bell 通知</Label>
              <p className="text-xs text-rd-textMuted">暂未实现</p>
            </div>
            <Switch
              id="ui-bell"
              checked={draft.ui.bell}
              onCheckedChange={(checked) => updateUi({ bell: checked })}
              disabled
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ui-idle">空闲提示触发秒数</Label>
            <Input
              id="ui-idle"
              type="number"
              value={draft.ui.idleHintSeconds}
              onChange={(e) => updateUi({ idleHintSeconds: Number(e.target.value) })}
              disabled
            />
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>
        </CardContent>
      </Card>
      </SettingsAdvancedSection>
    </div>
  );
}
