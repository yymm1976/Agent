// desktop/renderer/src/components/settings/SettingsModelDisplayTab.tsx
// Phase 51 Task 11：模型显示配置
// 控制模型在 UI 中的显示方式：思考级别、提供商前缀、自定义标签。
import type { AppConfig, ModelDisplayConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';

interface SettingsModelDisplayTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsModelDisplayTab({ draft, updateDraft }: SettingsModelDisplayTabProps) {
  const cfg: ModelDisplayConfig = draft.modelDisplay ?? ({} as ModelDisplayConfig);

  const update = (patch: Partial<ModelDisplayConfig>) => {
    updateDraft({ modelDisplay: { ...cfg, ...patch } });
  };

  // thinkingLevelLabels 是 Record<string, string>，这里用 JSON 文本框简化编辑
  const labels = cfg.thinkingLevelLabels ?? {};
  const labelsText = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const handleLabelsChange = (text: string) => {
    const next: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) next[k] = v;
      }
    }
    update({ thinkingLevelLabels: next });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>模型显示</CardTitle>
          <CardDescription>
            控制模型在 UI 中的显示方式：思考级别、提供商前缀、自定义标签。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="md-thinking">显示思考级别</Label>
              <p className="text-xs text-rd-textMuted">在模型名称旁展示当前思考级别。</p>
            </div>
            <Switch
              id="md-thinking"
              checked={cfg.showThinkingLevel ?? true}
              onCheckedChange={(checked) => update({ showThinkingLevel: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="md-prefix">显示提供商前缀</Label>
              <p className="text-xs text-rd-textMuted">在模型名称前附加提供商标识（如 openai/gpt-4）。</p>
            </div>
            <Switch
              id="md-prefix"
              checked={cfg.showProviderPrefix ?? false}
              onCheckedChange={(checked) => update({ showProviderPrefix: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="md-labels">思考级别自定义标签</Label>
            <textarea
              id="md-labels"
              className="rd-input min-h-[100px] w-full rounded-md border border-rd-border bg-rd-bg px-3 py-2 text-sm text-rd-text"
              value={labelsText}
              onChange={(e) => handleLabelsChange(e.target.value)}
              placeholder={'每行一个，格式：key=value\n例如：high=深度思考\n      medium=常规思考'}
            />
            <p className="text-xs text-rd-textMuted">每行格式 <code>key=value</code>，用于覆盖默认思考级别标签。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsModelDisplayTab;
