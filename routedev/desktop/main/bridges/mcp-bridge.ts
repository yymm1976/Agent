// desktop/main/bridges/mcp-bridge.ts
// MCP 领域 delegate：负责 MCP 服务器安装/连接/断开与状态/工具查询
// 原 RouteDevEngine.installServer / connectServer / disconnectServer / getMCPStatus / listMCPTools 委托至此。

import type {
  MCPStatus,
  MCPConnectionResult,
  MCPInstallPayload,
  MCPInstallResult,
} from '../../shared/ipc-types.js';
import { getCatalogEntry } from '../mcp-catalog.js';
import type { MCPServerEntry } from '../../../src/tools/mcp/types.js';
import type { EngineContext, MCPToolInfo } from './engine-context.js';

/**
 * MCP 领域桥接器
 *
 * 持有 EngineContext 引用，通过 ctx.deps.mcpManager / ctx.config.mcp.servers 操作 MCP 服务器。
 */
export class MCPBridge {
  constructor(private ctx: EngineContext) {}

  /** 获取 MCP 连接状态（供 IPC mcp:status 与 /mcp 命令调用） */
  getMCPStatus(): MCPStatus {
    if (!this.ctx.deps) return { connected: false, servers: [] };
    const servers = this.ctx.deps.mcpManager.listConnections().map((s) => ({
      id: s.serverId,
      connected: s.status === 'connected',
      error: s.error,
    }));
    return {
      connected: servers.some((s) => s.connected),
      servers,
    };
  }

  /** 列出所有已连接 MCP 服务器的工具 */
  listMCPTools(): MCPToolInfo[] {
    if (!this.ctx.deps) return [];
    const tools: MCPToolInfo[] = [];
    for (const tool of this.ctx.deps.registry.list()) {
      const name = tool.definition.name;
      // MCP 工具命名规则：mcp__<serverId>__<toolName>
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        if (parts.length >= 3) {
          tools.push({
            name,
            description: tool.definition.description ?? '',
            serverId: parts[1],
          });
        }
      }
    }
    return tools;
  }

  /** 连接指定 MCP 服务器（根据 config 中的 server 配置） */
  async connectServer(serverId: string): Promise<MCPConnectionResult> {
    if (!this.ctx.deps) return { success: false, error: '引擎未初始化' };
    const server = this.ctx.config.mcp.servers.find((s) => s.id === serverId);
    if (!server) return { success: false, error: `未找到服务器配置: ${serverId}` };
    try {
      const info = await this.ctx.deps.mcpManager.connect(server);
      return {
        success: info.status === 'connected',
        error: info.error,
        status: this.getMCPStatus(),
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 断开指定 MCP 服务器 */
  async disconnectServer(serverId: string): Promise<MCPConnectionResult> {
    if (!this.ctx.deps) return { success: false, error: '引擎未初始化' };
    try {
      await this.ctx.deps.mcpManager.disconnect(serverId);
      return { success: true, status: this.getMCPStatus() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 一键安装：从市场目录安装 MCP 服务器
   * 1. 从目录获取服务器规格
   * 2. 构造 MCPServerEntry 配置
   * 3. 添加到 config.mcp.servers（去重）
   * 4. 立即连接
   * 5. 返回安装结果（调用方负责持久化 config）
   */
  async installServer(payload: MCPInstallPayload): Promise<MCPInstallResult> {
    if (!this.ctx.deps) return { success: false, error: '引擎未初始化' };

    const entry = getCatalogEntry(payload.catalogId);
    if (!entry) return { success: false, error: `目录中未找到: ${payload.catalogId}` };

    const serverId = payload.customId || payload.catalogId;

    // 检查是否已安装（同 id）
    if (this.ctx.config.mcp.servers.some((s) => s.id === serverId)) {
      return { success: false, error: `服务器已存在: ${serverId}（请先删除或使用自定义 id）` };
    }

    // 构造 MCPServerEntry
    let serverEntry: MCPServerEntry;
    if (entry.transport === 'stdio') {
      // 替换 args 中的占位符（如 ${WORKSPACE}、${DATABASE_URL}）
      const args = (entry.args ?? []).map((a) => {
        if (a === '${WORKSPACE}') return this.ctx.options.cwd;
        return a;
      });
      // 构造 env（从用户填写的值中提取）
      const env: Record<string, string> = {};
      for (const key of entry.requiredEnv ?? []) {
        const val = payload.envValues?.[key];
        if (val) env[key] = val;
      }
      serverEntry = {
        id: serverId,
        name: entry.displayName,
        enabled: true,
        config: {
          transport: 'stdio',
          command: entry.command ?? 'npx',
          args,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        },
      };
    } else {
      // http 传输
      const headers: Record<string, string> = {};
      for (const key of entry.requiredHeaders ?? []) {
        const val = payload.headerValues?.[key];
        if (val) headers[key] = val;
      }
      serverEntry = {
        id: serverId,
        name: entry.displayName,
        enabled: true,
        config: {
          transport: 'http',
          url: entry.url ?? '',
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      };
    }

    // 添加到 config（内存中，调用方负责持久化）
    this.ctx.config.mcp.servers.push(serverEntry);

    // 立即连接
    try {
      const info = await this.ctx.deps.mcpManager.connect(serverEntry);
      return {
        success: info.status === 'connected',
        error: info.error,
        serverId,
        connected: info.status === 'connected',
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        serverId,
        connected: false,
      };
    }
  }
}
