// desktop/renderer/src/components/SetupWizard.tsx
// 首次启动向导：基于 shadcn/ui 风格组件 + 设计规范
// 支持跳过 API Key 配置，直接进入主界面

import { useState } from 'react';
import {
  ArrowRight, ArrowLeft, Check, KeyRound, Eye, EyeOff,
  Rocket, Shield, Globe, Cpu, ChevronRight, Sparkles,
  Settings, Info,
} from 'lucide-react';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { Select, SelectItem } from './ui/select.js';
import { Card, CardContent } from './ui/card.js';
import { Badge } from './ui/badge.js';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Separator } from './ui/separator.js';
import { AppConfigSchema } from '../../../../src/config/schema.js';
import type { AppConfig, ProviderConfig } from '../../../../src/config/schema.js';
import type { ConfigSaveResult } from '../../../shared/ipc-types.js';

interface SetupWizardProps {
  saveConfig: (cfg: AppConfig) => Promise<ConfigSaveResult>;
}

interface Preset {
  label: string;
  baseUrl: string;
  protocol: 'openai' | 'anthropic';
  description: string;
  icon: string;
  defaultModelId: string;
  defaultModelName: string;
  docsUrl: string;
}

const PRESETS: Preset[] = [
  {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    description: 'GPT-4o / GPT-4o mini',
    icon: '🟢',
    defaultModelId: 'gpt-4o',
    defaultModelName: 'GPT-4o',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    description: '一个 Key 调用 100+ 模型',
    icon: '🟣',
    defaultModelId: 'anthropic/claude-3.5-sonnet',
    defaultModelName: 'Claude 3.5 Sonnet',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
    description: 'Claude 3.5 Sonnet / Opus',
    icon: '🟠',
    defaultModelId: 'claude-3-5-sonnet-20241022',
    defaultModelName: 'Claude 3.5 Sonnet',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    description: '国产高性价比',
    icon: '🔵',
    defaultModelId: 'deepseek-chat',
    defaultModelName: 'DeepSeek Chat',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    description: '超长上下文',
    icon: '💗',
    defaultModelId: 'moonshot-v1-128k',
    defaultModelName: 'Moonshot v1 128k',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    label: '自定义',
    baseUrl: '',
    protocol: 'openai',
    description: 'OpenAI 兼容接口',
    icon: '⚙️',
    defaultModelId: '',
    defaultModelName: '',
    docsUrl: '',
  },
];

const STEPS = ['选择服务商', '填写 API Key', '完成设置'];

// 未配置时的占位模型 ID（满足 schema 的 min(1) 约束，用户在设置中配置后会覆盖）
const UNCONFIGURED_MODEL_ID = 'unconfigured';

export function SetupWizard({ saveConfig }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState<number>(0);
  const [providerId, setProviderId] = useState('openai');
  const [providerName, setProviderName] = useState('OpenAI');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [modelId, setModelId] = useState('gpt-4o');
  const [modelName, setModelName] = useState('GPT-4o');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const applyPreset = (idx: number) => {
    const p = PRESETS[idx];
    setSelectedPreset(idx);
    setBaseUrl(p.baseUrl);
    setProtocol(p.protocol);
    if (p.label === '自定义') return;
    setProviderId(p.label.toLowerCase().replace(/\s+/g, '-').replace(/[()]/g, ''));
    setProviderName(p.label);
    setModelId(p.defaultModelId);
    setModelName(p.defaultModelName);
  };

  const buildConfig = (providers: ProviderConfig[]): AppConfig => {
    // providers 为空时（跳过配置），使用占位模型 ID 避免 schema 验证失败
    const defaultModelId = providers[0]?.models[0]?.id ?? UNCONFIGURED_MODEL_ID;
    // 使用 schema 默认值生成基础配置，避免后续新增字段时这里遗漏
    const base = AppConfigSchema.parse({});
    return {
      ...base,
      providers,
      router: {
        ...base.router,
        rules: [
          { tier: 'simple', modelId: defaultModelId },
          { tier: 'medium', modelId: defaultModelId },
          { tier: 'complex', modelId: defaultModelId },
          { tier: 'reasoning', modelId: defaultModelId },
        ],
        classifierModel: defaultModelId,
      },
      checkpoint: { ...base.checkpoint, modelId: defaultModelId },
      goalVerifier: { ...base.goalVerifier, modelId: defaultModelId },
    };
  };

  const handleFinish = async () => {
    setSaving(true);
    setError('');
    try {
      const newProvider: ProviderConfig = {
        id: providerId,
        name: providerName,
        protocol,
        baseUrl,
        apiKey,
        models: [
          {
            id: modelId,
            name: modelName,
            provider: providerId,
            tier: 'medium',
            contextWindow: 128000,
            capabilities: [],
            latencyMs: 0,
            available: true,
          },
        ],
      };
      const result = await saveConfig(buildConfig([newProvider]));
      if (!result.success) {
        setError(result.error ?? '保存失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 跳过 API Key 配置：直接进入主界面，后续在设置中补全 */
  const handleSkip = async () => {
    setSaving(true);
    setError('');
    try {
      const skippedConfig: AppConfig = {
        ...buildConfig([]),
        general: { language: 'zh-CN', theme: 'dark', startupBehavior: 'restore', setupSkipped: true, appearanceTheme: 'black', fontSize: 14, accentColor: '', backgroundBehavior: { backgroundBehavior: 'ask', activeTaskOnClose: 'prompt' } },
      };
      const result = await saveConfig(skippedConfig);
      if (!result.success) {
        setError(result.error ?? '保存失败');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const canNext =
    step === 0
      ? selectedPreset >= 0 && (PRESETS[selectedPreset].label !== '自定义' || baseUrl !== '')
      : step === 1
      ? providerId && baseUrl && apiKey
      : modelId;

  return (
    <div className="flex h-full bg-rd-background">
      {/* 左侧品牌区 */}
      <div className="hidden w-[420px] flex-col justify-between bg-gradient-to-br from-rd-primary to-indigo-700 p-10 text-white lg:flex">
        <div>
          <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm">
            <Rocket size={32} />
          </div>
          <h1 className="mb-4 text-4xl font-bold leading-tight">欢迎使用 RouteDev</h1>
          <p className="mb-8 text-lg text-white/80">智能路由开发助手。根据任务复杂度自动选择最合适的模型。</p>

          <div className="space-y-4">
            <Card className="border-white/10 bg-white/10 text-white shadow-none backdrop-blur-sm">
              <CardContent className="flex items-start gap-3 p-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20">
                  <Sparkles size={16} />
                </div>
                <div>
                  <div className="font-semibold">智能路由</div>
                  <div className="text-sm text-white/70">简单问题用轻量模型，复杂任务用高级模型</div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-white/10 text-white shadow-none backdrop-blur-sm">
              <CardContent className="flex items-start gap-3 p-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20">
                  <Shield size={16} />
                </div>
                <div>
                  <div className="font-semibold">本地安全</div>
                  <div className="text-sm text-white/70">API Key 仅保存在本地配置文件</div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-white/10 text-white shadow-none backdrop-blur-sm">
              <CardContent className="flex items-start gap-3 p-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20">
                  <Cpu size={16} />
                </div>
                <div>
                  <div className="font-semibold">多模型支持</div>
                  <div className="text-sm text-white/70">可同时配置多个 Provider 和模型</div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
        <div className="text-sm text-white/60">RouteDev v2.2.0</div>
      </div>

      {/* 右侧表单区 */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {/* 顶部步骤条 */}
        <div className="sticky top-0 z-10 border-b border-rd-border/80 bg-rd-background/85 px-8 py-4 backdrop-blur-sm">
          <div className="mx-auto flex max-w-2xl items-center">
            {STEPS.map((label, idx) => (
              <div key={idx} className="flex flex-1 items-center last:flex-none">
                <div className="flex items-center gap-3">
                  <div
                    className={[
                      'flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold transition-all',
                      idx < step
                        ? 'bg-rd-primary text-white'
                        : idx === step
                        ? 'bg-rd-primary text-white ring-4 ring-rd-primary/20'
                        : 'border-2 border-rd-border bg-rd-surface text-rd-textSubtle',
                    ].join(' ')}
                  >
                    {idx < step ? <Check size={16} /> : idx + 1}
                  </div>
                  <span className={['text-sm font-semibold', idx <= step ? 'text-rd-text' : 'text-rd-textSubtle'].join(' ')}>
                    {label}
                  </span>
                </div>
                {idx < STEPS.length - 1 && (
                  <div className={['mx-4 h-0.5 flex-1 rounded-full transition-colors', idx < step ? 'bg-rd-primary' : 'bg-rd-border'].join(' ')} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 表单内容 */}
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-full max-w-2xl animate-slide-up">
            <div className="mb-8 lg:hidden">
              <h1 className="mb-2 text-2xl font-bold text-rd-text">欢迎使用 RouteDev</h1>
              <p className="text-rd-textMuted">智能路由开发助手</p>
            </div>

            {/* Step 1: 选择服务商 */}
            {step === 0 && (
              <div className="space-y-6">
                <div>
                  <h2 className="mb-2 text-2xl font-bold text-rd-text">选择 LLM 服务商</h2>
                  <p className="text-rd-textMuted">选择一个服务商预设，快速完成初始配置</p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {PRESETS.map((p, idx) => {
                    const active = selectedPreset === idx;
                    return (
                      <button
                        key={p.label}
                        onClick={() => applyPreset(idx)}
                        className={[
                          'flex items-center gap-4 rounded-xl border p-4 text-left transition-all',
                          active
                            ? 'border-rd-primary bg-rd-primary/5 shadow-md'
                            : 'border-rd-border bg-rd-surface hover:border-rd-borderHover hover:bg-rd-surfaceHover hover:shadow-sm',
                        ].join(' ')}
                      >
                        <span className="text-2xl">{p.icon}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-rd-text">{p.label}</span>
                            {active && <Check size={16} className="text-rd-primary" />}
                          </div>
                          <div className="text-sm text-rd-textMuted">{p.description}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-col gap-3">
                  <Button onClick={() => setStep(1)} disabled={!canNext} className="w-full py-3 text-base">
                    下一步 <ArrowRight size={18} />
                  </Button>
                  <Button variant="ghost" onClick={handleSkip} disabled={saving} className="w-full">
                    <Settings size={16} /> 暂时跳过，稍后去设置配置
                  </Button>
                </div>

                {/* 错误提示 */}
                {error && (
                  <Alert variant="destructive">
                    <AlertTitle>错误</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            {/* Step 2: 填写 API Key */}
            {step === 1 && (
              <div className="space-y-6">
                <div>
                  <h2 className="mb-2 text-2xl font-bold text-rd-text">填写连接信息</h2>
                  <p className="text-rd-textMuted">输入 API Key 以连接到你选择的服务商</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Provider ID</Label>
                    <Input value={providerId} onChange={(e) => setProviderId(e.target.value)} placeholder="openai" />
                    <p className="text-xs text-rd-textSubtle">唯一标识符</p>
                  </div>
                  <div className="space-y-2">
                    <Label>显示名称</Label>
                    <Input value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="OpenAI" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>协议</Label>
                    <Select value={protocol} onChange={(e) => setProtocol(e.target.value as 'openai' | 'anthropic')}>
                      <SelectItem value="openai">OpenAI 兼容</SelectItem>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Base URL</Label>
                    <div className="relative">
                      <Globe size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-rd-textSubtle" />
                      <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="pl-9" />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>API Key</Label>
                  <div className="relative">
                    <KeyRound size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-rd-textSubtle" />
                    <Input
                      type={showApiKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                      className="pl-9 pr-10"
                    />
                    <button
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-rd-textSubtle hover:text-rd-text"
                      type="button"
                    >
                      {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1 text-rd-textSubtle">
                      <Shield size={12} /> Key 仅保存在本地
                    </span>
                    {PRESETS[selectedPreset].docsUrl && (
                      <a
                        href={PRESETS[selectedPreset].docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 font-semibold text-rd-primary hover:underline"
                      >
                        获取 API Key <ChevronRight size={12} />
                      </a>
                    )}
                  </div>
                </div>

                {error && (
                  <Alert variant="destructive">
                    <AlertTitle>保存失败</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-col gap-3">
                  <div className="flex gap-3">
                    <Button variant="outline" onClick={() => setStep(0)} className="flex-1 py-3">
                      <ArrowLeft size={18} /> 上一步
                    </Button>
                    <Button onClick={() => setStep(2)} disabled={!canNext} className="flex-1 py-3 text-base">
                      下一步 <ArrowRight size={18} />
                    </Button>
                  </div>
                  <Button variant="ghost" onClick={handleSkip} disabled={saving} className="w-full">
                    <Settings size={16} /> 暂时跳过，稍后去设置配置
                  </Button>
                </div>
              </div>
            )}

            {/* Step 3: 设置模型 */}
            {step === 2 && (
              <div className="space-y-6">
                <div>
                  <h2 className="mb-2 text-2xl font-bold text-rd-text">设置默认模型</h2>
                  <p className="text-rd-textMuted">配置完成后即可开始对话</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>模型 ID</Label>
                    <Input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="gpt-4o" />
                    <p className="text-xs text-rd-textSubtle">API 调用时使用的模型名称</p>
                  </div>
                  <div className="space-y-2">
                    <Label>模型显示名称</Label>
                    <Input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="GPT-4o" />
                  </div>
                </div>

                <Card>
                  <CardContent className="p-5">
                    <div className="mb-4 flex items-center gap-2 text-sm font-bold text-rd-text">
                      <Sparkles size={16} className="text-rd-primary" />
                      配置摘要
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <div className="text-rd-textSubtle">服务商</div>
                        <div className="font-semibold text-rd-text">{providerName}</div>
                      </div>
                      <div>
                        <div className="text-rd-textSubtle">协议</div>
                        <Badge variant="primary">{protocol === 'openai' ? 'OpenAI 兼容' : 'Anthropic'}</Badge>
                      </div>
                      <div className="col-span-2">
                        <div className="text-rd-textSubtle">Base URL</div>
                        <div className="font-mono text-xs text-rd-text">{baseUrl}</div>
                      </div>
                      <div>
                        <div className="text-rd-textSubtle">API Key</div>
                        <div className="font-mono text-xs text-rd-text">{apiKey ? '●●●●●●●●●●●●' : '未设置'}</div>
                      </div>
                      <div>
                        <div className="text-rd-textSubtle">默认模型</div>
                        <div className="font-semibold text-rd-text">{modelName}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {error && (
                  <Alert variant="destructive">
                    <AlertTitle>保存失败</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-col gap-3">
                  <div className="flex gap-3">
                    <Button variant="outline" onClick={() => setStep(1)} className="flex-1 py-3">
                      <ArrowLeft size={18} /> 上一步
                    </Button>
                    <Button onClick={handleFinish} disabled={saving || !canNext} className="flex-1 py-3 text-base">
                      {saving ? (
                        <>
                          <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                          保存中...
                        </>
                      ) : (
                        <>
                          <Check size={18} /> 完成配置，开始使用
                        </>
                      )}
                    </Button>
                  </div>
                  <Button variant="ghost" onClick={handleSkip} disabled={saving} className="w-full">
                    <Settings size={16} /> 暂时跳过，稍后去设置配置
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底部提示 */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-rd-border bg-rd-background px-8 py-3 lg:left-[420px]">
        <div className="mx-auto flex max-w-2xl items-center gap-2 text-xs text-rd-textSubtle">
          <Info size={14} />
          <span>配置保存在本地。跳过配置后，可在「设置 → Provider & 模型」中随时补全。</span>
        </div>
      </div>
    </div>
  );
}
