// desktop/renderer/src/components/settings/SettingsExecutionTab.tsx
// Phase 74-G：执行配置 Tab（并发/熔断 + 检查点提示 + 质量监测）
// 从 SettingsPage.tsx 迁移

import type { AppConfig, ExecutionConfig } from '../../../../../src/config/schema.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';

interface SettingsExecutionTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新执行配置（并发/熔断/检查点提示） */
  updateExecution: (patch: Partial<ExecutionConfig>) => void;
  /** 更新质量监测配置 */
  updateQuality: (patch: Partial<AppConfig['quality']>) => void;
}

/**
 * 执行配置 Tab
 * 包含：并发与熔断、检查点提示、质量监测（隐式反馈/信号保留/知识图谱自动改进）
 */
export function SettingsExecutionTab({
  draft,
  updateExecution,
  updateQuality,
}: SettingsExecutionTabProps) {
  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>并发与熔断</CardTitle>
          <CardDescription>控制最大并发数与模型熔断机制，避免雪崩失败</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="exec-concurrency">最大并发数（{draft.execution.maxConcurrency}）</Label>
            <input
              id="exec-concurrency"
              type="range"
              min="1"
              max="20"
              step="1"
              value={draft.execution.maxConcurrency}
              onChange={(e) => updateExecution({ maxConcurrency: Number(e.target.value) })}
              className="w-full accent-rd-primary"
            />
            <div className="flex justify-between text-xs text-rd-textMuted">
              <span>1</span>
              <span>5</span>
              <span>10</span>
              <span>15</span>
              <span>20</span>
            </div>
            <p className="text-xs text-rd-textMuted">同时执行的任务/请求上限，范围 1-20，默认 3。</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="exec-cb">熔断机制</Label>
              <p className="text-xs text-rd-textMuted">连续失败达到阈值后暂停请求，避免持续重试造成雪崩。</p>
            </div>
            <Switch
              id="exec-cb"
              checked={draft.execution.circuitBreaker}
              onCheckedChange={(checked) => updateExecution({ circuitBreaker: checked })}
            />
          </div>

          {draft.execution.circuitBreaker && (
            <>
              <div className="space-y-2">
                <Label htmlFor="exec-cb-threshold">熔断阈值（连续失败次数）</Label>
                <Input
                  id="exec-cb-threshold"
                  type="number"
                  min={1}
                  value={draft.execution.circuitBreakerThreshold}
                  onChange={(e) => updateExecution({ circuitBreakerThreshold: Number(e.target.value) })}
                />
                <p className="text-xs text-rd-textMuted">连续失败达到此次数后触发熔断，默认 5。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="exec-cb-duration">熔断持续时间（毫秒）</Label>
                <Input
                  id="exec-cb-duration"
                  type="number"
                  min={1000}
                  value={draft.execution.circuitBreakerDuration}
                  onChange={(e) => updateExecution({ circuitBreakerDuration: Number(e.target.value) })}
                />
                <p className="text-xs text-rd-textMuted">熔断后等待此时间再重试，范围 1000ms 起默认 30000ms。</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>检查点提示</CardTitle>
          <CardDescription>保存检查点时是否显示 UI 提示</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="exec-checkpoint-notify">检查点提示</Label>
              <p className="text-xs text-rd-textMuted">开启后每次保存检查点都会在界面底部显示短暂提示。</p>
            </div>
            <Switch
              id="exec-checkpoint-notify"
              checked={draft.execution.checkpointNotify}
              onCheckedChange={(checked) => updateExecution({ checkpointNotify: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Phase 40：质量监测 */}
      <Card>
        <CardHeader>
          <CardTitle>质量监测</CardTitle>
          <CardDescription>隐式反馈检测 + 信号保留 + 知识图谱自动改进</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="quality-implicit">启用隐式反馈检测</Label>
              <p className="text-xs text-rd-textMuted">检测用户行为中的隐式反馈（如反复修改同一文件），自动降级模型信任度。</p>
            </div>
            <Switch
              id="quality-implicit"
              checked={draft.quality.enableImplicitFeedback}
              onCheckedChange={(checked) => updateQuality({ enableImplicitFeedback: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="quality-threshold">负面信号降级阈值: {draft.quality.negativeSignalThreshold.toFixed(2)}</Label>
            <input
              id="quality-threshold"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={draft.quality.negativeSignalThreshold}
              onChange={(e) => updateQuality({ negativeSignalThreshold: Number(e.target.value) })}
              className="mt-2 w-full accent-rd-primary"
            />
            <p className="text-xs text-rd-textMuted">负面信号累计达到此阈值时触发模型降级，默认 0.4。设高了反应迟钝，设低了可能误降级。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="quality-retention">信号保留天数</Label>
            <Input
              id="quality-retention"
              type="number"
              min={1}
              value={draft.quality.signalRetentionDays}
              onChange={(e) => updateQuality({ signalRetentionDays: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">质量信号保留天数，超过此天数的信号自动清理，默认 30 天。</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="quality-auto-improve">自动改进知识图谱</Label>
              <p className="text-xs text-rd-textMuted">将质量信号反馈到知识图谱，自动标记过时或错误的节点。</p>
            </div>
            <Switch
              id="quality-auto-improve"
              checked={draft.quality.autoImproveKnowledgeGraph}
              onCheckedChange={(checked) => updateQuality({ autoImproveKnowledgeGraph: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="quality-debounce">去抖时间（毫秒）</Label>
            <Input
              id="quality-debounce"
              type="number"
              min={0}
              value={draft.quality.debounceMs}
              onChange={(e) => updateQuality({ debounceMs: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">质量信号处理的去抖间隔，避免频繁触发降级，默认 3000ms。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
