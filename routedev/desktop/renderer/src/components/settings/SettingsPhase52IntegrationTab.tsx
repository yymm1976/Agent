// desktop/renderer/src/components/settings/SettingsPhase52IntegrationTab.tsx
// Phase 52 MUSE-Autoskill 集成总开关（含 10 个子任务）
// 本 Tab 聚合关键子任务的核心字段，便于快速启用 / 调参。
import type { AppConfig, Phase52IntegrationConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';
import { Select, SelectItem } from '../ui/select.js';

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

  // Skill 生命周期（Task 1）
  const skillLifecycle = cfg.skillLifecycle ?? {};
  const updateSkillLifecycle = (patch: Partial<typeof skillLifecycle>) => {
    update({ skillLifecycle: { ...skillLifecycle, ...patch } });
  };

  // 过程级缺陷评估（Task 2）
  const processEvaluation = cfg.processEvaluation ?? {};
  const updateProcessEvaluation = (patch: Partial<typeof processEvaluation>) => {
    update({ processEvaluation: { ...processEvaluation, ...patch } });
  };

  // 架构感知指标（Task 6）
  const archAwareMetrics = cfg.archAwareMetrics ?? {};
  const updateArchAwareMetrics = (patch: Partial<typeof archAwareMetrics>) => {
    update({ archAwareMetrics: { ...archAwareMetrics, ...patch } });
  };

  // 评估集饱和监测（Task 7）
  const saturationMonitor = cfg.saturationMonitor ?? {};
  const updateSaturationMonitor = (patch: Partial<typeof saturationMonitor>) => {
    update({ saturationMonitor: { ...saturationMonitor, ...patch } });
  };

  // Gödel 提案器（Task 8）
  const godelProposer = cfg.godelProposer ?? {};
  const updateGodelProposer = (patch: Partial<typeof godelProposer>) => {
    update({ godelProposer: { ...godelProposer, ...patch } });
  };

  // Self-Harness 循环（Task 9）
  const selfHarness = cfg.selfHarness ?? {};
  const updateSelfHarness = (patch: Partial<typeof selfHarness>) => {
    update({ selfHarness: { ...selfHarness, ...patch } });
  };

  // MCP 安全形式化框架（Task 10）
  const mcpSecurity = cfg.mcpSecurity ?? {};
  const updateMcpSecurity = (patch: Partial<typeof mcpSecurity>) => {
    update({ mcpSecurity: { ...mcpSecurity, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      {/* Task 1：Skill 生命周期 */}
      <Card>
        <CardHeader>
          <CardTitle>Skill 生命周期（Task 1）</CardTitle>
          <CardDescription>MUSE-Autoskill 五阶段生命周期：Creation / Memory / Management / Evaluation / Refinement。</CardDescription>
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

      {/* Task 2：过程级缺陷评估 */}
      <Card>
        <CardHeader>
          <CardTitle>过程级缺陷评估（Task 2）</CardTitle>
          <CardDescription>在内循环中按步评估执行质量，及时暴露过程级缺陷。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-proceval-enabled">启用过程级缺陷评估</Label>
              <p className="text-xs text-rd-textMuted">开启后在每个步骤完成后采集过程级指标。</p>
            </div>
            <Switch
              id="p52-proceval-enabled"
              checked={processEvaluation.enabled ?? false}
              onCheckedChange={(checked) => updateProcessEvaluation({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-proceval-sensitivity">敏感度</Label>
            <Select
              id="p52-proceval-sensitivity"
              value={processEvaluation.sensitivity ?? 'medium'}
              onChange={(e) => updateProcessEvaluation({ sensitivity: e.target.value as 'low' | 'medium' | 'high' })}
            >
              <SelectItem value="low">low（宽松）</SelectItem>
              <SelectItem value="medium">medium（标准）</SelectItem>
              <SelectItem value="high">high（严格）</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">敏感度越高，越倾向把波动记为缺陷。</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-proceval-show">展示过程评分</Label>
              <p className="text-xs text-rd-textMuted">在质量面板中展示过程级评分。</p>
            </div>
            <Switch
              id="p52-proceval-show"
              checked={processEvaluation.showProcessGrade ?? true}
              onCheckedChange={(checked) => updateProcessEvaluation({ showProcessGrade: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-proceval-ctrl">控制保留阈值（0-1）</Label>
            <Input
              id="p52-proceval-ctrl"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={processEvaluation.controlPreservationThreshold ?? 0.7}
              onChange={(e) => updateProcessEvaluation({ controlPreservationThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">控制流保留比例低于此值时视为缺陷。</p>
          </div>
        </CardContent>
      </Card>

      {/* Task 6：架构感知指标 */}
      <Card>
        <CardHeader>
          <CardTitle>架构感知指标（Task 6）</CardTitle>
          <CardDescription>从执行轨迹提取 6 组件指标并识别异常。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-arch-enabled">启用架构感知指标</Label>
              <p className="text-xs text-rd-textMuted">开启后在内循环完成时采集组件指标。</p>
            </div>
            <Switch
              id="p52-arch-enabled"
              checked={archAwareMetrics.enabled ?? false}
              onCheckedChange={(checked) => updateArchAwareMetrics({ enabled: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-arch-show">在 /quality 中展示</Label>
              <p className="text-xs text-rd-textMuted">在质量命令输出中包含架构感知诊断。</p>
            </div>
            <Switch
              id="p52-arch-show"
              checked={archAwareMetrics.showInQualityCommand ?? true}
              onCheckedChange={(checked) => updateArchAwareMetrics({ showInQualityCommand: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Task 7：评估集饱和监测 */}
      <Card>
        <CardHeader>
          <CardTitle>评估集饱和监测（Task 7）</CardTitle>
          <CardDescription>持续监测 passRate / scoreVariance / discrimination，在饱和时给出补强建议。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-sat-enabled">启用饱和监测</Label>
              <p className="text-xs text-rd-textMuted">开启后由 EvaluationFramework 在每次 runEvaluation 后调用。</p>
            </div>
            <Switch
              id="p52-sat-enabled"
              checked={saturationMonitor.enabled ?? false}
              onCheckedChange={(checked) => updateSaturationMonitor({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-sat-pass">通过率阈值（0.5-1）</Label>
            <Input
              id="p52-sat-pass"
              type="number"
              min={0.5}
              max={1}
              step={0.01}
              value={saturationMonitor.passRateThreshold ?? 0.95}
              onChange={(e) => updateSaturationMonitor({ passRateThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">高于此值且方差低于阈值时判定为 saturated。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-sat-var">方差阈值（0-0.5）</Label>
            <Input
              id="p52-sat-var"
              type="number"
              min={0}
              max={0.5}
              step={0.01}
              value={saturationMonitor.varianceThreshold ?? 0.05}
              onChange={(e) => updateSaturationMonitor({ varianceThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">低于此值且通过率高于阈值时判定为 saturated。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-sat-interval">检查间隔（5-100）</Label>
            <Input
              id="p52-sat-interval"
              type="number"
              min={5}
              max={100}
              value={saturationMonitor.checkInterval ?? 10}
              onChange={(e) => updateSaturationMonitor({ checkInterval: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">至少积累多少次运行结果才开始评估。</p>
          </div>
        </CardContent>
      </Card>

      {/* Task 8：Gödel 提案器 */}
      <Card>
        <CardHeader>
          <CardTitle>Gödel 提案器（Task 8）</CardTitle>
          <CardDescription>外循环失败后基于执行历史生成优化提案。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-godel-enabled">启用 Gödel 提案器</Label>
              <p className="text-xs text-rd-textMuted">开启后在外循环失败时生成优化提案。</p>
            </div>
            <Switch
              id="p52-godel-enabled"
              checked={godelProposer.enabled ?? false}
              onCheckedChange={(checked) => updateGodelProposer({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-godel-max">单次最大提案数（1-20）</Label>
            <Input
              id="p52-godel-max"
              type="number"
              min={1}
              max={20}
              value={godelProposer.maxProposalsPerRun ?? 5}
              onChange={(e) => updateGodelProposer({ maxProposalsPerRun: Number(e.target.value) })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-godel-approve">需要用户审批</Label>
              <p className="text-xs text-rd-textMuted">提案应用前必须经用户确认。</p>
            </div>
            <Switch
              id="p52-godel-approve"
              checked={godelProposer.requireUserApproval ?? true}
              onCheckedChange={(checked) => updateGodelProposer({ requireUserApproval: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Task 9：Self-Harness 循环 */}
      <Card>
        <CardHeader>
          <CardTitle>Self-Harness 循环（Task 9）</CardTitle>
          <CardDescription>自安全套件：弱点发现 → 提案 → 验证 → 应用。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-harness-enabled">启用 Self-Harness 循环</Label>
              <p className="text-xs text-rd-textMuted">开启后在外循环失败时触发弱点分析与改进。</p>
            </div>
            <Switch
              id="p52-harness-enabled"
              checked={selfHarness.enabled ?? false}
              onCheckedChange={(checked) => updateSelfHarness({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-harness-max">单周期最大提案数（1-20）</Label>
            <Input
              id="p52-harness-max"
              type="number"
              min={1}
              max={20}
              value={selfHarness.maxProposalsPerCycle ?? 5}
              onChange={(e) => updateSelfHarness({ maxProposalsPerCycle: Number(e.target.value) })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-harness-regression">要求回归测试</Label>
              <p className="text-xs text-rd-textMuted">提案应用前必须通过回归测试。</p>
            </div>
            <Switch
              id="p52-harness-regression"
              checked={selfHarness.requireRegressionTest ?? true}
              onCheckedChange={(checked) => updateSelfHarness({ requireRegressionTest: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Task 10：MCP 安全形式化框架 */}
      <Card>
        <CardHeader>
          <CardTitle>MCP 安全形式化框架（Task 10）</CardTitle>
          <CardDescription>来自 MCPSHIELD 论文：4 层深度防御 + 7 类威胁检测。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-mcpsec-enabled">启用 MCP 安全框架</Label>
              <p className="text-xs text-rd-textMuted">开启后对 MCP 工具调用执行 4 层深度防御。</p>
            </div>
            <Switch
              id="p52-mcpsec-enabled"
              checked={mcpSecurity.enabled ?? false}
              onCheckedChange={(checked) => updateMcpSecurity({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p52-mcpsec-strictness">严格度</Label>
            <Select
              id="p52-mcpsec-strictness"
              value={mcpSecurity.strictness ?? 'standard'}
              onChange={(e) => updateMcpSecurity({ strictness: e.target.value as 'permissive' | 'standard' | 'strict' })}
            >
              <SelectItem value="permissive">permissive（宽松）</SelectItem>
              <SelectItem value="standard">standard（标准）</SelectItem>
              <SelectItem value="strict">strict（严格）</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">严格度越高，威胁检测的阻断阈值越低。</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-mcpsec-l1">L1 能力层防御</Label>
              <p className="text-xs text-rd-textMuted">工具能力校验（声明与实际行为一致）。</p>
            </div>
            <Switch
              id="p52-mcpsec-l1"
              checked={mcpSecurity.l1CapabilityCheck ?? true}
              onCheckedChange={(checked) => updateMcpSecurity({ l1CapabilityCheck: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-mcpsec-l2">L2 证明层防御</Label>
              <p className="text-xs text-rd-textMuted">工具来源验证（attribution）。</p>
            </div>
            <Switch
              id="p52-mcpsec-l2"
              checked={mcpSecurity.l2AttestationCheck ?? false}
              onCheckedChange={(checked) => updateMcpSecurity({ l2AttestationCheck: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-mcpsec-l3">L3 信息流层防御</Label>
              <p className="text-xs text-rd-textMuted">数据流追踪（敏感数据外泄检测）。</p>
            </div>
            <Switch
              id="p52-mcpsec-l3"
              checked={mcpSecurity.l3InfoFlowTracking ?? true}
              onCheckedChange={(checked) => updateMcpSecurity({ l3InfoFlowTracking: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p52-mcpsec-l4">L4 运行时层防御</Label>
              <p className="text-xs text-rd-textMuted">运行时行为监控（异常调用模式检测）。</p>
            </div>
            <Switch
              id="p52-mcpsec-l4"
              checked={mcpSecurity.l4RuntimeMonitoring ?? true}
              onCheckedChange={(checked) => updateMcpSecurity({ l4RuntimeMonitoring: checked })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SettingsPhase52IntegrationTab;
