# Phase 17：App.tsx 重构 + 关键缺陷修复

**回应**：V1 蓝图审视报告

| # | 审视项 | 处理 |
|---|--------|------|
| 缺陷 #1 | App.tsx:108 `clientManager.listAll()` 每次渲染重新计算 + undefined 强转 | **Task 1 核心**：移入 useMemo / useServiceContext |
| 缺陷 #4 | vision.ts:112 path traversal（loadImage 无边界检查） | **Task 6**：添加 SecurityChecker 路径校验 |
| 缺陷 #5 | branch.ts:146 append 状态不一致 | **Task 7**：修复 append 在 parentId 非 tip 时的分支映射 |
| UX #1 | /help 列表过短，大量新命令未列入 | **Task 4**：命令注册时自动收集帮助文本 |
| 架构 | 1450 行 God Component，19 useRef，40 import，588 行 switch | **Task 1-5 核心**：全面拆分 |

---

**目标**：将 App.tsx 从 1450 行的 God Component 拆分为模块化架构——服务容器（useServiceContext）、命令注册表（CommandRegistry）、独立命令处理器。同时修复 3 个高风险缺陷。

**前置依赖**：Phase 14-16（多 Agent + 可观测性 + Prompt 模板——它们的 ref 和逻辑也需要迁移到新架构中）

---

## 架构说明

App.tsx 当前承担了三重角色：服务容器（19 个 useRef 初始化各种 Manager）、命令分发器（588 行 switch 块处理 17 个命令）、UI 渲染（JSX 输出）。这就像一个人既是 CEO 又是前台又是清洁工——需要把职责分开。

重构后的分工：

```
重构前（App.tsx 1450 行）：
┌─────────────────────────────────────┐
│  App.tsx                            │
│  ├─ 19 useRef（服务容器）            │
│  ├─ handleSubmit（306 行主循环）     │
│  ├─ handleCommand（588 行命令分发）  │
│  ├─ handleGoalCommand + executePlan │
│  └─ JSX（~100 行 UI 输出）          │
└─────────────────────────────────────┘

重构后：
┌─────────────────────────────────────┐
│  App.tsx（~250 行，纯 UI 编排）     │
│  ├─ useServiceContext() 获取服务    │
│  ├─ useCommandHandlers() 获取命令  │
│  ├─ handleSubmit() 精简为路由调度   │
│  └─ JSX 不变                        │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  service-context.ts（~200 行）      │
│  useServiceContext() custom hook    │
│  ├─ 创建/持有 19 个 ref             │
│  ├─ 初始化逻辑（工具注册、权限）    │
│  ├─ 清理逻辑（SIGINT、unmount）    │
│  └─ 返回服务对象                    │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  commands/ 目录（5 个文件）         │
│  ├─ system.ts    — help/status/clear/quit/auto/semi/manual  │
│  ├─ memory.ts    — memory/checkpoint/rollback/dream/init   │
│  ├─ branch.ts    — branch list/edit/switch                  │
│  ├─ goal.ts      — goal + executeGoalPlan                   │
│  └─ channels.ts  — channels list/port                       │
│                                                         │
│  command-registry.ts — 注册表 + 自动帮助文本收集          │
└─────────────────────────────────────┘
```

**关键约束**：
- 重构不改变任何行为——所有命令的输入输出完全不变
- App.tsx 目标：300 行以内（含 JSX）
- 每个命令处理器是纯函数或简单类，接收 ServiceContext 作为参数
- CommandRegistry 提供 `getHelpText()` 自动从已注册命令生成 /help 输出
- SIGINT handler 在 service-context 中注册，优雅关闭所有资源

---

## 具体任务

### Task 1：ServiceContext 提取

**文件：** 创建 `src/cli/service-context.ts`

把 App.tsx 的 19 个 useRef + 初始化逻辑提取为一个 custom hook。

- [ ] **Step 1：定义 ServiceContext 接口和 hook**

```typescript
// src/cli/service-context.ts
// 服务容器 Hook：集中管理所有 Manager/Service 实例
// 从 App.tsx 的 19 个 useRef 中提取

import { useRef, useEffect, useMemo, useCallback } from 'react';
import type { ILLMClient, LLMMessage } from '../router/types.js';
import type { AppConfig, AutonomyMode } from '../config/schema.js';
import { LLMClientManager } from '../router/llm/index.js';
import { ScenarioClassifier } from '../router/classifier.js';
import { ModelRouter } from '../router/router.js';
import { TokenTracker } from '../router/tracker.js';
import { ReActAgentLoop } from '../agent/loop.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { SecurityChecker } from '../tools/security.js';
import { ToolRegistryAdapter } from '../tools/adapter.js';
import { PermissionChecker } from '../tools/permission.js';
import { MCPClientManager } from '../tools/mcp/client.js';
import { CheckpointManager } from '../harness/checkpoint-manager.js';
import { CheckpointWriter } from '../agent/memory/checkpoint-writer.js';
import { ContextManager } from '../agent/memory/context-manager.js';
import { VisionAssistant } from '../agent/vision.js';
import { BranchManager } from '../agent/branch.js';
import { InitAnalyzer } from '../agent/init-analyzer.js';
import { DreamConsolidator } from '../agent/dream-consolidator.js';
import { GoalParser } from '../agent/goal-parser.js';
import { GoalVerifier } from '../agent/goal-verifier.js';
import { logger } from '../utils/logger.js';
import { getSystemPrompt } from '../agent/prompts.js';
// 工具导入（与 App.tsx 现有导入一致）
import { FileReadTool } from '../tools/builtin/file-read.js';
import { FileWriteTool } from '../tools/builtin/file-write.js';
import { FileSearchTool } from '../tools/builtin/file-search.js';
import { ShellExecTool } from '../tools/builtin/shell-exec.js';
import { GitOpTool } from '../tools/builtin/git-op.js';
import { WebSearchTool } from '../tools/builtin/web-search.js';
import { CodeSearchTool } from '../tools/builtin/code-search.js';

/** 服务容器——所有 Manager/Service 实例的集合 */
export interface ServiceContext {
  // 路由层
  clientManager: LLMClientManager;
  classifier: ScenarioClassifier;
  modelRouter: ModelRouter;
  tracker: TokenTracker;

  // Agent 层
  agentLoop: ReActAgentLoop;
  goalParser: GoalParser;
  goalVerifier: GoalVerifier;

  // 工具层
  registry: ToolRegistry;
  toolExecutor: ToolExecutor;
  securityChecker: SecurityChecker;
  permissionChecker: PermissionChecker;
  adapter: ToolRegistryAdapter;
  mcpManager: MCPClientManager;

  // 记忆层
  checkpointManager: CheckpointManager;
  writer: CheckpointWriter;
  contextManager: ContextManager;

  // 辅助层
  visionAssistant: VisionAssistant;
  branchManager: BranchManager;
  initAnalyzer: InitAnalyzer | null;
  dreamConsolidator: DreamConsolidator;

  // 运行时状态 refs（可变引用）
  conversationHistory: React.MutableRefObject<LLMMessage[]>;
  pendingConfirm: React.MutableRefObject<{ resolve: (v: boolean) => void; toolName: string } | null>;
  awaitingGoalConfirm: React.MutableRefObject<{ resolve: (v: boolean) => void; plan: any } | null>;
  currentPlan: React.MutableRefObject<any | null>;
  abortController: React.MutableRefObject<AbortController | null>;

  // 配置
  config: AppConfig;
  systemPrompt: string;
}

/**
 * useServiceContext — 创建并持有所有服务实例
 * 等价于 App.tsx 中原有的 19 个 useRef + 初始化 useEffect
 */
export function useServiceContext(config: AppConfig): ServiceContext {
  // ===== 路由层 =====
  const clientManager = useMemo(() => {
    const cm = new LLMClientManager();
    for (const provider of config.providers) {
      cm.registerProvider(provider);
    }
    return cm;
  }, []);

  const classifier = useMemo(
    () => new ScenarioClassifier(config.router.classifierModel),
    [],
  );
  const modelRouter = useMemo(
    () => new ModelRouter(config.router, clientManager),
    [],
  );
  const tracker = useMemo(
    () => new TokenTracker(config.router.budget),
    [],
  );

  // ===== 工具层 =====
  const registry = useRef(new ToolRegistry()).current;
  const securityChecker = useRef(
    new SecurityChecker(config.security),
  ).current;
  const permissionChecker = useRef(
    new PermissionChecker(config.autonomy),
  ).current;
  const toolExecutor = useRef(new ToolExecutor(registry, securityChecker, permissionChecker)).current;
  const adapter = useRef(new ToolRegistryAdapter(registry)).current;
  const mcpManager = useRef(new MCPClientManager(config.mcp)).current;

  // 工具注册（从 App.tsx 搬过来的 7 个 register 调用）
  useEffect(() => {
    registry.register(new FileReadTool());
    registry.register(new FileWriteTool());
    registry.register(new FileSearchTool());
    registry.register(new ShellExecTool());
    registry.register(new GitOpTool());
    registry.register(new WebSearchTool());
    registry.register(new CodeSearchTool());

    // 权限规则（从 App.tsx 搬过来的 5 个 addRule 调用）
    permissionChecker.addRule('file_write', 'confirm');
    permissionChecker.addRule('file_delete', 'confirm');
    permissionChecker.addRule('shell_exec', 'confirm');
    permissionChecker.addRule('git_op', 'auto');
    permissionChecker.addRule('web_search', 'auto');
  }, []);

  // ===== Agent 层 =====
  const agentLoop = useRef(new ReActAgentLoop(adapter, {
    maxIterations: 10,
    toolsEnabled: true,
  })).current;
  const goalParser = useRef(new GoalParser()).current;
  const goalVerifier = useRef(new GoalVerifier(config.goalVerifier)).current;

  // ===== 记忆层 =====
  const checkpointManager = useRef(new CheckpointManager(process.cwd())).current;

  // 【修复缺陷 #1】fallbackClient 用 useMemo 而非每次渲染计算
  const fallbackClient: ILLMClient | undefined = useMemo(() => {
    const first = clientManager.listAll().values().next().value;
    return first ?? undefined; // 不再 as ILLMClient 强转
  }, []);

  const checkpointClient: ILLMClient | undefined = useMemo(() => {
    const provider = config.checkpoint.modelId
      ? clientManager.get(config.checkpoint.modelId)
      : undefined;
    return provider ?? fallbackClient;
  }, []);

  const writer = useRef(new CheckpointWriter(checkpointClient!)).current;
  const contextManager = useRef(new ContextManager(config.checkpoint)).current;

  // ===== 辅助层 =====
  const visionAssistant = useRef(new VisionAssistant(clientManager)).current;
  const branchManager = useRef(new BranchManager()).current;
  const initAnalyzer = useRef<InitAnalyzer | null>(null).current;
  const dreamConsolidator = useRef(new DreamConsolidator(checkpointClient!)).current;

  // ===== 运行时状态 refs =====
  const conversationHistory = useRef<LLMMessage[]>([]);
  const pendingConfirm = useRef<
    { resolve: (v: boolean) => void; toolName: string } | null
  >(null);
  const awaitingGoalConfirm = useRef<
    { resolve: (v: boolean) => void; plan: any } | null
  >(null);
  const currentPlan = useRef<any | null>(null);
  const abortController = useRef<AbortController | null>(null);

  // ===== 系统 Prompt =====
  const systemPrompt = useMemo(
    () => getSystemPrompt(config.general.language),
    [config.general.language],
  );

  // ===== 清理逻辑 =====
  useEffect(() => {
    return () => {
      mcpManager.disconnectAll().catch(() => {});
    };
  }, []);

  // 【新增】SIGINT/SIGTERM 优雅退出
  useEffect(() => {
    const cleanup = () => {
      logger.info('Received shutdown signal, cleaning up...');
      abortController.current?.abort();
      mcpManager.disconnectAll().catch(() => {});
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    return () => {
      process.off('SIGINT', cleanup);
      process.off('SIGTERM', cleanup);
    };
  }, []);

  return {
    clientManager, classifier, modelRouter, tracker,
    agentLoop, goalParser, goalVerifier,
    registry, toolExecutor, securityChecker, permissionChecker, adapter, mcpManager,
    checkpointManager, writer, contextManager,
    visionAssistant, branchManager, initAnalyzer, dreamConsolidator,
    conversationHistory, pendingConfirm, awaitingGoalConfirm, currentPlan, abortController,
    config, systemPrompt,
  };
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/service-context.ts
git commit -m "refactor(cli): extract ServiceContext hook from App.tsx (19 refs consolidated)"
```

---

### Task 2：CommandRegistry 命令注册表

**文件：** 创建 `src/cli/command-registry.ts`

用注册表模式替代 588 行的 switch 块。每个命令注册时提供：匹配规则、处理函数、帮助文本。

- [ ] **Step 1：实现 CommandRegistry**

```typescript
// src/cli/command-registry.ts
// 命令注册表：替代 App.tsx 中 588 行的 switch 块
// 每个命令是一个独立的处理器，注册时声明：名称、匹配模式、处理函数、帮助文本

import type { ServiceContext } from './service-context.js';

/** 命令处理器的输入 */
export interface CommandInput {
  /** 用户输入的原始文本（含 /command） */
  rawText: string;
  /** 拆分后的参数数组（['/goal', '描述']） */
  parts: string[];
  /** 服务容器 */
  services: ServiceContext;
  /** 追加系统消息到 UI */
  addSystemMessage: (content: string) => void;
  /** 设置处理状态 */
  setIsProcessing: (processing: boolean) => void;
  /** 获取当前消息列表（只读） */
  getMessages: () => ReadonlyArray<{ id: string; role: string; content: string }>;
}

/** 命令处理器函数 */
export type CommandHandler = (input: CommandInput) => Promise<void> | void;

/** 命令定义 */
export interface CommandDefinition {
  /** 命令名称（如 '/help', '/goal'） */
  name: string;
  /** 命令别名（如 '/exit' = '/quit'） */
  aliases?: string[];
  /** 简短描述（一行，用于 /help 列表） */
  description: string;
  /** 详细用法（用于 /help <command>） */
  usage?: string;
  /** 处理函数 */
  handler: CommandHandler;
}

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();
  private aliases = new Map<string, string>(); // alias → canonical name

  /** 注册一个命令 */
  register(def: CommandDefinition): void {
    this.commands.set(def.name, def);
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.aliases.set(alias, def.name);
      }
    }
  }

  /** 查找命令处理器 */
  resolve(text: string): CommandDefinition | null {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    if (!cmd) return null;

    // 直接匹配
    const direct = this.commands.get(cmd);
    if (direct) return direct;

    // 别名匹配
    const canonical = this.aliases.get(cmd);
    if (canonical) return this.commands.get(canonical) ?? null;

    return null;
  }

  /** 生成帮助文本（自动从已注册命令收集） */
  getHelpText(): string {
    const lines: string[] = ['可用命令：', ''];

    const sorted = [...this.commands.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const cmd of sorted) {
      const aliasStr = cmd.aliases?.length
        ? ` (别名: ${cmd.aliases.join(', ')})`
        : '';
      lines.push(`  ${cmd.name}${aliasStr} — ${cmd.description}`);
      if (cmd.usage) {
        lines.push(`    ${cmd.usage}`);
      }
    }

    return lines.join('\n');
  }

  /** 列出所有命令名（用于 Tab 补全等） */
  listNames(): string[] {
    const names = [...this.commands.keys()];
    for (const alias of this.aliases.keys()) {
      names.push(alias);
    }
    return names.sort();
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/command-registry.ts
git commit -m "refactor(cli): add CommandRegistry for modular command handling"
```

---

### Task 3：命令处理器拆分（5 个文件）

**文件：** 创建 `src/cli/commands/` 目录下的 5 个文件

每个文件导出一个注册函数，接收 ServiceContext 并返回 CommandDefinition 数组。

- [ ] **Step 1：`src/cli/commands/system.ts`** — 系统命令

从 App.tsx 提取：`/help`、`/status`、`/clear`、`/quit`（含 `/exit` 别名）、`/auto`、`/semi`、`/manual`。

关键点：
- `/help` 改为调用 `registry.getHelpText()` 自动输出
- `/status` 保持原有逻辑（显示模型、token、模式等）
- `/auto` `/semi` `/manual` 改为修改 `services.config.autonomy.defaultMode`
- `/quit` 和 `/exit` 共用处理器，添加 SIGINT 清理

```typescript
// 示意结构（执行人需从 App.tsx 复制完整逻辑）
export function createSystemCommands(registry: CommandRegistry): CommandDefinition[] {
  return [
    {
      name: '/help',
      description: '显示帮助信息',
      handler: (input) => {
        input.addSystemMessage(registry.getHelpText());
      },
    },
    {
      name: '/status',
      description: '显示当前状态（模型、Token、模式）',
      handler: (input) => { /* 从 App.tsx 搬过来的 /status 逻辑 */ },
    },
    {
      name: '/clear',
      description: '清空对话历史',
      handler: (input) => { /* ... */ },
    },
    {
      name: '/quit',
      aliases: ['/exit'],
      description: '退出 RouteDev',
      handler: (input) => { /* process.exit(0) */ },
    },
    {
      name: '/auto',
      description: '切换到全自动模式',
      handler: (input) => { /* ... */ },
    },
    {
      name: '/semi',
      description: '切换到半自动模式',
      handler: (input) => { /* ... */ },
    },
    {
      name: '/manual',
      description: '切换到手动模式',
      handler: (input) => { /* ... */ },
    },
  ];
}
```

- [ ] **Step 2：`src/cli/commands/memory.ts`** — 记忆命令

从 App.tsx 提取：`/memory`（show/notes/write/clear）、`/checkpoint`（create/list）、`/rollback`、`/dream`、`/init`。

```typescript
export function createMemoryCommands(
  commandRegistry: CommandRegistry,
): CommandDefinition[] {
  return [
    {
      name: '/memory',
      description: '查看/编辑项目记忆',
      usage: '/memory show|notes|write|clear',
      handler: (input) => {
        const subCmd = input.parts[1]?.toLowerCase();
        switch (subCmd) {
          case 'show': /* 搬自 App.tsx:835-860 */ break;
          case 'notes': /* 搬自 App.tsx:862-880 */ break;
          case 'write': /* 搬自 App.tsx:882-905 */ break;
          case 'clear': /* 搬自 App.tsx:907-925 */ break;
          default: /* 帮助文本 */ break;
        }
      },
    },
    {
      name: '/checkpoint',
      description: '管理检查点',
      usage: '/checkpoint create|list',
      handler: (input) => { /* 搬自 App.tsx:672-731 */ },
    },
    {
      name: '/rollback',
      description: '回滚到指定检查点',
      handler: (input) => { /* 搬自 App.tsx:733-796 */ },
    },
    {
      name: '/dream',
      description: '整理项目记忆（合并去重）',
      handler: (input) => { /* 搬自 App.tsx:1062-1087 */ },
    },
    {
      name: '/init',
      description: '分析项目结构生成 .routedev-rules.md',
      handler: (input) => { /* 搬自 App.tsx:1029-1060 */ },
    },
  ];
}
```

- [ ] **Step 3：`src/cli/commands/branch.ts`** — 分支命令

从 App.tsx 提取：`/branch`（list/edit/switch）。

- [ ] **Step 4：`src/cli/commands/goal.ts`** — 目标命令

从 App.tsx 提取：`/goal`、`handleGoalCommand`（73 行）、`executeGoalPlan`（190 行）。

这是最复杂的一个——`executeGoalPlan` 单独提取为一个导出函数：

```typescript
export async function executeGoalPlan(
  plan: GoalPlan,
  services: ServiceContext,
  addSystemMessage: (content: string) => void,
  setIsProcessing: (v: boolean) => void,
): Promise<void> {
  // 搬自 App.tsx:1237-1427 的完整逻辑
  // 注意：所有 ref 访问改为 services.xxx.current
}

export function createGoalCommands(
  commandRegistry: CommandRegistry,
): CommandDefinition[] {
  return [
    {
      name: '/goal',
      description: '设定并执行开发目标',
      usage: '/goal "目标描述"',
      handler: async (input) => {
        // 搬自 App.tsx handleGoalCommand (lines 1164-1236)
      },
    },
    {
      name: '/pause',
      description: '暂停当前目标执行',
      handler: (input) => { /* 搬自 App.tsx:650-670 */ },
    },
  ];
}
```

- [ ] **Step 5：`src/cli/commands/channels.ts`** — 渠道命令

从 App.tsx 提取：`/channels`（list/port）。

- [ ] **Step 6：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/commands/
git commit -m "refactor(cli): extract all command handlers into 5 modular files"
```

---

### Task 4：App.tsx 瘦身

**文件：** 修改 `src/cli/App.tsx`

用 useServiceContext + CommandRegistry 替代原有的 19 useRef + 588 行 switch。

- [ ] **Step 1：重写 App 组件**

```typescript
// src/cli/App.tsx（重写后 ~250 行）
// 瘦身为纯 UI 编排组件
// - 服务实例由 useServiceContext() 管理
// - 命令由 CommandRegistry 分发
// - handleSubmit 精简为核心聊天循环

import React, { useState, useCallback, useEffect } from 'react';
import { Box } from 'ink';
import { ChatView, type ChatMessage } from './components/ChatView.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import { useServiceContext } from './service-context.js';
import { CommandRegistry } from './command-registry.js';
import { createSystemCommands } from './commands/system.js';
import { createMemoryCommands } from './commands/memory.js';
import { createBranchCommands } from './commands/branch.js';
import { createGoalCommands, executeGoalPlan } from './commands/goal.js';
import { createChannelCommands } from './commands/channels.js';
import type { AppConfig } from '../config/schema.js';
import type { LLMMessage, ReActEvent } from '../router/types.js';
import type { ConfirmToolCallback } from '../agent/loop-config.js';
import type { GoalPlan } from '../agent/goal-types.js';
import { logger } from '../utils/logger.js';

interface AppProps {
  config: AppConfig;
}

let msgId = 0;
const nextId = () => String(++msgId);

export function App({ config }: AppProps) {
  // 服务容器（替代原来的 19 个 useRef）
  const services = useServiceContext(config);

  // 命令注册表
  const commandRegistry = React.useMemo(() => {
    const reg = new CommandRegistry();
    for (const cmd of createSystemCommands(reg)) reg.register(cmd);
    for (const cmd of createMemoryCommands(reg)) reg.register(cmd);
    for (const cmd of createBranchCommands(reg)) reg.register(cmd);
    for (const cmd of createGoalCommands(reg)) reg.register(cmd);
    for (const cmd of createChannelCommands(reg)) reg.register(cmd);
    return reg;
  }, []);

  // UI 状态
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [todayTokensUsed, setTodayTokensUsed] = useState(0);

  // 辅助函数
  const addSystemMessage = useCallback((content: string) => {
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content,
    }]);
  }, []);

  // 工具确认回调
  const handleToolConfirm: ConfirmToolCallback = useCallback(
    async (toolName, args) => {
      return new Promise<boolean>((resolve) => {
        services.pendingConfirm.current = { resolve, toolName };
        addSystemMessage(
          `工具 ${toolName} 请求确认 (${JSON.stringify(args).slice(0, 80)})\n输入 y 确认 / n 拒绝`
        );
      });
    },
    [addSystemMessage],
  );

  // 主提交处理（精简后的核心循环）
  const handleSubmit = useCallback(
    async (text: string) => {
      // 1. 工具确认优先
      if (services.pendingConfirm.current) {
        const confirm = services.pendingConfirm.current;
        services.pendingConfirm.current = null;
        const approved = text.toLowerCase().trim() === 'y';
        confirm.resolve(approved);
        return;
      }

      // 2. Goal 确认优先
      if (services.awaitingGoalConfirm.current) {
        const confirm = services.awaitingGoalConfirm.current;
        services.awaitingGoalConfirm.current = null;
        const approved = text.toLowerCase().trim() === 'y';
        if (approved && confirm.plan) {
          services.currentPlan.current = confirm.plan;
          executeGoalPlan(
            confirm.plan,
            services,
            addSystemMessage,
            setIsProcessing,
          ).catch(err => {
            addSystemMessage(`目标执行失败: ${err.message}`);
            setIsProcessing(false);
          });
        }
        confirm.resolve(approved);
        return;
      }

      // 3. 添加用户消息
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'user' as const,
        content: text,
      }]);

      // 4. 斜杠命令分发
      if (text.startsWith('/')) {
        const cmd = commandRegistry.resolve(text);
        if (cmd) {
          await cmd.handler({
            rawText: text,
            parts: text.trim().split(/\s+/),
            services,
            addSystemMessage,
            setIsProcessing,
            getMessages: () => messages,
          });
          return;
        }
        addSystemMessage(`未知命令：${text.split(' ')[0]}`);
        return;
      }

      // 5. 核心聊天循环（从 App.tsx 原有 handleSubmit 搬过来）
      setIsProcessing(true);
      try {
        // 场景分类 → 路由 → 获取 LLM client
        const classification = await services.classifier.classify({ query: text });
        const routeDecision = await services.modelRouter.route(classification);
        const llmClient = services.clientManager.get(routeDecision.providerId);

        if (!llmClient) {
          addSystemMessage(`错误：未找到 provider ${routeDecision.providerId}`);
          return;
        }

        // 视觉处理（@image 引用）
        // ... 搬自原 handleSubmit:362-402 ...

        // 创建流式 assistant 消息
        const assistantMsgId = nextId();
        setMessages(prev => [...prev, {
          id: assistantMsgId,
          role: 'assistant' as const,
          content: '',
          isStreaming: true,
        }]);

        // ReAct 循环
        let fullContent = '';
        let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const abort = new AbortController();
        services.abortController.current = abort;

        for await (const event of services.agentLoop.run({
          userMessage: text,
          llmClient,
          routeDecision,
          conversationHistory: services.conversationHistory.current,
          systemPrompt: services.systemPrompt,
          signal: abort.signal,
          onConfirmTool: handleToolConfirm,
        })) {
          switch (event.type) {
            case 'text_delta':
              fullContent += event.text;
              setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: fullContent } : m
              ));
              break;
            case 'tool_call_start':
              addSystemMessage(`🔧 调用工具: ${event.toolName}`);
              break;
            case 'tool_call_result':
              if (event.isError) {
                addSystemMessage(`⚠️ 工具错误: ${event.result.slice(0, 200)}`);
              }
              break;
            case 'error':
              fullContent += `\n\n❌ 错误: ${event.error}`;
              break;
            case 'done':
              finalUsage = event.usage;
              fullContent = event.content || fullContent;
              break;
          }
        }

        // Token 追踪
        setTodayTokensUsed(prev => prev + finalUsage.totalTokens);
        services.tracker.record(finalUsage, {
          modelId: routeDecision.model.id,
          agentId: 'main',
        });

        // 更新对话历史
        services.conversationHistory.current.push(
          { role: 'user', content: text },
          { role: 'assistant', content: fullContent },
        );
        if (services.conversationHistory.current.length > 20) {
          services.conversationHistory.current =
            services.conversationHistory.current.slice(-20);
        }

        // 检查点 + 压缩
        // ... 搬自原 handleSubmit:497-541 ...

        // 结束流式
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId ? { ...m, isStreaming: false } : m
        ));
      } catch (error) {
        addSystemMessage(`错误: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsProcessing(false);
      }
    },
    [services, commandRegistry, handleToolConfirm, addSystemMessage, messages],
  );

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <ChatView messages={messages} />
      <StatusBar
        currentModel={routeDecision?.model.name ?? '-'}
        currentTier={routeDecision?.model.tier ?? 'simple'}
        isDegraded={routeDecision?.degraded ?? false}
        todayTokensUsed={todayTokensUsed}
        autonomyMode={config.autonomy.defaultMode}
        workMode="chat"
      />
      <InputBox onSubmit={handleSubmit} disabled={isProcessing} />
    </Box>
  );
}
```

注意：以上代码是架构示意。执行人实现时应逐段从原 App.tsx 搬移逻辑，确保行为完全一致。特别是视觉处理、检查点/压缩、Goal 确认等细节。

- [ ] **Step 2：删除原 handleCommand 和 handleGoalCommand**

确认所有命令逻辑已迁移到 `src/cli/commands/` 后，从 App.tsx 中删除：
- 原 handleCommand callback（lines 572-1159）
- 原 handleGoalCommand callback（lines 1164-1236）
- 原 executeGoalPlan callback（lines 1237-1427）

- [ ] **Step 3：验证 App.tsx 行数**

目标：App.tsx 应在 **250-350 行** 之间。如果超出，检查是否有遗漏的逻辑未迁移。

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
# 运行全量测试确保无行为变化
npx vitest run
git add src/cli/App.tsx src/cli/commands/ src/cli/service-context.ts src/cli/command-registry.ts
git commit -m "refactor(cli): slim App.tsx from 1450 to ~300 lines via ServiceContext + CommandRegistry"
```

---

### Task 5：handleSubmit 中的聊天循环提取

**文件：** 创建 `src/cli/chat-runner.ts`

handleSubmit 中的"核心聊天循环"（场景分类 → 路由 → ReAct 循环 → token 追踪 → 历史更新）提取为独立函数，让 App.tsx 更精简，同时也便于 serve 模式复用。

- [ ] **Step 1：实现 ChatRunner**

```typescript
// src/cli/chat-runner.ts
// 核心聊天循环：从 App.tsx handleSubmit 中提取
// 可被 interactive 模式和 serve 模式共享

import type { ServiceContext } from './service-context.js';
import type { LLMMessage, ReActEvent } from '../router/types.js';
import type { ConfirmToolCallback } from '../agent/loop-config.js';
import { logger } from '../utils/logger.js';

export interface ChatRunnerInput {
  text: string;
  services: ServiceContext;
  onTextDelta: (text: string) => void;
  onToolCall: (toolName: string) => void;
  onToolError: (toolName: string, error: string) => void;
  onSystemMessage: (text: string) => void;
  onComplete: (content: string, usage: { inputTokens: number; outputTokens: number; totalTokens: number }) => void;
  onError: (error: string) => void;
  onConfirmTool?: ConfirmToolCallback;
  signal?: AbortSignal;
}

export async function runChat(input: ChatRunnerInput): Promise<void> {
  const { text, services, onTextDelta, onToolCall, onToolError, onSystemMessage, onComplete, onError, onConfirmTool, signal } = input;

  try {
    // 1. 场景分类
    const classification = await services.classifier.classify({ query: text });

    // 2. 路由决策
    const routeDecision = await services.modelRouter.route(classification);

    // 3. 获取 LLM client
    const llmClient = services.clientManager.get(routeDecision.providerId);
    if (!llmClient) {
      onError(`未找到 provider ${routeDecision.providerId}`);
      return;
    }

    // 4. ReAct 循环
    let fullContent = '';
    let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    for await (const event of services.agentLoop.run({
      userMessage: text,
      llmClient,
      routeDecision,
      conversationHistory: services.conversationHistory.current,
      systemPrompt: services.systemPrompt,
      signal: signal ?? services.abortController.current?.signal,
      onConfirmTool,
    })) {
      switch (event.type) {
        case 'text_delta':
          onTextDelta(event.text);
          fullContent += event.text;
          break;
        case 'tool_call_start':
          onToolCall(event.toolName);
          break;
        case 'tool_call_result':
          if (event.isError) {
            onToolError(event.toolName, event.result);
          }
          break;
        case 'error':
          onError(event.error);
          fullContent += `\n\n❌ 错误: ${event.error}`;
          break;
        case 'done':
          finalUsage = event.usage;
          fullContent = event.content || fullContent;
          break;
      }
    }

    // 5. Token 追踪
    services.tracker.record(finalUsage, {
      modelId: routeDecision.model.id,
      agentId: 'main',
    });

    // 6. 更新对话历史
    services.conversationHistory.current.push(
      { role: 'user', content: text },
      { role: 'assistant', content: fullContent },
    );
    if (services.conversationHistory.current.length > 20) {
      services.conversationHistory.current =
        services.conversationHistory.current.slice(-20);
    }

    onComplete(fullContent, finalUsage);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 2：App.tsx handleSubmit 改为调用 runChat()**

```typescript
// App.tsx 中的 handleSubmit 精简为：
const handleSubmit = useCallback(async (text: string) => {
  // ... 确认检查和命令分发不变 ...

  setIsProcessing(true);
  const assistantMsgId = nextId();
  let accumulated = '';

  setMessages(prev => [...prev, {
    id: assistantMsgId, role: 'assistant' as const, content: '', isStreaming: true,
  }]);

  await runChat({
    text,
    services,
    onTextDelta: (delta) => {
      accumulated += delta;
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId ? { ...m, content: accumulated } : m
      ));
    },
    onToolCall: (name) => addSystemMessage(`🔧 调用工具: ${name}`),
    onToolError: (name, err) => addSystemMessage(`⚠️ ${name} 错误: ${err.slice(0, 200)}`),
    onSystemMessage: addSystemMessage,
    onComplete: (content, usage) => {
      setTodayTokensUsed(prev => prev + usage.totalTokens);
      setMessages(prev => prev.map(m =>
        m.id === assistantMsgId ? { ...m, content, isStreaming: false } : m
      ));
    },
    onError: (err) => addSystemMessage(`错误: ${err}`),
    onConfirmTool: handleToolConfirm,
  });

  setIsProcessing(false);
}, [services, commandRegistry, handleToolConfirm, addSystemMessage]);
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
npx vitest run
git add src/cli/chat-runner.ts src/cli/App.tsx
git commit -m "refactor(cli): extract core chat loop into reusable ChatRunner"
```

---

### Task 6：vision.ts 路径穿越修复

**文件：** 修改 `src/agent/vision.ts`

- [ ] **Step 1：在 loadImage 中添加路径边界检查**

```typescript
// 在 VisionAssistant.loadImage() 中添加安全检查
// 当前代码（line 110-139）：
static async loadImage(filePath: string): Promise<ImageInput | null> {
    try {
      const absolutePath = path.resolve(filePath);
      // 【新增】路径安全检查——拒绝项目目录外的文件
      const projectRoot = process.cwd();
      const normalizedPath = path.normalize(absolutePath);
      if (!normalizedPath.startsWith(projectRoot)) {
        logger.warn('VisionAssistant: path traversal blocked', {
          requestedPath: normalizedPath,
          projectRoot,
        });
        return null;
      }

      const buffer = await fs.readFile(normalizedPath);
      // ... 后续逻辑不变 ...
```

注意：路径检查使用 `process.cwd()` 作为项目边界。这与 SecurityChecker 的目录边界策略一致。

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/vision.ts
git commit -m "fix(agent): add path traversal protection in VisionAssistant.loadImage"
```

---

### Task 7：branch.ts append 状态一致性修复

**文件：** 修改 `src/agent/branch.ts`

- [ ] **Step 1：修复 append 在 parentId 非 tip 时的分支映射**

当前问题（lines 146-157）：当 `parentId` 不是 `this.branches` 的 key 时（即 parentId 不是某个分支的 tip），append 不会创建新的 BranchInfo 条目，导致 `activeBranchId` 与 `branches` Map 不一致。

修复方案：在 `if (oldBranch)` 块之外增加一个兜底——如果 parentId 没有对应的旧分支，尝试通过 `getPath` 找到所属分支并更新其 tip：

```typescript
append(message: LLMMessage): string {
    const id = this.generateId();
    const parentId = this.activeBranchId;
    const node: BranchNode = { id, parentId, /* ... */ };
    this.nodes.set(id, node);

    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) parent.children.push(id);

      // 尝试更新现有分支的 tip
      const oldBranch = this.branches.get(parentId);
      if (oldBranch) {
        // 原有逻辑：直接更新
        this.branches.delete(parentId);
        const newBranch = {
          id,
          name: oldBranch.name,
          messageCount: this.getPathLength(id),
          isActive: true,
          createdAt: oldBranch.createdAt,
        };
        this.branches.set(id, newBranch);
      } else {
        // 【修复】parentId 不是任何分支的 tip——找到所属分支并更新
        for (const [branchKey, branch] of this.branches) {
          if (this.isAncestor(parentId, branchKey)) {
            this.branches.delete(branchKey);
            this.branches.set(id, {
              ...branch,
              id,
              messageCount: this.getPathLength(id),
            });
            break;
          }
        }
        // 如果还是没找到所属分支，创建一个新分支
        if (![...this.branches.values()].some(b => b.id === id)) {
          this.branches.set(id, {
            id,
            name: `branch-${this.branches.size + 1}`,
            messageCount: this.getPathLength(id),
            isActive: true,
            createdAt: Date.now(),
          });
        }
      }
    } else {
      // 根节点——创建初始分支
      this.branches.set(id, {
        id,
        name: 'main',
        messageCount: 1,
        isActive: true,
        createdAt: Date.now(),
      });
    }

    this.activeBranchId = id;
    return id;
  }

  /** 判断 nodeId 是否是 ancestorId 的后代 */
  private isAncestor(nodeId: string, potentialDescendant: string): boolean {
    let current = this.nodes.get(potentialDescendant);
    while (current) {
      if (current.parentId === nodeId) return true;
      if (!current.parentId) break;
      current = this.nodes.get(current.parentId);
    }
    return false;
  }
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/branch.ts
git commit -m "fix(agent): resolve branch state inconsistency in BranchManager.append"
```

---

### Task 8：单元测试

**文件：** 创建 `tests/cli/command-registry.test.ts`、`tests/cli/service-context.test.ts`，修改 `tests/agent/branch/branch.test.ts`、`tests/agent/vision/vision.test.ts`

- [ ] **Step 1：CommandRegistry 测试（5 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | register + resolve | 注册后可按名称查找处理器 |
| 2 | 别名解析 | /exit 正确解析到 /quit 的处理器 |
| 3 | 未知命令 | resolve 返回 null |
| 4 | getHelpText 自动生成 | 包含所有已注册命令的名称和描述 |
| 5 | listNames 包含别名 | 返回所有名称 + 别名 |

- [ ] **Step 2：branch.ts append 修复验证（3 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | 连续 append 在同一分支 | branches Map 正确更新 tip |
| 2 | fork 后 append | 新分支 tip 正确指向 append 创建的节点 |
| 3 | append 在 mid-chain 节点 | 兜底逻辑创建或更新 BranchInfo |

- [ ] **Step 3：vision.ts path traversal 测试（2 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | 正常路径（项目内） | loadImage 正常返回 |
| 2 | 路径穿越（../../.env） | loadImage 返回 null 并 log warning |

- [ ] **Step 4：运行全量测试 → 提交**

```powershell
npx vitest run
# 预期：新增 10 个测试
# 累计测试数：Phase 16 的 290 + 10 = 300+

pnpm build
pnpm typecheck
git add tests/
git commit -m "test(cli+agent): add CommandRegistry tests, fix branch/vision test coverage"
git push origin main
```

---

## 接口对齐观察表

以下签名已通过 Explore agent 对实际代码库验证（Phase 13 完成后基线）：

| 接口 | 文件 | 签名 | 本 Phase 引用方式 |
|------|------|------|-------------------|
| `App` 组件 | `src/cli/App.tsx` | `({ config }: AppProps) => JSX` | 重写后保持相同 props 接口 |
| `clientManager.listAll()` | `src/router/llm/index.ts` | `() => Map<string, ILLMClient>` | useMemo 包裹，修复缺陷 #1 |
| `ScenarioClassifier.classify()` | `src/router/classifier.ts` | `({ query: string }) => Promise<ClassificationResult>` | runChat() 调用 |
| `ModelRouter.route()` | `src/router/router.ts` | `(classification) => Promise<RoutingResult>` | runChat() 调用 |
| `TokenTracker.record()` | `src/router/tracker.ts` | `(usage, meta) => void` | runChat() 调用 |
| `ReActAgentLoop.run()` | `src/agent/loop.ts` | `async *run(ReActRunParams) => AsyncGenerator<ReActEvent>` | runChat() 的 for-await 循环 |
| `ToolRegistry` | `src/tools/registry.ts` | `register(tool)` / `get(name)` / `list()` | service-context 初始化 |
| `ToolExecutor` | `src/tools/executor.ts` | `(registry, security, permission) => ToolExecutor` | service-context 初始化 |
| `ToolRegistryAdapter` | `src/tools/adapter.ts` | `(registry) => ToolExecutorAdapter` | service-context 初始化 |
| `SecurityChecker` | `src/tools/security.ts` | `(SecurityConfig) => SecurityChecker` | service-context 初始化 |
| `PermissionChecker` | `src/tools/permission.ts` | `(AutonomyConfig) => PermissionChecker` | service-context 初始化 |
| `MCPClientManager` | `src/tools/mcp/client.ts` | `(MCPConfig) => MCPClientManager` | service-context + unmount 清理 |
| `CheckpointManager` | `src/harness/checkpoint-manager.ts` | `(projectPath) => CheckpointManager` | service-context 初始化 |
| `VisionAssistant.loadImage()` | `src/agent/vision.ts` | `static async (filePath: string) => Promise<ImageInput \| null>` | Task 6 添加路径检查 |
| `BranchManager.append()` | `src/agent/branch.ts` | `(message: LLMMessage) => string` | Task 7 修复状态一致性 |
| `ConfirmToolCallback` | `src/agent/loop-config.ts` | `(toolName, args) => Promise<boolean>` | App.tsx handleToolConfirm |
| `StatusBar` | `src/cli/components/StatusBar.tsx` | `{ currentModel, currentTier, isDegraded, todayTokensUsed, autonomyMode, workMode }` | App.tsx JSX 中传入 6 个 props |
| `InputBox` | `src/cli/components/InputBox.tsx` | `{ onSubmit: (text) => void, disabled?: boolean }` | App.tsx JSX 中传入 |

---

## 对下一阶段的提醒

1. **Phase 14-16 的 ref 需要迁移**：Phase 14（multi/）、Phase 15（harness/trace、audit）、Phase 16（prompts/）添加的 ref 和逻辑也需要搬入 useServiceContext。本 Phase 的 Task 1 只覆盖了 Phase 1-13 的 19 个 ref——执行人在实现时需将后续 Phase 的 ref 一并整合
2. **ChatRunner 可被 serve 模式复用**：当前 `src/cli/server.ts` 中的 MessageRouter 直接使用 `llmClient.complete()`。后续可改为使用 ChatRunner，让渠道模式也支持 ReAct 循环（工具调用）
3. **命令处理器中的 `var` 关键字**：handleGoalCommand 中 lines 1181/1183 使用了 `var`，迁移时改为 `let`/`const`
4. **命令注册顺序决定 /help 显示顺序**：当前按字母序排列，后续可加 `priority` 字段控制顺序
5. **App.tsx 中 `messages` 作为 handleSubmit 的 useCallback 依赖**：每次 messages 变化都会重建 handleSubmit。这是 Ink/React 的固有行为，不影响性能，但意味着 getMessages() 总是最新的
6. **process.cwd() 作为项目边界**：vision.ts 路径检查和 SecurityChecker 都用 process.cwd() 作为项目根目录。如果用户从不同目录启动，边界会不同。后续可加 --project-dir CLI 参数
7. **SIGINT handler 的 process.exit(0)**：当前直接退出。后续可加 "再次按 Ctrl+C 强制退出" 的二次确认
