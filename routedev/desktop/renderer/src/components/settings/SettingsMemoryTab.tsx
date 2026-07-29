// desktop/renderer/src/components/settings/SettingsMemoryTab.tsx
// Phase 74-G：记忆设置 Tab（增量 Checkpoint + 目标验证器 + 项目记忆 + 记忆推理）
// 从 SettingsPage.tsx 迁移

import { Trash2, Plus } from 'lucide-react';
import type { AppConfig } from '../../../../shared/config-types.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';

interface SettingsMemoryTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 Checkpoint 配置 */
  updateCheckpoint: (patch: Partial<AppConfig['checkpoint']>) => void;
  /** 更新 Checkpoint 触发器 */
  updateCheckpointTrigger: (index: number, patch: Partial<AppConfig['checkpoint']['triggers'][number]>) => void;
  /** 添加 Checkpoint 触发器 */
  addCheckpointTrigger: () => void;
  /** 删除 Checkpoint 触发器 */
  removeCheckpointTrigger: (index: number) => void;
  /** 更新目标验证器配置 */
  updateGoalVerifier: (patch: Partial<AppConfig['goalVerifier']>) => void;
  /** 更新项目记忆配置 */
  updateProjectMemory: (patch: Partial<AppConfig['projectMemory']>) => void;
  /** 更新记忆推理配置 */
  updateMemory: (patch: Partial<AppConfig['memory']>) => void;
}

/**
 * 记忆设置 Tab
 * 包含：增量 Checkpoint、目标验证器、项目记忆、记忆推理与注入
 */
export function SettingsMemoryTab({
  draft,
  updateCheckpoint,
  updateCheckpointTrigger,
  addCheckpointTrigger,
  removeCheckpointTrigger,
  updateGoalVerifier,
  updateProjectMemory,
  updateMemory,
}: SettingsMemoryTabProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>检查点</CardTitle>
          <CardDescription>按步骤自动压缩与恢复记忆</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="checkpoint-enabled">启用 Checkpoint</Label>
              <p className="text-xs text-rd-textMuted">定期压缩对话历史为摘要，避免长对话超出上下文窗口导致遗忘。</p>
            </div>
            <Switch
              id="checkpoint-enabled"
              checked={draft.checkpoint.enabled}
              onCheckedChange={(checked) => updateCheckpoint({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="checkpoint-model">Checkpoint 模型</Label>
            {/* 从已配置的模型中选择，留空则用路由默认模型 */}
            <Select
              id="checkpoint-model"
              value={draft.checkpoint.modelId}
              onChange={(e) => updateCheckpoint({ modelId: e.target.value })}
            >
              <SelectItem value="">跟随路由默认</SelectItem>
              {draft.providers.flatMap((p) => p.models).map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">执行压缩摘要的模型，建议用便宜模型。留空则用路由默认模型。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="checkpoint-max">单次 Checkpoint 最大 Token</Label>
            <Input
              id="checkpoint-max"
              type="number"
              value={draft.checkpoint.maxTokensPerCheckpoint}
              onChange={(e) => updateCheckpoint({ maxTokensPerCheckpoint: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">每次压缩生成的摘要最大长度，过小可能丢失细节，过大增加成本。</p>
          </div>

          {/* Phase 33 Task 3.3：Checkpoint 触发器编辑 */}
          <div className="space-y-2">
            <Label>触发器（上下文使用率达到指定百分比时触发对应动作）</Label>
            {draft.checkpoint.triggers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-rd-border bg-rd-surface p-3 text-center text-sm text-rd-textMuted">
                暂无触发器
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-rd-border">
                <div className="grid grid-cols-12 gap-2 border-b border-rd-border bg-rd-surface px-3 py-2 text-xs font-semibold text-rd-textMuted">
                  <div className="col-span-4">使用率 (%)</div>
                  <div className="col-span-6">动作</div>
                  <div className="col-span-2 text-right">操作</div>
                </div>
                <div className="divide-y divide-rd-border">
                  {draft.checkpoint.triggers.map((trigger, tIdx) => (
                    <div key={tIdx} className="grid grid-cols-12 items-center gap-2 px-3 py-2">
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        value={trigger.level}
                        onChange={(e) => updateCheckpointTrigger(tIdx, { level: Number(e.target.value) })}
                        className="col-span-4"
                      />
                      <Select
                        value={trigger.action}
                        onChange={(e) => updateCheckpointTrigger(tIdx, { action: e.target.value as 'initial' | 'incremental' | 'compress' })}
                        className="col-span-6"
                      >
                        <SelectItem value="initial">initial（初始摘要）</SelectItem>
                        <SelectItem value="incremental">incremental（增量摘要）</SelectItem>
                        <SelectItem value="compress">compress（全量压缩）</SelectItem>
                      </Select>
                      <div className="col-span-2 flex justify-end">
                        <Button
                          variant="outline"
                          size="icon"
                          className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                          onClick={() => removeCheckpointTrigger(tIdx)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={addCheckpointTrigger}>
              <Plus size={14} /> 添加触发器
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Phase 33 Task 3.1：目标验证器配置 */}
      <Card>
        <CardHeader>
          <CardTitle>目标验证器</CardTitle>
          <CardDescription>目标完成后的独立验证</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="gv-enabled">启用目标验证</Label>
              <p className="text-xs text-rd-textMuted">任务完成后由独立 LLM 验证目标是否达成，不信任 Agent 的"已完成"判断。</p>
            </div>
            <Switch
              id="gv-enabled"
              checked={draft.goalVerifier.enabled}
              onCheckedChange={(checked) => updateGoalVerifier({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gv-model">验证模型</Label>
            {/* 从已配置的模型中选择，留空则跟随路由默认 */}
            <Select
              id="gv-model"
              value={draft.goalVerifier.modelId}
              onChange={(e) => updateGoalVerifier({ modelId: e.target.value })}
            >
              <SelectItem value="">跟随路由默认</SelectItem>
              {draft.providers.flatMap((p) => p.models).map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">执行验证的模型，建议用 reasoning 级模型以保证验证质量。留空跟随路由默认。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="gv-max-tokens">单次验证最大 Token</Label>
            <Input
              id="gv-max-tokens"
              type="number"
              value={draft.goalVerifier.maxTokensPerVerification}
              onChange={(e) => updateGoalVerifier({ maxTokensPerVerification: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">每次验证消耗的最大用量。</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="gv-auto">完成后自动验证</Label>
              <p className="text-xs text-rd-textMuted">目标完成后自动触发验证，关闭则需手动调用验证。</p>
            </div>
            <Switch
              id="gv-auto"
              checked={draft.goalVerifier.autoVerify}
              onCheckedChange={(checked) => updateGoalVerifier({ autoVerify: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="gv-iterative">迭代验证闭环</Label>
              <p className="text-xs text-rd-textMuted">验证失败时自动生成补救步骤并重新执行，直到目标达成或达到最大迭代次数（借鉴 kimi-code 模式）。</p>
            </div>
            <Switch
              id="gv-iterative"
              checked={draft.goalVerifier.iterative?.enabled ?? false}
              onCheckedChange={(checked) => updateGoalVerifier({ iterative: { ...draft.goalVerifier.iterative, enabled: checked } })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gv-max-rounds">最大迭代次数</Label>
            <Input
              id="gv-max-rounds"
              type="number"
              min={1}
              max={10}
              value={draft.goalVerifier.iterative?.maxRounds ?? 3}
              onChange={(e) => updateGoalVerifier({ iterative: { ...draft.goalVerifier.iterative, maxRounds: Number(e.target.value) } })}
            />
            <p className="text-xs text-rd-textMuted">验证失败后最多重试的轮数（1-10），超过后停止迭代并标记为失败。</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>项目记忆</CardTitle>
          <CardDescription>跨会话保留项目上下文与决策记录</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="memory-enabled">启用项目记忆</Label>
              <p className="text-xs text-rd-textMuted">跨会话保留项目的关键上下文与决策记录，新会话自动加载历史记忆。</p>
            </div>
            <Switch
              id="memory-enabled"
              checked={draft.projectMemory.enabled}
              onCheckedChange={(checked) => updateProjectMemory({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="memory-size">最大记忆容量</Label>
            <Input
              id="memory-size"
              type="number"
              value={draft.projectMemory.maxMemorySize}
              onChange={(e) => updateProjectMemory({ maxMemorySize: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">项目记忆的最大条目数，超出后自动淘汰最旧的条目。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="memory-decisions">最大决策记录数</Label>
            <Input
              id="memory-decisions"
              type="number"
              value={draft.projectMemory.maxDecisions}
              onChange={(e) => updateProjectMemory({ maxDecisions: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">保留的关键决策记录数量，用于回溯为何做了某个选择。</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="memory-inject">自动注入上下文</Label>
              <p className="text-xs text-rd-textMuted">新会话开始时自动将项目记忆注入到系统提示词，无需手动引用。</p>
            </div>
            <Switch
              id="memory-inject"
              checked={draft.projectMemory.autoInject}
              onCheckedChange={(checked) => updateProjectMemory({ autoInject: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Phase 45：记忆推理与注入 */}
      <Card>
        <CardHeader>
          <CardTitle>记忆推理</CardTitle>
          <CardDescription>控制长期记忆的推理、学习与注入阈值</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="memory-inference">启用记忆推理</Label>
              <p className="text-xs text-rd-textMuted">根据当前对话自动检索并推理相关记忆。</p>
            </div>
            <Switch
              id="memory-inference"
              checked={draft.memory.inference}
              onCheckedChange={(checked) => updateMemory({ inference: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="memory-auto-learn">启用自动学习</Label>
              <p className="text-xs text-rd-textMuted">自动从对话中抽取事实与偏好并写入记忆。</p>
            </div>
            <Switch
              id="memory-auto-learn"
              checked={draft.memory.autoLearn}
              onCheckedChange={(checked) => updateMemory({ autoLearn: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="memory-inject-threshold">注入阈值</Label>
            <Input
              id="memory-inject-threshold"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={draft.memory.injectThreshold}
              onChange={(e) => updateMemory({ injectThreshold: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">记忆与当前对话相关度达到此值才注入（0-1）。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
