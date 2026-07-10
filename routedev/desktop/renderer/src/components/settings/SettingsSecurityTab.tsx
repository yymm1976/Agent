// desktop/renderer/src/components/settings/SettingsSecurityTab.tsx
// Phase 74-G：安全设置 Tab（目录边界/权限规则/网络搜索/对抗性验证/渐进式信任/沙箱级）
// 从 SettingsPage.tsx 迁移

import { Plus, Trash2 } from 'lucide-react';
import type {
  AppConfig, SecurityConfig, SandboxLevel, ApprovalLevel, ToolCategory,
  FilesystemPermissionRule,
} from '../../../../shared/config-types.js';
import { SEARCH_ENGINES } from '../../pages/settings-helpers.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Select, SelectItem } from '../ui/select.js';
import { Switch } from '../ui/switch.js';

/** 网络搜索配置 patch 类型 */
type WebSearchPatch = Partial<{
  glmApiKey: string; metasoApiKey: string; baiduApiKey: string;
  tavilyApiKey: string; bingApiKey: string;
  perplexityApiKey: string; exaApiKey: string; braveApiKey: string;
  searxngEndpoint: string;
}>;

// Phase 48：沙箱级选项与默认审批级映射（与 src/tools/permission-engine.ts 的 DEFAULT_APPROVAL 保持一致）
const SANDBOX_LEVEL_OPTIONS: SandboxLevel[] = ['read-only', 'workspace-write', 'full-access'];
const TOOL_CATEGORIES: ToolCategory[] = ['read', 'write', 'shell', 'network', 'git-read', 'git-write', 'agent', 'mcp'];
const DEFAULT_APPROVAL_MAP: Record<ToolCategory, ApprovalLevel> = {
  'read': 'never-ask',
  'write': 'on-request',
  'shell': 'always-ask',
  'network': 'always-ask',
  'git-read': 'never-ask',
  'git-write': 'always-ask',
  'agent': 'on-request',
  'mcp': 'on-request',
};

interface SettingsSecurityTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新安全配置 */
  updateSecurity: (patch: Partial<SecurityConfig>) => void;
  /** 更新审批级覆盖 */
  updateSecurityApproval: (category: ToolCategory, level: ApprovalLevel) => void;
  /** 更新文件系统规则 */
  updateFsRule: (index: number, patch: Partial<FilesystemPermissionRule>) => void;
  /** 添加文件系统规则 */
  addFsRule: () => void;
  /** 删除文件系统规则 */
  removeFsRule: (index: number) => void;
  /** 更新网络白名单 */
  updateNetworkAllow: (value: string) => void;
  /** 更新网络黑名单 */
  updateNetworkDeny: (value: string) => void;
  /** 更新网络搜索配置 */
  updateWebSearch: (patch: WebSearchPatch) => void;
  /** 更新对抗性验证配置 */
  updateAdversarial: (patch: Partial<AppConfig['adversarial']>) => void;
  /** 更新渐进式信任配置 */
  updateTrust: (patch: Partial<AppConfig['trust']>) => void;
  /** 当前选中的搜索引擎 id */
  selectedSearchEngine: string;
  /** 设置当前选中的搜索引擎 id */
  setSelectedSearchEngine: (value: string) => void;
}

/**
 * 安全设置 Tab
 * 包含：目录边界/命令黑名单/敏感文件 + 权限规则（Permission Profile）+ 网络搜索 +
 *       对抗性验证 + 渐进式信任 + 沙箱级与审批级覆盖
 */
export function SettingsSecurityTab({
  draft, updateSecurity, updateSecurityApproval,
  updateFsRule, addFsRule, removeFsRule,
  updateNetworkAllow, updateNetworkDeny,
  updateWebSearch, updateAdversarial, updateTrust,
  selectedSearchEngine, setSelectedSearchEngine,
}: SettingsSecurityTabProps) {
  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      {/* TD-09：autonomy=auto 时显示红色强警告框 */}
      {draft.autonomy?.defaultMode === 'auto' && (
        <div
          role="alert"
          className="rounded-md border-2 border-red-600 bg-red-50 p-4 dark:bg-red-950/40"
        >
          <div className="flex items-start gap-2">
            <span className="text-xl leading-none">⚠️</span>
            <div className="space-y-1">
              <p className="font-semibold text-red-700 dark:text-red-400">
                自主度模式为 Auto（全自动）—— 高风险操作仍需确认
              </p>
              <p className="text-sm text-red-600 dark:text-red-300">
                当前自主度设为 <code className="rounded bg-red-100 px-1 dark:bg-red-900/60">auto</code>，
                大多数工具调用将自动批准。为安全起见，以下高风险工具在 auto 模式下
                <strong>仍会弹出确认框</strong>：<code className="rounded bg-red-100 px-1 dark:bg-red-900/60">shell_exec</code>、
                <code className="rounded bg-red-100 px-1 dark:bg-red-900/60">git_op</code>、
                <code className="rounded bg-red-100 px-1 dark:bg-red-900/60">file_write</code>、
                <code className="rounded bg-red-100 px-1 dark:bg-red-900/60">spawn_agent</code>。
                如需完全自动执行所有工具，请审慎评估风险后再切换至更宽松的策略。
              </p>
            </div>
          </div>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>安全设置</CardTitle>
          <CardDescription>目录边界、命令黑名单与敏感文件保护</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="security-boundary">启用目录边界限制</Label>
              <p className="text-xs text-rd-textMuted">限制 Agent 只能读写当前项目目录内的文件，防止越权访问其他目录。</p>
            </div>
            <Switch
              id="security-boundary"
              checked={draft.security.directoryBoundary}
              onCheckedChange={(checked) => updateSecurity({ directoryBoundary: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="security-network">网络请求前确认</Label>
              <p className="text-xs text-rd-textMuted">Agent 发起 HTTP 请求前弹出确认，防止意外访问外部服务。</p>
            </div>
            <Switch
              id="security-network"
              checked={draft.security.networkConfirm}
              onCheckedChange={(checked) => updateSecurity({ networkConfirm: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="security-blacklist">危险命令黑名单（逗号分隔）</Label>
            <Input
              id="security-blacklist"
              value={draft.security.commandBlacklist.join(', ')}
              onChange={(e) => updateSecurity({ commandBlacklist: e.target.value.split(',').map((s) => s.trim()) })}
            />
            <p className="text-xs text-rd-textMuted">匹配到的 shell 命令会被直接拦截。命令与工具黑白名单可在"命令与工具"标签页详细配置。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="security-sensitive">敏感文件 pattern（逗号分隔）</Label>
            <Input
              id="security-sensitive"
              value={draft.security.sensitiveFiles.join(', ')}
              onChange={(e) => updateSecurity({ sensitiveFiles: e.target.value.split(',').map((s) => s.trim()) })}
            />
            <p className="text-xs text-rd-textMuted">匹配到的文件按下方策略保护，防止 Agent 读取或修改密钥、凭证等。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="security-policy">敏感文件策略</Label>
            <Select
              id="security-policy"
              value={draft.security.sensitiveFilePolicy}
              onChange={(e) => updateSecurity({ sensitiveFilePolicy: e.target.value as 'readonly' | 'deny' })}
            >
              <SelectItem value="readonly">只读</SelectItem>
              <SelectItem value="deny">禁止访问</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">只读允许 Agent 读取但不能修改；禁止访问则完全无法读写。</p>
          </div>
        </CardContent>
      </Card>

      {/* 网络与运行时安全（SSRF / Bash / HTTPS / 速率限制 / 开发认证） */}
      <Card>
        <CardHeader>
          <CardTitle>网络与运行时安全</CardTitle>
          <CardDescription>SSRF 防护、严格 Bash 模式、强制 HTTPS 与速率限制</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="security-ssrf">SSRF 防护</Label>
              <p className="text-xs text-rd-textMuted">拦截对内网地址（127.0.0.1、10.x、192.168.x 等）的访问请求，防止服务端请求伪造。</p>
            </div>
            <Switch
              id="security-ssrf"
              checked={draft.security.ssrfProtection}
              onCheckedChange={(checked) => updateSecurity({ ssrfProtection: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="security-strict-bash">严格 Bash 模式</Label>
              <p className="text-xs text-rd-textMuted">开启后检测到命令注入将阻断执行。</p>
            </div>
            <Switch
              id="security-strict-bash"
              checked={draft.security.strictBashMode}
              onCheckedChange={(checked) => updateSecurity({ strictBashMode: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="security-https">强制 HTTPS</Label>
              <p className="text-xs text-rd-textMuted">仅允许 HTTPS 协议的网络请求，拦截明文 HTTP 请求防止中间人攻击。</p>
            </div>
            <Switch
              id="security-https"
              checked={draft.security.httpsOnly}
              onCheckedChange={(checked) => updateSecurity({ httpsOnly: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="security-rate-limit">速率限制 Map 上限</Label>
            <Input
              id="security-rate-limit"
              type="number"
              min={100}
              value={draft.security.rateLimitMaxSize}
              onChange={(e) => updateSecurity({ rateLimitMaxSize: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">速率限制 Map 的最大条目数，范围 100 起默认 10000。</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="security-dev-auth">开发模式认证</Label>
              <p className="text-xs text-rd-textMuted">开发环境下要求认证，避免未授权访问开发服务器。</p>
            </div>
            <Switch
              id="security-dev-auth"
              checked={draft.security.devModeAuth}
              onCheckedChange={(checked) => updateSecurity({ devModeAuth: checked })}
            />
          </div>
        </CardContent>
      </Card>

      {/* 权限规则（Permission Profile，glob 级权限规则） */}
      <Card>
        <CardHeader>
          <CardTitle>权限规则（Permission Profile）</CardTitle>
          <CardDescription>
            用 glob 规则精细控制文件系统和网络访问权限，替代扁平的敏感文件配置。
            文件系统规则按顺序匹配，命中第一条即生效。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 文件系统规则列表 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>文件系统规则</Label>
              <Button variant="outline" size="sm" onClick={addFsRule}>
                <Plus size={14} /> 添加规则
              </Button>
            </div>
            <p className="text-xs text-rd-textMuted">
              glob 模式示例：<code className="bg-rd-bgSoft px-1 rounded">**/*.env</code>（所有 .env 文件）、
              <code className="bg-rd-bgSoft px-1 rounded">**/secrets/**</code>（secrets 目录下所有文件）。
              访问级别：deny=禁止访问，read=只读，write=可读写。
            </p>
            {draft.permissionProfile.filesystem.length === 0 && (
              <p className="text-xs text-rd-textMuted italic">暂无规则，所有文件默认允许读写。</p>
            )}
            {draft.permissionProfile.filesystem.map((rule, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  value={rule.pattern}
                  onChange={(e) => updateFsRule(idx, { pattern: e.target.value })}
                  placeholder="**/*.env"
                  className="flex-1"
                />
                <Select
                  value={rule.access}
                  onChange={(e) => updateFsRule(idx, { access: e.target.value as 'read' | 'write' | 'deny' })}
                  className="w-32"
                >
                  <SelectItem value="deny">禁止访问</SelectItem>
                  <SelectItem value="read">只读</SelectItem>
                  <SelectItem value="write">可读写</SelectItem>
                </Select>
                <Button variant="ghost" size="sm" onClick={() => removeFsRule(idx)}>
                  <Trash2 size={14} className="text-rd-danger" />
                </Button>
              </div>
            ))}
          </div>

          {/* 网络域名规则 */}
          <div className="space-y-2 pt-4 border-t border-rd-border">
            <Label>网络域名规则</Label>
            <p className="text-xs text-rd-textMuted">
              白名单为空表示不限制；非空时仅允许白名单内域名。黑名单优先于白名单。
              支持通配符，如 <code className="bg-rd-bgSoft px-1 rounded">*.github.com</code>。
            </p>
            <div className="space-y-2">
              <Label htmlFor="net-allow">域名白名单（逗号分隔）</Label>
              <Input
                id="net-allow"
                value={draft.permissionProfile.network.allow.join(', ')}
                onChange={(e) => updateNetworkAllow(e.target.value)}
                placeholder="*.github.com, api.openai.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="net-deny">域名黑名单（逗号分隔）</Label>
              <Input
                id="net-deny"
                value={draft.permissionProfile.network.deny.join(', ')}
                onChange={(e) => updateNetworkDeny(e.target.value)}
                placeholder="*.evil.com, internal.local"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 网络搜索 API Key 配置（下拉选择式） */}
      <Card>
        <CardHeader>
          <CardTitle>网络搜索</CardTitle>
          <CardDescription>
            支持 9 个搜索引擎，按中国可用性自动回退。推荐配置中国直连引擎（智谱 GLM / 秘塔 / 百度）。
            未配置任何 Key 时回退到 Bing HTML 抓取（可能不稳定）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 搜索引擎下拉选择器 */}
          <div className="space-y-2">
            <Label htmlFor="ws-engine-select">搜索引擎</Label>
            <Select
              id="ws-engine-select"
              value={selectedSearchEngine}
              onChange={(e) => setSelectedSearchEngine(e.target.value)}
            >
              {SEARCH_ENGINES.map((eng) => (
                <SelectItem key={eng.id} value={eng.id}>{eng.label}</SelectItem>
              ))}
            </Select>
          </div>

          {/* 选中引擎的 API Key 输入框 + 申请地址 + 说明 */}
          {(() => {
            const engine = SEARCH_ENGINES.find((e) => e.id === selectedSearchEngine) ?? SEARCH_ENGINES[0];
            const fieldValue = (draft.webSearch?.[engine.keyField] as string | undefined) ?? '';
            const isUrlField = engine.id === 'searxng';
            return (
              <div className="space-y-2">
                <Label htmlFor="ws-engine-key">{isUrlField ? `${engine.label} 实例 URL` : `${engine.label} API Key`}</Label>
                <Input
                  id="ws-engine-key"
                  type={isUrlField ? 'text' : 'password'}
                  placeholder={isUrlField ? 'http://localhost:8080' : `在 ${engine.applyUrl.replace(/^https?:\/\//, '')} 获取`}
                  value={fieldValue}
                  onChange={(e) => updateWebSearch({ [engine.keyField]: e.target.value } as WebSearchPatch)}
                />
                <a
                  href={engine.applyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-rd-primary hover:underline"
                >
                  🔑 申请地址: {engine.applyUrl.replace(/^https?:\/\//, '')}
                </a>
                <p className="text-xs text-rd-textMuted">{engine.desc}</p>
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Phase 33 Task 3.1：对抗性验证配置 */}
      <Card>
        <CardHeader>
          <CardTitle>对抗性验证（实验性）</CardTitle>
          <CardDescription>用独立 LLM 尝试推翻主验证结论，增强安全防护</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="adv-enabled">启用对抗性验证</Label>
              <p className="text-xs text-rd-textMuted">启用后用独立 LLM 客户端尝试推翻主验证结论，可能增加 Token 消耗。</p>
            </div>
            <Switch
              id="adv-enabled"
              checked={draft.adversarial.enabled}
              onCheckedChange={(checked) => updateAdversarial({ enabled: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adv-threshold">严重度阈值: {draft.adversarial.threshold.toFixed(2)}</Label>
            <input
              id="adv-threshold"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={draft.adversarial.threshold}
              onChange={(e) => updateAdversarial({ threshold: Number(e.target.value) })}
              className="mt-2 w-full accent-rd-primary"
            />
            <p className="text-xs text-rd-textMuted">低于此严重度的质疑不返回。设高了可能漏掉隐蔽问题，设低了可能产生警告疲劳。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="adv-tier">模型层级</Label>
            <Select
              id="adv-tier"
              value={draft.adversarial.modelTier}
              onChange={(e) => updateAdversarial({ modelTier: e.target.value as 'fast' | 'main' })}
            >
              <SelectItem value="fast">fast（廉价快速）</SelectItem>
              <SelectItem value="main">main（与主 Agent 相同）</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">对抗性验证使用的模型层级。fast 省钱但可能不够精准，main 更准但更贵。</p>
          </div>
        </CardContent>
      </Card>

      {/* Phase 40：渐进式信任 */}
      <Card>
        <CardHeader>
          <CardTitle>渐进式信任</CardTitle>
          <CardDescription>7 级信任梯度 + 临时授权 + 偏好持久化（借鉴 Claude Code）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="trust-base-level">基础信任级别</Label>
            <Select
              id="trust-base-level"
              value={draft.trust.baseLevel}
              onChange={(e) => updateTrust({ baseLevel: e.target.value as typeof draft.trust.baseLevel })}
            >
              <SelectItem value="plan">plan（只规划不执行）</SelectItem>
              <SelectItem value="default">default（每次确认）</SelectItem>
              <SelectItem value="acceptEdits">acceptEdits（文件自动通过）</SelectItem>
              <SelectItem value="acceptAll">acceptAll（全部自动通过）</SelectItem>
              <SelectItem value="auto">auto（LLM 判断安全性）</SelectItem>
              <SelectItem value="bypassPermissions">bypassPermissions（跳过检查）</SelectItem>
              <SelectItem value="trusted">trusted（完全信任，仅测试）</SelectItem>
            </Select>
            <p className="text-xs text-rd-textMuted">从最严格到最宽松的 7 级梯度。新会话不恢复上次级别，防止遗忘。</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="trust-temp-grants">启用临时授权</Label>
              <p className="text-xs text-rd-textMuted">会话级临时授权，resume 时不恢复，到期自动失效。</p>
            </div>
            <Switch
              id="trust-temp-grants"
              checked={draft.trust.enableTemporaryGrants}
              onCheckedChange={(checked) => updateTrust({ enableTemporaryGrants: checked })}
            />
          </div>
          {draft.trust.enableTemporaryGrants && (
            <div className="space-y-2">
              <Label htmlFor="trust-ttl">临时授权 TTL（分钟）</Label>
              <Input
                id="trust-ttl"
                type="number"
                min={1}
                value={draft.trust.grantTTLMinutes}
                onChange={(e) => updateTrust({ grantTTLMinutes: Number(e.target.value) })}
              />
              <p className="text-xs text-rd-textMuted">临时授权有效期，超过此时间自动失效，默认 30 分钟。</p>
            </div>
          )}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="trust-persist">启用偏好持久化</Label>
              <p className="text-xs text-rd-textMuted">跨会话保留授权偏好，避免重复确认。默认关闭以保安全。</p>
            </div>
            <Switch
              id="trust-persist"
              checked={draft.trust.enablePersistentPreferences}
              onCheckedChange={(checked) => updateTrust({ enablePersistentPreferences: checked })}
            />
          </div>
          {draft.trust.enablePersistentPreferences && (
            <div className="space-y-2">
              <Label htmlFor="trust-max-persist">偏好最大条目数</Label>
              <Input
                id="trust-max-persist"
                type="number"
                min={1}
                value={draft.trust.maxPersistentGrants}
                onChange={(e) => updateTrust({ maxPersistentGrants: Number(e.target.value) })}
              />
              <p className="text-xs text-rd-textMuted">持久化偏好上限，超出时淘汰最旧条目，默认 200。</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Phase 48：沙箱级与审批级覆盖（PermissionEngine 双旋钮 UI） */}
      <Card>
        <CardHeader>
          <CardTitle>沙箱级与审批级覆盖</CardTitle>
          <CardDescription>
            Phase 47 Task 4 引入的权限双旋钮：沙箱级决定工具能执行的操作范围；
            审批级决定是否每次询问用户。两项已通过 PermissionMiddleware 接入 Agent Loop。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 沙箱级选择器 */}
          <div className="space-y-2">
            <Label htmlFor="security-sandbox">沙箱级别</Label>
            <Select
              id="security-sandbox"
              value={draft.security.sandbox}
              onChange={(e) => updateSecurity({ sandbox: e.target.value as SandboxLevel })}
            >
              {SANDBOX_LEVEL_OPTIONS.map((level) => (
                <SelectItem key={level} value={level}>{level}</SelectItem>
              ))}
            </Select>
            <p className="text-xs text-rd-textMuted">
              决定工具能执行的操作范围。read-only: 仅读取；workspace-write: 读写工作区；
              full-access: 完全访问（含网络/Shell/Git 写）。
            </p>
          </div>

          {/* 审批级覆盖表格：每个 ToolCategory 一个下拉选择器 */}
          <div className="space-y-2 pt-4 border-t border-rd-border">
            <Label>审批级别覆盖</Label>
            <p className="text-xs text-rd-textMuted">
              按工具类别覆盖默认审批策略。always-ask: 每次询问；on-request: 按需询问；never-ask: 从不询问。
              未显式覆盖时使用 PermissionEngine 的内置默认值。
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TOOL_CATEGORIES.map((category) => {
                const currentValue = draft.security.approval?.[category] ?? DEFAULT_APPROVAL_MAP[category];
                return (
                  <div key={category} className="flex items-center gap-2">
                    <Label htmlFor={`security-approval-${category}`} className="w-24 shrink-0 text-xs">
                      {category}
                    </Label>
                    <Select
                      id={`security-approval-${category}`}
                      value={currentValue}
                      onChange={(e) => updateSecurityApproval(category, e.target.value as ApprovalLevel)}
                      className="flex-1"
                    >
                      <SelectItem value="always-ask">always-ask</SelectItem>
                      <SelectItem value="on-request">on-request</SelectItem>
                      <SelectItem value="never-ask">never-ask</SelectItem>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
