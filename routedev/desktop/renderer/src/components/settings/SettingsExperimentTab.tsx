// desktop/renderer/src/components/settings/SettingsExperimentTab.tsx
// Phase 44：并行实验设置

import type { AppConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';

interface SettingsExperimentTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsExperimentTab({ draft, updateDraft }: SettingsExperimentTabProps) {
  const experiment = draft.experiment;

  const updateExperiment = (patch: Partial<typeof experiment>) => {
    updateDraft({ experiment: { ...experiment, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>并行实验</CardTitle>
          <CardDescription>控制多分支并行实验的并发与冲突检测</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="experiment-parallel-enabled">启用并行实验</Label>
              <p className="text-xs text-rd-textMuted">允许同时运行多个实验分支并自动对比结果。</p>
            </div>
            <Switch
              id="experiment-parallel-enabled"
              checked={experiment.parallelEnabled}
              onCheckedChange={(checked) => updateExperiment({ parallelEnabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="experiment-conflict-detection">启用冲突检测</Label>
              <p className="text-xs text-rd-textMuted">并行前检测分支间的文件写冲突。</p>
            </div>
            <Switch
              id="experiment-conflict-detection"
              checked={experiment.conflictDetection}
              onCheckedChange={(checked) => updateExperiment({ conflictDetection: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="experiment-max-parallel">最大并行实验数</Label>
            <Input
              id="experiment-max-parallel"
              type="number"
              min={2}
              max={5}
              value={experiment.maxParallel}
              onChange={(e) => updateExperiment({ maxParallel: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">同时运行的最大实验分支数（2-5）。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="experiment-auto-cleanup">自动清理天数</Label>
            <Input
              id="experiment-auto-cleanup"
              type="number"
              min={0}
              value={experiment.autoCleanupDays}
              onChange={(e) => updateExperiment({ autoCleanupDays: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">0 表示不自动清理。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
