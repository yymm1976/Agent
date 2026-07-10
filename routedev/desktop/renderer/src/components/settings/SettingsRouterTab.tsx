// desktop/renderer/src/components/settings/SettingsRouterTab.tsx
// Phase 74-G：路由规则 Tab（路由偏好 + Token 预算 + 路由规则 + 降级模型链）
// 从 SettingsPage.tsx 迁移

import { Trash2, Plus } from 'lucide-react';
import type { AppConfig, RouterRule } from '../../../../shared/config-types.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Select, SelectItem } from '../ui/select.js';

interface SettingsRouterTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 draft（用于路由配置直接修改） */
  updateDraft: (patch: Partial<AppConfig>) => void;
  /** 更新预算配置 */
  updateBudget: (patch: Partial<AppConfig['router']['budget']>) => void;
  /** 更新路由规则 */
  updateRule: (index: number, patch: Partial<RouterRule>) => void;
  /** 添加路由规则 */
  addRule: () => void;
  /** 删除路由规则 */
  removeRule: (index: number) => void;
}

/**
 * 路由规则 Tab
 * 包含：路由偏好（分类器模型/用户偏好）、Token 预算、路由规则列表、降级模型链
 */
export function SettingsRouterTab({
  draft,
  updateDraft,
  updateBudget,
  updateRule,
  addRule,
  removeRule,
}: SettingsRouterTabProps) {
  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>路由偏好</CardTitle>
          <CardDescription>配置分类器模型与用户成本/质量偏好</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="router-classifier">分类器模型</Label>
              {/* 从已配置的模型中选择，避免手动输入不存在的模型 ID */}
              <Select
                id="router-classifier"
                value={draft.router.classifierModel}
                onChange={(e) => updateDraft({ router: { ...draft.router, classifierModel: e.target.value } })}
              >
                <SelectItem value="">跟随路由默认</SelectItem>
                {draft.providers.flatMap((p) => p.models).map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                ))}
              </Select>
              <p className="text-xs text-rd-textMuted">判断用户请求复杂度等级的模型，建议选最便宜的模型以节省成本。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="router-preference">用户偏好</Label>
              <Select
                id="router-preference"
                value={draft.router.userPreference}
                onChange={(e) => updateDraft({ router: { ...draft.router, userPreference: e.target.value as 'saving' | 'balanced' | 'premium' } })}
              >
                <SelectItem value="saving">省钱</SelectItem>
                <SelectItem value="balanced">平衡</SelectItem>
                <SelectItem value="premium">高质量</SelectItem>
              </Select>
              <p className="text-xs text-rd-textMuted">同等级任务有多个候选模型时，优先选便宜还是高质量的模型。</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Token 预算</CardTitle>
          <CardDescription>设置预算模式、日限额与降级阈值</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="budget-mode">预算模式</Label>
              <Select
                id="budget-mode"
                value={draft.router.budget.mode}
                onChange={(e) => updateBudget({ mode: e.target.value as 'track_only' | 'enforce' })}
              >
                <SelectItem value="track_only">仅追踪（track_only）</SelectItem>
                <SelectItem value="enforce">强制执行（enforce）</SelectItem>
              </Select>
              <p className="text-xs text-rd-textMuted">仅追踪只统计不限制；强制执行会在达到限额时降级到更便宜的模型或拒绝请求。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget-daily">日 Token 上限</Label>
              <Input
                id="budget-daily"
                type="number"
                value={draft.router.budget.dailyLimit}
                onChange={(e) => updateBudget({ dailyLimit: Number(e.target.value) })}
              />
              <p className="text-xs text-rd-textMuted">单日累计 Token 消耗上限，超过后按预算模式处理。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget-per-request">单次请求上限（可选）</Label>
              <Input
                id="budget-per-request"
                type="number"
                value={draft.router.budget.perRequestLimit ?? ''}
                onChange={(e) => updateBudget({ perRequestLimit: e.target.value ? Number(e.target.value) : undefined })}
              />
              <p className="text-xs text-rd-textMuted">单次请求 Token 上限，超过会自动截断或降级。留空表示不限制。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget-threshold">降级阈值: {draft.router.budget.degradationThreshold.toFixed(2)}</Label>
              <input
                id="budget-threshold"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={draft.router.budget.degradationThreshold}
                onChange={(e) => updateBudget({ degradationThreshold: Number(e.target.value) })}
                className="mt-2 w-full accent-rd-primary"
              />
              <p className="text-xs text-rd-textMuted">日用量达到此比例时开始降级到更便宜的模型。0.8 表示用到 80% 时触发。</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>路由规则</CardTitle>
          <CardDescription>把任务等级映射到具体模型</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {draft.router.rules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-rd-border bg-rd-surface p-4 text-center text-sm text-rd-textMuted">
              暂无规则，点击下方按钮添加
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-rd-border">
              {/* 列宽分配：任务等级 3 / 主选模型 8 / 操作 1 */}
              <div className="grid grid-cols-12 gap-2 border-b border-rd-border bg-rd-surface px-3 py-2 text-xs font-semibold text-rd-textMuted">
                <div className="col-span-3">任务等级</div>
                <div className="col-span-8">主选模型</div>
                <div className="col-span-1 text-right">操作</div>
              </div>
              <div className="divide-y divide-rd-border">
                {draft.router.rules.map((rule, idx) => (
                  <div key={idx} className="grid grid-cols-12 items-center gap-2 px-3 py-2">
                    <Select
                      value={rule.tier}
                      onChange={(e) => updateRule(idx, { tier: e.target.value as RouterRule['tier'] })}
                      className="col-span-3"
                    >
                      <SelectItem value="simple">simple</SelectItem>
                      <SelectItem value="medium">medium</SelectItem>
                      <SelectItem value="complex">complex</SelectItem>
                      <SelectItem value="reasoning">reasoning</SelectItem>
                    </Select>
                    {/* 主选模型：下拉选择已配置的模型，避免填写 unconfigured 或不存在的模型 ID */}
                    <Select
                      value={rule.modelId}
                      onChange={(e) => updateRule(idx, { modelId: e.target.value })}
                      className="col-span-8"
                    >
                      {draft.providers.flatMap((p) => p.models).length === 0 ? (
                        <SelectItem value={rule.modelId || 'unconfigured'}>未配置任何模型</SelectItem>
                      ) : (
                        draft.providers.flatMap((p) => p.models).map((m) => (
                          <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                        ))
                      )}
                    </Select>
                    <div className="col-span-1 flex justify-end">
                      <Button
                        variant="outline"
                        size="icon"
                        className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                        onClick={() => removeRule(idx)}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Button onClick={addRule} className="w-full">
            <Plus size={16} /> 添加路由规则
          </Button>
        </CardContent>
      </Card>

      {/* 全局降级模型链：一旦有模型失效，按顺序换成此列表中的模型 */}
      <Card>
        <CardHeader>
          <CardTitle>降级模型链</CardTitle>
          <CardDescription>
            一旦有模型失效（API 错误、超时等），按顺序换成下方模型。优先级从上到下递减。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(draft.router.fallbackChain ?? []).length === 0 ? (
            <div className="rounded-lg border border-dashed border-rd-border bg-rd-surface p-4 text-center text-sm text-rd-textMuted">
              暂无降级模型，点击下方按钮添加
            </div>
          ) : (
            <div className="space-y-2">
              {(draft.router.fallbackChain ?? []).map((modelId, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rd-primary/10 text-xs font-semibold text-rd-primary">
                    {idx + 1}
                  </span>
                  <Select
                    value={modelId}
                    onChange={(e) => {
                      const chain = [...(draft.router.fallbackChain ?? [])];
                      chain[idx] = e.target.value;
                      updateDraft({ router: { ...draft.router, fallbackChain: chain } });
                    }}
                    className="flex-1"
                  >
                    {draft.providers.flatMap((p) => p.models).length === 0 ? (
                      <SelectItem value={modelId}>未配置任何模型</SelectItem>
                    ) : (
                      draft.providers.flatMap((p) => p.models).map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                      ))
                    )}
                  </Select>
                  <Button
                    variant="outline"
                    size="icon"
                    className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                    onClick={() => {
                      const chain = (draft.router.fallbackChain ?? []).filter((_, i) => i !== idx);
                      updateDraft({ router: { ...draft.router, fallbackChain: chain } });
                    }}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              const chain = [...(draft.router.fallbackChain ?? []), ''];
              updateDraft({ router: { ...draft.router, fallbackChain: chain } });
            }}
          >
            <Plus size={16} /> 添加降级模型
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
