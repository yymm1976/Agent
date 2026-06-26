// src/tools/mcp/types.ts
// MCP 客户端类型定义

/**
 * MCP Server 传输类型（Phase 48 Task 4 扩展）
 * 覆盖 Claude Code / SonettoHere / APIX / MCP 2025-03-26 规范全部传输
 */
export type MCPTransportType = 'stdio' | 'http' | 'sse' | 'streamable_http' | 'websocket';

/** stdio 传输配置 */
export interface MCPStdioConfig {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** HTTP 传输配置（请求-响应） */
export interface MCPHttpConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

/** SSE 传输配置（单向流，Phase 48 Task 4） */
export interface MCPSseConfig {
  transport: 'sse';
  url: string;
  headers?: Record<string, string>;
}

/** Streamable HTTP 传输配置（MCP 2025-03-26，双向流式 HTTP） */
export interface MCPStreamableHttpConfig {
  transport: 'streamable_http';
  url: string;
  headers?: Record<string, string>;
}

/** WebSocket 传输配置（Phase 48 Task 4） */
export interface MCPWebsocketConfig {
  transport: 'websocket';
  url: string;
  headers?: Record<string, string>;
}

/** MCP Server 配置（联合类型） */
export type MCPServerConfig =
  | MCPStdioConfig
  | MCPHttpConfig
  | MCPSseConfig
  | MCPStreamableHttpConfig
  | MCPWebsocketConfig;

/**
 * MCP 会话生命周期策略（Phase 48 Task 4，受 APIX 启发）
 * - per-call：每次工具调用新建会话（适合无状态 server）
 * - per-session：整个 RouteDev 会话期间保持连接（默认）
 * - persistent：应用级持久连接，可手动重连/断开
 */
export type MCPLifecyclePolicy = 'per-call' | 'per-session' | 'persistent';

/** MCP Server 完整配置项（含元数据） */
export interface MCPServerEntry {
  id: string;
  name: string;
  enabled: boolean;
  config: MCPServerConfig;
  connectTimeout?: number;
  /** Phase 48 Task 4：会话生命周期策略 */
  lifecyclePolicy?: MCPLifecyclePolicy;
  /** 来源标注（导入时填写，便于在 UI 中显示来源） */
  origin?: string;
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
