// desktop/renderer/src/components/settings/SettingsDiscoveryTab.tsx
// Phase 45：功能发现设置

import type { AppConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';

interface SettingsDiscoveryTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsDiscoveryTab({ draft, updateDraft }: SettingsDiscoveryTabProps) {
  const discovery = draft.discovery;

  const updateDiscovery = (patch: Partial<typeof discovery>) => {
    updateDraft({ discovery: { ...discovery, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>功能发现</CardTitle>
          <CardDescription>控制新功能提示与启动时发现入口</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="discovery-enabled">启用功能发现</Label>
              <p className="text-xs text-rd-textMuted">根据使用场景推荐你可能需要的功能与快捷方式。</p>
            </div>
            <Switch
              id="discovery-enabled"
              checked={discovery.enabled}
              onCheckedChange={(checked) => updateDiscovery({ enabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="discovery-startup">启动时显示发现提示</Label>
              <p className="text-xs text-rd-textMuted">每次启动应用时展示一条功能发现提示。</p>
            </div>
            <Switch
              id="discovery-startup"
              checked={discovery.showOnStartup}
              onCheckedChange={(checked) => updateDiscovery({ showOnStartup: checked })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
