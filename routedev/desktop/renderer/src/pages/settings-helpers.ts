// desktop/renderer/src/pages/settings-helpers.ts
// SettingsPage 的纯函数辅助模块（Phase 33 Task 5：提取可测试逻辑）
// 所有配置构造与解析逻辑集中于此，便于单元测试

import type {
  AppConfig,
  ProviderConfig,
  ModelConfig,
  RouterRule,
  MCPServerEntryConfig,
} from '../../../shared/config-types.js';
// 导入 AgentRole / AgentOutputFormat，使 AgentProfileUI 与持久层类型同源
import type { AgentRole, AgentOutputFormat } from '../../../../src/agents/profiles/types.js';
// V2-006 修复：ESM 环境下 require() 失效，改用 ESM import 读取 package.json
// 路径：desktop/renderer/src/pages/ → ../../../../ = routedev/（package.json 所在）
// resolveJsonModule 已在 desktop/tsconfig.desktop.json 中启用
import pkg from '../../../../package.json';

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
  // 支持全部 5 种传输类型（与 MCPTransportSchema 对齐）
  transport: 'stdio' | 'http' | 'sse' | 'streamable_http' | 'websocket';
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
  /** 会话生命周期策略（空字符串表示使用全局默认） */
  lifecyclePolicy: '' | 'per-call' | 'per-session' | 'persistent';
  /** 来源标注（导入时填写，编辑时保留原值） */
  origin: string;
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
  lifecyclePolicy: '',
  origin: '',
};

/**
 * 从表单状态构造 MCPServerEntryConfig
 * 根据 transport 类型组装正确的 config 对象
 *
 * 修复要点：
 * - 不再强制把非 stdio 的 transport 改成 'http'，保留表单原始 transport
 *   （支持 http / sse / streamable_http / websocket 四种非 stdio 传输）
 * - 保留 lifecyclePolicy 和 origin 字段，避免编辑后丢失
 */
export function constructMcpServer(form: McpFormState): MCPServerEntryConfig {
  let config: MCPServerEntryConfig['config'];
  if (form.transport === 'stdio') {
    config = {
      transport: 'stdio',
      command: form.command,
      args: parseStringList(form.args),
      ...(form.env.trim() ? { env: parseKeyValuePairs(form.env) } : {}),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
    };
  } else {
    // 非 stdio 传输（http / sse / streamable_http / websocket）：保留原始 transport
    // 四种传输在 schema 中结构相同（url + headers），但 transport 字面量必须保留
    config = {
      transport: form.transport,
      url: form.url,
      ...(form.headers.trim() ? { headers: parseKeyValuePairs(form.headers) } : {}),
    } as MCPServerEntryConfig['config'];
  }

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

  // 保留 lifecyclePolicy（空字符串表示使用全局默认，不写入）
  if (form.lifecyclePolicy) {
    entry.lifecyclePolicy = form.lifecyclePolicy;
  }
  // 保留 origin（来源标注，编辑时不应丢失）
  if (form.origin) {
    entry.origin = form.origin;
  }

  return entry;
}

/**
 * 从已有的 MCPServerEntryConfig 回填表单状态
 * 用于编辑已有服务器时预填表单
 *
 * 修复要点：
 * - 非 stdio 传输保留原始 transport 字面量（不再统一改写为 'http'）
 * - 回填 lifecyclePolicy 和 origin，避免编辑保存后这两个字段丢失
 */
export function mcpServerToForm(server: MCPServerEntryConfig): McpFormState {
  const config = server.config;
  // 公共字段：lifecyclePolicy / origin / connectTimeout 在所有传输类型下都需回填
  const common = {
    id: server.id,
    name: server.name,
    command: '',
    url: '',
    args: '',
    env: '',
    cwd: '',
    headers: '',
    connectTimeout: server.connectTimeout ? String(server.connectTimeout) : '',
    lifecyclePolicy: (server.lifecyclePolicy ?? '') as McpFormState['lifecyclePolicy'],
    origin: server.origin ?? '',
  };
  if (config.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: config.command,
      args: config.args.join(', '),
      env: keyValueToText(config.env),
      cwd: config.cwd ?? '',
    };
  }
  // 非 stdio 传输（http / sse / streamable_http / websocket）：保留原始 transport
  return {
    ...common,
    transport: config.transport,
    url: config.url,
    headers: keyValueToText(config.headers),
  };
}

// ===== 版本号 =====

/**
 * 从 package.json 读取应用版本号
 * 避免在 SettingsPage 中硬编码版本号
 *
 * V2-006 修复：原 require() 在 ESM 环境下失效，改用顶层 ESM import。
 * Vite 构建时会将 package.json 内联；测试环境下 import 由 vitest 处理。
 */
export function getAppVersion(): string {
  return pkg.version ?? '0.0.0';
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
  // 与持久层 AgentRole 同源，支持 planner/verifier/synthesizer/review-planner 等全部角色
  role: AgentRole;
  modelId: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  forbiddenTools: string[];
  canChallenge: boolean;
  challengeSeverity: 'blocking' | 'warning';
  // 与持久层 AgentOutputFormat 同源，支持 task_plan/verification_report/synthesis_report 等
  outputFormat: AgentOutputFormat;
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
  // Bug 修复：不再过滤掩码 apiKey（含 **** 模式），掩码 provider 传入主进程，
  // 由主进程的掩码回填逻辑用磁盘真实值替换，避免渲染层过滤导致 providers 清空
  // name 为空时自动用 id 作为 name，避免用户只填了部分字段导致被过滤
  const validProviders: ProviderConfig[] = draft.providers
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
  // Bug 修复：providers 为空时保留原 fallbackChain，避免因 providers 被过滤导致降级链丢失
  const cleanedFallbackChain = cleanedProviders.length === 0
    ? (draft.router.fallbackChain ?? [])
    : (draft.router.fallbackChain ?? [])
        .map((id) => id.trim())
        .filter((id) => id && configuredModelIds.has(id));
  return {
    ...draft,
    providers: cleanedProviders,
    router: { ...draft.router, rules: cleanedRules, fallbackChain: cleanedFallbackChain },
  };
}
