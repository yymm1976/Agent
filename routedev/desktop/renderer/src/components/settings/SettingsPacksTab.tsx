// desktop/renderer/src/components/settings/SettingsPacksTab.tsx
// Phase 81 Task 5：能力分层设置页
// 按 docs/CAPABILITY_LAYERS.md 四层分层展示能力 Pack 开关：
//   基础区（Core，默认开）→ 高级区（Extended Pack）→ 扩展区（Standard Pack）→ 实验区（Freeze，禁用）
// 开关状态绑定 config.packs.xxx.enabled，修改后由 useAutoSave 自动保存并触发 config:reload

import type { AppConfig, PacksConfig } from '../../../../shared/config-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Switch } from '../ui/switch.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { FoldableSection } from '../ui/foldable-section.js';
import { SettingsTabContainer } from './SettingsTabContainer.js';
import type { TabId } from './SettingsNav.js';
import {
  Server, Route, Shield, Folder, Zap, Users, Crosshair, BookOpen,
  Globe, Map as MapIcon, Archive, Database, Activity, FlaskConical,
  ArrowRight, AlertTriangle, Lock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface SettingsPacksTabProps {
  draft: AppConfig;
  /** 更新 packs 配置（来自 useSettingsDraft） */
  updatePacks: (patch: Partial<PacksConfig>) => void;
  /** 跳转到指定设置 tab（基础区"前往配置"按钮使用） */
  onNavigate: (tab: TabId) => void;
}

// --- 基础区（Core）：核心配置入口，默认开启不可关闭 ---
interface CoreItem {
  label: string;
  description: string;
  icon: LucideIcon;
  /** 跳转目标 tab */
  tab: TabId;
}

const CORE_ITEMS: CoreItem[] = [
  { label: '模型配置', description: 'providers / models——LLM 提供商与模型清单', icon: Server, tab: 'providers' },
  { label: '预算配置', description: 'router.budget——Token 预算与降级阈值', icon: Route, tab: 'router' },
  { label: '权限配置', description: 'security / permission——沙箱、路径与命令权限', icon: Shield, tab: 'security' },
  { label: '项目目录', description: 'general——工作目录与通用设置', icon: Folder, tab: 'appearance' },
];

// --- Pack 描述符：统一描述一个能力 Pack 开关 ---
interface PackDescriptor {
  /** PacksConfig 的 key */
  key: keyof PacksConfig;
  label: string;
  description: string;
  icon: LucideIcon;
  /** 成本提示：启用该 Pack 时的资源/性能开销说明（小字灰色显示） */
  costHint: string;
}

// 高级区（Extended Pack）：默认关，修 bug 不扩功能
const EXTENDED_PACKS: PackDescriptor[] = [
  { key: 'goalAdvanced', label: 'Goal 高级编排', description: '/goal 执行器 + DAG 引擎 + 双循环 + 有界恢复 + 预算监控', icon: Crosshair, costHint: '注入 /goal 执行器与 DAG 引擎，系统提示约 +2~4k tokens；双循环恢复额外调用 LLM' },
  { key: 'multiAgent', label: 'Multi-Agent 编排', description: 'spawn-agent + orchestrator + worker 执行器 + 冲突检测 + 熔断', icon: Users, costHint: '注册 spawn-agent 工具，子 Agent 消耗独立 token 预算，并行上限默认 3' },
  { key: 'adversarial', label: '对抗审查', description: 'UnifiedReviewer + 跨模型审查 + 分级审查策略', icon: Zap, costHint: '每次审查额外调用 1 次 LLM，跨模型审查按 tier 叠加开销' },
  { key: 'skillLifecycle', label: 'Skill 生命周期', description: 'SkillLifecycleManager 自动提炼与精炼技能', icon: BookOpen, costHint: '后台周期性 LLM 调用提炼技能，磁盘写入 .routedev/skills/' },
];

// 扩展区（Standard Pack）：默认关，冷处理仅修崩溃
const STANDARD_PACKS: PackDescriptor[] = [
  { key: 'browserWeb', label: '浏览器 / Web', description: 'web-search + web-fetch + browser 工具 + 视觉助手', icon: Globe, costHint: '注册 web-search/web-fetch/browser 工具，按实际调用计费；视觉助手需图片输入' },
  { key: 'codeMap', label: '代码地图', description: 'code-graph-query + repo-map + CodeMapEngine 索引与监听', icon: MapIcon, costHint: '构建 tree-sitter 代码索引，首次扫描耗内存 ~50MB；watch 模式持续监听文件变更' },
  { key: 'ccrCompression', label: 'CCR 压缩', description: 'ccr-retrieve 可逆压缩 + ComposePipeline 组合编排', icon: Archive, costHint: '注入 ccr-retrieve 工具与 Compose 管道，压缩缓存占磁盘空间' },
  { key: 'vfsPlan', label: 'VFS / Plan 工具', description: '虚拟文件系统 + 计划状态显式管理工具', icon: Database, costHint: '注册 VFS/Plan 工具，Agent 工作内存占用略增' },
  { key: 'harness', label: 'Harness', description: 'Trace 回放 + 评分卡 + 并行实验', icon: Activity, costHint: '开放 Trace 回放与评分卡，trace 文件持续累积需定期清理' },
  { key: 'integrity', label: '完整性校验', description: 'cite / import / macros / mcpBridge / IntegrityManifest', icon: Shield, costHint: '接入引用/导入/宏/MCP 桥接五模块，外部导入增加启动时间' },
  { key: 'compose', label: 'Compose 管道', description: 'ComposePipeline 阶段提示词注入与自动流转', icon: Route, costHint: '注入 Compose 管道阶段提示词，多阶段任务 token 开销增加' },
];

// 实验区（Freeze）：默认关，UI 禁用仅展示
const FREEZE_PACKS: PackDescriptor[] = [
  { key: 'trustGradient', label: 'TrustGradient', description: '渐进式信任梯度动态升级（Phase 79 已冻结动态升级）', icon: Lock, costHint: '已冻结——动态信任升级无证据，启用仅作展示，不保证稳定性' },
  { key: 'kgAdvanced', label: 'KG 高级算法', description: '知识图谱 PageRank / 社区检测（tree-sitter + SQLite 已够用）', icon: FlaskConical, costHint: '已冻结——PageRank/社区检测耗 CPU，tree-sitter + SQLite 已够用' },
  { key: 'acRouter', label: 'ACRouter', description: '闭环模型路由实验性高级部分（regret-tracker 等）', icon: FlaskConical, costHint: '已冻结——闭环路由实验性，启用可能引入路由抖动' },
];

export function SettingsPacksTab({ draft, updatePacks, onNavigate }: SettingsPacksTabProps) {
  // packs 为 optional 字段，未配置时用空对象兜底
  const cfg: PacksConfig = draft.packs ?? ({} as PacksConfig);

  // 读取某个 pack 的 enabled 状态（缺省 false）
  const isEnabled = (key: keyof PacksConfig): boolean => cfg[key]?.enabled ?? false;

  // 切换某个 pack 的 enabled：合并保留原 pack 对象，仅覆写 enabled
  const togglePack = (key: keyof PacksConfig, enabled: boolean) => {
    const current = cfg[key] ?? { enabled: false };
    updatePacks({ [key]: { ...current, enabled } } as Partial<PacksConfig>);
  };

  return (
    <SettingsTabContainer>
      {/* 顶部说明：四层分层模型 */}
      <Card>
        <CardHeader>
          <CardTitle>能力分层</CardTitle>
          <CardDescription>
            按 CAPABILITY_LAYERS 四层分层管理能力 Pack 开关。基础层默认开启不可关闭；
            高级 / 扩展区可按需启用；实验区已冻结，仅展示不推荐启用。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-xs text-rd-textMuted">
          <Badge variant="success">基础区 · 默认开</Badge>
          <Badge variant="primary">高级区 · 默认关</Badge>
          <Badge variant="outline">扩展区 · 默认关</Badge>
          <Badge variant="destructive">实验区 · 已冻结</Badge>
        </CardContent>
      </Card>

      {/* ===== 基础区（Core）===== */}
      <FoldableSection
        defaultOpen
        header={
          <div className="flex items-center gap-2">
            <Badge variant="success">基础区</Badge>
            <span className="font-medium text-rd-text">Core · 核心能力</span>
            <span className="text-xs text-rd-textMuted">默认开启，不可关闭</span>
          </div>
        }
      >
        <div className="space-y-2">
          {CORE_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.label}
                className="flex items-center justify-between gap-4 rounded-lg bg-rd-surfaceHover px-3 py-2.5"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Icon size={18} className="mt-0.5 shrink-0 text-rd-primary" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-rd-text">{item.label}</span>
                      <Badge variant="success">已启用</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-rd-textMuted">{item.description}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate(item.tab)}
                  className="shrink-0"
                >
                  前往配置 <ArrowRight size={14} />
                </Button>
              </div>
            );
          })}
        </div>
      </FoldableSection>

      {/* ===== 高级区（Extended Pack）===== */}
      <FoldableSection
        defaultOpen
        header={
          <div className="flex items-center gap-2">
            <Badge variant="primary">高级区</Badge>
            <span className="font-medium text-rd-text">Extended Pack · 进阶能力</span>
            <span className="text-xs text-rd-textMuted">默认关，修 bug 不扩功能</span>
          </div>
        }
      >
        {/* 维护说明：Extended Pack 修 bug 不扩功能 */}
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-rd-primary/5 px-3 py-2 text-xs text-rd-textMuted">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            Extended Pack 默认关闭，按需启用。维护策略：修 bug 不扩功能，不新增能力。
            启用后会注入对应工具与子系统，请注意 token 与资源开销。
          </span>
        </div>
        <div className="space-y-2">
          {EXTENDED_PACKS.map((item) => (
            <PackRow
              key={item.key}
              item={item}
              checked={isEnabled(item.key)}
              onToggle={(checked) => togglePack(item.key, checked)}
              layerLabel="高级"
            />
          ))}
        </div>
      </FoldableSection>

      {/* ===== 扩展区（Standard Pack）===== */}
      <FoldableSection
        header={
          <div className="flex items-center gap-2">
            <Badge variant="outline">扩展区</Badge>
            <span className="font-medium text-rd-text">Standard Pack · 可选能力</span>
            <span className="text-xs text-rd-textMuted">默认关，冷处理仅修崩溃</span>
          </div>
        }
      >
        <div className="space-y-2">
          {STANDARD_PACKS.map((item) => (
            <PackRow
              key={item.key}
              item={item}
              checked={isEnabled(item.key)}
              onToggle={(checked) => togglePack(item.key, checked)}
              layerLabel="扩展"
            />
          ))}
        </div>
      </FoldableSection>

      {/* ===== 实验区（Freeze）===== */}
      <FoldableSection
        header={
          <div className="flex items-center gap-2">
            <Badge variant="destructive">实验区</Badge>
            <span className="font-medium text-rd-text">Freeze · 已冻结</span>
            <span className="text-xs text-rd-textMuted">停止接线，不推荐启用</span>
          </div>
        }
      >
        {/* 冻结说明：实验性能力，开关禁用 */}
        <div className="mb-3 flex items-start gap-2 rounded-lg bg-rd-danger/5 px-3 py-2 text-xs text-rd-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            以下能力已冻结，停止一切接线。开关仅作展示，不保证稳定性，不推荐启用。
            后续将在清理窗口与对应代码一并移除。
          </span>
        </div>
        <div className="space-y-2">
          {FREEZE_PACKS.map((item) => (
            <PackRow
              key={item.key}
              item={item}
              checked={isEnabled(item.key)}
              onToggle={() => {
                /* 冻结区禁用，不响应切换 */
              }}
              disabled
              freezeNote="实验性，不推荐"
            />
          ))}
        </div>
      </FoldableSection>
    </SettingsTabContainer>
  );
}

// --- 单个 Pack 开关行 ---
interface PackRowProps {
  item: PackDescriptor;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  /** 禁用开关（Freeze 区使用） */
  disabled?: boolean;
  /** 冻结区附加标注 */
  freezeNote?: string;
  /** 层标签：Extended="高级"、Standard="扩展"、Freeze 不传（用 freezeNote） */
  layerLabel?: string;
}

function PackRow({ item, checked, onToggle, disabled, freezeNote, layerLabel }: PackRowProps) {
  const Icon = item.icon;
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-rd-surfaceHover px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <Icon size={18} className={`mt-0.5 shrink-0 ${disabled ? 'text-rd-textMuted' : 'text-rd-primary'}`} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-rd-text">{item.label}</span>
            {/* 层标签：Extended Pack=高级，Standard Pack=扩展 */}
            {layerLabel && layerLabel === '高级' && <Badge variant="primary">{layerLabel}</Badge>}
            {layerLabel && layerLabel === '扩展' && <Badge variant="outline">{layerLabel}</Badge>}
            {freezeNote && <Badge variant="destructive">{freezeNote}</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-rd-textMuted">{item.description}</p>
          {/* 成本提示：小字灰色文字显示在开关下方 */}
          <p className="mt-0.5 text-[11px] text-rd-textMuted/70">{item.costHint}</p>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onToggle} disabled={disabled} />
    </div>
  );
}
