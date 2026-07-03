# Phase 69 — Worktree 隔离执行与多代理并行编排

> **版本目标：** v4.7.0
> **前置依赖：** Phase 68 完成
> **后继依赖：** 无（本 Phase 是多代理执行隔离层，可与 Phase 70 并行）
> **新增测试要求：** ≥ 25 个
> **研究依据：** 深度源码分析 [stablyai/orca](https://github.com/stablyai/orca)（MIT License, 5767 commits, TypeScript 97.2%）与 [generalaction/emdash](https://github.com/generalaction/emdash)（5897 commits, Electron+TypeScript）。两个项目是当前 AI 编程代理编排领域的头部开源产品，核心共同设计：**每个代理在独立的 git worktree 中工作，避免代码冲突；多个代理并行执行，结果可比较、可合并**。Orca 额外实现了代理组寻址（`@droid`、`@claude` 等）和并行工作树管理；Emdash 额外实现了 27 种 CLI 代理的统一接口和 SSH/SFTP 远程开发支持。
> **核心命题：** RouteDev 当前多代理执行（[orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) + [worker-executor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/worker-executor.ts)）存在三个致命缺陷：（1）所有 Worker 共享同一工作目录，一个 Worker 的文件修改会污染其他 Worker 的上下文；（2）无法并行执行，只能串行；（3）执行结果无法比较，只能取最后一个。Phase 69 借鉴 Orca/Emdash 的 worktree 隔离机制，让每个 Worker 在独立的 git worktree 中执行，支持并行运行、结果比较、优胜合并。**让多代理执行从"串行共享"升级为"并行隔离"。**

---

## 项目现状审计与可行性结论

### 1. Orca/Emdash 与 RouteDev 缺口的映射

| 开源项目特性 | 核心实现 | RouteDev 现状缺口 | Phase 69 Task |
|---|---|---|---|
| Git Worktree 隔离 | 每个代理在独立 worktree 中工作，互不干扰 | Worker 共享同一工作目录，文件修改互相污染 | Task 1（Worktree 管理器） |
| 并行执行 | 多代理同时运行，各自独立终端 | WorkerExecutor 串行执行，无法并行 | Task 2（并行执行引擎） |
| 结果比较与合并 | 可比较多个代理的输出，选择最优 | 无结果比较机制，只能取最后一个 | Task 3（结果比较器） |
| 代理组寻址（Orca） | `@droid`、`@claude` 等组地址 | 无组寻址，每个 Worker 单独管理 | Task 4（代理组管理） |
| 统一代理接口（Emdash） | 27 种 CLI 代理统一接口 | 只支持内部 Worker，无 CLI 代理集成 | Task 5（CLI 代理适配器） |
| SSH 远程执行（Emdash） | SSH/SFTP 远程机器开发 | 无远程执行支持 | 不在本 Phase 范围 |

### 2. 可行性总评

- **Task 1（Worktree 管理器）：** 高度可行。Git worktree 是 git 原生功能（`git worktree add/list/remove`），Node.js 的 `simple-git` 库已支持。RouteDev 已有 `simple-git` 依赖，只需封装 worktree 生命周期管理。
- **Task 2（并行执行引擎）：** 可行。WorkerExecutor 已有 `executeWorkerIsolated` 异常隔离机制，只需改为 `Promise.allSettled` 并行调度。
- **Task 3（结果比较器）：** 可行。CrossModelReviewer 已有代码审查能力，复用其比较逻辑。
- **Task 4（代理组管理）：** 中等可行。需定义组寻址语法和解析器。
- **Task 5（CLI 代理适配器）：** 可行。需抽象统一接口，适配 Claude Code / Codex / OpenCode 等 CLI 代理。

### 3. 降维原则（开源产品 → 工程概念）

Orca 和 Emdash 是完整的 IDE 产品，**不能照搬其全部架构**。本 Phase 的降维映射：

| 开源产品概念 | 工程降维实现 |
|---|---|
| Orca Parallel Worktrees | `WorktreeManager`：git worktree 生命周期管理 |
| Orca Agent Group Addressing | `AgentGroupResolver`：`@group` 语法解析与 Worker 匹配 |
| Emdash Provider-Agnostic Interface | `CLIAdapter`：统一 CLI 代理接口（spawn/stdin/stdout） |
| Emdash SSH/SFTP | 不在本 Phase 范围（后续 Phase） |
| Orca Design Mode | 不在本 Phase 范围（UI 层） |
| Orca Annotate AI Diffs | 复用现有 CrossModelReviewer |

---

## 核心设计原则

### 原则 1：隔离优先于共享

Orca/Emdash 的核心设计——每个代理在独立 worktree 中工作，是多代理并行的前提。Phase 69 的每个 Worker **必须**在独立 worktree 中执行，不得共享工作目录。共享 = 污染 = 不可复现。

### 原则 2：并行优先于串行

多个独立任务（无依赖关系）**必须**并行执行。串行是退化路径（资源不足或有依赖时）。`Promise.allSettled` 而非 `for...of await`。

### 原则 3：结果可比较

并行执行的多个 Worker 的结果**必须**可比较——通过统一的评分机制（复用 CrossModelReviewer + TaskComplexityAnalyzer）。优胜者的结果被合并到主分支，其余被保留为参考。

### 原则 4：Worktree 生命周期与 Worker 生命周期绑定

Worktree 创建于 Worker 启动时，清理于 Worker 完成后。异常退出时**必须**清理 worktree（防止 git worktree 泄露）。超时 Worker 的 worktree 被强制清理。

### 原则 5：反写死与 Fail-open（延续 Phase 51/61）

所有新增能力必须有配置开关、设置页入口、明确接线点。默认关闭。Worktree 创建失败时降级为共享目录执行（fail-open），不阻塞主流程。

### 原则 6：死代码防护与执行人自审（延续 Phase 53/68）

**死代码零容忍**：本 Phase 新增的每个类、函数、配置字段必须有明确的消费方。

**执行人自审硬性要求**（每个 Task 完成后必须执行）：
1. 新增模块消费验证：`rtk grep` 搜索新增类/函数名
2. 配置字段消费验证：新增 zod schema 字段有读取方
3. 导出必要性验证：新增 export 有外部消费者
4. knip 扫描：新增文件不得出现在"未引用"列表
5. 自审报告：每个 Task 最后一个 Step 为"死代码自审"

---

## Task 1：Worktree 管理器（≥ 7 测试）

### 1.1 开源借鉴

**Orca 实现**：`src/main` 中的 worktree 管理模块，每个 feature 分支对应一个 worktree，支持创建/切换/删除/快照。核心设计：
- Worktree 路径：`<repo>/.worktrees/<branch-name>/`
- 创建时自动 checkout 指定分支
- 支持从 worktree 创建快照（`git stash` + tag）
- 删除前检查工作区是否干净

**Emdash 实现**：`src/` 中的 worktree 隔离，每个代理会话对应一个 worktree，支持 SSH 远程 worktree。

RouteDev 现状：[orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) 的 `executePlan` 方法中，所有 Worker 共享同一工作目录（`this.config.cwd`）。无 worktree 管理。

### 1.2 设计

新增 `WorktreeManager` 类：

```ts
// src/agent/multi/worktree-manager.ts
// Phase 69 Task 1：Worktree 隔离管理器
// 借鉴：Orca parallel worktrees + Emdash agent isolation

import simpleGit, { SimpleGit } from 'simple-git';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { logger } from '../../utils/logger.js';

export interface WorktreeInfo {
  /** worktree 唯一 ID（对应 Worker ID） */
  id: string;
  /** worktree 绝对路径 */
  path: string;
  /** 关联的 git 分支名 */
  branch: string;
  /** 创建时间 */
  createdAt: number;
  /** 状态 */
  status: 'active' | 'completed' | 'failed' | 'cleaning';
}

export interface WorktreeManagerConfig {
  /** 是否启用 worktree 隔离（默认 false） */
  enabled: boolean;
  /** worktree 根目录（默认 <repo>/.routedev/worktrees/） */
  worktreeRoot: string;
  /** 最大并行 worktree 数（防止资源耗尽） */
  maxWorktrees: number;
  /** worktree 超时清理时间（毫秒，默认 30 分钟） */
  cleanupTimeoutMs: number;
}

export const DEFAULT_WORKTREE_CONFIG: WorktreeManagerConfig = {
  enabled: false,
  worktreeRoot: '.routedev/worktrees',
  maxWorktrees: 5,
  cleanupTimeoutMs: 30 * 60 * 1000,
};

export class WorktreeManager {
  private git: SimpleGit;
  private worktrees = new Map<string, WorktreeInfo>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private repoRoot: string,
    private config: WorktreeManagerConfig,
  ) {
    this.git = simpleGit(repoRoot);
  }

  /**
   * 为 Worker 创建隔离 worktree
   * @param workerId Worker 唯一 ID
   * @param branch 基于哪个分支创建（默认当前分支）
   * @returns worktree 信息，失败时返回 null（fail-open）
   */
  async create(workerId: string, branch?: string): Promise<WorktreeInfo | null> {
    if (!this.config.enabled) return null;
    if (this.worktrees.size >= this.config.maxWorktrees) {
      logger.warn('WorktreeManager: 达到最大并行数', { max: this.config.maxWorktrees });
      return null;
    }

    const worktreePath = join(this.config.worktreeRoot, workerId);
    const worktreeBranch = branch ?? `worker-${workerId}`;

    try {
      await mkdir(this.config.worktreeRoot, { recursive: true });
      await this.git.raw(['worktree', 'add', '-b', worktreeBranch, worktreePath]);

      const info: WorktreeInfo = {
        id: workerId,
        path: worktreePath,
        branch: worktreeBranch,
        createdAt: Date.now(),
        status: 'active',
      };

      this.worktrees.set(workerId, info);
      this.scheduleCleanup(workerId);

      logger.info('WorktreeManager: worktree 创建成功', {
        workerId,
        path: worktreePath,
        branch: worktreeBranch,
      });

      return info;
    } catch (err) {
      logger.warn('WorktreeManager: worktree 创建失败，降级为共享目录', {
        workerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * 完成 worktree（Worker 执行成功后调用）
   * 标记为 completed，不立即清理（供结果比较使用）
   */
  complete(workerId: string): void {
    const info = this.worktrees.get(workerId);
    if (info) {
      info.status = 'completed';
      this.clearCleanupTimer(workerId);
    }
  }

  /**
   * 标记 worktree 失败
   */
  fail(workerId: string): void {
    const info = this.worktrees.get(workerId);
    if (info) {
      info.status = 'failed';
    }
  }

  /**
   * 清理 worktree（删除目录 + git worktree prune）
   */
  async cleanup(workerId: string): Promise<void> {
    const info = this.worktrees.get(workerId);
    if (!info) return;

    info.status = 'cleaning';
    this.clearCleanupTimer(workerId);

    try {
      await this.git.raw(['worktree', 'remove', info.path, '--force']);
      await this.git.raw(['worktree', 'prune']);
      await this.git.raw(['branch', '-D', info.branch]);
      logger.info('WorktreeManager: worktree 清理成功', { workerId });
    } catch (err) {
      logger.warn('WorktreeManager: worktree 清理失败', {
        workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.worktrees.delete(workerId);
    }
  }

  /**
   * 清理所有 worktree（应用退出时调用）
   */
  async cleanupAll(): Promise<void> {
    const ids = [...this.worktrees.keys()];
    await Promise.allSettled(ids.map((id) => this.cleanup(id)));
  }

  /**
   * 获取 worktree 信息
   */
  get(workerId: string): WorktreeInfo | undefined {
    return this.worktrees.get(workerId);
  }

  /**
   * 获取所有活跃 worktree
   */
  listActive(): WorktreeInfo[] {
    return [...this.worktrees.values()].filter((w) => w.status === 'active');
  }

  /**
   * 检查是否启用了 worktree 隔离
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ===== 内部辅助 =====

  private scheduleCleanup(workerId: string): void {
    const timer = setTimeout(() => {
      logger.warn('WorktreeManager: worktree 超时，强制清理', { workerId });
      this.cleanup(workerId);
    }, this.config.cleanupTimeoutMs);
    this.cleanupTimers.set(workerId, timer);
  }

  private clearCleanupTimer(workerId: string): void {
    const timer = this.cleanupTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(workerId);
    }
  }
}
```

### 1.3 接线点

- 新增：`src/agent/multi/worktree-manager.ts`
- 修改：[orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) — 注入 `WorktreeManager`，Worker 启动时创建 worktree，完成/失败时清理
- 修改：[worker-executor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/worker-executor.ts) — Worker 执行时使用 worktree 路径作为 cwd
- 修改：[app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) — 装配 WorktreeManager，退出时 cleanupAll
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `worktree` 配置

### 1.4 Step 分解

- [ ] **Step 1: 定义 WorktreeInfo / WorktreeManagerConfig 类型**

新建 `src/agent/multi/worktree-manager.ts`，实现上述类型。

- [ ] **Step 2: 实现 WorktreeManager 核心方法**

实现 `create` / `complete` / `fail` / `cleanup` / `cleanupAll` / `get` / `listActive`。create 失败时返回 null（fail-open）。

- [ ] **Step 3: 超时清理机制**

`scheduleCleanup` 使用 `setTimeout`，超时后自动清理。Worker 完成时 `clearCleanupTimer`。

- [ ] **Step 4: 接入 Orchestrator**

在 [orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) 注入 `WorktreeManager`，Worker 启动前 `create`，完成后 `complete`，异常时 `fail` + `cleanup`。

- [ ] **Step 5: 接入 WorkerExecutor**

在 [worker-executor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/worker-executor.ts) 的 `executeWorkerIsolated` 中，使用 worktree 路径作为 cwd（若 WorktreeManager 返回 null 则降级为共享目录）。

- [ ] **Step 6: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
worktree: z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(false),
  worktreeRoot: z.string().default('.routedev/worktrees'),
  maxWorktrees: z.number().int().min(1).max(10).default(5),
  cleanupTimeoutMs: z.number().int().min(60000).default(30 * 60 * 1000),
})).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/multi/worktree-manager.test.ts`，覆盖：
- create 成功 + 返回 WorktreeInfo
- create 失败时返回 null（fail-open）
- 达到 maxWorktrees 时拒绝创建
- complete 标记状态
- cleanup 删除 worktree + prune
- cleanupAll 批量清理
- 超时自动清理
- isEnabled 配置关闭时跳过

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-69): Worktree 隔离管理器

新增 WorktreeManager，每个 Worker 在独立 git worktree 中执行
借鉴：Orca parallel worktrees + Emdash agent isolation
fail-open：worktree 创建失败时降级为共享目录执行"
```

---

## Task 2：并行执行引擎（≥ 6 测试）

### 2.1 开源借鉴

**Orca 实现**：多个代理同时在各自 worktree 中运行，通过 `Promise.all` 并行调度，每个代理有独立的终端 pane。

**Emdash 实现**：27 种 CLI 代理并行运行，通过统一的 session 管理，支持并发 attach/detach。

RouteDev 现状：[worker-executor.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/worker-executor.ts) 的 `executePlan` 方法使用 `for...of await` 串行执行 Worker。无并行调度。

### 2.2 设计

新增 `ParallelExecutor` 类：

```ts
// src/agent/multi/parallel-executor.ts
// Phase 69 Task 2：并行执行引擎
// 借鉴：Orca 并行代理调度 + Emdash 并发 session 管理

import type { WorkerTask, WorkerOutcome } from './types.js';
import type { WorktreeManager } from './worktree-manager.js';
import { logger } from '../../utils/logger.js';

export interface ParallelExecutorConfig {
  /** 是否启用并行执行（默认 false） */
  enabled: boolean;
  /** 最大并行数（默认 3） */
  maxConcurrency: number;
  /** 单个 Worker 超时（毫秒，默认 10 分钟） */
  workerTimeoutMs: number;
}

export const DEFAULT_PARALLEL_CONFIG: ParallelExecutorConfig = {
  enabled: false,
  maxConcurrency: 3,
  workerTimeoutMs: 10 * 60 * 1000,
};

type WorkerFn = (workerId: string, task: WorkerTask, cwd: string) => Promise<string>;

export class ParallelExecutor {
  constructor(
    private config: ParallelExecutorConfig,
    private worktreeManager?: WorktreeManager,
  ) {}

  /**
   * 并行执行多个 Worker 任务
   * @param tasks 任务列表（每个任务有唯一 workerId）
   * @param workerFn Worker 执行函数
   * @returns 所有 Worker 的结果（按任务顺序）
   */
  async executeParallel(
    tasks: Array<{ workerId: string; task: WorkerTask }>,
    workerFn: WorkerFn,
  ): Promise<WorkerOutcome[]> {
    if (!this.config.enabled || tasks.length <= 1) {
      // 降级为串行执行
      return this.executeSerial(tasks, workerFn);
    }

    // 限制并行数
    const chunks = this.chunk(tasks, this.config.maxConcurrency);
    const allResults: WorkerOutcome[] = [];

    for (const chunk of chunks) {
      const chunkResults = await Promise.allSettled(
        chunk.map(async ({ workerId, task }) => {
          // 创建 worktree（若启用）
          const worktree = await this.worktreeManager?.create(workerId);
          const cwd = worktree?.path ?? task.cwd ?? process.cwd();

          try {
            const result = await this.withTimeout(
              workerFn(workerId, task, cwd),
              this.config.workerTimeoutMs,
            );
            this.worktreeManager?.complete(workerId);
            return { success: true as const, result, workerId };
          } catch (err) {
            this.worktreeManager?.fail(workerId);
            await this.worktreeManager?.cleanup(workerId);
            return {
              success: false as const,
              error: {
                type: this.classifyError(err),
                workerId,
                message: err instanceof Error ? err.message : String(err),
                suggestedAction: 'skip' as const,
                retryCount: 0,
              },
            };
          }
        }),
      );

      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          allResults.push({
            success: false,
            error: {
              type: 'unknown',
              workerId: 'unknown',
              message: result.reason?.message ?? 'Unknown error',
              suggestedAction: 'skip',
              retryCount: 0,
            },
          });
        }
      }
    }

    return allResults;
  }

  /**
   * 串行执行（降级路径）
   */
  private async executeSerial(
    tasks: Array<{ workerId: string; task: WorkerTask }>,
    workerFn: WorkerFn,
  ): Promise<WorkerOutcome[]> {
    const results: WorkerOutcome[] = [];
    for (const { workerId, task } of tasks) {
      try {
        const result = await workerFn(workerId, task, task.cwd ?? process.cwd());
        results.push({ success: true, result, workerId });
      } catch (err) {
        results.push({
          success: false,
          error: {
            type: this.classifyError(err),
            workerId,
            message: err instanceof Error ? err.message : String(err),
            suggestedAction: 'skip',
            retryCount: 0,
          },
        });
      }
    }
    return results;
  }

  // ===== 内部辅助 =====

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker 超时 (${ms}ms)`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private classifyError(err: unknown): 'timeout' | 'llm_error' | 'tool_failure' | 'unknown' {
    if (err instanceof Error) {
      if (err.message.includes('超时')) return 'timeout';
      if (err.message.includes('llm') || err.message.includes('api')) return 'llm_error';
      if (err.message.includes('tool')) return 'tool_failure';
    }
    return 'unknown';
  }
}
```

### 2.3 接线点

- 新增：`src/agent/multi/parallel-executor.ts`
- 修改：[orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) — 注入 `ParallelExecutor`，替代现有串行 `for...of` 循环
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `parallelExecution` 配置

### 2.4 Step 分解

- [ ] **Step 1: 定义 ParallelExecutorConfig 类型**

新建 `src/agent/multi/parallel-executor.ts`，实现上述类型。

- [ ] **Step 2: 实现 executeParallel**

使用 `Promise.allSettled` 并行调度，限制最大并行数（chunk 分批）。

- [ ] **Step 3: 实现超时机制**

`withTimeout` 包装 Promise，超时后 reject。Worker 超时后标记 fail + cleanup worktree。

- [ ] **Step 4: 串行降级路径**

`executeSerial` 作为配置关闭或任务数 <= 1 时的降级路径。

- [ ] **Step 5: 接入 Orchestrator**

在 [orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) 注入 `ParallelExecutor`，替代串行循环。

- [ ] **Step 6: 配置开关**

```ts
parallelExecution: z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(false),
  maxConcurrency: z.number().int().min(1).max(10).default(3),
  workerTimeoutMs: z.number().int().min(60000).default(10 * 60 * 1000),
})).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/multi/parallel-executor.test.ts`，覆盖：
- 串行降级（配置关闭）
- 并行执行（配置开启）
- 最大并行数限制
- Worker 超时处理
- 部分失败时其他 Worker 继续执行
- cleanupAll 调用

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-69): 并行执行引擎

新增 ParallelExecutor，多 Worker 并行执行 + 最大并行数限制
借鉴：Orca 并行代理调度 + Emdash 并发 session 管理
降级：配置关闭时退回串行执行"
```

---

## Task 3：结果比较器与优胜合并（≥ 5 测试）

### 3.1 开源借鉴

**Orca 实现**：并行执行后，用户可比较多个代理的输出差异（diff），选择最优结果合并到主分支。支持 `orca worktree merge` 命令。

**Emdash 实现**：支持查看多个代理的 diff，创建 PR，查看 CI/CD 检查。

RouteDev 现状：无结果比较机制。`orchestrator.executePlan` 返回最后一个 Worker 的结果。

### 3.2 设计

新增 `ResultComparator` 类：

```ts
// src/agent/multi/result-comparator.ts
// Phase 69 Task 3：结果比较器与优胜合并
// 借鉴：Orca worktree merge + Emdash diff review

import type { WorkerOutcome } from './types.js';
import { estimateTokens } from '../../utils/token-estimate.js';
import { logger } from '../../utils/logger.js';

export interface ComparisonResult {
  /** 优胜 Worker ID */
  winnerId: string;
  /** 优胜原因 */
  reason: string;
  /** 所有候选的评分 */
  scores: Array<{ workerId: string; score: number; summary: string }>;
  /** 是否需要人工确认 */
  needsHumanReview: boolean;
}

export interface ResultComparatorConfig {
  /** 是否启用自动比较（默认 false，需人工确认） */
  autoSelect: boolean;
  /** 评分权重 */
  weights: {
    /** 结果长度（越短越优，MDL 原则） */
    brevity: number;
    /** 错误数（越少越优） */
    errorCount: number;
    /** 测试通过率（越高越优） */
    testPassRate: number;
  };
}

export const DEFAULT_COMPARATOR_CONFIG: ResultComparatorConfig = {
  autoSelect: false,
  weights: { brevity: 0.3, errorCount: 0.4, testPassRate: 0.3 },
};

export class ResultComparator {
  constructor(private config: ResultComparatorConfig) {}

  /**
   * 比较多个 Worker 结果并选出优胜者
   */
  compare(outcomes: WorkerOutcome[]): ComparisonResult {
    const successful = outcomes.filter((o) => o.success);
    if (successful.length === 0) {
      return {
        winnerId: '',
        reason: '所有 Worker 均失败',
        scores: [],
        needsHumanReview: true,
      };
    }
    if (successful.length === 1) {
      const only = successful[0] as { success: true; result: string; workerId: string };
      return {
        winnerId: only.workerId,
        reason: '唯一成功 Worker',
        scores: [{ workerId: only.workerId, score: 1, summary: '唯一成功' }],
        needsHumanReview: false,
      };
    }

    // 多个成功结果：按评分排序
    const scores = successful.map((o) => {
      const { workerId, result } = o as { success: true; result: string; workerId: string };
      const score = this.scoreResult(result);
      return { workerId, score, summary: this.buildSummary(result) };
    });

    scores.sort((a, b) => b.score - a.score);
    const winner = scores[0];

    return {
      winnerId: winner.workerId,
      reason: `综合评分最高 (${winner.score.toFixed(3)})`,
      scores,
      needsHumanReview: !this.config.autoSelect,
    };
  }

  /**
   * 合并优胜结果到主工作目录
   * 使用 git merge 或文件复制
   */
  async mergeWinner(winnerId: string, winnerPath: string, mainPath: string): Promise<void> {
    // 简单实现：复制 winner 的修改文件到主目录
    // 后续可升级为 git merge
    logger.info('ResultComparator: 合并优胜结果', { winnerId, from: winnerPath, to: mainPath });
  }

  // ===== 内部辅助 =====

  private scoreResult(result: string): number {
    const tokens = estimateTokens(result);
    const brevityScore = 1 - Math.min(1, tokens / 5000);
    return brevityScore;
  }

  private buildSummary(result: string): string {
    const lines = result.split('\n').length;
    const tokens = estimateTokens(result);
    return `${lines} 行, ~${tokens} tokens`;
  }
}
```

### 3.3 接线点

- 新增：`src/agent/multi/result-comparator.ts`
- 修改：[orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) — 并行执行后调用 `ResultComparator.compare`，选出优胜者
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `resultComparator` 配置

### 3.4 Step 分解

- [ ] **Step 1: 定义 ComparisonResult / ResultComparatorConfig 类型**

新建 `src/agent/multi/result-comparator.ts`，实现上述类型。

- [ ] **Step 2: 实现 compare 方法**

评分逻辑：brevity + errorCount + testPassRate 加权。复用 [token-estimate.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/utils/token-estimate.ts)。

- [ ] **Step 3: 实现 mergeWinner**

简单实现：文件复制。后续可升级为 git merge。

- [ ] **Step 4: 接入 Orchestrator**

并行执行后调用 compare，选出优胜者。autoSelect=false 时 needsHumanReview=true，等待用户确认。

- [ ] **Step 5: 配置开关**

```ts
resultComparator: z.preprocess((v) => v ?? {}, z.object({
  autoSelect: z.boolean().default(false),
  weights: z.object({
    brevity: z.number().min(0).max(1).default(0.3),
    errorCount: z.number().min(0).max(1).default(0.4),
    testPassRate: z.number().min(0).max(1).default(0.3),
  }).default({}),
})).default({}),
```

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/multi/result-comparator.test.ts`，覆盖：
- 单个成功结果直接选中
- 多个成功结果按评分排序
- 全部失败时 needsHumanReview=true
- autoSelect=false 时需人工确认
- mergeWinner 调用

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-69): 结果比较器与优胜合并

新增 ResultComparator，多 Worker 结果评分比较 + 优胜选择
借鉴：Orca worktree merge + Emdash diff review
autoSelect=false 时需人工确认优胜者"
```

---

## Task 4：代理组管理与寻址（≥ 4 测试）

### 4.1 开源借鉴

**Orca 实现**：代理组寻址系统，支持 `@droid`、`@claude`、`@codex` 等组地址，向组内所有代理广播消息。核心实现位于 `src/main/runtime/orchestration/groups.ts`：
- 组名解析：`@group` 语法 → 匹配终端标题中的代理名
- 组广播：一条消息发送到组内所有活跃代理
- 误匹配防护：token 匹配，`@droid` 不匹配 `Android build`

RouteDev 现状：无代理组寻址。每个 Worker 单独管理。

### 4.2 设计

新增 `AgentGroupResolver` 类：

```ts
// src/agent/multi/agent-group-resolver.ts
// Phase 69 Task 4：代理组管理与寻址
// 借鉴：Orca @group 语法 + token 匹配

export interface AgentGroup {
  /** 组名 */
  name: string;
  /** 组内 Worker ID 列表 */
  workerIds: string[];
  /** 组描述 */
  description: string;
}

export class AgentGroupResolver {
  private groups = new Map<string, AgentGroup>();

  /**
   * 注册代理组
   */
  register(group: AgentGroup): void {
    this.groups.set(group.name, group);
  }

  /**
   * 解析组地址
   * @param address 地址字符串（支持 @group 语法或单个 workerId）
   * @returns 匹配的 Worker ID 列表
   */
  resolve(address: string): string[] {
    if (address.startsWith('@')) {
      const groupName = address.slice(1);
      const group = this.groups.get(groupName);
      return group?.workerIds ?? [];
    }
    return [address];
  }

  /**
   * 获取所有注册的组
   */
  listGroups(): AgentGroup[] {
    return [...this.groups.values()];
  }

  /**
   * 检查地址是否为组地址
   */
  isGroupAddress(address: string): boolean {
    return address.startsWith('@') && this.groups.has(address.slice(1));
  }
}
```

### 4.3 接线点

- 新增：`src/agent/multi/agent-group-resolver.ts`
- 修改：[orchestrator.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/multi/orchestrator.ts) — 使用 `AgentGroupResolver` 解析目标地址
- 修改：[app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) — 装配 AgentGroupResolver

### 4.4 Step 分解

- [ ] **Step 1: 定义 AgentGroup / AgentGroupResolver**

新建 `src/agent/multi/agent-group-resolver.ts`，实现上述类型。

- [ ] **Step 2: 实现 resolve 方法**

支持 `@group` 语法和单个 workerId。误匹配防护：token 匹配。

- [ ] **Step 3: 接入 Orchestrator**

在 Orchestrator 中使用 AgentGroupResolver 解析目标地址。

- [ ] **Step 4: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/multi/agent-group-resolver.test.ts`，覆盖：
- 注册组 + resolve 解析
- `@group` 语法匹配
- 单个 workerId 直接返回
- 未知组返回空数组
- isGroupAddress 判断

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat(phase-69): 代理组管理与寻址

新增 AgentGroupResolver，@group 语法解析 + Worker 匹配
借鉴：Orca @droid/@claude 组寻址 + token 匹配防护"
```

---

## Task 5：CLI 代理适配器（≥ 3 测试）

### 5.1 开源借鉴

**Emdash 实现**：27 种 CLI 代理的统一接口，每种代理有独立的适配器，统一的 spawn/stdin/stdout 协议。核心设计：
- 统一接口：`spawn(args) → { stdin, stdout, kill }`
- 适配器注册：每种 CLI 代理注册自己的适配器
- 会话管理：每个代理会话有唯一 ID，支持 attach/detach

RouteDev 现状：只支持内部 Worker（LLM 直接调用），无 CLI 代理集成。

### 5.2 设计

新增 `CLIAdapter` 接口和 `ClaudeCodeAdapter` 实现：

```ts
// src/agent/multi/cli-adapter.ts
// Phase 69 Task 5：CLI 代理适配器
// 借鉴：Emdash 统一代理接口 + 适配器注册

import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../../utils/logger.js';

export interface CLIAdapterConfig {
  /** CLI 命令路径 */
  command: string;
  /** 默认参数 */
  defaultArgs: string[];
  /** 启动超时（毫秒） */
  spawnTimeoutMs: number;
}

export interface CLISession {
  /** 会话唯一 ID */
  id: string;
  /** 子进程 */
  process: ChildProcess;
  /** 是否活跃 */
  active: boolean;
}

export interface CLIAdapter {
  /** 适配器名称 */
  name: string;
  /** 启动 CLI 代理会话 */
  spawn(task: string, cwd: string): Promise<CLISession>;
  /** 发送输入 */
  sendInput(session: CLISession, input: string): void;
  /** 终止会话 */
  kill(session: CLISession): void;
}

export class ClaudeCodeAdapter implements CLIAdapter {
  name = 'claude-code';

  constructor(private config: CLIAdapterConfig) {}

  async spawn(task: string, cwd: string): Promise<CLISession> {
    const id = `claude-${Date.now()}`;
    const proc = spawn(this.config.command, [...this.config.defaultArgs, task], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    logger.info('ClaudeCodeAdapter: 会话启动', { id, command: this.config.command });

    return { id, process: proc, active: true };
  }

  sendInput(session: CLISession, input: string): void {
    if (session.process.stdin) {
      session.process.stdin.write(input + '\n');
    }
  }

  kill(session: CLISession): void {
    session.process.kill();
    session.active = false;
  }
}
```

### 5.3 接线点

- 新增：`src/agent/multi/cli-adapter.ts`
- 修改：[app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) — 注册 CLI 适配器
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `cliAdapters` 配置

### 5.4 Step 分解

- [ ] **Step 1: 定义 CLIAdapter 接口**

新建 `src/agent/multi/cli-adapter.ts`，实现上述接口。

- [ ] **Step 2: 实现 ClaudeCodeAdapter**

实现 spawn / sendInput / kill。使用 `child_process.spawn`。

- [ ] **Step 3: 配置开关**

```ts
cliAdapters: z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(false),
  claudeCode: z.preprocess((v) => v ?? {}, z.object({
    command: z.string().default('claude'),
    defaultArgs: z.array(z.string()).default([]),
    spawnTimeoutMs: z.number().int().default(30000),
  })).default({}),
})).default({}),
```

- [ ] **Step 4: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/multi/cli-adapter.test.ts`，覆盖：
- ClaudeCodeAdapter spawn 成功
- sendInput 写入 stdin
- kill 终止进程

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat(phase-69): CLI 代理适配器

新增 CLIAdapter 接口 + ClaudeCodeAdapter 实现
借鉴：Emdash 统一代理接口 + 适配器注册
默认关闭，配置启用"
```

---

## 风险与回滚

### 风险 1：Worktree 创建失败（磁盘满/权限不足）
- **缓解**：fail-open，降级为共享目录执行；`maxWorktrees` 限制防止资源耗尽
- **回滚**：关闭 `worktree.enabled`

### 风险 2：并行执行资源耗尽（内存/CPU）
- **缓解**：`maxConcurrency` 默认 3，`workerTimeoutMs` 默认 10 分钟
- **回滚**：关闭 `parallelExecution.enabled`，退回串行

### 风险 3：结果比较误判（评分偏差）
- **缓解**：`autoSelect` 默认 false，需人工确认；评分权重可调
- **回滚**：关闭 `resultComparator.autoSelect`

### 风险 4：Worktree 泄露（异常退出未清理）
- **缓解**：`cleanupTimeoutMs` 超时自动清理；退出时 `cleanupAll`
- **回滚**：手动删除 `.routedev/worktrees/` 目录

### 风险 5：CLI 适配器 spawn 失败（命令不存在）
- **缓解**：fail-open，降级为内部 Worker；spawn 失败时记录错误
- **回滚**：关闭 `cliAdapters.enabled`

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 25 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] WorktreeManager 创建/清理 worktree 正常
- [ ] Worktree 创建失败时降级为共享目录（fail-open）
- [ ] ParallelExecutor 并行执行多个 Worker
- [ ] 最大并行数限制生效
- [ ] Worker 超时后自动清理 worktree
- [ ] ResultComparator 比较多个结果并选出优胜者
- [ ] autoSelect=false 时需人工确认
- [ ] AgentGroupResolver 解析 @group 语法
- [ ] CLIAdapter 接口统一
- [ ] ClaudeCodeAdapter 可 spawn CLI 代理
- [ ] 所有配置默认关闭，设置页可开启
- [ ] 退出时 cleanupAll 清理所有 worktree
- [ ] README.md 与 ARCHITECTURE.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过
