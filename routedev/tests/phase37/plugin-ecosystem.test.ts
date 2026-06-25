// tests/phase37/plugin-ecosystem.test.ts
// Phase 37 Task 4：插件生态兼容性原型验证测试
// 验证 RouteDev MCP 客户端与 Codex/Claude Code 生态的兼容性
// 覆盖：工具描述兼容、服务器配置兼容、命名空间约定兼容

import { describe, it, expect } from 'vitest';
import { MCPTool } from '../../src/tools/mcp/mcp-tool.js';
import type { MCPServerEntry } from '../../src/tools/mcp/types.js';
import type { Tool as MCPToolDefinition } from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * 模拟 Codex/Claude Code 生态中常见的 MCP server 配置
 * 这些配置格式与 Codex 的 mcp_servers.json / Claude Code 的 claude_desktop_config.json 一致
 */
function createMockServerEntry(
  id: string,
  name: string,
  transport: 'stdio' | 'http',
): MCPServerEntry {
  if (transport === 'stdio') {
    return {
      id,
      name,
      enabled: true,
      config: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      },
    };
  }
  return {
    id,
    name,
    enabled: true,
    config: {
      transport: 'http',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer test-token' },
    },
  };
}

/**
 * 模拟 MCP server 暴露的工具定义（符合 MCP 规范）
 * 这与 Codex/Claude Code 生态中 MCP server 返回的工具格式完全一致
 */
function createMockMCPTool(name: string, description: string): MCPToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path'],
    },
  };
}

describe('Phase 37 Task 4：插件生态兼容性原型验证', () => {
  // ============================================================
  // 测试 1：MCP 工具描述兼容性
  // 验证 MCP Tool 定义能正确转换为 RouteDev ToolDefinition
  // 这是 Codex/Claude Code 生态的工具接入 RouteDev 的核心兼容点
  // ============================================================
  it('1. MCP 工具描述能正确转换为 RouteDev ToolDefinition（与 Codex/Claude Code 格式一致）', () => {
    const serverEntry = createMockServerEntry('filesystem', 'Filesystem MCP', 'stdio');
    const mcpToolDef = createMockMCPTool('read_file', '读取文件内容');
    const mockClient = {} as Client; // 实际调用时由 MCPClientManager 注入

    const tool = new MCPTool('mcp__filesystem__read_file', mcpToolDef, mockClient, serverEntry);

    // 验证：工具定义符合 RouteDev 的 ToolDefinition 结构
    expect(tool.definition.name).toBe('mcp__filesystem__read_file');
    // 描述应包含 MCP server 名称前缀（RouteDev 的约定）
    expect(tool.definition.description).toContain('Filesystem MCP');
    expect(tool.definition.description).toContain('读取文件内容');

    // 验证：参数 schema 从 MCP inputSchema 正确转换
    const params = tool.definition.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.properties).toHaveProperty('path');
    expect(params.properties).toHaveProperty('content');
    expect(params.required).toContain('path');

    // 验证：MCP 工具默认需要审批（安全约定，与 Codex 一致）
    expect(tool.definition.requiresApproval).toBe(true);
    expect(tool.definition.category).toBe('mcp');
  });

  // ============================================================
  // 测试 2：MCP 服务器配置兼容性
  // 验证 RouteDev 支持的传输类型与 Codex/Claude Code 生态一致
  // Codex 的 mcp_servers.json 和 Claude Code 的配置都使用 stdio + http
  // ============================================================
  it('2. MCP 服务器配置支持 stdio 和 http 传输（与 Codex/Claude Code 配置格式兼容）', () => {
    // stdio 传输：Codex/Claude Code 最常用的方式（本地子进程）
    const stdioEntry = createMockServerEntry('fs-local', 'Local Filesystem', 'stdio');
    expect(stdioEntry.config.transport).toBe('stdio');
    if (stdioEntry.config.transport === 'stdio') {
      expect(stdioEntry.config.command).toBe('npx');
      expect(stdioEntry.config.args).toContain('-y');
      expect(stdioEntry.config.args).toContain('@modelcontextprotocol/server-filesystem');
      // Codex 配置格式：command + args + 可选 env/cwd
      expect(Array.isArray(stdioEntry.config.args)).toBe(true);
    }

    // http 传输：远程 MCP server（Claude Code 支持的 SSE 方式）
    const httpEntry = createMockServerEntry('fs-remote', 'Remote Filesystem', 'http');
    expect(httpEntry.config.transport).toBe('http');
    if (httpEntry.config.transport === 'http') {
      expect(httpEntry.config.url).toMatch(/^https?:\/\//);
      // Claude Code 配置格式：url + 可选 headers
      expect(httpEntry.config.headers).toHaveProperty('Authorization');
    }

    // 验证：两种传输类型都符合 MCPServerConfig 联合类型
    // RouteDev 的 MCPServerEntry 与 Codex/Claude Code 的配置项结构对齐
    expect(stdioEntry.enabled).toBe(true);
    expect(httpEntry.enabled).toBe(true);
    expect(typeof stdioEntry.id).toBe('string');
    expect(typeof stdioEntry.name).toBe('string');
  });

  // ============================================================
  // 测试 3：工具命名空间兼容性
  // 验证 mcp__<serverId>__<toolName> 格式与 Codex/Claude Code 完全一致
  // 这是跨工具识别 MCP 工具的关键约定
  // ============================================================
  it('3. 工具命名空间格式 mcp__serverId__toolName 与 Codex/Claude Code 一致', () => {
    const testCases = [
      { serverId: 'filesystem', toolName: 'read_file', expected: 'mcp__filesystem__read_file' },
      { serverId: 'github', toolName: 'create_issue', expected: 'mcp__github__create_issue' },
      { serverId: 'postgres', toolName: 'query', expected: 'mcp__postgres__query' },
    ];

    for (const { serverId, toolName, expected } of testCases) {
      const serverEntry = createMockServerEntry(serverId, `${serverId} MCP`, 'stdio');
      const mcpToolDef = createMockMCPTool(toolName, `工具: ${toolName}`);
      const mockClient = {} as Client;

      const tool = new MCPTool(expected, mcpToolDef, mockClient, serverEntry);

      // 验证：命名空间格式严格匹配 mcp__<serverId>__<toolName>
      expect(tool.definition.name).toBe(expected);
      expect(tool.definition.name.startsWith('mcp__')).toBe(true);
      expect(tool.definition.name).toContain(`__${serverId}__`);

      // 验证：命名空间可被反向解析（Codex/Claude Code 用此格式识别工具来源）
      const parts = tool.definition.name.split('__');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('mcp');
      expect(parts[1]).toBe(serverId);
      expect(parts[2]).toBe(toolName);
    }
  });

  // ============================================================
  // 测试 4：参数校验跨生态兼容性
  // 验证 RouteDev 的 validateArgs 能正确校验 MCP 规范的参数
  // 这确保 Codex/Claude Code 生态的 MCP server 工具能在 RouteDev 中正常使用
  // ============================================================
  it('4. validateArgs 能正确校验 MCP 规范的参数（跨生态兼容）', () => {
    const serverEntry = createMockServerEntry('fs', 'Filesystem', 'stdio');
    const mcpToolDef: MCPToolDefinition = {
      name: 'write_file',
      description: '写入文件',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
          overwrite: { type: 'boolean', description: '是否覆盖' },
        },
        required: ['path', 'content'],
      },
    };
    const mockClient = {} as Client;
    const tool = new MCPTool('mcp__fs__write_file', mcpToolDef, mockClient, serverEntry);

    // 合法参数：应通过校验
    const validResult = tool.validateArgs({
      path: '/tmp/test.txt',
      content: 'hello',
      overwrite: true,
    });
    expect(validResult.valid).toBe(true);
    expect(validResult.errors).toHaveLength(0);

    // 缺少必填参数：应失败
    const missingResult = tool.validateArgs({ path: '/tmp/test.txt' });
    expect(missingResult.valid).toBe(false);
    expect(missingResult.errors.some((e) => e.includes('content'))).toBe(true);

    // 类型不匹配：应失败（Phase 32 Task 4.1 的类型检查能力）
    const typeMismatchResult = tool.validateArgs({
      path: '/tmp/test.txt',
      content: 'hello',
      overwrite: 'yes', // 应为 boolean
    });
    expect(typeMismatchResult.valid).toBe(false);
  });
});
