// desktop/renderer/src/components/settings/SettingsGoalTab.tsx
// Phase 43：/goal 流程配置

import type { AppConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';
import { Input } from '../ui/input.js';

interface SettingsGoalTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

const AUDIT_MODES = [
  { value: 'completion_gate_first', label: '验证门优先' },
  { value: 'reviewer_first', label: '审查器优先' },
  { value: 'all_must_pass', label: '全部通过' },
] as const;

export function SettingsGoalTab({ draft, updateDraft }: SettingsGoalTabProps) {
  const goal = draft.goal;

  const updateGoal = (patch: Partial<typeof goal>) => {
    updateDraft({ goal: { ...goal, ...patch } });
  };

  // Phase 55 Task 14：跨区配置更新 helper
  const updateExecutionRouter = (patch: Partial<typeof goal.executionRouter>) => {
    updateGoal({ executionRouter: { ...goal.executionRouter, ...patch } });
  };
  const updatePhase53 = (patch: Partial<typeof draft.phase53Integration>) => {
    updateDraft({ phase53Integration: { ...draft.phase53Integration, ...patch } });
  };
  const updatePhase52 = (patch: Partial<typeof draft.phase52Integration>) => {
    updateDraft({ phase52Integration: { ...draft.phase52Integration, ...patch } });
  };
  const updatePhase49 = (patch: Partial<typeof draft.phase49Integration>) => {
    updateDraft({ phase49Integration: { ...draft.phase49Integration, ...patch } });
  };
  const updateOrchestrationIntegration = (patch: Partial<typeof draft.orchestrationIntegration>) => {
    updateDraft({ orchestrationIntegration: { ...draft.orchestrationIntegration, ...patch } });
  };
  const updateReviewerPolicy = (patch: Partial<typeof draft.reviewerPolicy>) => {
    updateDraft({ reviewerPolicy: { ...draft.reviewerPolicy, ...patch } });
  };
  // Phase 50 Task 1：Goal 流程模块接入开关
  const updateGoalIntegration = (patch: Partial<NonNullable<typeof draft.goalIntegration>>) => {
    updateDraft({ goalIntegration: { ...draft.goalIntegration, ...patch } });
  };

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>/goal 流程</CardTitle>
          <CardDescription>控制目标分解、确认与审计的行为</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="goal-clarify">启用需求澄清</Label>
              <p className="text-xs text-rd-textMuted">执行前若目标模糊，自动追问澄清。</p>
            </div>
            <Switch
              id="goal-clarify"
              checked={goal.clarify}
              onCheckedChange={(checked) => updateGoal({ clarify: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="goal-require-confirmation">要求用户确认计划</Label>
              <p className="text-xs text-rd-textMuted">分解后的子任务计划需用户确认后才执行。</p>
            </div>
            <Switch
              id="goal-require-confirmation"
              checked={goal.requireConfirmation}
              onCheckedChange={(checked) => updateGoal({ requireConfirmation: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-audit-mode">审计模式</Label>
            <Select
              id="goal-audit-mode"
              value={goal.auditMode}
              onChange={(e) => updateGoal({ auditMode: e.target.value as typeof goal.auditMode })}
            >
              {AUDIT_MODES.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">目标完成后按哪种顺序执行审计。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-token-budget">Token 预算</Label>
            <Input
              id="goal-token-budget"
              type="number"
              min={1000}
              value={goal.tokenBudget}
              onChange={(e) => updateGoal({ tokenBudget: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">单次 /goal 任务的 token 上限。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal-soft-stop-ratio">软停止比例</Label>
            <Input
              id="goal-soft-stop-ratio"
              type="number"
              min={0.5}
              max={1}
              step={0.05}
              value={goal.softStopRatio}
              onChange={(e) => updateGoal({ softStopRatio: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">达到预算此比例时提示用户是否继续。</p>
          </div>
        </CardContent>
      </Card>

      {/* Phase 55 Task 14：执行路径与编排配置 */}
      <Card>
        <CardHeader>
          <CardTitle>执行路径与编排</CardTitle>
          <CardDescription>
            Phase 55 新增的执行路径判定、DAG 引擎、双循环编排等高级开关。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">

          {/* 1. 路径判定模式（单选 auto/legacy/explicit） */}
          <div className="space-y-2">
            <Label htmlFor="execution-router-mode">路径判定模式</Label>
            <Select
              id="execution-router-mode"
              value={goal.executionRouter?.mode ?? 'auto'}
              onChange={(e) => updateExecutionRouter({ mode: e.target.value as 'auto' | 'legacy' | 'explicit' })}
            >
              <SelectItem value="auto">auto（自动判定）</SelectItem>
              <SelectItem value="legacy">legacy（强制旧路径）</SelectItem>
              <SelectItem value="explicit">explicit（显式指定）</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">控制 /goal 执行路径的判定策略。</p>
          </div>

          {/* 2. 单 Agent 最大步数（Stepper 1-5） */}
          <div className="space-y-2">
            <Label htmlFor="single-agent-max-steps">单 Agent 最大步数（1-5）</Label>
            <Input
              id="single-agent-max-steps"
              type="number"
              min={1}
              max={5}
              value={goal.executionRouter?.singleAgentMaxSteps ?? 2}
              onChange={(e) => updateExecutionRouter({ singleAgentMaxSteps: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">步数 ≤ 此值且单领域时走单 Agent 路径。</p>
          </div>

          {/* 3. DAG 最大领域数（Stepper 1-5） */}
          <div className="space-y-2">
            <Label htmlFor="dag-max-domains">DAG 最大领域数（1-5）</Label>
            <Input
              id="dag-max-domains"
              type="number"
              min={1}
              max={5}
              value={goal.executionRouter?.dagMaxDomains ?? 1}
              onChange={(e) => updateExecutionRouter({ dagMaxDomains: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">领域数超过此值时从 DAG 升级到组合路由。</p>
          </div>

          {/* 4. DAG 引擎开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="dag-engine-enabled">DAG 引擎</Label>
              <p className="text-xs text-rd-textMuted">启用 DAG 工作流引擎,支持拓扑排序与并行执行。</p>
            </div>
            <Switch
              id="dag-engine-enabled"
              checked={draft.phase53Integration?.dagEngine?.enabled ?? true}
              onCheckedChange={(checked) => updatePhase53({ dagEngine: { ...draft.phase53Integration?.dagEngine, enabled: checked } })}
            />
          </div>

          {/* 5. 组合路由开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="compositional-routing-enabled">组合路由</Label>
              <p className="text-xs text-rd-textMuted">跨领域任务走 SAD 分解 + Skill 检索 + DAG 组合。</p>
            </div>
            <Switch
              id="compositional-routing-enabled"
              checked={draft.phase52Integration?.compositionalRouting?.enabled ?? true}
              onCheckedChange={(checked) => updatePhase52({ compositionalRouting: { ...draft.phase52Integration?.compositionalRouting, enabled: checked } })}
            />
          </div>

          {/* 6. 策略选择器开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="strategy-enabled">策略选择器</Label>
              <p className="text-xs text-rd-textMuted">按复杂度选择单 Agent 或多 Agent 策略。</p>
            </div>
            <Switch
              id="strategy-enabled"
              checked={draft.orchestrationIntegration?.strategyEnabled ?? false}
              onCheckedChange={(checked) => updateOrchestrationIntegration({ strategyEnabled: checked })}
            />
          </div>

          {/* 7. 步骤状态图开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="state-graph-enabled">步骤状态图</Label>
              <p className="text-xs text-rd-textMuted">ExecutionStateGraph 步骤状态管理与追踪。</p>
            </div>
            <Switch
              id="state-graph-enabled"
              checked={draft.orchestrationIntegration?.stateGraphEnabled ?? false}
              onCheckedChange={(checked) => updateOrchestrationIntegration({ stateGraphEnabled: checked })}
            />
          </div>

          {/* 8. 熔断器开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="circuit-breaker-enabled">熔断器</Label>
              <p className="text-xs text-rd-textMuted">连续失败时熔断,防止雪崩。</p>
            </div>
            <Switch
              id="circuit-breaker-enabled"
              checked={draft.phase53Integration?.circuitBreaker?.enabled ?? true}
              onCheckedChange={(checked) => updatePhase53({ circuitBreaker: { ...draft.phase53Integration?.circuitBreaker, enabled: checked } })}
            />
          </div>

          {/* 9. 双循环编排开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="dual-loop-enabled">双循环编排</Label>
              <p className="text-xs text-rd-textMuted">内循环执行 + 外循环验证,失败时局部重跑。</p>
            </div>
            <Switch
              id="dual-loop-enabled"
              checked={draft.phase49Integration?.dualLoopEnabled ?? true}
              onCheckedChange={(checked) => updatePhase49({ dualLoopEnabled: checked })}
            />
          </div>

          {/* 10. 有界恢复开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="bounded-recovery-enabled">有界恢复</Label>
              <p className="text-xs text-rd-textMuted">失败时回退到最近 checkpoint,只重跑失败步骤及其依赖闭包。</p>
            </div>
            <Switch
              id="bounded-recovery-enabled"
              checked={draft.phase52Integration?.boundedRecovery?.enabled ?? true}
              onCheckedChange={(checked) => updatePhase52({ boundedRecovery: { ...draft.phase52Integration?.boundedRecovery, enabled: checked } })}
            />
          </div>

          {/* 11. 跨模型审查开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="cross-model-reviewer">跨模型审查</Label>
              <p className="text-xs text-rd-textMuted">高风险任务自动用不同模型交叉审查。</p>
            </div>
            <Switch
              id="cross-model-reviewer"
              checked={draft.reviewerPolicy?.autoCrossModelForHighRisk ?? true}
              onCheckedChange={(checked) => updateReviewerPolicy({ autoCrossModelForHighRisk: checked })}
            />
          </div>

          {/* 12. Reviewer 分级开关 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="tiered-review">Reviewer 分级</Label>
              <p className="text-xs text-rd-textMuted">按任务规模分级（tiny/mid/big）,tiny 跳过外循环。</p>
            </div>
            <Switch
              id="tiered-review"
              checked={draft.reviewerPolicy?.tieredReviewEnabled ?? true}
              onCheckedChange={(checked) => updateReviewerPolicy({ tieredReviewEnabled: checked })}
            />
          </div>

        </CardContent>
      </Card>

      {/* Phase 50 Task 1：Goal 流程模块接入 */}
      <Card>
        <CardHeader>
          <CardTitle>Goal 流程模块接入</CardTitle>
          <CardDescription>
            /goal 流程四个核心模块的渐进式接入开关。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">

          {/* 1. 三层独立审计 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="goal-integration-audit">三层独立审计</Label>
              <p className="text-xs text-rd-textMuted">
                GoalAuditor 三层独立审计（completion_gate + verifier_llm + reviewer_agent）。
              </p>
            </div>
            <Switch
              id="goal-integration-audit"
              checked={draft.goalIntegration?.auditEnabled ?? true}
              onCheckedChange={(checked) => updateGoalIntegration({ auditEnabled: checked })}
            />
          </div>

          {/* 2. 持久化与崩溃恢复 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="goal-integration-persistence">持久化与崩溃恢复</Label>
              <p className="text-xs text-rd-textMuted">
                写入 .routedev/goals/&lt;id&gt;.json，崩溃后可恢复继续执行。
              </p>
            </div>
            <Switch
              id="goal-integration-persistence"
              checked={draft.goalIntegration?.persistenceEnabled ?? true}
              onCheckedChange={(checked) => updateGoalIntegration({ persistenceEnabled: checked })}
            />
          </div>

          {/* 3. GoalPromptBuilder 五段式规范构造 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="goal-integration-prompt-builder">GoalPromptBuilder 五段式规范</Label>
              <p className="text-xs text-rd-textMuted">
                开启后用五段式规范构造 /goal 提示词，提升结构化程度。
              </p>
            </div>
            <Switch
              id="goal-integration-prompt-builder"
              checked={draft.goalIntegration?.promptBuilderEnabled ?? false}
              onCheckedChange={(checked) => updateGoalIntegration({ promptBuilderEnabled: checked })}
            />
          </div>

          {/* 4. RequirementChangeAnalyzer 需求变更分析 */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="goal-integration-requirement-change">需求变更分析</Label>
              <p className="text-xs text-rd-textMuted">
                RequirementChangeAnalyzer：检测需求中途变更并触发重规划。
              </p>
            </div>
            <Switch
              id="goal-integration-requirement-change"
              checked={draft.goalIntegration?.requirementChangeEnabled ?? false}
              onCheckedChange={(checked) => updateGoalIntegration({ requirementChangeEnabled: checked })}
            />
          </div>

        </CardContent>
      </Card>
    </div>
  );
}
