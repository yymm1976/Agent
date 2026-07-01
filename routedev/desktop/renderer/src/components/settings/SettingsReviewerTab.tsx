// desktop/renderer/src/components/settings/SettingsReviewerTab.tsx
// Phase 51 Task 1/7：Reviewer 分级策略配置
// 借鉴 ohmypi 的三档分级（tiny/medium/big/high-risk），但配置化。
// 启用后根据任务规模和风险自动决定审查轮次。

import type { AppConfig, ReviewerPolicyConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';

interface SettingsReviewerTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsReviewerTab({ draft, updateDraft }: SettingsReviewerTabProps) {
  const policy: ReviewerPolicyConfig = draft.reviewerPolicy ?? ({} as ReviewerPolicyConfig);

  const updatePolicy = (patch: Partial<ReviewerPolicyConfig>) => {
    updateDraft({ reviewerPolicy: { ...policy, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>审查分级策略</CardTitle>
          <CardDescription>
            借鉴 ohmypi 的三档分级（tiny/medium/big/high-risk），但配置化。
            启用后根据任务规模和风险自动决定审查轮次。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="reviewer-tiered">启用分级审查</Label>
              <p className="text-xs text-rd-textMuted">按任务规模/风险自动决定审查轮次。</p>
            </div>
            <Switch
              id="reviewer-tiered"
              checked={policy.tieredReviewEnabled ?? false}
              onCheckedChange={(checked) => updatePolicy({ tieredReviewEnabled: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reviewer-tiny-threshold">tiny 任务步数阈值（1-20）</Label>
            <Input
              id="reviewer-tiny-threshold"
              type="number"
              min={1}
              max={20}
              value={policy.tinyTaskStepThreshold ?? 5}
              onChange={(e) => updatePolicy({ tinyTaskStepThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">步数低于此值视为 tiny 任务，可跳过中间审查。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reviewer-big-threshold">big 任务步数阈值（10-100）</Label>
            <Input
              id="reviewer-big-threshold"
              type="number"
              min={10}
              max={100}
              value={policy.bigTaskStepThreshold ?? 30}
              onChange={(e) => updatePolicy({ bigTaskStepThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">步数高于此值视为 big 任务，强制 mid-work 审查。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reviewer-mid-ratio">mid-work 审查比例（0.3-0.8）</Label>
            <Input
              id="reviewer-mid-ratio"
              type="number"
              min={0.3}
              max={0.8}
              step={0.05}
              value={policy.midWorkReviewRatio ?? 0.5}
              onChange={(e) => updatePolicy({ midWorkReviewRatio: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">达到总步数此比例时触发中途审查。</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="reviewer-cross-model">high-risk 自动跨模型审查</Label>
              <p className="text-xs text-rd-textMuted">高风险任务自动切换到不同模型复审。</p>
            </div>
            <Switch
              id="reviewer-cross-model"
              checked={policy.autoCrossModelForHighRisk ?? false}
              onCheckedChange={(checked) => updatePolicy({ autoCrossModelForHighRisk: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reviewer-cross-id">跨模型审查器 ID</Label>
            <Input
              id="reviewer-cross-id"
              type="text"
              value={policy.crossModelReviewerId ?? ''}
              onChange={(e) => updatePolicy({ crossModelReviewerId: e.target.value })}
              placeholder="留空则按路由自动选择"
            />
            <p className="text-xs text-rd-textMuted">指定复审所用模型/Agent ID；留空按路由选择。</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="reviewer-auto-select">自动选择跨模型</Label>
              <p className="text-xs text-rd-textMuted">未指定 ID 时按路由自动挑选不同模型。</p>
            </div>
            <Switch
              id="reviewer-auto-select"
              checked={policy.autoSelectCrossModel ?? true}
              onCheckedChange={(checked) => updatePolicy({ autoSelectCrossModel: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="reviewer-evidence">强制三条证据协议</Label>
              <p className="text-xs text-rd-textMuted">审查结论必须附三条独立证据。</p>
            </div>
            <Switch
              id="reviewer-evidence"
              checked={policy.enforceEvidenceProtocol ?? false}
              onCheckedChange={(checked) => updatePolicy({ enforceEvidenceProtocol: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reviewer-high-risk-threshold">high-risk 风险分阈值（20-100）</Label>
            <Input
              id="reviewer-high-risk-threshold"
              type="number"
              min={20}
              max={100}
              value={policy.highRiskThreshold ?? 40}
              onChange={(e) => updatePolicy({ highRiskThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">风险分达到此值判定为 high-risk，触发升级审查。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reviewer-failure-escalation">失败升级阈值（1-10）</Label>
            <Input
              id="reviewer-failure-escalation"
              type="number"
              min={1}
              max={10}
              value={policy.failureEscalationThreshold ?? 2}
              onChange={(e) => updatePolicy({ failureEscalationThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">连续审查失败达到此次数后升级处理。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reviewer-context-ratio">上下文 Token 升级比例（0.5-0.95）</Label>
            <Input
              id="reviewer-context-ratio"
              type="number"
              min={0.5}
              max={0.95}
              step={0.05}
              value={policy.contextTokenEscalationRatio ?? 0.8}
              onChange={(e) => updatePolicy({ contextTokenEscalationRatio: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">上下文占用达到此比例时触发升级审查。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsReviewerTab;
