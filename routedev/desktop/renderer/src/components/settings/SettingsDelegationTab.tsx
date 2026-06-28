// desktop/renderer/src/components/settings/SettingsDelegationTab.tsx
// Phase 51 Task 2/3/4：委托四维约束 + 三态策略配置
// 控制子 Agent 委托深度/并行、专家可用性、工具调用守卫、会话隔离等。

import type { AppConfig, DelegationPolicyConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';
import { Select, SelectItem } from '../ui/select.js';

interface SettingsDelegationTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

const DEPTH_PASSING_MODES = [
  { value: 'counter', label: 'counter（计数器传递）' },
  { value: 'env', label: 'env（环境变量传递）' },
] as const;

export function SettingsDelegationTab({ draft, updateDraft }: SettingsDelegationTabProps) {
  const policy: DelegationPolicyConfig = draft.delegationPolicy ?? ({} as DelegationPolicyConfig);

  const updatePolicy = (patch: Partial<DelegationPolicyConfig>) => {
    updateDraft({ delegationPolicy: { ...policy, ...patch } });
  };

  // Phase 55 Task 14：跨区配置更新 helper
  const updateDelegationIntegration = (patch: Partial<typeof draft.delegationIntegration>) => {
    updateDraft({ delegationIntegration: { ...draft.delegationIntegration, ...patch } });
  };
  const updatePhase52 = (patch: Partial<typeof draft.phase52Integration>) => {
    updateDraft({ phase52Integration: { ...draft.phase52Integration, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>委托策略</CardTitle>
          <CardDescription>
            控制子 Agent 委托的四维约束（深度/并行/专家/工具）与三态策略（绑定/隔离/传播）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="delegation-bounded">启用有界委托</Label>
              <p className="text-xs text-rd-textMuted">限制委托的深度与并行度，防止失控递归。</p>
            </div>
            <Switch
              id="delegation-bounded"
              checked={policy.boundedDelegationEnabled ?? false}
              onCheckedChange={(checked) => updatePolicy({ boundedDelegationEnabled: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="delegation-max-depth">最大委托深度（0-5）</Label>
            <Input
              id="delegation-max-depth"
              type="number"
              min={0}
              max={5}
              value={policy.maxDepth ?? 1}
              onChange={(e) => updatePolicy({ maxDepth: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">0 表示禁止委托；5 为极深嵌套（不推荐）。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="delegation-max-parallel">最大并行子 Agent（1-10）</Label>
            <Input
              id="delegation-max-parallel"
              type="number"
              min={1}
              max={10}
              value={policy.maxParallel ?? 4}
              onChange={(e) => updatePolicy({ maxParallel: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">同时运行的子 Agent 数量上限。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="delegation-depth-mode">深度传递模式</Label>
            <Select
              id="delegation-depth-mode"
              value={policy.depthPassingMode ?? 'counter'}
              onChange={(e) => updatePolicy({ depthPassingMode: e.target.value as DelegationPolicyConfig['depthPassingMode'] })}
            >
              {DEPTH_PASSING_MODES.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">子 Agent 如何感知当前委托深度。</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="delegation-refuse-specialist">专家不可用时拒绝委托</Label>
              <p className="text-xs text-rd-textMuted">目标专家缺失时直接失败，而非降级处理。</p>
            </div>
            <Switch
              id="delegation-refuse-specialist"
              checked={policy.refuseIfSpecialistUnavailable ?? false}
              onCheckedChange={(checked) => updatePolicy({ refuseIfSpecialistUnavailable: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="delegation-tool-guard">启用工具调用守卫</Label>
              <p className="text-xs text-rd-textMuted">子 Agent 工具调用前经父 Agent 审核。</p>
            </div>
            <Switch
              id="delegation-tool-guard"
              checked={policy.toolCallGuardEnabled ?? false}
              onCheckedChange={(checked) => updatePolicy({ toolCallGuardEnabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="delegation-detached">启用分离会话</Label>
              <p className="text-xs text-rd-textMuted">子 Agent 在独立会话中运行，结束后合并结果。</p>
            </div>
            <Switch
              id="delegation-detached"
              checked={policy.detachedSessionEnabled ?? false}
              onCheckedChange={(checked) => updatePolicy({ detachedSessionEnabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="delegation-context-iso">完全上下文隔离</Label>
              <p className="text-xs text-rd-textMuted">子 Agent 不继承父 Agent 的对话上下文。</p>
            </div>
            <Switch
              id="delegation-context-iso"
              checked={policy.fullContextIsolation ?? true}
              onCheckedChange={(checked) => updatePolicy({ fullContextIsolation: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="delegation-sub-context-tokens">子 Agent 最大上下文 Token（1000-200000）</Label>
            <Input
              id="delegation-sub-context-tokens"
              type="number"
              min={1000}
              max={200000}
              value={policy.subAgentMaxContextTokens ?? 32000}
              onChange={(e) => updatePolicy({ subAgentMaxContextTokens: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">单个子 Agent 的上下文窗口上限。</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="delegation-propagate">向父 Agent 传播工具调用</Label>
              <p className="text-xs text-rd-textMuted">子 Agent 的工具调用同步回父 Agent 上下文。</p>
            </div>
            <Switch
              id="delegation-propagate"
              checked={policy.propagateToolCallsToParent ?? false}
              onCheckedChange={(checked) => updatePolicy({ propagateToolCallsToParent: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Phase 55 Task 14：子 Agent 模块开关 */}
      <Card>
        <CardHeader>
          <CardTitle>子 Agent 模块开关</CardTitle>
          <CardDescription>
            Phase 55 新增的委托体系模块、自演化框架等开关。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">

          {/* 1. 委托门控开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="delegation-gate-enabled">委托门控</Label>
              <p className="text-xs text-rd-textMuted">DelegationGate 委托前检查资格,防止无效委托。</p>
            </div>
            <Switch
              id="delegation-gate-enabled"
              checked={draft.delegationIntegration?.delegationGateEnabled ?? true}
              onCheckedChange={(checked) => updateDelegationIntegration({ delegationGateEnabled: checked })}
            />
          </div>

          {/* 2. 委托执行器开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="delegation-enforcer-enabled">委托执行器</Label>
              <p className="text-xs text-rd-textMuted">DelegationEnforcer 执行中校验工具调用,契约履行保障。</p>
            </div>
            <Switch
              id="delegation-enforcer-enabled"
              checked={draft.delegationIntegration?.delegationEnforcerEnabled ?? true}
              onCheckedChange={(checked) => updateDelegationIntegration({ delegationEnforcerEnabled: checked })}
            />
          </div>

          {/* 3. 生命周期管理开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="lifecycle-enabled">生命周期管理</Label>
              <p className="text-xs text-rd-textMuted">SubAgentLifecycle + AntiAbuseDetector 生命周期与反滥用。</p>
            </div>
            <Switch
              id="lifecycle-enabled"
              checked={draft.delegationIntegration?.lifecycleEnabled ?? true}
              onCheckedChange={(checked) => updateDelegationIntegration({ lifecycleEnabled: checked })}
            />
          </div>

          {/* 4. 质量评分卡开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="score-card-enabled">质量评分卡</Label>
              <p className="text-xs text-rd-textMuted">SubAgentScoreCardCollector 执行后收集评分。</p>
            </div>
            <Switch
              id="score-card-enabled"
              checked={draft.delegationIntegration?.scoreCardEnabled ?? true}
              onCheckedChange={(checked) => updateDelegationIntegration({ scoreCardEnabled: checked })}
            />
          </div>

          {/* 5. 上下文打包器开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="context-packer-enabled">上下文打包器</Label>
              <p className="text-xs text-rd-textMuted">ContextPacker 按角色打包上下文,选择性传递。</p>
            </div>
            <Switch
              id="context-packer-enabled"
              checked={draft.delegationIntegration?.contextPackerEnabled ?? true}
              onCheckedChange={(checked) => updateDelegationIntegration({ contextPackerEnabled: checked })}
            />
          </div>

          {/* 6. 自进化框架开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="self-evolution-enabled">自进化框架</Label>
              <p className="text-xs text-rd-textMuted">收集执行信号,产出优化提案（不自动应用）。</p>
            </div>
            <Switch
              id="self-evolution-enabled"
              checked={draft.phase52Integration?.selfEvolution?.enabled ?? true}
              onCheckedChange={(checked) => updatePhase52({ selfEvolution: { ...draft.phase52Integration?.selfEvolution, enabled: checked } })}
            />
          </div>

          {/* 7. Gödel 提案器开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="godel-proposer-enabled">Gödel 提案器</Label>
              <p className="text-xs text-rd-textMuted">基于执行历史的提案生成,需用户确认后应用。</p>
            </div>
            <Switch
              id="godel-proposer-enabled"
              checked={draft.phase52Integration?.godelProposer?.enabled ?? true}
              onCheckedChange={(checked) => updatePhase52({ godelProposer: { ...draft.phase52Integration?.godelProposer, enabled: checked } })}
            />
          </div>

          {/* 8. Self-Harness 循环开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="self-harness-enabled">Self-Harness 循环</Label>
              <p className="text-xs text-rd-textMuted">弱点挖掘 + 回归测试,保障提案质量。</p>
            </div>
            <Switch
              id="self-harness-enabled"
              checked={draft.phase52Integration?.selfHarness?.enabled ?? true}
              onCheckedChange={(checked) => updatePhase52({ selfHarness: { ...draft.phase52Integration?.selfHarness, enabled: checked } })}
            />
          </div>

        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsDelegationTab;
