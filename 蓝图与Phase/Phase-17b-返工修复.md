# Phase 17b — 返工修复：Phase 17/18/19 未完成项收束

> **Phase 类型：** 返工修复（Remediation）
> **前置依赖：** Phase 17 + Phase 18 + Phase 19 已执行
> **目标版本：** v0.17b.0
> **执行人注意：** 这是返工 Phase，专门收束 Phase 17/18/19 中"搭了架子没装修"的遗留项。所有 Task 都对应已审阅确认的缺陷，不是新增需求。

---

## 背景

Phase 17/18/19 的执行报告声称完成了多项交付物，但架构师逐项验证后发现 10 项中仅 3 项通过。核心问题：

1. **App.tsx 不缩反涨**：1450→1548 行。CommandRegistry 创建了但旧的 580 行 switch 块没删，新旧并存。
2. **安全加固全缺**：WebhookServer 无 rate limit / 无认证 / 无 body 限制；企业微信两个已知漏洞未修。
3. **用户功能未接通**：/cost、/history 命令不存在；中文 token 估算依然是 `Math.ceil(text.length / 4)`。
4. **Phase 17 的 vision.ts 路径遍历和 branch.ts 状态不一致**：两个安全/正确性缺陷未修。

本 Phase 的目标：**把 Phase 17/18/19 的债全部还清，App.tsx 瘦身到 ≤ 400 行，所有安全漏洞封堵，不留尾巴进入 Phase 20。**

---

## 核心原则

1. **搬家式迁移**：把 switch 块里的逻辑搬到独立命令文件后，**必须删除 App.tsx 里的旧代码**。不能新旧并存。
2. **安全不妥协**：WebhookServer 和企业微信的安全修复是强制项，不是"可选优化"。
3. **UI 副作用走桥接**：命令文件不能直接调 React setState。通过 ServiceContext 上的 `commandBridge` 回调桥接 UI 操作。
4. **测试覆盖**：每个新命令文件至少 1 个单元测试；安全修复必须有对应测试。

---

## 接口对齐观察表

以下签名已通过代码验证，Phase 中的引用必须与此一致：

| 接口 / 函数 | 当前签名 | 文件位置 | 备注 |
|---|---|---|---|
| `CommandDefinition` | `{ name, aliases?, description, usage?, handler: (args, ctx) => Promise<CommandHandlerResult> }` | `src/cli/command-registry.ts` | |
| `CommandHandlerResult` | `{ type: 'handled'; messages?: string[] } \| { type: 'passthrough'; input: string }` | `src/cli/command-registry.ts` | |
| `CommandRegistry.register(def)` | `register(def: CommandDefinition): void` | `src/cli/command-registry.ts` | |
| `CommandRegistry.execute(input, ctx)` | `execute(input: string, ctx: ServiceContext): Promise<CommandHandlerResult>` | `src/cli/command-registry.ts` | |
| `ServiceContext` | 22 字段的接口（config, clientManager, router, tracker, agentLoop, checkpointWriter, contextManager, branchManager, vision, initAnalyzer, dream, goalParser, goalVerifier, blackboard, orchestrator, workerExecutor, trace, audit, prompts, projectMemory, toolExecutor, setToolExecutor, sessionId, cwd） | `src/cli/service-context.ts` | Task 1 需新增 `commandBridge` 字段 |
| `StatusBar` props | `{ currentModel, currentTier, isDegraded, todayTokensUsed, autonomyMode, workMode }` — 共 6 个 | `src/cli/components/StatusBar.tsx` | |
| `InputBox` props | `{ onSubmit: (text: string) => void; disabled?: boolean }` | `src/cli/components/InputBox.tsx` | |
| `ChatView` props | `{ messages: ChatMessage[] }` | `src/cli/components/ChatView.tsx` | |
| `ChannelAdapter` | `{ readonly type, readonly config, start(), stop(), isRunning(), onMessage(handler), sendResponse(targetId, text, isGroup): Promise<ChannelResponse>, getStatus(): ChannelStatus }` | `src/channels/types.ts` | |
| `ChannelStatus` | `{ type, running, messagesProcessed, lastMessageAt?, error? }` | `src/channels/types.ts` | |
| `ChannelResponse` | `{ text: string; success: boolean; error?: string }` | `src/channels/types.ts` | |
| `WebhookServer` | 163 行，无 rate limit / 无 auth / 无 body 限制 | `src/channels/server.ts` | Task 3 修复 |
| `loadConfig(options?)` | `loadConfig(options?: { projectPath?: string; globalConfigPath?: string }): AppConfig` | `src/config/loader.ts` | |
| `TokenTracker.getStats()` | `getStats(): TokenStats { total, byModel, byAgent, byStep }` | `src/router/tracker.ts` | 没有 `getTodayUsage()` |
| `RetryPolicy` | class，`execute<T>(fn: () => Promise<T>): Promise<T>` | `src/utils/retry.ts` | |
| `CircuitBreaker` | class，`execute<T>(fn: () => Promise<T>): Promise<T>` | `src/utils/retry.ts` | |
| `resilientExecute<T>(fn, options?)` | 组合 retry + circuit breaker | `src/utils/retry.ts` | |
| `AppConfig.autonomy` | `{ defaultMode: AutonomyMode }` | `src/config/schema.ts` | |
| `AutonomyMode` | `'auto' \| 'semi' \| 'manual'` | `src/config/schema.ts` | |
| `Checkpoint` | `{ id, stepId?, goalId?, gitCommitHash, timestamp, description, filesSnapshot, isAutoCreated }` | `src/harness/types.ts` | 注意：无 `tag`/`createdAt` 字段 |
| `CreateCheckpointOptions` | `{ description?, stepId?, goalId?, isAutoCreated? }` | `src/harness/types.ts` | 注意：无 `tag` 字段 |
| `CheckpointManager.create(options?)` | `create(options?: CreateCheckpointOptions): Promise<Checkpoint \| null>` | `src/harness/checkpoint-manager.ts` | |
| `CheckpointManager.list()` | `list(): Checkpoint[]` | `src/harness/checkpoint-manager.ts` | |
| `CheckpointManager.rollback(id)` | `rollback(checkpointId: string): Promise<boolean>` | `src/harness/checkpoint-manager.ts` | |
| `DreamResult` | `{ beforeSize, afterSize, mergedCount, consolidated: CheckpointData, summary: string }` | `src/agent/dream-consolidator.ts` | |
| `DreamConsolidator.consolidate(cp)` | `consolidate(checkpoint: CheckpointData): Promise<DreamResult>` | `src/agent/dream-consolidator.ts` | 需要传入 CheckpointData |
| `BranchManager.switchBranch(id)` | `switchBranch(branchId: string): LLMMessage[] \| null` | `src/agent/branch.ts` | 不是 `switchToBranch` |
| `ContextManager.getCheckpoint()` | `getCheckpoint(): CheckpointData \| null` | `src/agent/memory/context-manager.ts` | |

---
## Task 1：完成命令迁移 — 11 个新命令文件 + CommandBridge

> **目标：** 把 App.tsx switch 块里的 11 组命令全部搬到独立文件，为 Task 7 删除旧代码做准备。

### Step 0：扩展 ServiceContext，新增 CommandBridge

命令文件是独立模块，不能直接调用 React 的 `setMessages` 或 `setAutonomyMode`。需要在 ServiceContext 上新增一个"桥接"接口，让命令可以通过回调影响 UI。

**文件：** 修改 `src/cli/service-context.ts`

```typescript
// src/cli/service-context.ts — 新增 CommandBridge 接口

/** 命令与 UI 之间的桥接：命令通过回调影响 UI，不直接持有 React state */
export interface CommandBridge {
  /** 向聊天追加系统消息 */
  addSystemMessage: (content: string) => void;
  /** 清空聊天并重置上下文 */
  clearChat: () => void;
  /** 切换自治模式 */
  setAutonomyMode: (mode: AutonomyMode) => void;
  /** 请求中断当前执行 */
  requestAbort: () => void;
  /** 请求确认（返回用户输入 'y'/'n'） */
  requestConfirm: (prompt: string) => Promise<boolean>;
  /** 退出程序 */
  exit: () => void;
}

// 在 ServiceContext 接口中新增：
// commandBridge: CommandBridge;
```

**文件：** 修改 `src/cli/App.tsx` 的 `buildServiceContext` 回调

在 `buildServiceContext` 中实现 `commandBridge`：

```typescript
const commandBridge: CommandBridge = {
  addSystemMessage: (content: string) => {
    setMessages(prev => [...prev, { id: nextId(), role: 'system', content }]);
  },
  clearChat: () => {
    setMessages([{ id: nextId(), role: 'system', content: '对话已清空。' }]);
    conversationHistoryRef.current = [];
    contextManagerRef.current.resetTriggers();
  },
  setAutonomyMode: (mode: AutonomyMode) => {
    setAutonomyMode(mode);
  },
  requestAbort: () => {
    abortControllerRef.current?.abort();
  },
  requestConfirm: async (prompt: string): Promise<boolean> => {
    // 使用 pendingConfirmRef 机制：
    // 1. 显示确认提示
    // 2. 等待用户下一次输入
    // 3. 返回 true/false
    // 具体实现：设置 pendingConfirmRef，然后在 handleSubmit 中检测
    setMessages(prev => [...prev, { id: nextId(), role: 'system', content: prompt + ' (y/n)' }]);
    return new Promise<boolean>((resolve) => {
      pendingConfirmRef.current = (answer: string) => {
        resolve(answer.toLowerCase() === 'y');
      };
    });
  },
  exit: () => {
    audit?.log({ action: 'session_end', sessionId: trace.getSessionId(), details: {} });
    process.exit(0);
  },
};
```

在 `buildServiceContext` 返回的对象中加入 `commandBridge`。

---

### Step 1：创建 `src/cli/commands/autonomy.ts`

处理 `/auto`、`/semi`、`/manual` 三个命令（通过 aliases）。

```typescript
// src/cli/commands/autonomy.ts

import type { CommandDefinition } from '../command-registry.js';
import type { AutonomyMode } from '../../config/schema.js';

const MODE_MAP: Record<string, AutonomyMode> = {
  auto: 'auto',
  semi: 'semi',
  manual: 'manual',
};

function makeModeCommand(name: string, mode: AutonomyMode, label: string): CommandDefinition {
  return {
    name,
    description: `切换到${label}模式`,
    handler: async (_args, ctx) => {
      ctx.commandBridge.setAutonomyMode(mode);
      return {
        type: 'handled',
        messages: [`已切换到${label}模式。`],
      };
    },
  };
}

export const autoCommand = makeModeCommand('auto', 'auto', '全自动');
export const semiCommand = makeModeCommand('semi', 'semi', '半自动');
export const manualCommand = makeModeCommand('manual', 'manual', '手动');
```

---

### Step 2：创建 `src/cli/commands/pause.ts`

```typescript
// src/cli/commands/pause.ts

export const pauseCommand: CommandDefinition = {
  name: 'pause',
  aliases: ['stop', 'abort'],
  description: '中断当前执行',
  handler: async (_args, ctx) => {
    ctx.commandBridge.requestAbort();
    return { type: 'handled', messages: ['已发送中断信号。'] };
  },
};
```

---

### Step 3：创建 `src/cli/commands/checkpoint.ts`

处理 `/checkpoint create [tag]` 和 `/checkpoint list`。

```typescript
// src/cli/commands/checkpoint.ts

export const checkpointCommand: CommandDefinition = {
  name: 'checkpoint',
  aliases: ['cp'],
  description: '检查点管理',
  usage: '/checkpoint create [tag] | /checkpoint list',
  handler: async (args, ctx) => {
    const { checkpointManager } = ctx;
    const parts = args.split(' ');
    const sub = parts[0] || 'list';

    switch (sub) {
      case 'create': {
        const description = parts.slice(1).join(' ') || undefined;
        const cp = await checkpointManager.create({ description, isAutoCreated: false });
        if (!cp) {
          return { type: 'handled', messages: ['检查点创建失败（可能不在 Git 仓库中或未启用检查点）。'] };
        }
        return { type: 'handled', messages: [`检查点已创建: ${cp.id} (${cp.description})`] };
      }
      case 'list': {
        const checkpoints = checkpointManager.list();
        if (checkpoints.length === 0) {
          return { type: 'handled', messages: ['暂无检查点。'] };
        }
        const lines = checkpoints.map((cp, i) =>
          `  ${i + 1}. ${cp.id} — ${cp.description} (${new Date(cp.timestamp).toLocaleString()})`
        );
        return { type: 'handled', messages: [['检查点列表:', ...lines].join('\n')] };
      }
      default:
        return { type: 'handled', messages: ['用法: /checkpoint create [tag] | /checkpoint list'] };
    }
  },
};
```

> **执行人注意：** `CheckpointManager.create(options?: CreateCheckpointOptions)` 接受 `description`、`stepId`、`goalId`、`isAutoCreated` 字段。`CheckpointManager.list(): Checkpoint[]` 返回数组，`Checkpoint` 有 `id`、`description`、`timestamp`（毫秒）、`gitCommitHash` 等字段——注意没有 `tag` 和 `createdAt`。核心逻辑从 App.tsx 第 770-829 行的 checkpoint case 搬过来，注意 `CheckpointWriter` 是自动检查点写入器（接受 `CheckpointWriterInput` 对象），不是 CLI 用的——CLI 用 `CheckpointManager`。

---

### Step 4：创建 `src/cli/commands/rollback.ts`

```typescript
// src/cli/commands/rollback.ts

export const rollbackCommand: CommandDefinition = {
  name: 'rollback',
  description: '回滚到指定检查点',
  usage: '/rollback <checkpoint-id>',
  handler: async (args, ctx) => {
    const { checkpointManager, commandBridge } = ctx;
    const id = args.trim();
    if (!id) {
      return { type: 'handled', messages: ['用法: /rollback <checkpoint-id>'] };
    }

    const checkpoint = checkpointManager.list().find(cp => cp.id === id);
    if (!checkpoint) {
      return { type: 'handled', messages: [`找不到检查点: ${id}`] };
    }

    const confirmed = await commandBridge.requestConfirm(
      `确认回滚到检查点 ${id}（${checkpoint.description}）？当前对话将丢失。`
    );
    if (!confirmed) {
      return { type: 'handled', messages: ['回滚已取消。'] };
    }

    const success = await checkpointManager.rollback(id);
    if (!success) {
      return { type: 'handled', messages: ['回滚失败。'] };
    }
    commandBridge.clearChat();
    return { type: 'handled', messages: [`已回滚到检查点: ${id}`] };
  },
};
```

> **执行人注意：** `CheckpointManager` 没有 `findById()` 方法，用 `list().find()` 代替。`rollback(id)` 返回 `Promise<boolean>`。核心逻辑从 App.tsx 第 831-894 行搬过来。

---

### Step 5：创建 `src/cli/commands/goal.ts`

```typescript
// src/cli/commands/goal.ts

export const goalCommand: CommandDefinition = {
  name: 'goal',
  description: '目标分解与执行',
  usage: '/goal "目标描述" [--verify "验证条件"]',
  handler: async (args, ctx) => {
    const { goalParser, goalVerifier, commandBridge } = ctx;

    if (!args.trim()) {
      return { type: 'handled', messages: ['用法: /goal "目标描述" [--verify "验证条件"]'] };
    }

    // 解析 --verify 参数
    let verifyCondition: string | undefined;
    let goalText = args;
    const verifyMatch = args.match(/--verify\s+"([^"]+)"/);
    if (verifyMatch) {
      verifyCondition = verifyMatch[1];
      goalText = args.replace(verifyMatch[0], '').trim();
    }

    // 调用 GoalParser 分解目标
    const plan = await goalParser.parse(goalText);
    commandBridge.addSystemMessage(`目标已分解为 ${plan.steps.length} 个步骤。`);

    // 后续执行逻辑：交给 Agent Loop 执行各步骤
    // 具体实现参考 App.tsx handleGoalCommand 的逻辑
    // ...

    return { type: 'handled', messages: [`目标计划:\n${plan.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`] };
  },
};
```

> **执行人注意：** 这个命令的核心逻辑从 App.tsx `handleGoalCommand` 函数（约第 736-746 行调用的那个函数）搬过来。请完整搬迁，不要简化。

---

### Step 6：创建 `src/cli/commands/branch.ts`

```typescript
// src/cli/commands/branch.ts

export const branchCommand: CommandDefinition = {
  name: 'branch',
  description: '对话分支管理',
  usage: '/branch list | /branch switch <id> | /branch edit <N> <内容>',
  handler: async (args, ctx) => {
    const { branchManager, commandBridge } = ctx;
    const parts = args.split(' ');
    const sub = parts[0] || 'list';

    switch (sub) {
      case 'list': {
        const branches = branchManager.listBranches();
        if (branches.length === 0) {
          return { type: 'handled', messages: ['暂无分支。'] };
        }
        const lines = branches.map(b =>
          `  ${b.id} — ${b.name} (${b.messageCount} 条消息${b.isActive ? ', 当前' : ''})`
        );
        return { type: 'handled', messages: [['分支列表:', ...lines].join('\n')] };
      }
      case 'switch': {
        const id = parts[1];
        if (!id) return { type: 'handled', messages: ['用法: /branch switch <id>'] };
        const history = branchManager.switchBranch(id);
        if (!history) {
          return { type: 'handled', messages: [`分支不存在: ${id}`] };
        }
        commandBridge.addSystemMessage(`已切换到分支: ${id} (${history.length} 条消息)`);
        return { type: 'handled' };
      }
      case 'edit': {
        const index = parseInt(parts[1], 10);
        const content = parts.slice(2).join(' ');
        if (isNaN(index) || !content) {
          return { type: 'handled', messages: ['用法: /branch edit <序号> <新内容>'] };
        }
        branchManager.editByHistoryIndex(index, content);
        return { type: 'handled', messages: [`已编辑第 ${index} 条消息。`] };
      }
      default:
        return { type: 'handled', messages: ['用法: /branch list | switch <id> | edit <N> <内容>'] };
    }
  },
};
```

---

### Step 7：创建 `src/cli/commands/init.ts`

```typescript
// src/cli/commands/init.ts

export const initCommand: CommandDefinition = {
  name: 'init',
  description: '分析项目并生成规则',
  handler: async (_args, ctx) => {
    const { initAnalyzer, commandBridge } = ctx;

    commandBridge.addSystemMessage('正在分析项目结构...');
    const analysis = await initAnalyzer.analyze();
    const rules = await initAnalyzer.generateRules(analysis);
    await initAnalyzer.saveRules(rules);

    return {
      type: 'handled',
      messages: [`项目分析完成，已生成规则文件。\n${rules}`],
    };
  },
};
```

> **执行人注意：** 从 App.tsx 第 1127-1158 行搬过来。`initAnalyzer` 的三个方法签名请以实际代码为准。

---

### Step 8：创建 `src/cli/commands/dream.ts`

```typescript
// src/cli/commands/dream.ts

export const dreamCommand: CommandDefinition = {
  name: 'dream',
  description: '整理与巩固对话记忆',
  handler: async (_args, ctx) => {
    const { dream, contextManager, commandBridge } = ctx;

    const checkpoint = contextManager.getCheckpoint();
    if (!checkpoint) {
      return { type: 'handled', messages: ['暂无可用的检查点数据，无法执行记忆整理。请先创建检查点。'] };
    }

    commandBridge.addSystemMessage('正在整理记忆...');
    const result = await dream.consolidate(checkpoint);

    return {
      type: 'handled',
      messages: [`记忆整理完成。\n摘要: ${result.summary || '(无摘要)'}`],
    };
  },
};
```

> **执行人注意：** `DreamConsolidator.consolidate(checkpoint: CheckpointData)` 需要传入 `CheckpointData` 参数。通过 `contextManager.getCheckpoint()` 获取当前检查点数据。如果返回 null，说明还没有检查点，应提示用户先创建。从 App.tsx 第 1160-1185 行搬过来时注意保持完整逻辑。

---

### Step 9：创建 `src/cli/commands/quit.ts`

```typescript
// src/cli/commands/quit.ts

export const quitCommand: CommandDefinition = {
  name: 'quit',
  aliases: ['exit', 'q'],
  description: '退出程序',
  handler: async (_args, ctx) => {
    // commandBridge.exit() 内部会记录审计日志后调用 process.exit(0)
    ctx.commandBridge.exit();
    return { type: 'handled' }; // 实际不会执行到，exit() 会终止进程
  },
};
```

---

### Step 10：更新 `src/cli/commands/index.ts`

在现有 8 个 re-export 基础上新增：

```typescript
export * from './autonomy.js';
export * from './pause.js';
export * from './checkpoint.js';
export * from './rollback.js';
export * from './goal.js';
export * from './branch.js';
export * from './init.js';
export * from './dream.js';
export * from './quit.js';
```

---

### Step 11：注册所有新命令

在 App.tsx 的 CommandRegistry 初始化处（约第 298-305 行），新增注册：

```typescript
commandRegistryRef.current.register(autoCommand);
commandRegistryRef.current.register(semiCommand);
commandRegistryRef.current.register(manualCommand);
commandRegistryRef.current.register(pauseCommand);
commandRegistryRef.current.register(checkpointCommand);
commandRegistryRef.current.register(rollbackCommand);
commandRegistryRef.current.register(goalCommand);
commandRegistryRef.current.register(branchCommand);
commandRegistryRef.current.register(initCommand);
commandRegistryRef.current.register(dreamCommand);
commandRegistryRef.current.register(quitCommand);
```

---

### Step 12：单元测试

为每个新命令文件编写至少 1 个测试，验证：
- 命令名和别名正确注册
- handler 返回预期的 `CommandHandlerResult`
- CommandBridge 回调被正确调用（用 mock）

测试文件：`tests/cli/commands/` 目录下新建对应文件。

---

## Task 2：新增 /cost 和 /history 命令

### Step 1：创建 `src/cli/commands/cost.ts`

```typescript
// src/cli/commands/cost.ts

import type { CommandDefinition } from '../command-registry.js';

export const costCommand: CommandDefinition = {
  name: 'cost',
  description: '查看 Token 用量与费用',
  handler: async (_args, ctx) => {
    const { tracker } = ctx;
    const stats = tracker.getStats();

    const lines: string[] = ['Token 用量统计:'];
    lines.push(`  总计: ${stats.total.totalTokens ?? 0} tokens (输入 ${stats.total.inputTokens ?? 0}, 输出 ${stats.total.outputTokens ?? 0})`);

    if (stats.byModel && stats.byModel.size > 0) {
      lines.push('\n按模型:');
      for (const [model, usage] of stats.byModel.entries()) {
        lines.push(`  ${model}: ${usage.totalTokens ?? 0} tokens`);
      }
    }

    return { type: 'handled', messages: [lines.join('\n')] };
  },
};
```

> **执行人注意：** `stats.byModel` 是 `Map<string, TokenUsageInfo>`。`TokenUsageInfo` 包含 `inputTokens`, `outputTokens`, `totalTokens` 以及可选的 `cacheReadTokens`, `cacheWriteTokens`。请用实际类型验证。

---

### Step 2：创建 `src/cli/commands/history.ts`

```typescript
// src/cli/commands/history.ts

import type { CommandDefinition } from '../command-registry.js';

export const historyCommand: CommandDefinition = {
  name: 'history',
  description: '查看对话历史摘要',
  usage: '/history [条数]',
  handler: async (args, ctx) => {
    const { branchManager } = ctx;
    const count = parseInt(args.trim(), 10) || 10;

    // 通过 branchManager 获取当前分支的历史
    const branches = branchManager.listBranches();
    const activeBranch = branches.find(b => b.isActive);

    if (!activeBranch) {
      return { type: 'handled', messages: ['暂无对话历史。'] };
    }

    const lines = [
      `对话历史（最近 ${count} 条，分支 ${activeBranch.name}）:`,
      `  总消息数: ${activeBranch.messageCount}`,
      `  分支 ID: ${activeBranch.id}`,
    ];

    return { type: 'handled', messages: [lines.join('\n')] };
  },
};
```

> **执行人注意：** history 命令的具体实现取决于 BranchManager 能提供多少历史数据。请根据实际 API 调整，核心是给用户一个"我的对话概况"的视图。

---

### Step 3：注册 + index.ts 更新 + 测试

同 Task 1 的 Step 10-12 模式。

---

## Task 3：WebhookServer 安全加固

> **文件：** `src/channels/server.ts`（当前 163 行）
> **蓝图引用：** Section 9.4 安全要求

### Step 1：添加请求体大小限制

在 `readBody` 方法中增加 body 大小检查：

```typescript
private readBody(req: http.IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
```

### Step 2：添加 Bearer Token 认证

在 `WebhookServerConfig` 中新增 `authToken?: string` 字段。

在 `handleRequest` 中，对非 `/status` 路径检查 Authorization 头：

```typescript
private verifyAuth(req: http.IncomingMessage): boolean {
  if (!this.config.authToken) return true; // 未配置则跳过（开发模式）
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  // 使用 timingSafeEqual 比较
  const provided = Buffer.from(authHeader.slice(7));
  const expected = Buffer.from(this.config.authToken);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}
```

> 认证失败时返回 401。

### Step 3：添加速率限制

在 `WebhookServer` 中新增简单的令牌桶限流：

```typescript
// 简单的令牌桶限流
private rateLimit = new Map<string, { tokens: number; lastRefill: number }>();
private readonly rateLimitConfig = { maxTokens: 30, refillRate: 10, refillIntervalMs: 1000 };

private checkRateLimit(clientIp: string): boolean {
  const now = Date.now();
  let bucket = this.rateLimit.get(clientIp);
  if (!bucket) {
    bucket = { tokens: this.rateLimitConfig.maxTokens, lastRefill: now };
    this.rateLimit.set(clientIp, bucket);
  }
  // 补充令牌
  const elapsed = now - bucket.lastRefill;
  const refills = Math.floor(elapsed / this.rateLimitConfig.refillIntervalMs);
  if (refills > 0) {
    bucket.tokens = Math.min(this.rateLimitConfig.maxTokens, bucket.tokens + refills * this.rateLimitConfig.refillRate);
    bucket.lastRefill = now;
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  return true;
}
```

> 限流失败时返回 429。

### Step 4：handleRequest 整合

```typescript
private async handleRequest(req, res) {
  // 1. 速率限制
  const clientIp = req.socket.remoteAddress || 'unknown';
  if (!this.checkRateLimit(clientIp)) {
    res.writeHead(429);
    res.end('Too Many Requests');
    return;
  }
  // 2. 认证（/status 路径免认证）
  const url = new URL(req.url!, `http://${req.headers.host}`);
  if (url.pathname !== this.config.statusPath && !this.verifyAuth(req)) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }
  // ... 后续原有逻辑
}
```

### Step 5：单元测试

- 测试 body 超过 1MB 时被拒绝
- 测试无 Authorization 头时返回 401
- 测试错误 Bearer token 时返回 401
- 测试连续请求触发 429

---

## Task 4：企业微信适配器安全修复

> **文件：** `src/channels/adapters/wechat-work.ts`（221 行）

### Step 1：修复 timing-unsafe 比较（约第 90 行）

将：
```typescript
return expected === signature;
```

改为：
```typescript
import { timingSafeEqual } from 'crypto';

const expectedBuf = Buffer.from(expected, 'hex');
const signatureBuf = Buffer.from(signature, 'hex');
if (expectedBuf.length !== signatureBuf.length) return false;
return timingSafeEqual(expectedBuf, signatureBuf);
```

### Step 2：修复 credential-in-URL（约第 172 行）

将：
```typescript
const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`;
const response = await fetch(url);
```

改为使用 POST + body（企业微信官方 API 支持 POST 方式获取 token）：

```typescript
const url = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
const params = new URLSearchParams({ corpid: corpId, corpsecret: corpSecret });
const response = await fetch(`${url}?${params.toString()}`, {
  // 如果企业微信不支持 POST 获取 token，则至少做到：
  // 1. 不在日志中打印完整 URL
  // 2. 使用 logger 时脱敏
});
```

> **执行人注意：** 企业微信的 `gettoken` 接口官方只支持 GET。所以无法完全避免 URL 参数。退而求其次：确保 logger 不记录含 corpSecret 的 URL。在 refreshAccessToken 方法入口添加：`logger.debug('Refreshing access token for corpId: ***');` 而不是记录完整 URL。

### Step 3：修复 token 未配置时的静默跳过（约第 81 行）

将：
```typescript
if (!token) return true; // 未配置 token 时跳过验证（开发模式）
```

改为：
```typescript
if (!token) {
  logger.warn('WeChatWork webhook token not configured — signature verification disabled');
  return true;
}
```

> 至少加一条 warn 日志，让运维知道签名验证被跳过了。

### Step 4：单元测试

- 测试 timingSafeEqual 替换后，正确签名仍通过
- 测试错误签名被拒绝
- 测试 token 未配置时有 warn 日志

---

## Task 5：中文 Token 估算修正 + console.log 清理 + splash.ts

### Step 1：创建通用估算函数

**文件：** 创建 `src/utils/token-estimate.ts`

```typescript
// src/utils/token-estimate.ts
// 中文感知的 Token 估算

/**
 * 估算文本的 token 数量（中文感知）
 * - CJK 字符（中日韩统一表意文字）：每字约 1.5 token
 * - 其他字符（英文/数字/标点）：每 4 字符约 1 token
 */
export function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 1.5 + otherChars / 4);
}
```

### Step 2：替换三处旧估算

需要替换的位置（已验证）：

1. `src/channels/message-router.ts` 约第 72 行：`Math.ceil(text.length / 4)` → `estimateTokens(text)`
2. `src/cli/App.tsx` 约第 598 行：同上
3. `src/cli/App.tsx` 约第 1460 行：同上

> 每处都需要 `import { estimateTokens } from '../utils/token-estimate.js';`（路径按实际调整）。

### Step 3：清理 console.log

`src/cli/App.tsx` 第 1246 行：

将 `console.log('\n再见！');` 改为 `logger.info('Session ended — goodbye');`

> 注意：如果 quit 命令通过 CommandBridge.exit() 处理，这行代码会在 Task 7 删除 switch 块时一并删除。但如果其他地方还有 console.log，也一并替换为 logger 调用。

### Step 4：创建 `src/cli/splash.ts`

```typescript
// src/cli/splash.ts
// CLI 启动画面

import chalk from 'chalk';

export interface SplashInfo {
  version: string;
  modelCount: number;
  readyModels: number;
  channelsEnabled: string[];
  projectPath?: string;
}

export function renderSplash(info: SplashInfo): string {
  const lines = [
    '',
    chalk.cyan('  ╔═══════════════════════════════════╗'),
    chalk.cyan('  ║') + chalk.bold.white('        RouteDev CLI') + chalk.cyan('                ║'),
    chalk.cyan('  ║') + chalk.gray(`          v${info.version}`) + chalk.cyan('                 ║'),
    chalk.cyan('  ╚═══════════════════════════════════╝'),
    '',
    `  模型: ${info.readyModels}/${info.modelCount} 就绪`,
    info.channelsEnabled.length > 0
      ? `  渠道: ${info.channelsEnabled.join(', ')}`
      : '  渠道: 无',
    info.projectPath ? `  项目: ${info.projectPath}` : '',
    '',
    chalk.gray('  输入 /help 查看可用命令'),
    '',
  ];
  return lines.filter(l => l !== '').join('\n');
}
```

### Step 5：在 App.tsx 启动时显示 splash

在 App 组件的 `useEffect`（初始化阶段）中，调用 `renderSplash` 并作为第一条系统消息加入 `messages`。

### Step 6：单元测试

- `estimateTokens` 测试：纯英文、纯中文、混合文本、空字符串
- `renderSplash` 测试：输出格式包含版本号

---

## Task 6：vision.ts 路径遍历修复 + branch.ts 状态一致性修复

### Step 1：修复 vision.ts loadImage 路径遍历（约第 110-140 行）

在 `loadImage` 方法中，`path.resolve(filePath)` 之后添加边界检查：

```typescript
static async loadImage(filePath: string, projectRoot?: string): Promise<ImageInput | null> {
  try {
    const absolutePath = path.resolve(filePath);

    // 路径边界检查：确保文件在项目目录内
    const allowedRoot = projectRoot || process.cwd();
    const normalizedPath = path.normalize(absolutePath);
    const normalizedRoot = path.normalize(path.resolve(allowedRoot));
    if (!normalizedPath.startsWith(normalizedRoot + path.sep) && normalizedPath !== normalizedRoot) {
      logger.warn(`Path traversal blocked: ${filePath} resolves outside project root`);
      return null;
    }

    const buffer = await fs.readFile(absolutePath);
    // ... 原有逻辑
  }
}
```

> **执行人注意：** `loadImage` 的调用方需要传入 `projectRoot` 参数。请在 App.tsx 中调用 `VisionAssistant.loadImage` 时传入当前工作目录。如果 `loadImage` 是静态方法，检查所有调用点并补充参数。

### Step 2：修复 branch.ts append 状态不一致（约第 129-162 行）

当前问题：每次 `append` 都删除旧的 BranchInfo 并以新节点 ID 为 key 重建，导致分支 ID 不稳定。

修复方案：让 BranchInfo 的 key 保持为分支创建时的 ID（来自 fork 或初始创建），`append` 只更新 BranchInfo 内的 `tipNodeId` 字段。

```typescript
// 修改 BranchInfo 类型：新增 tipNodeId 字段
export interface BranchInfo {
  id: string;           // 稳定的分支 ID（不随 append 变化）
  name: string;
  tipNodeId: string;    // 当前分支末端的节点 ID
  messageCount: number;
  isActive: boolean;
  createdAt: number;
}

// 修改 append 方法
append(message: LLMMessage): string {
  const id = this.generateId();
  const parentId = this.activeBranchId;
  const node: BranchNode = { id, parentId, message, children: [], timestamp: Date.now() };
  this.nodes.set(id, node);

  if (parentId) {
    const parent = this.nodes.get(parentId);
    if (parent) parent.children.push(id);
  }

  // 找到当前活跃分支，只更新 tipNodeId（不删除/重建分支条目）
  if (this.activeBranchKey) {
    const branch = this.branches.get(this.activeBranchKey);
    if (branch) {
      branch.tipNodeId = id;
      branch.messageCount = this.getPathLength(id);
    }
  }

  this.activeBranchId = id;
  return id;
}
```

> **执行人注意：** 这需要引入一个 `activeBranchKey` 字段来追踪当前分支的稳定 key（区别于 `activeBranchId` 追踪的是当前节点 ID）。`fork()` 创建新分支时用新 ID 作为 key 并设 `activeBranchKey`。`append()` 只更新 `tipNodeId` 而不碰 branches map 的 key。请仔细阅读现有 `fork()` 和 `switchBranch()` 逻辑后做最小改动。

### Step 3：修复 historyNodeIds 不更新问题

在 `append` 方法末尾追加：

```typescript
this.historyNodeIds.push(id);
```

这样 `editByHistoryIndex` 就能对后续追加的消息也生效。

### Step 4：单元测试

- `loadImage`：传入 `../../etc/passwd` 路径，验证返回 null
- `loadImage`：传入项目内合法路径，验证正常返回
- `branch.append`：连续 append 两次，验证 branch ID 不变
- `branch.append` 后 `editByHistoryIndex`：验证能编辑后续追加的消息

---

## Task 7：App.tsx 最终瘦身

> **目标：** 从 1548 行缩减到 ≤ 400 行。
> **前提：** Task 1-6 已完成，所有命令已迁移到独立文件。

### Step 1：删除旧 switch 块

删除 `handleSubmit` / `handleCommand` 回调中的整个 `switch (cmd)` 块（约第 674-1256 行）。

替换为：

```typescript
// 所有命令都通过 CommandRegistry 处理
const result = await commandRegistryRef.current.execute(text, ctx);
if (result.type === 'handled') {
  if (result.messages) {
    for (const content of result.messages) {
      if (content === '__CLEAR__') {
        // clearChat 已经通过 CommandBridge 处理了
      } else {
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content }]);
      }
    }
  }
  return;
}

// 非命令输入 → 走 Agent Loop
// ... 原有的 agent loop 调用逻辑
```

> **执行人注意：** 当前 App.tsx 有两层：先 `commandRegistry.execute()`（第 650 行），如果不 match 就走 switch 块（第 674 行）。删除 switch 后，CommandRegistry 的 `passthrough` 结果直接进入 Agent Loop（即正常的聊天逻辑）。

### Step 2：精简 imports

删除 App.tsx 中不再需要的 import。以下 import 应该已经搬到各命令文件中：

- `GoalParser`, `GoalVerifier`, `GoalPlan`（→ goal.ts）
- `CheckpointWriter`, `CheckpointManager`（→ checkpoint.ts, rollback.ts）
- `BranchManager` 的类型引用可保留（App 仍需创建实例），但分支操作逻辑已搬走
- `InitAnalyzer`, `DreamConsolidator`（→ init.ts, dream.ts）
- `VisionAssistant`, `ImageInput`（如果只在 vision 命令中使用）

保留的 import：
- React / Ink 相关
- `ChatView`, `StatusBar`, `InputBox`
- `CommandRegistry` 及所有命令定义
- `ServiceContext`, `CommandBridge`
- `ReActAgentLoop`, `ReActEvent`
- `LLMClientManager`, `ScenarioClassifier`, `ModelRouter`, `TokenTracker`
- `AppConfig`, `AutonomyMode`
- `logger`
- 创建实例所需的类（`ToolRegistry`, `SecurityChecker` 等）

### Step 3：确认 StatusBar 传入 6 个 props

```tsx
<StatusBar
  currentModel={currentModel}
  currentTier={currentTier}
  isDegraded={isDegraded}
  todayTokensUsed={todayTokensUsed}
  autonomyMode={autonomyMode}
  workMode={workMode}
/>
```

### Step 4：验证 App.tsx 行数

```bash
wc -l src/cli/App.tsx
```

目标 ≤ 400 行。如果超过 400 行，检查是否还有可以提取到独立模块的逻辑（比如 Agent Loop 事件处理可以提取为 `src/cli/chat-runner.ts`）。

### Step 5：全量功能回归测试

逐一测试所有 18 个命令，确保：
1. 每个命令都能通过 CommandRegistry 正确路由
2. 命令的 UI 副作用（消息显示、模式切换、清屏等）正常工作
3. 非命令输入正常进入 Agent Loop
4. `/quit` 正常退出

---

## Task 8：Agent Middleware Pipeline（借鉴 AgentScope 2.0）

> **来源：** AgentScope 2.0 的五阶段中间件管线（onAgent → onReasoning → onActing → onModelCall → onSystemPrompt）
> **价值：** 让 Agent Loop 的每个阶段都可以被拦截和扩展，不用修改核心代码就能加入日志、限流、审计等功能。

### Step 1：创建 `src/agent/middleware.ts`

```typescript
// src/agent/middleware.ts
// Agent 中间件管线（借鉴 AgentScope 2.0 五阶段模型）

import type { ReActEvent } from './loop-config.js';
import type { LLMMessage, LLMToolDefinition } from '../router/types.js';

/** 中间件可拦截的五个阶段 */
export type MiddlewarePhase =
  | 'onAgent'        // Agent 启动时（进入 ReAct 循环前）
  | 'onReasoning'    // 每次 LLM 推理前
  | 'onActing'       // 每次工具调用前
  | 'onModelCall'    // LLM API 调用时（可替换/缓存）
  | 'onSystemPrompt'; // 系统提示词生成时

/** 中间件上下文 */
export interface MiddlewareContext {
  phase: MiddlewarePhase;
  messages?: LLMMessage[];
  toolDefinitions?: LLMToolDefinition[];
  systemPrompt?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** 中间件处理器 */
export type MiddlewareHandler = (
  ctx: MiddlewareContext,
  next: () => Promise<void>,
) => Promise<void>;

/** 中间件注册与管理 */
export class AgentMiddlewarePipeline {
  private handlers = new Map<MiddlewarePhase, MiddlewareHandler[]>();

  register(phase: MiddlewarePhase, handler: MiddlewareHandler): void {
    const list = this.handlers.get(phase) || [];
    list.push(handler);
    this.handlers.set(phase, list);
  }

  async execute(phase: MiddlewarePhase, ctx: MiddlewareContext): Promise<void> {
    const handlers = this.handlers.get(phase) || [];
    let index = 0;
    const next = async (): Promise<void> => {
      if (index < handlers.length) {
        const handler = handlers[index++];
        await handler(ctx, next);
      }
    };
    await next();
  }
}
```

### Step 2：在 ReActAgentLoop 中集成中间件

在 `src/agent/loop.ts` 的 `run()` 方法中，在关键节点调用 `middleware.execute()`：

- 进入 ReAct 循环前：`middleware.execute('onAgent', { phase: 'onAgent', messages })`
- 调用 LLM 前：`middleware.execute('onReasoning', { phase: 'onReasoning', messages })`
- 调用工具前：`middleware.execute('onActing', { phase: 'onActing', toolName, toolArgs })`

> **执行人注意：** 中间件是可选的。如果 `config.middleware` 不存在，跳过调用。不要为中间件改动核心 ReAct 逻辑，只在调用前后插入钩子。

### Step 3：单元测试

- 测试中间件按注册顺序执行
- 测试 `next()` 不调用时管线中止
- 测试五个阶段都能正确触发

---

## Task 9：Structured Tool Response（借鉴 AgentScope 2.0）

> **来源：** AgentScope 的 ToolResponse 模式——工具永远不崩溃，失败返回结构化错误让 LLM 自行推理。
> **价值：** 防止单个工具的异常导致整个 Agent 循环崩溃。

### Step 1：修改 `src/tools/types.ts`，添加 ToolResponse 类型

```typescript
// 在 src/tools/types.ts 中新增

/** 工具执行的结构化响应（工具永远不 throw，失败通过 isError 标记） */
export interface ToolResponse {
  /** 响应文本（成功时的结果 / 失败时的错误描述） */
  content: string;
  /** 是否为错误 */
  isError: boolean;
  /** 可选的结构化数据（供后续工具链使用） */
  metadata?: Record<string, unknown>;
}
```

### Step 2：修改 ToolExecutor.execute() 包装异常

在 `src/tools/executor.ts` 中，确保所有工具执行都被 try-catch 包裹，异常转为 `ToolResponse { content: error.message, isError: true }`。

```typescript
// 修改 ToolExecutor.execute 的异常处理
async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResponse> {
  try {
    // ... 原有逻辑
    const result = await tool.execute(args);
    return { content: result, isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Tool ${toolName} failed: ${message}`);
    return { content: `[工具执行失败: ${toolName}] ${message}`, isError: true };
  }
}
```

### Step 3：在 ReAct Loop 中处理 isError 响应

在 `src/agent/loop.ts` 中，当工具返回 `isError: true` 时，将错误信息作为 observation 注入上下文，让 LLM 自行决定重试还是跳过——而不是中断 Agent 循环。

### Step 4：单元测试

- 测试工具抛出异常时返回 `isError: true`
- 测试工具正常返回时 `isError: false`
- 测试 Agent Loop 在收到 `isError: true` 后继续执行

---

## Task 10：Stall Detection 子进程活性监控（借鉴 architect-loop）

> **来源：** architect-loop 的 15 分钟活性检测——监控子进程 stdout 时间戳，超时则 kill 特定 PID。
> **价值：** 防止 shell_exec 或 MCP 子进程卡死时无人知晓。

### Step 1：创建 `src/utils/stall-detector.ts`

```typescript
// src/utils/stall-detector.ts
// 子进程活性检测器（借鉴 architect-loop 的 liveness monitoring）

import { logger } from './logger.js';

export interface StallDetectorConfig {
  /** 静默超时（毫秒），超过此时间无输出视为卡死 */
  stallTimeoutMs: number;
  /** 检测间隔（毫秒） */
  checkIntervalMs: number;
  /** 卡死时的回调 */
  onStall: (pid: number) => void;
}

export class StallDetector {
  private lastActivity = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: StallDetectorConfig;

  constructor(config: StallDetectorConfig) {
    this.config = config;
  }

  /** 注册一个需要监控的进程 */
  register(pid: number): void {
    this.lastActivity.set(pid, Date.now());
  }

  /** 报告进程有活动（收到 stdout/stderr） */
  reportActivity(pid: number): void {
    this.lastActivity.set(pid, Date.now());
  }

  /** 注销进程 */
  unregister(pid: number): void {
    this.lastActivity.delete(pid);
  }

  /** 启动定期检测 */
  start(): void {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [pid, lastTime] of this.lastActivity.entries()) {
        if (now - lastTime > this.config.stallTimeoutMs) {
          logger.warn(`Process ${pid} stalled (no activity for ${this.config.stallTimeoutMs}ms)`);
          this.config.onStall(pid);
          this.lastActivity.delete(pid);
        }
      }
    }, this.config.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

### Step 2：集成到 shell_exec 工具

在 `src/tools/builtin/shell-exec.ts` 中，子进程 spawn 后注册到 StallDetector，收到 stdout/stderr 时调用 `reportActivity`，退出时 `unregister`。

### Step 3：单元测试

- 测试超时后触发 onStall 回调
- 测试持续有输出时不触发
- 测试 unregister 后不再检测

---

## Task 11：Handoff File 结构化交接文件（借鉴 architect-loop）

> **来源：** architect-loop 的 HANDOFF.md 模式——结构化的跨会话记忆，要求 2 分钟内可读完。
> **价值：** 解决 Agent 跨会话/跨 Phase 的状态传递问题，不依赖外部数据库。

### Step 1：创建 `src/agent/handoff.ts`

```typescript
// src/agent/handoff.ts
// 结构化交接文件（借鉴 architect-loop HANDOFF.md 模式）

import fs from 'node:fs/promises';
import path from 'node:path';

export interface HandoffData {
  /** 当前目标 */
  currentGoal: string;
  /** 已完成的步骤 */
  completedSteps: string[];
  /** 下一步行动 */
  nextAction: string;
  /** 关键约束/发现 */
  constraints: string[];
  /** 当前工作文件列表 */
  workingFiles: string[];
  /** 未解决的问题 */
  openQuestions: string[];
  /** 时间戳 */
  timestamp: number;
}

/** 生成交接文件 */
export function renderHandoff(data: HandoffData): string {
  const lines = [
    `# Handoff — ${new Date(data.timestamp).toISOString()}`,
    '',
    `## 当前目标`,
    data.currentGoal,
    '',
    `## 已完成`,
    ...data.completedSteps.map(s => `- ${s}`),
    '',
    `## 下一步`,
    data.nextAction,
    '',
    `## 约束与发现`,
    ...data.constraints.map(c => `- ${c}`),
    '',
    `## 工作文件`,
    ...data.workingFiles.map(f => `- ${f}`),
    '',
    `## 未解决问题`,
    ...data.openQuestions.map(q => `- ${q}`),
  ];
  return lines.join('\n');
}

/** 保存交接文件 */
export async function saveHandoff(data: HandoffData, dir: string): Promise<string> {
  const filePath = path.join(dir, 'HANDOFF.md');
  await fs.writeFile(filePath, renderHandoff(data), 'utf-8');
  return filePath;
}
```

### Step 2：集成到 /goal 和 CheckpointWriter

- `/goal` 命令在目标分解后生成初始 HANDOFF.md
- `CheckpointWriter` 在写入检查点时同步更新 HANDOFF.md
- App 退出前（quit 命令）保存最终 HANDOFF.md

### Step 3：单元测试

- 测试 renderHandoff 输出格式包含所有章节
- 测试 saveHandoff 写入文件成功

---

## 验收标准

1. **App.tsx ≤ 400 行**，且无 switch 块
2. **WebhookServer** 有 rate limit + Bearer auth + body 限制，对应测试通过
3. **企业微信**：timingSafeEqual + URL 脱敏日志 + token 未配置警告
4. **中文 token 估算**：`estimateTokens` 函数替代所有 `Math.ceil(text.length / 4)`
5. **/cost** 和 **/history** 命令可用
6. **splash.ts** 启动画面渲染
7. **vision.ts** 路径遍历被拦截（测试通过）
8. **branch.ts** append 后 branch ID 稳定（测试通过）
9. **所有 console.log 替换为 logger**
10. **Agent Middleware Pipeline** 五阶段中间件可用（测试通过）
11. **Structured Tool Response** 工具异常不崩溃 Agent Loop（测试通过）
12. **StallDetector** 子进程超时检测可用（测试通过）
13. **Handoff File** 交接文件生成与保存（测试通过）
14. **新增测试 ≥ 30 个**，全部通过

---

## 补充说明（来自新执行人 Phase 0 审查报告）

新执行人（GLM 5.2）在开工前做了一次全量审查（见 `EXECUTION_REPORTS.md` Phase 0），发现以下额外项，执行人在 Phase 17b 执行过程中一并处理：

**A. Windows checkpoint 测试超时**（`tests/harness/checkpoint.test.ts`）：`should prune checkpoints beyond maxCheckpoints` 用例在 Windows 上因 EBUSY 文件锁 + 5s 超时失败。修复方式：给该测试加 `testTimeout: 15000` 或改用 `os.tmpdir()` 子目录。非阻塞，顺手修。

**B. `src/agent/executor.ts` 是 NoOpToolExecutor 空桩**：当前只是一个占位实现。如果 Phase 17b 的 Task 9（Structured Tool Response）涉及 `ToolExecutor`，请确认该文件的实际角色——它可能被 `ToolRegistryAdapter` 替代了。如果确认是死代码，清理掉；如果仍在使用，按 Task 9 要求包装异常处理。

**C. 版本号不一致**：`package.json` 为 0.4.0，`src/cli/args.ts` 打印 0.14.0。Phase 17b 不要求修版本号（留给 Phase 23），但执行人应知晓此差异，不要误以为版本是 0.14.0。
