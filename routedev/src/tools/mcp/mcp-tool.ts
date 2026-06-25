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
    const inputSchema = mcpToolDef.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const schemaProperties = inputSchema.properties ?? {};
    this.definition = {
      name: namespacedName,
      description: `[MCP:${serverEntry.name}] ${mcpToolDef.description ?? ''}`,
      parameters: {
        type: 'object',
        properties: schemaProperties,
        // Phase 32 Task 4.1：保留 required 字段，供 validateArgs 做必填参数检查
        required: inputSchema.required ?? [],
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

    // 1. 必填参数存在性检查（原有）
    for (const key of required) {
      if (!(key in args)) {
        errors.push(`缺少必需参数: ${key}`);
      }
    }

    // 2. Phase 32 Task 4.1：类型检查（新增）
    //    根据 JSON Schema 的 properties.<key>.type 检查实际参数类型
    //    支持：string/number/boolean/array/object/null
    //    type 为 'any' 或未声明时跳过（向后兼容）
    const properties = (schema.properties ?? {}) as Record<string, { type?: string | string[] }>;
    for (const [key, value] of Object.entries(args)) {
      const propSchema = properties[key];
      if (!propSchema?.type) continue;

      // JSON Schema type 可以是字符串或字符串数组（联合类型）
      const expectedTypes = Array.isArray(propSchema.type) ? propSchema.type : [propSchema.type];
      if (expectedTypes.includes('any')) continue;

      // 推断实际类型（array 需在 object 之前判断，因为 typeof [] === 'object'）
      let actualType: string;
      if (Array.isArray(value)) {
        actualType = 'array';
      } else if (value === null) {
        actualType = 'null';
      } else {
        actualType = typeof value;
        // JSON Schema 的 integer 对应 JS 的 number
        if (actualType === 'number' && Number.isInteger(value) && expectedTypes.includes('integer')) {
          actualType = 'integer';
        }
      }

      if (!expectedTypes.includes(actualType)) {
        errors.push(`参数 ${key} 期望类型 ${expectedTypes.join('|')}，实际为 ${actualType}`);
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
