// desktop/renderer/src/components/settings/SettingsMcpTab.tsx
// Phase 74-G：MCP 插件设置 Tab（MCP 服务器管理 + 插件市场 + 安装模态框）
// 从 SettingsPage.tsx 迁移

import type { Dispatch, SetStateAction } from 'react';
import { Trash2, Plus, X, Sparkles, CheckCircle2, AlertCircle } from 'lucide-react';
import type { AppConfig, MCPServerEntryConfig } from '../../../../../src/config/schema.js';
import type { McpFormState } from '../../pages/settings-helpers.js';
import type { MCPCatalogEntry } from '../../../../shared/ipc-types.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Select, SelectItem } from '../ui/select.js';
import { Badge } from '../ui/badge.js';
import { Switch } from '../ui/switch.js';
import { Alert, AlertDescription } from '../ui/alert.js';

/** MCP 安装结果 */
interface InstallResultState {
  id: string;
  success: boolean;
  error?: string;
}

interface SettingsMcpTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 MCP 配置 */
  updateMcp: (patch: Partial<AppConfig['mcp']>) => void;
  /** 更新单个 MCP 服务器 */
  updateMcpServer: (index: number, patch: Partial<MCPServerEntryConfig>) => void;
  /** 删除 MCP 服务器 */
  removeMcpServer: (index: number) => void;
  /** 提交 MCP 表单（新增/编辑） */
  submitMcpForm: () => void;
  /** 打开新增 MCP 表单 */
  openAddMcp: () => void;
  /** 打开编辑 MCP 表单 */
  openEditMcp: (index: number) => void;
  /** MCP 表单状态（null 时隐藏表单） */
  mcpForm: McpFormState | null;
  /** 设置 MCP 表单状态 */
  setMcpForm: Dispatch<SetStateAction<McpFormState | null>>;
  /** MCP 编辑模式标记（null=新增，string=编辑对应 id） */
  mcpEditingId: string | null;
  /** 设置 MCP 编辑模式标记 */
  setMcpEditingId: Dispatch<SetStateAction<string | null>>;
  /** 市场目录条目列表 */
  catalogEntries: MCPCatalogEntry[];
  /** 当前选中的分类 */
  catalogCategory: string;
  /** 当前搜索关键词 */
  catalogSearch: string;
  /** 切换分类 */
  handleCatalogCategoryChange: (cat: string) => void;
  /** 搜索 */
  handleCatalogSearch: (value: string) => void;
  /** 正在安装的条目 id */
  installingId: string | null;
  /** 安装结果 */
  installResult: InstallResultState | null;
  /** 设置安装结果 */
  setInstallResult: Dispatch<SetStateAction<InstallResultState | null>>;
  /** 安装模态框条目（null 时隐藏） */
  installModal: MCPCatalogEntry | null;
  /** 设置安装模态框条目 */
  setInstallModal: Dispatch<SetStateAction<MCPCatalogEntry | null>>;
  /** 环境变量输入 */
  envInputs: Record<string, string>;
  /** 设置环境变量输入 */
  setEnvInputs: Dispatch<SetStateAction<Record<string, string>>>;
  /** 请求头输入 */
  headerInputs: Record<string, string>;
  /** 设置请求头输入 */
  setHeaderInputs: Dispatch<SetStateAction<Record<string, string>>>;
  /** 打开安装模态框 */
  openInstallModal: (entry: MCPCatalogEntry) => void;
  /** 执行安装 */
  handleInstall: () => void;
}

/**
 * MCP 插件设置 Tab
 * 包含：MCP 全局开关 + 服务器列表 + 添加/编辑表单 + 插件市场 + 安装模态框
 */
export function SettingsMcpTab({
  draft, updateMcp, updateMcpServer, removeMcpServer,
  submitMcpForm, openAddMcp, openEditMcp,
  mcpForm, setMcpForm, mcpEditingId, setMcpEditingId,
  catalogEntries, catalogCategory, catalogSearch,
  handleCatalogCategoryChange, handleCatalogSearch,
  installingId, installResult, setInstallResult,
  installModal, setInstallModal,
  envInputs, setEnvInputs, headerInputs, setHeaderInputs,
  openInstallModal, handleInstall,
}: SettingsMcpTabProps) {
  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="mcp-autoconnect">启动时自动连接 MCP 服务器</Label>
              <p className="text-xs text-rd-textMuted">应用启动时自动连接所有已启用的 MCP 服务器；关闭则需手动触发连接。</p>
            </div>
            <Switch
              id="mcp-autoconnect"
              checked={draft.mcp.autoConnect}
              onCheckedChange={(checked) => updateMcp({ autoConnect: checked })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="mcp-auto-reconnect">自动重连</Label>
              <p className="text-xs text-rd-textMuted">MCP 连接断开后是否自动尝试重新连接。</p>
            </div>
            <Switch
              id="mcp-auto-reconnect"
              checked={draft.mcp.autoReconnect}
              onCheckedChange={(checked) => updateMcp({ autoReconnect: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-connect-timeout">连接超时（毫秒）</Label>
            <Input
              id="mcp-connect-timeout"
              type="number"
              min={1000}
              value={draft.mcp.connectTimeout}
              onChange={(e) => updateMcp({ connectTimeout: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">MCP 服务器连接超时时间，范围 1000ms 起默认 30000ms。</p>
          </div>
        </CardContent>
      </Card>

      {draft.mcp.servers.map((server, idx) => (
        <Card key={idx}>
          <CardContent className="py-6">
            <div className="flex items-center justify-between gap-4">
              <div className="grid flex-1 grid-cols-2 gap-4 md:grid-cols-4">
                <div className="space-y-1">
                  <div className="text-xs text-rd-textMuted">ID</div>
                  <div className="text-sm font-medium text-rd-text">{server.id}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-rd-textMuted">名称</div>
                  <div className="text-sm font-medium text-rd-text">{server.name}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-rd-textMuted">传输方式</div>
                  <Badge variant="outline">{server.config.transport}</Badge>
                </div>
                <div className="flex items-center justify-between gap-2 md:justify-start">
                  <Label htmlFor={`mcp-enabled-${idx}`}>启用</Label>
                  <Switch
                    id={`mcp-enabled-${idx}`}
                    checked={server.enabled}
                    onCheckedChange={(checked) => updateMcpServer(idx, { enabled: checked })}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => openEditMcp(idx)}>
                  编辑
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                  onClick={() => removeMcpServer(idx)}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {/* MCP 添加/编辑表单：mcpForm 非 null 时显示 */}
      {mcpForm !== null && (
        <Card>
          <CardHeader>
            <CardTitle>{mcpEditingId !== null ? '编辑 MCP 服务器' : '新增 MCP 服务器'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="mcp-form-id">ID</Label>
                <Input
                  id="mcp-form-id"
                  value={mcpForm.id}
                  disabled={mcpEditingId !== null}
                  onChange={(e) => setMcpForm({ ...mcpForm, id: e.target.value })}
                  placeholder="例如 filesystem"
                />
                {mcpEditingId !== null && (
                  <p className="text-xs text-rd-textMuted">编辑模式下 ID 不可修改。</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-form-name">名称</Label>
                <Input
                  id="mcp-form-name"
                  value={mcpForm.name}
                  onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
                  placeholder="例如 Filesystem MCP"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-form-transport">传输方式</Label>
                <Select
                  id="mcp-form-transport"
                  value={mcpForm.transport}
                  onChange={(e) => setMcpForm({ ...mcpForm, transport: e.target.value as 'stdio' | 'http' })}
                >
                  <SelectItem value="stdio">stdio</SelectItem>
                  <SelectItem value="http">http</SelectItem>
                </Select>
              </div>
              {mcpForm.transport === 'stdio' ? (
                <div className="space-y-2">
                  <Label htmlFor="mcp-form-command">命令</Label>
                  <Input
                    id="mcp-form-command"
                    value={mcpForm.command}
                    onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
                    placeholder="例如 npx"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="mcp-form-url">URL</Label>
                  <Input
                    id="mcp-form-url"
                    value={mcpForm.url}
                    onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })}
                    placeholder="https://..."
                  />
                </div>
              )}
            </div>

            {/* stdio 专属字段：args / env / cwd */}
            {mcpForm.transport === 'stdio' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="mcp-form-args">命令参数（逗号分隔）</Label>
                  <Input
                    id="mcp-form-args"
                    value={mcpForm.args}
                    onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })}
                    placeholder="例如 @modelcontextprotocol/server-fs, /home/user/project"
                  />
                  <p className="text-xs text-rd-textMuted">多个参数用逗号分隔，会按顺序传给命令。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcp-form-env">环境变量（每行一个 KEY=value）</Label>
                  <textarea
                    id="mcp-form-env"
                    className="w-full rounded-md border border-rd-border bg-rd-background px-3 py-2 text-sm text-rd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40 focus-visible:border-rd-primary/70"
                    rows={3}
                    value={mcpForm.env}
                    onChange={(e) => setMcpForm({ ...mcpForm, env: e.target.value })}
                    placeholder={'ANTHROPIC_API_KEY=sk-...\nGITHUB_TOKEN=ghp_...'}
                  />
                  <p className="text-xs text-rd-textMuted">每行一个键值对，常用于传递 API Key。支持 $&#123;ENV_VAR&#125; 引用。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcp-form-cwd">工作目录（可选）</Label>
                  <Input
                    id="mcp-form-cwd"
                    value={mcpForm.cwd}
                    onChange={(e) => setMcpForm({ ...mcpForm, cwd: e.target.value })}
                    placeholder="留空使用默认工作目录"
                  />
                </div>
              </div>
            )}

            {/* http 专属字段：headers */}
            {mcpForm.transport === 'http' && (
              <div className="space-y-2">
                <Label htmlFor="mcp-form-headers">HTTP 请求头（每行一个 KEY=value）</Label>
                <textarea
                  id="mcp-form-headers"
                  className="w-full rounded-md border border-rd-border bg-rd-background px-3 py-2 text-sm text-rd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40 focus-visible:border-rd-primary/70"
                  rows={3}
                  value={mcpForm.headers}
                  onChange={(e) => setMcpForm({ ...mcpForm, headers: e.target.value })}
                  placeholder={'Authorization=Bearer xxx\nX-API-Key=...'}
                />
                <p className="text-xs text-rd-textMuted">每行一个请求头，用于认证。支持 $&#123;ENV_VAR&#125; 引用。</p>
              </div>
            )}

            {/* 通用高级选项：connectTimeout */}
            <div className="space-y-2">
              <Label htmlFor="mcp-form-timeout">连接超时（毫秒，可选）</Label>
              <Input
                id="mcp-form-timeout"
                type="number"
                value={mcpForm.connectTimeout}
                onChange={(e) => setMcpForm({ ...mcpForm, connectTimeout: e.target.value })}
                placeholder="留空使用默认值"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={submitMcpForm}
                disabled={!mcpForm.id || !mcpForm.name}
              >
                <Plus size={16} /> {mcpEditingId !== null ? '保存' : '添加'}
              </Button>
              <Button variant="ghost" onClick={() => { setMcpForm(null); setMcpEditingId(null); }}>
                <X size={16} /> 取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {mcpForm === null && (
        <Button onClick={openAddMcp} className="w-full">
          <Plus size={16} /> 添加 MCP 服务器
        </Button>
      )}

      {/* ===== MCP 插件市场 ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles size={18} /> MCP 插件市场
          </CardTitle>
          <CardDescription>
            浏览精选 MCP 服务器目录，一键安装到 RouteDev。安装后自动连接并持久化到配置文件。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 搜索栏 */}
          <div className="flex gap-2">
            <Input
              placeholder="搜索 MCP 服务器（名称/描述/分类）..."
              value={catalogSearch}
              onChange={(e) => handleCatalogSearch(e.target.value)}
              className="flex-1"
            />
          </div>
          {/* 分类标签 */}
          <div className="flex flex-wrap gap-2">
            {['all', 'filesystem', 'database', 'browser', 'search', 'devtool', 'communication', 'other'].map((cat) => (
              <button
                key={cat}
                onClick={() => handleCatalogCategoryChange(cat)}
                className={`rounded-md px-3 py-1 text-xs transition-colors ${
                  catalogCategory === cat && !catalogSearch
                    ? 'bg-rd-accent text-white'
                    : 'bg-rd-cardHover text-rd-textMuted hover:bg-rd-border'
                }`}
              >
                {cat === 'all' ? '全部' : cat}
              </button>
            ))}
          </div>
          {/* 目录列表 */}
          <div className="grid gap-3 md:grid-cols-2">
            {catalogEntries.map((entry) => {
              const installed = draft.mcp.servers.some((s) => s.id === entry.id);
              return (
                <div
                  key={entry.id}
                  className="flex flex-col gap-2 rounded-lg border border-rd-border p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-rd-text">{entry.displayName}</span>
                        {entry.requiresApiKey && (
                          <Badge variant="outline" className="text-[10px]">需 API Key</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-rd-textMuted line-clamp-2">{entry.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[10px]">{entry.category}</Badge>
                    <Badge variant="outline" className="text-[10px]">{entry.transport}</Badge>
                    <a
                      href={entry.homepage}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto text-xs text-rd-accent hover:underline"
                    >
                      主页
                    </a>
                    {installed ? (
                      <Badge variant="secondary" className="text-[10px] text-green-400">已安装</Badge>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => openInstallModal(entry)}
                        disabled={installingId === entry.id}
                      >
                        {installingId === entry.id ? '安装中...' : '安装'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {catalogEntries.length === 0 && (
              <div className="col-span-2 py-8 text-center text-sm text-rd-textMuted">
                未找到匹配的 MCP 服务器
              </div>
            )}
          </div>
          {/* 外部链接 */}
          <div className="flex items-center gap-4 border-t border-rd-border pt-3 text-xs text-rd-textMuted">
            <span>浏览更多：</span>
            <a href="https://mcp.so" target="_blank" rel="noopener noreferrer" className="text-rd-accent hover:underline">
              mcp.so
            </a>
            <a href="https://smithery.ai" target="_blank" rel="noopener noreferrer" className="text-rd-accent hover:underline">
              Smithery
            </a>
          </div>
        </CardContent>
      </Card>

      {/* ===== 安装模态框 ===== */}
      {installModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>安装 {installModal.displayName}</span>
                <button onClick={() => setInstallModal(null)} className="text-rd-textMuted hover:text-rd-text">
                  <X size={18} />
                </button>
              </CardTitle>
              <CardDescription>{installModal.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 环境变量输入（stdio） */}
              {installModal.transport === 'stdio' && (installModal.requiredEnv ?? []).length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs font-medium">环境变量（必填）</Label>
                  {installModal.requiredEnv!.map((key: string) => (
                    <div key={key} className="space-y-1">
                      <Label className="text-xs text-rd-textMuted">{key}</Label>
                      <Input
                        type="password"
                        value={envInputs[key] ?? ''}
                        onChange={(e) => setEnvInputs({ ...envInputs, [key]: e.target.value })}
                        placeholder={`输入 ${key} 的值`}
                      />
                    </div>
                  ))}
                </div>
              )}
              {/* Headers 输入（http） */}
              {installModal.transport === 'http' && (installModal.requiredHeaders ?? []).length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs font-medium">请求头（必填）</Label>
                  {installModal.requiredHeaders!.map((key: string) => (
                    <div key={key} className="space-y-1">
                      <Label className="text-xs text-rd-textMuted">{key}</Label>
                      <Input
                        type="password"
                        value={headerInputs[key] ?? ''}
                        onChange={(e) => setHeaderInputs({ ...headerInputs, [key]: e.target.value })}
                        placeholder={`输入 ${key} 的值`}
                      />
                    </div>
                  ))}
                </div>
              )}
              {/* 无需额外配置的提示 */}
              {installModal.transport === 'stdio' && (installModal.requiredEnv ?? []).length === 0 && (
                <Alert>
                  <CheckCircle2 size={16} />
                  <AlertDescription>此服务器无需额外配置，点击安装即可使用。</AlertDescription>
                </Alert>
              )}
              {/* 安装结果 */}
              {installResult && (
                <Alert variant={installResult.success ? 'default' : 'destructive'}>
                  {installResult.success ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                  <AlertDescription>
                    {installResult.success ? '安装成功，已自动连接。' : `安装失败：${installResult.error}`}
                  </AlertDescription>
                </Alert>
              )}
              {/* 按钮 */}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setInstallModal(null)}>
                  {installResult?.success ? '关闭' : '取消'}
                </Button>
                {!installResult?.success && (
                  <Button
                    onClick={handleInstall}
                    disabled={installingId !== null}
                  >
                    {installingId ? '安装中...' : '确认安装'}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
