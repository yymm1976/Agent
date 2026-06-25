// desktop/renderer/src/pages/SettingsPage.tsx
// 设置页面：Provider / 模型 / 路由规则 / 安全 / 命令与工具 / 可观测性 / 记忆 / MCP / 渠道 / 外观 / 提示音 / 归档对话 / 关于

import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import {
  Save, Plus, Trash2, Shield, Route, Server, Target, BarChart3, FileText,
  Plug, Radio, Palette, Bell, Info, Eye, EyeOff, Download, Upload, Zap, X,
  CheckCircle2, AlertCircle, Archive, RotateCcw, Folder, BookOpen, Sparkles, RefreshCw,
  ChevronDown, ChevronRight, Map as MapIcon, Webhook, Code, Wand2, GraduationCap,
  ShoppingBag, Gauge, Brain, Lightbulb, Users,
} from 'lucide-react';
import type {
  AppConfig, ProviderConfig, ModelConfig, RouterRule, SecurityConfig,
  MCPServerEntryConfig, ChannelEntryConfig, ChannelType,
  PermissionProfile, FilesystemPermissionRule, ExecutionConfig,
  SandboxLevel, ApprovalLevel, ToolCategory,
} from '../../../../src/config/schema.js';
import type { ConfigSaveResult, SkillInfo, SkillPreview, MCPCatalogEntry, MCPInstallResult, ExperimentInfo, HookInfo } from '../../../shared/ipc-types.js';
import {
  parseStringList, constructMcpServer, mcpServerToForm, EMPTY_MCP_FORM,
  getChannelOptionFields, isChannelTypeSupported, constructChannelEntry,
  constructChannelOptions, getAppVersion, type McpFormState,
} from './settings-helpers.js';
import { Button } from '../components/ui/button.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select, SelectItem } from '../components/ui/select.js';
import { Badge, type BadgeProps } from '../components/ui/badge.js';
import { Switch } from '../components/ui/switch.js';
import { Alert, AlertTitle, AlertDescription } from '../components/ui/alert.js';
import { ConfirmDialog, AlertBanner } from '../components/ui/dialog.js';
import { useProjectsStore } from '../store/useProjectsStore.js';
import { SettingsPersonaTab } from '../components/settings/SettingsPersonaTab.js';
import { SettingsVoiceTab } from '../components/settings/SettingsVoiceTab.js';
import { SettingsDiscoveryTab } from '../components/settings/SettingsDiscoveryTab.js';
import { SettingsConversationTab } from '../components/settings/SettingsConversationTab.js';
import { SettingsExperimentTab } from '../components/settings/SettingsExperimentTab.js';
import { SettingsGoalTab } from '../components/settings/SettingsGoalTab.js';
import { SettingsHookEnhancementTab } from '../components/settings/SettingsHookEnhancementTab.js';

interface SettingsPageProps {
  config: AppConfig | null;
  saveConfig: (cfg: AppConfig) => Promise<ConfigSaveResult>;
  /** 热重载配置（可选，saveConfig 内部已自动 reload） */
  reloadConfig?: () => Promise<void>;
  /** 返回对话页 */
  onBack: () => void;
}

type TabId =
  | 'providers' | 'router' | 'security'
  | 'commands' | 'optimization' | 'execution' | 'memory'
  | 'mcp' | 'skills' | 'channels' | 'appearance' | 'sounds' | 'archived' | 'about'
  | 'codemap' | 'hooks' | 'expertise'
  | 'policies' | 'market' | 'subagents'
  | 'persona' | 'voice' | 'discovery'
  | 'conversation' | 'experiment'
  | 'goal' | 'hookEnhancement';

// 子 Agent Profile UI 类型（与 src/agents/profiles/types.ts 中的 AgentProfile 对应，
// 此处仅用于 SettingsPage 展示与本地编辑，不直接依赖 src/ 类型避免跨工程导入）
interface AgentProfileUI {
  id: string;
  name: string;
  role: 'researcher' | 'executor' | 'reviewer' | 'custom';
  modelId: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  forbiddenTools: string[];
  canChallenge: boolean;
  challengeSeverity: 'blocking' | 'warning';
  outputFormat: 'research_report' | 'code_change' | 'review_report' | 'custom';
  maxTokens: number;
  maxSteps: number;
  isBuiltin: boolean;
}

function deepClone<T>(obj: T): T {
  // 使用 structuredClone 保留 undefined 字段，避免配置导入后字段丢失
  if (typeof structuredClone === 'function') {
    return structuredClone(obj);
  }
  // 降级：旧环境无 structuredClone 时仍用 JSON 方式
  return JSON.parse(JSON.stringify(obj)) as T;
}

const EMPTY_PROVIDER: ProviderConfig = {
  id: '',
  name: '',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  models: [],
};

const EMPTY_MODEL: ModelConfig = {
  id: '',
  name: '',
  provider: '',
  tier: 'medium',
  contextWindow: 128000,
  capabilities: [],
  latencyMs: 0,
  available: true,
};

const EMPTY_RULE: RouterRule = {
  tier: 'simple',
  modelId: '',
};

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

// 内置子 Agent Profile 模板（与 src/agents/profiles/builtin-templates.ts 保持一致）
// 此处为 UI 展示用的静态副本，实际持久化由主进程 AgentProfileManager 负责
const BUILTIN_AGENT_PROFILES: AgentProfileUI[] = [
  {
    id: 'builtin-researcher',
    name: 'Researcher',
    role: 'researcher',
    modelId: 'default',
    description: '只读调研子 Agent：负责代码探索、依赖分析、影响面评估，产出研究报告，不修改任何文件。',
    systemPrompt: '# 角色定位\n你是 Researcher（调研员）。负责对代码库进行只读调研。\n\n# 绝对规则\n- 严格服从父 Agent 的委托契约，不越权、不扩展任务范围。\n- 仅使用 allowedTools 中声明的工具。\n\n# 禁止事项\n- 禁止写入、修改、删除任何文件。\n- 禁止执行有副作用的命令。\n\n# 输出格式\n输出 research_report（Markdown）：摘要 + 关键发现 + 影响面分析 + 风险建议。\n\n# 质疑权利\n若父 Agent 指令存在明显错误或安全风险，可提出质疑。',
    allowedTools: ['read_file', 'code_map_explore', 'find_callers', 'find_callees', 'analyze_impact'],
    forbiddenTools: ['file_write', 'file_edit', 'execute_command', 'run_tests', 'diff_view'],
    canChallenge: true,
    challengeSeverity: 'warning',
    outputFormat: 'research_report',
    maxTokens: 32000,
    maxSteps: 20,
    isBuiltin: true,
  },
  {
    id: 'builtin-executor',
    name: 'Executor',
    role: 'executor',
    modelId: 'default',
    description: '代码实现子 Agent：负责按委托契约编写或修改代码，运行测试验证，产出代码变更。',
    systemPrompt: '# 角色定位\n你是 Executor（执行者）。负责按委托契约实现具体代码变更并运行测试验证。\n\n# 绝对规则\n- 严格服从父 Agent 的委托契约，不越权、不扩展任务范围。\n- 仅使用 allowedTools 中声明的工具。\n\n# 禁止事项\n- 禁止扩展任务范围。\n- 禁止跳过测试直接交付。\n- 禁止修改与任务无关的文件。\n\n# 输出格式\n输出 code_change（Markdown）：变更摘要 + 变更清单 + 测试结果 + 遗留问题。\n\n# 质疑权利\n若父 Agent 指令存在明显错误或安全风险，可提出质疑。',
    allowedTools: ['read_file', 'file_write', 'file_edit', 'execute_command', 'run_tests'],
    forbiddenTools: ['code_map_explore', 'find_callers', 'find_callees', 'analyze_impact', 'diff_view'],
    canChallenge: true,
    challengeSeverity: 'blocking',
    outputFormat: 'code_change',
    maxTokens: 64000,
    maxSteps: 30,
    isBuiltin: true,
  },
  {
    id: 'builtin-reviewer',
    name: 'Reviewer',
    role: 'reviewer',
    modelId: 'default',
    description: '代码审查子 Agent：负责对 Executor 产出的代码变更进行审查，运行测试复核，产出审查报告。',
    systemPrompt: '# 角色定位\n你是 Reviewer（审查员）。负责对 Executor 提交的代码变更进行只读审查。\n\n# 绝对规则\n- 严格服从父 Agent 的委托契约，不越权、不扩展任务范围。\n- 仅使用 allowedTools 中声明的工具。\n\n# 禁止事项\n- 禁止直接修改被审查的代码。\n- 禁止执行有破坏性副作用的命令。\n- 禁止仅凭风格偏好给出 blocking 级别问题。\n\n# 输出格式\n输出 review_report（Markdown）：总体结论 + 问题清单 + 测试复核 + 亮点。\n\n# 质疑权利\n若父 Agent 指令存在明显错误或安全风险，可提出质疑。',
    allowedTools: ['read_file', 'diff_view', 'run_tests'],
    forbiddenTools: ['file_write', 'file_edit', 'execute_command', 'code_map_explore', 'find_callers', 'find_callees', 'analyze_impact'],
    canChallenge: true,
    challengeSeverity: 'blocking',
    outputFormat: 'review_report',
    maxTokens: 32000,
    maxSteps: 15,
    isBuiltin: true,
  },
];

// 网络搜索引擎配置表（下拉选择式）
const SEARCH_ENGINES = [
  { id: 'glm', label: '智谱 GLM', keyField: 'glmApiKey', applyUrl: 'https://z.ai/manage-apikey', desc: 'z.ai，中国直连推荐' },
  { id: 'metaso', label: '秘塔搜索', keyField: 'metasoApiKey', applyUrl: 'https://metaso.cn', desc: '中国直连' },
  { id: 'baidu', label: '百度千帆', keyField: 'baiduApiKey', applyUrl: 'https://console.bce.baidu.com/qianfan', desc: '中国直连' },
  { id: 'searxng', label: 'SearXNG', keyField: 'searxngEndpoint', applyUrl: 'https://github.com/searxng/searxng', desc: '自托管，填 URL 而非 Key' },
  { id: 'tavily', label: 'Tavily', keyField: 'tavilyApiKey', applyUrl: 'https://tavily.com', desc: '专为 AI Agent 设计，需翻墙' },
  { id: 'bing', label: 'Bing', keyField: 'bingApiKey', applyUrl: 'https://portal.azure.com', desc: 'Azure 门户获取，需翻墙' },
  { id: 'perplexity', label: 'Perplexity', keyField: 'perplexityApiKey', applyUrl: 'https://perplexity.ai/settings/api', desc: 'AI 原生搜索，需翻墙' },
  { id: 'exa', label: 'Exa', keyField: 'exaApiKey', applyUrl: 'https://exa.ai', desc: 'AI 原生搜索，需翻墙' },
  { id: 'brave', label: 'Brave', keyField: 'braveApiKey', applyUrl: 'https://brave.com/search/api/', desc: '隐私优先，需翻墙' },
] as const;

// 应用版本号（从 package.json 读取，Phase 33 Task 3.4 修复硬编码）
const APP_VERSION = getAppVersion();

function protocolBadgeVariant(protocol: string): BadgeProps['variant'] {
  return protocol === 'openai' ? 'primary' : 'outline';
}

function protocolIconClass(protocol: string): string {
  return protocol === 'openai'
    ? 'bg-rd-primary/10 text-rd-primary'
    : 'bg-rd-warning/10 text-rd-warning';
}

export function SettingsPage({ config, saveConfig, reloadConfig, onBack }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<TabId>('providers');
  // 高级设置折叠状态（默认折叠，包含不常用的安全/渠道/归档/关于）
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  // 保存成功后跳过一次 config→draft 同步，避免用户正在编辑的 Provider 被清空
  const skipSyncRef = useRef(false);
  const dirtyRef = useRef(false);

  // 替代原生 alert/confirm 的状态
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  // Phase 40：用户体验引导式选择展开状态
  const [showExpertiseGuide, setShowExpertiseGuide] = useState(false);
  // 网络搜索引擎下拉选择（默认 'glm'，draft 加载后推断第一个有 key 的引擎）
  const [selectedSearchEngine, setSelectedSearchEngine] = useState<string>('glm');
  const searchEngineInitedRef = useRef(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    variant?: 'default' | 'danger';
    onConfirm: () => void;
  } | null>(null);

  // API Key 显示/隐藏状态（按 provider index）
  const [showApiKeys, setShowApiKeys] = useState<Record<number, boolean>>({});
  // 测试连接状态
  const [testingProvider, setTestingProvider] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, { success: boolean; message: string } | null>>({});
  // MCP 添加/编辑表单：null=关闭，McpFormState=打开（添加或编辑）
  const [mcpForm, setMcpForm] = useState<McpFormState | null>(null);
  // MCP 编辑模式标记：null=添加模式，非 null=编辑模式（存储原始 server id）
  const [mcpEditingId, setMcpEditingId] = useState<string | null>(null);
  // MCP 插件市场 state
  const [catalogEntries, setCatalogEntries] = useState<MCPCatalogEntry[]>([]);
  const [catalogCategory, setCatalogCategory] = useState<string>('all');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<{ id: string; success: boolean; error?: string } | null>(null);
  const [installModal, setInstallModal] = useState<MCPCatalogEntry | null>(null);
  const [envInputs, setEnvInputs] = useState<Record<string, string>>({});
  const [headerInputs, setHeaderInputs] = useState<Record<string, string>>({});
  // Phase 37：Skill 管理 state
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillPreview, setSkillPreview] = useState<SkillPreview | null>(null);
  const [skillForm, setSkillForm] = useState<{ name: string; description: string; keywords: string; content: string } | null>(null);
  const [skillRouteTest, setSkillRouteTest] = useState<{ query: string; results: SkillInfo[] } | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  // Phase 39：Skill AI 自动生成对话框（描述 → 生成 → 确认）
  const [skillAiForm, setSkillAiForm] = useState<{ description: string; generating: boolean; generated: { name: string; description: string; keywords: string; content: string } | null } | null>(null);
  // Phase 39：Hooks state
  const [hooks, setHooks] = useState<HookInfo[]>([]);
  const [hookLoading, setHookLoading] = useState(false);
  const [hookCreateForm, setHookCreateForm] = useState<{ description: string; generating: boolean; generated: { name: string; event: string; content: string } | null } | null>(null);
  // 子 Agent Profile state
  // agentProfiles：内置 + 自定义全部 Profile；expandedAgentId：当前展开编辑的卡片 id
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileUI[]>([]);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  // 渠道添加表单
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [newChannel, setNewChannel] = useState({ id: '', type: 'wechat-work' as ChannelType });
  // 渠道凭据值（按字段 key 存储）
  const [channelCreds, setChannelCreds] = useState<Record<string, string>>({});
  // 渠道凭据显示/隐藏状态（按 字段key 存储）
  const [showChannelCreds, setShowChannelCreds] = useState<Record<string, boolean>>({});
  // 渠道编辑：null=无编辑，number=编辑指定 index 的 options
  const [editingChannelIdx, setEditingChannelIdx] = useState<number | null>(null);
  // 导入文件引用
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 模型编辑模态：null=关闭，{pIdx, mIdx?, model}=打开（mIdx 不存在=新增，存在=编辑）
  const [modelEditor, setModelEditor] = useState<{ pIdx: number; mIdx?: number; model: ModelConfig } | null>(null);

  // 当 activeTab 属于高级设置时，自动展开折叠组，避免用户在导航栏"丢失"当前页面
  useEffect(() => {
    if (['security', 'channels', 'archived', 'about'].includes(activeTab)) {
      setAdvancedExpanded(true);
    }
  }, [activeTab]);

  useEffect(() => {
    // 保存成功后跳过一次同步，保留用户正在编辑的 draft
    if (skipSyncRef.current) {
      skipSyncRef.current = false;
      return;
    }
    if (config) {
      dirtyRef.current = false;
      setDraft(deepClone(config));
    }
  }, [config]);

  // draft 首次加载后，推断默认选中的搜索引擎（第一个有 key 的引擎，否则 'glm'）
  useEffect(() => {
    if (!draft || searchEngineInitedRef.current) return;
    searchEngineInitedRef.current = true;
    const ws = draft.webSearch;
    const firstWithKey = SEARCH_ENGINES.find((eng) => {
      const v = (ws as Record<string, unknown>)?.[eng.keyField];
      return typeof v === 'string' && v.trim() !== '';
    });
    setSelectedSearchEngine(firstWithKey?.id ?? 'glm');
  }, [draft]);

  useEffect(() => {
    if (!draft || !dirtyRef.current) return;
    const timer = setTimeout(() => {
      void handleSave(true);
    }, 700);
    return () => clearTimeout(timer);
  }, [draft]);

  // 主题和字体大小实时预览：draft 变化时立即应用到 <html>，无需先保存
  useEffect(() => {
    if (!draft) return;
    const root = document.documentElement;
    root.setAttribute('data-theme', draft.general.appearanceTheme);
    root.style.setProperty('--rd-font-size', `${draft.general.fontSize}px`);
  }, [draft?.general.appearanceTheme, draft?.general.fontSize]);

  // 组件卸载时恢复到已保存的 config 值（若用户未保存则回退预览）
  useEffect(() => {
    return () => {
      if (config) {
        const root = document.documentElement;
        root.setAttribute('data-theme', config.general.appearanceTheme);
        root.style.setProperty('--rd-font-size', `${config.general.fontSize}px`);
      }
    };
  }, [config]);

  // 保存提示 3 秒后自动消失（必须放在 early return 之前，否则 hooks 数量不一致会触发 React #310）
  useEffect(() => {
    if (!saveResult) return;
    const timer = setTimeout(() => setSaveResult(null), 3000);
    return () => clearTimeout(timer);
  }, [saveResult]);

  // Phase 37：进入 Skills Tab 时加载 Skill 列表
  useEffect(() => {
    if (activeTab !== 'skills') return;
    refreshSkills();
  }, [activeTab]);

  // Phase 39：进入 Hooks Tab 时加载 Hook 列表
  useEffect(() => {
    if (activeTab !== 'hooks') return;
    refreshHooks();
  }, [activeTab]);

  // MCP 市场：进入 MCP Tab 时加载目录
  useEffect(() => {
    if (activeTab !== 'mcp') return;
    refreshCatalog();
  }, [activeTab]);

  /** 刷新 Skill 列表 */
  const refreshSkills = async () => {
    setSkillLoading(true);
    try {
      const list = await window.routedev.skill.list();
      setSkills(list);
    } catch (err) {
      console.error('加载 Skill 列表失败:', err);
    } finally {
      setSkillLoading(false);
    }
  };

  /** 切换 Skill 启用/禁用 */
  const handleSkillToggle = async (name: string, enabled: boolean) => {
    const ok = await window.routedev.skill.toggle(name, enabled);
    if (ok) {
      setSkills((prev) => prev.map((s) => s.name === name ? { ...s, enabled } : s));
    }
  };

  /** 预览 Skill */
  const handleSkillPreview = async (name: string) => {
    const preview = await window.routedev.skill.preview(name);
    setSkillPreview(preview);
  };

  /** 创建 Skill */
  const handleSkillCreate = async () => {
    if (!skillForm) return;
    const keywords = skillForm.keywords.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
    const result = await window.routedev.skill.create({
      name: skillForm.name,
      description: skillForm.description,
      keywords,
      content: skillForm.content,
    });
    if (result.success) {
      setSkillForm(null);
      await refreshSkills();
    } else {
      setAlertMsg(`创建失败: ${result.error}`);
    }
  };

  /** 删除 Skill */
  const handleSkillDelete = async (name: string) => {
    setConfirmDialog({
      message: `确定删除 Skill "${name}" 吗？此操作不可恢复。`,
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        const result = await window.routedev.skill.delete(name);
        if (result.success) {
          await refreshSkills();
        } else {
          setAlertMsg(`删除失败: ${result.error}`);
        }
      },
    });
  };

  /** 测试 Skill 路由匹配 */
  const handleSkillRouteTest = async () => {
    if (!skillRouteTest || !skillRouteTest.query.trim()) return;
    const result = await window.routedev.skill.route(skillRouteTest.query);
    setSkillRouteTest({ ...skillRouteTest, results: result.skills });
  };

  /** 重新发现 Skill */
  const handleSkillReload = async () => {
    await window.routedev.skill.reload();
    await refreshSkills();
  };

  // ============================================================
  // Phase 39：Hooks / Skill AI 生成 handler
  // ============================================================

  /** 刷新 Hook 列表 */
  const refreshHooks = async () => {
    setHookLoading(true);
    try {
      const list = await window.routedev.hook.list();
      setHooks(list);
    } catch (err) {
      console.error('加载 Hook 列表失败:', err);
    } finally {
      setHookLoading(false);
    }
  };

  /** 切换 Hook 启用/禁用 */
  const handleHookToggle = async (hookId: string, enabled: boolean) => {
    const result = await window.routedev.hook.toggle(hookId, enabled);
    if (result.success) {
      setHooks((prev) => prev.map((h) => h.id === hookId ? { ...h, enabled } : h));
    } else {
      setAlertMsg(`切换失败: ${result.error}`);
    }
  };

  /** 删除自定义 Hook */
  const handleHookDelete = async (hookId: string) => {
    setConfirmDialog({
      message: `确定删除 Hook "${hookId}" 吗？此操作不可恢复。`,
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog(null);
        const result = await window.routedev.hook.delete(hookId);
        if (result.success) {
          await refreshHooks();
        } else {
          setAlertMsg(`删除失败: ${result.error}`);
        }
      },
    });
  };

  /** AI 生成 Hook（通过自然语言描述） */
  const handleHookAiGenerate = async () => {
    if (!hookCreateForm || !hookCreateForm.description.trim()) return;
    setHookCreateForm({ ...hookCreateForm, generating: true });
    try {
      const result = await window.routedev.hook.create(hookCreateForm.description);
      if (result.success && result.hookId) {
        setHookCreateForm(null);
        await refreshHooks();
      } else {
        setAlertMsg(`生成失败: ${result.error}`);
      }
    } catch (err) {
      setAlertMsg(`生成失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (hookCreateForm) {
        setHookCreateForm({ ...hookCreateForm, generating: false });
      }
    }
  };

  /** Skill AI 自动生成（通过自然语言描述） */
  const handleSkillAiGenerate = async () => {
    if (!skillAiForm || !skillAiForm.description.trim()) return;
    setSkillAiForm({ ...skillAiForm, generating: true });
    try {
      // 调用 skill.create，将描述作为内容，自动生成名称和关键词
      const desc = skillAiForm.description.trim();
      const autoName = `ai-${Date.now().toString(36).slice(-6)}`;
      const result = await window.routedev.skill.create({
        name: autoName,
        description: desc,
        keywords: desc.split(/\s+/).filter((w) => w.length > 1).slice(0, 5),
        content: `# ${desc}\n\n本 Skill 由 AI 自动生成，请根据实际需求编辑内容。`,
      });
      if (result.success) {
        setSkillAiForm(null);
        await refreshSkills();
      } else {
        setAlertMsg(`生成失败: ${result.error}`);
      }
    } catch (err) {
      setAlertMsg(`生成失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (skillAiForm) {
        setSkillAiForm({ ...skillAiForm, generating: false });
      }
    }
  };

  if (!draft) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center text-rd-textMuted">
        配置加载中...
      </div>
    );
  }

  // --- 通用更新 ---
  const updateDraft = (patch: Partial<AppConfig>) => {
    dirtyRef.current = true;
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaveResult(null);
  };

  // --- Provider 操作 ---
  const updateProvider = (index: number, patch: Partial<ProviderConfig>) => {
    const providers = [...draft.providers];
    providers[index] = { ...providers[index], ...patch };
    updateDraft({ providers });
  };
  // 添加 Provider：自动生成唯一 ID（用户无需手动填写）
  const addProvider = () => {
    const existingCount = draft.providers.length;
    const newProvider: ProviderConfig = {
      ...EMPTY_PROVIDER,
      id: `provider-${Date.now().toString(36).slice(-4)}-${existingCount + 1}`,
      name: `Provider ${existingCount + 1}`,
    };
    updateDraft({ providers: [...draft.providers, newProvider] });
  };
  const removeProvider = (index: number) => {
    const providers = draft.providers.filter((_, i) => i !== index);
    updateDraft({ providers });
  };

  // --- 模型操作 ---
  const updateModel = (pIdx: number, mIdx: number, patch: Partial<ModelConfig>) => {
    const providers = [...draft.providers];
    const models = [...providers[pIdx].models];
    models[mIdx] = { ...models[mIdx], ...patch, provider: providers[pIdx].id };
    providers[pIdx] = { ...providers[pIdx], models };
    updateDraft({ providers });
  };
  // 打开模型编辑模态（新增）
  const openAddModel = (pIdx: number) => {
    setModelEditor({
      pIdx,
      model: { ...EMPTY_MODEL, provider: draft.providers[pIdx].id },
    });
  };
  // 打开模型编辑模态（编辑现有）
  const openEditModel = (pIdx: number, mIdx: number) => {
    setModelEditor({ pIdx, mIdx, model: { ...draft.providers[pIdx].models[mIdx] } });
  };
  // 确认模型编辑模态
  const confirmModelEditor = () => {
    if (!modelEditor) return;
    const { pIdx, mIdx, model } = modelEditor;
    if (mIdx === undefined) {
      // 新增模型
      const providers = [...draft.providers];
      providers[pIdx] = {
        ...providers[pIdx],
        models: [...providers[pIdx].models, { ...model, provider: providers[pIdx].id }],
      };
      updateDraft({ providers });
    } else {
      // 编辑模型
      updateModel(pIdx, mIdx, model);
    }
    setModelEditor(null);
  };
  const removeModel = (pIdx: number, mIdx: number) => {
    const providers = [...draft.providers];
    providers[pIdx] = {
      ...providers[pIdx],
      models: providers[pIdx].models.filter((_, i) => i !== mIdx),
    };
    updateDraft({ providers });
  };

  // --- 路由规则操作 ---
  const updateRule = (index: number, patch: Partial<RouterRule>) => {
    const rules = [...draft.router.rules];
    rules[index] = { ...rules[index], ...patch };
    updateDraft({ router: { ...draft.router, rules } });
  };
  const addRule = () => updateDraft({ router: { ...draft.router, rules: [...draft.router.rules, { ...EMPTY_RULE }] } });
  const removeRule = (index: number) => {
    updateDraft({ router: { ...draft.router, rules: draft.router.rules.filter((_, i) => i !== index) } });
  };

  // --- 预算操作 ---
  const updateBudget = (patch: Partial<typeof draft.router.budget>) => {
    updateDraft({ router: { ...draft.router, budget: { ...draft.router.budget, ...patch } } });
  };

  // --- 安全配置 ---
  const updateSecurity = (patch: Partial<SecurityConfig>) => {
    updateDraft({ security: { ...draft.security, ...patch } });
  };
  // Phase 48：更新某个 ToolCategory 的审批级覆盖（合并到 config.security.approval）
  const updateSecurityApproval = (category: ToolCategory, level: ApprovalLevel) => {
    const current = { ...(draft.security.approval ?? {}) };
    current[category] = level;
    updateSecurity({ approval: current });
  };

  // --- 权限规则配置（Permission Profile） ---
  const updatePermissionProfile = (patch: Partial<PermissionProfile>) => {
    updateDraft({ permissionProfile: { ...draft.permissionProfile, ...patch } });
  };
  // 文件系统规则：更新指定索引
  const updateFsRule = (index: number, patch: Partial<FilesystemPermissionRule>) => {
    const filesystem = [...draft.permissionProfile.filesystem];
    filesystem[index] = { ...filesystem[index], ...patch };
    updatePermissionProfile({ filesystem });
  };
  // 文件系统规则：新增
  const addFsRule = () => {
    updatePermissionProfile({
      filesystem: [...draft.permissionProfile.filesystem, { pattern: '**/*', access: 'read' }],
    });
  };
  // 文件系统规则：删除
  const removeFsRule = (index: number) => {
    updatePermissionProfile({
      filesystem: draft.permissionProfile.filesystem.filter((_, i) => i !== index),
    });
  };
  // 网络域名规则：更新白名单/黑名单（逗号分隔文本）
  const updateNetworkAllow = (value: string) => {
    updatePermissionProfile({
      network: {
        ...draft.permissionProfile.network,
        allow: value.split(',').map((s) => s.trim()).filter(Boolean),
      },
    });
  };
  const updateNetworkDeny = (value: string) => {
    updatePermissionProfile({
      network: {
        ...draft.permissionProfile.network,
        deny: value.split(',').map((s) => s.trim()).filter(Boolean),
      },
    });
  };

  // --- 网络搜索配置 ---
  const updateWebSearch = (patch: Partial<{
    glmApiKey: string; metasoApiKey: string; baiduApiKey: string;
    tavilyApiKey: string; bingApiKey: string;
    perplexityApiKey: string; exaApiKey: string; braveApiKey: string;
    searxngEndpoint: string;
  }>) => {
    updateDraft({ webSearch: { ...draft.webSearch, ...patch } });
  };

  // --- 自主度配置 ---
  const updateAutonomy = (patch: Partial<typeof draft.autonomy>) => {
    updateDraft({ autonomy: { ...draft.autonomy, ...patch } });
  };

  // --- 可观测性配置 ---
  const updateOptimization = (patch: Partial<typeof draft.optimization>) => {
    updateDraft({ optimization: { ...draft.optimization, ...patch } });
  };
  const updateTokenTracking = (patch: Partial<typeof draft.optimization.tokenTracking>) => {
    updateDraft({ optimization: { ...draft.optimization, tokenTracking: { ...draft.optimization.tokenTracking, ...patch } } });
  };
  // --- Phase 31：统一工作流编排 ---
  const updateWorkflow = (patch: Partial<typeof draft.optimization.workflow>) => {
    updateOptimization({ workflow: { ...draft.optimization.workflow, ...patch } });
  };
  // --- Phase 31 Task 6：生产安全防护 ---
  const updateSafety = (patch: Partial<typeof draft.optimization.safety>) => {
    updateOptimization({ safety: { ...draft.optimization.safety, ...patch } });
  };
  // 任务3：简洁思考约束
  const updateConciseThinking = (patch: Partial<typeof draft.optimization.conciseThinking>) => {
    updateOptimization({ conciseThinking: { ...draft.optimization.conciseThinking, ...patch } });
  };

  // --- Checkpoint 配置 ---
  const updateCheckpoint = (patch: Partial<typeof draft.checkpoint>) => {
    updateDraft({ checkpoint: { ...draft.checkpoint, ...patch } });
  };
  // Phase 33 Task 3：Checkpoint triggers 编辑
  const updateCheckpointTrigger = (index: number, patch: Partial<typeof draft.checkpoint.triggers[0]>) => {
    const triggers = [...draft.checkpoint.triggers];
    triggers[index] = { ...triggers[index], ...patch };
    updateCheckpoint({ triggers });
  };
  const addCheckpointTrigger = () => {
    updateCheckpoint({ triggers: [...draft.checkpoint.triggers, { level: 50, action: 'incremental' }] });
  };
  const removeCheckpointTrigger = (index: number) => {
    updateCheckpoint({ triggers: draft.checkpoint.triggers.filter((_, i) => i !== index) });
  };

  // --- Phase 33 Task 3：goalVerifier 配置 ---
  const updateGoalVerifier = (patch: Partial<typeof draft.goalVerifier>) => {
    updateDraft({ goalVerifier: { ...draft.goalVerifier, ...patch } });
  };

  // --- Phase 33 Task 3：adversarial 配置 ---
  const updateAdversarial = (patch: Partial<typeof draft.adversarial>) => {
    updateDraft({ adversarial: { ...draft.adversarial, ...patch } });
  };

  // --- 执行配置（并发/熔断/检查点提示） ---
  const updateExecution = (patch: Partial<ExecutionConfig>) => {
    updateDraft({ execution: { ...draft.execution, ...patch } });
  };

  // --- Phase 33 Task 3：updates 配置 ---
  const updateUpdates = (patch: Partial<typeof draft.updates>) => {
    updateDraft({ updates: { ...draft.updates, ...patch } });
  };

  // --- Phase 33 Task 3：prompts 配置 ---
  const updatePrompts = (patch: Partial<typeof draft.prompts>) => {
    updateDraft({ prompts: { ...draft.prompts, ...patch } });
  };

  // --- 项目记忆配置 ---
  const updateProjectMemory = (patch: Partial<typeof draft.projectMemory>) => {
    updateDraft({ projectMemory: { ...draft.projectMemory, ...patch } });
  };

  // --- Phase 45：记忆配置（推理 / 自动学习 / 注入阈值） ---
  const updateMemory = (patch: Partial<typeof draft.memory>) => {
    updateDraft({ memory: { ...draft.memory, ...patch } });
  };

  // --- MCP 配置 ---
  const updateMcp = (patch: Partial<typeof draft.mcp>) => {
    updateDraft({ mcp: { ...draft.mcp, ...patch } });
  };
  const updateMcpServer = (index: number, patch: Partial<MCPServerEntryConfig>) => {
    const servers = [...draft.mcp.servers];
    servers[index] = { ...servers[index], ...patch };
    updateMcp({ servers });
  };
  const removeMcpServer = (index: number) => {
    updateMcp({ servers: draft.mcp.servers.filter((_, i) => i !== index) });
  };
  // 提交 MCP 表单（添加或编辑）
  const submitMcpForm = () => {
    if (!mcpForm) return;
    const entry = constructMcpServer(mcpForm);
    if (mcpEditingId !== null) {
      // 编辑模式：找到原始 id 对应的 server，保留 enabled 状态
      const existingIdx = draft.mcp.servers.findIndex((s) => s.id === mcpEditingId);
      if (existingIdx >= 0) {
        const servers = [...draft.mcp.servers];
        servers[existingIdx] = { ...entry, enabled: draft.mcp.servers[existingIdx].enabled };
        updateMcp({ servers });
      }
    } else {
      // 添加模式
      updateMcp({ servers: [...draft.mcp.servers, entry] });
    }
    setMcpForm(null);
    setMcpEditingId(null);
  };
  // 打开 MCP 添加表单
  const openAddMcp = () => {
    setMcpForm({ ...EMPTY_MCP_FORM });
    setMcpEditingId(null);
  };
  // 打开 MCP 编辑表单
  const openEditMcp = (index: number) => {
    setMcpForm(mcpServerToForm(draft.mcp.servers[index]));
    setMcpEditingId(draft.mcp.servers[index].id);
  };

  // --- MCP 插件市场 ---
  // 加载目录（按分类或搜索关键词）
  const refreshCatalog = async (category?: string, search?: string) => {
    try {
      const cat = category ?? catalogCategory;
      const q = (search ?? catalogSearch).trim();
      const result = q
        ? await window.routedev.mcp.catalog.search(q)
        : await window.routedev.mcp.catalog.list(cat === 'all' ? undefined : cat);
      setCatalogEntries(result.entries);
    } catch (err) {
      console.error('[MCP Market] 加载目录失败:', err);
      setCatalogEntries([]);
    }
  };
  // 切换分类
  const handleCatalogCategoryChange = (cat: string) => {
    setCatalogCategory(cat);
    setCatalogSearch('');
    refreshCatalog(cat, '');
  };
  // 搜索
  const handleCatalogSearch = (value: string) => {
    setCatalogSearch(value);
    if (value.trim()) {
      refreshCatalog(undefined, value);
    } else {
      refreshCatalog(catalogCategory, '');
    }
  };
  // 打开安装模态框
  const openInstallModal = (entry: MCPCatalogEntry) => {
    setInstallModal(entry);
    // 初始化 env/headers 输入框
    const envInit: Record<string, string> = {};
    for (const key of entry.requiredEnv ?? []) envInit[key] = '';
    setEnvInputs(envInit);
    const hdrInit: Record<string, string> = {};
    for (const key of entry.requiredHeaders ?? []) hdrInit[key] = '';
    setHeaderInputs(hdrInit);
    setInstallResult(null);
  };
  // 执行安装
  const handleInstall = async () => {
    if (!installModal) return;
    setInstallingId(installModal.id);
    setInstallResult(null);
    try {
      const result: MCPInstallResult = await window.routedev.mcp.install({
        catalogId: installModal.id,
        envValues: envInputs,
        headerValues: headerInputs,
      });
      setInstallResult({ id: installModal.id, success: result.success, error: result.error });
      if (result.success) {
        // 安装成功后重新加载配置（后端已持久化，前端需同步 draft）
        const newConfig = await window.routedev.config.get();
        updateDraft({ mcp: newConfig.mcp });
      }
    } catch (err) {
      setInstallResult({ id: installModal.id, success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setInstallingId(null);
    }
  };

  // --- 渠道配置 ---
  const updateChannels = (patch: Partial<typeof draft.channels>) => {
    updateDraft({ channels: { ...draft.channels, ...patch } });
  };
  const removeChannel = (index: number) => {
    updateChannels({ entries: draft.channels.entries.filter((_, i) => i !== index) });
  };
  // 添加渠道：使用 channelCreds 中的值构造 options
  const addChannel = () => {
    const entry = constructChannelEntry(newChannel.id, newChannel.type, channelCreds);
    updateChannels({ entries: [...draft.channels.entries, entry] });
    setNewChannel({ id: '', type: 'wechat-work' });
    setChannelCreds({});
    setShowAddChannel(false);
  };
  // 保存渠道 options 编辑
  const saveChannelOptions = (index: number) => {
    const entries = [...draft.channels.entries];
    const entry = entries[index];
    const options = constructChannelOptions(entry.type, channelCreds);
    entries[index] = { ...entry, options };
    updateChannels({ entries });
    setEditingChannelIdx(null);
    setChannelCreds({});
  };

  // --- 通用配置 ---
  const updateGeneral = (patch: Partial<typeof draft.general>) => {
    updateDraft({ general: { ...draft.general, ...patch } });
  };

  // --- 后台行为配置 ---
  const updateBackgroundBehavior = (patch: Partial<typeof draft.general.backgroundBehavior>) => {
    updateGeneral({ backgroundBehavior: { ...draft.general.backgroundBehavior, ...patch } });
  };

  // --- UI 配置 ---
  const updateUi = (patch: Partial<typeof draft.ui>) => {
    updateDraft({ ui: { ...draft.ui, ...patch } });
  };

  // --- 提示音配置 ---
  const updateSounds = (patch: Partial<typeof draft.sounds>) => {
    updateDraft({ sounds: { ...draft.sounds, ...patch } });
  };

  // --- Phase 40：渐进式信任配置 ---
  const updateTrust = (patch: Partial<typeof draft.trust>) => {
    updateDraft({ trust: { ...draft.trust, ...patch } });
  };

  // --- Phase 40：质量监测配置 ---
  const updateQuality = (patch: Partial<typeof draft.quality>) => {
    updateDraft({ quality: { ...draft.quality, ...patch } });
  };

  // --- Phase 40：用户经验配置 ---
  const updateExpertise = (patch: Partial<typeof draft.expertise>) => {
    updateDraft({ expertise: { ...draft.expertise, ...patch } });
  };

  // --- Phase 43：子 Agent 配置 ---
  const updateSubAgents = (patch: Partial<typeof draft.subAgents>) => {
    updateDraft({ subAgents: { ...draft.subAgents, ...patch } });
  };
  const updateSubAgentsGateRules = (patch: { researcherMaxParallel?: number; executorMaxParallel?: number; reviewerMaxParallel?: number }) => {
    updateSubAgents({
      gateRules: {
        researcherMaxParallel: patch.researcherMaxParallel ?? draft.subAgents.gateRules?.researcherMaxParallel ?? 3,
        executorMaxParallel: patch.executorMaxParallel ?? draft.subAgents.gateRules?.executorMaxParallel ?? 2,
        reviewerMaxParallel: patch.reviewerMaxParallel ?? draft.subAgents.gateRules?.reviewerMaxParallel ?? 2,
      },
    });
  };

  // --- API Key 显示/隐藏切换 ---
  const toggleApiKey = (index: number) => {
    setShowApiKeys((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  // --- 测试 Provider 连接 ---
  const handleTestConnection = async (index: number) => {
    const provider = draft.providers[index];
    setTestingProvider(index);
    setTestResults((prev) => ({ ...prev, [index]: null }));
    try {
      await window.routedev.tool.execute({
        name: 'test_connection',
        args: { providerId: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKey },
      });
      setTestResults((prev) => ({ ...prev, [index]: { success: true, message: '连接成功' } }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [index]: { success: false, message: err instanceof Error ? err.message : '连接失败' },
      }));
    } finally {
      setTestingProvider(null);
    }
  };

  // --- 导出配置 ---
  const handleExport = () => {
    const json = JSON.stringify(draft, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `routedev-config-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- 导入配置 ---
  const handleImport = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as AppConfig;
        setDraft(parsed);
        setSaveResult(null);
      } catch {
        setSaveResult({ success: false, message: '导入失败：JSON 解析错误' });
      }
    };
    reader.readAsText(file);
    // 重置 input 以便重复导入同一文件
    e.target.value = '';
  };

  // --- 保存配置 ---
  const handleSave = async (silent = false) => {
    if (!draft) return;
    // 保存前清理：过滤掉 apiKey 为空的 provider（apiKey 是最关键字段）
    // name 为空时自动用 id 作为 name，避免用户只填了部分字段导致被过滤
    const validProviders = draft.providers
      .filter((p) => p.apiKey.trim())
      .map((p) => ({
        ...p,
        id: p.id.trim(),
        name: p.name.trim() || p.id.trim(),
        apiKey: p.apiKey.trim(),
        baseUrl: p.baseUrl.trim(),
      }));
    // 过滤掉每个 provider 下空的 model（id 为空），name 为空时自动用 id
    const cleanedProviders = validProviders.map((p) => ({
      ...p,
      models: p.models
        .filter((m) => m.id.trim())
        .map((m) => ({
          ...m,
          id: m.id.trim(),
          name: m.name.trim() || m.id.trim(),
          provider: p.id,
        })),
    }));
    // 修复路由规则：将 unconfigured 或不存在的 modelId 替换为已配置的模型
    // 避免保存后路由器找不到可用模型导致对话失败
    const configuredModelIds = new Set(cleanedProviders.flatMap((p) => p.models.map((m) => m.id)));
    const tierToFirstModel = new Map<string, string>();
    const allModelIds = cleanedProviders.flatMap((p) => p.models.map((m) => m.id));
    for (const p of cleanedProviders) {
      for (const m of p.models) {
        if (m.tier && !tierToFirstModel.has(m.tier)) {
          tierToFirstModel.set(m.tier, m.id);
        }
      }
    }
    const cleanedRules = draft.router.rules.map((rule) => {
      let modelId = rule.modelId;
      let fallbackModelId = rule.fallbackModelId;
      // 修复主模型
      if (!modelId || modelId === 'unconfigured' || !configuredModelIds.has(modelId)) {
        const replacement = tierToFirstModel.get(rule.tier) ?? allModelIds[0];
        if (replacement) {
          modelId = replacement;
        }
      }
      // 修复 fallback 模型
      if (fallbackModelId && (fallbackModelId === 'unconfigured' || !configuredModelIds.has(fallbackModelId))) {
        fallbackModelId = allModelIds.find((id) => id !== modelId) ?? undefined;
      }
      return { ...rule, modelId, fallbackModelId };
    });
    // 保存到磁盘时过滤空字符串；但 UI draft 保留空项，避免刚点击“添加降级模型”就被自动保存清掉
    const cleanedFallbackChain = (draft.router.fallbackChain ?? [])
      .map((id) => id.trim())
      .filter((id) => id && configuredModelIds.has(id));
    const cleanedDraft = { ...draft, providers: cleanedProviders, router: { ...draft.router, rules: cleanedRules, fallbackChain: cleanedFallbackChain } };
    setSaving(true);
    const result = await saveConfig(cleanedDraft);
    // saveConfig 内部已调用 reload；若额外提供 reloadConfig 则再调用一次
    if (result.success && reloadConfig) {
      try {
        await reloadConfig();
      } catch (err) {
        console.error('[SettingsPage] reloadConfig 失败:', err);
        setSaving(false);
        setSaveResult({
          success: true,
          message: `配置已保存，但热重载失败: ${err instanceof Error ? err.message : String(err)}。重启应用后生效。`,
        });
        return;
      }
    }
    setSaving(false);
    if (!silent || !result.success) {
      setSaveResult({
        success: result.success,
        message: result.success ? '配置已自动保存并热重载' : `保存失败: ${result.error ?? '未知错误'}`,
      });
    }
    // 保存成功后跳过 config→draft 同步，保留用户正在编辑的 draft
    // draft 保留原始内容（包括未通过校验的 Provider），避免用户看到表单清空
    if (result.success) {
      skipSyncRef.current = true;
      dirtyRef.current = false;
      // 用 cleanedDraft 更新 draft（已保存的有效 Provider 用清理后的版本）
      // 但保留未通过校验的 Provider，让用户继续编辑
      const failedProviders = draft.providers.filter((p) => !p.apiKey.trim());
      setDraft(deepClone({ ...cleanedDraft, providers: [...cleanedProviders, ...failedProviders], router: { ...cleanedDraft.router, fallbackChain: draft.router.fallbackChain ?? [] } }));
    }
  };

  // Tab 分组：常用 → 不常用 → 高级设置（折叠）
  // 常用：模型配置、外观、路由、执行、插件MCP、提示音
  // 不常用：Skill、记忆检查点、可观测性、命令工具
  // 高级：安全设置、渠道集成、归档对话、关于
  const mainTabs = [
    { id: 'providers', label: '模型配置', icon: Server },
    { id: 'appearance', label: '外观', icon: Palette },
    { id: 'router', label: '路由规则', icon: Route },
    { id: 'execution', label: '执行', icon: Zap },
    { id: 'mcp', label: '插件 & MCP', icon: Plug },
    { id: 'sounds', label: '提示音', icon: Bell },
    { id: 'expertise', label: '用户体验', icon: GraduationCap },
    { id: 'persona', label: '人格', icon: Sparkles },
    { id: 'voice', label: '语音', icon: Radio },
    { id: 'goal', label: '/goal', icon: Target },
    { id: 'conversation', label: '对话', icon: FileText },
    { id: 'skills', label: 'Skill 技能', icon: BookOpen },
    { id: 'hooks', label: 'Hooks', icon: Webhook },
    { id: 'memory', label: '记忆 & 检查点', icon: Brain },
    { id: 'optimization', label: '可观测性', icon: BarChart3 },
    { id: 'commands', label: '命令与工具', icon: Target },
    { id: 'codemap', label: '代码地图', icon: MapIcon },
    { id: 'policies', label: '策略引擎', icon: Shield },
    { id: 'market', label: '市场', icon: ShoppingBag },
    { id: 'subagents', label: '子 Agent', icon: Users },
  ] as const;

  const advancedTabs = [
    { id: 'experiment', label: '并行实验', icon: Gauge },
    { id: 'discovery', label: '功能发现', icon: Lightbulb },
    { id: 'hookEnhancement', label: 'Hook 增强', icon: Wand2 },
    { id: 'security', label: '安全设置', icon: Shield },
    { id: 'channels', label: '渠道集成', icon: Radio },
    { id: 'archived', label: '归档对话', icon: Archive },
    { id: 'about', label: '关于', icon: Info },
  ] as const;

  return (
    <>
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-hidden p-6">
      {/* 顶部：标题 + 标签栏 + 导入导出 + 保存 */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={onBack} title="关闭设置">
              <X size={18} />
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-rd-text">设置</h1>
              <p className="text-sm text-rd-textMuted">管理模型、路由规则与应用偏好</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileInputRef} type="file" accept="application/json" onChange={handleImport} className="hidden" />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload size={16} /> 导入
            </Button>
            <Button variant="outline" onClick={handleExport}>
              <Download size={16} /> 导出
            </Button>
            {saving && <span className="text-xs text-rd-textMuted">自动保存中...</span>}
          </div>
        </div>
      </div>

      {/* 保存提示：顶部居中浮动 toast，3 秒自动消失 */}
      {saveResult && (
        <div className="fixed top-6 left-1/2 z-50 -translate-x-1/2">
          <div
            className={[
              'flex items-center gap-2.5 rounded-xl px-5 py-3 shadow-rdLg',
              saveResult.success ? 'bg-rd-surfaceHighlight text-rd-text' : 'bg-rd-danger/15 text-rd-danger',
            ].join(' ')}
          >
            {saveResult.success ? (
              <CheckCircle2 size={18} className="shrink-0 text-rd-success" />
            ) : (
              <AlertCircle size={18} className="shrink-0" />
            )}
            <span className="text-sm font-medium">{saveResult.message}</span>
          </div>
        </div>
      )}

      {/* 下方 flex 布局：左侧标签导航 + 右侧内容区 */}
      <div className="flex flex-1 min-h-0 gap-6 overflow-hidden">
        {/* 左侧标签导航栏 */}
        <nav className="w-40 shrink-0 flex flex-col gap-1 overflow-y-auto py-2">
          {/* 常用 + 不常用 Tab */}
          {mainTabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabId)}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-rd-surfaceHighlight text-rd-text font-medium'
                    : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text'
                }`}
              >
                <Icon size={16} />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}

          {/* 高级设置标题行（点击展开/折叠，无分隔线，与 mainTabs 同级） */}
          <button
            type="button"
            onClick={() => setAdvancedExpanded((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 pt-2 pb-1 text-xs text-rd-textMuted hover:text-rd-text"
          >
            {advancedExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>高级</span>
          </button>

          {/* 高级设置子项（展开时显示，样式与 mainTabs 完全一致） */}
          {advancedExpanded && (
            <div className="flex flex-col gap-1">
              {advancedTabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as TabId)}
                    className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                      active
                        ? 'bg-rd-surfaceHighlight text-rd-text font-medium'
                        : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text'
                    }`}
                  >
                    <Icon size={16} />
                    <span className="truncate">{tab.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </nav>

        {/* 右侧内容区（relative 定位，子 tab 内容用 absolute inset-0 填充，避免 flexbox 高度抖动） */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
      {/* ===== Provider & 模型 ===== */}
      {activeTab === 'providers' && (
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
      )}

      {/* ===== 路由规则 ===== */}
      {activeTab === 'router' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          <Card>
            <CardHeader>
              <CardTitle>路由偏好</CardTitle>
              <CardDescription>配置分类器模型与用户成本/质量偏好</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="router-classifier">分类器模型</Label>
                  {/* 从已配置的模型中选择，避免手动输入不存在的模型 ID */}
                  <Select
                    id="router-classifier"
                    value={draft.router.classifierModel}
                    onChange={(e) => updateDraft({ router: { ...draft.router, classifierModel: e.target.value } })}
                  >
                    <SelectItem value="">跟随路由默认</SelectItem>
                    {draft.providers.flatMap((p) => p.models).map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                    ))}
                  </Select>
                  <p className="text-xs text-rd-textMuted">判断用户请求复杂度等级的模型，建议选最便宜的模型以节省成本。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="router-preference">用户偏好</Label>
                  <Select
                    id="router-preference"
                    value={draft.router.userPreference}
                    onChange={(e) => updateDraft({ router: { ...draft.router, userPreference: e.target.value as 'saving' | 'balanced' | 'premium' } })}
                  >
                    <SelectItem value="saving">省钱</SelectItem>
                    <SelectItem value="balanced">平衡</SelectItem>
                    <SelectItem value="premium">高质量</SelectItem>
                  </Select>
                  <p className="text-xs text-rd-textMuted">同等级任务有多个候选模型时，优先选便宜还是高质量的模型。</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Token 预算</CardTitle>
              <CardDescription>设置预算模式、日限额与降级阈值</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="budget-mode">预算模式</Label>
                  <Select
                    id="budget-mode"
                    value={draft.router.budget.mode}
                    onChange={(e) => updateBudget({ mode: e.target.value as 'track_only' | 'enforce' })}
                  >
                    <SelectItem value="track_only">仅追踪（track_only）</SelectItem>
                    <SelectItem value="enforce">强制执行（enforce）</SelectItem>
                  </Select>
                  <p className="text-xs text-rd-textMuted">仅追踪只统计不限制；强制执行会在达到限额时降级到更便宜的模型或拒绝请求。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="budget-daily">日 Token 上限</Label>
                  <Input
                    id="budget-daily"
                    type="number"
                    value={draft.router.budget.dailyLimit}
                    onChange={(e) => updateBudget({ dailyLimit: Number(e.target.value) })}
                  />
                  <p className="text-xs text-rd-textMuted">单日累计 Token 消耗上限，超过后按预算模式处理。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="budget-per-request">单次请求上限（可选）</Label>
                  <Input
                    id="budget-per-request"
                    type="number"
                    value={draft.router.budget.perRequestLimit ?? ''}
                    onChange={(e) => updateBudget({ perRequestLimit: e.target.value ? Number(e.target.value) : undefined })}
                  />
                  <p className="text-xs text-rd-textMuted">单次请求 Token 上限，超过会自动截断或降级。留空表示不限制。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="budget-threshold">降级阈值: {draft.router.budget.degradationThreshold.toFixed(2)}</Label>
                  <input
                    id="budget-threshold"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={draft.router.budget.degradationThreshold}
                    onChange={(e) => updateBudget({ degradationThreshold: Number(e.target.value) })}
                    className="mt-2 w-full accent-rd-primary"
                  />
                  <p className="text-xs text-rd-textMuted">日用量达到此比例时开始降级到更便宜的模型。0.8 表示用到 80% 时触发。</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>路由规则</CardTitle>
              <CardDescription>把任务等级映射到具体模型</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {draft.router.rules.length === 0 ? (
                <div className="rounded-lg border border-dashed border-rd-border bg-rd-surface p-4 text-center text-sm text-rd-textMuted">
                  暂无规则，点击下方按钮添加
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-rd-border">
                  {/* 列宽分配：任务等级 3 / 主选模型 8 / 操作 1 */}
                  <div className="grid grid-cols-12 gap-2 border-b border-rd-border bg-rd-surface px-3 py-2 text-xs font-semibold text-rd-textMuted">
                    <div className="col-span-3">任务等级</div>
                    <div className="col-span-8">主选模型</div>
                    <div className="col-span-1 text-right">操作</div>
                  </div>
                  <div className="divide-y divide-rd-border">
                    {draft.router.rules.map((rule, idx) => (
                      <div key={idx} className="grid grid-cols-12 items-center gap-2 px-3 py-2">
                        <Select
                          value={rule.tier}
                          onChange={(e) => updateRule(idx, { tier: e.target.value as RouterRule['tier'] })}
                          className="col-span-3"
                        >
                          <SelectItem value="simple">simple</SelectItem>
                          <SelectItem value="medium">medium</SelectItem>
                          <SelectItem value="complex">complex</SelectItem>
                          <SelectItem value="reasoning">reasoning</SelectItem>
                        </Select>
                        {/* 主选模型：下拉选择已配置的模型，避免填写 unconfigured 或不存在的模型 ID */}
                        <Select
                          value={rule.modelId}
                          onChange={(e) => updateRule(idx, { modelId: e.target.value })}
                          className="col-span-8"
                        >
                          {draft.providers.flatMap((p) => p.models).length === 0 ? (
                            <SelectItem value={rule.modelId || 'unconfigured'}>未配置任何模型</SelectItem>
                          ) : (
                            draft.providers.flatMap((p) => p.models).map((m) => (
                              <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                            ))
                          )}
                        </Select>
                        <div className="col-span-1 flex justify-end">
                          <Button
                            variant="outline"
                            size="icon"
                            className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                            onClick={() => removeRule(idx)}
                          >
                            <Trash2 size={16} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <Button onClick={addRule} className="w-full">
                <Plus size={16} /> 添加路由规则
              </Button>
            </CardContent>
          </Card>

          {/* 全局降级模型链：一旦有模型失效，按顺序换成此列表中的模型 */}
          <Card>
            <CardHeader>
              <CardTitle>降级模型链</CardTitle>
              <CardDescription>
                一旦有模型失效（API 错误、超时等），按顺序换成下方模型。优先级从上到下递减。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(draft.router.fallbackChain ?? []).length === 0 ? (
                <div className="rounded-lg border border-dashed border-rd-border bg-rd-surface p-4 text-center text-sm text-rd-textMuted">
                  暂无降级模型，点击下方按钮添加
                </div>
              ) : (
                <div className="space-y-2">
                  {(draft.router.fallbackChain ?? []).map((modelId, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rd-primary/10 text-xs font-semibold text-rd-primary">
                        {idx + 1}
                      </span>
                      <Select
                        value={modelId}
                        onChange={(e) => {
                          const chain = [...(draft.router.fallbackChain ?? [])];
                          chain[idx] = e.target.value;
                          updateDraft({ router: { ...draft.router, fallbackChain: chain } });
                        }}
                        className="flex-1"
                      >
                        {draft.providers.flatMap((p) => p.models).length === 0 ? (
                          <SelectItem value={modelId}>未配置任何模型</SelectItem>
                        ) : (
                          draft.providers.flatMap((p) => p.models).map((m) => (
                            <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                          ))
                        )}
                      </Select>
                      <Button
                        variant="outline"
                        size="icon"
                        className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                        onClick={() => {
                          const chain = (draft.router.fallbackChain ?? []).filter((_, i) => i !== idx);
                          updateDraft({ router: { ...draft.router, fallbackChain: chain } });
                        }}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  const chain = [...(draft.router.fallbackChain ?? []), ''];
                  updateDraft({ router: { ...draft.router, fallbackChain: chain } });
                }}
              >
                <Plus size={16} /> 添加降级模型
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== 安全设置 ===== */}
      {activeTab === 'security' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
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
                      onChange={(e) => updateWebSearch({ [engine.keyField]: e.target.value } as Partial<{ glmApiKey: string; metasoApiKey: string; baiduApiKey: string; tavilyApiKey: string; bingApiKey: string; perplexityApiKey: string; exaApiKey: string; braveApiKey: string; searxngEndpoint: string; }>)}
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
                审批级决定是否每次询问用户。两项已通过 app-init 接线到 PermissionEngine。
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
      )}

      {/* ===== 命令与工具黑白名单 ===== */}
      {activeTab === 'commands' && (
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
        </div>
      )}

      {/* ===== 可观测性 ===== */}
      {activeTab === 'optimization' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          <Card>
            <CardHeader>
              <CardTitle>Token 追踪</CardTitle>
              <CardDescription>分组件 Token 估算与会话快照</CardDescription>
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
              <CardDescription>先读后写、工具输出截断、独立验证门等防护机制</CardDescription>
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
              <CardDescription>让 AI 回答像电报，不是作文——输出纪律 + 工具结果裁剪</CardDescription>
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
              <CardDescription>自定义模板目录、项目级覆盖与缓存策略</CardDescription>
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
      )}

      {/* ===== 执行配置（并发 / 熔断 / 检查点提示） ===== */}
      {activeTab === 'execution' && (
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
      )}

      {/* ===== 记忆与检查点 ===== */}
      {activeTab === 'memory' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          <Card>
            <CardHeader>
              <CardTitle>增量 Checkpoint</CardTitle>
              <CardDescription>按步骤自动压缩与恢复记忆</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="checkpoint-enabled">启用 Checkpoint</Label>
                  <p className="text-xs text-rd-textMuted">定期压缩对话历史为摘要，避免长对话超出上下文窗口导致遗忘。</p>
                </div>
                <Switch
                  id="checkpoint-enabled"
                  checked={draft.checkpoint.enabled}
                  onCheckedChange={(checked) => updateCheckpoint({ enabled: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="checkpoint-model">Checkpoint 模型</Label>
                {/* 从已配置的模型中选择，留空则用路由默认模型 */}
                <Select
                  id="checkpoint-model"
                  value={draft.checkpoint.modelId}
                  onChange={(e) => updateCheckpoint({ modelId: e.target.value })}
                >
                  <SelectItem value="">跟随路由默认</SelectItem>
                  {draft.providers.flatMap((p) => p.models).map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                  ))}
                </Select>
                <p className="text-xs text-rd-textMuted">执行压缩摘要的模型，建议用便宜模型。留空则用路由默认模型。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="checkpoint-max">单次 Checkpoint 最大 Token</Label>
                <Input
                  id="checkpoint-max"
                  type="number"
                  value={draft.checkpoint.maxTokensPerCheckpoint}
                  onChange={(e) => updateCheckpoint({ maxTokensPerCheckpoint: Number(e.target.value) })}
                />
                <p className="text-xs text-rd-textMuted">每次压缩生成的摘要最大长度，过小可能丢失细节，过大增加成本。</p>
              </div>

              {/* Phase 33 Task 3.3：Checkpoint 触发器编辑 */}
              <div className="space-y-2">
                <Label>触发器（上下文使用率达到指定百分比时触发对应动作）</Label>
                {draft.checkpoint.triggers.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-rd-border bg-rd-surface p-3 text-center text-sm text-rd-textMuted">
                    暂无触发器
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-rd-border">
                    <div className="grid grid-cols-12 gap-2 border-b border-rd-border bg-rd-surface px-3 py-2 text-xs font-semibold text-rd-textMuted">
                      <div className="col-span-4">使用率 (%)</div>
                      <div className="col-span-6">动作</div>
                      <div className="col-span-2 text-right">操作</div>
                    </div>
                    <div className="divide-y divide-rd-border">
                      {draft.checkpoint.triggers.map((trigger, tIdx) => (
                        <div key={tIdx} className="grid grid-cols-12 items-center gap-2 px-3 py-2">
                          <Input
                            type="number"
                            min={1}
                            max={100}
                            value={trigger.level}
                            onChange={(e) => updateCheckpointTrigger(tIdx, { level: Number(e.target.value) })}
                            className="col-span-4"
                          />
                          <Select
                            value={trigger.action}
                            onChange={(e) => updateCheckpointTrigger(tIdx, { action: e.target.value as 'initial' | 'incremental' | 'compress' })}
                            className="col-span-6"
                          >
                            <SelectItem value="initial">initial（初始摘要）</SelectItem>
                            <SelectItem value="incremental">incremental（增量摘要）</SelectItem>
                            <SelectItem value="compress">compress（全量压缩）</SelectItem>
                          </Select>
                          <div className="col-span-2 flex justify-end">
                            <Button
                              variant="outline"
                              size="icon"
                              className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                              onClick={() => removeCheckpointTrigger(tIdx)}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <Button variant="outline" size="sm" onClick={addCheckpointTrigger}>
                  <Plus size={14} /> 添加触发器
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Phase 33 Task 3.1：目标验证器配置 */}
          <Card>
            <CardHeader>
              <CardTitle>目标验证器</CardTitle>
              <CardDescription>/goal 完成后的独立验证，判断目标是否真正达成</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="gv-enabled">启用目标验证</Label>
                  <p className="text-xs text-rd-textMuted">任务完成后由独立 LLM 验证目标是否达成，不信任 Agent 的"已完成"判断。</p>
                </div>
                <Switch
                  id="gv-enabled"
                  checked={draft.goalVerifier.enabled}
                  onCheckedChange={(checked) => updateGoalVerifier({ enabled: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="gv-model">验证模型</Label>
                {/* 从已配置的模型中选择，留空则跟随路由默认 */}
                <Select
                  id="gv-model"
                  value={draft.goalVerifier.modelId}
                  onChange={(e) => updateGoalVerifier({ modelId: e.target.value })}
                >
                  <SelectItem value="">跟随路由默认</SelectItem>
                  {draft.providers.flatMap((p) => p.models).map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                  ))}
                </Select>
                <p className="text-xs text-rd-textMuted">执行验证的模型，建议用 reasoning 级模型以保证验证质量。留空跟随路由默认。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gv-max-tokens">单次验证最大 Token</Label>
                <Input
                  id="gv-max-tokens"
                  type="number"
                  value={draft.goalVerifier.maxTokensPerVerification}
                  onChange={(e) => updateGoalVerifier({ maxTokensPerVerification: Number(e.target.value) })}
                />
                <p className="text-xs text-rd-textMuted">每次验证消耗的最大 Token 数。</p>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="gv-auto">完成后自动验证</Label>
                  <p className="text-xs text-rd-textMuted">/goal 完成后自动触发验证，关闭则需手动调用验证。</p>
                </div>
                <Switch
                  id="gv-auto"
                  checked={draft.goalVerifier.autoVerify}
                  onCheckedChange={(checked) => updateGoalVerifier({ autoVerify: checked })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="gv-iterative">迭代验证闭环</Label>
                  <p className="text-xs text-rd-textMuted">验证失败时自动生成补救步骤并重新执行，直到目标达成或达到最大迭代次数（借鉴 kimi-code 模式）。</p>
                </div>
                <Switch
                  id="gv-iterative"
                  checked={draft.goalVerifier.iterative?.enabled ?? false}
                  onCheckedChange={(checked) => updateGoalVerifier({ iterative: { ...draft.goalVerifier.iterative, enabled: checked } })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="gv-max-rounds">最大迭代次数</Label>
                <Input
                  id="gv-max-rounds"
                  type="number"
                  min={1}
                  max={10}
                  value={draft.goalVerifier.iterative?.maxRounds ?? 3}
                  onChange={(e) => updateGoalVerifier({ iterative: { ...draft.goalVerifier.iterative, maxRounds: Number(e.target.value) } })}
                />
                <p className="text-xs text-rd-textMuted">验证失败后最多重试的轮数（1-10），超过后停止迭代并标记为失败。</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>项目记忆</CardTitle>
              <CardDescription>跨会话保留项目上下文与决策记录</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="memory-enabled">启用项目记忆</Label>
                  <p className="text-xs text-rd-textMuted">跨会话保留项目的关键上下文与决策记录，新会话自动加载历史记忆。</p>
                </div>
                <Switch
                  id="memory-enabled"
                  checked={draft.projectMemory.enabled}
                  onCheckedChange={(checked) => updateProjectMemory({ enabled: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="memory-size">最大记忆容量</Label>
                <Input
                  id="memory-size"
                  type="number"
                  value={draft.projectMemory.maxMemorySize}
                  onChange={(e) => updateProjectMemory({ maxMemorySize: Number(e.target.value) })}
                />
                <p className="text-xs text-rd-textMuted">项目记忆的最大条目数，超出后自动淘汰最旧的条目。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="memory-decisions">最大决策记录数</Label>
                <Input
                  id="memory-decisions"
                  type="number"
                  value={draft.projectMemory.maxDecisions}
                  onChange={(e) => updateProjectMemory({ maxDecisions: Number(e.target.value) })}
                />
                <p className="text-xs text-rd-textMuted">保留的关键决策记录数量，用于回溯为何做了某个选择。</p>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="memory-inject">自动注入上下文</Label>
                  <p className="text-xs text-rd-textMuted">新会话开始时自动将项目记忆注入到系统提示词，无需手动引用。</p>
                </div>
                <Switch
                  id="memory-inject"
                  checked={draft.projectMemory.autoInject}
                  onCheckedChange={(checked) => updateProjectMemory({ autoInject: checked })}
                />
              </div>
            </CardContent>
          </Card>

          {/* Phase 45：记忆推理与注入 */}
          <Card>
            <CardHeader>
              <CardTitle>记忆推理</CardTitle>
              <CardDescription>控制长期记忆的推理、学习与注入阈值</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="memory-inference">启用记忆推理</Label>
                  <p className="text-xs text-rd-textMuted">根据当前对话自动检索并推理相关记忆。</p>
                </div>
                <Switch
                  id="memory-inference"
                  checked={draft.memory.inference}
                  onCheckedChange={(checked) => updateMemory({ inference: checked })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="memory-auto-learn">启用自动学习</Label>
                  <p className="text-xs text-rd-textMuted">自动从对话中抽取事实与偏好并写入记忆。</p>
                </div>
                <Switch
                  id="memory-auto-learn"
                  checked={draft.memory.autoLearn}
                  onCheckedChange={(checked) => updateMemory({ autoLearn: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="memory-inject-threshold">注入阈值</Label>
                <Input
                  id="memory-inject-threshold"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.memory.injectThreshold}
                  onChange={(e) => updateMemory({ injectThreshold: Number(e.target.value) })}
                />
                <p className="text-xs text-rd-textMuted">记忆与当前对话相关度达到此值才注入（0-1）。</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== 插件与 MCP ===== */}
      {activeTab === 'mcp' && (
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
                      {installModal.requiredEnv!.map((key) => (
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
                      {installModal.requiredHeaders!.map((key) => (
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
      )}

      {/* ===== Phase 37：Skill 技能管理 ===== */}
      {activeTab === 'skills' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          {/* 说明卡片 */}
          <Card>
            <CardContent className="flex items-start justify-between gap-4 py-6">
              <div className="flex items-start gap-3">
                <BookOpen size={20} className="mt-0.5 shrink-0 text-rd-primary" />
                <div>
                  <Label>Skill 技能系统</Label>
                  <p className="text-xs text-rd-textMuted mt-1">
                    Skill 是按需加载的 Markdown 程序，框架根据任务描述自动匹配并注入相关 Skill 内容到上下文。
                    只有匹配的 Skill 才会消耗 token，未匹配的不会影响上下文预算。
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={handleSkillReload} disabled={skillLoading}>
                <RefreshCw size={14} className={skillLoading ? 'animate-spin' : ''} />
                重新发现
              </Button>
            </CardContent>
          </Card>

          {/* Skill 列表 */}
          {skills.length === 0 && !skillLoading && (
            <Card>
              <CardContent className="py-12 text-center">
                <BookOpen size={32} className="mx-auto mb-3 text-rd-textSubtle" />
                <p className="text-sm text-rd-textMuted">
                  未发现任何 Skill。Skill 文件约定放在 <code className="rounded bg-rd-surfaceHover px-1.5 py-0.5 text-xs">.routedev/skills/&lt;name&gt;/SKILL.md</code>
                </p>
              </CardContent>
            </Card>
          )}

          {skills.map((skill) => (
            <Card key={skill.name}>
              <CardContent className="py-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-semibold text-rd-text">{skill.name}</span>
                      <Badge variant={skill.enabled ? 'primary' : 'outline'}>
                        {skill.enabled ? '已启用' : '已禁用'}
                      </Badge>
                    </div>
                    <p className="text-sm text-rd-textMuted line-clamp-2">{skill.description}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {skill.routingKeywords.slice(0, 8).map((kw) => (
                        <span key={kw} className="rounded-md bg-rd-surfaceHover px-2 py-0.5 text-xs text-rd-textSubtle">
                          {kw}
                        </span>
                      ))}
                      {skill.routingKeywords.length > 8 && (
                        <span className="text-xs text-rd-textSubtle">+{skill.routingKeywords.length - 8}</span>
                      )}
                    </div>
                    <p className="text-xs text-rd-textSubtle font-mono truncate">{skill.sourcePath}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <Switch
                      checked={skill.enabled}
                      onCheckedChange={(checked) => handleSkillToggle(skill.name, checked)}
                    />
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => handleSkillPreview(skill.name)}>
                        <Eye size={14} /> 预览
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                        onClick={() => handleSkillDelete(skill.name)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          {/* 路由测试 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles size={16} className="text-rd-primary" />
                Skill 路由测试
              </CardTitle>
              <CardDescription>输入任务描述，查看哪些 Skill 会被自动匹配</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  placeholder="例如：实现一个新的用户认证功能"
                  value={skillRouteTest?.query ?? ''}
                  onChange={(e) => setSkillRouteTest({ query: e.target.value, results: skillRouteTest?.results ?? [] })}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSkillRouteTest(); }}
                />
                <Button onClick={handleSkillRouteTest} disabled={!skillRouteTest?.query.trim()}>
                  测试
                </Button>
              </div>
              {skillRouteTest?.results && skillRouteTest.results.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-rd-textMuted">匹配到 {skillRouteTest.results.length} 个 Skill：</p>
                  {skillRouteTest.results.map((s) => (
                    <div key={s.name} className="flex items-center gap-2 rounded-lg bg-rd-surfaceHover px-3 py-2">
                      <Badge variant="primary">{s.name}</Badge>
                      <span className="text-xs text-rd-textMuted truncate">{s.description}</span>
                    </div>
                  ))}
                </div>
              )}
              {skillRouteTest?.results && skillRouteTest.results.length === 0 && (
                <p className="text-xs text-rd-textMuted">无匹配的 Skill</p>
              )}
            </CardContent>
          </Card>

          {/* 创建 Skill 表单 */}
          {skillForm === null && skillAiForm === null ? (
            <div className="flex gap-2">
              <Button
                onClick={() => setSkillForm({ name: '', description: '', keywords: '', content: '' })}
                className="flex-1"
              >
                <Plus size={16} /> 创建新 Skill
              </Button>
              <Button
                variant="outline"
                onClick={() => setSkillAiForm({ description: '', generating: false, generated: null })}
                className="flex-1"
              >
                <Wand2 size={16} /> AI 生成 Skill
              </Button>
              <Button
                variant="outline"
                onClick={() => setAlertMsg('从代码学习功能由其他子代理负责实现，敬请期待')}
                className="flex-1"
              >
                <Code size={16} /> 从代码学习
              </Button>
            </div>
          ) : null}

          {/* Phase 39：Skill AI 自动生成对话框 */}
          {skillAiForm !== null && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wand2 size={16} className="text-rd-primary" />
                  AI 自动生成 Skill
                </CardTitle>
                <CardDescription>
                  输入自然语言描述，AI 将自动生成 Skill 内容
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="skill-ai-desc">描述你想要的 Skill</Label>
                  <textarea
                    id="skill-ai-desc"
                    className="w-full rounded-md border border-rd-border bg-rd-background px-3 py-2 text-sm text-rd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40 focus-visible:border-rd-primary/70"
                    rows={4}
                    value={skillAiForm.description}
                    onChange={(e) => setSkillAiForm({ ...skillAiForm, description: e.target.value })}
                    placeholder="例如：当用户要求实现 REST API 时，自动遵循项目的控制器-服务-仓库分层模式"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleSkillAiGenerate}
                    disabled={!skillAiForm.description.trim() || skillAiForm.generating}
                  >
                    {skillAiForm.generating ? <RefreshCw size={16} className="animate-spin" /> : <Wand2 size={16} />}
                    生成 Skill
                  </Button>
                  <Button variant="ghost" onClick={() => setSkillAiForm(null)}>
                    <X size={16} /> 取消
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {skillForm !== null && (
            <Card>
              <CardHeader>
                <CardTitle>创建新 Skill</CardTitle>
                <CardDescription>
                  Skill 文件将创建在 <code className="text-xs">.routedev/skills/&lt;name&gt;/SKILL.md</code>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="skill-form-name">名称（仅字母、数字、连字符）</Label>
                    <Input
                      id="skill-form-name"
                      value={skillForm.name}
                      onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })}
                      placeholder="例如 my-skill"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="skill-form-desc">描述（作为路由提示）</Label>
                    <Input
                      id="skill-form-desc"
                      value={skillForm.description}
                      onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })}
                      placeholder="当用户...时使用此 Skill"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="skill-form-keywords">路由关键词（逗号分隔）</Label>
                  <Input
                    id="skill-form-keywords"
                    value={skillForm.keywords}
                    onChange={(e) => setSkillForm({ ...skillForm, keywords: e.target.value })}
                    placeholder="关键词1, 关键词2, keyword3"
                  />
                  <p className="text-xs text-rd-textMuted">任务描述包含这些关键词时触发匹配，每个关键词 +10 分</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="skill-form-content">Skill 内容（Markdown）</Label>
                  <textarea
                    id="skill-form-content"
                    className="w-full rounded-md border border-rd-border bg-rd-background px-3 py-2 text-sm text-rd-text font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40 focus-visible:border-rd-primary/70"
                    rows={10}
                    value={skillForm.content}
                    onChange={(e) => setSkillForm({ ...skillForm, content: e.target.value })}
                    placeholder="# Skill 标题&#10;&#10;Skill 的具体指令内容..."
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleSkillCreate}
                    disabled={!skillForm.name || !skillForm.description}
                  >
                    <Plus size={16} /> 创建
                  </Button>
                  <Button variant="ghost" onClick={() => setSkillForm(null)}>
                    <X size={16} /> 取消
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Skill 预览模态 */}
      {skillPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setSkillPreview(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-rd-background shadow-rdLg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-rd-border px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold text-rd-text">{skillPreview.name}</h2>
                <p className="text-xs text-rd-textMuted">{skillPreview.sourcePath}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSkillPreview(null)}>
                <X size={18} />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div className="mb-4 space-y-2">
                <div>
                  <span className="text-xs font-semibold text-rd-textSubtle">描述</span>
                  <p className="text-sm text-rd-text mt-0.5">{skillPreview.description}</p>
                </div>
                <div>
                  <span className="text-xs font-semibold text-rd-textSubtle">关键词</span>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    {skillPreview.routingKeywords.map((kw) => (
                      <span key={kw} className="rounded-md bg-rd-surfaceHover px-2 py-0.5 text-xs text-rd-textSubtle">
                        {kw}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <span className="text-xs font-semibold text-rd-textSubtle">内容</span>
                <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-rd-surfaceHover p-4 text-sm text-rd-text font-mono">
                  {skillPreview.content}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== 渠道集成 ===== */}
      {activeTab === 'channels' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          <Card>
            <CardHeader>
              <CardTitle>渠道服务</CardTitle>
              <CardDescription>Webhook 服务端口与响应限制</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="channel-port">端口</Label>
                  <Input
                    id="channel-port"
                    type="number"
                    value={draft.channels.port}
                    onChange={(e) => updateChannels({ port: Number(e.target.value) })}
                  />
                  <p className="text-xs text-rd-textMuted">Webhook 服务监听的本地端口，外部渠道通过此端口推送消息。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="channel-public">公开 URL</Label>
                  <Input
                    id="channel-public"
                    value={draft.channels.publicUrl ?? ''}
                    onChange={(e) => updateChannels({ publicUrl: e.target.value || undefined })}
                  />
                  <p className="text-xs text-rd-textMuted">对外暴露的回调地址（如内网穿透后的公网 URL），用于注册到第三方渠道。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="channel-max">最大响应长度</Label>
                  <Input
                    id="channel-max"
                    type="number"
                    value={draft.channels.maxResponseLength}
                    onChange={(e) => updateChannels({ maxResponseLength: Number(e.target.value) })}
                  />
                  <p className="text-xs text-rd-textMuted">单条渠道消息回复的最大字符数，超出会截断。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="channel-timeout">请求超时（毫秒）</Label>
                  <Input
                    id="channel-timeout"
                    type="number"
                    value={draft.channels.requestTimeout}
                    onChange={(e) => updateChannels({ requestTimeout: Number(e.target.value) })}
                  />
                  <p className="text-xs text-rd-textMuted">等待 Agent 处理渠道消息的最长时间，超时后返回错误。</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {draft.channels.entries.map((entry, idx) => (
            <Card key={idx}>
              <CardContent className="py-6">
                <div className="flex items-center justify-between gap-4">
                  <div className="grid flex-1 grid-cols-2 gap-4 md:grid-cols-3">
                    <div className="space-y-1">
                      <div className="text-xs text-rd-textMuted">ID</div>
                      <div className="text-sm font-medium text-rd-text">{entry.id}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-rd-textMuted">类型</div>
                      <Badge variant="outline">{entry.type}</Badge>
                    </div>
                    <div className="flex items-center justify-between gap-2 md:justify-start">
                      <Label htmlFor={`channel-enabled-${idx}`}>启用</Label>
                      <Switch
                        id={`channel-enabled-${idx}`}
                        checked={entry.enabled}
                        onCheckedChange={(checked) => {
                          const entries = [...draft.channels.entries];
                          entries[idx] = { ...entry, enabled: checked };
                          updateChannels({ entries });
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (editingChannelIdx === idx) {
                          setEditingChannelIdx(null);
                          setChannelCreds({});
                        } else {
                          // 预填现有 options 值
                          const creds: Record<string, string> = {};
                          for (const field of getChannelOptionFields(entry.type)) {
                            creds[field.key] = entry.options[field.key] ?? '';
                          }
                          setChannelCreds(creds);
                          setEditingChannelIdx(idx);
                        }
                      }}
                    >
                      {editingChannelIdx === idx ? '收起' : '编辑凭据'}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                      onClick={() => removeChannel(idx)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>

                {/* 渠道凭据编辑区域（展开时显示） */}
                {editingChannelIdx === idx && (
                  <div className="mt-4 space-y-3 border-t border-rd-border pt-4">
                    {getChannelOptionFields(entry.type).map((field) => (
                      <div key={field.key} className="space-y-1">
                        <Label htmlFor={`ch-edit-${idx}-${field.key}`}>
                          {field.label}
                          {field.required && <span className="ml-1 text-rd-danger">*</span>}
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            id={`ch-edit-${idx}-${field.key}`}
                            type={field.sensitive && !showChannelCreds[`${idx}-${field.key}`] ? 'password' : 'text'}
                            value={channelCreds[field.key] ?? ''}
                            onChange={(e) => setChannelCreds({ ...channelCreds, [field.key]: e.target.value })}
                            placeholder={field.sensitive ? '支持 ${ENV_VAR} 环境变量引用' : ''}
                          />
                          {field.sensitive && (
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={() => setShowChannelCreds({ ...showChannelCreds, [`${idx}-${field.key}`]: !showChannelCreds[`${idx}-${field.key}`] })}
                              title={showChannelCreds[`${idx}-${field.key}`] ? '隐藏' : '显示'}
                            >
                              {showChannelCreds[`${idx}-${field.key}`] ? <EyeOff size={16} /> : <Eye size={16} />}
                            </Button>
                          )}
                        </div>
                        <p className="text-xs text-rd-textMuted">{field.hint}</p>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => saveChannelOptions(idx)}>
                        保存凭据
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setEditingChannelIdx(null); setChannelCreds({}); }}>
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          {showAddChannel ? (
            <Card>
              <CardHeader>
                <CardTitle>新增渠道</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="channel-new-id">ID</Label>
                    <Input
                      id="channel-new-id"
                      value={newChannel.id}
                      onChange={(e) => setNewChannel({ ...newChannel, id: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="channel-new-type">类型</Label>
                    <Select
                      id="channel-new-type"
                      value={newChannel.type}
                      onChange={(e) => {
                        const type = e.target.value as ChannelType;
                        setNewChannel({ ...newChannel, type });
                        // 切换类型时清空凭据
                        setChannelCreds({});
                      }}
                    >
                      <SelectItem value="wechat-work">企业微信</SelectItem>
                      <SelectItem value="telegram">Telegram</SelectItem>
                      <SelectItem value="slack">Slack</SelectItem>
                      {/* Discord 适配器尚未实现，暂不显示选项 */}
                    </Select>
                    <p className="text-xs text-rd-textMuted">Discord 适配器开发中，暂不可选。</p>
                  </div>
                </div>

                {/* 动态渲染渠道凭据字段 */}
                {getChannelOptionFields(newChannel.type).map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={`ch-new-${field.key}`}>
                      {field.label}
                      {field.required && <span className="ml-1 text-rd-danger">*</span>}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id={`ch-new-${field.key}`}
                        type={field.sensitive && !showChannelCreds[`new-${field.key}`] ? 'password' : 'text'}
                        value={channelCreds[field.key] ?? ''}
                        onChange={(e) => setChannelCreds({ ...channelCreds, [field.key]: e.target.value })}
                        placeholder={field.sensitive ? '支持 ${ENV_VAR} 环境变量引用' : ''}
                      />
                      {field.sensitive && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setShowChannelCreds({ ...showChannelCreds, [`new-${field.key}`]: !showChannelCreds[`new-${field.key}`] })}
                          title={showChannelCreds[`new-${field.key}`] ? '隐藏' : '显示'}
                        >
                          {showChannelCreds[`new-${field.key}`] ? <EyeOff size={16} /> : <Eye size={16} />}
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-rd-textMuted">{field.hint}</p>
                  </div>
                ))}

                <div className="flex items-center gap-2">
                  <Button onClick={addChannel} disabled={!newChannel.id}>
                    <Plus size={16} /> 添加
                  </Button>
                  <Button variant="ghost" onClick={() => { setShowAddChannel(false); setChannelCreds({}); }}>
                    <X size={16} /> 取消
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Button onClick={() => { setShowAddChannel(true); setChannelCreds({}); }} className="w-full">
              <Plus size={16} /> 添加渠道
            </Button>
          )}
        </div>
      )}

      {/* ===== 外观 ===== */}
      {activeTab === 'appearance' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          <Card>
            <CardHeader>
              <CardTitle>主题配色</CardTitle>
              <CardDescription>选择应用的整体配色方案（黑白灰蓝）</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {([
                  { id: 'white', label: '白色', bg: '#ffffff', fg: '#0f172a', border: '#e2e8f0' },
                  { id: 'black', label: '黑色', bg: '#0a0a0a', fg: '#fafafa', border: '#2a2a2a' },
                  { id: 'gray', label: '灰色', bg: '#1f2937', fg: '#f3f4f6', border: '#374151' },
                  { id: 'blue', label: '蓝色', bg: '#0c1a2e', fg: '#e0f2fe', border: '#1e3a5f' },
                ] as const).map((theme) => {
                  const active = draft.general.appearanceTheme === theme.id;
                  return (
                    <button
                      key={theme.id}
                      onClick={() => updateGeneral({ appearanceTheme: theme.id })}
                      className={[
                        'flex flex-col items-center gap-2 rounded-lg p-3 transition',
                        active ? 'ring-2 ring-rd-primary/40' : 'hover:bg-rd-surfaceHover',
                      ].join(' ')}
                    >
                      <div
                        className="flex h-16 w-full items-center justify-center rounded text-sm font-medium"
                        style={{ backgroundColor: theme.bg, color: theme.fg, border: `1px solid ${theme.border}` }}
                      >
                        {theme.label}
                      </div>
                      <span className="text-xs text-rd-textMuted">{theme.label}主题</span>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* 主题色（accent color）选择器 */}
          <Card>
            <CardHeader>
              <CardTitle>主题色</CardTitle>
              <CardDescription>自定义应用的主色调（按钮、选中态、聚焦框等）。默认紫色，可选预设色或自定义。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-3">
                {/* 预设色块 */}
                {([
                  { color: '#8b8dff', label: '紫色' },
                  { color: '#6366f1', label: '靛蓝' },
                  { color: '#3b82f6', label: '蓝色' },
                  { color: '#10b981', label: '绿色' },
                  { color: '#f59e0b', label: '橙色' },
                  { color: '#ef4444', label: '红色' },
                  { color: '#ec4899', label: '粉色' },
                  { color: '#14b8a6', label: '青色' },
                ] as const).map((preset) => {
                  const active = (draft.general.accentColor || '#8b8dff') === preset.color;
                  return (
                    <button
                      key={preset.color}
                      onClick={() => updateGeneral({ accentColor: preset.color })}
                      className={`flex flex-col items-center gap-1.5 rounded-lg p-2 transition ${
                        active ? 'ring-2 ring-offset-2 ring-offset-rd-surface' : 'hover:bg-rd-surfaceHover'
                      }`}
                      style={active ? { boxShadow: `0 0 0 2px ${preset.color}` } : undefined}
                      title={preset.label}
                    >
                      <div
                        className="h-8 w-8 rounded-full"
                        style={{ backgroundColor: preset.color }}
                      />
                      <span className="text-[10px] text-rd-textMuted">{preset.label}</span>
                    </button>
                  );
                })}
              </div>
              {/* 自定义颜色选择器 */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-rd-textMuted">自定义：</label>
                <input
                  type="color"
                  value={draft.general.accentColor || '#8b8dff'}
                  onChange={(e) => updateGeneral({ accentColor: e.target.value })}
                  className="h-8 w-12 cursor-pointer rounded border border-rd-border bg-transparent"
                />
                <Input
                  value={draft.general.accentColor}
                  onChange={(e) => updateGeneral({ accentColor: e.target.value })}
                  placeholder="#8b8dff（留空用预设）"
                  className="w-40"
                />
                {draft.general.accentColor && (
                  <button
                    onClick={() => updateGeneral({ accentColor: '' })}
                    className="text-xs text-rd-textMuted hover:text-rd-text"
                  >
                    重置
                  </button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>字体大小</CardTitle>
              <CardDescription>全局基准字号（{draft.general.fontSize}px）</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <input
                  type="range"
                  min="12"
                  max="24"
                  step="1"
                  value={draft.general.fontSize}
                  onChange={(e) => updateGeneral({ fontSize: Number(e.target.value) })}
                  className="w-full accent-rd-primary"
                />
                <div className="flex justify-between text-xs text-rd-textMuted">
                  <span>12px</span>
                  <span>14px</span>
                  <span>16px</span>
                  <span>18px</span>
                  <span>20px</span>
                  <span>22px</span>
                  <span>24px</span>
                </div>
              </div>
              <div className="rounded-lg bg-rd-surfaceHover p-3">
                <span className="text-rd-text" style={{ fontSize: `${draft.general.fontSize}px` }}>
                  预览：这是一段示例文字，字号 {draft.general.fontSize}px
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>UI 提示</CardTitle>
              <CardDescription>配置变更时的界面提示开关</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="ui-hot-reload-notify">配置热重载提示</Label>
                  <p className="text-xs text-rd-textMuted">开启后配置变更并热重载时在右下角显示短暂提示。</p>
                </div>
                <Switch
                  id="ui-hot-reload-notify"
                  checked={draft.ui.hotReloadNotify}
                  onCheckedChange={(checked) => updateUi({ hotReloadNotify: checked })}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>通用</CardTitle>
              <CardDescription>语言与启动行为</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="general-language">语言</Label>
                <Select
                  id="general-language"
                  value={draft.general.language}
                  onChange={(e) => updateGeneral({ language: e.target.value as 'zh-CN' | 'en-US' })}
                >
                  <SelectItem value="zh-CN">简体中文</SelectItem>
                  <SelectItem value="en-US">English</SelectItem>
                </Select>
                <p className="text-xs text-rd-textMuted">界面与系统提示词的语言。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="general-startup">启动行为</Label>
                <Select
                  id="general-startup"
                  value={draft.general.startupBehavior}
                  onChange={(e) => updateGeneral({ startupBehavior: e.target.value as 'restore' | 'project_select' })}
                >
                  <SelectItem value="restore">恢复上次会话</SelectItem>
                  <SelectItem value="project_select">显示项目选择器</SelectItem>
                </Select>
                <p className="text-xs text-rd-textMuted">应用启动时直接恢复上次对话，或弹出项目选择器让用户选择。</p>
              </div>

              {/* 退出行为设置 */}
              <div className="space-y-2">
                <Label htmlFor="bg-behavior">关闭窗口时</Label>
                <Select
                  id="bg-behavior"
                  value={draft.general.backgroundBehavior.backgroundBehavior}
                  onChange={(e) => {
                    const val = e.target.value as 'exit' | 'minimize-to-tray' | 'ask';
                    // exit 模式下 activeTaskOnClose 必须为 terminate
                    if (val === 'exit') {
                      updateBackgroundBehavior({ backgroundBehavior: val, activeTaskOnClose: 'terminate' });
                    } else {
                      updateBackgroundBehavior({ backgroundBehavior: val });
                    }
                  }}
                >
                  <SelectItem value="exit">直接退出（杀掉后台进程）</SelectItem>
                  <SelectItem value="minimize-to-tray">最小化到托盘</SelectItem>
                  <SelectItem value="ask">每次询问</SelectItem>
                </Select>
                <p className="text-xs text-rd-textMuted">默认退出时杀掉所有后台进程（包括 LLM 请求和 MCP 连接），避免文件锁冲突。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bg-active-task">有活跃任务时</Label>
                <Select
                  id="bg-active-task"
                  value={draft.general.backgroundBehavior.activeTaskOnClose}
                  onChange={(e) => updateBackgroundBehavior({ activeTaskOnClose: e.target.value as 'terminate' | 'continue-in-background' | 'prompt' })}
                  disabled={draft.general.backgroundBehavior.backgroundBehavior === 'exit'}
                >
                  <SelectItem value="terminate">终止任务</SelectItem>
                  <SelectItem value="continue-in-background">后台继续</SelectItem>
                  <SelectItem value="prompt">提示用户</SelectItem>
                </Select>
                <p className="text-xs text-rd-textMuted">关闭时有正在执行的任务时的处理方式。退出模式下自动终止。</p>
              </div>

              {/* Phase 33 Task 3.1：更新策略 */}
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="updates-check">启动时检查更新</Label>
                  <p className="text-xs text-rd-textMuted">应用启动时自动检查是否有新版本。</p>
                </div>
                <Switch
                  id="updates-check"
                  checked={draft.updates.checkOnStartup}
                  onCheckedChange={(checked) => updateUpdates({ checkOnStartup: checked })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="updates-auto">自动安装更新</Label>
                  <p className="text-xs text-rd-textMuted">自动下载并安装更新；关闭则仅提示有新版本可用。</p>
                </div>
                <Switch
                  id="updates-auto"
                  checked={draft.updates.autoUpdate}
                  onCheckedChange={(checked) => updateUpdates({ autoUpdate: checked })}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>UI 设置</CardTitle>
              <CardDescription>输出样式、终端提示与空闲提示</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ui-output-style">输出样式</Label>
                <Select
                  id="ui-output-style"
                  value={draft.ui.outputStyle}
                  onChange={(e) => updateUi({ outputStyle: e.target.value as 'minimal' | 'standard' | 'verbose' })}
                >
                  <SelectItem value="minimal">摘要</SelectItem>
                  <SelectItem value="standard">关键细节</SelectItem>
                  <SelectItem value="verbose">完整数据</SelectItem>
                </Select>
                <p className="text-xs text-rd-textMuted">控制 Agent 回复的详细程度。摘要只给结论，关键细节附关键信息，完整数据展示完整原始数据。</p>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="ui-bell">启用终端 Bell 通知</Label>
                  <p className="text-xs text-rd-textMuted">关键事件（如等待审批、任务完成）触发系统提示音。</p>
                </div>
                <Switch
                  id="ui-bell"
                  checked={draft.ui.bell}
                  onCheckedChange={(checked) => updateUi({ bell: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ui-idle">空闲提示触发秒数</Label>
                <Input
                  id="ui-idle"
                  type="number"
                  value={draft.ui.idleHintSeconds}
                  onChange={(e) => updateUi({ idleHintSeconds: Number(e.target.value) })}
                />
                <p className="text-xs text-rd-textMuted">Agent 空闲超过此秒数后显示提示，引导用户继续操作。</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== 提示音 ===== */}
      {activeTab === 'sounds' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          <Card>
            <CardHeader>
              <CardTitle>提示音</CardTitle>
              <CardDescription>为完成、错误与审批事件配置音效</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="sounds-enabled">启用提示音</Label>
                  <p className="text-xs text-rd-textMuted">为关键事件播放音效，关闭后所有事件静默。</p>
                </div>
                <Switch
                  id="sounds-enabled"
                  checked={draft.sounds.enabled}
                  onCheckedChange={(checked) => updateSounds({ enabled: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sounds-completion">完成提示音</Label>
                <Input
                  id="sounds-completion"
                  value={draft.sounds.completion}
                  onChange={(e) => updateSounds({ completion: e.target.value })}
                />
                <p className="text-xs text-rd-textMuted">Agent 完成任务时播放的音效名称。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sounds-error">错误提示音</Label>
                <Input
                  id="sounds-error"
                  value={draft.sounds.error}
                  onChange={(e) => updateSounds({ error: e.target.value })}
                />
                <p className="text-xs text-rd-textMuted">Agent 执行出错时播放的音效名称。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sounds-approval">审批提示音</Label>
                <Input
                  id="sounds-approval"
                  value={draft.sounds.approval}
                  onChange={(e) => updateSounds({ approval: e.target.value })}
                />
                <p className="text-xs text-rd-textMuted">需要用户审批确认时播放的音效名称。</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== Phase 40：用户体验 ===== */}
      {activeTab === 'expertise' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          <Card>
            <CardHeader>
              <CardTitle>经验等级</CardTitle>
              <CardDescription>三级经验等级，控制行为差异化与 System Prompt 注入</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {([
                  { value: 'beginner', label: '初学者', desc: '详细解释每一步，主动提供建议', icon: '🌱' },
                  { value: 'intermediate', label: '中级', desc: '平衡详细度与效率，关键步骤确认', icon: '⚡' },
                  { value: 'expert', label: '专家', desc: '简洁直接，最小化确认打断', icon: '🚀' },
                ] as const).map((opt) => {
                  const active = draft.expertise.level === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => updateExpertise({ level: opt.value })}
                      className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${
                        active
                          ? 'border-rd-primary bg-rd-primary/10 text-rd-text'
                          : 'border-rd-border bg-rd-surface text-rd-textMuted hover:border-rd-primary/40 hover:text-rd-text'
                      }`}
                    >
                      <span className="text-2xl">{opt.icon}</span>
                      <span className="text-base font-medium">{opt.label}</span>
                      <span className="text-xs">{opt.desc}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="expertise-auto-suggest">启用自动建议</Label>
                  <p className="text-xs text-rd-textMuted">根据经验等级自动提供操作建议和提示。</p>
                </div>
                <Switch
                  id="expertise-auto-suggest"
                  checked={draft.expertise.enableAutoSuggestion}
                  onCheckedChange={(checked) => updateExpertise({ enableAutoSuggestion: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="expertise-output-style">输出风格覆盖</Label>
                <Select
                  id="expertise-output-style"
                  value={draft.expertise.outputStyleOverride ?? ''}
                  onChange={(e) => updateExpertise({ outputStyleOverride: e.target.value || null })}
                >
                  <SelectItem value="">不覆盖（跟随全局设置）</SelectItem>
                  <SelectItem value="minimal">简洁</SelectItem>
                  <SelectItem value="standard">详细</SelectItem>
                  <SelectItem value="structured">结构化</SelectItem>
                </Select>
                <p className="text-xs text-rd-textMuted">覆盖全局输出样式，null 表示跟随 UI 输出样式设置。</p>
              </div>
              <div className="space-y-2">
                <Button
                  variant="outline"
                  onClick={() => setShowExpertiseGuide((v) => !v)}
                >
                  <Sparkles size={16} />
                  {showExpertiseGuide ? '收起引导式选择' : '不确定？引导式选择'}
                </Button>
                {showExpertiseGuide && (
                  <div className="space-y-3 rounded-xl border border-rd-border bg-rd-surfaceHover/50 p-4">
                    <p className="text-sm font-medium text-rd-text">回答以下问题，系统会推荐合适的等级：</p>
                    <div className="space-y-2 text-sm text-rd-textMuted">
                      <p>1. 你是否熟悉命令行工具和 Git 操作？</p>
                      <p>2. 你是否能够独立阅读和理解 TypeScript 代码？</p>
                      <p>3. 你是否希望 Agent 在执行前征求你的确认？</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => { updateExpertise({ level: 'beginner' }); setShowExpertiseGuide(false); }}>
                        多数否 → 初学者
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { updateExpertise({ level: 'intermediate' }); setShowExpertiseGuide(false); }}>
                        部分是 → 中级
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => { updateExpertise({ level: 'expert' }); setShowExpertiseGuide(false); }}>
                        多数是 → 专家
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== 归档对话 ===== */}
      {activeTab === 'archived' && (
        <ArchivedConversationsPanel />
      )}

      {/* ===== 关于 ===== */}
      {activeTab === 'about' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          <Card>
            <CardContent className="space-y-6 py-6">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-rd-primary text-rd-primaryForeground">
                  <Server size={24} />
                </div>
                <div>
                  <div className="text-lg font-semibold text-rd-text">RouteDev</div>
                  <div className="text-sm text-rd-textMuted">版本 {APP_VERSION}</div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-rd-text">技术栈</div>
                <div className="flex flex-wrap gap-2">
                  {['Electron', 'React', 'Vite', 'TypeScript'].map((tech) => (
                    <Badge key={tech} variant="secondary">{tech}</Badge>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-rd-text">GitHub</div>
                <a
                  href="https://github.com/routedev/routedev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-rd-primary hover:underline"
                >
                  https://github.com/routedev/routedev
                </a>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-rd-text">配置文件</div>
                <div className="text-sm text-rd-textMuted">
                  配置文件默认存储在用户主目录下的{' '}
                  <code className="rounded bg-rd-surface px-1 py-0.5 text-rd-text">~/.routedev/config.yaml</code>
                  ，修改后会自动保存并热重载。
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== 代码地图（Phase 39） ===== */}
      {activeTab === 'codemap' && (
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

          {/* 内置代码地图卡片 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Code size={16} className="text-rd-primary" />
                内置代码地图
              </CardTitle>
              <CardDescription>零依赖轻量引擎，秒级扫描项目结构</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm text-rd-text">启用内置代码地图</p>
                  <p className="text-xs text-rd-textMuted mt-1">
                    适合小项目，零依赖，秒级扫描。自动注入项目结构到 system prompt。
                  </p>
                </div>
                <Switch
                  checked={draft.codegraph?.enabled !== true}
                  onCheckedChange={(checked) => {
                    // 内置引擎 = codegraph.enabled 为 false 时启用（双轨制：关 CodeGraph 即用内置）
                    updateDraft({ codegraph: { ...draft.codegraph, enabled: !checked } });
                  }}
                />
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
      )}

      {/* ===== 策略引擎（Phase 42） ===== */}
      {activeTab === 'policies' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          {/* 说明卡片 */}
          <Card>
            <CardContent className="flex items-start justify-between gap-4 py-6">
              <div className="flex items-start gap-3">
                <Shield size={20} className="mt-0.5 shrink-0 text-rd-primary" />
                <div>
                  <Label>策略引擎</Label>
                  <p className="text-xs text-rd-textMuted mt-1">
                    Intent Guard + Playbook + Tool Guide + Tool Approval 四层策略，控制 Agent 行为边界与工具审批。
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 策略开关卡片 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield size={16} className="text-rd-primary" />
                策略开关
              </CardTitle>
              <CardDescription>控制各策略层的启用状态</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm text-rd-text">启用策略引擎</p>
                  <p className="text-xs text-rd-textMuted mt-1">总开关，关闭后所有策略层均不生效。</p>
                </div>
                <Switch
                  checked={draft.policies?.enabled !== false}
                  onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, enabled: checked } })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm text-rd-text">意图护栏（Intent Guard）</p>
                  <p className="text-xs text-rd-textMuted mt-1">检测危险意图并阻止执行。</p>
                </div>
                <Switch
                  checked={draft.policies?.intentGuard !== false}
                  onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, intentGuard: checked } })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm text-rd-text">SOP 注入（Playbook）</p>
                  <p className="text-xs text-rd-textMuted mt-1">根据意图注入标准操作流程。</p>
                </div>
                <Switch
                  checked={draft.policies?.playbook !== false}
                  onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, playbook: checked } })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm text-rd-text">工具增强（Tool Guide）</p>
                  <p className="text-xs text-rd-textMuted mt-1">为工具调用注入使用指南。</p>
                </div>
                <Switch
                  checked={draft.policies?.toolGuide !== false}
                  onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, toolGuide: checked } })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm text-rd-text">工具审批（Tool Approval）</p>
                  <p className="text-xs text-rd-textMuted mt-1">工具调用前需审批。</p>
                </div>
                <Switch
                  checked={draft.policies?.toolApproval === true}
                  onCheckedChange={(checked) => updateDraft({ policies: { ...draft.policies, toolApproval: checked } })}
                />
              </div>
            </CardContent>
          </Card>

          {/* 审批模式卡片 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Shield size={16} className="text-rd-primary" />
                审批模式
              </CardTitle>
              <CardDescription>控制工具审批的触发范围</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label>审批模式</Label>
                <Select
                  value={draft.policies?.approvalMode ?? 'risky-only'}
                  onChange={(e) => updateDraft({ policies: { ...draft.policies, approvalMode: e.target.value as 'always' | 'risky-only' | 'minimal' } })}
                >
                  <SelectItem value="always">always（全部审批）</SelectItem>
                  <SelectItem value="risky-only">risky-only（仅高风险）</SelectItem>
                  <SelectItem value="minimal">minimal（最小化）</SelectItem>
                </Select>
                <p className="text-xs text-rd-textMuted">
                  always=全部工具调用需审批；risky-only=仅高风险工具；minimal=最小化审批。
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== 市场（Phase 42） ===== */}
      {activeTab === 'market' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          {/* 说明卡片 */}
          <Card>
            <CardContent className="flex items-start justify-between gap-4 py-6">
              <div className="flex items-start gap-3">
                <ShoppingBag size={20} className="mt-0.5 shrink-0 text-rd-primary" />
                <div>
                  <Label>市场</Label>
                  <p className="text-xs text-rd-textMuted mt-1">
                    管理 Skill 和 Hook 的发布、导入、导出
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 市场开关卡片 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShoppingBag size={16} className="text-rd-primary" />
                市场设置
              </CardTitle>
              <CardDescription>控制市场功能的启用与自动发布</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm text-rd-text">启用市场</p>
                  <p className="text-xs text-rd-textMuted mt-1">开启后可发布、导入、导出 Skill 和 Hook。</p>
                </div>
                <Switch
                  checked={draft.market?.enabled !== false}
                  onCheckedChange={(checked) => updateDraft({ market: { ...draft.market, enabled: checked } })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm text-rd-text">自动发布</p>
                  <p className="text-xs text-rd-textMuted mt-1">Skill/Hook 创建后自动发布到市场。</p>
                </div>
                <Switch
                  checked={draft.market?.autoPublish === true}
                  onCheckedChange={(checked) => updateDraft({ market: { ...draft.market, autoPublish: checked } })}
                />
              </div>

              {/* Phase 43：远程 Registry */}
              <div className="space-y-2">
                <Label htmlFor="market-registry-url">远程 Registry URL</Label>
                <Input
                  id="market-registry-url"
                  value={draft.market?.registryUrl ?? ''}
                  onChange={(e) => updateDraft({ market: { ...draft.market, registryUrl: e.target.value || undefined } })}
                  placeholder="https://registry.example.com"
                />
                <p className="text-xs text-rd-textMuted">留空使用本地 StubRegistryClient。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="market-registry-token">Registry Token</Label>
                <Input
                  id="market-registry-token"
                  type="password"
                  value={draft.market?.registryToken ?? ''}
                  onChange={(e) => updateDraft({ market: { ...draft.market, registryToken: e.target.value || undefined } })}
                  placeholder="可选，配合远程 Registry 使用"
                />
                <p className="text-xs text-rd-textMuted">远程 Registry 的认证 Token。</p>
              </div>
            </CardContent>
          </Card>

          {/* 占位卡片 */}
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <ShoppingBag size={32} className="mb-4 text-rd-textMuted" />
              <p className="text-sm text-rd-textMuted">市场功能将在后续版本完善</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== 人格（Phase 45） ===== */}
      {activeTab === 'persona' && (
        <SettingsPersonaTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 语音（Phase 45） ===== */}
      {activeTab === 'voice' && (
        <SettingsVoiceTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 功能发现（Phase 45） ===== */}
      {activeTab === 'discovery' && (
        <SettingsDiscoveryTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 对话持久化（Phase 44） ===== */}
      {activeTab === 'conversation' && (
        <SettingsConversationTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== 并行实验（Phase 44） ===== */}
      {activeTab === 'experiment' && (
        <SettingsExperimentTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== /goal 流程（Phase 43） ===== */}
      {activeTab === 'goal' && (
        <SettingsGoalTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== Hook 增强（Phase 43） ===== */}
      {activeTab === 'hookEnhancement' && (
        <SettingsHookEnhancementTab draft={draft} updateDraft={updateDraft} />
      )}

      {/* ===== Hooks（Phase 39） ===== */}
      {activeTab === 'hooks' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          {/* 说明卡片 */}
          <Card>
            <CardContent className="flex items-start justify-between gap-4 py-6">
              <div className="flex items-start gap-3">
                <Webhook size={20} className="mt-0.5 shrink-0 text-rd-primary" />
                <div>
                  <Label>Hooks 系统</Label>
                  <p className="text-xs text-rd-textMuted mt-1">
                    Hook 在 Agent 生命周期的特定阶段（如工具调用前后、会话开始结束）自动执行。
                    支持模板库一键启用，或通过自然语言描述 AI 自动生成。
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={refreshHooks} disabled={hookLoading}>
                <RefreshCw size={14} className={hookLoading ? 'animate-spin' : ''} />
                刷新
              </Button>
            </CardContent>
          </Card>

          {/* 模板库卡片 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BookOpen size={16} className="text-rd-primary" />
                Hook 模板库
              </CardTitle>
              <CardDescription>10 个常用 Hook 模板，一键启用</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {hooks.filter((h) => h.isTemplate).length === 0 && !hookLoading && (
                <p className="text-sm text-rd-textMuted py-4 text-center">
                  模板库加载中或为空。Hook 模板由其他子代理负责创建。
                </p>
              )}
              {hooks.filter((h) => h.isTemplate).map((hook) => (
                <div key={hook.id} className="flex items-center justify-between gap-4 rounded-lg border border-rd-border px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-rd-text">{hook.name}</span>
                      <Badge variant="outline">{hook.event}</Badge>
                    </div>
                    <p className="text-xs text-rd-textMuted mt-1">{hook.description}</p>
                  </div>
                  <Switch
                    checked={hook.enabled}
                    onCheckedChange={(checked) => handleHookToggle(hook.id, checked)}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 自定义 Hook 卡片 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wand2 size={16} className="text-rd-primary" />
                自定义 Hook
              </CardTitle>
              <CardDescription>通过自然语言描述 AI 自动生成 Hook</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 创建 Hook 对话框 */}
              {hookCreateForm === null ? (
                <Button onClick={() => setHookCreateForm({ description: '', generating: false, generated: null })}>
                  <Plus size={16} /> 创建新 Hook
                </Button>
              ) : (
                <div className="space-y-3 rounded-lg border border-rd-border p-4">
                  <Label htmlFor="hook-create-desc">描述你想要的 Hook 行为</Label>
                  <textarea
                    id="hook-create-desc"
                    className="w-full rounded-md border border-rd-border bg-rd-background px-3 py-2 text-sm text-rd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40 focus-visible:border-rd-primary/70"
                    rows={4}
                    value={hookCreateForm.description}
                    onChange={(e) => setHookCreateForm({ ...hookCreateForm, description: e.target.value })}
                    placeholder="例如：每次 file_write 后自动运行 eslint 检查修改的文件"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={handleHookAiGenerate}
                      disabled={!hookCreateForm.description.trim() || hookCreateForm.generating}
                    >
                      {hookCreateForm.generating ? <RefreshCw size={16} className="animate-spin" /> : <Wand2 size={16} />}
                      生成 Hook
                    </Button>
                    <Button variant="ghost" onClick={() => setHookCreateForm(null)}>
                      <X size={16} /> 取消
                    </Button>
                  </div>
                </div>
              )}

              {/* 已有自定义 Hook 列表 */}
              {hooks.filter((h) => !h.isTemplate).length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-rd-textSubtle">已创建的自定义 Hook</p>
                  {hooks.filter((h) => !h.isTemplate).map((hook) => (
                    <div key={hook.id} className="flex items-center justify-between gap-4 rounded-lg border border-rd-border px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-rd-text">{hook.name}</span>
                          <Badge variant="outline">{hook.event}</Badge>
                        </div>
                        <p className="text-xs text-rd-textMuted mt-1">{hook.description}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={hook.enabled}
                          onCheckedChange={(checked) => handleHookToggle(hook.id, checked)}
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                          onClick={() => handleHookDelete(hook.id)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ===== 子 Agent 配置 ===== */}
      {activeTab === 'subagents' && (
        <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
          {/* 说明卡片 */}
          <Card>
            <CardContent className="flex items-start justify-between gap-4 py-6">
              <div className="flex items-start gap-3">
                <Users size={20} className="mt-0.5 shrink-0 text-rd-primary" />
                <div>
                  <Label>子 Agent 配置</Label>
                  <p className="text-xs text-rd-textMuted mt-1">
                    管理子 Agent 的角色 Profile：researcher（调研）、executor（执行）、reviewer（审查）。
                    每个 Profile 定义工具白名单、质疑权限、输出格式与 Token 预算，构成父 Agent 的委托契约。
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Phase 43：子 Agent 派遣配置 */}
          <Card>
            <CardHeader>
              <CardTitle>派遣设置</CardTitle>
              <CardDescription>控制子 Agent 派遣的总开关、并行上限与默认角色</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="subagents-enabled">启用子 Agent 派遣</Label>
                  <p className="text-xs text-rd-textMuted">关闭后父 Agent 不再派生子 Agent，所有任务在主线程完成。</p>
                </div>
                <Switch
                  id="subagents-enabled"
                  checked={draft.subAgents.enabled}
                  onCheckedChange={(checked) => updateSubAgents({ enabled: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="subagents-max-parallel">最大并行子 Agent 数</Label>
                <Input
                  id="subagents-max-parallel"
                  type="number"
                  min={1}
                  max={10}
                  value={draft.subAgents.maxParallel}
                  onChange={(e) => updateSubAgents({ maxParallel: Number(e.target.value) })}
                />
                <p className="text-xs text-rd-textMuted">同时运行的子 Agent 上限（1-10）。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="subagents-default-role">默认角色</Label>
                <Select
                  id="subagents-default-role"
                  value={draft.subAgents.defaultRole}
                  onChange={(e) => updateSubAgents({ defaultRole: e.target.value as typeof draft.subAgents.defaultRole })}
                >
                  <SelectItem value="researcher">researcher（调研）</SelectItem>
                  <SelectItem value="executor">executor（执行）</SelectItem>
                  <SelectItem value="reviewer">reviewer（审查）</SelectItem>
                  <SelectItem value="custom">custom（自定义）</SelectItem>
                </Select>
                <p className="text-xs text-rd-textMuted">未指定角色时使用的默认角色。</p>
              </div>

              {/* 角色门控规则 */}
              <div className="space-y-3 rounded-lg border border-rd-border p-4">
                <p className="text-xs font-semibold text-rd-textSubtle">角色并行上限</p>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="subagents-researcher-max">researcher</Label>
                    <Input
                      id="subagents-researcher-max"
                      type="number"
                      min={0}
                      value={draft.subAgents.gateRules?.researcherMaxParallel ?? 3}
                      onChange={(e) => updateSubAgentsGateRules({ researcherMaxParallel: Number(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="subagents-executor-max">executor</Label>
                    <Input
                      id="subagents-executor-max"
                      type="number"
                      min={0}
                      value={draft.subAgents.gateRules?.executorMaxParallel ?? 2}
                      onChange={(e) => updateSubAgentsGateRules({ executorMaxParallel: Number(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="subagents-reviewer-max">reviewer</Label>
                    <Input
                      id="subagents-reviewer-max"
                      type="number"
                      min={0}
                      value={draft.subAgents.gateRules?.reviewerMaxParallel ?? 2}
                      onChange={(e) => updateSubAgentsGateRules({ reviewerMaxParallel: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <p className="text-xs text-rd-textMuted">每种角色同时可存在的最大子 Agent 数，0 表示不限制。</p>
              </div>
            </CardContent>
          </Card>

          {/* 内置配置区 */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-rd-text">内置配置</h3>
              <Badge variant="outline">不可删除</Badge>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {BUILTIN_AGENT_PROFILES.map((profile) => (
                <Card key={profile.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Users size={16} className="text-rd-primary" />
                        {profile.name}
                      </CardTitle>
                      <Badge variant="primary">{profile.role}</Badge>
                    </div>
                    <CardDescription className="line-clamp-2">{profile.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-rd-textMuted">模型</span>
                      <span className="text-rd-text">{profile.modelId}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-rd-textMuted">输出格式</span>
                      <span className="text-rd-text">{profile.outputFormat}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-rd-textMuted">工具数</span>
                      <span className="text-rd-text">{profile.allowedTools.length}</span>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => setExpandedAgentId(expandedAgentId === profile.id ? null : profile.id)}
                      >
                        <Eye size={14} /> 查看
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => {
                          const copy: AgentProfileUI = {
                            ...profile,
                            id: `${profile.id}-copy-${Date.now().toString(36)}`,
                            name: `${profile.name} 副本`,
                            isBuiltin: false,
                            role: 'custom',
                            allowedTools: [...profile.allowedTools],
                            forbiddenTools: [...profile.forbiddenTools],
                          };
                          setAgentProfiles([...agentProfiles, copy]);
                          setExpandedAgentId(copy.id);
                        }}
                      >
                        <Plus size={14} /> 复制
                      </Button>
                    </div>
                    {expandedAgentId === profile.id && (
                      <div className="mt-3 space-y-3 rounded-lg bg-rd-surfaceHover/50 p-3">
                        <div className="space-y-1">
                          <Label className="text-xs">System Prompt</Label>
                          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-rd-surface p-2 text-xs text-rd-text">
                            {profile.systemPrompt}
                          </pre>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">工具白名单</Label>
                          <p className="text-xs text-rd-text">{profile.allowedTools.join(', ')}</p>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">禁止工具</Label>
                          <p className="text-xs text-rd-text">{profile.forbiddenTools.join(', ') || '无'}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <span className="text-rd-textMuted">Token 预算：</span>
                            <span className="text-rd-text">{profile.maxTokens}</span>
                          </div>
                          <div>
                            <span className="text-rd-textMuted">最大步数：</span>
                            <span className="text-rd-text">{profile.maxSteps}</span>
                          </div>
                          <div>
                            <span className="text-rd-textMuted">允许质疑：</span>
                            <span className="text-rd-text">{profile.canChallenge ? '是' : '否'}</span>
                          </div>
                          <div>
                            <span className="text-rd-textMuted">质疑级别：</span>
                            <span className="text-rd-text">{profile.challengeSeverity}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* 我的配置区 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-rd-text">我的配置</h3>
                <Badge variant="outline">{agentProfiles.length}</Badge>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  const newProfile: AgentProfileUI = {
                    id: `custom-${Date.now().toString(36)}`,
                    name: '新建 Profile',
                    role: 'custom',
                    modelId: 'default',
                    description: '自定义子 Agent Profile',
                    systemPrompt: '# 角色定位\n请描述该子 Agent 的角色与职责。\n\n# 绝对规则\n- 服从父 Agent 委托契约。\n\n# 禁止事项\n- 禁止越权操作。\n\n# 输出格式\n请定义输出格式。\n\n# 质疑权利\n可对错误指令提出质疑。',
                    allowedTools: ['read_file'],
                    forbiddenTools: [],
                    canChallenge: true,
                    challengeSeverity: 'warning',
                    outputFormat: 'custom',
                    maxTokens: 32000,
                    maxSteps: 20,
                    isBuiltin: false,
                  };
                  setAgentProfiles([...agentProfiles, newProfile]);
                  setExpandedAgentId(newProfile.id);
                }}
              >
                <Plus size={14} /> 新建
              </Button>
            </div>

            {agentProfiles.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-10 text-center">
                  <Users size={32} className="mb-3 text-rd-textMuted" />
                  <p className="text-sm text-rd-textMuted">
                    还没有自定义子 Agent Profile。点击"新建"创建，或从内置配置复制一个开始。
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {agentProfiles.map((profile, idx) => (
                  <Card key={profile.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-base">{profile.name || '未命名'}</CardTitle>
                          <Badge variant="outline">{profile.role}</Badge>
                          <Badge variant="primary">{profile.outputFormat}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setExpandedAgentId(expandedAgentId === profile.id ? null : profile.id)}
                          >
                            {expandedAgentId === profile.id ? (
                              <><ChevronDown size={14} /> 收起</>
                            ) : (
                              <><ChevronRight size={14} /> 展开</>
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                            onClick={() => {
                              const next = agentProfiles.filter((_, i) => i !== idx);
                              setAgentProfiles(next);
                              if (expandedAgentId === profile.id) setExpandedAgentId(null);
                            }}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                      <CardDescription>{profile.description}</CardDescription>
                    </CardHeader>
                    {expandedAgentId === profile.id && (
                      <CardContent className="space-y-4">
                        {/* 名称 */}
                        <div className="space-y-2">
                          <Label>名称</Label>
                          <Input
                            value={profile.name}
                            onChange={(e) => {
                              const next = [...agentProfiles];
                              next[idx] = { ...profile, name: e.target.value };
                              setAgentProfiles(next);
                            }}
                            placeholder="Profile 名称"
                          />
                        </div>

                        {/* 描述 */}
                        <div className="space-y-2">
                          <Label>描述</Label>
                          <Input
                            value={profile.description}
                            onChange={(e) => {
                              const next = [...agentProfiles];
                              next[idx] = { ...profile, description: e.target.value };
                              setAgentProfiles(next);
                            }}
                            placeholder="一句话描述该 Profile 的职责"
                          />
                        </div>

                        {/* 模型选择 */}
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>模型</Label>
                            <Input
                              value={profile.modelId}
                              onChange={(e) => {
                                const next = [...agentProfiles];
                                next[idx] = { ...profile, modelId: e.target.value };
                                setAgentProfiles(next);
                              }}
                              placeholder="default 或具体模型 id"
                            />
                            <p className="text-xs text-rd-textMuted">填 'default' 走路由器默认选择。</p>
                          </div>
                          <div className="space-y-2">
                            <Label>输出格式</Label>
                            <Select
                              value={profile.outputFormat}
                              onChange={(e) => {
                                const next = [...agentProfiles];
                                next[idx] = { ...profile, outputFormat: e.target.value as AgentProfileUI['outputFormat'] };
                                setAgentProfiles(next);
                              }}
                            >
                              <SelectItem value="research_report">research_report</SelectItem>
                              <SelectItem value="code_change">code_change</SelectItem>
                              <SelectItem value="review_report">review_report</SelectItem>
                              <SelectItem value="custom">custom</SelectItem>
                            </Select>
                          </div>
                        </div>

                        {/* System Prompt */}
                        <div className="space-y-2">
                          <Label>System Prompt</Label>
                          <textarea
                            className="flex min-h-[120px] w-full rounded-xl border border-rd-border bg-rd-surface px-3 py-2 text-sm text-rd-text placeholder:text-rd-textMuted focus:border-rd-primary focus:outline-none focus:ring-1 focus:ring-rd-primary"
                            value={profile.systemPrompt}
                            onChange={(e) => {
                              const next = [...agentProfiles];
                              next[idx] = { ...profile, systemPrompt: e.target.value };
                              setAgentProfiles(next);
                            }}
                            placeholder="定义子 Agent 的角色、规则、禁止事项、输出格式、质疑权利"
                          />
                          <p className="text-xs text-rd-textMuted">支持 Markdown，建议包含：角色定位、绝对规则、禁止事项、输出格式、质疑权利。</p>
                        </div>

                        {/* 工具白名单 */}
                        <div className="space-y-2">
                          <Label>工具白名单（逗号分隔）</Label>
                          <Input
                            value={profile.allowedTools.join(', ')}
                            onChange={(e) => {
                              const tools = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                              const next = [...agentProfiles];
                              next[idx] = { ...profile, allowedTools: tools };
                              setAgentProfiles(next);
                            }}
                            placeholder="read_file, file_write, execute_command"
                          />
                          <p className="text-xs text-rd-textMuted">仅允许子 Agent 使用此处列出的工具。</p>
                        </div>

                        {/* Token 预算 & 最大步数 */}
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Token 预算</Label>
                            <Input
                              type="number"
                              value={String(profile.maxTokens)}
                              onChange={(e) => {
                                const v = parseInt(e.target.value, 10);
                                const next = [...agentProfiles];
                                next[idx] = { ...profile, maxTokens: Number.isFinite(v) && v > 0 ? v : profile.maxTokens };
                                setAgentProfiles(next);
                              }}
                              placeholder="32000"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>最大步数</Label>
                            <Input
                              type="number"
                              value={String(profile.maxSteps)}
                              onChange={(e) => {
                                const v = parseInt(e.target.value, 10);
                                const next = [...agentProfiles];
                                next[idx] = { ...profile, maxSteps: Number.isFinite(v) && v > 0 ? v : profile.maxSteps };
                                setAgentProfiles(next);
                              }}
                              placeholder="20"
                            />
                          </div>
                        </div>

                        {/* 允许质疑 Toggle & 质疑级别 */}
                        <div className="flex items-center justify-between gap-4 rounded-lg bg-rd-surfaceHover/50 p-3">
                          <div className="flex-1">
                            <p className="text-sm text-rd-text">允许质疑父 Agent</p>
                            <p className="text-xs text-rd-textMuted mt-1">开启后子 Agent 可对父 Agent 的指令提出质疑。</p>
                          </div>
                          <Switch
                            checked={profile.canChallenge}
                            onCheckedChange={(checked) => {
                              const next = [...agentProfiles];
                              next[idx] = { ...profile, canChallenge: checked };
                              setAgentProfiles(next);
                            }}
                          />
                        </div>
                        {profile.canChallenge && (
                          <div className="space-y-2">
                            <Label>质疑级别</Label>
                            <Select
                              value={profile.challengeSeverity}
                              onChange={(e) => {
                                const next = [...agentProfiles];
                                next[idx] = { ...profile, challengeSeverity: e.target.value as AgentProfileUI['challengeSeverity'] };
                                setAgentProfiles(next);
                              }}
                            >
                              <SelectItem value="warning">warning（仅记录）</SelectItem>
                              <SelectItem value="blocking">blocking（暂停流水线）</SelectItem>
                            </Select>
                          </div>
                        )}
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 模型编辑模态：新增/编辑模型时弹出，集中填写所有字段 */}
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
        </div>
      </div>
    </div>
    <AlertBanner message={alertMsg} onDismiss={() => setAlertMsg(null)} />
    </>
  );
}

// ===== 归档对话面板 =====
// 从 useProjectsStore 读取归档列表，支持还原与永久删除
function ArchivedConversationsPanel() {
  const archivedConversations = useProjectsStore((s) => s.archivedConversations);
  const restoreConversation = useProjectsStore((s) => s.restoreConversation);
  const deleteArchivedConversation = useProjectsStore((s) => s.deleteArchivedConversation);
  const projects = useProjectsStore((s) => s.projects);
  // 替代原生 confirm 的状态
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    variant?: 'default' | 'danger';
    onConfirm: () => void;
  } | null>(null);

  // 格式化时间戳
  const formatTime = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  if (archivedConversations.length === 0) {
    return (
      <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
        <Card className="flex flex-col items-center justify-center py-12 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-rd-primary/10 text-rd-primary">
            <Archive size={32} />
          </div>
          <h3 className="mb-2 text-lg font-semibold text-rd-text">没有归档对话</h3>
          <p className="max-w-md text-sm text-rd-textMuted">
            在左侧项目侧边栏中右键对话选择"归档"，对话会移到此页面。归档后可随时还原到原项目。
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 space-y-3 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>归档对话</CardTitle>
          <CardDescription>
            共 {archivedConversations.length} 条归档对话。可还原到原项目或永久删除。
          </CardDescription>
        </CardHeader>
      </Card>

      {archivedConversations.map((conv) => {
        // 检查原项目是否还存在
        const projectExists = projects.some((p) => p.id === conv.projectId);
        return (
          <Card key={conv.id}>
            <CardContent className="py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Folder size={16} className="shrink-0 text-rd-textMuted" />
                    <span className="truncate font-medium text-rd-text">{conv.title}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-rd-textMuted">
                    <span>原项目: {conv.projectName}</span>
                    <span>归档于: {formatTime(conv.archivedAt)}</span>
                    <span>消息数: {conv.messages?.length ?? 0}</span>
                    {!projectExists && (
                      <Badge variant="outline" className="text-rd-warning">原项目已删除</Badge>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => restoreConversation(conv.id)}
                    disabled={!projectExists}
                    title={projectExists ? '还原到原项目' : '原项目已被删除，无法还原'}
                  >
                    <RotateCcw size={14} /> 还原
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-rd-danger hover:bg-rd-danger/10 hover:text-rd-danger"
                    onClick={() => {
                      setConfirmDialog({
                        message: `确认永久删除归档对话"${conv.title}"？此操作不可恢复。`,
                        variant: 'danger',
                        onConfirm: () => {
                          setConfirmDialog(null);
                          deleteArchivedConversation(conv.id);
                        },
                      });
                    }}
                  >
                    <Trash2 size={14} /> 永久删除
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
      <ConfirmDialog
        open={confirmDialog !== null}
        message={confirmDialog?.message ?? ''}
        variant={confirmDialog?.variant}
        onConfirm={() => confirmDialog?.onConfirm()}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}
