// desktop/renderer/src/components/settings/SettingsPersonaTab.tsx
// Phase 45：人格引擎设置

import type { AppConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';
import { Input } from '../ui/input.js';

interface SettingsPersonaTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

const INTENSITY_OPTIONS = [
  { value: 'none', label: '关闭' },
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '中度' },
  { value: 'high', label: '高度' },
] as const;

export function SettingsPersonaTab({ draft, updateDraft }: SettingsPersonaTabProps) {
  const persona = draft.persona;

  const updatePersona = (patch: Partial<typeof persona>) => {
    updateDraft({ persona: { ...persona, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>人格引擎</CardTitle>
          <CardDescription>控制助手的人格化表达风格与强度</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="persona-enabled">启用人格引擎</Label>
              <p className="text-xs text-rd-textMuted">开启后助手回复会带有人格化语气与表达风格。</p>
            </div>
            <Switch
              id="persona-enabled"
              checked={persona.enabled}
              onCheckedChange={(checked) => updatePersona({ enabled: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="persona-intensity">人格强度</Label>
            <Select
              id="persona-intensity"
              value={persona.intensity}
              onChange={(e) => updatePersona({ intensity: e.target.value as typeof persona.intensity })}
            >
              {INTENSITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">强度越高，人格化表达越明显；设为关闭则仅保留基础风格。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="persona-current-id">当前人格 ID</Label>
            <Input
              id="persona-current-id"
              value={persona.currentId}
              onChange={(e) => updatePersona({ currentId: e.target.value })}
            />
            <p className="text-xs text-rd-textMuted">使用的人格配置标识，默认 collaborator。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
