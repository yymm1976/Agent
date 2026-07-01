// desktop/renderer/src/components/settings/SettingsErrorDisplayTab.tsx
// Phase 51 Task 9：错误显示配置（双受众模型）
// 区分开发者与终端用户两类受众，控制错误详情的可见性与截断长度。
import type { AppConfig, ErrorDisplayConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';

interface SettingsErrorDisplayTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsErrorDisplayTab({ draft, updateDraft }: SettingsErrorDisplayTabProps) {
  const cfg: ErrorDisplayConfig = draft.errorDisplay ?? ({} as ErrorDisplayConfig);

  const update = (patch: Partial<ErrorDisplayConfig>) => {
    updateDraft({ errorDisplay: { ...cfg, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>错误显示（双受众模型）</CardTitle>
          <CardDescription>
            区分开发者与终端用户两类受众。启用开发者详情可辅助排查，但可能暴露内部信息。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="ed-dev">显示开发者详情</Label>
              <p className="text-xs text-rd-textMuted">在错误信息中包含面向开发者的诊断详情。</p>
            </div>
            <Switch
              id="ed-dev"
              checked={cfg.showDevDetails ?? false}
              onCheckedChange={(checked) => update({ showDevDetails: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="ed-trace">显示堆栈跟踪</Label>
              <p className="text-xs text-rd-textMuted">在错误信息中包含完整堆栈跟踪。</p>
            </div>
            <Switch
              id="ed-trace"
              checked={cfg.showStackTrace ?? false}
              onCheckedChange={(checked) => update({ showStackTrace: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ed-max-len">详情最大长度（100-10000）</Label>
            <Input
              id="ed-max-len"
              type="number"
              min={100}
              max={10000}
              value={cfg.maxDetailsLength ?? 2000}
              onChange={(e) => update({ maxDetailsLength: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">超过此长度的错误详情会被截断。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsErrorDisplayTab;
