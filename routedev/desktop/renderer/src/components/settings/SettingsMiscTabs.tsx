// desktop/renderer/src/components/settings/SettingsMiscTabs.tsx
// Phase 74-G：3 个小块 Tab 合并文件（expertise / about / market）
// 从 SettingsPage.tsx 迁移，保留原逻辑与 UI

import { useState } from 'react';
import { Server, Sparkles, ShoppingBag, Snowflake } from 'lucide-react';
import type { AppConfig } from '../../../../shared/config-types.js';
import { getAppVersion } from '../../pages/settings-helpers.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Select, SelectItem } from '../ui/select.js';
import { Badge } from '../ui/badge.js';
import { Switch } from '../ui/switch.js';

// 应用版本号（从 package.json 读取，Phase 33 Task 3.4 修复硬编码）
const APP_VERSION = getAppVersion();

// ============================================================================
// 1. 用户体验 Tab
// ============================================================================

interface SettingsExpertiseTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 expertise 字段 */
  updateExpertise: (patch: Partial<AppConfig['expertise']>) => void;
}

/**
 * 用户体验 Tab
 * 包含：三级经验等级选择、自动建议开关、输出风格覆盖、引导式选择
 * 注：showExpertiseGuide 为纯 UI 状态，封装在组件内部以维持 draft + updateDraft 契约
 */
export function SettingsExpertiseTab({ draft, updateExpertise }: SettingsExpertiseTabProps) {
  // 引导式选择展开状态（纯 UI 状态，内部管理）
  const [showExpertiseGuide, setShowExpertiseGuide] = useState(false);

  return (
    <div className="space-y-6">
      {/* G-F036: Freeze 警告徽章 */}
      <div className="flex items-center gap-2 rounded-md border border-rd-warning/30 bg-rd-warning/10 px-3 py-2 text-xs text-rd-warning">
        <Snowflake size={14} />
        <span>此模块已冻结，配置可能不会生效</span>
      </div>
      {/* Phase 89：明确告知配置不会生效 */}
      <p className="text-xs font-medium text-rd-danger">配置不会生效</p>
      <Card>
        <CardHeader>
          <CardTitle>经验等级</CardTitle>
          <CardDescription>三级经验等级，控制行为差异化与 System Prompt 注入</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {([
              { value: 'beginner', label: '初学者', desc: '详细解释每一步，主动提供建议', icon: '🌱' },
              { value: 'intermediate', label: '中级', desc: '平衡详细度与效率，关键步骤确认', icon: '⚡' },
              { value: 'expert', label: '专家', desc: '简洁直接，最小化确认打断', icon: '🚀' },
            ] as const).map((opt) => {
              const active = draft.expertise.level === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => updateExpertise({ level: opt.value })}
                  className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors pointer-events-none opacity-60 ${
                    active
                      ? 'border-rd-primary bg-rd-primary/10 text-rd-text'
                      : 'border-rd-border bg-rd-surface text-rd-textMuted hover:border-rd-primary/40 hover:text-rd-text'
                  }`}
                >
                  <span className="text-2xl">{opt.icon}</span>
                  <span className="text-base font-medium">{opt.label}</span>
                  <span className="text-xs">{opt.desc}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="expertise-auto-suggest">启用自动建议</Label>
              <p className="text-xs text-rd-textMuted">暂未实现</p>
            </div>
            <Switch
              id="expertise-auto-suggest"
              checked={draft.expertise.enableAutoSuggestion}
              onCheckedChange={(checked) => updateExpertise({ enableAutoSuggestion: checked })}
              disabled
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="expertise-output-style">输出风格覆盖</Label>
            <Select
              id="expertise-output-style"
              value={draft.expertise.outputStyleOverride ?? ''}
              onChange={(e) => updateExpertise({ outputStyleOverride: e.target.value || null })}
              disabled
            >
              <SelectItem value="">不覆盖（跟随全局设置）</SelectItem>
              <SelectItem value="minimal">简洁</SelectItem>
              <SelectItem value="standard">详细</SelectItem>
              <SelectItem value="structured">结构化</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>
          <div className="space-y-2">
            <Button
              variant="outline"
              onClick={() => setShowExpertiseGuide((v) => !v)}
            >
              <Sparkles size={16} />
              {showExpertiseGuide ? '收起引导式选择' : '不确定？引导式选择'}
            </Button>
            {showExpertiseGuide && (
              <div className="space-y-3 rounded-xl border border-rd-border bg-rd-surfaceHover/50 p-4">
                <p className="text-sm font-medium text-rd-text">回答以下问题，系统会推荐合适的等级：</p>
                <div className="space-y-2 text-sm text-rd-textMuted">
                  <p>1. 你是否熟悉命令行工具和 Git 操作？</p>
                  <p>2. 你是否能够独立阅读和理解 TypeScript 代码？</p>
                  <p>3. 你是否希望 Agent 在执行前征求你的确认？</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => { updateExpertise({ level: 'beginner' }); setShowExpertiseGuide(false); }}>
                    多数否 → 初学者
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { updateExpertise({ level: 'intermediate' }); setShowExpertiseGuide(false); }}>
                    部分是 → 中级
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { updateExpertise({ level: 'expert' }); setShowExpertiseGuide(false); }}>
                    多数是 → 专家
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// 2. 关于 Tab
// ============================================================================

/**
 * 关于 Tab
 * 包含：应用图标与版本、技术栈、GitHub 链接、配置文件路径说明
 * 注：无配置依赖，纯静态展示
 */
export function SettingsAboutTab() {
  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      {/* about tab 是独立 tab，保留 absolute inset-0 自行滚动 */}
      <Card>
        <CardContent className="space-y-6 py-6">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-rd-primary text-rd-primaryForeground">
              <Server size={24} />
            </div>
            <div>
              <div className="text-lg font-semibold text-rd-text">RouteDev</div>
              <div className="text-sm text-rd-textMuted">版本 {APP_VERSION}</div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-rd-text">技术栈</div>
            <div className="flex flex-wrap gap-2">
              {['Electron', 'React', 'Vite', 'TypeScript'].map((tech) => (
                <Badge key={tech} variant="secondary">{tech}</Badge>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-rd-text">GitHub</div>
            <a
              href="https://github.com/routedev/routedev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-rd-primary hover:underline"
            >
              https://github.com/routedev/routedev
            </a>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold text-rd-text">配置文件</div>
            <div className="text-sm text-rd-textMuted">
              配置文件默认存储在用户主目录下的{' '}
              <code className="rounded bg-rd-surface px-1 py-0.5 text-rd-text">~/.routedev/config.yaml</code>
              ，修改后会自动保存并热重载。
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// 3. 市场 Tab
// ============================================================================

interface SettingsMarketTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 draft（用于 market 字段直接修改） */
  updateDraft: (patch: Partial<AppConfig>) => void;
}

/**
 * 市场 Tab
 * 包含：市场说明、启用/自动发布开关、远程 Registry 配置、占位卡片
 */
export function SettingsMarketTab({ draft, updateDraft }: SettingsMarketTabProps) {
  return (
    <div className="space-y-6">
      {/* 说明卡片 */}
      <Card>
        <CardContent className="flex items-start justify-between gap-4 py-6">
          <div className="flex items-start gap-3">
            <ShoppingBag size={20} className="mt-0.5 shrink-0 text-rd-primary" />
            <div>
              <Label>市场</Label>
              <p className="text-xs text-rd-textMuted mt-1">
                管理 Skill 和 Hook 的发布、导入、导出
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 市场开关卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShoppingBag size={16} className="text-rd-primary" />
            市场设置
          </CardTitle>
          <CardDescription>控制市场功能的启用与自动发布</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm text-rd-text">启用市场</p>
              <p className="text-xs text-rd-textMuted mt-1">开启后可发布、导入、导出 Skill 和 Hook。</p>
            </div>
            <Switch
              checked={draft.market?.enabled !== false}
              onCheckedChange={(checked) => updateDraft({ market: { ...draft.market, enabled: checked } })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm text-rd-text">自动发布</p>
              <p className="text-xs text-rd-textMuted mt-1">Skill/Hook 创建后自动发布到市场。</p>
            </div>
            <Switch
              checked={draft.market?.autoPublish === true}
              onCheckedChange={(checked) => updateDraft({ market: { ...draft.market, autoPublish: checked } })}
            />
          </div>

          {/* Phase 43：远程 Registry */}
          <div className="space-y-2">
            <Label htmlFor="market-registry-url">远程 Registry URL</Label>
            <Input
              id="market-registry-url"
              value={draft.market?.registryUrl ?? ''}
              onChange={(e) => updateDraft({ market: { ...draft.market, registryUrl: e.target.value || undefined } })}
              placeholder="https://registry.example.com"
            />
            <p className="text-xs text-rd-textMuted">远程 Skill 注册表地址（留空则不连接远程注册表）。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="market-registry-token">Registry Token</Label>
            <Input
              id="market-registry-token"
              type="password"
              value={draft.market?.registryToken ?? ''}
              onChange={(e) => updateDraft({ market: { ...draft.market, registryToken: e.target.value || undefined } })}
              placeholder="可选，配合远程 Registry 使用"
            />
            <p className="text-xs text-rd-textMuted">远程 Registry 的认证 Token。</p>
          </div>
        </CardContent>
      </Card>

      {/* 占位卡片 */}
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <ShoppingBag size={32} className="mb-4 text-rd-textMuted" />
          <p className="text-sm text-rd-textMuted">市场功能将在后续版本完善</p>
        </CardContent>
      </Card>
    </div>
  );
}
