# Phase 6：工具框架 + 基础工具（file_read / file_write / file_search）

**回应**：Phase 5 无 CONCERN（执行人未上报）

**观察记录**（基于代码审阅）：
| # | 观察 | 处理 |
|---|------|------|
| O1 | `ToolExecutorAdapter.executeTool()` 接收 `args: Record<string, unknown>`（已解析对象），非字符串 | Phase 6 的实现直接使用此签名 |
| O2 | `MessageRole` 只有 `'system' \| 'user' \| 'assistant'`，没有 `'tool'` 角色 | 工具结果通过 user 消息中的 `ToolResultContent` ContentPart 注入 |
| O3 | `tools/types.ts` 已定义完整的 `ITool`、`IToolRegistry`、`IToolExecutor`、`ISecurityChecker`、`IPermissionChecker` 接口 | Phase 6 直接实现这些接口 |
| O4 | `simple-git` 已在 dependencies 中 | Phase 7 可直接使用 |
| O5 | `ToolCallRequest.arguments` 是 `Record<string, unknown>`（已解析），不是 JSON 字符串 | 工具接收已解析参数，与 `executeTool()` 签名一致 |

---

**目标**：实现工具框架（ToolRegistry + ToolExecutor + 权限/安全检查）+ 三个基础工具（file_read、file_write、file_search），替换 NoOpToolExecutor，让 ReActAgentLoop 真正具备工具调用能力。

**蓝图参考**：第五节决策 2（主进程+子进程）、第八节（Tool 层详细规格）、design-routedev-spec2.md §1（Tool 层接口）

**前置依赖**：Phase 5 全部完成

---

## 架构说明

Phase 6 的核心是把 `tools/types.ts` 中的五个接口变成真正的实现代码，然后桥接到 `ReActAgentLoop` 已有的 `ToolExecutorAdapter` 接口。

```
ReActAgentLoop (Phase 5)
  ↓ 调用
ToolExecutorAdapter 接口 (loop-config.ts)
  ↑ 实现
ToolRegistryAdapter (Phase 6 新增 — 桥梁)
  ↓ 委托
IToolRegistry (查工具) + IToolExecutor (执行) + IPermissionChecker + ISecurityChecker
  ↓ 具体工具
ITool: file_read / file_write / file_search (Phase 6)
       shell_exec / git_op / web_search / code_search (Phase 7)
       MCP 工具 (Phase 8)
```

**关键约束**：
- 文件操作限制在项目目录内（`ToolExecutionContext.workingDirectory` + `allowedDirectories`）
- `file_read` / `file_search` 权限为 `auto`（自动执行），`file_write` 权限为 `confirm`（需确认）
- 但 Phase 6 暂不实现交互式确认对话框（semi/auto 模式下先放行，manual 模式 Phase 9 处理）
- 安全层先实现目录边界检查，命令黑名单和网络确认留到 Phase 7

---

## 具体任务

### Task 1：ToolRegistry 实现

**文件：** 创建 `src/tools/registry.ts`

实现 `IToolRegistry` 接口——工具的注册、注销、查询、生成 function schema。

- [ ] **Step 1：实现 ToolRegistry**

```typescript
// src/tools/registry.ts
// 工具注册表：管理所有已注册的工具
// 实现 IToolRegistry 接口

import type { ITool, IToolRegistry, ToolDefinition } from './types.js';
import type { LLMToolDefinition } from '../router/types.js';
import { logger } from '../utils/logger.js';

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ITool>();

  register(tool: ITool): void {
    if (this.tools.has(tool.definition.name)) {
      logger.warn(`Tool "${tool.definition.name}" already registered, overwriting`);
    }
    this.tools.set(tool.definition.name, tool);
    logger.debug(`Tool registered: ${tool.definition.name}`, {
      category: tool.definition.category,
      requiresApproval: tool.definition.requiresApproval,
    });
  }

  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) {
      logger.debug(`Tool unregistered: ${name}`);
    }
    return deleted;
  }

  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /** 生成给 LLM function calling 用的 schema 列表 */
  getFunctionSchemas(): LLMToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.definition.name,
      description: tool.definition.description,
      parameters: tool.definition.parameters as Record<string, unknown>,
    }));
  }

  /** 获取工具总数 */
  get size(): number {
    return this.tools.size;
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

---

### Task 2：基础安全检查器

**文件：** 创建 `src/tools/security.ts`

实现 `ISecurityChecker` 接口——Phase 6 先实现文件路径检查（目录边界），命令检查和网络检查留到 Phase 7。

- [ ] **Step 1：实现 SecurityChecker**

```typescript
// src/tools/security.ts
// 安全检查器：验证工具操作是否安全
// Phase 6：实现文件路径检查（目录边界）
// Phase 7：添加命令检查和网络请求检查

import path from 'node:path';
import type { ISecurityChecker, SecurityCheckResult } from './types.js';
import type { SecurityConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export class SecurityChecker implements ISecurityChecker {
  private allowedDirs: string[];
  private sensitiveFiles: string[];
  private sensitiveFilePolicy: 'readonly' | 'deny';

  constructor(
    workingDirectory: string,
    securityConfig: SecurityConfig,
  ) {
    // 规范化目录路径
    this.allowedDirs = [path.resolve(workingDirectory)];
    this.sensitiveFiles = securityConfig.sensitiveFiles;
    this.sensitiveFilePolicy = securityConfig.sensitiveFilePolicy;

    logger.debug('SecurityChecker initialized', {
      allowedDirs: this.allowedDirs,
      sensitiveFiles: this.sensitiveFiles,
      policy: this.sensitiveFilePolicy,
    });
  }

  /** 检查文件路径是否在允许范围内 */
  checkFilePath(filePath: string, operation: 'read' | 'write'): SecurityCheckResult {
    const resolved = path.resolve(filePath);

    // 检查是否在允许的目录内
    const inAllowedDir = this.allowedDirs.some(dir =>
      resolved.startsWith(dir + path.sep) || resolved === dir,
    );

    if (!inAllowedDir) {
      return {
        allowed: false,
        reason: `路径 "${filePath}" 不在项目目录范围内`,
        requiresConfirmation: false, // 目录边界外直接拒绝，不允许覆盖
      };
    }

    // 检查是否为敏感文件
    const fileName = path.basename(resolved);
    const isSensitive = this.sensitiveFiles.some(pattern => {
      if (pattern.startsWith('*.')) {
        return fileName.endsWith(pattern.slice(1));
      }
      return fileName === pattern || resolved.endsWith(pattern);
    });

    if (isSensitive) {
      if (this.sensitiveFilePolicy === 'deny') {
        return {
          allowed: false,
          reason: `文件 "${fileName}" 是敏感文件，禁止访问`,
          requiresConfirmation: false,
        };
      }
      // readonly 策略：读取允许，写入拒绝
      if (operation === 'write') {
        return {
          allowed: false,
          reason: `文件 "${fileName}" 是敏感文件，只允许读取`,
          requiresConfirmation: false,
        };
      }
    }

    return { allowed: true, requiresConfirmation: false };
  }

  /** 检查 Shell 命令（Phase 7 实现） */
  checkCommand(command: string): SecurityCheckResult {
    // Phase 6 暂不检查命令，Phase 7 添加命令黑名单
    return { allowed: true, requiresConfirmation: false };
  }

  /** 检查网络请求（Phase 7 实现） */
  checkNetworkRequest(url: string): SecurityCheckResult {
    // Phase 6 暂不检查网络请求，Phase 7 添加域名白/黑名单
    return { allowed: true, requiresConfirmation: false };
  }

  /** 添加允许目录 */
  addAllowedDir(dirPath: string): void {
    const resolved = path.resolve(dirPath);
    if (!this.allowedDirs.includes(resolved)) {
      this.allowedDirs.push(resolved);
      logger.debug('Added allowed directory', { dir: resolved });
    }
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

---

### Task 3：ToolExecutor 实现

**文件：** 创建 `src/tools/executor.ts`

实现 `IToolExecutor` 接口——权限检查 → 安全检查 → 执行工具 → 返回结果。

- [ ] **Step 1：实现 ToolExecutor**

```typescript
// src/tools/executor.ts
// 工具执行器：权限检查 → 安全检查 → 执行 → 记录日志
// 实现 IToolExecutor 接口

import type {
  ITool,
  IToolExecutor,
  IToolRegistry,
  IPermissionChecker,
  ISecurityChecker,
  ToolResult,
  ToolExecutionContext,
} from './types.js';
import { logger } from '../utils/logger.js';

export class ToolExecutor implements IToolExecutor {
  private registry: IToolRegistry;
  private permissionChecker?: IPermissionChecker;
  private securityChecker?: ISecurityChecker;

  constructor(registry: IToolRegistry) {
    this.registry = registry;
  }

  setPermissionChecker(checker: IPermissionChecker): void {
    this.permissionChecker = checker;
  }

  setSecurityChecker(checker: ISecurityChecker): void {
    this.securityChecker = checker;
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    // 1. 查找工具
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `工具 "${toolName}" 未注册`,
        durationMs: Date.now() - startTime,
      };
    }

    // 2. 参数验证
    const validationError = tool.validateArgs(args);
    if (validationError) {
      return {
        success: false,
        output: '',
        error: `参数验证失败: ${validationError}`,
        durationMs: Date.now() - startTime,
      };
    }

    // 3. 权限检查
    if (this.permissionChecker) {
      const permResult = this.permissionChecker.checkPermission(toolName, args);
      if (!permResult.granted) {
        logger.warn('Tool execution denied by permission', {
          toolName,
          reason: permResult.reason,
        });
        return {
          success: false,
          output: '',
          error: `权限被拒绝: ${permResult.reason ?? '未知原因'}`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 4. 安全检查（对文件操作类工具检查路径）
    if (this.securityChecker && this.isFileOperation(toolName, args)) {
      const filePath = args.path as string ?? args.filePath as string;
      if (filePath) {
        const operation = toolName.includes('write') ? 'write' : 'read';
        const secResult = this.securityChecker.checkFilePath(filePath, operation);
        if (!secResult.allowed) {
          logger.warn('Tool execution denied by security', {
            toolName,
            filePath,
            reason: secResult.reason,
          });
          return {
            success: false,
            output: '',
            error: `安全检查失败: ${secResult.reason}`,
            durationMs: Date.now() - startTime,
          };
        }
      }
    }

    // 5. 执行工具
    try {
      logger.debug('Executing tool', { toolName, args });
      const result = await tool.execute(args, context);
      const duration = Date.now() - startTime;

      logger.debug('Tool executed', {
        toolName,
        success: result.success,
        durationMs: duration,
      });

      return { ...result, durationMs: duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      logger.error('Tool execution error', { toolName, error: errorMsg });

      return {
        success: false,
        output: '',
        error: `工具执行异常: ${errorMsg}`,
        durationMs: duration,
      };
    }
  }

  /** 判断是否为文件操作类工具 */
  private isFileOperation(toolName: string, args: Record<string, unknown>): boolean {
    return toolName.startsWith('file_') && ('path' in args || 'filePath' in args);
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

---

### Task 4：三个基础工具

**文件：**
- 创建 `src/tools/builtin/file-read.ts`
- 创建 `src/tools/builtin/file-write.ts`
- 创建 `src/tools/builtin/file-search.ts`

每个工具实现 `ITool` 接口。

- [ ] **Step 1：file_read**

```typescript
// src/tools/builtin/file-read.ts
// 读取文件内容
// 权限：auto（自动执行，无需确认）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class FileReadTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'file_read',
    description: '读取文件内容。支持指定行号范围。返回文件的文本内容。',
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对于项目根目录）',
        },
        startLine: {
          type: 'number',
          description: '起始行号（可选，从 1 开始）',
        },
        endLine: {
          type: 'number',
          description: '结束行号（可选，包含该行）',
        },
      },
      required: ['path'],
    },
    requiresApproval: false,
    category: 'file',
  };

  validateArgs(args: Record<string, unknown>): string | null {
    if (!args.path || typeof args.path !== 'string') {
      return '缺少必需参数: path';
    }
    return null;
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = path.resolve(context.workingDirectory, args.path as string);
    const startLine = (args.startLine as number) ?? 1;
    const endLine = args.endLine as number | undefined;

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // 如果有行号范围，截取指定行
      if (startLine > 1 || endLine) {
        const lines = content.split('\n');
        const start = Math.max(0, startLine - 1);
        const end = endLine ? Math.min(lines.length, endLine) : lines.length;
        const sliced = lines.slice(start, end);

        // 添加行号前缀
        const numbered = sliced.map((line, i) =>
          `${String(start + i + 1).padStart(4)} | ${line}`,
        ).join('\n');

        return {
          success: true,
          output: numbered,
          durationMs: 0,
          metadata: { totalLines: lines.length, shownLines: sliced.length },
        };
      }

      // 无行号范围，返回完整内容（带行号）
      const lines = content.split('\n');
      const numbered = lines.map((line, i) =>
        `${String(i + 1).padStart(4)} | ${line}`,
      ).join('\n');

      return {
        success: true,
        output: numbered,
        durationMs: 0,
        metadata: { totalLines: lines.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `读取文件失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
```

- [ ] **Step 2：file_write**

```typescript
// src/tools/builtin/file-write.ts
// 写入或创建文件
// 权限：confirm（需确认，但 Phase 6 暂自动放行）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class FileWriteTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'file_write',
    description: '写入内容到文件。如果文件不存在则创建，存在则覆盖。可指定追加模式。',
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对于项目根目录）',
        },
        content: {
          type: 'string',
          description: '要写入的内容',
        },
        append: {
          type: 'boolean',
          description: '是否追加模式（默认 false，覆盖写入）',
        },
      },
      required: ['path', 'content'],
    },
    requiresApproval: true,
    category: 'file',
  };

  validateArgs(args: Record<string, unknown>): string | null {
    if (!args.path || typeof args.path !== 'string') {
      return '缺少必需参数: path';
    }
    if (args.content === undefined || typeof args.content !== 'string') {
      return '缺少必需参数: content';
    }
    return null;
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = path.resolve(context.workingDirectory, args.path as string);
    const content = args.content as string;
    const append = (args.append as boolean) ?? false;

    try {
      // 确保父目录存在
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      if (append) {
        await fs.appendFile(filePath, content, 'utf-8');
      } else {
        await fs.writeFile(filePath, content, 'utf-8');
      }

      const stats = await fs.stat(filePath);
      const lines = content.split('\n').length;

      return {
        success: true,
        output: `文件${append ? '追加' : '写入'}成功: ${args.path} (${lines} 行, ${stats.size} 字节)`,
        durationMs: 0,
        metadata: { filePath, lines, bytes: stats.size, append },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `写入文件失败: ${msg}`,
        durationMs: 0,
      };
    }
  }
}
```

- [ ] **Step 3：file_search**

```typescript
// src/tools/builtin/file-search.ts
// 搜索文件内容或按名称查找文件
// 权限：auto

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class FileSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'file_search',
    description: '搜索文件。支持按内容搜索（grep）或按文件名模式（glob）查找。返回匹配的文件路径和行号。',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（内容搜索）',
        },
        pattern: {
          type: 'string',
          description: '文件名 glob 模式（如 "*.ts"、"*.test.*"）',
        },
        maxResults: {
          type: 'number',
          description: '最大返回结果数（默认 20）',
        },
      },
      required: [],
    },
    requiresApproval: false,
    category: 'file',
  };

  validateArgs(args: Record<string, unknown>): string | null {
    if (!args.query && !args.pattern) {
      return '至少需要提供 query（内容搜索）或 pattern（文件名搜索）之一';
    }
    return null;
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = args.query as string | undefined;
    const pattern = args.pattern as string | undefined;
    const maxResults = (args.maxResults as number) ?? 20;

    try {
      const results: string[] = [];

      // 递归遍历目录
      const files = await this.walkDir(context.workingDirectory, maxResults * 5);

      for (const filePath of files) {
        if (results.length >= maxResults) break;

        const relativePath = path.relative(context.workingDirectory, filePath);
        const fileName = path.basename(filePath);

        // 跳过 node_modules、.git、dist 等
        if (this.isIgnoredPath(relativePath)) continue;

        // 文件名模式匹配
        if (pattern && !this.matchGlob(fileName, pattern)) continue;

        // 内容搜索
        if (query) {
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            const matches: string[] = [];

            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                matches.push(`  ${i + 1}: ${lines[i].trim().slice(0, 100)}`);
                if (matches.length >= 3) break; // 每个文件最多 3 个匹配行
              }
            }

            if (matches.length > 0) {
              results.push(`${relativePath}\n${matches.join('\n')}`);
            }
          } catch {
            // 二进制文件或权限不足，跳过
          }
        } else {
          // 仅文件名匹配
          results.push(relativePath);
        }
      }

      if (results.length === 0) {
        return {
          success: true,
          output: '未找到匹配结果',
          durationMs: 0,
        };
      }

      return {
        success: true,
        output: `找到 ${results.length} 个结果:\n\n${results.join('\n\n')}`,
        durationMs: 0,
        metadata: { resultCount: results.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `搜索失败: ${msg}`,
        durationMs: 0,
      };
    }
  }

  /** 递归遍历目录（忽略隐藏目录和 node_modules） */
  private async walkDir(dir: string, maxFiles: number): Promise<string[]> {
    const files: string[] = [];

    async function walk(currentDir: string): Promise<void> {
      if (files.length >= maxFiles) return;

      let entries;
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          await walk(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    await walk(dir);
    return files;
  }

  /** 检查是否为忽略路径 */
  private isIgnoredPath(relativePath: string): boolean {
    const ignored = ['node_modules', '.git', 'dist', '.next', 'coverage', '__pycache__'];
    return ignored.some(dir => relativePath.startsWith(dir + '/') || relativePath.includes('/' + dir + '/'));
  }

  /** 简单 glob 匹配（支持 * 和 ?） */
  private matchGlob(fileName: string, pattern: string): boolean {
    const regex = new RegExp(
      '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return regex.test(fileName);
  }
}
```

- [ ] **Step 4：构建验证 → 提交**

---

### Task 5：ToolRegistryAdapter 桥梁

**文件：** 创建 `src/tools/adapter.ts`

这是连接 `ReActAgentLoop`（Phase 5）和工具框架（Phase 6）的关键桥梁。实现 `ToolExecutorAdapter` 接口，内部委托给 `ToolRegistry` + `ToolExecutor`。

- [ ] **Step 1：实现桥梁适配器**

```typescript
// src/tools/adapter.ts
// 桥梁适配器：连接 ReActAgentLoop 的 ToolExecutorAdapter 和工具框架的 IToolRegistry + IToolExecutor
//
// ToolExecutorAdapter (loop-config.ts) → Phase 5 的接口
//   ↕ 本文件
// IToolRegistry + IToolExecutor → Phase 6 的实现

import type { ToolExecutorAdapter } from '../agent/loop-config.js';
import type { LLMToolDefinition } from '../router/types.js';
import type { IToolRegistry, IToolExecutor, ToolExecutionContext } from './types.js';
import { logger } from '../utils/logger.js';

export class ToolRegistryAdapter implements ToolExecutorAdapter {
  private registry: IToolRegistry;
  private executor: IToolExecutor;
  private context: ToolExecutionContext;

  constructor(
    registry: IToolRegistry,
    executor: IToolExecutor,
    context: ToolExecutionContext,
  ) {
    this.registry = registry;
    this.executor = executor;
    this.context = context;
  }

  /** 获取当前可用工具的 LLM function schema */
  getToolDefinitions(): LLMToolDefinition[] {
    // 注意：如果 registry 是 ToolRegistry 类，可以直接调 getFunctionSchemas()
    // 但为了接口兼容，这里手动转换
    return this.registry.list().map(def => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters as Record<string, unknown>,
    }));
  }

  /** 执行工具调用
   *  args 来自 LLM 的 function calling，已经是解析好的对象
   */
  async executeTool(
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    logger.debug('ToolRegistryAdapter.executeTool', { toolName, toolCallId, args });

    const result = await this.executor.execute(toolName, args, this.context);

    if (result.success) {
      return result.output;
    }

    // 失败时返回错误描述（不抛异常，让 LLM 看到错误信息）
    return `[工具错误] ${toolName}: ${result.error ?? '未知错误'}`;
  }

  /** 检查工具是否存在 */
  hasTool(toolName: string): boolean {
    return this.registry.has(toolName);
  }

  /** 更新执行上下文（如项目目录变化时） */
  updateContext(context: Partial<ToolExecutionContext>): void {
    this.context = { ...this.context, ...context };
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

---

### Task 6：CLI 集成（启用工具）

**文件：** 修改 `src/cli/App.tsx`

将 `NoOpToolExecutor` 替换为 `ToolRegistryAdapter`，启用工具功能。

- [ ] **Step 1：修改 App.tsx**

关键改动：

```typescript
// 新增 import
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { SecurityChecker } from '../tools/security.js';
import { ToolRegistryAdapter } from '../tools/adapter.js';
import { FileReadTool } from '../tools/builtin/file-read.js';
import { FileWriteTool } from '../tools/builtin/file-write.js';
import { FileSearchTool } from '../tools/builtin/file-search.js';

// 在 App 组件内，替换 NoOpToolExecutor：

// 1. 初始化工具注册表
const registry = new ToolRegistry();
registry.register(new FileReadTool());
registry.register(new FileWriteTool());
registry.register(new FileSearchTool());

// 2. 初始化安全检查器
const securityChecker = new SecurityChecker(
  process.cwd(), // 项目目录
  config.security,
);

// 3. 初始化执行器
const toolExecutor = new ToolExecutor(registry);
toolExecutor.setSecurityChecker(securityChecker);

// 4. 创建桥梁适配器
const adapter = new ToolRegistryAdapter(registry, toolExecutor, {
  workingDirectory: process.cwd(),
  allowedDirectories: [process.cwd()],
  environment: {},
  timeoutMs: 30000,
});

// 5. 创建 ReActAgentLoop（启用工具）
const loopRef = useRef(
  new ReActAgentLoop(adapter, {
    maxIterations: 10,
    toolsEnabled: true, // ← 关键：启用工具
  }),
);
```

- [ ] **Step 2：在 tool_call_start 事件中显示工具调用状态**

App.tsx 的 `handleSubmit` 中，给 `tool_call_start` 和 `tool_call_result` 事件添加简单的 UI 反馈：

```typescript
case 'tool_call_start':
  // 在对话中显示工具调用指示
  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: `🔧 调用工具: ${event.toolName}`,
  }]);
  break;

case 'tool_call_result':
  if (event.isError) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `❌ 工具 ${event.toolName} 执行失败`,
    }]);
  }
  break;
```

- [ ] **Step 3：构建验证 → 测试 → 提交**

---

### Task 7：单元测试

**文件：**
- 创建 `tests/tools/registry.test.ts`
- 创建 `tests/tools/builtin.test.ts`
- 创建 `tests/tools/security.test.ts`

- [ ] **Step 1：ToolRegistry 测试**

测试点：注册/注销/查询/重复注册/size/getFunctionSchemas

- [ ] **Step 2：基础工具测试**

测试点（使用临时目录）：
- file_read：读取文件、行号范围、文件不存在
- file_write：创建文件、覆盖写入、追加模式、自动创建目录
- file_search：内容搜索、文件名搜索、最大结果数

- [ ] **Step 3：SecurityChecker 测试**

测试点：
- 项目目录内文件 → 允许
- 项目目录外文件 → 拒绝
- 敏感文件读取 → 允许（readonly 策略）
- 敏感文件写入 → 拒绝（readonly 策略）

- [ ] **Step 4：运行全部测试 → 提交**

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 110 个用例）
4. ToolRegistry 支持注册/注销/查询/生成 function schema
5. ToolExecutor 执行流程：权限 → 安全 → 执行 → 返回结果
6. SecurityChecker 正确拦截项目目录外的文件访问
7. file_read / file_write / file_search 三个工具正常工作
8. ToolRegistryAdapter 正确桥接 ReActAgentLoop 和工具框架
9. CLI 中 ReActAgentLoop 已启用工具（toolsEnabled: true）
10. LLM 返回工具调用时能正确执行并循环

## 注意事项

- **权限确认**：`file_write` 的 `requiresApproval: true` 在 Phase 6 暂不触发交互式确认对话框。Phase 9（自主模式）实现 `IPermissionChecker` 的 confirm 逻辑。当前 semi/auto 模式下所有工具直接放行
- **文件路径**：所有工具的 `path` 参数相对于 `context.workingDirectory`（项目根目录）。安全检查用 `path.resolve()` 转为绝对路径再比较
- **file_search 性能**：当前实现是纯 JS 递归遍历 + 字符串 includes。Phase 7 的 code_search 工具会用 ripgrep 替代，性能更好
- **ToolExecutorAdapter 签名**：`executeTool(toolName, toolCallId, args)` 中 `args` 是 `Record<string, unknown>`（已解析对象），不是 JSON 字符串
- **ContentPart 消息注入**：工具结果在 ReActAgentLoop 中通过 `ToolResultContent` ContentPart 注入到 user 消息中，不使用独立的 `tool` 角色消息（因为 `MessageRole` 没有 `'tool'`）
- **Phase 5 踩坑清单**：ILLMClient、RoutingResult、ReActEvent 等实际类型名与 Phase 5 spec 有差异，本 Phase 以实际代码为准

---

*Phase 6 | 蓝图 V1.0 | 预估新增文件：~8 个 | 预估修改文件：~1 个（App.tsx）*
