// desktop/renderer/src/components/settings/SettingsGoalTab.tsx
// Phase 43：/goal 流程配置

import type { AppConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';
import { Input } from '../ui/input.js';

interface SettingsGoalTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

const AUDIT_MODES = [
  { value: 'completion_gate_first', label: '验证门优先' },
  { value: 'reviewer_first', label: '审查器优先' },
  { value: 'all_must_pass', label: '全部通过' },
] as const;

export function SettingsGoalTab({ draft, updateDraft }: SettingsGoalTabProps) {
  const goal = draft.goal;

  const updateGoal = (patch: Partial<typeof goal>) => {
    updateDraft({ goal: { ...goal, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>/goal 流程</CardTitle>
          <CardDescription>控制目标分解、确认与审计的行为</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="goal-clarify">启用需求澄清</Label>
              <p className="text-xs text-rd-textMuted">执行前若目标模糊，自动追问澄清。</p>
            </div>
            <Switch
              id="goal-clarify"
              checked={goal.clarify}
              onCheckedChange={(checked) => updateGoal({ clarify: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="goal-require-confirmation">要求用户确认计划</Label>
              <p className="text-xs text-rd-textMuted">分解后的子任务计划需用户确认后才执行。</p>
            </div>
            <Switch
              id="goal-require-confirmation"
              checked={goal.requireConfirmation}
              onCheckedChange={(checked) => updateGoal({ requireConfirmation: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-audit-mode">审计模式</Label>
            <Select
              id="goal-audit-mode"
              value={goal.auditMode}
              onChange={(e) => updateGoal({ auditMode: e.target.value as typeof goal.auditMode })}
            >
              {AUDIT_MODES.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">目标完成后按哪种顺序执行审计。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-token-budget">Token 预算</Label>
            <Input
              id="goal-token-budget"
              type="number"
              min={1000}
              value={goal.tokenBudget}
              onChange={(e) => updateGoal({ tokenBudget: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">单次 /goal 任务的 token 上限。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-soft-stop-ratio">软停止比例</Label>
            <Input
              id="goal-soft-stop-ratio"
              type="number"
              min={0.5}
              max={1}
              step={0.05}
              value={goal.softStopRatio}
              onChange={(e) => updateGoal({ softStopRatio: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">达到预算此比例时提示用户是否继续。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
