// desktop/renderer/src/components/settings/SettingsPersonaTab.tsx
// Phase 45：人格引擎设置

import type { AppConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';
import { Input } from '../ui/input.js';
import { Alert, AlertTitle, AlertDescription } from '../ui/alert.js';
import { SettingsTabContainer } from './SettingsTabContainer.js';

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
    <SettingsTabContainer className="space-y-6">
      {/* 占位 UI：PersonaEngine 尚未实现，所有控件已禁用 */}
      <Alert variant="destructive">
        <AlertTitle>此功能暂未实现</AlertTitle>
        <AlertDescription>此功能暂未实现，配置不会生效</AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>人格化</CardTitle>
          <CardDescription>控制助手的人格化表达风格与强度</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="persona-enabled">启用人格化</Label>
              <p className="text-xs text-rd-textMuted">暂未实现</p>
            </div>
            <Switch
              id="persona-enabled"
              checked={persona.enabled}
              onCheckedChange={(checked) => updatePersona({ enabled: checked })}
              disabled
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="persona-intensity">人格强度</Label>
            <Select
              id="persona-intensity"
              value={persona.intensity}
              onChange={(e) => updatePersona({ intensity: e.target.value as typeof persona.intensity })}
              disabled
            >
              {INTENSITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="persona-current-id">当前人格标识</Label>
            <Input
              id="persona-current-id"
              value={persona.currentId}
              onChange={(e) => updatePersona({ currentId: e.target.value })}
              disabled
            />
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>
        </CardContent>
      </Card>
    </SettingsTabContainer>
  );
}
