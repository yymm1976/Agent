// desktop/renderer/src/pages/settings-helpers.ts
// SettingsPage 的纯函数辅助模块（Phase 33 Task 5：提取可测试逻辑）
// 所有配置构造与解析逻辑集中于此，便于单元测试

import type {
  AppConfig,
  ProviderConfig,
  ModelConfig,
  RouterRule,
  MCPServerEntryConfig,
  ChannelEntryConfig,
  ChannelType,
} from '../../../shared/config-types.js';

// ===== 通用解析 =====

/**
 * 深拷贝对象（使用 structuredClone 保留 undefined 字段）
 * Phase 74-G：从 SettingsPage.tsx 迁移，供 useSettingsDraft 与 handleSave 共用
 */
export function deepClone<T>(obj: T): T {
  // 使用 structuredClone 保留 undefined 字段，避免配置导入后字段丢失
  if (typeof structuredClone === 'function') {
    return structuredClone(obj);
  }
  // 降级：旧环境无 structuredClone 时仍用 JSON 方式
  return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * 逗号分隔字符串转数组（过滤空值）
 * 用于 commandBlacklist、capabilities 等字段的表单输入
 */
export function parseStringList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * key=value 文本转对象（每行一个键值对）
 * 用于 MCP env/headers 等字段的表单输入
 * 空行和只有 key 没有 value 的行被过滤
 */
export function parseKeyValuePairs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue; // 没有 = 或 = 在开头（key 为空）
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!key) continue;
    result[key] = value;
  }
  return result;
}

/**
 * 对象转 key=value 文本（每行一个键值对）
 * 用于回填表单时将已有的 env/headers 对象转为文本
 */
export function keyValueToText(obj: Record<string, string> | undefined): string {
  if (!obj) return '';
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

// ===== MCP 服务器配置构造 =====

/** MCP 表单状态（添加/编辑共用） */
export interface McpFormState {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  url: string;
  /** 逗号分隔的参数字符串 */
  args: string;
  /** key=value 文本（每行一个） */
  env: string;
  /** 工作目录 */
  cwd: string;
  /** key=value 文本（每行一个） */
  headers: string;
  /** 连接超时毫秒，空字符串表示不设置 */
  connectTimeout: string;
}

/** 空白 MCP 表单 */
export const EMPTY_MCP_FORM: McpFormState = {
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  url: '',
  args: '',
  env: '',
  cwd: '',
  headers: '',
  connectTimeout: '',
};

/**
 * 从表单状态构造 MCPServerEntryConfig
 * 根据 transport 类型组装正确的 config 对象
 */
export function constructMcpServer(form: McpFormState): MCPServerEntryConfig {
  const config: MCPServerEntryConfig['config'] =
    form.transport === 'stdio'
      ? {
          transport: 'stdio',
          command: form.command,
          args: parseStringList(form.args),
          ...(form.env.trim() ? { env: parseKeyValuePairs(form.env) } : {}),
          ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
        }
      : {
          transport: 'http',
          url: form.url,
          ...(form.headers.trim() ? { headers: parseKeyValuePairs(form.headers) } : {}),
        };

  const entry: MCPServerEntryConfig = {
    id: form.id,
    name: form.name,
    enabled: true,
    config,
  };

  const timeout = form.connectTimeout.trim();
  if (timeout) {
    const num = Number(timeout);
    if (Number.isFinite(num) && num > 0) {
      entry.connectTimeout = num;
    }
  }

  return entry;
}

/**
 * 从已有的 MCPServerEntryConfig 回填表单状态
 * 用于编辑已有服务器时预填表单
 */
export function mcpServerToForm(server: MCPServerEntryConfig): McpFormState {
  const config = server.config;
  if (config.transport === 'stdio') {
    return {
      id: server.id,
      name: server.name,
      transport: 'stdio',
      command: config.command,
      url: '',
      args: config.args.join(', '),
      env: keyValueToText(config.env),
      cwd: config.cwd ?? '',
      headers: '',
      connectTimeout: server.connectTimeout ? String(server.connectTimeout) : '',
    };
  }
  return {
    id: server.id,
    name: server.name,
    transport: 'http',
    command: '',
    url: config.url,
    args: '',
    env: '',
    cwd: '',
    headers: keyValueToText(config.headers),
    connectTimeout: server.connectTimeout ? String(server.connectTimeout) : '',
  };
}

// ===== 渠道 options 配置 =====

/** 渠道凭据字段定义 */
export interface ChannelOptionField {
  key: string;
  label: string;
  /** 是否为敏感字段（密码类型） */
  sensitive: boolean;
  /** 是否必填 */
  required: boolean;
  /** 说明文字 */
  hint: string;
}

/**
 * 获取指定渠道类型的凭据字段定义
 * 不同渠道需要不同的 options key
 */
export function getChannelOptionFields(type: ChannelType): ChannelOptionField[] {
  switch (type) {
    case 'telegram':
      return [
        { key: 'botToken', label: 'Bot Token', sensitive: true, required: true, hint: '从 @BotFather 获取，格式 123456:ABC-DEF...' },
        { key: 'allowedUserIds', label: '允许的用户 ID', sensitive: false, required: false, hint: '逗号分隔的 Telegram user ID，留空不限制' },
        { key: 'pollIntervalMs', label: '轮询间隔(ms)', sensitive: false, required: false, hint: '长轮询间隔，默认 1000' },
      ];
    case 'wechat-work':
      return [
        { key: 'corpId', label: '企业 ID', sensitive: false, required: true, hint: '企业微信管理后台获取' },
        { key: 'corpSecret', label: '应用密钥', sensitive: true, required: true, hint: '与 corpId 配合，用于获取 access_token' },
        { key: 'token', label: '验证 Token', sensitive: true, required: true, hint: '用于签名验证（生产模式必须配置）' },
        { key: 'encodingAESKey', label: 'AES 密钥', sensitive: true, required: false, hint: '43 字符 EncodingAESKey，启用消息加解密' },
        { key: 'agentId', label: '应用 AgentId', sensitive: false, required: false, hint: '发送消息时需要' },
      ];
    case 'slack':
      return [
        { key: 'botToken', label: 'Bot Token', sensitive: true, required: true, hint: '格式 xoxb-...，从 Slack App 获取' },
        { key: 'signingSecret', label: 'Signing Secret', sensitive: true, required: false, hint: '用于请求签名验证（生产模式必须配置）' },
        { key: 'appToken', label: 'App Token', sensitive: true, required: false, hint: '格式 xapp-...，Socket Mode 需要' },
      ];
    default:
      return [];
  }
}

/**
 * 检查渠道类型是否有适配器实现
 * discord 类型已从 ChannelTypeSchema 移除，所有合法类型均有适配器实现
 */
export function isChannelTypeSupported(_type: ChannelType): boolean {
  return true;
}

/**
 * 从表单字段构造渠道 options 对象
 * 过滤掉空值
 */
export function constructChannelOptions(
  type: ChannelType,
  formValues: Record<string, string>,
): Record<string, string> {
  const fields = getChannelOptionFields(type);
  const options: Record<string, string> = {};
  for (const field of fields) {
    const value = formValues[field.key]?.trim();
    if (value) {
      options[field.key] = value;
    }
  }
  return options;
}

/**
 * 构造完整的 ChannelEntryConfig
 */
export function constructChannelEntry(
  id: string,
  type: ChannelType,
  formValues: Record<string, string>,
): ChannelEntryConfig {
  return {
    id,
    type,
    enabled: true,
    options: constructChannelOptions(type, formValues),
  };
}

// ===== 版本号 =====

/**
 * 从 package.json 读取应用版本号
 * 避免在 SettingsPage 中硬编码版本号
 */
export function getAppVersion(): string {
  try {
    // Vite 构建时会将 package.json 内联，运行时可直接读取
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../../package.json');
    return pkg.version ?? '0.0.0';
  } catch {
    // 降级：如果 require 失败（如测试环境），返回占位值
    return '0.0.0';
  }
}

// ===== 配置常量（Phase 74-G：从 SettingsPage.tsx 迁移，供 hook 与组件共用） =====

/** 空白 Provider 模板 */
export const EMPTY_PROVIDER: ProviderConfig = {
  id: '',
  name: '',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  models: [],
};

/** 空白 Model 模板 */
export const EMPTY_MODEL: ModelConfig = {
  id: '',
  name: '',
  provider: '',
  tier: 'medium',
  contextWindow: 128000,
  capabilities: [],
  latencyMs: 0,
  available: true,
};

/** 空白路由规则模板 */
export const EMPTY_RULE: RouterRule = {
  tier: 'simple',
  modelId: '',
};

/**
 * 子 Agent Profile UI 类型（与 src/agents/profiles/types.ts 中的 AgentProfile 对应，
 * 此处仅用于 SettingsPage 展示与本地编辑，不直接依赖 src/ 类型避免跨工程导入）
 */
export interface AgentProfileUI {
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

/** 网络搜索引擎配置表（下拉选择式） */
export const SEARCH_ENGINES = [
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

// ===== 保存前清理 =====

/**
 * 检测掩码 API Key（maskApiKey 产生的格式为 "首4****尾4" 或 "****"）
 * G-001：渲染层在保存前过滤掩码 key，避免掩码值覆盖磁盘真实密钥
 * 掩码 key 的 provider 不应被包含在 cleanedDraft 中，让主进程保留磁盘真实值
 */
function isMaskedApiKey(key: string): boolean {
  return key.includes('****');
}

/**
 * 保存前清理 draft：过滤空 provider/model、修复路由规则 modelId、过滤 fallbackChain
 * Phase 74-G：从 SettingsPage.handleSave 抽离的纯函数（原 L1048-1103）
 *
 * 清理逻辑：
 * 1. 过滤掉 apiKey 为空的 provider，name 为空时自动用 id 作为 name
 * 2. 过滤掉每个 provider 下 id 为空的 model，name 为空时自动用 id
 * 3. 修复路由规则：将 unconfigured 或不存在的 modelId 替换为已配置的模型
 * 4. 过滤 fallbackChain：仅保留指向已配置模型的 id（UI draft 保留空项避免编辑被打断）
 *
 * @param draft 原始 draft 配置（不会被修改）
 * @returns 清理后的 draft，可直接传给 saveConfig
 */
export function cleanDraftForSave(draft: AppConfig): AppConfig {
  // 保存前清理：过滤掉 apiKey 为空的 provider（apiKey 是最关键字段）
  // G-001：同时过滤掩码 apiKey（含 **** 模式），掩码 provider 不传入 saveConfig，
  // 让主进程保留磁盘真实值，避免掩码字符串覆盖真实密钥
  // name 为空时自动用 id 作为 name，避免用户只填了部分字段导致被过滤
  const validProviders: ProviderConfig[] = draft.providers
    .filter((p) => p.apiKey.trim() && !isMaskedApiKey(p.apiKey.trim()))
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
  const cleanedRules: RouterRule[] = draft.router.rules.map((rule) => {
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
  return {
    ...draft,
    providers: cleanedProviders,
    router: { ...draft.router, rules: cleanedRules, fallbackChain: cleanedFallbackChain },
  };
}
