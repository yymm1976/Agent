// tests/mcp/claude-bridge.test.ts
// ClaudeMCPBridge 单元测试（Phase 48 Task 4）
//
// 覆盖蓝图 4.6 节全部 10 个测试要求 + 2 个额外用例：
//   1. HTTP MCP server 配置正确导入
//   2. stdio MCP server 配置正确导入
//   3. SSE MCP server 配置正确导入
//   4. Streamable HTTP MCP server 配置正确导入
//   5. WebSocket MCP server 配置正确导入
//   6. 导入时检测重复 ID 并自动生成新 ID（陷阱 #131）
//   7. 导出到 .mcp.json 格式正确
//   8. 自动发现能扫描默认 Claude Code 配置路径（项目级 + 用户级）
//   9. 桥接失败的 server 不影响其他 server 导入（部分失败容错）
//  10. 会话生命周期策略在导入后保持可配置（persistent:true → 'persistent'）
//  11. importFromObject 不读文件（纯函数式）便于测试
//  12. 已有 existingIds 时正确避免冲突

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ClaudeMCPBridge,
} from '../../src/mcp/claude-bridge.js';
import type {
  ClaudeMcpConfig,
  BridgeImportResult,
} from '../../src/mcp/claude-bridge.js';
import type { MCPServerEntry } from '../../src/tools/mcp/types.js';

// ============================================================
// 工具函数
// ============================================================

/** fixture 根目录（tests/mcp/fixtures） */
const FIXTURES_ROOT = path.join(__dirname, 'fixtures');

/** 项目级 fixture .mcp.json 路径 */
const PROJECT_FIXTURE = path.join(FIXTURES_ROOT, '.mcp.json');

/** 用户级 fixture 根目录（含 .claude/.mcp.json） */
const USER_HOME_FIXTURE = path.join(FIXTURES_ROOT, 'claude-home');

/** 创建临时目录 */
async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 递归复制目录 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/** 递归删除目录 */
async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** 读取 fixture 并解析为 ClaudeMcpConfig */
async function readFixture(file: string): Promise<ClaudeMcpConfig> {
  const raw = await fs.readFile(file, 'utf-8');
  return JSON.parse(raw) as ClaudeMcpConfig;
}

// ============================================================
// 测试
// ============================================================

describe('ClaudeMCPBridge', () => {
  let bridge: ClaudeMCPBridge;

  beforeEach(() => {
    bridge = new ClaudeMCPBridge();
  });

  // ------------------------------------------------------------
  // 1. HTTP MCP server 配置正确导入
  // ------------------------------------------------------------
  it('HTTP MCP server 配置正确导入', async () => {
    const config = await readFixture(PROJECT_FIXTURE);
    const result = bridge.importFromObject(config);

    const http = result.servers.find((s) => s.id === 'http-server');
    expect(http).toBeDefined();
    expect(http!.config.transport).toBe('http');
    expect(http!.config).toMatchObject({
      transport: 'http',
      url: 'https://mcp.example.com/api',
    });
    // headers 字段映射
    expect(http!.config.headers).toEqual({ Authorization: 'Bearer token123' });
    // timeout → connectTimeout
    expect(http!.connectTimeout).toBe(60000);
    // 默认 origin
    expect(http!.origin).toBe('claude-code');
    // 默认生命周期
    expect(http!.lifecyclePolicy).toBe('per-session');
    // name 用原始 key
    expect(http!.name).toBe('http-server');
    expect(http!.enabled).toBe(true);
  });

  // ------------------------------------------------------------
  // 2. stdio MCP server 配置正确导入
  // ------------------------------------------------------------
  it('stdio MCP server 配置正确导入', async () => {
    const config = await readFixture(PROJECT_FIXTURE);
    const result = bridge.importFromObject(config);

    const stdio = result.servers.find((s) => s.id === 'stdio-server');
    expect(stdio).toBeDefined();
    expect(stdio!.config.transport).toBe('stdio');
    expect(stdio!.config).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--port', '3000'],
      env: { NODE_ENV: 'production' },
      cwd: '/tmp',
    });
  });

  // ------------------------------------------------------------
  // 3. SSE MCP server 配置正确导入
  // ------------------------------------------------------------
  it('SSE MCP server 配置正确导入', async () => {
    const config = await readFixture(PROJECT_FIXTURE);
    const result = bridge.importFromObject(config);

    const sse = result.servers.find((s) => s.id === 'sse-server');
    expect(sse).toBeDefined();
    expect(sse!.config.transport).toBe('sse');
    expect(sse!.config).toMatchObject({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { 'X-Api-Key': 'abc' },
    });
  });

  // ------------------------------------------------------------
  // 4. Streamable HTTP MCP server 配置正确导入
  // ------------------------------------------------------------
  it('Streamable HTTP MCP server 配置正确导入', async () => {
    const config = await readFixture(PROJECT_FIXTURE);
    const result = bridge.importFromObject(config);

    const streamable = result.servers.find((s) => s.id === 'streamable-server');
    expect(streamable).toBeDefined();
    expect(streamable!.config.transport).toBe('streamable_http');
    expect(streamable!.config).toMatchObject({
      transport: 'streamable_http',
      url: 'https://mcp.example.com/stream',
    });
  });

  // ------------------------------------------------------------
  // 5. WebSocket MCP server 配置正确导入
  // ------------------------------------------------------------
  it('WebSocket MCP server 配置正确导入', async () => {
    const config = await readFixture(PROJECT_FIXTURE);
    const result = bridge.importFromObject(config);

    const ws = result.servers.find((s) => s.id === 'websocket-server');
    expect(ws).toBeDefined();
    expect(ws!.config.transport).toBe('websocket');
    expect(ws!.config).toMatchObject({
      transport: 'websocket',
      url: 'wss://mcp.example.com/ws',
    });
  });

  // ------------------------------------------------------------
  // 6. 导入时检测重复 ID 并自动生成新 ID（陷阱 #131）
  // ------------------------------------------------------------
  it('导入时检测重复 ID 并自动生成新 ID（陷阱 #131）', () => {
    const config: ClaudeMcpConfig = {
      'dup-server': {
        type: 'http',
        url: 'https://mcp.example.com/a',
      },
    };
    // existingIds 已包含 dup-server → 应触发重命名
    const result = bridge.importFromObject(config, {
      existingIds: new Set(['dup-server']),
    });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].id).toBe('claude-dup-server');
    expect(result.renamed).toHaveLength(1);
    expect(result.renamed[0]).toEqual({
      originalId: 'dup-server',
      newId: 'claude-dup-server',
      reason: 'id "dup-server" conflicts with existing server, renamed to "claude-dup-server"',
    });

    // 进一步：claude-dup-server 也冲突时追加 -2 后缀
    const result2 = bridge.importFromObject(config, {
      existingIds: new Set(['dup-server', 'claude-dup-server']),
    });
    expect(result2.servers[0].id).toBe('claude-dup-server-2');
    expect(result2.renamed[0].newId).toBe('claude-dup-server-2');
  });

  // ------------------------------------------------------------
  // 7. 导出到 .mcp.json 格式正确
  // ------------------------------------------------------------
  it('导出到 .mcp.json 格式正确', () => {
    const servers: MCPServerEntry[] = [
      {
        id: 'my-stdio',
        name: 'my-stdio',
        enabled: true,
        config: {
          transport: 'stdio',
          command: 'node',
          args: ['s.js'],
          env: { FOO: 'bar' },
          cwd: '/work',
        },
        connectTimeout: 5000,
        lifecyclePolicy: 'per-session',
        origin: 'claude-code',
      },
      {
        id: 'my-http',
        name: 'my-http',
        enabled: true,
        config: {
          transport: 'http',
          url: 'https://mcp.example.com/api',
          headers: { Authorization: 'Bearer x' },
        },
        lifecyclePolicy: 'per-call',
        origin: 'claude-code',
      },
      {
        id: 'my-sse',
        name: 'my-sse',
        enabled: true,
        config: {
          transport: 'sse',
          url: 'https://mcp.example.com/sse',
        },
        lifecyclePolicy: 'per-session',
        origin: 'claude-code',
      },
    ];

    const result = bridge.exportToClaudeConfig(servers);

    // 解析导出的 JSON
    const parsed = JSON.parse(result.content) as Record<string, unknown>;

    // stdio 导出格式
    expect(parsed['my-stdio']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['s.js'],
      env: { FOO: 'bar' },
      cwd: '/work',
      timeout: 5000,
    });

    // http 导出格式
    expect(parsed['my-http']).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/api',
      headers: { Authorization: 'Bearer x' },
    });

    // sse 应被跳过（Claude Code 基础格式不支持）
    expect(parsed['my-sse']).toBeUndefined();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].id).toBe('my-sse');
    expect(result.skipped[0].reason).toContain('sse');

    // 导出内容应为 pretty-printed JSON（含换行缩进）
    expect(result.content).toContain('\n    "type": "stdio"');
    expect(result.content).toContain('\n  "my-stdio"');
  });

  // ------------------------------------------------------------
  // 8. 自动发现能扫描默认 Claude Code 配置路径（项目级 + 用户级）
  // ------------------------------------------------------------
  it('自动发现能扫描默认 Claude Code 配置路径（项目级 + 用户级）', async () => {
    // 构造临时项目根 + 临时 home 目录
    const projectRoot = await makeTempDir('routedev-mcp-proj-');
    const homeDir = await makeTempDir('routedev-mcp-home-');
    const emptyHome = await makeTempDir('routedev-mcp-empty-');

    try {
      // 初始：两个位置都不存在 → 返回空
      const before = await bridge.discoverClaudeConfigs(projectRoot, homeDir);
      expect(before).toEqual([]);

      // 项目级 .mcp.json
      await fs.copyFile(PROJECT_FIXTURE, path.join(projectRoot, '.mcp.json'));

      // 用户级 ~/.claude/.mcp.json
      await copyDir(USER_HOME_FIXTURE, homeDir);

      const found = await bridge.discoverClaudeConfigs(projectRoot, homeDir);
      // 应按扫描顺序返回两个路径：项目级 → 用户级
      expect(found).toHaveLength(2);
      expect(found[0]).toBe(path.join(projectRoot, '.mcp.json'));
      expect(found[1]).toBe(path.join(homeDir, '.claude', '.mcp.json'));

      // 仅项目级存在时只返回一个（emptyHome 下无 .claude/.mcp.json）
      const onlyProject = await bridge.discoverClaudeConfigs(projectRoot, emptyHome);
      expect(onlyProject).toHaveLength(1);
    } finally {
      await rmrf(projectRoot);
      await rmrf(homeDir);
      await rmrf(emptyHome);
    }
  });

  // ------------------------------------------------------------
  // 9. 桥接失败的 server 不影响其他 server 导入（部分失败容错）
  // ------------------------------------------------------------
  it('桥接失败的 server 不影响其他 server 导入（部分失败容错）', () => {
    const config: ClaudeMcpConfig = {
      'good-http': {
        type: 'http',
        url: 'https://mcp.example.com/good',
      },
      'bad-unknown-type': {
        // 不支持的 transport → failed（陷阱 #137：不静默降级）
        type: 'grpc',
        url: 'https://mcp.example.com/grpc',
      },
      'bad-missing-url': {
        type: 'http',
        // 缺失 url → failed
      },
      'bad-missing-type': {
        // 缺失 type → failed
        url: 'https://mcp.example.com/no-type',
      },
      'good-stdio': {
        type: 'stdio',
        command: 'node',
        args: ['s.js'],
      },
    };

    const result = bridge.importFromObject(config);

    // 成功导入 2 个
    expect(result.servers).toHaveLength(2);
    const ids = result.servers.map((s) => s.id).sort();
    expect(ids).toEqual(['good-http', 'good-stdio']);

    // 失败 3 个，不中断整体导入
    expect(result.failed).toHaveLength(3);
    const failedIds = result.failed.map((f) => f.id).sort();
    expect(failedIds).toEqual(['bad-missing-type', 'bad-missing-url', 'bad-unknown-type']);

    // 失败原因明确（不静默降级）
    const unknownTypeFailure = result.failed.find((f) => f.id === 'bad-unknown-type');
    expect(unknownTypeFailure!.error).toContain('unsupported transport type: grpc');
    const missingUrlFailure = result.failed.find((f) => f.id === 'bad-missing-url');
    expect(missingUrlFailure!.error).toContain('requires \'url\' field');
    const missingTypeFailure = result.failed.find((f) => f.id === 'bad-missing-type');
    expect(missingTypeFailure!.error).toContain('missing \'type\' field');
  });

  // ------------------------------------------------------------
  // 10. 会话生命周期策略在导入后保持可配置
  //     persistent:true → lifecyclePolicy:'persistent'；默认 per-session
  // ------------------------------------------------------------
  it('会话生命周期策略在导入后保持可配置（persistent:true → persistent）', async () => {
    const config = await readFixture(PROJECT_FIXTURE);
    const result = bridge.importFromObject(config);

    // persistent-server（SonettoHere YAML 扩展字段 persistent:true）
    const persistent = result.servers.find((s) => s.id === 'persistent-server');
    expect(persistent).toBeDefined();
    expect(persistent!.lifecyclePolicy).toBe('persistent');

    // 其他 server 默认 per-session
    const http = result.servers.find((s) => s.id === 'http-server');
    expect(http!.lifecyclePolicy).toBe('per-session');

    // 通过 defaultLifecycle 选项可覆盖默认值
    const result2 = bridge.importFromObject(
      { 'per-call-server': { type: 'http', url: 'https://mcp.example.com/pc' } },
      { defaultLifecycle: 'per-call' },
    );
    expect(result2.servers[0].lifecyclePolicy).toBe('per-call');

    // persistent:true 优先于 defaultLifecycle
    const result3 = bridge.importFromObject(
      { 'p-server': { type: 'http', url: 'https://mcp.example.com/p', persistent: true } },
      { defaultLifecycle: 'per-call' },
    );
    expect(result3.servers[0].lifecyclePolicy).toBe('persistent');
  });

  // ------------------------------------------------------------
  // 11. importFromObject 不读文件（纯函数式）便于测试
  // ------------------------------------------------------------
  it('importFromObject 不读文件（纯函数式），同步返回结果', () => {
    // 同步调用，无 await，无文件 IO
    const result: BridgeImportResult = bridge.importFromObject({
      'sync-server': { type: 'http', url: 'https://mcp.example.com/sync' },
    });

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].id).toBe('sync-server');
    expect(result.servers[0].config.transport).toBe('http');
    expect(result.failed).toEqual([]);
    expect(result.renamed).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  // ------------------------------------------------------------
  // 12. 已有 existingIds 时正确避免冲突（批量内 + 跨批次）
  // ------------------------------------------------------------
  it('已有 existingIds 时正确避免冲突（批量内 + 跨批次）', () => {
    // 两个同 ID 的 server 在同一次导入中：第二个应被重命名
    const config: ClaudeMcpConfig = {
      'shared-id': { type: 'http', url: 'https://mcp.example.com/1' },
      'shared-id-dup': { type: 'http', url: 'https://mcp.example.com/2' },
    };

    // existingIds 中没有冲突 → 第一个用原名，第二个原名不冲突
    const result = bridge.importFromObject(config);
    const ids = result.servers.map((s) => s.id).sort();
    expect(ids).toEqual(['shared-id', 'shared-id-dup']);
    expect(result.renamed).toEqual([]);

    // 跨批次：existingIds 包含上一批次的 ID，导入同名 server 应重命名
    const existing = new Set(['shared-id']);
    const result2 = bridge.importFromObject(
      { 'shared-id': { type: 'http', url: 'https://mcp.example.com/again' } },
      { existingIds: existing },
    );
    expect(result2.servers[0].id).toBe('claude-shared-id');
    expect(result2.renamed).toHaveLength(1);

    // 同批次内两个 server 同名：第二个加前缀
    const config3: ClaudeMcpConfig = {
      'same': { type: 'http', url: 'https://mcp.example.com/a' },
      'same2': { type: 'http', url: 'https://mcp.example.com/b' },
    };
    // 用一个 server 的 id 与另一个原始 id 相同的场景验证批量内冲突
    const result3 = bridge.importFromObject(config3, {
      existingIds: new Set(['same', 'same2']),
    });
    // 'same' 冲突 → 'claude-same'；'same2' 冲突 → 'claude-same2'
    expect(result3.servers.map((s) => s.id).sort()).toEqual(['claude-same', 'claude-same2']);
    expect(result3.renamed).toHaveLength(2);
  });

  // ------------------------------------------------------------
  // 额外：importFromClaudeConfig 从文件导入（端到端）
  // ------------------------------------------------------------
  it('importFromClaudeConfig 从 fixture 文件导入全部 5 种 transport', async () => {
    const result = await bridge.importFromClaudeConfig(PROJECT_FIXTURE);

    expect(result.failed).toEqual([]);
    expect(result.servers).toHaveLength(6); // 5 transport + 1 persistent

    const transports = result.servers.map((s) => s.config.transport).sort();
    expect(transports).toEqual(
      ['http', 'http', 'sse', 'stdio', 'streamable_http', 'websocket'],
    );
  });

  // ------------------------------------------------------------
  // 额外：importFromClaudeConfig 文件不存在时记入 failed，不抛异常
  // ------------------------------------------------------------
  it('importFromClaudeConfig 文件不存在时记入 failed，不抛异常', async () => {
    const result = await bridge.importFromClaudeConfig(
      path.join(FIXTURES_ROOT, 'not-exist.json'),
    );

    expect(result.servers).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain('failed to read file');
  });
});
