// tests/tools/mcp.test.ts
// MCP 客户端管理器与工具包装器单元测试

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { MCPClientManager } from '../../src/tools/mcp/client.js';
import { MCPTool } from '../../src/tools/mcp/mcp-tool.js';
import type { MCPServerEntry } from '../../src/tools/mcp/types.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

// Mock MCP SDK Client
const mockClient = {
  connect: vi.fn(),
  close: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
};

const mockTransport = {};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(function () {
    return mockClient;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return mockTransport;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(function () {
    return mockTransport;
  }),
}));

const context: ToolExecutionContext = {
  workingDirectory: process.cwd(),
  allowedDirectories: [process.cwd()],
  environment: {},
  timeoutMs: 30000,
};

describe('MCPClientManager', () => {
  let registry: ToolRegistry;
  let manager: MCPClientManager;

  beforeEach(() => {
    registry = new ToolRegistry();
    manager = new MCPClientManager(registry);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await manager.disconnectAll();
  });

  it('should connect to stdio MCP server and discover tools', async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({
      tools: [
        {
          name: 'echo',
          description: 'Echo tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    const server: MCPServerEntry = {
      id: 'test-stdio',
      name: 'Test STDIO Server',
      enabled: true,
      config: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
      },
    };

    const info = await manager.connect(server);

    expect(info.status).toBe('connected');
    expect(info.toolCount).toBe(1);
    expect(registry.has('mcp__test-stdio__echo')).toBe(true);
  });

  it('should connect to http MCP server', async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({ tools: [] });

    const server: MCPServerEntry = {
      id: 'test-http',
      name: 'Test HTTP Server',
      enabled: true,
      config: {
        transport: 'http',
        url: 'http://localhost:3000/mcp',
      },
    };

    const info = await manager.connect(server);

    expect(info.status).toBe('connected');
    expect(info.toolCount).toBe(0);
  });

  it('should handle connection errors', async () => {
    mockClient.connect.mockRejectedValue(new Error('Connection refused'));

    const server: MCPServerEntry = {
      id: 'test-error',
      name: 'Test Error Server',
      enabled: true,
      config: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
      },
    };

    const info = await manager.connect(server);

    expect(info.status).toBe('error');
    expect(info.error).toContain('Connection refused');
  });

  it('should disconnect and unregister tools', async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({
      tools: [{ name: 'tool1', description: 'Tool 1', inputSchema: { type: 'object', properties: {} } }],
    });

    await manager.connect({
      id: 'test-disconnect',
      name: 'Test Disconnect',
      enabled: true,
      config: { transport: 'stdio', command: 'node', args: [] },
    });

    expect(registry.has('mcp__test-disconnect__tool1')).toBe(true);

    await manager.disconnect('test-disconnect');

    expect(registry.has('mcp__test-disconnect__tool1')).toBe(false);
  });

  it('should list all connections', async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({ tools: [] });

    await manager.connect({
      id: 'server1',
      name: 'Server 1',
      enabled: true,
      config: { transport: 'stdio', command: 'node', args: [] },
    });

    const connections = manager.listConnections();
    expect(connections.length).toBe(1);
    expect(connections[0].serverId).toBe('server1');
  });
});

describe('MCPTool', () => {
  it('should wrap MCP tool definition', () => {
    const mcpDef = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' },
        },
      },
    };

    const tool = new MCPTool(
      'mcp__server1__test_tool',
      mcpDef,
      mockClient as unknown as import('@modelcontextprotocol/sdk/client/index.js').Client,
      {
        id: 'server1',
        name: 'Server 1',
        enabled: true,
        config: { transport: 'stdio', command: 'node', args: [] },
      },
    );

    expect(tool.definition.name).toBe('mcp__server1__test_tool');
    expect(tool.definition.category).toBe('mcp');
    expect(tool.definition.requiresApproval).toBe(true);
  });

  it('should call MCP tool and return result', async () => {
    mockClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });

    const tool = new MCPTool(
      'mcp__server1__echo',
      {
        name: 'echo',
        description: 'Echo',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      mockClient as unknown as import('@modelcontextprotocol/sdk/client/index.js').Client,
      {
        id: 'server1',
        name: 'Server 1',
        enabled: true,
        config: { transport: 'stdio', command: 'node', args: [] },
      },
    );

    const result = await tool.execute({ text: 'hello' }, context);

    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: 'echo',
      arguments: { text: 'hello' },
    });
  });

  it('should handle MCP tool errors', async () => {
    mockClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'error occurred' }],
      isError: true,
    });

    const tool = new MCPTool(
      'mcp__server1__fail',
      {
        name: 'fail',
        description: 'Fail tool',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      mockClient as unknown as import('@modelcontextprotocol/sdk/client/index.js').Client,
      {
        id: 'server1',
        name: 'Server 1',
        enabled: true,
        config: { transport: 'stdio', command: 'node', args: [] },
      },
    );

    const result = await tool.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toBe('error occurred');
  });
});
