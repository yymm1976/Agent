# Phase 8：MCP 客户端（Model Context Protocol 工具集成）

**回应**：Phase 7 无 CONCERN（等待执行人报告）

**观察记录**（基于代码审阅）：
| # | 观察 | 处理 |
|---|------|------|
| O1 | `IToolRegistry.register(tool: ITool)` 接受任何实现 ITool 接口的对象 | MCP 工具包装为 MCPTool 实现 ITool，直接注册到同一个 Registry |
| O2 | `ToolDefinition.category` 枚举中没有 `'mcp'` 类型 | MCPTool 的 category 使用 `'system'`（已有），通过 metadata 标记来源 |
| O3 | `ToolExecutionContext` 有 `workingDirectory`、`allowedDirectories`、`environment`、`timeoutMs` | MCP 工具执行时传递 timeoutMs 作为超时 |
| O4 | `ToolRegistryAdapter`（Phase 6 桥梁）从 `IToolRegistry.list()` 生成 LLM function schema | MCP 工具注册后自动出现在 LLM 的工具列表中，无需额外处理 |
| O5 | `ToolExecutor.execute()` 的安全检查只对 `file_*` 前缀的工具检查路径 | MCP 工具不走文件安全检查（由 MCP Server 自身控制权限） |
| O6 | `config.example.yaml` 目前没有 MCP 相关配置 | Phase 8 新增 mcpServers 配置节 |

---

**目标**：实现 MCP（Model Context Protocol）客户端——连接外部 MCP Server，自动发现并注册其提供的工具到 ToolRegistry，让 LLM 能像调用内置工具一样调用 MCP 工具。

**蓝图参考**：第八节 8.4（MCP 客户端）、第八节 8.1（分级架构：MCP Server 为中等开销层）、第四节（文件结构 `tools/mcp/client.ts`）

**前置依赖**：Phase 6（ToolRegistry + ToolExecutor）+ Phase 7（全部内置工具就位）

---

## 架构说明

MCP 让 RouteDev 能"插 USB 线"连接外部工具服务器——比如数据库查询、浏览器自动化、Jira/Slack 集成等。Phase 8 实现的是 MCP **客户端**（RouteDev 是客户端，外部 Server 提供工具）。

```
内置工具（Phase 6-7）：
  ToolRegistry ← file_read, file_write, file_search, shell_exec, git_op, web_search, code_search

MCP 工具（Phase 8）：
  MCPClientManager ← 管理多个 MCP Server 连接
    ↓ 连接 Server A（stdio）
      发现工具: db_query, db_list_tables → 包装为 MCPTool → 注册到 ToolRegistry
    ↓ 连接 Server B（HTTP+SSE）
      发现工具: jira_create_issue → 包装为 MCPTool → 注册到 ToolRegistry
    ↓
  ToolRegistry ← 内置工具 + MCP 工具（统一注册表，LLM 无感知差异）
```

**关键约束**：
- MCP 协议基于 JSON-RPC 2.0
- 支持两种传输：stdio（本地进程通信）和 HTTP+SSE（远程服务器）
- MCP Server 可能随时断开（进程崩溃、网络中断），需要自动清理已注册的工具
- MCP 工具调用是异步的，但 ITool.execute() 本身就是 async，天然兼容
- MCP 工具的参数 schema 由 Server 提供（JSON Schema），直接复用为 ToolDefinition.parameters

---

## 具体任务

### Task 1：安装 MCP SDK

- [ ] **Step 1：安装 @modelcontextprotocol/sdk**

```powershell
pnpm add @modelcontextprotocol/sdk
```

依赖说明：
- `@modelcontextprotocol/sdk`：Anthropic 官方 MCP SDK，提供 Client、Transport、协议类型
- 版本以 pnpm 解析的最新版为准

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

确认新依赖不影响已有代码的编译。

- [ ] **Step 3：提交**

```powershell
git add package.json pnpm-lock.yaml
git commit -m "chore: add @modelcontextprotocol/sdk for MCP client support"
```

---

### Task 2：MCP 配置类型与 Schema

**文件：**
- 创建 `src/tools/mcp/types.ts`
- 修改 `src/config/schema.ts`（新增 MCP 配置 schema）
- 修改 `src/config/defaults.ts`（新增默认值）

- [ ] **Step 1：MCP 类型定义**

```typescript
// src/tools/mcp/types.ts
// MCP 客户端类型定义

/** MCP Server 传输类型 */
export type MCPTransportType = 'stdio' | 'http';

/** stdio 传输配置 */
export interface MCPStdioConfig {
  transport: 'stdio';
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args: string[];
  /** 环境变量（合并到 process.env） */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
}

/** HTTP+SSE 传输配置 */
export interface MCPHttpConfig {
  transport: 'http';
  /** Server URL */
  url: string;
  /** 请求头（如认证 token） */
  headers?: Record<string, string>;
}

/** MCP Server 配置（联合类型） */
export type MCPServerConfig = MCPStdioConfig | MCPHttpConfig;

/** MCP Server 完整配置项（含元数据） */
export interface MCPServerEntry {
  /** 服务器 ID（唯一标识） */
  id: string;
  /** 服务器名称（显示用） */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 传输配置 */
  config: MCPServerConfig;
  /** 连接超时（毫秒，默认 10000） */
  connectTimeout?: number;
}

/** MCP 客户端状态 */
export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** MCP 连接信息 */
export interface MCPConnectionInfo {
  serverId: string;
  serverName: string;
  status: MCPConnectionStatus;
  /** 已发现的工具数量 */
  toolCount: number;
  /** 连接错误信息（如有） */
  error?: string;
  /** 连接时间 */
  connectedAt?: number;
}

/** MCP 工具元数据（附加到 ToolResult.metadata） */
export interface MCPToolMetadata {
  serverId: string;
  serverName: string;
  originalName: string;  // MCP Server 原始工具名
}
```

- [ ] **Step 2：扩展配置 Schema**

在 `src/config/schema.ts` 中，新增 MCP 相关 Zod schema。在 `AppConfigSchema` 中添加 `mcpServers` 字段：

```typescript
// 在 schema.ts 中新增（与其他 schema 并列）：

export const MCPServerConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

export const MCPServerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  config: MCPServerConfigSchema,
  connectTimeout: z.number().optional(),
});

export const MCPConfigSchema = z.object({
  servers: z.array(MCPServerEntrySchema).default([]),
  autoConnect: z.boolean().default(true),
});

export type MCPConfig = z.infer<typeof MCPConfigSchema>;
export type MCPServerEntryConfig = z.infer<typeof MCPServerEntrySchema>;

// 在 AppConfigSchema 中添加：
// mcp: z.preprocess((v) => v ?? {}, MCPConfigSchema),
```

同时在 `AppConfig` 类型（`export type AppConfig = z.infer<typeof AppConfigSchema>`）中会自动包含 `mcp` 字段。

- [ ] **Step 3：更新默认配置**

在 `src/config/defaults.ts` 中添加 MCP 默认值：

```typescript
// 在 DEFAULT_CONFIG 中添加：
mcp: {
  servers: [],
  autoConnect: true,
},
```

- [ ] **Step 4：更新 config.example.yaml**

```yaml
# MCP Server 配置
# 参考: https://modelcontextprotocol.io
mcp:
  autoConnect: true    # 启动时自动连接已启用的 Server
  servers:
    # stdio 传输示例（本地进程）
    # - id: my-db-server
    #   name: "Database Server"
    #   enabled: true
    #   config:
    #     transport: stdio
    #     command: npx
    #     args: ["-y", "@my-org/db-mcp-server"]
    #     env:
    #       DB_HOST: localhost
    #       DB_PORT: "5432"
    #
    # HTTP+SSE 传输示例（远程服务器）
    # - id: my-jira-server
    #   name: "Jira Integration"
    #   enabled: true
    #   config:
    #     transport: http
    #     url: https://mcp.example.com/jira
    #     headers:
    #       Authorization: "Bearer ${JIRA_TOKEN}"
```

- [ ] **Step 5：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/tools/mcp/types.ts src/config/schema.ts src/config/defaults.ts config.example.yaml
git commit -m "feat(mcp): add MCP configuration types and schema"
```

---

### Task 3：MCPClientManager（连接管理 + 工具发现）

**文件：** 创建 `src/tools/mcp/client.ts`

这是 MCP 客户端的核心——管理多个 MCP Server 的连接、发现工具、注册到 ToolRegistry。

- [ ] **Step 1：实现 MCPClientManager**

```typescript
// src/tools/mcp/client.ts
// MCP 客户端管理器：连接 MCP Server、发现工具、注册到 ToolRegistry
//
// 架构：
//   MCPClientManager
//     ├── Connection A (stdio) → MCPTool[] → ToolRegistry
//     ├── Connection B (http)  → MCPTool[] → ToolRegistry
//     └── ...

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { IToolRegistry } from '../types.js';
import type {
  MCPServerEntry,
  MCPConnectionInfo,
  MCPConnectionStatus,
} from './types.js';
import { MCPTool } from './mcp-tool.js';
import { logger } from '../../utils/logger.js';

/** 单个连接的内部状态 */
interface ConnectionState {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  entry: MCPServerEntry;
  status: MCPConnectionStatus;
  tools: MCPTool[];
  error?: string;
  connectedAt?: number;
}

/**
 * MCP 客户端管理器
 * 管理多个 MCP Server 连接，自动发现工具并注册到 ToolRegistry
 */
export class MCPClientManager {
  private connections = new Map<string, ConnectionState>();
  private registry: IToolRegistry;

  constructor(registry: IToolRegistry) {
    this.registry = registry;
  }

  /** 连接单个 MCP Server */
  async connect(entry: MCPServerEntry): Promise<MCPConnectionInfo> {
    if (this.connections.has(entry.id)) {
      logger.warn(`MCP server "${entry.id}" already connected, disconnecting first`);
      await this.disconnect(entry.id);
    }

    logger.info(`Connecting to MCP server: ${entry.name} (${entry.id})`, {
      transport: entry.config.transport,
    });

    const state: ConnectionState = {
      client: new Client({
        name: 'routedev',
        version: '0.6.0',
      }),
      transport: this.createTransport(entry),
      entry,
      status: 'connecting',
      tools: [],
    };

    this.connections.set(entry.id, state);

    try {
      // 连接（带超时）
      const timeout = entry.connectTimeout ?? 10000;
      await Promise.race([
        state.client.connect(state.transport),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`连接超时 (${timeout}ms)`)), timeout),
        ),
      ]);

      state.status = 'connected';
      state.connectedAt = Date.now();

      // 发现工具
      await this.discoverTools(entry.id);

      logger.info(`MCP server connected: ${entry.name}`, {
        toolCount: state.tools.length,
      });

      return this.getConnectionInfo(entry.id)!;
    } catch (error) {
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);

      logger.error(`Failed to connect MCP server: ${entry.name}`, {
        error: state.error,
      });

      // 清理失败的连接
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

  /** 断开单个 MCP Server */
  async disconnect(serverId: string): Promise<void> {
    const state = this.connections.get(serverId);
    if (!state) {
      logger.warn(`MCP server "${serverId}" not connected`);
      return;
    }

    // 从 ToolRegistry 注销该 Server 的所有工具
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

  /** 断开所有 MCP Server */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.connections.keys());
    await Promise.all(ids.map(id => this.disconnect(id)));
    logger.info('All MCP servers disconnected');
  }

  /** 获取连接信息 */
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

  /** 获取所有连接信息 */
  listConnections(): MCPConnectionInfo[] {
    return Array.from(this.connections.keys())
      .map(id => this.getConnectionInfo(id)!)
      .filter(Boolean);
  }

  /** 获取已连接的 Server 数量 */
  get connectedCount(): number {
    return Array.from(this.connections.values())
      .filter(s => s.status === 'connected').length;
  }

  /** 获取所有 MCP 工具总数 */
  get totalToolCount(): number {
    return Array.from(this.connections.values())
      .reduce((sum, s) => sum + s.tools.length, 0);
  }

  // ===== 内部方法 =====

  /** 创建传输层 */
  private createTransport(entry: MCPServerEntry): StdioClientTransport | SSEClientTransport {
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

    // HTTP + SSE
    return new SSEClientTransport(
      new URL(entry.config.url),
      {
        requestInit: {
          headers: entry.config.headers,
        },
      },
    );
  }

  /** 发现并注册 Server 的工具 */
  private async discoverTools(serverId: string): Promise<void> {
    const state = this.connections.get(serverId);
    if (!state) return;

    try {
      const result = await state.client.listTools();

      for (const mcpToolDef of result.tools) {
        // 工具名加 serverId 前缀避免冲突：mcp__{serverId}__{toolName}
        const namespacedName = `mcp__${serverId}__${mcpToolDef.name}`;

        const mcpTool = new MCPTool(
          namespacedName,
          mcpToolDef,
          state.client,
          state.entry,
        );

        // 注册到 ToolRegistry
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
```

- [ ] **Step 2：构建验证 → 提交**

---

### Task 4：MCPTool 适配器

**文件：** 创建 `src/tools/mcp/mcp-tool.ts`

将 MCP Server 提供的工具包装为 ITool 接口，让 MCP 工具能直接注册到 ToolRegistry。

- [ ] **Step 1：实现 MCPTool**

```typescript
// src/tools/mcp/mcp-tool.ts
// MCP 工具适配器：将 MCP Server 的工具包装为 ITool 接口
//
// MCP 工具 → MCPTool(ITool) → ToolRegistry
// LLM 调用 MCPTool.execute() → MCPTool 转发给 MCP Client → MCP Server 执行

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import type { MCPServerEntry } from './types.js';
import { logger } from '../../utils/logger.js';

/** MCP SDK 的工具定义类型（从 listTools 返回） */
interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP 工具包装器
 * 将 MCP Server 提供的工具适配为 RouteDev 的 ITool 接口
 */
export class MCPTool implements ITool {
  readonly definition: ToolDefinition;
  private client: Client;
  private serverEntry: MCPServerEntry;
  private originalToolName: string;

  constructor(
    namespacedName: string,
    mcpToolDef: MCPToolDefinition,
    client: Client,
    serverEntry: MCPServerEntry,
  ) {
    this.client = client;
    this.serverEntry = serverEntry;
    this.originalToolName = mcpToolDef.name;

    this.definition = {
      name: namespacedName,
      description: `[MCP:${serverEntry.name}] ${mcpToolDef.description ?? mcpToolDef.name}`,
      parameters: {
        type: 'object' as const,
        properties: mcpToolDef.inputSchema.properties ?? {},
        required: mcpToolDef.inputSchema.required ?? [],
      },
      requiresApproval: false, // MCP 工具的权限由 Server 自身控制
      category: 'system',      // ToolDefinition.category 枚举中没有 'mcp'
    };
  }

  validateArgs(_args: Record<string, unknown>): string | null {
    // MCP 工具的参数验证由 Server 端负责
    // 客户端不做预验证（Server 的 schema 可能比客户端理解的更复杂）
    return null;
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const timeout = context.timeoutMs ?? 30000;

    try {
      logger.debug('Calling MCP tool', {
        server: this.serverEntry.name,
        tool: this.originalToolName,
        argsKeys: Object.keys(args),
      });

      // 调用 MCP Server 的工具
      const result = await Promise.race([
        this.client.callTool({
          name: this.originalToolName,
          arguments: args,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`MCP 工具超时 (${timeout}ms)`)), timeout),
        ),
      ]);

      // 解析 MCP 返回结果
      const output = this.formatMCPResult(result);

      return {
        success: !(result as { isError?: boolean }).isError,
        output,
        error: (result as { isError?: boolean }).isError ? output : undefined,
        durationMs: 0,
        metadata: {
          serverId: this.serverEntry.id,
          serverName: this.serverEntry.name,
          originalName: this.originalToolName,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('MCP tool call failed', {
        server: this.serverEntry.name,
        tool: this.originalToolName,
        error: msg,
      });

      return {
        success: false,
        output: '',
        error: `MCP 工具调用失败 (${this.originalToolName}): ${msg}`,
        durationMs: 0,
      };
    }
  }

  /** 将 MCP 工具返回结果格式化为字符串 */
  private formatMCPResult(result: unknown): string {
    // MCP callTool 返回 { content: Array<{ type: string; text?: string; ... }> }
    if (result && typeof result === 'object' && 'content' in result) {
      const content = (result as { content: unknown[] }).content;
      if (Array.isArray(content)) {
        return content.map(item => {
          if (typeof item === 'object' && item !== null && 'text' in item) {
            return (item as { text: string }).text;
          }
          return JSON.stringify(item);
        }).join('\n');
      }
    }

    // 兜底：JSON 序列化
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/tools/mcp/mcp-tool.ts
git commit -m "feat(mcp): implement MCPTool adapter wrapping MCP tools as ITool"
```

---

### Task 5：MCP 配置管理（导入/导出）

**文件：** 创建 `src/tools/mcp/config-manager.ts`

管理 MCP Server 配置的持久化（读取/写入 mcp-config.json）。

- [ ] **Step 1：实现 MCPConfigManager**

```typescript
// src/tools/mcp/config-manager.ts
// MCP 配置管理器：从文件加载/保存 MCP Server 配置
//
// 配置来源（优先级从高到低）：
//   1. 项目级 .routedev-mcp.json
//   2. 全局 AppData/RouteDev/mcp-config.json
//   3. config.yaml 中的 mcp.servers

import fs from 'node:fs/promises';
import path from 'node:path';
import type { MCPServerEntry } from './types.js';
import { getAppDataDir } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

export interface MCPConfigFile {
  version: 1;
  servers: MCPServerEntry[];
}

export class MCPConfigManager {
  private servers: MCPServerEntry[] = [];

  /** 从文件加载配置 */
  async load(projectDir: string): Promise<MCPServerEntry[]> {
    this.servers = [];

    // 1. 全局配置
    const globalPath = path.join(getAppDataDir(), 'mcp-config.json');
    const globalServers = await this.loadFile(globalPath);
    this.servers.push(...globalServers);

    // 2. 项目级配置（覆盖全局同名 Server）
    const projectPath = path.join(projectDir, '.routedev-mcp.json');
    const projectServers = await this.loadFile(projectPath);

    for (const server of projectServers) {
      const existingIdx = this.servers.findIndex(s => s.id === server.id);
      if (existingIdx >= 0) {
        this.servers[existingIdx] = server; // 覆盖
      } else {
        this.servers.push(server);
      }
    }

    logger.info('MCP config loaded', {
      total: this.servers.length,
      global: globalServers.length,
      project: projectServers.length,
    });

    return this.servers;
  }

  /** 保存配置到全局文件 */
  async saveGlobal(): Promise<void> {
    const globalPath = path.join(getAppDataDir(), 'mcp-config.json');
    const config: MCPConfigFile = {
      version: 1,
      servers: this.servers,
    };

    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.info('MCP config saved', { path: globalPath });
  }

  /** 添加 Server */
  addServer(entry: MCPServerEntry): void {
    const existing = this.servers.findIndex(s => s.id === entry.id);
    if (existing >= 0) {
      this.servers[existing] = entry;
    } else {
      this.servers.push(entry);
    }
  }

  /** 移除 Server */
  removeServer(serverId: string): boolean {
    const before = this.servers.length;
    this.servers = this.servers.filter(s => s.id !== serverId);
    return this.servers.length < before;
  }

  /** 获取已启用的 Server 列表 */
  getEnabledServers(): MCPServerEntry[] {
    return this.servers.filter(s => s.enabled);
  }

  /** 获取所有 Server 列表 */
  getAllServers(): MCPServerEntry[] {
    return [...this.servers];
  }

  /** 导出配置为 JSON 字符串 */
  exportJSON(): string {
    return JSON.stringify({ version: 1, servers: this.servers }, null, 2);
  }

  /** 从 JSON 字符串导入配置 */
  importJSON(json: string): { added: number; updated: number } {
    let parsed: MCPConfigFile;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('无效的 JSON 格式');
    }

    if (!parsed.servers || !Array.isArray(parsed.servers)) {
      throw new Error('缺少 servers 字段');
    }

    let added = 0;
    let updated = 0;

    for (const entry of parsed.servers) {
      const existing = this.servers.findIndex(s => s.id === entry.id);
      if (existing >= 0) {
        this.servers[existing] = entry;
        updated++;
      } else {
        this.servers.push(entry);
        added++;
      }
    }

    return { added, updated };
  }

  // ===== 内部方法 =====

  /** 从单个文件加载 */
  private async loadFile(filePath: string): Promise<MCPServerEntry[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as MCPConfigFile;
      if (parsed.servers && Array.isArray(parsed.servers)) {
        return parsed.servers;
      }
      return [];
    } catch (error) {
      // 文件不存在或解析失败，静默返回空
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Failed to load MCP config: ${filePath}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return [];
    }
  }
}
```

- [ ] **Step 2：确认 getAppDataDir 可用**

检查 `src/utils/paths.ts` 是否导出了 `getAppDataDir()` 函数。Phase 1 已实现此函数，返回跨平台的 AppData 目录路径。如果函数名不同，按实际导出名调整 import。

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/tools/mcp/config-manager.ts
git commit -m "feat(mcp): implement MCP config manager with import/export"
```

---

### Task 6：CLI 集成（MCP 命令 + 自动连接）

**文件：** 修改 `src/cli/App.tsx`

将 MCP 客户端集成到 CLI——启动时自动连接已配置的 Server，新增 /mcp 命令管理连接。

- [ ] **Step 1：在 App 组件中初始化 MCP**

在 App.tsx 的工具初始化部分（Phase 7 注册内置工具之后），添加 MCP 客户端初始化：

```typescript
// 新增 import
import { MCPClientManager } from '../tools/mcp/client.js';
import { MCPConfigManager } from '../tools/mcp/config-manager.js';

// 在 useRef 初始化区域：

// 1. MCP 配置管理
const mcpConfigManager = new MCPConfigManager();

// 2. MCP 客户端管理（注册到同一个 ToolRegistry）
const mcpManager = new MCPClientManager(registry);

// 3. 自动连接（异步，不阻塞 UI 启动）
useEffect(() => {
  (async () => {
    try {
      // 从 config.yaml 的 mcp.servers 加载
      const mcpServers = config.mcp?.servers ?? [];

      // 从配置文件加载（全局 + 项目级）
      const fileServers = await mcpConfigManager.load(process.cwd());

      // 合并（config.yaml 优先）
      const allServers = [...fileServers];
      for (const server of mcpServers) {
        const existing = allServers.findIndex(s => s.id === server.id);
        if (existing >= 0) {
          allServers[existing] = server;
        } else {
          allServers.push(server);
        }
      }

      // 自动连接已启用的 Server
      if (config.mcp?.autoConnect) {
        const enabled = allServers.filter(s => s.enabled);
        for (const server of enabled) {
          const info = await mcpManager.connect(server);
          setMessages(prev => [...prev, {
            id: nextId(),
            role: 'system' as const,
            content: info.status === 'connected'
              ? `MCP: 已连接 ${info.serverName} (${info.toolCount} 个工具)`
              : `MCP: ${info.serverName} 连接失败 - ${info.error}`,
          }]);
        }
      }
    } catch (error) {
      logger.warn('MCP auto-connect failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  // 清理：退出时断开所有 MCP 连接
  return () => {
    mcpManager.disconnectAll().catch(() => {});
  };
}, []); // 只在组件挂载时执行一次
```

- [ ] **Step 2：新增 /mcp 命令**

在 App.tsx 的 `handleCommand` 中，添加 `/mcp` 命令：

```typescript
case '/mcp':
  const subCmd = parts[1]?.toLowerCase();
  switch (subCmd) {
    case 'list':
    case undefined: {
      const connections = mcpManager.listConnections();
      if (connections.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: 'MCP: 没有已连接的 Server。使用 /mcp connect <id> 连接。',
        }]);
      } else {
        const statusLines = connections.map(c => {
          const statusIcon = c.status === 'connected' ? '●' : c.status === 'error' ? '✗' : '○';
          return `  ${statusIcon} ${c.serverName} (${c.serverId}) — ${c.status}, ${c.toolCount} 工具`;
        });
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `MCP 连接状态:\n${statusLines.join('\n')}`,
        }]);
      }
      break;
    }

    case 'connect': {
      const serverId = parts[2];
      if (!serverId) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '用法: /mcp connect <server-id>',
        }]);
        break;
      }
      // 从配置中查找
      const allServers = mcpConfigManager.getAllServers();
      const serverEntry = allServers.find(s => s.id === serverId);
      if (!serverEntry) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `MCP: 未找到 Server "${serverId}"。检查配置文件。`,
        }]);
        break;
      }
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `MCP: 正在连接 ${serverEntry.name}...`,
      }]);
      const info = await mcpManager.connect(serverEntry);
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: info.status === 'connected'
          ? `MCP: 已连接 ${info.serverName} (${info.toolCount} 个工具)`
          : `MCP: 连接失败 - ${info.error}`,
      }]);
      break;
    }

    case 'disconnect': {
      const serverId = parts[2];
      if (!serverId) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '用法: /mcp disconnect <server-id>',
        }]);
        break;
      }
      await mcpManager.disconnect(serverId);
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `MCP: 已断开 ${serverId}`,
      }]);
      break;
    }

    default:
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          'MCP 命令：',
          '  /mcp list              — 查看所有连接状态',
          '  /mcp connect <id>      — 连接指定 Server',
          '  /mcp disconnect <id>   — 断开指定 Server',
        ].join('\n'),
      }]);
  }
  break;
```

- [ ] **Step 3：更新 /help 命令**

在 `/help` 的可用命令列表中添加：

```
  /mcp list              - 查看 MCP 连接状态
  /mcp connect <id>      - 连接 MCP Server
  /mcp disconnect <id>   - 断开 MCP Server
```

- [ ] **Step 4：在 StatusBar 显示 MCP 状态（可选）**

如果时间允许，在 StatusBar 中添加 MCP 连接数指示：

```typescript
// 在 StatusBar 中新增 MCP 连接数显示
<Text color="gray"> │ </Text>
<Text color="gray">MCP: </Text>
<Text>{mcpConnectedCount}</Text>
```

此步骤为可选增强，不影响核心功能。

- [ ] **Step 5：构建验证 → 测试 → 提交**

```powershell
pnpm build
pnpm typecheck
pnpm test
git add src/cli/App.tsx
git commit -m "feat(cli): integrate MCP client with auto-connect and /mcp commands"
```

---

### Task 7：单元测试

**文件：**
- 创建 `tests/tools/mcp-client.test.ts`
- 创建 `tests/tools/mcp-tool.test.ts`
- 创建 `tests/tools/mcp-config.test.ts`

- [ ] **Step 1：MCPTool 测试**

测试点（mock MCP Client）：
- MCPTool.definition 正确生成（name 有前缀、description 有 [MCP:] 标记、parameters 从 inputSchema 转换）
- execute() 正常调用 → 转发到 client.callTool() → 返回格式化结果
- execute() Server 返回 isError → success: false
- execute() 超时 → success: false, error 包含 "超时"
- formatMCPResult 正确处理 { content: [{ type: 'text', text: '...' }] }
- formatMCPResult 兜底 JSON 序列化

- [ ] **Step 2：MCPClientManager 测试**

测试点（mock MCP SDK 的 Client 和 Transport）：
- connect() 成功 → status: 'connected', toolCount > 0
- connect() 超时 → status: 'error', error 包含 "超时"
- connect() 后工具自动注册到 ToolRegistry
- disconnect() 后工具从 ToolRegistry 注销
- disconnectAll() 断开所有连接
- listConnections() 返回所有连接信息
- 重复 connect 同一 Server → 先断开再连接

- [ ] **Step 3：MCPConfigManager 测试**

测试点（使用临时目录）：
- load() 从全局配置文件加载
- load() 项目级配置覆盖全局
- saveGlobal() 写入文件
- addServer() / removeServer()
- getEnabledServers() 只返回 enabled: true 的
- exportJSON() / importJSON() 往返一致
- load() 文件不存在 → 静默返回空
- load() 文件损坏 → 静默返回空 + 记录警告

- [ ] **Step 4：运行全部测试 → 提交**

```powershell
pnpm test
git add tests/
git commit -m "test(mcp): add unit tests for MCP client, tool adapter, and config manager"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 175 个用例，Phase 7 的 ~145 + Phase 8 新增 ~30）
4. @modelcontextprotocol/sdk 已安装
5. MCPConfigManager 能从文件加载/保存 MCP Server 配置
6. MCPClientManager 能连接 stdio 和 HTTP+SSE 类型的 MCP Server
7. MCP Server 的工具自动发现并注册到 ToolRegistry（以 `mcp__{serverId}__{toolName}` 命名）
8. MCPTool 正确包装 MCP 工具为 ITool 接口
9. 断开连接时自动注销对应的 MCP 工具
10. CLI 启动时自动连接已配置的 MCP Server（如果 mcp.autoConnect: true）
11. /mcp list / connect / disconnect 命令正常工作
12. LLM 能调用 MCP 工具（与内置工具无感知差异）

## 注意事项

- **MCP SDK API 稳定性**：`@modelcontextprotocol/sdk` 仍在快速迭代中（目前 1.x），API 可能有 breaking changes。安装时锁定主版本，如有类型不匹配用 CONCERN 上报
- **Transport 导入路径**：SDK 的导入路径可能是 `@modelcontextprotocol/sdk/client/index.js`、`@modelcontextprotocol/sdk/client/stdio.js`、`@modelcontextprotocol/sdk/client/sse.js`（带 `.js` 后缀，ESM 风格）。如果不行尝试不带 `.js` 的路径
- **工具命名空间**：MCP 工具名格式为 `mcp__{serverId}__{toolName}`。使用双下划线 `__` 分隔，因为 Server 的 toolName 本身可能包含单下划线
- **MCP 工具权限**：MCP 工具的 `requiresApproval` 设为 `false`，权限由 MCP Server 自身控制。RouteDev 的 PermissionChecker 对 MCP 工具使用默认的 `auto` 级别
- **stdio 传输**：MCP Server 以子进程形式启动（类似 shell_exec），stdio 双向通信。进程退出时连接自动断开
- **HTTP+SSE 传输**：MCP Server 在远端运行，客户端通过 HTTP 连接 + Server-Sent Events 接收推送。需要 Server URL 可达
- **config.yaml vs mcp-config.json**：两种方式都可以配置 MCP Server。config.yaml 中的 `mcp.servers` 适合简单场景，mcp-config.json 适合复杂配置（如大量环境变量、认证 header）
- **MCP 配置中的环境变量**：`env` 字段支持 `${ENV_VAR}` 语法（由 config loader 的 replaceEnvVars 处理）。但 mcp-config.json 不经过 config loader，所以需要在 MCPConfigManager.load() 中手动处理环境变量替换，或者在加载后调用 `processEnvVars()` 工具函数
- **错误隔离**：MCP Server 连接失败不应影响 RouteDev 主程序运行。所有 MCP 操作都包在 try/catch 中，失败时在 CLI 显示警告消息
- **SSEClientTransport 参数**：SSE 传输的构造参数可能随 SDK 版本变化。如果 `new SSEClientTransport(url, options)` 不兼容，查看 SDK 文档或类型定义调整

---

*Phase 8 | 蓝图 V1.0 | 预估新增文件：~5 个 | 预估修改文件：~3 个（schema.ts、defaults.ts、App.tsx）*
