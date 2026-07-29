// desktop/renderer/src/components/settings/SettingsOptimizationTab.tsx
// Phase 74-G：可观测性 Tab（Token 追踪 + 生产安全防护 + 简洁输出 + 提示词模板系统）
// 从 SettingsPage.tsx 迁移

import type { AppConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';

interface SettingsOptimizationTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 Token 追踪配置 */
  updateTokenTracking: (patch: Partial<AppConfig['optimization']['tokenTracking']>) => void;
  /** 更新生产安全防护配置 */
  updateSafety: (patch: Partial<AppConfig['optimization']['safety']>) => void;
  /** 更新简洁思考约束配置 */
  updateConciseThinking: (patch: Partial<AppConfig['optimization']['conciseThinking']>) => void;
  /** 更新提示词模板系统配置 */
  updatePrompts: (patch: Partial<AppConfig['prompts']>) => void;
}

/**
 * 可观测性 Tab
 * 包含：Token 追踪、生产安全防护（先读后写/工具输出截断/独立验证门）、简洁输出约束、提示词模板系统
 */
export function SettingsOptimizationTab({
  draft,
  updateTokenTracking,
  updateSafety,
  updateConciseThinking,
  updatePrompts,
}: SettingsOptimizationTabProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Token 追踪</CardTitle>
          <CardDescription>追踪各组件的 Token 用量</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="tracking-enabled">启用 Token Profiling</Label>
              <p className="text-xs text-rd-textMuted">按组件（路由、工具、记忆等）分别统计 Token 消耗，便于定位成本热点。</p>
            </div>
            <Switch
              id="tracking-enabled"
              checked={draft.optimization.tokenTracking.enabled}
              onCheckedChange={(checked) => updateTokenTracking({ enabled: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="tracking-persist">持久化会话快照</Label>
              <p className="text-xs text-rd-textMuted">将会话的 Token 统计写入磁盘，便于离线分析。关闭则只在内存中统计。</p>
            </div>
            <Switch
              id="tracking-persist"
              checked={draft.optimization.tokenTracking.persistSession}
              onCheckedChange={(checked) => updateTokenTracking({ persistSession: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tracking-output">快照输出目录</Label>
            <Input
              id="tracking-output"
              value={draft.optimization.tokenTracking.outputDir}
              onChange={(e) => updateTokenTracking({ outputDir: e.target.value })}
            />
            <p className="text-xs text-rd-textMuted">Token 统计快照的存储路径，相对于当前工作目录。</p>
          </div>
        </CardContent>
      </Card>

      {/* Phase 31 Task 6：生产安全防护 */}
      <Card>
        <CardHeader>
          <CardTitle>生产安全防护</CardTitle>
          <CardDescription>防止误操作的安全防护机制</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="sf-rbw">强制先读后写</Label>
              <p className="text-xs text-rd-textMuted">file_write/file_edit 前必须先 file_read 过该文件（新建文件除外），防止盲改。</p>
            </div>
            <Switch
              id="sf-rbw"
              checked={draft.optimization.safety.readBeforeWrite}
              onCheckedChange={(checked) => updateSafety({ readBeforeWrite: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sf-max-output">工具输出最大字符数</Label>
            <Input
              id="sf-max-output"
              type="number"
              min={1000}
              max={100000}
              value={draft.optimization.safety.maxToolOutputChars}
              onChange={(e) => updateSafety({ maxToolOutputChars: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">超过此长度将智能截断（优先保留错误区域），范围 1000~100000。</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="sf-gate">独立验证门</Label>
              <p className="text-xs text-rd-textMuted">任务完成前独立运行 typecheck/lint/tests 验证，不信任 LLM 的"已完成"判断。</p>
            </div>
            <Switch
              id="sf-gate"
              checked={draft.optimization.safety.completionGate}
              onCheckedChange={(checked) => updateSafety({ completionGate: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sf-gate-timeout">验证门超时（毫秒）</Label>
            <Input
              id="sf-gate-timeout"
              type="number"
              min={10000}
              max={600000}
              value={draft.optimization.safety.gateTimeout}
              onChange={(e) => updateSafety({ gateTimeout: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">typecheck/lint/tests 总执行超时，范围 10000~600000 毫秒。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sf-gate-retry">验证门失败重试次数</Label>
            <Input
              id="sf-gate-retry"
              type="number"
              min={0}
              max={5}
              value={draft.optimization.safety.gateRetry}
              onChange={(e) => updateSafety({ gateRetry: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">验证门失败后允许 Agent 修复并重试的最大次数，范围 0~5。</p>
          </div>
        </CardContent>
      </Card>

      {/* 任务3：简洁输出约束 */}
      <Card>
        <CardHeader>
          <CardTitle>简洁输出</CardTitle>
          <CardDescription>控制输出的简洁程度</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="concise-enabled">启用简洁思考约束</Label>
              <p className="text-xs text-rd-textMuted">开启后追加输出纪律到系统提示词，裁剪过长的工具返回（&gt;2000 字符时保留首尾各 800 字符）。用户消息包含"详细/完整"等关键词时临时跳过约束。</p>
            </div>
            <Switch
              id="concise-enabled"
              checked={draft.optimization.conciseThinking.enabled}
              onCheckedChange={(checked) => updateConciseThinking({ enabled: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Phase 33 Task 3.1：提示词模板系统配置 */}
      <Card>
        <CardHeader>
          <CardTitle>提示词模板系统</CardTitle>
          <CardDescription>自定义提示词模板</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="prompts-override">允许项目级覆盖</Label>
              <p className="text-xs text-rd-textMuted">允许项目目录下的模板覆盖内置模板，实现项目级定制。</p>
            </div>
            <Switch
              id="prompts-override"
              checked={draft.prompts.projectOverrides}
              onCheckedChange={(checked) => updatePrompts({ projectOverrides: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="prompts-cache">模板缓存 TTL（秒）</Label>
            <Input
              id="prompts-cache"
              type="number"
              min={0}
              value={draft.prompts.cacheTtlSeconds}
              onChange={(e) => updatePrompts({ cacheTtlSeconds: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">模板编译后的缓存存活秒数，0 表示不缓存。缓存可减少重复编译开销。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="prompts-dir">用户模板目录（可选）</Label>
            <Input
              id="prompts-dir"
              value={draft.prompts.userTemplatesDir ?? ''}
              onChange={(e) => updatePrompts({ userTemplatesDir: e.target.value || undefined })}
              placeholder="留空使用默认路径"
            />
            <p className="text-xs text-rd-textMuted">用户自定义模板的根目录路径，留空使用内置默认路径。高级用户配置。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
