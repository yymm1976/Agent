// src/tools/mcp/mcp-tool.ts
// MCP 工具包装器：将 MCP Server 的工具注册到本地 ToolRegistry

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool as MCPToolDefinition } from '@modelcontextprotocol/sdk/types.js';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import type { MCPServerEntry, MCPToolMetadata } from './types.js';

export class MCPTool implements ITool {
  readonly definition: ToolDefinition;
  private client: Client;
  private metadata: MCPToolMetadata;
  private originalName: string;

  constructor(
    namespacedName: string,
    mcpToolDef: MCPToolDefinition,
    client: Client,
    serverEntry: MCPServerEntry,
  ) {
    const schemaProperties = (mcpToolDef.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    this.definition = {
      name: namespacedName,
      description: `[MCP:${serverEntry.name}] ${mcpToolDef.description ?? ''}`,
      parameters: {
        type: 'object',
        properties: schemaProperties,
      },
      requiresApproval: true,
      category: 'mcp',
    } as unknown as ToolDefinition;
    this.client = client;
    this.originalName = mcpToolDef.name;
    this.metadata = {
      serverId: serverEntry.id,
      serverName: serverEntry.name,
      originalName: mcpToolDef.name,
    };
  }

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const schema = this.definition.parameters;
    const required = (schema.required as string[]) ?? [];

    for (const key of required) {
      if (!(key in args)) {
        errors.push(`缺少必需参数: ${key}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const result = await this.client.callTool({
        name: this.originalName,
        arguments: args,
      });

      const contentParts = result.content as Array<{ type: string; text?: string; [key: string]: unknown }>;
      const content = contentParts
        .map(part => (part.type === 'text' ? part.text : JSON.stringify(part)))
        .join('\n');

      return {
        success: !result.isError,
        output: content,
        error: result.isError ? content : undefined,
        durationMs: Date.now() - startTime,
        metadata: {
          mcpToolName: this.originalName,
          serverId: this.metadata.serverId,
          serverName: this.metadata.serverName,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `MCP 工具调用失败: ${msg}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  getMetadata(): MCPToolMetadata {
    return { ...this.metadata };
  }
}
