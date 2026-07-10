// desktop/renderer/src/components/settings/SettingsCodemapTab.tsx
// Phase 74-G：代码地图 Tab（说明卡片 + 升级版引擎配置）
// 从 SettingsPage.tsx 迁移

import { Map as MapIcon, Sparkles } from 'lucide-react';
import type { AppConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Select, SelectItem } from '../ui/select.js';

interface SettingsCodemapTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 draft（用于 codeMap 字段直接修改） */
  updateDraft: (patch: Partial<AppConfig>) => void;
}

/**
 * 代码地图 Tab
 * 包含：说明卡片、代码地图引擎升级版（tree-sitter + SQLite + PageRank）
 */
export function SettingsCodemapTab({ draft, updateDraft }: SettingsCodemapTabProps) {
  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      {/* 说明卡片 */}
      <Card>
        <CardContent className="flex items-start justify-between gap-4 py-6">
          <div className="flex items-start gap-3">
            <MapIcon size={20} className="mt-0.5 shrink-0 text-rd-primary" />
            <div>
              <Label>代码地图</Label>
              <p className="text-xs text-rd-textMuted mt-1">
                RouteDev 内置代码地图已可用，无需安装外部工具。零依赖轻量引擎秒级扫描项目结构，自动注入到 system prompt。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 代码地图引擎（升级版，Phase 41） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles size={16} className="text-rd-primary" />
            代码地图引擎（升级版）
          </CardTitle>
          <CardDescription>tree-sitter (WASM) + SQLite + PageRank + Aider 风格渲染</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 引擎选择 */}
          <div className="space-y-2">
            <Label>解析引擎</Label>
            <Select
              value={draft.codeMap?.engine ?? 'tree-sitter'}
              onChange={(e) => updateDraft({ codeMap: { ...draft.codeMap, engine: e.target.value as 'tree-sitter' | 'regex' | 'disabled' } })}
            >
              <SelectItem value="tree-sitter">tree-sitter（WASM 精确解析）</SelectItem>
              <SelectItem value="regex">regex（轻量回退）</SelectItem>
              <SelectItem value="disabled">disabled（关闭）</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">tree-sitter 提供精确的语法树解析；regex 为轻量回退方案。</p>
          </div>

          {/* Token 预算 + 最大上下文符号数 */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Token 预算</Label>
              <Input
                type="number"
                value={draft.codeMap?.budgetTokens ?? 2048}
                onChange={(e) => updateDraft({ codeMap: { ...draft.codeMap, budgetTokens: Number(e.target.value) } })}
                placeholder="2048"
              />
              <p className="text-xs text-rd-textMuted">RepoDistill 压缩后的目标 token 数。</p>
            </div>
            <div className="space-y-2">
              <Label>最大上下文符号数</Label>
              <Input
                type="number"
                value={draft.codeMap?.maxContextSymbols ?? 50}
                onChange={(e) => updateDraft({ codeMap: { ...draft.codeMap, maxContextSymbols: Number(e.target.value) } })}
                placeholder="50"
              />
              <p className="text-xs text-rd-textMuted">注入 system prompt 的符号上限。</p>
            </div>
          </div>

          {/* 自动索引 */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm text-rd-text">自动索引</p>
              <p className="text-xs text-rd-textMuted mt-1">文件变更时自动重建索引。</p>
            </div>
            <Switch
              checked={draft.codeMap?.autoIndex !== false}
              onCheckedChange={(checked) => updateDraft({ codeMap: { ...draft.codeMap, autoIndex: checked } })}
            />
          </div>

          {/* 索引排除目录 */}
          <div className="space-y-2">
            <Label>索引排除目录</Label>
            <Input
              value={(draft.codeMap?.indexExclude ?? ['node_modules', '.git', 'dist', 'release-v*']).join(', ')}
              onChange={(e) => updateDraft({
                codeMap: { ...draft.codeMap, indexExclude: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) },
              })}
              placeholder="node_modules, .git, dist, release-v*"
            />
            <p className="text-xs text-rd-textMuted">逗号分隔的 glob 模式，匹配的目录不参与索引。</p>
          </div>

          {/* 实验性功能 */}
          <div className="space-y-4 rounded-lg border border-rd-border p-4">
            <p className="text-xs font-semibold text-rd-textSubtle">实验性功能</p>
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <p className="text-sm text-rd-text">HCGS（分层调用图摘要）</p>
                <p className="text-xs text-rd-textMuted mt-1">Hierarchical Call Graph Summary，按调用层级聚合符号。</p>
              </div>
              <Switch
                checked={draft.codeMap?.enableHCGS === true}
                onCheckedChange={(checked) => updateDraft({ codeMap: { ...draft.codeMap, enableHCGS: checked } })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <p className="text-sm text-rd-text">语义边</p>
                <p className="text-xs text-rd-textMuted mt-1">跨文件符号引用关系，增强代码导航。</p>
              </div>
              <Switch
                checked={draft.codeMap?.enableSemanticEdges === true}
                onCheckedChange={(checked) => updateDraft({ codeMap: { ...draft.codeMap, enableSemanticEdges: checked } })}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
