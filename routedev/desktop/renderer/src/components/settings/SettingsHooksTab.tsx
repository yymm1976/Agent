// desktop/renderer/src/components/settings/SettingsHooksTab.tsx
// Phase 74-G：Hooks 系统 Tab（说明 + 模板库 + 自定义 Hook）
// 从 SettingsPage.tsx 迁移

import { Plus, Trash2, RefreshCw, BookOpen, Wand2, Webhook, X } from 'lucide-react';
import type { HookInfo } from '../../../../shared/ipc-types.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Badge } from '../ui/badge.js';

/** 自定义 Hook 创建表单状态 */
type HookCreateForm = { description: string; generating: boolean; generated: { name: string; event: string; content: string } | null } | null;

interface SettingsHooksTabProps {
  /** Hook 列表 */
  hooks: HookInfo[];
  /** 加载中标志 */
  hookLoading: boolean;
  /** 自定义 Hook 创建表单 */
  hookCreateForm: HookCreateForm;
  /** 设置自定义 Hook 创建表单 */
  setHookCreateForm: (form: HookCreateForm) => void;
  /** 刷新 Hook 列表 */
  refreshHooks: () => void;
  /** 切换 Hook 启用/禁用 */
  handleHookToggle: (hookId: string, enabled: boolean) => void;
  /** 删除 Hook */
  handleHookDelete: (hookId: string) => void;
  /** 生成 Hook（自定义模式） */
  handleHookAiGenerate: () => void;
}

/**
 * Hooks 系统 Tab
 * 包含：说明卡片、Hook 模板库（一键启用）、自定义 Hook（自然语言描述 AI 生成）
 */
export function SettingsHooksTab({
  hooks,
  hookLoading,
  hookCreateForm,
  setHookCreateForm,
  refreshHooks,
  handleHookToggle,
  handleHookDelete,
  handleHookAiGenerate,
}: SettingsHooksTabProps) {
  return (
    <div className="space-y-6">
      {/* 说明卡片 */}
      <Card>
        <CardContent className="flex items-start justify-between gap-4 py-6">
          <div className="flex items-start gap-3">
            <Webhook size={20} className="mt-0.5 shrink-0 text-rd-primary" />
            <div>
              <Label>钩子系统</Label>
              <p className="text-xs text-rd-textMuted mt-1">
                钩子在 Agent 生命周期的特定阶段自动执行，例如工具调用前后、会话开始与结束。
                支持模板库一键启用，或通过自然语言描述由 AI 自动生成。
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={refreshHooks} disabled={hookLoading}>
            <RefreshCw size={14} className={hookLoading ? 'animate-spin' : ''} />
            刷新
          </Button>
        </CardContent>
      </Card>

      {/* 模板库卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen size={16} className="text-rd-primary" />
            钩子模板库
          </CardTitle>
          <CardDescription>常用钩子模板，一键启用</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {hooks.filter((h) => h.isTemplate).length === 0 && !hookLoading && (
            <p className="text-sm text-rd-textMuted py-4 text-center">
              模板库加载中或为空。钩子模板由其他子代理负责创建。
            </p>
          )}
          {hooks.filter((h) => h.isTemplate).map((hook) => (
            <div key={hook.id} className="flex items-center justify-between gap-4 rounded-lg border border-rd-border px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-rd-text">{hook.name}</span>
                  <Badge variant="outline">{hook.event}</Badge>
                </div>
                <p className="text-xs text-rd-textMuted mt-1">{hook.description}</p>
              </div>
              <Switch
                checked={hook.enabled}
                onCheckedChange={(checked) => handleHookToggle(hook.id, checked)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 自定义钩子卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wand2 size={16} className="text-rd-primary" />
            自定义钩子
          </CardTitle>
          <CardDescription>通过自然语言描述由 AI 自动生成钩子</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 创建钩子对话框 */}
          {hookCreateForm === null ? (
            <Button onClick={() => setHookCreateForm({ description: '', generating: false, generated: null })}>
              <Plus size={16} /> 创建新钩子
            </Button>
          ) : (
            <div className="space-y-3 rounded-lg border border-rd-border p-4">
              <Label htmlFor="hook-create-desc">描述你想要的钩子行为</Label>
              <textarea
                id="hook-create-desc"
                className="w-full rounded-md border border-rd-border bg-rd-background px-3 py-2 text-sm text-rd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40 focus-visible:border-rd-primary/70"
                rows={4}
                value={hookCreateForm.description}
                onChange={(e) => setHookCreateForm({ ...hookCreateForm, description: e.target.value })}
                placeholder="例如：每次写入文件后自动运行 eslint 检查修改的文件"
              />
              <div className="flex items-center gap-2">
                <Button
                  onClick={handleHookAiGenerate}
                  disabled={!hookCreateForm.description.trim() || hookCreateForm.generating}
                >
                  {hookCreateForm.generating ? <RefreshCw size={16} className="animate-spin" /> : <Wand2 size={16} />}
                  生成钩子
                </Button>
                <Button variant="ghost" onClick={() => setHookCreateForm(null)}>
                  <X size={16} /> 取消
                </Button>
              </div>
            </div>
          )}

          {/* 已有自定义钩子列表 */}
          {hooks.filter((h) => !h.isTemplate).length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-rd-textSubtle">已创建的自定义钩子</p>
              {hooks.filter((h) => !h.isTemplate).map((hook) => (
                <div key={hook.id} className="flex items-center justify-between gap-4 rounded-lg border border-rd-border px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-rd-text">{hook.name}</span>
                      <Badge variant="outline">{hook.event}</Badge>
                    </div>
                    <p className="text-xs text-rd-textMuted mt-1">{hook.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={hook.enabled}
                      onCheckedChange={(checked) => handleHookToggle(hook.id, checked)}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                      onClick={() => handleHookDelete(hook.id)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
