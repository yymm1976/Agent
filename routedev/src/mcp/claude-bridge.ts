// src/mcp/claude-bridge.ts
// Claude Code MCP 配置桥接器（Phase 48 Task 4）
//
// 设计目标：
//   1. 导入 Claude Code .mcp.json 到 RouteDev MCPConfig
//      - 覆盖 5 种 transport：stdio / http / sse / streamable_http / websocket
//      - 字段映射：command/args/env/cwd、url/headers、timeout→connectTimeout
//      - SonettoHere YAML 扩展字段 persistent:true → lifecyclePolicy:'persistent'
//   2. ID 冲突处理（陷阱 #131）：原 ID 冲突时加 claude- 前缀，再追加 -2、-3 后缀
//   3. 部分失败容错（陷阱 #137）：不支持的 transport 明确记入 failed，不静默降级，
//      桥接失败的 server 不影响其他 server 导入
//   4. 导出到 Claude Code .mcp.json 格式（仅 stdio/http，其余记入 skipped）
//   5. 自动发现：项目级 .mcp.json → 用户级 ~/.claude/.mcp.json
//
// 注意：不使用 zod 严格校验导入的 Claude Code 配置——其字段松散，
// 严格校验会拒绝很多合法配置。这里用手工校验 + 类型守卫。
//
// 来源：Phase 48 Task 4 蓝图 4.1-4.6

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../utils/logger.js';
import type {
  MCPServerEntry,
  MCPServerConfig,
  MCPLifecyclePolicy,
  MCPStdioConfig,
  MCPHttpConfig,
  MCPSseConfig,
  MCPStreamableHttpConfig,
  MCPWebsocketConfig,
} from '../tools/mcp/types.js';

// ============================================================
// 类型定义
// ============================================================

/** Claude Code .mcp.json 中的 server 配置（loose 类型，导入时手工校验） */
export type ClaudeMcpServerConfig = {
  /** 传输类型：'http' | 'stdio' | 'sse' | 'streamable_http' | 'websocket' */
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  timeout?: number;
  /** SonettoHere YAML 扩展字段：持久连接 */
  persistent?: boolean;
};

/** Claude Code .mcp.json 顶层结构：serverName → serverConfig */
export type ClaudeMcpConfig = Record<string, ClaudeMcpServerConfig>;

/** 导入选项 */
export interface BridgeImportOptions {
  /** 来源标注（默认 'claude-code'） */
  origin?: string;
  /** 已存在的 server ID 集合，用于冲突检测 */
  existingIds?: Set<string>;
  /** 默认生命周期策略（未指定时使用，默认 'per-session'） */
  defaultLifecycle?: 'per-call' | 'per-session' | 'persistent';
}

/** 导入结果 */
export interface BridgeImportResult {
  servers: MCPServerEntry[];
  /** ID 冲突重命名记录 */
  renamed: Array<{ originalId: string; newId: string; reason: string }>;
  /** 桥接失败的 server（不影响其他 server） */
  failed: Array<{ id: string; error: string }>;
  warnings: string[];
}

/** 导出结果 */
export interface BridgeExportResult {
  /** JSON 字符串 */
  content: string;
  /** 无法导出的 server */
  skipped: Array<{ id: string; reason: string }>;
}

// ============================================================
// 常量
// ============================================================

/** Claude Code .mcp.json 支持的 transport 类型 */
const SUPPORTED_TRANSPORTS = new Set<string>([
  'stdio',
  'http',
  'sse',
  'streamable_http',
  'websocket',
]);

/** 默认来源标注 */
const DEFAULT_ORIGIN = 'claude-code';

/** 默认生命周期策略 */
const DEFAULT_LIFECYCLE: MCPLifecyclePolicy = 'per-session';

/** 项目级配置文件名 */
const PROJECT_CONFIG_NAME = '.mcp.json';

/** 用户级配置目录名 */
const USER_CONFIG_DIR = '.claude';

// ============================================================
// 工具函数
// ============================================================

/**
 * 解析唯一 ID（陷阱 #131）
 *
 * 规则：
 *   1. 原 ID 不冲突 → 直接使用
 *   2. 冲突 → 加 claude- 前缀
 *   3. 仍冲突 → 追加 -2、-3... 后缀
 *   4. 超过 99 次尝试 → 用时间戳兜底
 *
 * 注意：会修改 existing 集合（添加最终选定的 ID），便于批量导入时
 * 后续 server 不会与同批次已分配的 ID 冲突。
 */
function resolveUniqueId(originalId: string, existing: Set<string>): string {
  if (!existing.has(originalId)) {
    existing.add(originalId);
    return originalId;
  }
  // 加 origin 前缀
  const prefixed = `claude-${originalId}`;
  if (!existing.has(prefixed)) {
    existing.add(prefixed);
    return prefixed;
  }
  // 追加 -2、-3...
  for (let i = 2; i < 100; i++) {
    const candidate = `${prefixed}-${i}`;
    if (!existing.has(candidate)) {
      existing.add(candidate);
      return candidate;
    }
  }
  // 兜底：时间戳
  const fallback = `${prefixed}-${Date.now()}`;
  existing.add(fallback);
  return fallback;
}

/**
 * 将 Claude Code server 配置转换为 RouteDev MCPServerConfig
 *
 * 返回 [config, errorMessage]：成功时 errorMessage 为 undefined，
 * 失败时 config 为 undefined。
 */
function mapServerConfig(
  raw: ClaudeMcpServerConfig,
  id: string,
): [MCPServerConfig | undefined, string | undefined] {
  const type = raw.type;

  // type 缺失
  if (!type) {
    return [undefined, `server "${id}" missing 'type' field`];
  }

  // type 不支持（陷阱 #137：明确记入 failed，不静默降级）
  if (!SUPPORTED_TRANSPORTS.has(type)) {
    return [undefined, `server "${id}" unsupported transport type: ${type}`];
  }

  if (type === 'stdio') {
    if (!raw.command || typeof raw.command !== 'string') {
      return [undefined, `server "${id}" stdio transport requires 'command' field`];
    }
    const config: MCPStdioConfig = {
      transport: 'stdio',
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args : [],
    };
    if (raw.env) config.env = raw.env;
    if (raw.cwd) config.cwd = raw.cwd;
    return [config, undefined];
  }

  // URL 类 transport：http / sse / streamable_http / websocket
  if (!raw.url || typeof raw.url !== 'string') {
    return [undefined, `server "${id}" ${type} transport requires 'url' field`];
  }

  // 分别构造各 url 类型，确保联合类型正确收窄
  let config: MCPServerConfig;
  if (type === 'http') {
    const c: MCPHttpConfig = { transport: 'http', url: raw.url };
    if (raw.headers) c.headers = raw.headers;
    config = c;
  } else if (type === 'sse') {
    const c: MCPSseConfig = { transport: 'sse', url: raw.url };
    if (raw.headers) c.headers = raw.headers;
    config = c;
  } else if (type === 'streamable_http') {
    const c: MCPStreamableHttpConfig = { transport: 'streamable_http', url: raw.url };
    if (raw.headers) c.headers = raw.headers;
    config = c;
  } else {
    // websocket（已在上方校验属于 SUPPORTED_TRANSPORTS）
    const c: MCPWebsocketConfig = { transport: 'websocket', url: raw.url };
    if (raw.headers) c.headers = raw.headers;
    config = c;
  }
  return [config, undefined];
}

// ============================================================
// ClaudeMCPBridge
// ============================================================

/**
 * Claude Code MCP 配置桥接器
 *
 * 用法：
 *   const bridge = new ClaudeMCPBridge();
 *   const result = await bridge.importFromClaudeConfig('/path/to/.mcp.json', {
 *     existingIds: new Set(existingServerIds),
 *   });
 *   // result.servers 可直接写入 RouteDev MCPConfig.servers
 *
 *   const exportResult = bridge.exportToClaudeConfig(servers);
 *   await fs.writeFile('.mcp.json', exportResult.content);
 *
 * 设计要点：
 *   - importFromObject 为纯函数式（不读文件），便于单元测试
 *   - 单个 server 桥接失败时记入 failed，不中断整体导入（部分容错）
 *   - 不支持的 transport 明确记入 failed，不静默降级（陷阱 #137）
 *   - ID 冲突时自动重命名并记录（陷阱 #131）
 */
export class ClaudeMCPBridge {
  /**
   * 从 Claude Code .mcp.json 文件导入
   *
   * 步骤：
   *   1. 读取并解析 JSON
   *   2. 调用 importFromObject 转换
   *
   * 文件不存在或 JSON 解析失败时返回空 servers + failed 记录（不抛异常）
   */
  async importFromClaudeConfig(
    configPath: string,
    options?: BridgeImportOptions,
  ): Promise<BridgeImportResult> {
    let raw: string;
    try {
      raw = await fs.readFile(configPath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('ClaudeMCPBridge: failed to read config file', { configPath, error: msg });
      return {
        servers: [],
        renamed: [],
        failed: [{ id: configPath, error: `failed to read file: ${msg}` }],
        warnings: [],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('ClaudeMCPBridge: failed to parse JSON', { configPath, error: msg });
      return {
        servers: [],
        renamed: [],
        failed: [{ id: configPath, error: `invalid JSON: ${msg}` }],
        warnings: [],
      };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        servers: [],
        renamed: [],
        failed: [{ id: configPath, error: 'top-level JSON must be an object' }],
        warnings: [],
      };
    }

    return this.importFromObject(parsed as ClaudeMcpConfig, options);
  }

  /**
   * 从 ClaudeMcpConfig 对象导入（不读文件，便于单元测试）
   *
   * 对每个 server：
   *   1. 转换 transport 类型、字段映射
   *   2. 生成唯一 ID（冲突时重命名）
   *   3. 不支持的 transport / 缺失必需字段 → 记入 failed
   *   4. 桥接失败的 server 不影响其他 server 导入
   */
  importFromObject(
    config: ClaudeMcpConfig,
    options?: BridgeImportOptions,
  ): BridgeImportResult {
    const origin = options?.origin ?? DEFAULT_ORIGIN;
    const defaultLifecycle: MCPLifecyclePolicy =
      options?.defaultLifecycle ?? DEFAULT_LIFECYCLE;

    // 复制 existingIds（避免修改调用方传入的 Set），并用于批量内冲突检测
    const usedIds = new Set<string>(options?.existingIds ?? []);

    const servers: MCPServerEntry[] = [];
    const renamed: Array<{ originalId: string; newId: string; reason: string }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    const warnings: string[] = [];

    for (const [originalId, raw] of Object.entries(config)) {
      // 跳过非对象条目（如原型链污染或格式错误）
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        failed.push({ id: originalId, error: 'server config must be an object' });
        continue;
      }

      const [serverConfig, errMsg] = mapServerConfig(raw, originalId);
      if (!serverConfig || errMsg) {
        failed.push({ id: originalId, error: errMsg ?? 'unknown error' });
        continue;
      }

      // 生成唯一 ID
      const newId = resolveUniqueId(originalId, usedIds);
      if (newId !== originalId) {
        renamed.push({
          originalId,
          newId,
          reason: `id "${originalId}" conflicts with existing server, renamed to "${newId}"`,
        });
      }

      // 生命周期策略：SonettoHere persistent:true → 'persistent'，否则用默认值
      const lifecyclePolicy: MCPLifecyclePolicy =
        raw.persistent === true ? 'persistent' : defaultLifecycle;

      servers.push({
        id: newId,
        name: originalId,
        enabled: true,
        config: serverConfig,
        ...(raw.timeout !== undefined && typeof raw.timeout === 'number'
          ? { connectTimeout: raw.timeout }
          : {}),
        lifecyclePolicy,
        origin,
      });
    }

    if (failed.length > 0) {
      logger.info('ClaudeMCPBridge: import completed with failures', {
        imported: servers.length,
        failed: failed.length,
      });
    }

    return { servers, renamed, failed, warnings };
  }

  /**
   * 导出到 Claude Code .mcp.json 格式
   *
   * Claude Code 基础格式只支持 type: "stdio" 和 type: "http"。
   * sse / streamable_http / websocket 等独立类型无法直接导出，记入 skipped。
   *
   * 字段映射（反向）：
   *   - stdio：command / args / env / cwd / timeout（来自 connectTimeout）
   *   - http：url / headers / timeout
   *
   * @returns JSON 字符串（pretty-printed）+ skipped 列表
   */
  exportToClaudeConfig(servers: MCPServerEntry[]): BridgeExportResult {
    const out: ClaudeMcpConfig = {};
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const entry of servers) {
      const cfg = entry.config;
      if (cfg.transport === 'stdio') {
        const c: ClaudeMcpServerConfig = {
          type: 'stdio',
          command: cfg.command,
          args: cfg.args,
        };
        if (cfg.env) c.env = cfg.env;
        if (cfg.cwd) c.cwd = cfg.cwd;
        if (entry.connectTimeout !== undefined) c.timeout = entry.connectTimeout;
        out[entry.id] = c;
      } else if (cfg.transport === 'http') {
        const c: ClaudeMcpServerConfig = {
          type: 'http',
          url: cfg.url,
        };
        if (cfg.headers) c.headers = cfg.headers;
        if (entry.connectTimeout !== undefined) c.timeout = entry.connectTimeout;
        out[entry.id] = c;
      } else {
        // sse / streamable_http / websocket：Claude Code 基础格式不支持
        skipped.push({
          id: entry.id,
          reason: `transport "${cfg.transport}" not supported by Claude Code .mcp.json basic format`,
        });
      }
    }

    const content = JSON.stringify(out, null, 2);
    return { content, skipped };
  }

  /**
   * 自动发现 Claude Code 配置文件
   *
   * 扫描顺序：
   *   1. 项目级：<projectRoot>/.mcp.json
   *   2. 用户级：<homeDir>/.claude/.mcp.json（homeDir 默认 os.homedir()）
   *
   * 返回找到的所有配置文件绝对路径（按扫描顺序）。
   *
   * @param projectRoot 项目根目录绝对路径
   * @param homeDir 用户主目录（可选，便于测试注入；默认 os.homedir()）
   */
  async discoverClaudeConfigs(projectRoot: string, homeDir?: string): Promise<string[]> {
    const found: string[] = [];
    const home = homeDir ?? os.homedir();

    // 1. 项目级
    const projectConfig = path.join(projectRoot, PROJECT_CONFIG_NAME);
    if (fsSync.existsSync(projectConfig)) {
      found.push(projectConfig);
    }

    // 2. 用户级
    const userConfig = path.join(home, USER_CONFIG_DIR, PROJECT_CONFIG_NAME);
    if (fsSync.existsSync(userConfig)) {
      found.push(userConfig);
    }

    return found;
  }
}
