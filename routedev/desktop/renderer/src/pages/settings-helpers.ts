// desktop/renderer/src/pages/settings-helpers.ts
// SettingsPage 的纯函数辅助模块（Phase 33 Task 5：提取可测试逻辑）
// 所有配置构造与解析逻辑集中于此，便于单元测试

import type {
  MCPServerEntryConfig,
  ChannelEntryConfig,
  ChannelType,
} from '../../../../src/config/schema.js';

// ===== 通用解析 =====

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
