// desktop/renderer/src/components/settings/SettingsProvidersTab.tsx
// Phase 74-G：模型配置 Tab（Provider 列表 + 推理模式 + 模型编辑模态）
// 从 SettingsPage.tsx 迁移

import type { Dispatch, SetStateAction } from 'react';
import { Server, Plus, Trash2, Eye, EyeOff, Zap, Brain, Gauge, Lightbulb } from 'lucide-react';
import type { AppConfig, ModelConfig } from '../../../../../src/config/schema.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Select, SelectItem } from '../ui/select.js';
import { Badge, type BadgeProps } from '../ui/badge.js';

/** 模型编辑模态状态 */
interface ModelEditorState {
  pIdx: number;
  mIdx?: number;
  model: ModelConfig;
}

/** 协议对应的 Badge 样式 */
function protocolBadgeVariant(protocol: string): BadgeProps['variant'] {
  return protocol === 'openai' ? 'primary' : 'outline';
}

/** 协议对应的图标容器样式 */
function protocolIconClass(protocol: string): string {
  return protocol === 'openai'
    ? 'bg-rd-primary/10 text-rd-primary'
    : 'bg-rd-warning/10 text-rd-warning';
}

interface SettingsProvidersTabProps {
  /** 当前配置草稿 */
  draft: AppConfig;
  /** 更新 draft（用于推理模式切换） */
  updateDraft: (patch: Partial<AppConfig>) => void;
  /** 添加 Provider */
  addProvider: () => void;
  /** 删除 Provider */
  removeProvider: (index: number) => void;
  /** 更新 Provider */
  updateProvider: (index: number, patch: Partial<AppConfig['providers'][number]>) => void;
  /** API Key 显示/隐藏状态（按 provider index） */
  showApiKeys: Record<number, boolean>;
  /** 切换 API Key 显示/隐藏 */
  toggleApiKey: (index: number) => void;
  /** 测试连接 handler */
  handleTestConnection: (index: number) => void;
  /** 正在测试连接的 provider index */
  testingProvider: number | null;
  /** 测试连接结果（按 provider index） */
  testResults: Record<number, { success: boolean; message: string } | null>;
  /** 打开新增模型模态 */
  openAddModel: (pIdx: number) => void;
  /** 打开编辑模型模态 */
  openEditModel: (pIdx: number, mIdx: number) => void;
  /** 删除模型 */
  removeModel: (pIdx: number, mIdx: number) => void;
  /** 模型编辑模态状态 */
  modelEditor: ModelEditorState | null;
  /** 设置模型编辑模态状态 */
  setModelEditor: Dispatch<SetStateAction<ModelEditorState | null>>;
  /** 确认模型编辑模态（新增/编辑） */
  confirmModelEditor: () => void;
}

/**
 * 模型配置 Tab
 * 包含：Provider 列表（含 API Key/测试连接/模型管理）、推理模式选择、模型编辑模态
 */
export function SettingsProvidersTab({
  draft,
  updateDraft,
  addProvider,
  removeProvider,
  updateProvider,
  showApiKeys,
  toggleApiKey,
  handleTestConnection,
  testingProvider,
  testResults,
  openAddModel,
  openEditModel,
  removeModel,
  modelEditor,
  setModelEditor,
  confirmModelEditor,
}: SettingsProvidersTabProps) {
  return (
    <>
      <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
        {draft.providers.length === 0 ? (
          <Card className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-rd-primary/10 text-rd-primary">
              <Server size={32} />
            </div>
            <h3 className="mb-2 text-lg font-semibold text-rd-text">还没有配置大模型 Provider</h3>
            <p className="mb-6 max-w-md text-sm text-rd-textMuted">
              添加第一个 Provider（如 OpenAI、Anthropic），即可开始使用 RouteDev。
            </p>
            <Button onClick={addProvider}>
              <Plus size={16} /> 添加 Provider
            </Button>
          </Card>
        ) : (
          <>
            {draft.providers.map((provider, pIdx) => (
              <Card key={pIdx}>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${protocolIconClass(provider.protocol)}`}>
                      <Server size={20} />
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="text-base">
                        {provider.name || provider.id || `Provider ${pIdx + 1}`}
                      </CardTitle>
                      <CardDescription>
                        {provider.baseUrl ? provider.baseUrl : '未设置 Base URL'}
                      </CardDescription>
                    </div>
                    <Badge variant={protocolBadgeVariant(provider.protocol)}>
                      {provider.protocol.toUpperCase()}
                    </Badge>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                    onClick={() => removeProvider(pIdx)}
                  >
                    <Trash2 size={16} /> 删除
                  </Button>
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {/* Provider ID 自动生成，不再显示给用户编辑 */}
                    <div className="space-y-2">
                      <Label htmlFor={`provider-${pIdx}-name`}>显示名称（可选）</Label>
                      <Input
                        id={`provider-${pIdx}-name`}
                        value={provider.name}
                        onChange={(e) => updateProvider(pIdx, { name: e.target.value })}
                        placeholder="留空则自动使用 ID"
                      />
                      <p className="text-xs text-rd-textMuted">在界面上展示的友好名称，便于区分不同 Provider。</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`provider-${pIdx}-protocol`}>协议</Label>
                      <Select
                        id={`provider-${pIdx}-protocol`}
                        value={provider.protocol}
                        onChange={(e) => updateProvider(pIdx, { protocol: e.target.value as 'openai' | 'anthropic' })}
                      >
                        <SelectItem value="openai">OpenAI</SelectItem>
                        <SelectItem value="anthropic">Anthropic</SelectItem>
                      </Select>
                      <p className="text-xs text-rd-textMuted">决定使用哪个 SDK 发起请求。OpenAI 协议兼容大多数第三方服务。</p>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor={`provider-${pIdx}-url`}>Base URL</Label>
                      <Input
                        id={`provider-${pIdx}-url`}
                        value={provider.baseUrl}
                        onChange={(e) => updateProvider(pIdx, { baseUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1"
                      />
                      <p className="text-xs text-rd-textMuted">API 基础地址，SDK 会自动拼接路径。第三方兼容服务填其 OpenAI 兼容端点。</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={`provider-${pIdx}-key`}>API Key</Label>
                    <div className="flex gap-2">
                      <Input
                        id={`provider-${pIdx}-key`}
                        type={showApiKeys[pIdx] ? 'text' : 'password'}
                        value={provider.apiKey}
                        onChange={(e) => updateProvider(pIdx, { apiKey: e.target.value })}
                        placeholder="支持 ${ENV_VAR} 环境变量引用"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => toggleApiKey(pIdx)}
                        title={showApiKeys[pIdx] ? '隐藏' : '显示'}
                      >
                        {showApiKeys[pIdx] ? <EyeOff size={16} /> : <Eye size={16} />}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => handleTestConnection(pIdx)}
                        disabled={testingProvider === pIdx}
                        title="测试连接"
                      >
                        <Zap size={16} className={testingProvider === pIdx ? 'animate-pulse' : ''} />
                        <span className="ml-1.5 hidden sm:inline">测试</span>
                      </Button>
                    </div>
                    <p className="text-xs text-rd-textMuted">访问该 Provider 服务的密钥。支持用 $&#123;ENV_VAR&#125; 引用环境变量，避免明文存储。</p>
                    {testResults[pIdx] && (
                      <p className={`text-xs ${testResults[pIdx]!.success ? 'text-rd-success' : 'text-rd-danger'}`}>
                        {testResults[pIdx]!.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>模型列表</Label>
                      <Button variant="outline" size="sm" onClick={() => openAddModel(pIdx)}>
                        <Plus size={14} /> 添加模型
                      </Button>
                    </div>
                    {provider.models.length === 0 ? (
                      <div className="rounded-lg bg-rd-surfaceHover p-4 text-center text-sm text-rd-textMuted">
                        暂无模型，点击上方按钮添加第一个模型
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {provider.models.map((model, mIdx) => (
                          <div
                            key={mIdx}
                            className="flex items-center justify-between rounded-lg bg-rd-surfaceHover px-4 py-3 transition hover:bg-rd-surfaceHighlight"
                          >
                            <div className="flex items-center gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-rd-text">
                                  {model.name || model.id || `模型 ${mIdx + 1}`}
                                </div>
                                <div className="text-xs text-rd-textMuted">
                                  {model.id} · {model.contextWindow.toLocaleString()} tokens
                                  {model.capabilities.length > 0 && ` · ${model.capabilities.join(', ')}`}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button variant="ghost" size="sm" onClick={() => openEditModel(pIdx, mIdx)}>
                                编辑
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                                onClick={() => removeModel(pIdx, mIdx)}
                              >
                                <Trash2 size={16} />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
            <Button onClick={addProvider} className="w-full">
              <Plus size={16} /> 添加 Provider
            </Button>
          </>
        )}

        {/* ===== 推理模式（Phase 42） ===== */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Brain size={16} className="text-rd-primary" />
              推理模式
            </CardTitle>
            <CardDescription>控制 Agent 的推理深度与速度平衡</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {([
                { id: 'fast', label: '快速', icon: Zap, desc: '最低延迟，适合简单任务和迭代调试' },
                { id: 'balanced', label: '均衡', icon: Gauge, desc: '速度与质量平衡，推荐大多数场景' },
                { id: 'accurate', label: '精准', icon: Lightbulb, desc: '深度推理，适合复杂架构与关键决策' },
              ] as const).map((mode) => {
                const Icon = mode.icon;
                const active = draft.reasoningMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => updateDraft({ reasoningMode: mode.id })}
                    className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${
                      active
                        ? 'border-rd-primary bg-rd-primary/10 text-rd-text'
                        : 'border-rd-border bg-rd-surface text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text'
                    }`}
                  >
                    <Icon size={20} className={active ? 'text-rd-primary' : ''} />
                    <span className="text-sm font-medium">{mode.label}</span>
                    <span className="text-xs text-rd-textMuted">{mode.desc}</span>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 模型编辑模态 */}
      {modelEditor && (
        <div
          className="rd-modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setModelEditor(null)}
        >
          <div
            className="rd-modal-enter w-[480px] max-w-[90vw] rounded-2xl bg-rd-surface p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-rd-text">
                {modelEditor.mIdx === undefined ? '添加模型' : '编辑模型'}
              </h2>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>模型 ID</Label>
                <Input
                  value={modelEditor.model.id}
                  onChange={(e) => setModelEditor({ ...modelEditor, model: { ...modelEditor.model, id: e.target.value } })}
                  placeholder="例如 gpt-4o"
                />
                <p className="text-xs text-rd-textMuted">模型的唯一标识，路由规则通过此 ID 引用。</p>
              </div>
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <Label>上下文窗口</Label>
                  <Input
                    type="number"
                    value={modelEditor.model.contextWindow}
                    onChange={(e) => setModelEditor({ ...modelEditor, model: { ...modelEditor.model, contextWindow: Number(e.target.value) } })}
                    placeholder="128000"
                  />
                </div>
              </div>
              {/* 高级选项：默认折叠，普通用户无需填写 */}
              <details className="rounded-lg border border-rd-border p-3">
                <summary className="cursor-pointer text-sm font-medium text-rd-textMuted">高级选项（可选）</summary>
                <div className="mt-3 space-y-4">
                  <div className="space-y-2">
                    <Label>显示名称</Label>
                    <Input
                      value={modelEditor.model.name}
                      onChange={(e) => setModelEditor({ ...modelEditor, model: { ...modelEditor.model, name: e.target.value } })}
                      placeholder="留空则自动使用模型 ID"
                    />
                    <p className="text-xs text-rd-textMuted">在界面上展示的友好名称。</p>
                  </div>
                  <div className="space-y-2">
                    <Label>能力标签</Label>
                    <Input
                      value={modelEditor.model.capabilities.join(', ')}
                      onChange={(e) =>
                        setModelEditor({
                          ...modelEditor,
                          model: { ...modelEditor.model, capabilities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) as ModelConfig['capabilities'] },
                        })
                      }
                      placeholder="code, vision, reasoning（逗号分隔）"
                    />
                    <p className="text-xs text-rd-textMuted">用逗号分隔多个能力标签，便于路由分类。</p>
                  </div>
                </div>
              </details>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setModelEditor(null)}>取消</Button>
              <Button onClick={confirmModelEditor}>确认</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
