// src/tools/mcp/types.ts
// MCP 客户端类型定义

/** MCP Server 传输类型 */
export type MCPTransportType = 'stdio' | 'http';

/** stdio 传输配置 */
export interface MCPStdioConfig {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** HTTP+SSE 传输配置 */
export interface MCPHttpConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

/** MCP Server 配置（联合类型） */
export type MCPServerConfig = MCPStdioConfig | MCPHttpConfig;

/** MCP Server 完整配置项（含元数据） */
export interface MCPServerEntry {
  id: string;
  name: string;
  enabled: boolean;
  config: MCPServerConfig;
  connectTimeout?: number;
}

/** MCP 客户端状态 */
export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** MCP 连接信息 */
export interface MCPConnectionInfo {
  serverId: string;
  serverName: string;
  status: MCPConnectionStatus;
  toolCount: number;
  error?: string;
  connectedAt?: number;
}

/** MCP 工具元数据 */
export interface MCPToolMetadata {
  serverId: string;
  serverName: string;
  originalName: string;
}
