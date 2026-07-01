// desktop/renderer/src/components/settings/SettingsResultSchemaTab.tsx
// Phase 51 Task 10：子 Agent 结果 Schema 配置
// 控制子 Agent 产出结果的结构化校验行为。
import type { AppConfig, ResultSchemaConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';

interface SettingsResultSchemaTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsResultSchemaTab({ draft, updateDraft }: SettingsResultSchemaTabProps) {
  const cfg: ResultSchemaConfig = draft.resultSchema ?? ({} as ResultSchemaConfig);

  const update = (patch: Partial<ResultSchemaConfig>) => {
    updateDraft({ resultSchema: { ...cfg, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>子 Agent 结果 Schema</CardTitle>
          <CardDescription>
            控制子 Agent 产出结果的结构化校验。启用后子 Agent 必须按 schema 返回结构化结果。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="rs-enabled">启用结果 Schema 校验</Label>
              <p className="text-xs text-rd-textMuted">开启后对子 Agent 返回结果进行结构化校验。</p>
            </div>
            <Switch
              id="rs-enabled"
              checked={cfg.enabled ?? false}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="rs-strict">严格校验模式</Label>
              <p className="text-xs text-rd-textMuted">严格模式下任何字段缺失或类型不符都视为失败。</p>
            </div>
            <Switch
              id="rs-strict"
              checked={cfg.strictValidation ?? false}
              onCheckedChange={(checked) => update({ strictValidation: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="rs-fallback">校验失败回退为文本</Label>
              <p className="text-xs text-rd-textMuted">校验失败时回退使用原始文本结果，而非直接报错。</p>
            </div>
            <Switch
              id="rs-fallback"
              checked={cfg.fallbackToText ?? true}
              onCheckedChange={(checked) => update({ fallbackToText: checked })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsResultSchemaTab;
