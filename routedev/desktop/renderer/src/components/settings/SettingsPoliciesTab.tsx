// desktop/renderer/src/components/settings/SettingsPoliciesTab.tsx
// Phase 74-G：策略引擎 Tab（说明卡片 + 策略开关 + 审批模式）
// 从 SettingsPage.tsx 迁移

import { Shield } from 'lucide-react';
import type { AppConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';

interface SettingsPoliciesTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 draft（用于 policies 字段直接修改） */
  updateDraft: (patch: Partial<AppConfig>) => void;
}

/**
 * 策略引擎 Tab
 * 包含：说明卡片、策略开关（Intent Guard / Playbook / Tool Guide / Tool Approval）、审批模式
 */
export function SettingsPoliciesTab({ draft, updateDraft }: SettingsPoliciesTabProps) {
  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      {/* 说明卡片 */}
      <Card>
        <CardContent className="flex items-start justify-between gap-4 py-6">
          <div className="flex items-start gap-3">
            <Shield size={20} className="mt-0.5 shrink-0 text-rd-primary" />
            <div>
              <Label>策略引擎</Label>
              <p className="text-xs text-rd-textMuted mt-1">
                Intent Guard + Playbook + Tool Guide + Tool Approval 四层策略，控制 Agent 行为边界与工具审批。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 策略开关卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield size={16} className="text-rd-primary" />
            策略开关
          </CardTitle>
          <CardDescription>控制各策略层的启用状态</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm text-rd-text">启用策略引擎</p>
              <p className="text-xs text-rd-textMuted mt-1">总开关，关闭后所有策略层均不生效。</p>
            </div>
            <Switch
              checked={draft.policies?.enabled !== false}
              onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, enabled: checked } })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm text-rd-text">意图护栏（Intent Guard）</p>
              <p className="text-xs text-rd-textMuted mt-1">检测危险意图并阻止执行。</p>
            </div>
            <Switch
              checked={draft.policies?.intentGuard !== false}
              onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, intentGuard: checked } })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm text-rd-text">SOP 注入（Playbook）</p>
              <p className="text-xs text-rd-textMuted mt-1">根据意图注入标准操作流程。</p>
            </div>
            <Switch
              checked={draft.policies?.playbook !== false}
              onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, playbook: checked } })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm text-rd-text">工具增强（Tool Guide）</p>
              <p className="text-xs text-rd-textMuted mt-1">为工具调用注入使用指南。</p>
            </div>
            <Switch
              checked={draft.policies?.toolGuide !== false}
              onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, toolGuide: checked } })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm text-rd-text">工具审批（Tool Approval）</p>
              <p className="text-xs text-rd-textMuted mt-1">工具调用前需审批。</p>
            </div>
            <Switch
              checked={draft.policies?.toolApproval === true}
              onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, toolApproval: checked } })}
            />
          </div>
        </CardContent>
      </Card>

      {/* 审批模式卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield size={16} className="text-rd-primary" />
            审批模式
          </CardTitle>
          <CardDescription>控制工具审批的触发范围</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label>审批模式</Label>
            <Select
              value={draft.policies?.approvalMode ?? 'risky-only'}
              onChange={(e) => updateDraft({ policies: { ...draft.policies, approvalMode: e.target.value as 'always' | 'risky-only' | 'minimal' } })}
            >
              <SelectItem value="always">always（全部审批）</SelectItem>
              <SelectItem value="risky-only">risky-only（仅高风险）</SelectItem>
              <SelectItem value="minimal">minimal（最小化）</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">
              always=全部工具调用需审批；risky-only=仅高风险工具；minimal=最小化审批。
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
