// src/tools/mcp/client.ts
// MCP 客户端管理器：连接 MCP Server、发现工具、注册到 ToolRegistry
//
// Phase 32 Task 4.2：工具描述注入检测——恶意 MCP server 可能在 description 中塞入指令注入
// Phase 32 Task 4.3：版本号从硬编码 0.8.0 改为从 package.json 读取

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { IToolRegistry } from '../types.js';
import type { MCPServerEntry, MCPConnectionInfo, MCPConnectionStatus } from './types.js';
import type { MCPConfig } from '../../config/schema.js';
import { MCPTool } from './mcp-tool.js';
import { logger } from '../../utils/logger.js';
// Phase 32 Task 4.2：接入 ToolResultSanitizer 的注入检测能力
import { ToolResultSanitizer } from '../result-sanitizer.js';

// Phase 38 修复：版本号通过构建时注入的 __ROUTEDEV_VERSION__ 获取，
// 避免运行时 createRequire('../../../package.json') 在 Electron asar 中失效。
declare const __ROUTEDEV_VERSION__: string;
const ROUTEDEV_VERSION =
  typeof __ROUTEDEV_VERSION__ !== 'undefined' ? __ROUTEDEV_VERSION__ : '0.0.0';

/**
 * C4 修复：MCP 子进程环境变量白名单
 * 仅允许这些变量从 process.env 传递给 MCP server 子进程
 * 防止 API 密钥、数据库凭证等敏感信息泄漏给不可信的 MCP server
 */
const MCP_ALLOWED_ENV_KEYS = new Set([
  // 系统基础变量（子进程运行所必需）
  'PATH', 'HOME', 'USER', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'NODE_ENV', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'ComSpec', 'SystemRoot',
  'TEMP', 'TMP', 'TMPDIR',
  // Git 工具链（部分 MCP server 可能调用 git）
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  // HTTP 代理（部分 MCP server 需要联网）
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]);

/**
 * C4 修复：从 process.env 中按白名单过滤环境变量
 * 防止 MCP server 子进程接收全部 process.env（含 API 密钥等敏感信息）
 */
function filterProcessEnvByWhitelist(): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (MCP_ALLOWED_ENV_KEYS.has(key) && value !== undefined) {
      filtered[key] = value;
    }
  }
  // I24 修复：确保 NODE_ENV 传递给子进程（默认 'production'）
  if (!filtered.NODE_ENV) {
    filtered.NODE_ENV = 'production';
  }
  return filtered;
}

interface ConnectionState {
  client: Client;
  transport: Transport;
  entry: MCPServerEntry;
  status: MCPConnectionStatus;
  tools: MCPTool[];
  error?: string;
  connectedAt?: number;
}

export class MCPClientManager {
  private connections = new Map<string, ConnectionState>();
  private registry: IToolRegistry;
  // Phase 32 Task 4.2：工具描述注入检测器（可选，未设置时跳过检测）
  private sanitizer?: ToolResultSanitizer;
  // MCP 全局配置（C6/I9 使用）
  private mcpConfig?: MCPConfig;
  // I9：重连定时器（serverId → timer）
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // I9：重连尝试次数（serverId → attempts）
  private reconnectAttempts = new Map<string, number>();
  // I9：最大重连次数
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  // I9：初始退避（毫秒）
  private static readonly RECONNECT_INITIAL_DELAY = 1000;
  // I9：最大退避（毫秒）
  private static readonly RECONNECT_MAX_DELAY = 30000;

  constructor(registry: IToolRegistry) {
    this.registry = registry;
  }

  /** Phase 32 Task 4.2：注入 ToolResultSanitizer，用于检测 MCP 工具描述中的注入模式 */
  setSanitizer(sanitizer: ToolResultSanitizer): void {
    this.sanitizer = sanitizer;
  }

  /** C6/I9：注入 MCP 全局配置（connectTimeout / autoReconnect） */
  setMcpConfig(config: MCPConfig): void {
    this.mcpConfig = config;
  }

  async connect(entry: MCPServerEntry): Promise<MCPConnectionInfo> {
    if (this.connections.has(entry.id)) {
      logger.warn(`MCP server "${entry.id}" already connected, disconnecting first`);
      await this.disconnect(entry.id);
    }

    logger.info(`Connecting to MCP server: ${entry.name} (${entry.id})`, {
      transport: entry.config.transport,
    });

    const state: ConnectionState = {
      client: new Client({ name: 'routedev', version: ROUTEDEV_VERSION }),
      transport: this.createTransport(entry),
      entry,
      status: 'connecting',
      tools: [],
    };

    this.connections.set(entry.id, state);

    try {
      // C6 修复：使用 AbortController + setTimeout 实现超时，超时后 abort 并关闭连接
      // 配置：config.mcp?.connectTimeout ?? 30000（entry.connectTimeout 优先）
      const timeout = entry.connectTimeout ?? this.mcpConfig?.connectTimeout ?? 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        await Promise.race([
          state.client.connect(state.transport),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => {
              reject(new Error(`连接超时 (${timeout}ms)`));
            });
          }),
        ]);
      } finally {
        // C6 修复：在 finally 块中清理定时器，防止资源泄漏
        clearTimeout(timer);
      }

      state.status = 'connected';
      state.connectedAt = Date.now();

      await this.discoverTools(entry.id);

      // I9 修复：连接成功后重置重连计数，并设置断连重连回调
      this.reconnectAttempts.delete(entry.id);
      this.setupReconnectHandler(state);

      logger.info(`MCP server connected: ${entry.name}`, {
        toolCount: state.tools.length,
      });

      return this.getConnectionInfo(entry.id)!;
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);

      logger.error(`Failed to connect MCP server: ${entry.name}`, { error: state.error });

      // C6 修复：超时后关闭连接和子进程，防止 socket 泄漏
      try { await state.client.close(); } catch { /* ignore */ }
      this.killChildProcess(state);
      this.connections.delete(entry.id);

      return {
        serverId: entry.id,
        serverName: entry.name,
        status: 'error',
        toolCount: 0,
        error: state.error,
      };
    }
  }

  async disconnect(serverId: string): Promise<void> {
    // I9 修复：取消待定的重连定时器
    this.cancelReconnect(serverId);
    this.reconnectAttempts.delete(serverId);

    const state = this.connections.get(serverId);
    if (!state) {
      logger.warn(`MCP server "${serverId}" not connected`);
      return;
    }

    for (const tool of state.tools) {
      this.registry.unregister(tool.definition.name);
    }

    try {
      await state.client.close();
    } catch (error) {
      logger.warn(`Error closing MCP server: ${serverId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // C6 修复：提取 killChildProcess 为独立方法，复用于 connect 超时和 disconnect
    this.killChildProcess(state);

    this.connections.delete(serverId);
    logger.info(`MCP server disconnected: ${serverId}`);
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.connections.keys());
    await Promise.all(ids.map(id => this.disconnect(id)));
    // I9 修复：清理所有重连定时器
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    logger.info('All MCP servers disconnected');
  }

  getConnectionInfo(serverId: string): MCPConnectionInfo | undefined {
    const state = this.connections.get(serverId);
    if (!state) return undefined;

    return {
      serverId: state.entry.id,
      serverName: state.entry.name,
      status: state.status,
      toolCount: state.tools.length,
      error: state.error,
      connectedAt: state.connectedAt,
    };
  }

  listConnections(): MCPConnectionInfo[] {
    return Array.from(this.connections.keys())
      .map(id => this.getConnectionInfo(id))
      .filter((info): info is MCPConnectionInfo => info !== undefined);
  }

  get connectedCount(): number {
    return Array.from(this.connections.values())
      .filter(s => s.status === 'connected').length;
  }

  get totalToolCount(): number {
    return Array.from(this.connections.values())
      .reduce((sum, s) => sum + s.tools.length, 0);
  }

  private createTransport(entry: MCPServerEntry): Transport {
    if (entry.config.transport === 'stdio') {
      // C4 修复：使用环境变量白名单，防止 API 密钥等敏感信息泄漏给 MCP server 子进程
      // 仅白名单内的系统变量 + entry.config.env 显式声明的变量传递给子进程
      const baseEnv = filterProcessEnvByWhitelist();
      const env = entry.config.env
        ? { ...baseEnv, ...entry.config.env }
        : baseEnv;
      return new StdioClientTransport({
        command: entry.config.command,
        args: entry.config.args,
        env,
        cwd: entry.config.cwd,
      });
    }

    return new SSEClientTransport(
      new URL(entry.config.url),
      {
        requestInit: {
          headers: entry.config.headers,
        },
      },
    );
  }

  private async discoverTools(serverId: string): Promise<void> {
    const state = this.connections.get(serverId);
    if (!state) return;

    // I23 修复：失败时抛出错误，让调用方知道工具发现失败（而非静默返回空数组）
    const result = await state.client.listTools();

    for (const mcpToolDef of result.tools) {
      // Phase 32 Task 4.2：检测工具描述中的注入模式
      // 恶意 MCP server 可在 description 中塞入 "Ignore previous instructions" 等注入指令
      if (this.sanitizer) {
        const descSanitized = this.sanitizer.sanitize('mcp_description', mcpToolDef.description ?? '');
        if (descSanitized.injectionDetected) {
          logger.warn(`MCP tool "${mcpToolDef.name}" description 中检测到注入模式，已跳过注册`, {
            server: state.entry.name,
            patterns: descSanitized.patterns,
          });
          continue;
        }
      }

      const namespacedName = `mcp__${serverId}__${mcpToolDef.name}`;

      const mcpTool = new MCPTool(
        namespacedName,
        mcpToolDef,
        state.client,
        state.entry,
      );

      this.registry.register(mcpTool);
      state.tools.push(mcpTool);

      logger.debug('MCP tool registered', {
        name: namespacedName,
        server: state.entry.name,
        originalName: mcpToolDef.name,
      });
    }
    // I23 修复：移除 try-catch 静默吞错，让异常向上抛出
  }

  /**
   * C6 修复：强制杀掉子进程，避免孤儿进程锁定文件
   * 从 disconnect 提取为独立方法，复用于 connect 超时清理
   */
  private killChildProcess(state: ConnectionState): void {
    try {
      const transport = (state.client as unknown as { transport?: { child?: { kill?: () => void; killed?: boolean; pid?: number } } }).transport;
      const child = transport?.child;
      if (child && typeof child.kill === 'function' && !child.killed) {
        child.kill();
        logger.info(`MCP server "${state.entry.id}" child process killed`);
      }
    } catch (error) {
      logger.warn(`Error killing MCP child process: ${state.entry.id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * I9 修复：设置断连重连回调
   * 监听 transport 的 onclose 事件，连接断开时触发指数退避重连
   */
  private setupReconnectHandler(state: ConnectionState): void {
    const autoReconnect = this.mcpConfig?.autoReconnect ?? true;
    if (!autoReconnect) return;

    const entry = state.entry;
    const transport = state.transport;

    // 保存原始 onclose（如有），在重连回调中调用
    const originalOnclose = transport.onclose;
    transport.onclose = () => {
      if (originalOnclose) {
        try { originalOnclose(); } catch { /* ignore */ }
      }
      logger.info(`MCP server "${entry.id}" connection closed, scheduling reconnect`);
      const current = this.connections.get(entry.id);
      if (current) {
        current.status = 'disconnected';
      }
      this.scheduleReconnect(entry);
    };
  }

  /**
   * I9 修复：指数退避重连
   * 初始 1s，最大 30s，最多 10 次
   * 配置：config.mcp?.autoReconnect ?? true
   */
  private scheduleReconnect(entry: MCPServerEntry): void {
    const autoReconnect = this.mcpConfig?.autoReconnect ?? true;
    if (!autoReconnect) return;

    // 取消已有的重连定时器
    this.cancelReconnect(entry.id);

    const attempts = (this.reconnectAttempts.get(entry.id) ?? 0) + 1;
    if (attempts > MCPClientManager.MAX_RECONNECT_ATTEMPTS) {
      logger.warn(`MCP server "${entry.id}" reached max reconnect attempts (${MCPClientManager.MAX_RECONNECT_ATTEMPTS}), giving up`);
      this.reconnectAttempts.delete(entry.id);
      return;
    }

    this.reconnectAttempts.set(entry.id, attempts);

    // 指数退避：1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s, 30s, 30s
    const delay = Math.min(
      MCPClientManager.RECONNECT_INITIAL_DELAY * Math.pow(2, attempts - 1),
      MCPClientManager.RECONNECT_MAX_DELAY,
    );

    logger.info(`Scheduling reconnect for MCP server "${entry.id}" in ${delay}ms (attempt ${attempts}/${MCPClientManager.MAX_RECONNECT_ATTEMPTS})`);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(entry.id);
      this.connect(entry)
        .then((info) => {
          if (info.status === 'connected') {
            // 重连成功，重置计数
            this.reconnectAttempts.delete(entry.id);
            logger.info(`MCP server "${entry.id}" reconnected successfully`);
          } else {
            // 重连失败，继续重试
            logger.warn(`MCP server "${entry.id}" reconnect failed: ${info.error}`);
            this.scheduleReconnect(entry);
          }
        })
        .catch((err) => {
          logger.error(`MCP server "${entry.id}" reconnect error`, {
            error: err instanceof Error ? err.message : String(err),
          });
          this.scheduleReconnect(entry);
        });
    }, delay);

    this.reconnectTimers.set(entry.id, timer);
  }

  /**
   * I9 修复：取消待定的重连定时器
   */
  private cancelReconnect(serverId: string): void {
    const timer = this.reconnectTimers.get(serverId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(serverId);
    }
  }
}
