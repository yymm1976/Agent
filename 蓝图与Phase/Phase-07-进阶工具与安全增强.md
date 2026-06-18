# Phase 7：进阶工具（shell_exec / git_op / web_search / code_search）+ 安全增强

**回应**：Phase 6 无 CONCERN（等待执行人报告）

**观察记录**（基于代码审阅）：
| # | 观察 | 处理 |
|---|------|------|
| O1 | Phase 6 的 `SecurityChecker.checkCommand()` 和 `checkNetworkRequest()` 都是空壳（直接返回 allowed） | Phase 7 补全实现 |
| O2 | Phase 6 未实现 `IPermissionChecker`，`ToolExecutor.setPermissionChecker()` 无人调用 | Phase 7 实现 PermissionChecker |
| O3 | `simple-git` ^3.36.0 已在 dependencies 中 | git_op 直接使用，无需新增依赖 |
| O4 | `ToolExecutionContext` 包含 `workingDirectory`、`allowedDirectories`、`environment`、`timeoutMs` | shell_exec 用 timeoutMs 控制超时 |
| O5 | `ToolDefinition.category` 已有 `'shell' \| 'git' \| 'web' \| 'search' \| 'code'` 枚举 | 四个工具各用对应 category |
| O6 | `SecurityConfig` 包含 `commandBlacklist`、`commandWhitelist`、`networkConfirm`、`sensitiveFiles`、`sensitiveFilePolicy` | 直接读取配置驱动安全检查 |

---

**目标**：实现四个进阶工具（shell_exec、git_op、web_search、code_search），补全 SecurityChecker 的命令黑名单和网络请求检查，实现 PermissionChecker 权限系统，让 RouteDev 的七个内置工具全部就位。

**蓝图参考**：第八节 8.2（并发规则）、8.3（内置工具列表）、第九节 9.1（安全策略：命令控制、网络请求确认）

**前置依赖**：Phase 6 全部完成（ToolRegistry、SecurityChecker、ToolExecutor、三个基础工具）

---

## 架构说明

Phase 7 在 Phase 6 的工具框架上"填空"——把 Phase 6 预留的桩（命令检查、网络检查、权限检查）补上，再新增四个工具注册到同一个 ToolRegistry。

```
Phase 6 已有：
  ToolRegistry ← file_read, file_write, file_search
  SecurityChecker（checkFilePath ✓，checkCommand ✗，checkNetworkRequest ✗）
  ToolExecutor（权限检查桩 → 无人接入）

Phase 7 新增：
  SecurityChecker.checkCommand() → 命令黑名单匹配
  SecurityChecker.checkNetworkRequest() → 域名白/黑名单 + 确认标志
  PermissionChecker ← 权限规则匹配（auto/confirm/deny）
  ToolRegistry ← shell_exec, git_op, web_search, code_search
```

**shell_exec 和 git_op 在子进程中执行**（蓝图决策 2："老板+打工"模式），web_search 和 code_search 不需要子进程（web_search 用 Node.js 原生 fetch，code_search 包装系统 ripgrep 的 child_process）。

---

## 具体任务

### Task 1：SecurityChecker 增强

**文件：** 修改 `src/tools/security.ts`

Phase 6 的 `checkCommand()` 和 `checkNetworkRequest()` 是空壳。Phase 7 补全实现。

- [ ] **Step 1：补全 checkCommand()**

在 `SecurityChecker` 类中，新增 `commandBlacklist` 和 `commandWhitelist` 字段，实现命令检查逻辑：

```typescript
// 在构造函数中新增：
private commandBlacklist: string[];
private commandWhitelist: string[];

constructor(workingDirectory: string, securityConfig: SecurityConfig) {
  // ...已有的代码保持不变...
  this.commandBlacklist = securityConfig.commandBlacklist;
  this.commandWhitelist = securityConfig.commandWhitelist;
}

/** 检查 Shell 命令是否安全 */
checkCommand(command: string): SecurityCheckResult {
  const normalized = command.trim().toLowerCase();

  // 1. 黑名单检查（精确匹配 + 前缀匹配）
  for (const blocked of this.commandBlacklist) {
    const blockedLower = blocked.toLowerCase();
    // 精确匹配或包含匹配（如 "rm -rf" 匹配 "rm -rf /"）
    if (normalized === blockedLower || normalized.startsWith(blockedLower + ' ')) {
      return {
        allowed: false,
        reason: `命令 "${command}" 命中黑名单: ${blocked}`,
        requiresConfirmation: false, // 黑名单直接拒绝，不允许覆盖
      };
    }
  }

  // 2. 危险模式检测（正则匹配常见危险操作）
  const dangerousPatterns = [
    /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\//,  // rm -rf /
    /\bformat\s+[a-zA-Z]:/i,                  // format C:
    /\bdel\s+\/[sS]/,                          // del /s
    /\bmkfs\b/,                                // mkfs
    /\bdd\s+.*\bof=\/dev\//,                   // dd of=/dev/...
    /:\(\)\s*\{/,                               // fork bomb
    /\bshutdown\b/i,
    /\breboot\b/i,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `命令 "${command}" 匹配危险模式: ${pattern.source}`,
        requiresConfirmation: false,
      };
    }
  }

  // 3. 白名单检查（如果白名单非空，只允许白名单内的命令）
  if (this.commandWhitelist.length > 0) {
    const firstWord = normalized.split(/\s+/)[0];
    const inWhitelist = this.commandWhitelist.some(
      allowed => firstWord === allowed.toLowerCase(),
    );
    if (!inWhitelist) {
      return {
        allowed: false,
        reason: `命令 "${firstWord}" 不在白名单中`,
        requiresConfirmation: true, // 白名单外可以确认后执行
      };
    }
  }

  return { allowed: true, requiresConfirmation: false };
}
```

- [ ] **Step 2：补全 checkNetworkRequest()**

```typescript
// 新增字段：
private networkConfirm: boolean;

constructor(workingDirectory: string, securityConfig: SecurityConfig) {
  // ...已有的代码保持不变...
  this.networkConfirm = securityConfig.networkConfirm;
}

/** 检查网络请求是否允许 */
checkNetworkRequest(url: string): SecurityCheckResult {
  // 解析域名
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return {
      allowed: false,
      reason: `无效 URL: ${url}`,
      requiresConfirmation: false,
    };
  }

  // 1. 禁止域名黑名单
  const deniedDomains = ['malware.example.com']; // 可从配置扩展
  for (const denied of deniedDomains) {
    if (hostname === denied || hostname.endsWith('.' + denied)) {
      return {
        allowed: false,
        reason: `域名 "${hostname}" 在禁止列表中`,
        requiresConfirmation: false,
      };
    }
  }

  // 2. 需要确认的网络请求
  if (this.networkConfirm) {
    return {
      allowed: true,
      requiresConfirmation: true, // 需要用户确认
      reason: `网络请求到 "${hostname}" 需要确认`,
    };
  }

  return { allowed: true, requiresConfirmation: false };
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/tools/security.ts
git commit -m "feat(tools): enhance SecurityChecker with command blacklist and network checks"
```

---

### Task 2：PermissionChecker 实现

**文件：** 创建 `src/tools/permission.ts`

实现 `IPermissionChecker` 接口——基于规则的权限检查（auto/confirm/deny）。

- [ ] **Step 1：实现 PermissionChecker**

```typescript
// src/tools/permission.ts
// 权限检查器：根据规则判断工具是否需要确认
// 实现 IPermissionChecker 接口

import type { IPermissionChecker, PermissionLevel, PermissionRule } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * 权限检查结果
 */
export interface PermissionCheckResult {
  granted: boolean;
  level: PermissionLevel;
  reason?: string;
}

/**
 * 权限检查器配置
 * MVP 阶段：semi 模式下 confirm → 自动放行并记录日志
 * Phase 9（自主模式）：confirm → 弹出交互式确认对话框
 */
export class PermissionChecker implements IPermissionChecker {
  private rules: PermissionRule[] = [];
  /** MVP 模式：confirm 级别是否自动放行 */
  private autoApproveConfirm: boolean;

  constructor(autoApproveConfirm: boolean = true) {
    this.autoApproveConfirm = autoApproveConfirm;
  }

  /** 检查工具执行权限 */
  checkPermission(
    toolName: string,
    args: Record<string, unknown>,
  ): PermissionCheckResult {
    const level = this.getPermissionLevel(toolName);

    switch (level) {
      case 'auto':
        return { granted: true, level: 'auto' };

      case 'deny':
        logger.warn('Tool execution denied by permission rule', { toolName });
        return {
          granted: false,
          level: 'deny',
          reason: `工具 "${toolName}" 被权限规则禁止`,
        };

      case 'confirm':
        if (this.autoApproveConfirm) {
          logger.debug('Tool auto-approved (confirm → auto)', { toolName });
          return { granted: true, level: 'confirm', reason: '自动确认（MVP 模式）' };
        }
        // Phase 9：这里会弹出交互式确认对话框
        // 当前 MVP 阶段不实现
        return {
          granted: false,
          level: 'confirm',
          reason: `工具 "${toolName}" 需要用户确认（交互式确认将在 Phase 9 实现）`,
        };
    }
  }

  /** 添加权限规则 */
  addRule(rule: PermissionRule): void {
    // 移除同名旧规则
    this.rules = this.rules.filter(r => r.toolPattern !== rule.toolPattern);
    this.rules.push(rule);
    logger.debug('Permission rule added', {
      pattern: rule.toolPattern,
      level: rule.level,
    });
  }

  /** 移除权限规则 */
  removeRule(toolPattern: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter(r => r.toolPattern !== toolPattern);
    return this.rules.length < before;
  }

  /** 获取工具的权限级别 */
  private getPermissionLevel(toolName: string): PermissionLevel {
    // 按规则匹配（第一个匹配的规则生效）
    for (const rule of this.rules) {
      if (this.matchPattern(toolName, rule.toolPattern)) {
        return rule.level;
      }
    }

    // 无规则匹配 → 默认 auto
    return 'auto';
  }

  /** 简单的 glob 匹配（支持 * 通配符） */
  private matchPattern(toolName: string, pattern: string): boolean {
    if (pattern === '*') return true;
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return regex.test(toolName);
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/tools/permission.ts
git commit -m "feat(tools): implement PermissionChecker with auto/confirm/deny rules"
```

---

### Task 3：shell_exec 工具

**文件：** 创建 `src/tools/builtin/shell-exec.ts`

在子进程中执行 Shell 命令，有超时控制、命令黑名单检查。

- [ ] **Step 1：实现 ShellExecTool**

```typescript
// src/tools/builtin/shell-exec.ts
// 执行 Shell 命令
// 权限：confirm（需确认，MVP 模式自动放行）
// 子进程：是（child_process.spawn）

import { spawn } from 'node:child_process';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class ShellExecTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'shell_exec',
    description: '在子进程中执行 Shell 命令。支持超时控制。返回命令的 stdout 和 stderr 输出。',
    parameters: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令',
        },
        timeout: {
          type: 'number',
          description: '超时时间（毫秒，默认 30000，最大 120000）',
        },
        cwd: {
          type: 'string',
          description: '工作目录（可选，默认项目根目录）',
        },
      },
      required: ['command'],
    },
    requiresApproval: true,
    category: 'shell',
  };

  validateArgs(args: Record<string, unknown>): string | null {
    if (!args.command || typeof args.command !== 'string') {
      return '缺少必需参数: command';
    }
    if (args.command.trim().length === 0) {
      return '命令不能为空';
    }
    return null;
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const command = args.command as string;
    const timeout = Math.min(
      (args.timeout as number) ?? context.timeoutMs ?? 30000,
      120000, // 最大 2 分钟
    );
    const cwd = (args.cwd as string) ?? context.workingDirectory;

    return new Promise<ToolResult>((resolve) => {
      const startTime = Date.now();

      // 根据平台选择 shell
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellArgs = isWindows ? ['/c', command] : ['-c', command];

      const child = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env, ...context.environment },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        // 限制输出大小，防止 OOM（最大 100KB）
        if (stdout.length > 100_000) {
          stdout = stdout.slice(0, 100_000) + '\n... [输出截断]';
          child.kill('SIGTERM');
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > 50_000) {
          stderr = stderr.slice(0, 50_000) + '\n... [错误输出截断]';
        }
      });

      child.on('error', (error) => {
        resolve({
          success: false,
          output: '',
          error: `命令执行失败: ${error.message}`,
          durationMs: Date.now() - startTime,
        });
      });

      child.on('close', (code, signal) => {
        if (signal === 'SIGTERM' && killed) {
          resolve({
            success: false,
            output: stdout,
            error: `命令超时（${timeout}ms）`,
            durationMs: Date.now() - startTime,
            metadata: { exitCode: code, signal, timeout: true },
          });
          return;
        }

        const duration = Date.now() - startTime;

        if (code === 0) {
          resolve({
            success: true,
            output: stdout || '(无输出)',
            durationMs: duration,
            metadata: { exitCode: code, stderr: stderr || undefined },
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `命令退出码: ${code}`,
            durationMs: duration,
            metadata: { exitCode: code, stderr },
          });
        }
      });

      // 超时处理
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        // 给子进程 2 秒优雅退出，否则强杀
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2000);
      }, timeout);

      child.on('close', () => clearTimeout(timer));
    });
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/tools/builtin/shell-exec.ts
git commit -m "feat(tools): implement shell_exec tool with child_process and timeout"
```

---

### Task 4：git_op 工具

**文件：** 创建 `src/tools/builtin/git-op.ts`

包装 `simple-git` 实现 Git 操作。读操作（status/log/diff/branch）权限为 auto，写操作（add/commit/push/checkout/stash）权限为 confirm。

- [ ] **Step 1：实现 GitOpTool**

```typescript
// src/tools/builtin/git-op.ts
// Git 操作封装
// 权限：auto(读: status/log/diff/branch) / confirm(写: add/commit/push/checkout/stash)
// 子进程：是（simple-git 内部使用 child_process）

import simpleGit, { type SimpleGit } from 'simple-git';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

/** 写操作列表（需要确认权限） */
const WRITE_OPERATIONS = ['add', 'commit', 'push', 'checkout', 'stash', 'reset', 'merge', 'rebase'];

/** 读操作列表（自动权限） */
const READ_OPERATIONS = ['status', 'log', 'diff', 'branch', 'show', 'tag', 'remote'];

export class GitOpTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'git_op',
    description: `执行 Git 操作。
支持的操作：
  读(auto)：status, log, diff, branch, show, tag, remote
  写(confirm)：add, commit, push, checkout, stash, reset, merge, rebase
返回操作结果文本。`,
    parameters: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string',
          description: 'Git 操作类型',
          enum: [...READ_OPERATIONS, ...WRITE_OPERATIONS],
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '操作参数列表',
        },
        message: {
          type: 'string',
          description: 'commit 消息（仅 commit 操作需要）',
        },
      },
      required: ['operation'],
    },
    requiresApproval: true, // 动态判断：读操作实际 auto，写操作 confirm
    category: 'git',
  };

  validateArgs(args: Record<string, unknown>): string | null {
    if (!args.operation || typeof args.operation !== 'string') {
      return '缺少必需参数: operation';
    }
    const op = args.operation as string;
    const allOps = [...READ_OPERATIONS, ...WRITE_OPERATIONS];
    if (!allOps.includes(op)) {
      return `不支持的操作: ${op}。支持: ${allOps.join(', ')}`;
    }
    if (op === 'commit' && !args.message) {
      return 'commit 操作需要 message 参数';
    }
    return null;
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const operation = args.operation as string;
    const opArgs = (args.args as string[]) ?? [];
    const message = args.message as string | undefined;

    const git: SimpleGit = simpleGit(context.workingDirectory);

    try {
      let output: string;

      switch (operation) {
        case 'status': {
          const status = await git.status();
          output = [
            `分支: ${status.current}`,
            `跟踪: ${status.tracking ?? '无'}`,
            '',
            status.files.length > 0
              ? `变更文件 (${status.files.length}):\n` + status.files.map(f =>
                  `  ${f.index} ${f.working_dir} ${f.path}`).join('\n')
              : '工作目录干净',
          ].join('\n');
          break;
        }

        case 'log': {
          const count = opArgs[0] ? parseInt(opArgs[0], 10) || 10 : 10;
          const log = await git.log({ maxCount: count });
          output = log.all.map(entry =>
            `${entry.hash.slice(0, 7)} ${entry.date.slice(0, 10)} ${entry.author_name}: ${entry.message}`,
          ).join('\n');
          break;
        }

        case 'diff': {
          const diffArgs = opArgs.length > 0 ? opArgs : [];
          output = await git.diff(diffArgs);
          if (!output.trim()) {
            output = '(无差异)';
          }
          break;
        }

        case 'branch': {
          if (opArgs.length > 0) {
            // 创建分支
            await git.checkoutLocalBranch(opArgs[0]);
            output = `已创建并切换到分支: ${opArgs[0]}`;
          } else {
            const branches = await git.branchLocal();
            output = branches.all.map(b =>
              b === branches.current ? `* ${b}` : `  ${b}`,
            ).join('\n');
          }
          break;
        }

        case 'show': {
          const ref = opArgs[0] ?? 'HEAD';
          output = await git.show([ref]);
          break;
        }

        case 'tag': {
          if (opArgs.length > 0) {
            await git.addTag(opArgs[0]);
            output = `已创建标签: ${opArgs[0]}`;
          } else {
            const tags = await git.tags();
            output = tags.all.length > 0 ? tags.all.join('\n') : '(无标签)';
          }
          break;
        }

        case 'remote': {
          const remotes = await git.getRemotes(true);
          output = remotes.map(r => `${r.name}\t${r.refs.fetch}`).join('\n') || '(无远程仓库)';
          break;
        }

        case 'add': {
          const files = opArgs.length > 0 ? opArgs : ['.'];
          await git.add(files);
          output = `已暂存: ${files.join(', ')}`;
          break;
        }

        case 'commit': {
          const result = await git.commit(message!, opArgs.length > 0 ? opArgs : undefined);
          output = `提交成功: ${result.commit}\n${result.summary.changes} 变更, ${result.summary.insertions} 新增, ${result.summary.deletions} 删除`;
          break;
        }

        case 'push': {
          const remote = opArgs[0] ?? 'origin';
          const branch = opArgs[1]; // 可选
          await git.push(remote, branch);
          output = branch ? `已推送到 ${remote}/${branch}` : `已推送到 ${remote}`;
          break;
        }

        case 'checkout': {
          if (opArgs.length === 0) {
            return {
              success: false,
              output: '',
              error: 'checkout 需要指定分支或文件',
              durationMs: 0,
            };
          }
          await git.checkout(opArgs[0], opArgs.slice(1));
          output = `已切换到: ${opArgs[0]}`;
          break;
        }

        case 'stash': {
          const subCmd = opArgs[0] ?? 'push';
          if (subCmd === 'push') {
            const stashMsg = message ?? 'auto stash';
            await git.stash(['push', '-m', stashMsg]);
            output = `已暂存当前变更: ${stashMsg}`;
          } else if (subCmd === 'pop') {
            await git.stash(['pop']);
            output = '已恢复最近一次暂存';
          } else if (subCmd === 'list') {
            output = await git.stash(['list']);
            if (!output.trim()) output = '(无暂存记录)';
          } else {
            await git.stash([subCmd, ...opArgs.slice(1)]);
            output = `stash ${subCmd} 完成`;
          }
          break;
        }

        case 'reset': {
          const mode = opArgs[0] ?? '--mixed';
          const target = opArgs[1] ?? 'HEAD';
          await git.reset([mode, target]);
          output = `已重置到 ${target} (${mode})`;
          break;
        }

        case 'merge': {
          if (opArgs.length === 0) {
            return {
              success: false, output: '',
              error: 'merge 需要指定分支名',
              durationMs: 0,
            };
          }
          const result = await git.merge(opArgs);
          output = `合并完成: ${result.summary.changes} 变更`;
          break;
        }

        case 'rebase': {
          if (opArgs.length === 0) {
            return {
              success: false, output: '',
              error: 'rebase 需要指定分支名',
              durationMs: 0,
            };
          }
          await git.rebase(opArgs);
          output = `rebase 到 ${opArgs[0]} 完成`;
          break;
        }

        default:
          return {
            success: false,
            output: '',
            error: `未实现的操作: ${operation}`,
            durationMs: 0,
          };
      }

      return {
        success: true,
        output,
        durationMs: 0,
        metadata: { operation, isWriteOp: WRITE_OPERATIONS.includes(operation) },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `Git 操作失败 (${operation}): ${msg}`,
        durationMs: 0,
      };
    }
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/tools/builtin/git-op.ts
git commit -m "feat(tools): implement git_op tool with simple-git wrapper"
```

---

### Task 5：web_search + code_search 工具

**文件：**
- 创建 `src/tools/builtin/web-search.ts`
- 创建 `src/tools/builtin/code-search.ts`

- [ ] **Step 1：web_search**

```typescript
// src/tools/builtin/web-search.ts
// 网络搜索（使用 DuckDuckGo HTML 搜索 + 原生 fetch）
// 权限：auto
// 不依赖第三方 API Key，MVP 阶段使用网页抓取

import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class WebSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'web_search',
    description: '搜索网络信息。返回搜索结果列表（标题 + 摘要 + 链接）。',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词',
        },
        maxResults: {
          type: 'number',
          description: '最大返回结果数（默认 5，最大 10）',
        },
      },
      required: ['query'],
    },
    requiresApproval: false,
    category: 'web',
  };

  validateArgs(args: Record<string, unknown>): string | null {
    if (!args.query || typeof args.query !== 'string') {
      return '缺少必需参数: query';
    }
    return null;
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = args.query as string;
    const maxResults = Math.min((args.maxResults as number) ?? 5, 10);

    try {
      // 使用 DuckDuckGo HTML 搜索（无需 API Key）
      const encodedQuery = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) RouteDev/0.6.0',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000), // 15 秒超时
      });

      if (!response.ok) {
        return {
          success: false,
          output: '',
          error: `搜索请求失败: HTTP ${response.status}`,
          durationMs: 0,
        };
      }

      const html = await response.text();
      const results = this.parseSearchResults(html, maxResults);

      if (results.length === 0) {
        return {
          success: true,
          output: `搜索 "${query}" 未找到结果`,
          durationMs: 0,
        };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`,
      ).join('\n\n');

      return {
        success: true,
        output: `搜索 "${query}" 找到 ${results.length} 个结果:\n\n${formatted}`,
        durationMs: 0,
        metadata: { resultCount: results.length, query },
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

  /** 从 DuckDuckGo HTML 解析搜索结果 */
  private parseSearchResults(
    html: string,
    maxResults: number,
  ): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // 简单的正则解析（DuckDuckGo HTML 版本结构较简单）
    const resultRegex = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/[^>]+>/g;
    let match;

    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const url = this.decodeDuckDuckGoUrl(match[1]);
      const title = this.stripHtml(match[2]).trim();
      const snippet = this.stripHtml(match[3]).trim();

      if (title && url) {
        results.push({ title, url, snippet: snippet.slice(0, 200) });
      }
    }

    return results;
  }

  /** 解码 DuckDuckGo 重定向 URL */
  private decodeDuckDuckGoUrl(url: string): string {
    if (url.includes('uddg=')) {
      try {
        const uddg = new URLSearchParams(url.split('?')[1]).get('uddg');
        return uddg ? decodeURIComponent(uddg) : url;
      } catch {
        return url;
      }
    }
    return url;
  }

  /** 去除 HTML 标签 */
  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
}
```

- [ ] **Step 2：code_search**

```typescript
// src/tools/builtin/code-search.ts
// 代码搜索（使用 ripgrep 或回退到纯 JS 搜索）
// 权限：auto
// 优先使用系统安装的 ripgrep (rg)，不可用时回退到纯 JS 实现

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class CodeSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'code_search',
    description: `搜索代码内容。支持正则表达式、文件名过滤。优先使用 ripgrep（高性能），不可用时回退到纯 JS 搜索。
返回匹配的文件路径、行号和内容。`,
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词或正则表达式',
        },
        filePattern: {
          type: 'string',
          description: '文件名过滤 glob（如 "*.ts"、"*.tsx"）',
        },
        caseSensitive: {
          type: 'boolean',
          description: '是否大小写敏感（默认 false）',
        },
        maxResults: {
          type: 'number',
          description: '最大返回结果数（默认 30）',
        },
      },
      required: ['query'],
    },
    requiresApproval: false,
    category: 'code',
  };

  validateArgs(args: Record<string, unknown>): string | null {
    if (!args.query || typeof args.query !== 'string') {
      return '缺少必需参数: query';
    }
    return null;
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = args.query as string;
    const filePattern = args.filePattern as string | undefined;
    const caseSensitive = (args.caseSensitive as boolean) ?? false;
    const maxResults = (args.maxResults as number) ?? 30;

    // 尝试使用 ripgrep
    const hasRipgrep = await this.checkRipgrep();
    if (hasRipgrep) {
      return this.searchWithRipgrep(context.workingDirectory, query, {
        filePattern,
        caseSensitive,
        maxResults,
      });
    }

    // 回退到纯 JS 搜索
    return this.searchWithJS(context.workingDirectory, query, {
      filePattern,
      caseSensitive,
      maxResults,
    });
  }

  /** 检查系统是否安装了 ripgrep */
  private async checkRipgrep(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('rg', ['--version'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  /** 使用 ripgrep 搜索 */
  private searchWithRipgrep(
    workDir: string,
    query: string,
    options: { filePattern?: string; caseSensitive: boolean; maxResults: number },
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      const rgArgs = [
        '--json',                  // JSON 输出便于解析
        '--max-count', '3',        // 每个文件最多 3 个匹配
        '-m', String(options.maxResults),
      ];

      if (!options.caseSensitive) rgArgs.push('-i');
      if (options.filePattern) rgArgs.push('-g', options.filePattern);

      rgArgs.push(query, workDir);

      const child = spawn('rg', rgArgs, {
        cwd: workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 15000,
      });

      let stdout = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.on('error', () => {
        // ripgrep 不可用，回退到 JS
        this.searchWithJS(workDir, query, options).then(resolve);
      });

      child.on('close', (code) => {
        if (code === 1) {
          // ripgrep exit code 1 = 无匹配
          resolve({
            success: true,
            output: '未找到匹配结果',
            durationMs: 0,
            metadata: { engine: 'ripgrep', resultCount: 0 },
          });
          return;
        }

        if (code !== 0 && code !== 1) {
          resolve({
            success: false,
            output: '',
            error: `ripgrep 退出码: ${code}`,
            durationMs: 0,
          });
          return;
        }

        // 解析 ripgrep JSON 输出
        const results = this.parseRipgrepOutput(stdout, options.maxResults);
        resolve({
          success: true,
          output: results.length > 0
            ? `找到 ${results.length} 个匹配:\n\n${results.join('\n')}`
            : '未找到匹配结果',
          durationMs: 0,
          metadata: { engine: 'ripgrep', resultCount: results.length },
        });
      });
    });
  }

  /** 解析 ripgrep JSON 输出 */
  private parseRipgrepOutput(stdout: string, maxResults: number): string[] {
    const results: string[] = [];
    const lines = stdout.split('\n').filter(Boolean);

    for (const line of lines) {
      if (results.length >= maxResults) break;

      try {
        const obj = JSON.parse(line);
        if (obj.type === 'match') {
          const path = obj.data.path.text;
          const lineNum = obj.data.line_number;
          const text = obj.data.lines.text.trim();
          results.push(`${path}:${lineNum}: ${text.slice(0, 120)}`);
        }
      } catch {
        // 非 JSON 行，跳过
      }
    }

    return results;
  }

  /** 纯 JS 回退搜索 */
  private async searchWithJS(
    workDir: string,
    query: string,
    options: { filePattern?: string; caseSensitive: boolean; maxResults: number },
  ): Promise<ToolResult> {
    try {
      const results: string[] = [];
      const searchQuery = options.caseSensitive ? query : query.toLowerCase();
      const files = await this.walkDir(workDir, options.maxResults * 10);

      for (const filePath of files) {
        if (results.length >= options.maxResults) break;

        const relativePath = path.relative(workDir, filePath);
        const fileName = path.basename(filePath);

        // 文件名过滤
        if (options.filePattern && !this.matchGlob(fileName, options.filePattern)) continue;

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= options.maxResults) break;

            const lineText = options.caseSensitive ? lines[i] : lines[i].toLowerCase();
            if (lineText.includes(searchQuery)) {
              results.push(`${relativePath}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
              if (results.length % 3 === 0) break; // 每个文件最多 3 个匹配
            }
          }
        } catch {
          // 二进制或权限不足，跳过
        }
      }

      return {
        success: true,
        output: results.length > 0
          ? `找到 ${results.length} 个匹配:\n\n${results.join('\n')}`
          : '未找到匹配结果',
        durationMs: 0,
        metadata: { engine: 'js-fallback', resultCount: results.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `代码搜索失败: ${msg}`,
        durationMs: 0,
      };
    }
  }

  /** 递归遍历目录 */
  private async walkDir(dir: string, maxFiles: number): Promise<string[]> {
    const files: string[] = [];
    const ignored = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '__pycache__']);

    async function walk(currentDir: string): Promise<void> {
      if (files.length >= maxFiles) return;
      let entries;
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch { return; }

      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          if (ignored.has(entry.name)) continue;
          await walk(path.join(currentDir, entry.name));
        } else if (entry.isFile()) {
          files.push(path.join(currentDir, entry.name));
        }
      }
    }

    await walk(dir);
    return files;
  }

  /** 简单 glob 匹配 */
  private matchGlob(fileName: string, pattern: string): boolean {
    const regex = new RegExp(
      '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    return regex.test(fileName);
  }
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/tools/builtin/web-search.ts src/tools/builtin/code-search.ts
git commit -m "feat(tools): implement web_search and code_search tools"
```

---

### Task 6：CLI 集成（注册全部工具 + 启用安全层）

**文件：** 修改 `src/cli/App.tsx`

将 Phase 7 新增的四个工具注册到 ToolRegistry，接入 PermissionChecker，启用完整的命令检查和安全层。

- [ ] **Step 1：新增 import 和工具注册**

在 App.tsx 的工具初始化部分（Phase 6 已有的注册代码后面），添加：

```typescript
// 新增 import
import { ShellExecTool } from '../tools/builtin/shell-exec.js';
import { GitOpTool } from '../tools/builtin/git-op.js';
import { WebSearchTool } from '../tools/builtin/web-search.js';
import { CodeSearchTool } from '../tools/builtin/code-search.js';
import { PermissionChecker } from '../tools/permission.js';

// 在 registry 初始化后，追加注册四个进阶工具：
registry.register(new ShellExecTool());
registry.register(new GitOpTool());
registry.register(new WebSearchTool());
registry.register(new CodeSearchTool());

// 初始化权限检查器（MVP 模式：confirm 自动放行）
const permissionChecker = new PermissionChecker(true);

// 注册权限规则（deny > confirm > auto，最严格规则永远胜出）
permissionChecker.addRule({ toolPattern: 'file_read', level: 'auto', description: '文件读取' });
permissionChecker.addRule({ toolPattern: 'file_search', level: 'auto', description: '文件搜索' });
permissionChecker.addRule({ toolPattern: 'code_search', level: 'auto', description: '代码搜索' });
permissionChecker.addRule({ toolPattern: 'web_search', level: 'auto', description: '网络搜索' });
permissionChecker.addRule({ toolPattern: 'file_write', level: 'confirm', description: '文件写入需确认' });
permissionChecker.addRule({ toolPattern: 'shell_exec', level: 'confirm', description: '命令执行需确认' });
permissionChecker.addRule({ toolPattern: 'git_op', level: 'confirm', description: 'Git 写操作需确认' });

// 将权限检查器接入 ToolExecutor
toolExecutor.setPermissionChecker(permissionChecker);
```

- [ ] **Step 2：构建验证 → 测试 → 提交**

```powershell
pnpm build
pnpm typecheck
pnpm test
git add src/cli/App.tsx
git commit -m "feat(cli): register all 7 built-in tools and enable permission checker"
```

---

### Task 7：单元测试

**文件：**
- 创建 `tests/tools/permission.test.ts`
- 创建 `tests/tools/shell-exec.test.ts`
- 创建 `tests/tools/git-op.test.ts`
- 创建 `tests/tools/web-search.test.ts`
- 创建 `tests/tools/code-search.test.ts`

- [ ] **Step 1：PermissionChecker 测试**

测试点：
- auto 规则 → granted: true
- deny 规则 → granted: false
- confirm 规则 + autoApproveConfirm=true → granted: true
- confirm 规则 + autoApproveConfirm=false → granted: false
- 通配符规则匹配（`file_*` 匹配 `file_read`）
- addRule 覆盖旧规则
- removeRule 删除规则
- 无匹配规则 → 默认 auto

- [ ] **Step 2：shell_exec 测试**

测试点：
- 执行简单命令 `echo hello` → success: true, output 包含 "hello"
- 执行不存在命令 → success: false
- 超时测试（短超时 + 长命令）→ success: false, error 包含 "超时"
- 输出截断（大量输出）→ output 包含 "[输出截断]"
- validateArgs 空命令 → 返回错误字符串

- [ ] **Step 3：git_op 测试**

测试点（使用临时 git 仓库）：
- `status` → success: true, output 包含 "分支"
- `log` → success: true（空仓库可能失败，注意处理）
- `add` + `commit` → success: true
- validateArgs 缺少 operation → 返回错误字符串
- validateArgs commit 缺少 message → 返回错误字符串
- 不支持的操作 → 返回错误字符串

- [ ] **Step 4：code_search 测试**

测试点（使用临时目录 + 测试文件）：
- 搜索存在的内容 → success: true, 结果包含匹配行
- 搜索不存在的内容 → success: true, output 包含 "未找到"
- filePattern 过滤 → 只返回匹配文件的结果
- caseSensitive=false → 大小写不敏感匹配
- validateArgs 缺少 query → 返回错误字符串

- [ ] **Step 5：web_search 测试（mock fetch）**

测试点（mock global fetch）：
- 正常搜索 → success: true, 结果列表非空
- fetch 失败 → success: false, error 包含错误信息
- validateArgs 缺少 query → 返回错误字符串
- maxResults 限制 → 结果数不超过限制

- [ ] **Step 6：SecurityChecker 增强测试**

在 Phase 6 的 `tests/tools/security.test.ts` 中追加测试：

- checkCommand 黑名单命令 `rm -rf /` → allowed: false
- checkCommand 普通命令 `ls` → allowed: true
- checkCommand 白名单模式 + 不在白名单 → requiresConfirmation: true
- checkNetworkRequest 普通 URL + networkConfirm=false → allowed: true
- checkNetworkRequest + networkConfirm=true → requiresConfirmation: true
- checkNetworkRequest 无效 URL → allowed: false

- [ ] **Step 7：运行全部测试 → 提交**

```powershell
pnpm test
git add tests/
git commit -m "test(tools): add unit tests for Phase 7 tools and security enhancements"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 145 个用例，Phase 6 的 ~110 + Phase 7 新增 ~35）
4. SecurityChecker.checkCommand() 正确拦截黑名单命令
5. SecurityChecker.checkNetworkRequest() 正确处理域名检查
6. PermissionChecker 正确执行 auto/confirm/deny 权限规则
7. shell_exec 能在子进程中执行命令，支持超时
8. git_op 支持 status/log/diff/add/commit/push 等全部操作
9. web_search 能执行网络搜索并返回结果
10. code_search 能搜索代码内容（优先 ripgrep，回退 JS）
11. 七个内置工具全部注册到 ToolRegistry
12. CLI 中 PermissionChecker 和 SecurityChecker 全部启用

## 注意事项

- **shell_exec 子进程**：使用 `child_process.spawn`，设置 `windowsHide: true`（Windows 上不弹出额外终端窗口），`stdio: ['ignore', 'pipe', 'pipe']`（不连接 stdin）
- **shell_exec 超时**：双重保险——spawn 的 `timeout` 选项 + 手动 `setTimeout`（确保跨平台一致）
- **git_op 路径**：`simple-git` 的工作目录通过 `simpleGit(workingDirectory)` 设置，不需要手动 `process.chdir()`
- **web_search 稳定性**：DuckDuckGo HTML 搜索可能因页面结构变化而失效。如果解析失败，工具仍然返回 success: true + "未找到结果"，不抛异常
- **code_search ripgrep**：检查 ripgrep 是否可用是异步的（`rg --version`），每次调用都检查一次（开销很小）。也可以改为构造函数时检测一次并缓存结果
- **输出截断**：shell_exec 限制 stdout 100KB / stderr 50KB，防止大输出导致内存问题
- **PermissionChecker MVP**：`autoApproveConfirm: true` 意味着所有 confirm 级别的工具自动放行。Phase 9（自主模式）改为 false 并实现交互式确认
- **ToolExecutor 执行流程**：权限检查 → 安全检查 → 执行工具。权限检查在安全检查之前（deny > confirm > auto，最严格规则永远胜出）
- **git_op requiresApproval**：ToolDefinition 中设为 `true`（写操作需确认），但实际权限由 PermissionChecker 的规则决定。读操作走 auto 规则，写操作走 confirm 规则

---

*Phase 7 | 蓝图 V1.0 | 预估新增文件：~7 个 | 预估修改文件：~2 个（security.ts、App.tsx）*
