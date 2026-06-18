# Phase 24 — 功能补全与产品完善

> **Phase 类型：** 补全 + 完善（Completion + Polish）
> **前置依赖：** Phase 0c 完成（839 测试通过，v1.0.1）
> **并行说明：** 可与 Phase 25 并行执行。Task 1（CLI 设计系统）是两个 Phase 的共享基础，建议优先完成。
> **目标版本：** v1.1.0
> **蓝图引用：** Section 7.6（DurableExecutor）、Section 9.3（HookRunner）、Section 十二（Compose 模式）、Section 十五（Prompt 模板）

---

## 背景

v1.0.1 已发布，核心链路（路由→Agent Loop→工具执行→响应）和基础设施（插件、记忆、Guardrails、工作模式）均已就绪。但蓝图规定的几个功能模块仍停留在"骨架"或"未实现"状态：

1. **Compose 模式管线**——`WorkModeController` 已有四个阶段枚举（requirements → coding → testing → review），但 `advanceComposePhase()` 只翻转枚举值，没有阶段专属逻辑、prompt 注入或自动化工具限制。蓝图要求"自动编排需求→编码→测试→审查全流程"。
2. **DurableExecutor**——蓝图 Section 7.6 和设计文档都有完整接口定义（`start`/`resumeFrom`/`getSnapshot`/`listRecoverable`），但代码库中不存在此模块。
3. **HookRunner**——蓝图 Section 9.3 定义了四种生命周期钩子（pre-step / post-step / on-error / on-complete），与 `AgentMiddlewarePipeline` 是不同层次的抽象。代码库中不存在此模块。
4. **产品细节**——缺少 `/permissions` 命令、系统提示词工程规范、错误消息人性化等。

本 Phase 把这些"最后一公里"功能补齐，让 RouteDev 从"能用"变成"好用"。

---

## 接口对齐观察表

以下签名已通过架构师代码级验证（Phase 0c 完成后实际代码）：

| 接口 / 类 | 当前签名 | 文件位置 | 本 Phase 引用方式 |
|---|---|---|---|
| `WorkModeController` | `getMode(): WorkMode` / `setMode(mode)` / `checkOperation(toolName, args): ModeCheckResult` / `getComposePhase(): ComposePhase \| null` / `advanceComposePhase(): void` | `src/agent/work-modes.ts` | Task 2 扩展 compose 阶段逻辑 |
| `ComposePhase` | `type ComposePhase = 'requirements' \| 'coding' \| 'testing' \| 'review'` | `src/agent/work-modes.ts` | Task 2 阶段专属行为 |
| `GuardedToolExecutorAdapter` | 包装 `ToolExecutorAdapter`，插入 `checkOperation()` 前置守卫 | `src/agent/work-modes.ts` | Task 2 阶段工具限制 |
| `ReActAgentLoop` | `run(params): AsyncGenerator<ReActEvent>` / `setMiddlewarePipeline(pipeline)` / `updateConfig(config)` | `src/agent/loop.ts` | Task 4 HookRunner 接入点 |
| `AgentMiddlewarePipeline` | `register(phase, handler)` / `execute(phase, ctx)` — 5 个阶段，目前仅 onActing 被 loop 调用 | `src/agent/middleware.ts` | Task 4 区分 Hook vs Middleware |
| `ServiceContext` | 28 必需 + 1 可选 = 29 字段 | `src/cli/service-context.ts` | Task 5/6 新增字段 |
| `CommandBridge` | 10 方法：addSystemMessage / clearChat / setAutonomyMode / setWorkMode / requestAbort / requestConfirm / requestPlanEdit / exit / startGoal / getState | `src/cli/service-context.ts` | Task 5 /permissions 命令 |
| `CheckpointManager` | 已有检查点读写能力 | `src/agent/memory/` | Task 3 DurableExecutor 复用 |
| `PermissionEngine` | `createDefaultEngine()` 工厂 / 中间件接入 | `src/tools/permission-engine.ts` | Task 5 /permissions 可视化 |
| `PluginRegistry` | 11 方法 / 4 种插件类型 | `src/plugins/registry.ts` | Task 4 HookPlugin 扩展 |
| `PromptTemplateManager` | 模板获取、注册、变量渲染 | `src/prompts/manager.ts` | Task 6 提示词规范 |
| `StatusBar` props | `{ currentModel, currentTier, isDegraded, todayTokensUsed, autonomyMode, workMode }` | `src/cli/components/StatusBar.tsx` | Task 1 设计系统集成 |
| `ChatView` | 消息流渲染组件 | `src/cli/components/ChatView.tsx` | Task 1 消息样式迁移 |

---

## Task 1：CLI 设计系统（共享基础，与 Phase 25 共用）

**目标**：建立统一的视觉语言——颜色语义、消息类型、排版规范——让所有 UI 组件"说同一种语言"。此 Task 是 Phase 24 和 Phase 25 的共享基础，建议最先完成。

### 比喻

设计系统就像一本"品牌手册"——规定什么颜色代表什么意思、标题多大字号、间距多少。没有它，每个组件各自为政，用户看到的是一盘散沙。有了它，所有界面"说同一种语言"。

### 设计

#### 1.1 颜色语义表

| 语义角色 | 颜色 | 用途 | 示例 |
|---------|------|------|------|
| `primary` | 蓝色（#5B9BD5） | 主要操作、正常状态 | "正在执行..." |
| `success` | 绿色（#70AD47） | 成功完成、自动放行 | "✅ 文件已保存" |
| `warning` | 黄色（#FFC000） | 需要注意、降级状态 | "⚠️ 模型降级为 gpt-3.5" |
| `error` | 红色（#FF4444） | 错误、被禁止 | "❌ 权限被拒绝" |
| `info` | 灰色（#A0A0A0） | 系统消息、辅助信息 | "[路由] 分类结果: simple" |
| `accent` | 品红（#E040A0） | 特殊操作、高亮 | "🔮 梦境模式已激活" |

#### 1.2 消息类型与格式

```typescript
// src/cli/design-system.ts — 新建

type SemanticColor = 'primary' | 'success' | 'warning' | 'error' | 'info' | 'accent';

interface MessageStyle {
  prefix: string;        // 如 "[路由]", "[权限]", "[配置]"
  color: SemanticColor;  // 语义颜色
  italic?: boolean;      // 系统消息默认斜体
  dim?: boolean;         // 次要信息变暗
}

/** 统一的消息样式注册表 */
const MESSAGE_STYLES: Record<string, MessageStyle> = {
  routing:    { prefix: '[路由]', color: 'info', italic: true },
  permission: { prefix: '[权限]', color: 'warning' },
  config:     { prefix: '[配置]', color: 'info', italic: true },
  compose:    { prefix: '[编排]', color: 'accent' },
  hook:       { prefix: '[钩子]', color: 'info', dim: true },
  error:      { prefix: '[错误]', color: 'error' },
  success:    { prefix: '[完成]', color: 'success' },
  system:     { prefix: '[系统]', color: 'info', italic: true, dim: true },
};
```

#### 1.3 排版规范

- **标题行**：加粗，使用 primary 颜色
- **正文**：常规字重，默认颜色
- **系统消息**：斜体，dim 变暗，前缀标签
- **错误消息**：加粗，error 颜色，三行结构（发生了什么 / 可能原因 / 建议操作）
- **代码块**：缩进 2 格，等宽字体（如终端支持）
- **分隔线**：使用 Unicode 盒字符 `─`，宽度自适应终端

#### 1.4 现有组件迁移

所有现有组件（StatusBar、ChatView、ConfigReloadUI 等）迁移到设计系统的颜色语义和消息格式。改造时保持功能不变，只统一视觉。

#### 1.5 Executor 注意事项

1. `design-system.ts` 是纯常量 + 类型定义，无副作用，所有组件 import 使用
2. 颜色值支持终端 256 色和 truecolor 两种模式（检测 `process.env.COLORTERM`）
3. 改造是渐进式的——先建系统，再逐组件迁移，每个组件一个 commit
4. Phase 25 的 UI 组件将直接 import 此模块的常量和类型
5. 测试：颜色语义映射完整、消息格式化正确、终端兼容模式

---

## Task 2：Compose 模式管线自动化

**目标**：让 Compose 模式从"枚举翻转器"变成真正的自动编排引擎——每个阶段有专属的系统提示词注入、工具权限限制、和自动流转逻辑。

### 比喻

把 Compose 模式想象成一条**流水线**：原材料（需求）进来，经过四个工位（需求分析→编码→测试→审查），每个工位有自己的操作规范和使用工具的限制。现在这条流水线只有四个"牌子"（枚举值），没有实际的工位操作——Task 2 就是给每个工位装上操作手册和工具柜。

### 设计

#### 2.1 阶段行为矩阵

| 阶段 | 系统提示词注入 | 允许的工具类别 | 自动流转条件 |
|------|--------------|---------------|-------------|
| requirements | "你正在做需求分析，只读取和分析代码，不做修改" | file_read, code_search, list_dir | 用户确认需求文档后自动进入 coding |
| coding | "你正在编码实现，可以读写文件和执行命令" | 全工具（受 PermissionEngine 约束） | 编码完成后自动进入 testing |
| testing | "你正在测试，重点运行测试命令和检查代码" | file_read, shell_exec(测试命令), code_search | 测试通过后自动进入 review |
| review | "你正在审查代码，只读分析，输出审查报告" | file_read, code_search, list_dir | 审查完成后管线结束 |

#### 2.2 ComposePipeline 类

```typescript
// src/agent/compose-pipeline.ts — 新建

interface ComposePhaseConfig {
  phase: ComposePhase;
  systemPromptOverride: string;     // 注入 Agent Loop 的阶段提示词
  allowedToolCategories: string[];  // 工具类别白名单
  autoAdvanceCondition: (lastResult: ToolResult) => boolean;
}

class ComposePipeline {
  constructor(private workModeController: WorkModeController);

  /** 获取当前阶段的配置 */
  getCurrentPhaseConfig(): ComposePhaseConfig | null;

  /** 获取阶段提示词，注入到 Agent Loop 的 system prompt 中 */
  getPhasePrompt(): string;

  /** 评估是否应自动流转（每次工具执行后调用） */
  evaluateAdvance(lastResult: ToolResult): boolean;

  /** 手动推进到下一阶段（用户命令 /compose next） */
  advance(): ComposePhase;

  /** 获取管线状态摘要（用于 StatusBar 显示） */
  getSummary(): { phase: ComposePhase; progress: string };
}
```

#### 2.3 集成点

- `WorkModeController.setMode('compose')` 时创建 `ComposePipeline` 实例
- `ReActAgentLoop` 在每次迭代开始时调用 `pipeline.getPhasePrompt()` 追加到 system prompt
- `GuardedToolExecutorAdapter.checkOperation()` 在 compose 模式下额外检查 `pipeline.getCurrentPhaseConfig().allowedToolCategories`
- 工具执行完成后调用 `pipeline.evaluateAdvance()` 判断是否自动推进
- 新增 `/compose next` 和 `/compose status` 子命令

#### 2.4 Executor 注意事项

1. 先阅读 `src/agent/work-modes.ts` 理解现有的 `WorkModeController` 和 `GuardedToolExecutorAdapter`
2. `ComposePipeline` 是 `WorkModeController` 的内部协作对象，不改变 `WorkModeController` 的公共接口
3. 阶段提示词使用 `PromptTemplateManager` 获取，不硬编码字符串
4. `autoAdvanceCondition` 的默认实现基于"LLM 返回非 tool_call 文本"（即 LLM 认为当前阶段完成）
5. 自动流转时通过 `CommandBridge.addSystemMessage()` 通知用户阶段切换，使用 Task 1 的 `compose` 消息样式
6. 测试覆盖：四个阶段的工具限制、自动流转触发、手动推进、管线状态摘要

---

## Task 3：DurableExecutor（持久化执行器）

**目标**：实现蓝图 Section 7.6 规定的持久化执行能力——长任务每步自动保存状态，失败后可从断点恢复。

### 比喻

想象你在玩一个很长的游戏，每次退出都不用从头来——下次打开自动从上次存档的地方继续。DurableExecutor 就是给 RouteDev 的任务执行加上"自动存档"和"读档"功能。

### 设计

#### 3.1 核心接口（来自蓝图 design-spec.md）

```typescript
// src/agent/durable-executor.ts — 新建

interface DurableExecutor {
  /** 启动持久化执行，每完成一步自动保存状态 */
  start(plan: PlanStep[], goal: string): Promise<ExecutionResult>;

  /** 从上次成功的步骤恢复 */
  resumeFrom(planId: string): Promise<ExecutionResult>;

  /** 获取执行状态快照 */
  getSnapshot(planId: string): ExecutionSnapshot | null;

  /** 列出所有可恢复的执行 */
  listRecoverable(): ExecutionSnapshot[];
}

interface ExecutionSnapshot {
  planId: string;
  goal: string;
  startedAt: number;
  lastStepCompleted: number;
  totalSteps: number;
  status: 'running' | 'paused' | 'failed' | 'completed';
  completedResults: StepResult[];
  nextStep: PlanStep | null;
}
```

#### 3.2 状态持久化

- 快照存储路径：`~/.qoderwork/routedev/sessions/{sessionId}/progress.json`
- 每完成一步调用 `saveSnapshot()` 写入磁盘
- 使用 `fs.writeFile` + `JSON.stringify` 原子写入（先写 `.tmp` 再 rename）
- `listRecoverable()` 扫描 sessions 目录，读取各 `progress.json` 的 `status`

#### 3.3 与现有模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `ReActAgentLoop` | DurableExecutor 内部使用 | 每步调用 `agentLoop.run()` 执行 |
| `CheckpointManager` | 复用 | 步骤间自动触发检查点 |
| `CommandBridge` | 通知用户 | 阶段切换/恢复时 `addSystemMessage()` |
| `Orchestrator` | 可选上层 | Orchestrator 可选择使用 DurableExecutor 或直接执行 |

#### 3.4 新增命令

`/resume` — 列出可恢复的执行，用户选择后从断点继续

```
用户输入: /resume
RouteDev: 找到 2 个可恢复的执行：
  1. [paused] "重构认证模块" — 完成 3/8 步 — 2小时前
  2. [failed] "添加单元测试" — 完成 5/12 步 — 昨天
  输入编号恢复，或 /resume <planId> 直接恢复
```

#### 3.5 Executor 注意事项

1. `DurableExecutor` 是独立模块，不修改 `ReActAgentLoop` 内部逻辑
2. 快照文件格式参考 `CheckpointData`（Phase 17c 已定义）
3. `resumeFrom()` 需要验证快照完整性（planId 存在、文件未损坏）
4. 并发安全：同一 planId 不能同时有两个 running 状态的执行
5. 失败恢复：如果 `resumeFrom()` 本身失败，保留原快照不覆盖
6. 测试覆盖：正常执行→快照→恢复、中断→恢复、快照文件损坏处理、并发保护

---

## Task 4：HookRunner（生命周期钩子系统）

**目标**：实现蓝图 Section 9.3 规定的四种生命周期钩子，与 `AgentMiddlewarePipeline` 互补但不重叠。

### Middleware vs Hook 的区别（比喻）

`AgentMiddlewarePipeline`（Phase 17b/22 已实现）像是**高速公路上的收费站**——在 Agent Loop 的五个固定点拦截，可以检查和放行。

`HookRunner` 像是**任务执行前后的仪式**——在每一步开始之前（pre-step）、结束之后（post-step）、出错时（on-error）、整体完成时（on-complete）触发。它关注的不是"Agent Loop 内部怎么跑"，而是"步骤层面的生命周期"。

### 设计

#### 4.1 核心接口（来自蓝图 design-spec2.md）

```typescript
// src/agent/hooks.ts — 新建

type HookEvent = 'pre-step' | 'post-step' | 'on-error' | 'on-complete';

interface HookContext {
  stepId: string;
  agentId: string;
  stepResult?: StepResult;
  error?: StepError;
  projectPath: string;
}

interface HookResult {
  action: 'continue' | 'abort' | 'retry' | 'skip';
  message?: string;
  modifiedResult?: StepResult;
}

type HookHandler = (context: HookContext) => Promise<HookResult>;

interface HookDefinition {
  event: HookEvent;
  handler: HookHandler;
  priority?: number;    // 数值越小越先执行，默认 100
  name?: string;        // 可读名称，用于日志
}

class HookRunner {
  /** 注册钩子 */
  register(hook: HookDefinition): void;

  /** 注销钩子（按 name 匹配） */
  unregister(name: string): void;

  /** 触发某事件的所有钩子，按 priority 排序 */
  async fire(event: HookEvent, context: HookContext): Promise<HookResult>;

  /** 列出已注册的钩子 */
  list(): Array<{ event: HookEvent; name: string; priority: number }>;
}
```

#### 4.2 执行语义

- **pre-step**：步骤执行前触发。返回 `abort` 跳过此步骤；返回 `skip` 标记为跳过并继续下一步
- **post-step**：步骤成功完成后触发。返回 `retry` 重新执行此步骤
- **on-error**：步骤执行出错时触发。返回 `retry` 重试、`skip` 跳过、`abort` 终止
- **on-complete**：所有步骤完成后触发一次。返回值仅 `message` 字段有效

同一事件的多个钩子按 `priority` 升序执行。如果某个钩子返回 `abort`，后续钩子不再执行。

#### 4.3 集成点

- `Orchestrator`（或 `DurableExecutor`）在步骤执行前后调用 `hookRunner.fire()`
- `PluginRegistry` 中 `HookPlugin` 的钩子同时注册到 `HookRunner`（新增桥接逻辑）
- App 初始化时创建 `HookRunner` 实例，传入 `ServiceContext`

#### 4.4 与 AgentMiddlewarePipeline 的边界

| 维度 | AgentMiddlewarePipeline | HookRunner |
|------|------------------------|------------|
| 关注层 | Agent Loop 内部（LLM 调用、工具执行） | 步骤层（任务步骤的开始/结束/出错） |
| 调用者 | ReActAgentLoop.run() | Orchestrator / DurableExecutor |
| 阶段 | 5 个（onAgent/onReasoning/onActing/onModelCall/onSystemPrompt） | 4 个（pre-step/post-step/on-error/on-complete） |
| 拦截能力 | 可修改上下文、阻止工具执行 | 可跳过/重试/中止步骤 |

#### 4.5 Executor 注意事项

1. `HookRunner` 是独立模块，不修改 `AgentMiddlewarePipeline` 的代码
2. 钩子执行在 try-catch 中——单个钩子崩溃不影响其他钩子和主流程
3. `fire()` 返回的是"最严格"结果：如果任一钩子返回 `abort`，最终结果就是 `abort`
4. 插件的 `HookPlugin.getHooks()` 目前返回 `MiddlewarePhase` 钩子，需扩展支持 `HookEvent` 类型（或新增 `getLifecycleHooks()` 方法）
5. 测试覆盖：注册/注销、优先级排序、abort 短路、钩子崩溃隔离、retry 语义

---

## Task 5：/permissions 命令

**目标**：让用户能查看当前权限引擎的所有规则，了解哪些操作自动放行、哪些需要确认、哪些被禁止。

### 设计

```
用户输入: /permissions
RouteDev:
┌─ 权限规则一览 ──────────────────────────────────┐
│                                                   │
│  🔴 DENY 规则（不可绕过）:                        │
│    rm -rf /          阻止破坏性删除               │
│    system-write      阻止系统目录写入             │
│                                                   │
│  🟡 CONFIRM 规则（需确认）:                       │
│    file-write        文件写入需确认               │
│    shell-exec        Shell 命令执行需确认         │
│    confirm-git-op    Git 写操作需确认             │
│    confirm-web-search 网络搜索需确认              │
│                                                   │
│  🟢 AUTO 规则（自动放行）:                        │
│    file-read         文件读取                     │
│    code-search       代码搜索                     │
│    auto-file-wildcard 文件通配符操作              │
│    auto-code-search   代码搜索                    │
│                                                   │
│  当前自主模式: semi                               │
│  提示: 使用 /auto /semi /manual 切换自主模式      │
└───────────────────────────────────────────────────┘
```

### 实现

- 读取 `PermissionEngine` 的当前规则集（DEFAULT_DENY_RULES / DEFAULT_CONFIRM_RULES / DEFAULT_AUTO_RULES + 运行时添加的规则）
- 需要在 `PermissionEngine` 中新增 `listRules(): PermissionRule[]` 方法，返回当前所有规则
- 注册为 `CommandDefinition`，接入 `CommandRegistry`
- 输出使用 Task 1 设计系统的颜色语义（DENY=error、CONFIRM=warning、AUTO=success）

### Executor 注意事项

1. 先阅读 `src/tools/permission-engine.ts` 理解规则存储结构
2. `listRules()` 是 PermissionEngine 的新增公共方法，不改变现有方法
3. 输出格式用 Ink 的 `<Box>` + `<Text>` 渲染，颜色使用设计系统语义色
4. 测试覆盖：listRules() 返回完整规则、/permissions 命令输出格式

---

## Task 6：系统提示词工程规范

**目标**：建立提示词质量标准，让所有内置 prompt 模板符合统一规范。

### 灵感来源

从 Obsidian 知识库中"System Prompt 5-Block Structure"概念：好的系统提示词应分为五个块——角色定义、能力边界、输出格式、约束条件、示例。这与我们蓝图 Section 十五的 PromptTemplateManager 理念一致，但缺少落地规范。

### 设计

#### 6.1 五块结构标准

每个 prompt 模板应包含以下五个逻辑块（用注释分隔）：

```
// ═══ Block 1: 角色定义 ═══
你是一个 [角色]，专门负责 [职责]。

// ═══ Block 2: 能力边界 ═══
你可以做：[允许的操作列表]
你不能做：[禁止的操作列表]

// ═══ Block 3: 输出格式 ═══
你的输出必须遵循以下格式：[格式说明]

// ═══ Block 4: 约束条件 ═══
- 不要 [约束1]
- 不要 [约束2]

// ═══ Block 5: 示例（可选）═══
输入：[示例输入]
输出：[示例输出]
```

#### 6.2 审查与修正

对现有的 prompt 模板（`src/prompts/` 目录）进行审查，确保每个模板至少包含 Block 1-4。对缺失的块进行补充。

重点审查：
- Orchestrator prompt（spec3 已有五块结构，验证实际代码是否一致）
- Worker prompts（Coder/Searcher/Tester/Reviewer）
- Classifier prompt
- GoalVerifier prompt

#### 6.3 PromptTemplateManager 增强

新增 `validate()` 方法——检查模板是否包含五块结构标记，不符合时记 warn 日志（不阻断运行）。

#### 6.4 Executor 注意事项

1. 先阅读 `src/prompts/` 目录所有模板文件，统计每个模板的块覆盖情况
2. 补充缺失的块时保持原有内容不变，只增加结构标记
3. 不创建新的 prompt 文件，只修改现有文件
4. `validate()` 方法仅做格式检查，不修改模板内容

---

## Task 7：错误消息人性化 + 路由透明化

**目标**：改善用户遇到错误时的体验，让路由决策对用户可见可理解。

### 7.1 错误消息改造

当前错误消息可能是原始技术错误（如 "ECONNREFUSED 127.0.0.1:3000"）。改造为：

```
[错误] 无法连接到本地服务（127.0.0.1:3000）。
可能原因：服务未启动，或端口号不对。
建议：检查服务是否运行，或用 /config 修改端口。
```

改造范围：
- LLM API 调用失败（超时、鉴权失败、速率限制、模型不存在）
- 工具执行失败（文件不存在、权限不足、命令超时）
- 配置错误（配置文件格式错误、必填字段缺失）

每类错误模板包含三要素：**发生了什么** + **可能原因** + **建议操作**。

### 7.2 路由透明化

当前路由决策对用户不可见。新增路由通知：

```
[路由] 任务分类: complex (置信度 0.89) → 使用 gpt-4o
[路由] 原因: 检测到多文件修改需求，需要高能力模型
```

实现方式：
- `ModelRouter.route()` 返回结果中增加 `reasoning` 字段（如果 Classifier 已提供）
- App.tsx 在路由完成后通过 `CommandBridge.addSystemMessage()` 显示路由信息
- 可通过配置 `ui.showRoutingDecisions: true/false` 控制是否显示（默认 true）

### 7.3 Executor 注意事项

1. 错误消息模板统一管理在 `src/utils/error-messages.ts`（新建），按错误类型分类
2. 路由通知在 debug 模式下显示详细信息，普通模式下显示简洁版
3. 不改变 `ModelRouter.route()` 的返回类型签名——`reasoning` 字段已在 `ClassificationResult` 中
4. 消息样式使用 Task 1 设计系统的 `MESSAGE_STYLES.error` 和 `MESSAGE_STYLES.routing`
5. 测试覆盖：错误消息格式化、路由通知开关、配置项验证

---

## Task 8：Provider 配置完整性校验（GPT 审计建议）

**目标**：在启动时检查配置文件中的 provider 是否有对应的 LLMClient 实现。

### 设计

启动时遍历 `config.providers[]`，对每个 provider 检查：
1. `LLMClientManager` 是否有对应的 client 注册
2. `providers[].models[]` 列出的模型是否至少有一个可用

不匹配时输出警告（不阻断启动）：

```
[警告] 配置了 provider "anthropic" 但未找到对应的 API client。
  请确认已安装 @anthropic-ai/sdk 或设置 ANTHROPIC_API_KEY 环境变量。
```

### Executor 注意事项

1. 校验逻辑放在 `src/index.tsx` 的启动流程中，`App` 渲染之前
2. 校验结果通过 `logger.warn()` 输出，同时记录到 `AuditLogger`
3. 不修改 `LLMClientManager` 的接口，只调用现有的 `hasClient(providerId)` 方法（如无此方法则新增）
4. 测试覆盖：配置匹配、配置不匹配、空配置

---

## 执行顺序

```
Task 1 (设计系统) ─────── 最先做，Phase 25 也依赖此基础
  ↓
Task 5 (/permissions) ───── 简单，使用设计系统颜色
Task 7 (错误消息+路由) ──── 独立模块，使用设计系统样式
  ↓
Task 6 (提示词规范) ─────── 审查+修改，中等复杂度
Task 8 (Provider 校验) ──── 启动时逻辑
  ↓
Task 2 (Compose 管线) ──── 核心功能，依赖 Task 6 的阶段提示词
Task 4 (HookRunner) ────── 独立模块，但与 Task 3 有交互
  ↓
Task 3 (DurableExecutor) ─ 最复杂，最后做，可使用 Task 4 的钩子
```

Task 1 最先完成（共享基础）。Task 5/7 可并行。Task 2 在 Task 6 之后。Task 3 最后做。

---

## 验收标准

| # | 验收标准 | 验证方式 |
|---|---------|---------|
| 1 | 设计系统文件存在，颜色语义和消息样式定义完整 | 代码审查 |
| 2 | 现有 UI 组件迁移到设计系统（无硬编码颜色） | grep 验证 |
| 3 | Compose 模式四个阶段有专属提示词和工具限制 | 切换到 compose 模式，验证每个阶段的行为 |
| 4 | Compose 自动流转：LLM 完成当前阶段后自动进入下一阶段 | 单元测试 + 手动验证 |
| 5 | DurableExecutor 能执行多步计划并持久化快照 | 执行一个 3 步计划，检查 progress.json |
| 6 | DurableExecutor 能从断点恢复 | 中断后调用 resumeFrom()，验证从正确位置继续 |
| 7 | HookRunner 四种钩子按优先级执行 | 注册多个钩子，验证执行顺序和 abort 短路 |
| 8 | HookPlugin 的生命周期钩子能注册到 HookRunner | 插件集成测试 |
| 9 | /permissions 命令输出完整规则列表 | 手动执行命令验证输出 |
| 10 | 所有 prompt 模板符合五块结构 | validate() 无 warn |
| 11 | 错误消息包含三要素（发生了什么+原因+建议） | 触发各类错误验证消息格式 |
| 12 | 路由决策对用户可见（可通过配置关闭） | 验证通知显示和配置开关 |
| 13 | Provider 配置校验在启动时运行 | 故意配置不匹配的 provider 验证警告 |
| 14 | 全量测试通过 | `pnpm vitest run` |
| 15 | 构建通过 | `pnpm build && pnpm typecheck` |
| 16 | 新增测试 ≥ 35 个 | 测试计数 |

---

## 对下一阶段的提醒

1. **Compose 管线可视化**：Phase 25 可为 Compose 模式设计进度条和阶段指示器（`ComposePipeline.getSummary()` 提供数据）
2. **DurableExecutor UI**：Phase 25 可设计恢复选择的 UI 组件（`/resume` 已有基础命令）
3. **HookRunner 可视化**：Phase 25 可在 TracePanel 中展示钩子执行时间线
4. **插件热加载**：当前仅启动时加载插件，后续可 `fs.watch` 自动 reload
5. **RouterPlugin 集成**：`ModelRouter.route()` 尚未检查 RouterPlugin，需添加"先问 RouterPlugin，null 则 fallback"
6. **ThemePlugin 渲染**：StatusBar/ChatView 尚未读取 ThemePlugin 配置（但设计系统已就绪）
7. **插件状态持久化**：插件 enable/disable 状态仅内存，重启丢失
