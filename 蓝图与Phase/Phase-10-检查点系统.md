# Phase 10：检查点系统（Git 快照 + 回滚）

**回应**：Phase 9 完成报告的 CONCERN

| # | CONCERN | 处理 |
|---|---------|------|
| C1 | 对话历史硬截断 20 条，/goal 步骤会快速填满历史 | Phase 10 暂不改变截断策略，但检查点快照可辅助上下文恢复。Phase 11（增量 Checkpoint）正式解决 |
| C2 | GoalPlan 只在内存中，重启即丢失 | **本 Phase 核心任务之一**：检查点持久化到 Git 快照 + JSON 元数据 |
| C3 | executeGoalPlan 无 AbortSignal，用户只能 Ctrl+C | **本 Phase 核心任务之一**：新增 /pause 命令 + AbortController |
| C4 | PermissionChecker 规则硬编码在 addRule 中 | Phase 10 不涉及，留待 Phase 13（安全层增强） |
| C5 | CLI 渲染美观度（纯文本步骤卡片） | Phase 10 不涉及，留待 UI 阶段 |
| C6 | handleSubmit 多次 await 可能导致 React state 渲染错位 | Phase 10 不涉及，留待后续优化 |

---

**目标**：实现基于 Git 的检查点系统——在 /goal 步骤执行前自动创建 Git 快照，支持列出检查点、回滚到任意检查点，新增 /pause 命令中断正在执行的目标。

**蓝图参考**：第九节 9.2（CheckpointManager：Git 快照 + 回滚 + 保留 10 个 + 自动清理）

**前置依赖**：Phase 9（/goal 命令 + executeGoalPlan + AbortSignal 需求）

---

## 架构说明

检查点系统是 RouteDev 的"存档/读档"功能。类比游戏——每次进入 Boss 战前自动存档，打输了可以读档重来。Phase 10 用 Git 做"存档引擎"：每次创建检查点就是一次 `git commit`，回滚就是 `git reset --hard`。

```
Phase 9 的 executeGoalPlan 流程：
  步骤 1 → ReAct loop → 完成
  步骤 2 → ReAct loop → 完成
  步骤 3 → ReAct loop → 失败！用户想回退到步骤 2

Phase 10 新增：
  [CheckpointManager]
    步骤 1 前 → 自动 git commit（快照 "goal-step-1-before"）
    步骤 2 前 → 自动 git commit（快照 "goal-step-2-before"）
    步骤 3 前 → 自动 git commit（快照 "goal-step-3-before"）
    步骤 3 失败 → 用户 /rollback → git reset --hard 到步骤 3 前的快照

  [AbortController]
    /pause → abort() → 当前步骤的 ReAct loop 停止 → 后续步骤跳过
```

**关键约束**：
- 检查点只在 **Git 仓库内** 工作。如果当前目录不是 Git 仓库，CheckpointManager 静默降级（不创建快照，不报错）
- 检查点消息使用 `[routedev-checkpoint]` 前缀标记，与用户自己的 git commit 区分
- 最多保留 10 个自动检查点，超出自动清理最旧的
- `git reset --hard` 是破坏性操作——回滚前 **必须** 用户确认（即使在 auto 模式下）
- 检查点元数据（JSON）持久化到 `AppData/RouteDev/checkpoints/`，进程重启后仍可列出和回滚

---

## 具体任务

### Task 1：Checkpoint 类型定义

**文件：** 创建 `src/harness/types.ts`

检查点系统的数据结构，对齐蓝图 9.2 规格。

- [ ] **Step 1：定义 Checkpoint 类型**

```typescript
// src/harness/types.ts
// 检查点系统类型定义（Phase 10）
// 蓝图参考：第九节 9.2 CheckpointManager

/** 检查点记录 */
export interface Checkpoint {
  /** 唯一 ID（UUID 短格式） */
  id: string;
  /** 关联的步骤 ID（来自 GoalPlan.steps） */
  stepId?: number;
  /** 关联的目标 ID（来自 GoalPlan.id） */
  goalId?: string;
  /** Git commit hash */
  gitCommitHash: string;
  /** 创建时间戳 */
  timestamp: number;
  /** 描述（自动生成或用户指定） */
  description: string;
  /** 快照时的文件变更列表（相对于上一个检查点） */
  filesSnapshot: string[];
  /** 是否自动创建（vs 用户手动 /checkpoint） */
  isAutoCreated: boolean;
}

/** 检查点差异（两个检查点之间的变更） */
export interface CheckpointDiff {
  /** 新增的文件 */
  filesAdded: string[];
  /** 修改的文件 */
  filesModified: string[];
  /** 删除的文件 */
  filesDeleted: string[];
  /** Git diff 的 patch 文本 */
  patch: string;
}

/** 检查点管理器配置 */
export interface CheckpointManagerConfig {
  /** 是否启用自动检查点 */
  enabled: boolean;
  /** 最大保留检查点数（超出自动清理最旧的） */
  maxCheckpoints: number;
  /** 工作目录（Git 仓库根目录） */
  workingDirectory: string;
}

/** 检查点创建选项 */
export interface CreateCheckpointOptions {
  /** 描述（不传则自动生成） */
  description?: string;
  /** 关联的步骤 ID */
  stepId?: number;
  /** 关联的目标 ID */
  goalId?: string;
  /** 是否自动创建 */
  isAutoCreated?: boolean;
}
```

- [ ] **Step 2：创建 harness 目录**

```powershell
mkdir src\harness
git add src/harness/types.ts
git commit -m "feat(harness): add checkpoint type definitions for Phase 10"
```

---

### Task 2：CheckpointManager 核心实现

**文件：** 创建 `src/harness/checkpoint-manager.ts`

基于 `simple-git` 的检查点管理器——创建快照、列出检查点、回滚、清理。

- [ ] **Step 1：实现 CheckpointManager**

```typescript
// src/harness/checkpoint-manager.ts
// 检查点管理器：基于 Git 的代码快照与回滚
// 使用 simple-git（已在 dependencies 中）
//
// 检查点 = git commit + JSON 元数据
// 创建：git add -A && git commit -m "[routedev-checkpoint] ..."
// 列出：从 JSON 元数据文件读取
// 回滚：git reset --hard <hash>
// 清理：删除最旧的 git commit + JSON 元数据

import simpleGit, { type SimpleGit } from 'simple-git';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  Checkpoint,
  CheckpointDiff,
  CheckpointManagerConfig,
  CreateCheckpointOptions,
} from './types.js';
import { logger } from '../utils/logger.js';

/** Git commit 消息前缀（用于区分自动检查点和用户提交） */
const CHECKPOINT_PREFIX = '[routedev-checkpoint]';

export class CheckpointManager {
  private git: SimpleGit;
  private config: CheckpointManagerConfig;
  private checkpoints: Checkpoint[] = [];
  /** 元数据文件路径 */
  private metadataPath: string;

  constructor(config: CheckpointManagerConfig) {
    this.config = config;
    this.git = simpleGit(config.workingDirectory);
    // 元数据存储在 AppData 下
    this.metadataPath = this.getMetadataPath();
  }

  /** 初始化：加载已有检查点元数据 */
  async init(): Promise<void> {
    // 检查是否为 Git 仓库
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      logger.warn('CheckpointManager: not a git repository, checkpoints disabled');
      return;
    }

    // 加载元数据
    await this.loadMetadata();
    logger.info('CheckpointManager initialized', {
      checkpointCount: this.checkpoints.length,
      workingDirectory: this.config.workingDirectory,
    });
  }

  /** 创建检查点（Git 快照） */
  async create(options: CreateCheckpointOptions = {}): Promise<Checkpoint | null> {
    if (!this.config.enabled) return null;

    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) return null;

    try {
      // 检查是否有未提交的变更
      const status = await this.git.status();
      const hasChanges = status.files.length > 0;

      if (!hasChanges && this.checkpoints.length > 0) {
        logger.debug('No changes since last checkpoint, skipping');
        return null;
      }

      // 生成检查点 ID
      const id = crypto.randomUUID().slice(0, 8);

      // 获取变更文件列表
      const filesSnapshot = status.files.map(f => f.path);

      // 暂存所有变更
      await this.git.add('-A');

      // 创建 Git commit
      const description = options.description
        ?? `步骤 ${options.stepId ?? '?'} 前快照`;
      const commitMessage = `${CHECKPOINT_PREFIX} ${description} (cp-${id})`;
      const commitResult = await this.git.commit(commitMessage);

      const checkpoint: Checkpoint = {
        id,
        stepId: options.stepId,
        goalId: options.goalId,
        gitCommitHash: commitResult.commit,
        timestamp: Date.now(),
        description,
        filesSnapshot,
        isAutoCreated: options.isAutoCreated ?? true,
      };

      this.checkpoints.push(checkpoint);
      await this.saveMetadata();

      // 自动清理：保留最近 N 个
      await this.prune();

      logger.info('Checkpoint created', {
        id,
        commit: commitResult.commit.slice(0, 7),
        files: filesSnapshot.length,
      });

      return checkpoint;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to create checkpoint', { error: msg });
      return null;
    }
  }

  /** 列出所有检查点 */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** 获取检查点之间的差异 */
  async diff(fromId: string, toId?: string): Promise<CheckpointDiff | null> {
    const from = this.checkpoints.find(c => c.id === fromId);
    if (!from) return null;

    const toHash = toId
      ? this.checkpoints.find(c => c.id === toId)?.gitCommitHash
      : 'HEAD';

    if (!toHash) return null;

    try {
      // 获取 diff 统计
      const diffStat = await this.git.diffSummary([from.gitCommitHash, toHash]);
      const patch = await this.git.diff([from.gitCommitHash, toHash]);

      const result: CheckpointDiff = {
        filesAdded: [],
        filesModified: [],
        filesDeleted: [],
        patch,
      };

      for (const file of diffStat.files) {
        if (file.deletions === 0 && file.insertions > 0 && !file.binary) {
          result.filesAdded.push(file.file);
        } else if (file.deletions > 0 && file.insertions === 0) {
          result.filesDeleted.push(file.file);
        } else {
          result.filesModified.push(file.file);
        }
      }

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get checkpoint diff', { error: msg });
      return null;
    }
  }

  /** 回滚到指定检查点
   *  注意：这是一个破坏性操作（git reset --hard）
   *  调用方必须在执行前获得用户确认
   */
  async rollback(checkpointId: string): Promise<boolean> {
    const checkpoint = this.checkpoints.find(c => c.id === checkpointId);
    if (!checkpoint) {
      logger.error('Checkpoint not found', { id: checkpointId });
      return false;
    }

    try {
      // git reset --hard 到检查点的 commit
      await this.git.reset(['--hard', checkpoint.gitCommitHash]);

      // 清理该检查点之后创建的所有检查点
      const idx = this.checkpoints.indexOf(checkpoint);
      const removed = this.checkpoints.splice(idx + 1);

      // 删除被清理检查点的 Git commits（创建 revert commits 来撤销）
      // 注意：不直接删除 commits（Git 不允许），而是通过 prune 和 GC 自然回收
      await this.saveMetadata();

      logger.info('Rolled back to checkpoint', {
        id: checkpointId,
        commit: checkpoint.gitCommitHash.slice(0, 7),
        removedCheckpoints: removed.length,
      });

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to rollback', { error: msg });
      return false;
    }
  }

  /** 清理超出限制的最旧检查点 */
  private async prune(): Promise<void> {
    while (this.checkpoints.length > this.config.maxCheckpoints) {
      const oldest = this.checkpoints.shift();
      if (!oldest) break;

      logger.debug('Pruning old checkpoint', { id: oldest.id });
      // Git commit 不主动删除（通过 gc 自然回收）
    }
    await this.saveMetadata();
  }

  /** 获取检查点总数 */
  get count(): number {
    return this.checkpoints.length;
  }

  // ===== 元数据持久化 =====

  private getMetadataPath(): string {
    // 使用 AppData 目录
    const appData = process.env.APPDATA
      ?? (process.platform === 'darwin'
        ? path.join(process.env.HOME ?? '', 'Library', 'Application Support')
        : path.join(process.env.HOME ?? '', '.local', 'share'));
    return path.join(appData, 'RouteDev', 'checkpoints', 'metadata.json');
  }

  private async loadMetadata(): Promise<void> {
    try {
      const content = await fs.readFile(this.metadataPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        this.checkpoints = parsed;
      }
    } catch {
      // 文件不存在或损坏，从空列表开始
      this.checkpoints = [];
    }
  }

  private async saveMetadata(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });
      await fs.writeFile(
        this.metadataPath,
        JSON.stringify(this.checkpoints, null, 2),
        'utf-8',
      );
    } catch (error) {
      logger.warn('Failed to save checkpoint metadata', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/harness/checkpoint-manager.ts
git commit -m "feat(harness): implement CheckpointManager with git snapshots and rollback"
```

---

### Task 3：检查点自动创建集成

**文件：** 修改 `src/cli/App.tsx`

在 `executeGoalPlan` 中，每个步骤执行前自动创建检查点。

- [ ] **Step 1：初始化 CheckpointManager**

在 App 组件的 useRef 初始化区域添加：

```typescript
import { CheckpointManager } from '../harness/checkpoint-manager.js';

// 在 useRef 初始化区域：
const checkpointManagerRef = useRef(new CheckpointManager({
  enabled: config.checkpoint.enabled,
  maxCheckpoints: 10,
  workingDirectory: process.cwd(),
}));

// 在 useEffect 中初始化（异步加载元数据）：
useEffect(() => {
  checkpointManagerRef.current.init().catch(err => {
    logger.warn('CheckpointManager init failed', { error: String(err) });
  });
}, []);
```

- [ ] **Step 2：在 executeGoalPlan 中插入自动检查点**

在 `executeGoalPlan` 的步骤循环中，每个步骤执行前创建检查点：

```typescript
// 在 executeGoalPlan 的 for 循环中，step.status = 'in_progress' 之前：

// ===== Phase 10：自动创建检查点 =====
if (config.checkpoint.enabled) {
  const checkpoint = await checkpointManagerRef.current.create({
    description: `步骤 ${step.id} 前快照: ${step.description.slice(0, 40)}`,
    stepId: step.id,
    goalId: plan.id,
    isAutoCreated: true,
  });
  if (checkpoint) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `💾 检查点已创建: cp-${checkpoint.id} (${checkpoint.filesSnapshot.length} 个文件)`,
    }]);
  }
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): auto-create checkpoints before each goal step"
```

---

### Task 4：/pause 命令 + AbortController

**文件：** 修改 `src/cli/App.tsx`

新增 /pause 命令，使用 AbortController 中断当前正在执行的 ReAct loop。

- [ ] **Step 1：新增 AbortController ref**

```typescript
// 在 useRef 区域添加：
const abortControllerRef = useRef<AbortController | null>(null);
```

- [ ] **Step 2：在 ReAct loop 调用中传入 signal**

在 `handleSubmit` 的 ReAct loop 调用中传入 AbortSignal：

```typescript
// 在 for await (const event of agentLoopRef.current.run({...})) 之前：
const abortController = new AbortController();
abortControllerRef.current = abortController;

// 在 run() 参数中传入 signal：
for await (const event of agentLoopRef.current.run({
  userMessage: text,
  llmClient: client,
  routeDecision,
  conversationHistory: conversationHistoryRef.current,
  systemPrompt,
  signal: abortController.signal,  // ← Phase 10 新增
  onConfirmTool: handleToolConfirm,
})) {
  // ... 事件处理不变 ...
}

// 循环结束后清理：
abortControllerRef.current = null;
```

在 `executeGoalPlan` 中也同样传入 signal：

```typescript
// 在 executeGoalPlan 中每个步骤的 run() 调用中：
const stepAbort = new AbortController();
abortControllerRef.current = stepAbort;

for await (const event of agentLoopRef.current.run({
  userMessage: step.description,
  llmClient: client,
  routeDecision,
  conversationHistory: conversationHistoryRef.current,
  systemPrompt,
  signal: stepAbort.signal,  // ← Phase 10 新增
  onConfirmTool: handleToolConfirm,
})) {
  // ... 事件处理不变 ...
}
```

- [ ] **Step 3：实现 /pause 命令**

在 `handleCommand` 的 switch 中添加：

```typescript
case '/pause':
  if (abortControllerRef.current) {
    abortControllerRef.current.abort();
    abortControllerRef.current = null;
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '⏸ 已中断当前执行。后续步骤已跳过。',
    }]);
    // 如果有正在执行的目标计划，标记为 cancelled
    if (currentPlanRef.current?.status === 'executing') {
      currentPlanRef.current.status = 'failed';
    }
    setIsProcessing(false);
  } else {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '当前没有正在执行的任务。',
    }]);
  }
  break;
```

- [ ] **Step 4：在 executeGoalPlan 中检测 abort**

在 `executeGoalPlan` 的步骤循环开头，检查 signal 是否已 abort：

```typescript
// 在 for 循环开头（skip 检查之后）：

// 检查是否已被 /pause 中断
if (abortControllerRef.current?.signal.aborted) {
  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: `⏸ 目标已暂停。已完成 ${i}/${plan.steps.length} 个步骤。`,
  }]);
  plan.status = 'failed';
  break; // 退出步骤循环
}
```

- [ ] **Step 5：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): add /pause command with AbortController for goal execution"
```

---

### Task 5：/checkpoint + /rollback 命令

**文件：** 修改 `src/cli/App.tsx`

新增 /checkpoint（手动创建检查点 + 列表）和 /rollback（回滚到检查点）命令。

- [ ] **Step 1：/checkpoint 命令**

```typescript
case '/checkpoint': {
  const subCmd = parts[1]?.toLowerCase();

  switch (subCmd) {
    case 'list':
    case undefined: {
      const checkpoints = checkpointManagerRef.current.list();
      if (checkpoints.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '没有检查点记录。检查点会在 /goal 步骤执行前自动创建。',
        }]);
      } else {
        const lines = checkpoints.map((cp, i) => {
          const time = new Date(cp.timestamp).toLocaleString('zh-CN');
          const auto = cp.isAutoCreated ? '自动' : '手动';
          const files = cp.filesSnapshot.length;
          return `  ${i + 1}. [cp-${cp.id}] ${cp.description}\n     ${time} | ${cp.gitCommitHash.slice(0, 7)} | ${files} 文件 | ${auto}`;
        });
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `检查点列表 (${checkpoints.length}):\n${lines.join('\n')}`,
        }]);
      }
      break;
    }

    case 'create': {
      const desc = parts.slice(2).join(' ') || '手动创建的检查点';
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: '💾 正在创建检查点...',
      }]);
      const cp = await checkpointManagerRef.current.create({
        description: desc,
        isAutoCreated: false,
      });
      if (cp) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `💾 检查点已创建: cp-${cp.id} (${cp.gitCommitHash.slice(0, 7)}, ${cp.filesSnapshot.length} 个文件)`,
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '检查点创建失败（可能没有变更或不在 Git 仓库中）。',
        }]);
      }
      break;
    }

    default:
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          '检查点命令：',
          '  /checkpoint list    - 查看所有检查点',
          '  /checkpoint create  - 手动创建检查点',
        ].join('\n'),
      }]);
  }
  break;
}
```

- [ ] **Step 2：/rollback 命令**

```typescript
case '/rollback': {
  const cpId = parts[1];
  if (!cpId) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '用法: /rollback <checkpoint-id>\n例: /rollback a1b2c3d4\n使用 /checkpoint list 查看可用检查点。',
    }]);
    break;
  }

  // 查找检查点
  const checkpoints = checkpointManagerRef.current.list();
  const target = checkpoints.find(c => c.id === cpId || c.id.startsWith(cpId));
  if (!target) {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `未找到检查点 "${cpId}"。使用 /checkpoint list 查看可用检查点。`,
    }]);
    break;
  }

  // 回滚是破坏性操作，需要确认
  setMessages(prev => [...prev, {
    id: nextId(),
    role: 'system' as const,
    content: [
      `⚠️ 即将回滚到检查点: cp-${target.id}`,
      `  描述: ${target.description}`,
      `  提交: ${target.gitCommitHash.slice(0, 7)}`,
      `  时间: ${new Date(target.timestamp).toLocaleString('zh-CN')}`,
      ``,
      `⚠️ 这是破坏性操作（git reset --hard），回滚后当前未提交的变更将丢失！`,
      `输入 y 确认回滚，n 取消`,
    ].join('\n'),
  }]);

  // 使用 pendingConfirmRef 机制等待确认
  // 复用 pendingConfirmRef（与工具确认相同的 y/n 路由）
  const confirmed = await new Promise<boolean>((resolve) => {
    pendingConfirmRef.current = {
      resolve,
      toolName: `回滚到 cp-${target.id}`,
    };
  });

  if (confirmed) {
    const success = await checkpointManagerRef.current.rollback(target.id);
    if (success) {
      const remaining = checkpointManagerRef.current.count;
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `✓ 已回滚到 cp-${target.id} (${target.gitCommitHash.slice(0, 7)})。剩余 ${remaining} 个检查点。`,
      }]);
    } else {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `回滚失败。请检查 Git 状态。`,
      }]);
    }
  } else {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: '回滚已取消。',
    }]);
  }
  break;
}
```

- [ ] **Step 3：更新 /help**

在 /help 中添加新命令：

```
  /checkpoint list       - 查看检查点列表
  /checkpoint create     - 手动创建检查点
  /rollback <id>         - 回滚到指定检查点
  /pause                 - 中断当前执行
```

- [ ] **Step 4：更新 /status**

在 /status 中添加检查点信息：

```typescript
`检查点: ${checkpointManagerRef.current.count} 个`,
```

- [ ] **Step 5：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): add /checkpoint and /rollback commands"
```

---

### Task 6：GoalPlan 持久化（可选增强）

**文件：** 修改 `src/harness/checkpoint-manager.ts` 或新增辅助模块

将 GoalPlan 状态持久化到文件，进程重启后可恢复。

- [ ] **Step 1：在 CheckpointManager 中添加 GoalPlan 持久化方法**

```typescript
// 在 CheckpointManager 类中新增（或单独创建 GoalStore 类）：

/** 保存当前目标计划 */
async saveGoalPlan(plan: GoalPlan): Promise<void> {
  const goalPath = path.join(path.dirname(this.metadataPath), 'current-goal.json');
  try {
    await fs.writeFile(goalPath, JSON.stringify(plan, null, 2), 'utf-8');
  } catch (error) {
    logger.warn('Failed to save goal plan', { error: String(error) });
  }
}

/** 加载上一次的目标计划 */
async loadGoalPlan(): Promise<GoalPlan | null> {
  const goalPath = path.join(path.dirname(this.metadataPath), 'current-goal.json');
  try {
    const content = await fs.readFile(goalPath, 'utf-8');
    return JSON.parse(content) as GoalPlan;
  } catch {
    return null;
  }
}

/** 清除已保存的目标计划 */
async clearGoalPlan(): Promise<void> {
  const goalPath = path.join(path.dirname(this.metadataPath), 'current-goal.json');
  try {
    await fs.unlink(goalPath);
  } catch {
    // 文件不存在，忽略
  }
}
```

- [ ] **Step 2：在 executeGoalPlan 中持久化**

在 `executeGoalPlan` 中：

```typescript
// 开始执行前保存计划
await checkpointManagerRef.current.saveGoalPlan(plan);

// 执行完成后清除
if (plan.status === 'completed' || plan.status === 'failed') {
  await checkpointManagerRef.current.clearGoalPlan();
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/harness/checkpoint-manager.ts src/cli/App.tsx
git commit -m "feat(harness): persist GoalPlan state across restarts"
```

---

### Task 7：单元测试

**文件：**
- 创建 `tests/harness/checkpoint-manager.test.ts`

- [ ] **Step 1：CheckpointManager 核心测试**

测试点（使用临时 Git 仓库）：

- init() 非 Git 仓库 → 静默降级，不报错
- init() Git 仓库 → 加载元数据
- create() 有变更 → 返回 Checkpoint，gitCommitHash 非空
- create() 无变更 → 返回 null（跳过）
- create() disabled → 返回 null
- list() 返回所有检查点
- rollback() 成功 → 文件恢复到检查点状态
- rollback() 不存在的 ID → 返回 false
- prune() 超出 maxCheckpoints → 删除最旧的
- 元数据持久化 → saveMetadata + loadMetadata 往返一致
- diff() 两个检查点之间的文件变更

- [ ] **Step 2：AbortController 测试**

测试点：
- /pause 命令 → abortController.signal.aborted === true
- 无执行中任务时 /pause → 提示"当前没有正在执行的任务"

- [ ] **Step 3：GoalPlan 持久化测试**

测试点：
- saveGoalPlan + loadGoalPlan 往返一致
- clearGoalPlan 后 loadGoalPlan 返回 null
- 文件不存在时 loadGoalPlan 返回 null

- [ ] **Step 4：运行全部测试 → 提交**

```powershell
pnpm test
git add tests/
git commit -m "test(harness): add tests for CheckpointManager, /pause, and goal persistence"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 160 个用例，Phase 9 的 143 + Phase 10 新增 ~20）
4. CheckpointManager 在 Git 仓库中能正确创建/列出/回滚检查点
5. 非 Git 仓库时 CheckpointManager 静默降级（不影响主流程）
6. /goal 步骤执行前自动创建 Git 快照（commit 消息带 `[routedev-checkpoint]` 前缀）
7. 最多保留 10 个检查点，超出自动清理最旧的
8. /checkpoint list 显示所有检查点（ID、描述、时间、commit hash、文件数）
9. /checkpoint create 手动创建检查点
10. /rollback <id> 回滚到指定检查点（回滚前需用户确认，即使 auto 模式）
11. /pause 能中断当前正在执行的 ReAct loop（AbortController）
12. executeGoalPlan 在 /pause 后停止执行后续步骤
13. 检查点元数据持久化到 AppData/RouteDev/checkpoints/metadata.json
14. GoalPlan 状态可持久化（saveGoalPlan / loadGoalPlan）
15. /help 和 /status 反映新增功能

## 注意事项

- **Git 仓库依赖**：CheckpointManager 只在当前目录是 Git 仓库时工作。如果不是 Git 仓库，所有操作返回 null/false，不抛异常。用户可通过 `git init` 初始化
- **检查点前缀**：`[routedev-checkpoint]` 前缀用于区分自动检查点和用户自己的 commit。`git log --oneline --grep="[routedev-checkpoint]"` 可以过滤查看所有
- **git reset --hard 安全性**：回滚使用 `git reset --hard`，会丢弃所有未提交的变更。即使在 auto 模式下，回滚操作也 **必须** 经过用户确认（复用 pendingConfirmRef）
- **pendingConfirmRef 复用**：/rollback 的确认复用了 Phase 9 的工具确认机制（同一个 ref）。这意味着回滚确认和工具确认走同一个 y/n 路由，不会冲突（因为回滚时不在执行工具）
- **元数据路径**：`AppData/RouteDev/checkpoints/metadata.json`（Windows）、`~/Library/Application Support/RouteDev/checkpoints/metadata.json`（macOS）。使用 `process.env.APPDATA` 获取 Windows 路径
- **simple-git 版本**：`^3.36.0` 已在 dependencies 中，无需额外安装。`diffSummary()`、`reset()`、`commit()` 等 API 在 v3 中稳定可用
- **checkpointManagerRef.current.init()**：在 useEffect 中异步调用。如果 init 失败（如 AppData 目录权限问题），静默降级为无检查点
- **executeGoalPlan 中的 AbortSignal**：每个步骤创建新的 AbortController，`/pause` 调用 `abort()` 后，当前步骤的 ReAct loop 在下一次检查 `signal.aborted` 时退出。后续步骤在循环开头检查 `signal.aborted` 并跳过
- **GoalPlan 持久化格式**：直接 JSON.stringify(plan)，因为 GoalPlan 和 GoalStep 都是纯数据（无函数、无循环引用）。loadGoalPlan 用 JSON.parse 恢复，不验证类型（Phase 11 可加 Zod schema 验证）
- **检查点 vs 增量 Checkpoint**：Phase 10 的 CheckpointManager 是 **Git 快照** 级别的检查点（完整文件快照）。Phase 11 的增量 Checkpoint 是 **记忆压缩** 级别的（MiMo Code 风格，LLM 生成摘要）。两者互补但独立
- **checkpoint.config.enabled**：使用已有的 `config.checkpoint.enabled`（默认 true）。如果用户在 routedev.yaml 中设置 `checkpoint.enabled: false`，则不创建自动检查点

---

*Phase 10 | 蓝图 V1.0 | 预估新增文件：~3 个 | 预估修改文件：~1 个（App.tsx）*
