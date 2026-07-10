// desktop/renderer/src/components/settings/SettingsPhase52IntegrationTab.tsx
// Phase 52 MUSE-Autoskill 集成总开关（含 10 个子任务）
// 本 Tab 聚合关键子任务的核心字段，便于快速启用 / 调参。
// Phase 59：processEvaluation/archAwareMetrics/saturationMonitor 已删除（批次1 无价值 Integration）
// Phase 59：mcpSecurity 已删除（批次3，与 phase53Integration.mcpSecurityScan 重复，保留 53 的）
// Phase 60：合并到 '安全与治理' tab，删除 Task N 编号
import type { AppConfig, Phase52IntegrationConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';

interface SettingsPhase52IntegrationTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsPhase52IntegrationTab({ draft, updateDraft }: SettingsPhase52IntegrationTabProps) {
  const cfg: Phase52IntegrationConfig = draft.phase52Integration ?? ({} as Phase52IntegrationConfig);

  // 整体聚合更新：透传 patch 后再回写
  const update = (patch: Partial<Phase52IntegrationConfig>) => {
    updateDraft({ phase52Integration: { ...cfg, ...patch } });
  };

  // Skill 生命周期
  const skillLifecycle = cfg.skillLifecycle ?? {};
  const updateSkillLifecycle = (patch: Partial<typeof skillLifecycle>) => {
    update({ skillLifecycle: { ...skillLifecycle, ...patch } });
  };

  return (
    <div className="space-y-6">
      {/* Skill 生命周期 */}
      <Card>
        <CardHeader>
          <CardTitle>Skill 生命周期</CardTitle>
          <CardDescription>五阶段生命周期：创建 / 记忆 / 管理 / 评估 / 优化。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-skill-enabled">启用 Skill 生命周期管理</Label>
              <p className="text-xs text-rd-textMuted">开启后自动触发 Skill 创建与优化。</p>
            </div>
            <Switch
              id="p52-skill-enabled"
              checked={skillLifecycle.enabled ?? false}
              onCheckedChange={(checked) => updateSkillLifecycle({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-skill-threshold">创建触发相似任务次数阈值（2-10）</Label>
            <Input
              id="p52-skill-threshold"
              type="number"
              min={2}
              max={10}
              value={skillLifecycle.creationTriggerThreshold ?? 3}
              onChange={(e) => updateSkillLifecycle({ creationTriggerThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">相似任务达到此次数后触发 Skill 创建。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-skill-retention">记忆保留天数（1-365）</Label>
            <Input
              id="p52-skill-retention"
              type="number"
              min={1}
              max={365}
              value={skillLifecycle.memoryRetentionDays ?? 30}
              onChange={(e) => updateSkillLifecycle({ memoryRetentionDays: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">超过此天数的记忆立即清理（隐患 #171）。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
