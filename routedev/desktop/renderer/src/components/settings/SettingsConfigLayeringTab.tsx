// desktop/renderer/src/components/settings/SettingsConfigLayeringTab.tsx
// Phase 51 Task 8：项目级配置分层
// 支持项目级配置覆盖全局配置，控制合并策略与文件路径。
import type { AppConfig, ConfigLayeringConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';
import { Select, SelectItem } from '../ui/select.js';

interface SettingsConfigLayeringTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsConfigLayeringTab({ draft, updateDraft }: SettingsConfigLayeringTabProps) {
  const cfg: ConfigLayeringConfig = draft.configLayering ?? ({} as ConfigLayeringConfig);

  const update = (patch: Partial<ConfigLayeringConfig>) => {
    updateDraft({ configLayering: { ...cfg, ...patch } });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>配置分层</CardTitle>
          <CardDescription>
            支持项目级配置覆盖全局配置，启用后按合并策略合并两层配置。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="cl-enabled">启用配置分层</Label>
              <p className="text-xs text-rd-textMuted">开启后加载项目级配置并与全局配置合并。</p>
            </div>
            <Switch
              id="cl-enabled"
              checked={cfg.enabled ?? false}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cl-project-path">项目配置路径</Label>
            <Input
              id="cl-project-path"
              type="text"
              value={cfg.projectConfigPath ?? '.routedev/config.json'}
              onChange={(e) => update({ projectConfigPath: e.target.value })}
              placeholder=".routedev/config.json"
              disabled
            />
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cl-global-path">全局配置路径</Label>
            <Input
              id="cl-global-path"
              type="text"
              value={cfg.globalConfigPath ?? ''}
              onChange={(e) => update({ globalConfigPath: e.target.value })}
              placeholder="留空使用默认全局路径"
              disabled
            />
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cl-merge">合并策略</Label>
            <Select
              id="cl-merge"
              value={cfg.mergeStrategy ?? 'deep'}
              onChange={(e) => update({ mergeStrategy: e.target.value as 'deep' | 'shallow' })}
              disabled
            >
              <SelectItem value="deep">深层递归合并</SelectItem>
              <SelectItem value="shallow">浅层按字段覆盖</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">暂未实现</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
