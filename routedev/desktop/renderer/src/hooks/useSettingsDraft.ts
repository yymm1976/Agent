// desktop/renderer/src/hooks/useSettingsDraft.ts
// Phase 74-G：SettingsPage 的 draft 状态 + 50 个 update* 函数
// 从 SettingsPage.tsx 迁移，保留所有原函数签名与逻辑

import { useState, useEffect, useRef } from 'react';
import type {
  AppConfig, ProviderConfig, ModelConfig, RouterRule, SecurityConfig,
  MCPServerEntryConfig, ChannelType,
  PermissionProfile, FilesystemPermissionRule, ExecutionConfig,
  ApprovalLevel, ToolCategory,
} from '../../../../src/config/schema.js';
import {
  constructMcpServer, mcpServerToForm, EMPTY_MCP_FORM,
  constructChannelEntry, constructChannelOptions, deepClone,
  EMPTY_PROVIDER, EMPTY_MODEL, EMPTY_RULE, SEARCH_ENGINES,
  type AgentProfileUI, type McpFormState,
} from '../pages/settings-helpers.js';

interface UseSettingsDraftOptions {
  config: AppConfig | null;
  /** draft 更新时清除保存提示（对应原 updateDraft 中的 setSaveResult(null)） */
  onClearSaveResult?: () => void;
}

/**
 * SettingsPage 的 draft 状态管理 hook
 * 包含：draft 状态 + config→draft 同步 + 50 个 update* 函数
 * 所有 update* 函数仅在 draft 非空时生效（组件在 if (!draft) return 后才调用）
 */
export function useSettingsDraft({ config, onClearSaveResult }: UseSettingsDraftOptions) {
  const [draft, setDraft] = useState<AppConfig | null>(null);
  // 保存成功后跳过一次 config→draft 同步，避免用户正在编辑的 Provider 被清空
  const skipSyncRef = useRef(false);
  const dirtyRef = useRef(false);

  // 网络搜索引擎下拉选择（默认 'glm'，draft 加载后推断第一个有 key 的引擎）
  const [selectedSearchEngine, setSelectedSearchEngine] = useState<string>('glm');
  const searchEngineInitedRef = useRef(false);

  // API Key 显示/隐藏状态（按 provider index）
  const [showApiKeys, setShowApiKeys] = useState<Record<number, boolean>>({});
  // 测试连接状态
  const [testingProvider, setTestingProvider] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, { success: boolean; message: string } | null>>({});
  // MCP 添加/编辑表单：null=关闭，McpFormState=打开（添加或编辑）
  const [mcpForm, setMcpForm] = useState<McpFormState | null>(null);
  // MCP 编辑模式标记：null=添加模式，非 null=编辑模式（存储原始 server id）
  const [mcpEditingId, setMcpEditingId] = useState<string | null>(null);
  // 子 Agent Profile state
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileUI[]>([]);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  // 渠道添加表单
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [newChannel, setNewChannel] = useState({ id: '', type: 'wechat-work' as ChannelType });
  // 渠道凭据值（按字段 key 存储）
  const [channelCreds, setChannelCreds] = useState<Record<string, string>>({});
  // 渠道凭据显示/隐藏状态（按 字段key 存储）
  const [showChannelCreds, setShowChannelCreds] = useState<Record<string, boolean>>({});
  // Webhook authToken 显示/隐藏切换
  const [showChannelAuthToken, setShowChannelAuthToken] = useState(false);
  // 渠道编辑：null=无编辑，number=编辑指定 index 的 options
  const [editingChannelIdx, setEditingChannelIdx] = useState<number | null>(null);
  // 模型编辑模态：null=关闭，{pIdx, mIdx?, model}=打开（mIdx 不存在=新增，存在=编辑）
  const [modelEditor, setModelEditor] = useState<{ pIdx: number; mIdx?: number; model: ModelConfig } | null>(null);

  // 当 config 变化时同步到 draft（保存成功后跳过一次）
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

  // --- 通用更新 ---
  const updateDraft = (patch: Partial<AppConfig>) => {
    dirtyRef.current = true;
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    onClearSaveResult?.();
  };

  // --- Provider 操作 ---
  const updateProvider = (index: number, patch: Partial<ProviderConfig>) => {
    if (!draft) return;
    const providers = [...draft.providers];
    providers[index] = { ...providers[index], ...patch };
    updateDraft({ providers });
  };
  // 添加 Provider：自动生成唯一 ID（用户无需手动填写）
  const addProvider = () => {
    if (!draft) return;
    const existingCount = draft.providers.length;
    const newProvider: ProviderConfig = {
      ...EMPTY_PROVIDER,
      id: `provider-${Date.now().toString(36).slice(-4)}-${existingCount + 1}`,
      name: `Provider ${existingCount + 1}`,
    };
    updateDraft({ providers: [...draft.providers, newProvider] });
  };
  const removeProvider = (index: number) => {
    if (!draft) return;
    const providers = draft.providers.filter((_, i) => i !== index);
    updateDraft({ providers });
  };

  // --- 模型操作 ---
  const updateModel = (pIdx: number, mIdx: number, patch: Partial<ModelConfig>) => {
    if (!draft) return;
    const providers = [...draft.providers];
    const models = [...providers[pIdx].models];
    models[mIdx] = { ...models[mIdx], ...patch, provider: providers[pIdx].id };
    providers[pIdx] = { ...providers[pIdx], models };
    updateDraft({ providers });
  };
  // 打开模型编辑模态（新增）
  const openAddModel = (pIdx: number) => {
    if (!draft) return;
    setModelEditor({
      pIdx,
      model: { ...EMPTY_MODEL, provider: draft.providers[pIdx].id },
    });
  };
  // 打开模型编辑模态（编辑现有）
  const openEditModel = (pIdx: number, mIdx: number) => {
    if (!draft) return;
    setModelEditor({ pIdx, mIdx, model: { ...draft.providers[pIdx].models[mIdx] } });
  };
  // 确认模型编辑模态
  const confirmModelEditor = () => {
    if (!draft) return;
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
    if (!draft) return;
    const providers = [...draft.providers];
    providers[pIdx] = {
      ...providers[pIdx],
      models: providers[pIdx].models.filter((_, i) => i !== mIdx),
    };
    updateDraft({ providers });
  };

  // --- 路由规则操作 ---
  const updateRule = (index: number, patch: Partial<RouterRule>) => {
    if (!draft) return;
    const rules = [...draft.router.rules];
    rules[index] = { ...rules[index], ...patch };
    updateDraft({ router: { ...draft.router, rules } });
  };
  const addRule = () => {
    if (!draft) return;
    updateDraft({ router: { ...draft.router, rules: [...draft.router.rules, { ...EMPTY_RULE }] } });
  };
  const removeRule = (index: number) => {
    if (!draft) return;
    updateDraft({ router: { ...draft.router, rules: draft.router.rules.filter((_, i) => i !== index) } });
  };

  // --- 预算操作 ---
  const updateBudget = (patch: Partial<AppConfig['router']['budget']>) => {
    if (!draft) return;
    updateDraft({ router: { ...draft.router, budget: { ...draft.router.budget, ...patch } } });
  };

  // --- 安全配置 ---
  const updateSecurity = (patch: Partial<SecurityConfig>) => {
    if (!draft) return;
    updateDraft({ security: { ...draft.security, ...patch } });
  };
  // Phase 48：更新某个 ToolCategory 的审批级覆盖（合并到 config.security.approval）
  const updateSecurityApproval = (category: ToolCategory, level: ApprovalLevel) => {
    if (!draft) return;
    const current = { ...(draft.security.approval ?? {}) };
    current[category] = level;
    updateSecurity({ approval: current });
  };

  // --- 权限规则配置（Permission Profile） ---
  const updatePermissionProfile = (patch: Partial<PermissionProfile>) => {
    if (!draft) return;
    updateDraft({ permissionProfile: { ...draft.permissionProfile, ...patch } });
  };
  // 文件系统规则：更新指定索引
  const updateFsRule = (index: number, patch: Partial<FilesystemPermissionRule>) => {
    if (!draft) return;
    const filesystem = [...draft.permissionProfile.filesystem];
    filesystem[index] = { ...filesystem[index], ...patch };
    updatePermissionProfile({ filesystem });
  };
  // 文件系统规则：新增
  const addFsRule = () => {
    if (!draft) return;
    updatePermissionProfile({
      filesystem: [...draft.permissionProfile.filesystem, { pattern: '**/*', access: 'read' }],
    });
  };
  // 文件系统规则：删除
  const removeFsRule = (index: number) => {
    if (!draft) return;
    updatePermissionProfile({
      filesystem: draft.permissionProfile.filesystem.filter((_, i) => i !== index),
    });
  };
  // 网络域名规则：更新白名单/黑名单（逗号分隔文本）
  const updateNetworkAllow = (value: string) => {
    if (!draft) return;
    updatePermissionProfile({
      network: {
        ...draft.permissionProfile.network,
        allow: value.split(',').map((s) => s.trim()).filter(Boolean),
      },
    });
  };
  const updateNetworkDeny = (value: string) => {
    if (!draft) return;
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
    if (!draft) return;
    updateDraft({ webSearch: { ...draft.webSearch, ...patch } });
  };

  // --- 自主度配置 ---
  const updateAutonomy = (patch: Partial<AppConfig['autonomy']>) => {
    if (!draft) return;
    updateDraft({ autonomy: { ...draft.autonomy, ...patch } });
  };

  // --- 可观测性配置 ---
  const updateOptimization = (patch: Partial<AppConfig['optimization']>) => {
    if (!draft) return;
    updateDraft({ optimization: { ...draft.optimization, ...patch } });
  };
  const updateTokenTracking = (patch: Partial<AppConfig['optimization']['tokenTracking']>) => {
    if (!draft) return;
    updateDraft({ optimization: { ...draft.optimization, tokenTracking: { ...draft.optimization.tokenTracking, ...patch } } });
  };
  // --- Phase 31：统一工作流编排 ---
  const updateWorkflow = (patch: Partial<AppConfig['optimization']['workflow']>) => {
    if (!draft) return;
    updateOptimization({ workflow: { ...draft.optimization.workflow, ...patch } });
  };
  // --- Phase 31 Task 6：生产安全防护 ---
  const updateSafety = (patch: Partial<AppConfig['optimization']['safety']>) => {
    if (!draft) return;
    updateOptimization({ safety: { ...draft.optimization.safety, ...patch } });
  };
  // 任务3：简洁思考约束
  const updateConciseThinking = (patch: Partial<AppConfig['optimization']['conciseThinking']>) => {
    if (!draft) return;
    updateOptimization({ conciseThinking: { ...draft.optimization.conciseThinking, ...patch } });
  };

  // --- Checkpoint 配置 ---
  const updateCheckpoint = (patch: Partial<AppConfig['checkpoint']>) => {
    if (!draft) return;
    updateDraft({ checkpoint: { ...draft.checkpoint, ...patch } });
  };
  // Phase 33 Task 3：Checkpoint triggers 编辑
  const updateCheckpointTrigger = (index: number, patch: Partial<AppConfig['checkpoint']['triggers'][number]>) => {
    if (!draft) return;
    const triggers = [...draft.checkpoint.triggers];
    triggers[index] = { ...triggers[index], ...patch };
    updateCheckpoint({ triggers });
  };
  const addCheckpointTrigger = () => {
    if (!draft) return;
    updateCheckpoint({ triggers: [...draft.checkpoint.triggers, { level: 50, action: 'incremental' }] });
  };
  const removeCheckpointTrigger = (index: number) => {
    if (!draft) return;
    updateCheckpoint({ triggers: draft.checkpoint.triggers.filter((_, i) => i !== index) });
  };

  // --- Phase 33 Task 3：goalVerifier 配置 ---
  const updateGoalVerifier = (patch: Partial<AppConfig['goalVerifier']>) => {
    if (!draft) return;
    updateDraft({ goalVerifier: { ...draft.goalVerifier, ...patch } });
  };

  // --- Phase 33 Task 3：adversarial 配置 ---
  const updateAdversarial = (patch: Partial<AppConfig['adversarial']>) => {
    if (!draft) return;
    updateDraft({ adversarial: { ...draft.adversarial, ...patch } });
  };

  // --- 执行配置（并发/熔断/检查点提示） ---
  const updateExecution = (patch: Partial<ExecutionConfig>) => {
    if (!draft) return;
    updateDraft({ execution: { ...draft.execution, ...patch } });
  };

  // --- Phase 33 Task 3：updates 配置 ---
  const updateUpdates = (patch: Partial<AppConfig['updates']>) => {
    if (!draft) return;
    updateDraft({ updates: { ...draft.updates, ...patch } });
  };

  // --- Phase 50 Task 5/6：Phase 48/49 模块接入开关 ---
  const updatePhase48Integration = (patch: Partial<AppConfig['phase48Integration']>) => {
    if (!draft) return;
    updateDraft({ phase48Integration: { ...draft.phase48Integration, ...patch } });
  };
  const updatePhase49Integration = (patch: Partial<AppConfig['phase49Integration']>) => {
    if (!draft) return;
    updateDraft({ phase49Integration: { ...draft.phase49Integration, ...patch } });
  };

  // --- 调度器配置（Phase 37 Task 2） ---
  const updateScheduler = (patch: Partial<NonNullable<AppConfig['scheduler']>>) => {
    if (!draft) return;
    const current = draft.scheduler ?? { enabled: true, maxTasks: 20, defaultTimezone: 'Asia/Shanghai' };
    updateDraft({ scheduler: { ...current, ...patch } });
  };

  // --- Phase 33 Task 3：prompts 配置 ---
  const updatePrompts = (patch: Partial<AppConfig['prompts']>) => {
    if (!draft) return;
    updateDraft({ prompts: { ...draft.prompts, ...patch } });
  };

  // --- 项目记忆配置 ---
  const updateProjectMemory = (patch: Partial<AppConfig['projectMemory']>) => {
    if (!draft) return;
    updateDraft({ projectMemory: { ...draft.projectMemory, ...patch } });
  };

  // --- Phase 45：记忆配置（推理 / 自动学习 / 注入阈值） ---
  const updateMemory = (patch: Partial<AppConfig['memory']>) => {
    if (!draft) return;
    updateDraft({ memory: { ...draft.memory, ...patch } });
  };

  // --- MCP 配置 ---
  const updateMcp = (patch: Partial<AppConfig['mcp']>) => {
    if (!draft) return;
    updateDraft({ mcp: { ...draft.mcp, ...patch } });
  };
  const updateMcpServer = (index: number, patch: Partial<MCPServerEntryConfig>) => {
    if (!draft) return;
    const servers = [...draft.mcp.servers];
    servers[index] = { ...servers[index], ...patch };
    updateMcp({ servers });
  };
  const removeMcpServer = (index: number) => {
    if (!draft) return;
    updateMcp({ servers: draft.mcp.servers.filter((_, i) => i !== index) });
  };
  // 提交 MCP 表单（添加或编辑）
  const submitMcpForm = () => {
    if (!draft) return;
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
    if (!draft) return;
    setMcpForm(mcpServerToForm(draft.mcp.servers[index]));
    setMcpEditingId(draft.mcp.servers[index].id);
  };

  // --- 渠道配置 ---
  const updateChannels = (patch: Partial<AppConfig['channels']>) => {
    if (!draft) return;
    updateDraft({ channels: { ...draft.channels, ...patch } });
  };
  const removeChannel = (index: number) => {
    if (!draft) return;
    updateChannels({ entries: draft.channels.entries.filter((_, i) => i !== index) });
  };
  // 添加渠道：使用 channelCreds 中的值构造 options
  const addChannel = () => {
    if (!draft) return;
    const entry = constructChannelEntry(newChannel.id, newChannel.type, channelCreds);
    updateChannels({ entries: [...draft.channels.entries, entry] });
    setNewChannel({ id: '', type: 'wechat-work' });
    setChannelCreds({});
    setShowAddChannel(false);
  };
  // 保存渠道 options 编辑
  const saveChannelOptions = (index: number) => {
    if (!draft) return;
    const entries = [...draft.channels.entries];
    const entry = entries[index];
    const options = constructChannelOptions(entry.type, channelCreds);
    entries[index] = { ...entry, options };
    updateChannels({ entries });
    setEditingChannelIdx(null);
    setChannelCreds({});
  };

  // --- 通用配置 ---
  const updateGeneral = (patch: Partial<AppConfig['general']>) => {
    if (!draft) return;
    updateDraft({ general: { ...draft.general, ...patch } });
  };

  // --- 后台行为配置 ---
  const updateBackgroundBehavior = (patch: Partial<AppConfig['general']['backgroundBehavior']>) => {
    if (!draft) return;
    updateGeneral({ backgroundBehavior: { ...draft.general.backgroundBehavior, ...patch } });
  };

  // --- UI 配置 ---
  const updateUi = (patch: Partial<AppConfig['ui']>) => {
    if (!draft) return;
    updateDraft({ ui: { ...draft.ui, ...patch } });
  };

  // --- 提示音配置 ---
  const updateSounds = (patch: Partial<AppConfig['sounds']>) => {
    if (!draft) return;
    updateDraft({ sounds: { ...draft.sounds, ...patch } });
  };

  // --- Phase 40：渐进式信任配置 ---
  const updateTrust = (patch: Partial<AppConfig['trust']>) => {
    if (!draft) return;
    updateDraft({ trust: { ...draft.trust, ...patch } });
  };

  // --- Phase 40：质量监测配置 ---
  const updateQuality = (patch: Partial<AppConfig['quality']>) => {
    if (!draft) return;
    updateDraft({ quality: { ...draft.quality, ...patch } });
  };

  // --- Phase 40：用户经验配置 ---
  const updateExpertise = (patch: Partial<AppConfig['expertise']>) => {
    if (!draft) return;
    updateDraft({ expertise: { ...draft.expertise, ...patch } });
  };

  // --- Phase 43：子 Agent 配置 ---
  const updateSubAgents = (patch: Partial<AppConfig['subAgents']>) => {
    if (!draft) return;
    updateDraft({ subAgents: { ...draft.subAgents, ...patch } });
  };
  const updateSubAgentsGateRules = (patch: { researcherMaxParallel?: number; executorMaxParallel?: number; reviewerMaxParallel?: number }) => {
    if (!draft) return;
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
    if (!draft) return;
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

  return {
    // 核心状态
    draft,
    setDraft,
    dirtyRef,
    skipSyncRef,
    // 搜索引擎
    selectedSearchEngine,
    setSelectedSearchEngine,
    // Provider / 模型表单
    showApiKeys,
    testingProvider,
    testResults,
    modelEditor,
    setModelEditor,
    // MCP 表单
    mcpForm,
    setMcpForm,
    mcpEditingId,
    setMcpEditingId,
    // 子 Agent
    agentProfiles,
    setAgentProfiles,
    expandedAgentId,
    setExpandedAgentId,
    // 渠道表单
    showAddChannel,
    setShowAddChannel,
    newChannel,
    setNewChannel,
    channelCreds,
    setChannelCreds,
    showChannelCreds,
    setShowChannelCreds,
    showChannelAuthToken,
    setShowChannelAuthToken,
    editingChannelIdx,
    setEditingChannelIdx,
    // 更新函数
    updateDraft,
    updateProvider,
    addProvider,
    removeProvider,
    updateModel,
    openAddModel,
    openEditModel,
    confirmModelEditor,
    removeModel,
    updateRule,
    addRule,
    removeRule,
    updateBudget,
    updateSecurity,
    updateSecurityApproval,
    updatePermissionProfile,
    updateFsRule,
    addFsRule,
    removeFsRule,
    updateNetworkAllow,
    updateNetworkDeny,
    updateWebSearch,
    updateAutonomy,
    updateOptimization,
    updateTokenTracking,
    updateWorkflow,
    updateSafety,
    updateConciseThinking,
    updateCheckpoint,
    updateCheckpointTrigger,
    addCheckpointTrigger,
    removeCheckpointTrigger,
    updateGoalVerifier,
    updateAdversarial,
    updateExecution,
    updateUpdates,
    updatePhase48Integration,
    updatePhase49Integration,
    updateScheduler,
    updatePrompts,
    updateProjectMemory,
    updateMemory,
    updateMcp,
    updateMcpServer,
    removeMcpServer,
    submitMcpForm,
    openAddMcp,
    openEditMcp,
    updateChannels,
    removeChannel,
    addChannel,
    saveChannelOptions,
    updateGeneral,
    updateBackgroundBehavior,
    updateUi,
    updateSounds,
    updateTrust,
    updateQuality,
    updateExpertise,
    updateSubAgents,
    updateSubAgentsGateRules,
    toggleApiKey,
    handleTestConnection,
  };
}
