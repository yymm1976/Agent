// src/tools/mcp/client.ts
// MCP 客户端管理器：连接 MCP Server、发现工具、注册到 ToolRegistry

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { IToolRegistry } from '../types.js';
import type { MCPServerEntry, MCPConnectionInfo, MCPConnectionStatus } from './types.js';
import { MCPTool } from './mcp-tool.js';
import { logger } from '../../utils/logger.js';

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

  constructor(registry: IToolRegistry) {
    this.registry = registry;
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
      client: new Client({ name: 'routedev', version: '0.8.0' }),
      transport: this.createTransport(entry),
      entry,
      status: 'connecting',
      tools: [],
    };

    this.connections.set(entry.id, state);

    try {
      const timeout = entry.connectTimeout ?? 10000;
      await Promise.race([
        state.client.connect(state.transport),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`连接超时 (${timeout}ms)`)), timeout),
        ),
      ]);

      state.status = 'connected';
      state.connectedAt = Date.now();

      await this.discoverTools(entry.id);

      logger.info(`MCP server connected: ${entry.name}`, {
        toolCount: state.tools.length,
      });

      return this.getConnectionInfo(entry.id)!;
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);

      logger.error(`Failed to connect MCP server: ${entry.name}`, { error: state.error });

      try { await state.client.close(); } catch { /* ignore */ }
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

    this.connections.delete(serverId);
    logger.info(`MCP server disconnected: ${serverId}`);
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.connections.keys());
    await Promise.all(ids.map(id => this.disconnect(id)));
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
      return new StdioClientTransport({
        command: entry.config.command,
        args: entry.config.args,
        env: entry.config.env
          ? { ...process.env, ...entry.config.env } as Record<string, string>
          : process.env as Record<string, string>,
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

    try {
      const result = await state.client.listTools();

      for (const mcpToolDef of result.tools) {
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
    } catch (error) {
      logger.error(`Failed to discover tools from MCP server: ${serverId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
