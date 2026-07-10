// desktop/renderer/src/components/settings/SettingsCommandsTab.tsx
// Phase 74-G：命令与工具 Tab（命令黑白名单 + 工具黑白名单 + 自主度补充 + Phase 48/49 接入 + 调度器）
// 从 SettingsPage.tsx 迁移

import type { AppConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';

interface SettingsCommandsTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 security 字段 */
  updateSecurity: (patch: Partial<AppConfig['security']>) => void;
  /** 更新 autonomy 字段 */
  updateAutonomy: (patch: Partial<AppConfig['autonomy']>) => void;
  /** 更新 Phase 48 接入开关 */
  updatePhase48Integration: (patch: Partial<NonNullable<AppConfig['phase48Integration']>>) => void;
  /** 更新 Phase 49 接入开关 */
  updatePhase49Integration: (patch: Partial<NonNullable<AppConfig['phase49Integration']>>) => void;
  /** 更新调度器配置 */
  updateScheduler: (patch: Partial<NonNullable<AppConfig['scheduler']>>) => void;
}

/**
 * 命令与工具 Tab
 * 包含：命令黑白名单、工具黑白名单、自主度补充设置、Phase 48/49 模块接入、调度器配置
 */
export function SettingsCommandsTab({
  draft,
  updateSecurity,
  updateAutonomy,
  updatePhase48Integration,
  updatePhase49Integration,
  updateScheduler,
}: SettingsCommandsTabProps) {
  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>命令黑白名单</CardTitle>
          <CardDescription>控制 Agent 可执行的 shell 命令范围</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cmd-blacklist">命令黑名单（逗号分隔）</Label>
            <Input
              id="cmd-blacklist"
              value={draft.security.commandBlacklist.join(', ')}
              onChange={(e) => updateSecurity({ commandBlacklist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="例如 rm -rf, format, del /s"
            />
            <p className="text-xs text-rd-textMuted">匹配到的命令会被直接拦截，Agent 不会执行。支持完整命令字符串匹配。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-whitelist">命令白名单（逗号分隔）</Label>
            <Input
              id="cmd-whitelist"
              value={draft.security.commandWhitelist.join(', ')}
              onChange={(e) => updateSecurity({ commandWhitelist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="留空表示不限制"
            />
            <p className="text-xs text-rd-textMuted">仅允许 Agent 执行白名单内的命令；留空表示不限制。黑名单优先生效。</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>工具黑白名单</CardTitle>
          <CardDescription>控制 Agent 可调用的工具范围（含内置工具与 MCP 工具）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tool-blacklist">工具黑名单（逗号分隔）</Label>
            <Input
              id="tool-blacklist"
              value={draft.security.toolBlacklist.join(', ')}
              onChange={(e) => updateSecurity({ toolBlacklist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="例如 file_write, mcp_*"
            />
            <p className="text-xs text-rd-textMuted">匹配到的工具一律禁止调用，无论自主度如何设置。支持通配符 pattern（如 mcp_* 禁用所有 MCP 工具）。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tool-whitelist">工具白名单（逗号分隔）</Label>
            <Input
              id="tool-whitelist"
              value={draft.security.toolWhitelist.join(', ')}
              onChange={(e) => updateSecurity({ toolWhitelist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="留空表示不限制"
            />
            <p className="text-xs text-rd-textMuted">仅允许 Agent 调用白名单内的工具；留空表示不限制。黑名单优先生效。</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>自主度补充设置</CardTitle>
          <CardDescription>自主度模式可在主对话页顶部 Badge 快速切换，此处配置细节</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="autonomy-patterns">自动批准工具 pattern（逗号分隔）</Label>
            <Input
              id="autonomy-patterns"
              value={draft.autonomy.autoApprovePatterns.join(', ')}
              onChange={(e) =>
                updateAutonomy({
                  autoApprovePatterns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })
              }
              placeholder="例如 file_read, code_search"
            />
            <p className="text-xs text-rd-textMuted">匹配到的工具调用无需用户确认即自动执行，即使处于半自动或手动模式。用于放行低风险只读工具。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="autonomy-timeout">确认超时时间（毫秒）</Label>
            <Input
              id="autonomy-timeout"
              type="number"
              value={draft.autonomy.confirmTimeout}
              onChange={(e) => updateAutonomy({ confirmTimeout: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">弹出确认请求后等待用户响应的最长时间。超时后：全自动/半自动模式自动批准，手动模式自动拒绝。</p>
          </div>
        </CardContent>
      </Card>

      {/* Phase 50 Task 5：Phase 48 模块接入确认开关 */}
      <Card>
        <CardHeader>
          <CardTitle>Phase 48 模块接入</CardTitle>
          <CardDescription>控制 Phase 48 四个模块在生产路径的接入开关（默认全部开启）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p48-cite">引用系统</Label>
              <p className="text-xs text-rd-textMuted">CiteManager + CiteResolver：在 chat-runner 中注入引用解析能力。</p>
            </div>
            <Switch
              id="p48-cite"
              checked={draft.phase48Integration?.citeEnabled ?? true}
              onCheckedChange={(checked) => updatePhase48Integration({ citeEnabled: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p48-import">外部生态导入</Label>
              <p className="text-xs text-rd-textMuted">ClaudePluginImporter / CodexInstructionImporter：导入第三方 Skill 与指令。</p>
            </div>
            <Switch
              id="p48-import"
              checked={draft.phase48Integration?.importEnabled ?? true}
              onCheckedChange={(checked) => updatePhase48Integration({ importEnabled: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p48-macros">宏触发器</Label>
              <p className="text-xs text-rd-textMuted">MacroManager：通过 `!` 触发器引用轻量工作流宏。</p>
            </div>
            <Switch
              id="p48-macros"
              checked={draft.phase48Integration?.macrosEnabled ?? true}
              onCheckedChange={(checked) => updatePhase48Integration({ macrosEnabled: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p48-mcp">MCP Bridge 接入</Label>
              <p className="text-xs text-rd-textMuted">ClaudeMCPBridge：桥接 MCP 工具到 Agent 工具调用路径。</p>
            </div>
            <Switch
              id="p48-mcp"
              checked={draft.phase48Integration?.mcpBridgeEnabled ?? true}
              onCheckedChange={(checked) => updatePhase48Integration({ mcpBridgeEnabled: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Phase 50 Task 6：Phase 49 模块接入确认开关 */}
      <Card>
        <CardHeader>
          <CardTitle>Phase 49 模块接入</CardTitle>
          <CardDescription>控制 Phase 49 实验性模块的接入开关（默认关闭，需显式开启）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* @deprecated Phase 49 Task 3.5 已删除 qualityGate.check，此配置无运行时消费方 */}
          <div className="flex items-center justify-between opacity-60">
            <div>
              <Label htmlFor="p49-quality">Skill 质量门（已废弃）</Label>
              <p className="text-xs text-rd-textMuted">已废弃：Phase 49 Task 3.5 已删除 qualityGate.check，此开关无运行时消费方，仅保留以兼容旧配置。</p>
            </div>
            <Switch
              id="p49-quality"
              checked={draft.phase49Integration?.qualityGateEnabled ?? true}
              onCheckedChange={(checked) => updatePhase49Integration({ qualityGateEnabled: checked })}
              disabled
            />
          </div>
        </CardContent>
      </Card>

      {/* 调度器配置（Phase 37 Task 2）—— 预留功能，当前未在生产路径接线，控件禁用避免误导 */}
      <Card className="opacity-60">
        <CardHeader>
          <CardTitle>调度器（预留功能，当前不生效）</CardTitle>
          <CardDescription>定时任务引擎的启用状态、容量上限与默认时区（当前版本未接入运行时）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="sched-enabled">启用定时任务引擎</Label>
              <p className="text-xs text-rd-textMuted">开启后调度器接管 cron 周期任务的调度与执行。</p>
            </div>
            <Switch
              id="sched-enabled"
              checked={draft.scheduler?.enabled ?? true}
              onCheckedChange={(checked) => updateScheduler({ enabled: checked })}
              disabled
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sched-max-tasks">最大任务数</Label>
            <Input
              id="sched-max-tasks"
              type="number"
              min={1}
              max={100}
              value={draft.scheduler?.maxTasks ?? 20}
              onChange={(e) => updateScheduler({ maxTasks: Number(e.target.value) })}
              disabled
            />
            <p className="text-xs text-rd-textMuted">调度器同时承载的任务上限，范围 1~100，默认 20。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sched-tz">默认时区</Label>
            <Input
              id="sched-tz"
              value={draft.scheduler?.defaultTimezone ?? 'Asia/Shanghai'}
              onChange={(e) => updateScheduler({ defaultTimezone: e.target.value })}
              placeholder="例如 Asia/Shanghai"
              disabled
            />
            <p className="text-xs text-rd-textMuted">未显式指定时区的定时任务使用的回退时区，IANA 时区名称。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
