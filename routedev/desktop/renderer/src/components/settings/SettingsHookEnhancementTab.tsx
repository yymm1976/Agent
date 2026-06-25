// desktop/renderer/src/components/settings/SettingsHookEnhancementTab.tsx
// Phase 43：Hook 增强设置

import type { AppConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';

interface SettingsHookEnhancementTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsHookEnhancementTab({ draft, updateDraft }: SettingsHookEnhancementTabProps) {
  const hookEnhancement = draft.hookEnhancement;

  const updateHookEnhancement = (patch: Partial<typeof hookEnhancement>) => {
    updateDraft({ hookEnhancement: { ...hookEnhancement, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>Hook 增强</CardTitle>
          <CardDescription>控制函数级 Hook、沙箱与试用期行为</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="hook-function-hooks">启用函数级 Hook</Label>
              <p className="text-xs text-rd-textMuted">精细到函数入口/出口的 Hook 注入（实验性）。</p>
            </div>
            <Switch
              id="hook-function-hooks"
              checked={hookEnhancement.functionHooks}
              onCheckedChange={(checked) => updateHookEnhancement({ functionHooks: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="hook-sandbox">启用沙箱</Label>
              <p className="text-xs text-rd-textMuted">Hook 在隔离环境中执行，降低副作用风险。</p>
            </div>
            <Switch
              id="hook-sandbox"
              checked={hookEnhancement.sandbox}
              onCheckedChange={(checked) => updateHookEnhancement({ sandbox: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="hook-groups">启用 Hook 分组</Label>
              <p className="text-xs text-rd-textMuted">按事件类型分组管理 Hook。</p>
            </div>
            <Switch
              id="hook-groups"
              checked={hookEnhancement.hookGroups}
              onCheckedChange={(checked) => updateHookEnhancement({ hookGroups: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="hook-trial-days">试用期天数</Label>
            <Input
              id="hook-trial-days"
              type="number"
              min={1}
              max={30}
              value={hookEnhancement.trialDays}
              onChange={(e) => updateHookEnhancement({ trialDays: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">新 Hook 默认试用期（1-30 天）。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
