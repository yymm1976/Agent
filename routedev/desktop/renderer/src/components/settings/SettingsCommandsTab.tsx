// desktop/renderer/src/components/settings/SettingsCommandsTab.tsx
// Phase 74-G：命令与工具 Tab（命令黑白名单 + 工具黑白名单 + 自主度补充 + Phase 48 接入）
// 从 SettingsPage.tsx 迁移

import type { AppConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { SettingsAdvancedSection } from './SettingsAdvancedSection.js';

interface SettingsCommandsTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 security 字段 */
  updateSecurity: (patch: Partial<AppConfig['security']>) => void;
  /** 更新 autonomy 字段 */
  updateAutonomy: (patch: Partial<AppConfig['autonomy']>) => void;
  /** 更新 Phase 48 接入开关 */
  updatePhase48Integration: (patch: Partial<NonNullable<AppConfig['phase48Integration']>>) => void;
}

/**
 * 命令与工具 Tab
 * 包含：命令黑白名单、工具黑白名单、自主度补充设置、Phase 48 模块接入
 */
export function SettingsCommandsTab({
  draft,
  updateSecurity,
  updateAutonomy,
  updatePhase48Integration,
}: SettingsCommandsTabProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>命令黑白名单</CardTitle>
          <CardDescription>控制 Agent 可执行的 shell 命令范围</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cmd-blacklist">命令黑名单</Label>
            <Input
              id="cmd-blacklist"
              value={draft.security.commandBlacklist.join(', ')}
              onChange={(e) => updateSecurity({ commandBlacklist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="例如 rm -rf, format, del /s"
            />
            <p className="text-xs text-rd-textMuted">匹配到的命令会被直接拦截，Agent 不会执行。支持完整命令字符串匹配。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-whitelist">命令白名单</Label>
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
          <CardDescription>控制 Agent 可调用的工具范围，含内置工具与 MCP 工具</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tool-blacklist">工具黑名单</Label>
            <Input
              id="tool-blacklist"
              value={draft.security.toolBlacklist.join(', ')}
              onChange={(e) => updateSecurity({ toolBlacklist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="例如 file_write, mcp_*"
              disabled
            />
            <p className="text-xs text-rd-textMuted">暂未实现，当前不强制执行。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tool-whitelist">工具白名单</Label>
            <Input
              id="tool-whitelist"
              value={draft.security.toolWhitelist.join(', ')}
              onChange={(e) => updateSecurity({ toolWhitelist: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="留空表示不限制"
              disabled
            />
            <p className="text-xs text-rd-textMuted">暂未实现，当前不强制执行。</p>
          </div>
        </CardContent>
      </Card>

      <SettingsAdvancedSection title="自主度与模块" description="自动批准模式、确认超时、模块开关">
      <Card>
        <CardHeader>
          <CardTitle>自主度补充设置</CardTitle>
          <CardDescription>自主度模式可在主对话页顶部 Badge 快速切换，此处配置细节</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="autonomy-patterns">自动批准工具 pattern</Label>
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
            <Label htmlFor="autonomy-timeout">确认超时时间</Label>
            <Input
              id="autonomy-timeout"
              type="number"
              value={draft.autonomy.confirmTimeout}
              onChange={(e) => updateAutonomy({ confirmTimeout: Number(e.target.value) })}
              disabled
            />
            <p className="text-xs text-rd-textMuted">暂未实现。</p>
          </div>
        </CardContent>
      </Card>

      {/* Phase 50 Task 5：Phase 48 模块接入确认开关 */}
      <Card>
        <CardHeader>
          <CardTitle>模块接入开关</CardTitle>
          <CardDescription>控制各功能模块的开关</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p48-cite">引用系统</Label>
              <p className="text-xs text-rd-textMuted">在对话中注入引用解析能力。需同时启用 integrity Pack。</p>
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
              <p className="text-xs text-rd-textMuted">导入第三方技能与指令。需同时启用 integrity Pack。</p>
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
              <p className="text-xs text-rd-textMuted">通过 `!` 触发器引用轻量工作流宏。需同时启用 integrity Pack。</p>
            </div>
            <Switch
              id="p48-macros"
              checked={draft.phase48Integration?.macrosEnabled ?? true}
              onCheckedChange={(checked) => updatePhase48Integration({ macrosEnabled: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="p48-mcp">MCP 桥接</Label>
              <p className="text-xs text-rd-textMuted">桥接 MCP 工具到 Agent 工具调用路径。需同时启用 integrity Pack。</p>
            </div>
            <Switch
              id="p48-mcp"
              checked={draft.phase48Integration?.mcpBridgeEnabled ?? true}
              onCheckedChange={(checked) => updatePhase48Integration({ mcpBridgeEnabled: checked })}
            />
          </div>
        </CardContent>
      </Card>
      </SettingsAdvancedSection>

    </div>
  );
}
