# Phase 20 — 工作模式与步骤编辑器

> **Phase 类型：** 功能实现（Feature）
> **前置依赖：** Phase 17b（CommandBridge 已就位，命令文件模式已建立，ServiceContext 含 commandBridge）
> **目标版本：** v0.18.0
> **执行人注意：** 本 Phase 实现蓝图第十二节的工作模式（Build/Plan/Compose）和蓝图第七节 7.3 的 StepCard 步骤编辑器。工作模式与自主度模式（auto/semi/manual）**正交**——它们是两条独立的控制维度。

---

## 背景

蓝图第十二节定义了三种工作模式：Build（读写执行，默认）、Plan（只读分析）、Compose（编排全流程）。蓝图第七节 7.3 描述了目标分解后展示"Notion 风格步骤卡片列表（可编辑、删除、重排）"。

当前状态：
- `/goal` 命令已存在（Phase 9），能分解目标并逐步执行，但没有 UI 让用户编辑步骤
- `StatusBar` 已有 `workMode` prop（Phase 17b），但没有数据源和切换逻辑
- `CommandBridge` 已就位（Phase 17b），命令文件模式已建立

本 Phase 补齐这两块能力。

---

## 核心原则

1. **正交设计**：WorkMode 不替代 AutonomyMode。WorkMode 控制"能做什么类型的操作"，AutonomyMode 控制"什么时候需要人确认"
2. **拦截而非重写**：WorkModeController 在 ToolExecutor 执行前检查权限，不修改工具注册表
3. **Ink 组件规范**：StepCard/StepEditor 用 Ink 组件渲染，不用 console.log 拼字符串
4. **最小侵入**：不修改 GoalParser/GoalVerifier 的核心逻辑，只在执行前后插入编辑/确认环节

---

## 接口对齐观察表

以下签名已通过 Phase 9 / Phase 17b 验证，Phase 中的引用必须与此一致：

| 接口 / 类型 | 当前签名 | 文件位置 | 备注 |
|---|---|---|---|
| `CommandDefinition` | `{ name, aliases?, description, usage?, handler: (args, ctx) => Promise<CommandHandlerResult> }` | `src/cli/command-registry.ts` | |
| `CommandHandlerResult` | `{ type: 'handled'; messages?: string[] } \| { type: 'passthrough'; input: string }` | `src/cli/command-registry.ts` | |
| `CommandBridge` | `{ addSystemMessage, clearChat, setAutonomyMode, requestAbort, requestConfirm, exit, startGoal, getState }` | `src/cli/service-context.ts` | Phase 17b 交付，含 startGoal 和 getState。Task 2 需扩展 `setWorkMode` |
| `PlanStep` | `{ id: number, description, status: StepStatus, expectedFiles: string[], dependencies: number[], result?, usage? }` | `src/agent/goal-types.ts` | 蓝图称 PlanStep（非 GoalStep） |
| `StepStatus` | `'pending' \| 'in_progress' \| 'completed' \| 'failed' \| 'skipped'` | `src/agent/goal-types.ts` | |
| `GoalPlan` | `{ id, description, verifyCriteria, steps: PlanStep[], createdAt, completedAt?, status, verificationResult?, totalUsage? }` | `src/agent/goal-types.ts` | status 有 7 种：planning/confirmed/executing/verifying/completed/failed/cancelled |
| `ToolRegistryAdapter.execute()` | `execute(toolName: string, args: Record<string, unknown>): Promise<ToolResponse>` | `src/tools/registry.ts`（executor.ts 已在 Phase 17c 删除） | Task 1 需在此之前拦截 |
| `ToolResponse` | `{ content: string; isError: boolean; metadata?: Record<string, unknown> }` | `src/tools/types.ts` | Phase 17b 新增 |
| `StatusBar` props | `{ currentModel, currentTier, isDegraded, todayTokensUsed, autonomyMode, workMode }` | `src/cli/components/StatusBar.tsx` | workMode 已有 prop 位 |
| `ServiceContext` | 25 字段接口（含 `toolExecutor`, `setToolExecutor`, `goalParser`, `goalVerifier`, `commandBridge`, `checkpointManager`, `mcpManager` 等） | `src/cli/service-context.ts` | Task 1 新增 workModeController |
| `ChatView` props | `{ messages: ChatMessage[] }` | `src/cli/components/ChatView.tsx` | |

---

## Task 1：Work Mode 基础设施

> **目标：** 创建 WorkMode 类型和 WorkModeController，在工具执行前检查模式权限。

### 设计说明

WorkModeController 不修改 ToolRegistry，而是作为 ToolExecutor 的**前置守卫**。在 ToolExecutor.execute() 调用之前，由 Agent Loop 或 ServiceContext 层插入检查逻辑。

三种模式的操作权限矩阵：

| 操作类型 | Build | Plan | Compose |
|---|---|---|---|
| file_read / code_search / file_search | 允许 | 允许 | 允许 |
| file_write / file_edit | 允许 | **拦截** | 允许 |
| shell_exec（只读命令） | 允许 | 允许 | 允许 |
| shell_exec（写入/执行命令） | 允许 | **拦截** | 允许 |
| git_op（读：log/diff/status） | 允许 | 允许 | 允许 |
| git_op（写：commit/push/reset） | 允许 | **拦截** | 允许 |
| mcp 工具 | 允许 | **拦截** | 允许 |

> **执行人注意：** Plan 模式的核心判断是"这个操作会不会改变文件系统或外部状态"。对于 shell_exec，需要分析命令参数判断是否有副作用（启发式：检测 `rm`、`mv`、`cp`、`git push`、`git commit` 等关键词）。不要试图做完美的 shell 命令分析——宁可误拦也不要漏放。

### Step 1：创建 `src/agent/work-modes.ts`

关键类型定义（非完整实现，仅类型骨架）：

```typescript
// src/agent/work-modes.ts

/** 工作模式（蓝图第十二节） */
export type WorkMode = 'build' | 'plan' | 'compose';

/** 操作检查的结果 */
export interface ModeCheckResult {
  allowed: boolean;
  /** 被拦截时的人类可读原因 */
  reason?: string;
}

/** Compose 模式的管线阶段 */
export type ComposePhase = 'requirements' | 'coding' | 'testing' | 'review';
```

WorkModeController 类需要以下公开方法：

- `getMode(): WorkMode` — 获取当前模式
- `setMode(mode: WorkMode): void` — 切换模式
- `checkOperation(toolName: string, args: Record<string, unknown>): ModeCheckResult` — 检查操作是否被允许
- `getComposePhase(): ComposePhase | null` — 获取当前 Compose 阶段（仅 Compose 模式有效）
- `advanceComposePhase(): void` — 推进 Compose 管线到下一阶段

**Plan 模式拦截列表**（常量 `READ_ONLY_TOOLS`）：

```typescript
const READ_ONLY_TOOLS = new Set([
  'file_read', 'file_search', 'code_search', 'list_directory',
]);

const WRITE_TOOL_PATTERNS = new Set([
  'file_write', 'file_edit', 'shell_exec', 'git_op',
]);
```

对于 `shell_exec`，在 Plan 模式下需分析 args.command 字符串，启发式判断是否有副作用。

### Step 2：集成到 ToolExecutor

不修改 ToolExecutor 类本身，在 ServiceContext 构建时创建包装函数，通过已有的 `setToolExecutor` 替换原始 executor：

```typescript
const guardedExecute = async (toolName: string, args: Record<string, unknown>) => {
  const check = workModeController.checkOperation(toolName, args);
  if (!check.allowed) {
    return { content: `[${check.reason}] 操作被拦截。`, isError: true };
  }
  return toolExecutor.execute(toolName, args);
};
```

### Step 3：扩展 ServiceContext + CommandBridge

- ServiceContext 接口新增 `workModeController: WorkModeController`，在 `buildServiceContext` 中创建实例注入
- CommandBridge 接口新增 `setWorkMode: (mode: WorkMode) => void`，实现时同步更新 StatusBar 的 `workMode` prop

### Step 4：单元测试

| # | 用例 | 验证点 |
|---|---|---|
| 1 | Build 模式允许 file_write | `checkOperation('file_write', {})` → allowed: true |
| 2 | Plan 模式拦截 file_write | allowed: false, reason 含 "Plan mode" |
| 3 | Plan 模式允许 file_read | allowed: true |
| 4 | Plan 模式拦截 shell_exec 写入命令 | `checkOperation('shell_exec', { command: 'rm -rf' })` → allowed: false |
| 5 | Plan 模式允许 shell_exec 只读命令 | `checkOperation('shell_exec', { command: 'ls -la' })` → allowed: true |
| 6 | Compose 模式允许所有操作 | 类似 Build，全放行 |
| 7 | 模式切换后立即生效 | setMode → checkOperation 返回新结果 |

---

## Task 2：/build、/plan、/compose 命令

> **目标：** 创建三个命令文件，遵循 Phase 17b 建立的 CommandDefinition 模式。

### 设计说明

三个命令结构与 Phase 17b 的 `autonomy.ts` 完全对称。使用工厂函数减少重复。

### Step 1：创建 `src/cli/commands/work-modes.ts`

```typescript
// src/cli/commands/work-modes.ts
// 关键设计：工厂函数 + 模式说明表

const MODE_INFO: Record<WorkMode, { label: string; allowed: string; blocked: string }> = {
  build: {
    label: 'Build（读写执行）',
    allowed: '文件读写、Shell 执行、Git 操作、MCP 工具',
    blocked: '无限制',
  },
  plan: {
    label: 'Plan（只读分析）',
    allowed: '文件读取、代码搜索、目录浏览、只读 Git 命令',
    blocked: '文件写入/编辑、Shell 写入命令、Git 写操作、MCP 工具',
  },
  compose: {
    label: 'Compose（编排全流程）',
    allowed: '全部操作 + 自动管线编排（需求→编码→测试→审查）',
    blocked: '无限制（管线自动推进）',
  },
};
```

每个命令的 handler 逻辑：
1. 调用 `ctx.commandBridge.setWorkMode(mode)`
2. 返回 `CommandHandlerResult` 包含模式切换确认信息（允许/拦截说明）

导出三个命令：`buildCommand`、`planCommand`、`composeCommand`。

### Step 2：注册命令

在 App.tsx 的 CommandRegistry 初始化处注册：

```typescript
commandRegistryRef.current.register(buildCommand);
commandRegistryRef.current.register(planCommand);
commandRegistryRef.current.register(composeCommand);
```

在 `src/cli/commands/index.ts` 中 re-export。

### Step 3：单元测试

每个命令至少 1 个测试，验证 handler 返回正确的 `CommandHandlerResult` 且 `commandBridge.setWorkMode` 被调用。

---

## Task 3：StepCard 组件

> **目标：** 创建 Ink 组件渲染单个 PlanStep，显示状态、描述、依赖关系。

### 设计说明

StepCard 是纯展示组件（不持有状态），由父组件 StepEditor 控制选中/编辑行为。

### Step 1：创建 `src/cli/components/StepCard.tsx`

Props 接口：

```typescript
export interface StepCardProps {
  /** 步骤数据 */
  step: PlanStep;
  /** 显示序号（从 1 开始） */
  index: number;
  /** 是否被选中（编辑模式） */
  isSelected: boolean;
  /** 步骤总数（用于进度显示） */
  total: number;
}
```

渲染规格：
- 左侧：序号 + 状态图标
- 中间：描述文本（截断到 60 字符 + '...'）
- 右侧：依赖标记（如 `deps: 1,3`）

状态颜色映射（使用 Ink 的 `<Text color="">`）：

| StepStatus | 颜色 | 图标 |
|---|---|---|
| pending | gray | `[ ]` |
| in_progress | yellow | `[~]` |
| completed | green | `[x]` |
| failed | red | `[!]` |
| skipped | gray + dim | `[-]` |

选中时：整行加反色背景（`<Text inverse>`）或前缀箭头 `>`。

> **执行人注意：** 使用 Ink 的 `<Box>` 和 `<Text>` 组件，不要用 chalk 直接拼字符串——chalk 在 Ink 渲染循环中会导致重绘闪烁。

---

## Task 4：StepEditor 组件

> **目标：** 创建完整的步骤列表编辑器，支持选择、编辑、删除、重排。

### 设计说明

StepEditor 是一个交互式 Ink 组件，在 /goal 计划生成后展示。用户通过键盘操作审查和修改计划，确认后开始执行。

### Step 1：创建 `src/cli/components/StepEditor.tsx`

Props 接口：

```typescript
export interface StepEditorProps {
  /** 初始计划 */
  plan: GoalPlan;
  /** 用户确认后的回调（传入修改后的步骤列表） */
  onConfirm: (steps: PlanStep[]) => void;
  /** 用户取消的回调 */
  onCancel: () => void;
}
```

内部状态（使用 `useState`）：
- `steps: PlanStep[]` — 当前步骤列表（可编辑的副本）
- `cursorIndex: number` — 当前选中行
- `isEditing: boolean` — 是否在编辑某步骤的描述
- `editBuffer: string` — 编辑时的输入缓冲

### Step 2：键盘交互（使用 Ink 的 `useInput` hook）

| 按键 | 行为 |
|---|---|
| `↑/↓` 或 `k/j` | 光标上移/下移 |
| `e` | 进入编辑模式（当前步骤描述） |
| `d` | 删除当前步骤（二次确认） |
| `Alt+↑/↓` | 将当前步骤上移/下移一位（重排） |
| `Enter` | 编辑模式确认 / 非编辑模式确认整个计划 |
| `Escape` | 退出编辑 / 取消整个计划 |

> **执行人注意：** 键位冲突时以可用性为准，在组件底部显示快捷键提示行。Ink 测试用 `ink-testing-library` 的 `render` + `stdin.write` 模拟键盘。

### Step 3：编辑模式与确认

进入编辑模式后，当前步骤描述行变为可编辑文本，`useStdin` 捕获输入填充 `editBuffer`。Enter 确认修改，Escape 放弃。

确认时调用 `onConfirm(steps)`，取消时调用 `onCancel()`。底部提示行：`↑↓ 导航 | e 编辑 | d 删除 | Alt+↑↓ 重排 | Enter 确认 | Esc 取消`

### Step 4：单元测试

| # | 用例 | 验证点 |
|---|---|---|
| 1 | 渲染 5 个步骤 | 输出包含所有步骤描述 |
| 2 | 删除步骤 | steps 数组减少 1 |
| 3 | 重排步骤 | 步骤顺序变化，dependencies 不自动更新（留给 LLM 重新分析） |
| 4 | 编辑步骤描述 | 修改后 steps[i].description 更新 |
| 5 | 确认后 onConfirm 被调用 | 传入修改后的 steps |

> **执行人注意：** Ink 组件的测试用 `ink-testing-library` 的 `render` + `stdin.write` 模拟键盘输入。

---

## Task 5：集成到 /goal 流程 + 测试

> **目标：** 在 /goal 命令的计划生成后接入 StepEditor，注册新命令，完成全量测试。

### Step 1：修改 /goal 命令流程

当前 /goal 流程（Phase 9）：
```
输入 → GoalParser.parse() → 展示文本计划 → 自动开始执行
```

修改后：
```
输入 → GoalParser.parse() → 渲染 StepEditor → 用户编辑/确认 → 开始执行
```

在 `src/cli/commands/goal.ts` 的 handler 中：

1. GoalParser.parse() 生成 GoalPlan
2. 通过 CommandBridge 通知 App 渲染 StepEditor 组件
3. 等待 StepEditor 的 onConfirm/onCancel 回调
4. 确认后，用修改后的 steps 更新 GoalPlan 并开始执行
5. 取消后，显示"目标已取消"

**实现方式：** 在 CommandBridge 中新增 `requestPlanEdit(plan: GoalPlan): Promise<PlanStep[] | null>` 方法。返回 null 表示取消。

> **执行人注意：** 这是一个异步交互——命令 handler 需要 await 用户在 StepEditor 中的操作。实现方式类似 Phase 17b 的 `requestConfirm`：通过 pendingConfirmRef 机制，在 App.tsx 中设置状态触发 StepEditor 渲染，用户操作后 resolve Promise。

### Step 2：App.tsx 集成

在 App.tsx 中添加 `editingPlan` 状态（`useState<GoalPlan | null>`），非 null 时在 ChatView 下方渲染 `<StepEditor>`。onConfirm 回调 resolve pending promise 并传入 steps，onCancel 回调 resolve null。

### Step 3：Compose 模式管线（基础框架）

Compose 模式的管线执行是一个长期功能，本 Phase 只搭建框架。在 `WorkModeController` 中实现 `advanceComposePhase()`，按顺序推进四个阶段（需求分析→编码→测试→审查），每个阶段自动进入下一个。具体执行逻辑标记为 TODO。

> **执行人注意：** Compose 的完整实现是独立的 Phase 级工作量，本 Phase 重点是 WorkModeController 的状态管理和模式切换。

### Step 4：注册所有新命令 + 更新 index.ts

```typescript
// src/cli/commands/index.ts 新增
export * from './work-modes.js';
```

App.tsx 中注册 buildCommand、planCommand、composeCommand。

### Step 5：全量测试

新增测试清单：

| 模块 | 测试数 | 关键验证点 |
|---|---|---|
| WorkModeController | 7 | 模式权限矩阵、shell_exec 启发式判断 |
| /build /plan /compose 命令 | 3 | 模式切换 + CommandBridge 调用 |
| StepCard 组件 | 2 | 各状态渲染正确 |
| StepEditor 组件 | 5 | 删除/编辑/重排/确认/取消 |
| /goal 集成 | 2 | 计划编辑后执行、取消后中止 |
| **合计** | **19** | |

---

## 验收标准

1. **WorkModeController** 三种模式权限矩阵正确，Plan 模式拦截所有写入操作
2. **/build、/plan、/compose** 命令可用，StatusBar 的 workMode prop 实时更新
3. **StepCard** 组件正确渲染 5 种状态的步骤
4. **StepEditor** 支持键盘导航、编辑、删除、重排、确认/取消
5. **/goal 集成** 计划生成后弹出 StepEditor，用户确认后执行修改后的计划
6. **新增测试 >= 19 个**，全部通过
7. **构建通过**：`pnpm build && pnpm typecheck` 无错误

---

## 对下一阶段的提醒

1. **Compose 管线完整实现**：当前只有骨架，完整实现（需求分析→编码→测试→审查）是独立的 Phase 级工作量
2. **shell_exec 启发式判断的局限**：Plan 模式对 shell 命令的拦截基于关键词匹配，长期方案是用 LLM 分类命令副作用
3. **StepEditor 的 undo/redo**：当前没有撤销功能，用户误删步骤后只能重新 /goal
4. **MCP 工具在 Plan 模式下的处理**：当前一律拦截。后续可让 MCP 工具声明 `readOnly: boolean` 元数据
5. **StepEditor 与 CheckpointWriter 协作**：计划修改后应创建检查点，方便回滚到修改前的计划
