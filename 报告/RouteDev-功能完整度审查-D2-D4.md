# RouteDev 功能完整度审查报告（Dimension 2 & Dimension 4）

> **审查基线：** RouteDev v4.5.4（Phase 60 发布版 + Phase 61-73 后续迭代）  
> **审查维度：** 维度 2 — 用户场景闭环完整性；维度 4 — 错误路径完整性  
> **审查日期：** 2026-07-08  
> **审查范围：** 仅评估功能完整度，不评价代码质量、性能或类型安全

---

## 一、审查说明

本次审查依据 `C:\Users\杨铭\Desktop\Agent\报告\RouteDev-功能完整度审查提示词.md` 中维度 2 的 14 个场景与维度 4 的 12 条错误路径，逐项核对代码实现与闭环完整性。所有判定基于当前磁盘代码（非文档声称），并给出证据位置与修复建议。

**已核对的源代码：**
- `src/runtime/goal-runner.ts`（/goal 全流程、迭代闭环、计划编辑）
- `src/agent/loop.ts`（ReAct Agent Loop、工具确认、abort、follow-up）
- `src/agent/task-orchestrator.ts`（意图判定、需求澄清入口）
- `src/tools/builtin/spawn-agent.ts`（子 Agent 工具、角色白名单）
- `src/agent/multi/worker-executor.ts`（Worker 异常隔离、重试、熔断）
- `src/agent/multi/orchestrator.ts`（步骤依赖分析、并行组生成）
- `desktop/main/engine-bridge.ts`（IPC 桥接、/goal 分发、follow-up 队列）
- `desktop/main/index.ts`（IPC handler 实现）
- `desktop/preload/index.ts`（IPC 暴露面）
- `src/config/loader.ts`（配置加载、环境变量、备份恢复）
- `src/harness/checkpoint-manager.ts`（Checkpoint 创建/回滚）
- `src/harness/experiment-manager.ts`（实验分支创建/采纳/丢弃）

---

## 二、Dimension 2：用户场景闭环完整性

### 2.1 普通对话闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| 用户输入 | `ChatPage` → `chat:send` | ✅ |
| 分类/路由 | `engine-bridge.sendChat` L264-266 | ✅ |
| LLM 调用/流式回传 | `agentLoop.run` → `text_delta` | ✅ |
| 工具确认 | `onConfirmTool` → `chat:confirm-tool` | ✅ |
| 完成 | `done` 事件 | ✅ |

**判定：Complete**

普通对话主链路完整。唯一注意点：`sendChat` 中 `/goal` 被拦截后仅发送 `done`，没有普通 `text_delta`，这是有意设计（GoalExecutionCard 靠 `goal:event` 渲染）。

---

### 2.2 /goal 全流程闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| 命令解析 | `goal-runner.handleGoalCommand` L370-499 | ✅ |
| 目标澄清 | `clarifyGoalIfNeeded` L304-368（Electron） | ✅ |
| GoalParser 分解 | `parser.parse` L430-437 | ✅ |
| 计划确认（semi/manual） | `requestPlanEdit` + StepEditor | ✅ |
| PathRouter 选路径 | `pathRouter.route` L1075-1084 | ✅ |
| 执行 single/dag/compose | `executePlanWithSingleAgent` / `executePlanWithDag` / `executePlanWithCompose` | ✅ |
| GoalVerifier 验证 | `verifyPlan` L506-622 | ✅ |
| 迭代闭环/DualLoop | `legacyIterativeLoop` L796-877 / `runDualLoopPlan` L890-1004 | ✅ |
| 完成摘要 | `renderGoalCompletionSummary` + `done` 事件 L1191-1209 | ✅ |

**判定：Complete（主链路完整）**

断点与风险：
- `executeGoalCommand` 中 `requestPlanEdit` 依赖 `pendingPlanEditResolvers`，用户关闭 StepEditor 不响应时会造成 Promise 永久挂起（见维度 4 条目）。
- `goal-runner` 中多 Agent 编排函数 `executePlanWithMultiAgent` 已在 Phase 58 删除，`spawn_agent` 主要通过工具层使用，goal 流程内部的多 Agent 并行路径实际由 DAG/Compose 路径替代。

---

### 2.3 工具调用确认闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| Agent 决定调用工具 | `agentLoop.run` L1077 | ✅ |
| 渲染层推送确认请求 | `engine-bridge` L349-360 | ✅ |
| 用户确认/拒绝 | `chat:confirm-tool` → `resolveToolConfirm` | ✅ |
| 继续执行 | `pendingConfirmRef.current.resolve` | ✅ |
| 拒绝路径恢复 | `loop.ts` L1358-1377 注入 `[用户拒绝了此工具调用]` | ✅ |

**判定：Complete**

双向 IPC 对称，拒绝后结果回注 LLM 上下文，Agent 可自主调整策略。

---

### 2.4 计划编辑闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| semi/manual 触发 | `goal-runner.handleGoalCommand` L452-467 | ✅ |
| `onPlanEditRequest` 推送 | `engine-bridge.executeGoalCommand` L761-781 | ✅ |
| StepEditor 显示/编辑 | 渲染层 | ✅ |
| `plan:edit-response` 回传 | `desktop/main/index.ts` L359-364 | ✅ |
| resolver resolve | `engine-bridge.resolvePlanEdit` L511-517 | ✅ |

**判定：Partial**

潜在断点：`pendingPlanEditResolvers` 中的 Promise 只有在用户响应时才会被 resolve。若用户直接关闭 StepEditor 或渲染进程崩溃，Map 中的 Promise 将永久挂起，`goal-runner` 也永久等待。无超时/清理机制。

---

### 2.5 多 Agent 协作闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| `spawn_agent` 工具 | `src/tools/builtin/spawn-agent.ts` | ✅ |
| 子 Agent registry clone + 移除 spawn_agent | `createChildRegistry` L135-193 | ✅ |
| 角色工具白名单 | `SUBAGENT_TOOL_WHITELIST` L71-78 | ✅ |
| Blackboard 写入/读取 | `blackboard.addCompletedStep` 在 DAG/Compose 路径中调用 | ✅ |
| 主 Agent 汇总 | `goal-runner` 通过 blackboard 上下文汇总 | ⚠️ |

**判定：Partial**

- `spawn_agent` 工具实现完整，支持角色隔离、深度约束、委托体系。
- 但 `goal-runner.ts` 中原 `executePlanWithMultiAgent` 已在 Phase 58 删除，goal 流程内部不再显式 spawn 多个子 Agent 并行执行原始 plan 步骤，而是依赖 DAG/Compose 路径。
- 因此"主 Agent → 子 Agent → 结果回传 Blackboard → 主 Agent 汇总"的原始闭环在 goal 流程中并非主要执行路径，功能存在但入口发生迁移。

---

### 2.6 分支实验闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| 创建实验 | `experiment-manager.createExperiment` | ✅ |
| 执行 | 用户在实验 worktree 中继续操作 | ✅ |
| 查看 diff | `experiment:get-diff` → `engine.getExperimentDiff` | ✅ |
| 采纳/丢弃 | `experiment:adopt` / `experiment:discard` | ✅ |
| worktree 清理 | `discardExperiment` / `adoptExperiment` | ✅ |

**判定：Complete**

实验分支 IPC 与后端实现均存在，采纳后 `adoptExperiment` 会合并并清理 worktree。

---

### 2.7 配置变更闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| SettingsPage 修改 | 渲染层 | ✅ |
| `config:save` | `desktop/main/index.ts` L419-428 | ✅ |
| 写 config.yaml | `saveConfig` | ✅ |
| watcher 检测变更 | `src/config/watcher.ts` | ❌ |
| 热重载 → 通知渲染层 | `onConfigReloaded` | ⚠️ |

**判定：Partial（Broken 倾向）**

- `src/config/watcher.ts` 文件不存在（Glob 搜索未找到）。
- `config:save` 调用后会同步 `engine.updateConfig(config)`，使当前进程配置生效，并通过 `config:reloaded` 事件通知渲染层（`engine-bridge.reloadConfig` 会触发 `onConfigReloaded`）。
- 但**文件变更后的自动热重载**（watcher 检测磁盘变更 → 自动 reload）缺失，用户手动修改 YAML 文件不会触发应用内配置刷新。

---

### 2.8 MCP 集成闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| 目录浏览 | `mcp:catalog:list` / `mcp:catalog:search` | ✅ |
| 安装 | `mcp:install` → `engine.installServer` | ✅ |
| 连接 | `mcp:connect` → `engine.connectServer` | ✅ |
| 工具注册 | `mcpManager` 注册到 `ToolRegistry` | ✅ |
| Agent 调用 | `toolExecutor` 执行 MCP 工具 | ✅ |
| 断开 | `mcp:disconnect` | ✅ |

**判定：Complete**

MCP IPC 与后端实现均存在，连接失败会通过返回 `{ success: false, error }` 反馈给 UI。

---

### 2.9 Checkpoint 回滚闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| Agent 执行中创建 Checkpoint | `checkpointManager.create` | ✅ |
| `checkpoint:list` | `desktop/main/index.ts` L784-787 | ✅ |
| `checkpoint:rollback` | `desktop/main/index.ts` L790-796 | ✅ |
| 工作区干净检查 | `CheckpointManager.rollback` | ✅ |
| git checkout 恢复 | `CheckpointManager.rollback` | ✅ |

**判定：Complete**

`CheckpointManager.rollback` 会检查工作区是否干净，不干净时返回 `{ success: false, error: '工作区不干净' }` 并提示用户。

---

### 2.10 Follow-up 插话闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| `agent:followUp` | `desktop/main/index.ts` L804-814 | ✅ |
| 入队 | `agentLoop.followUp` | ✅ |
| `agent:queueStatus` | L840-843 | ✅ |
| 按模式投递 | `drainFollowUpQueue`（all / one-at-a-time） | ✅ |
| `agent:removeFollowUp` | L852-858 | ✅ |
| 队列持久化/崩溃恢复 | 无 | ❌ |

**判定：Partial**

Follow-up 队列仅在内存中保存，进程崩溃或重启后丢失，无持久化与崩溃恢复机制。

---

### 2.11 需求澄清闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| TaskOrchestrator 判定 | `task-orchestrator.ts` L104-110 | ✅ |
| `skipIfConfident` 路径 | `shouldSkipRequirements` L157-171 | ✅ |
| RequirementsClarifier 分析 | `requirements-clarifier.ts` | ❌ |
| 生成追问/用户回答 | 未在 TaskOrchestrator 中观察到调用 | ❌ |

**判定：Partial**

- `TaskOrchestrator` 会判定是否跳过需求确认（`shouldSkipRequirements`），并在不跳过时返回 `pipeline_start`。
- 但 `TaskOrchestrator.handle` 中**没有调用 `RequirementsClarifier` 生成追问**的代码，需求澄清的实际生成追问与收集回答链路未在代码中完整呈现。
- `requirements-clarifier.ts` 文件在 `src/` 下不存在。
- `goal-runner.ts` 中有 `clarifyGoalIfNeeded`（基于 LLM 检测模糊参数），但那是 /goal 命令的专属澄清，不是 TaskOrchestrator 通用需求澄清。

---

### 2.12 迭代验证闭环

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| GoalVerifier 失败 | `verifyPlan` 返回 `passed=false` | ✅ |
| `iterative.enabled` 触发 | `legacyIterativeLoop` L799-800 | ✅ |
| GoalParser 生成补救步骤 | L838-844 | ✅ |
| 执行补救步骤 | `executeRemediationStep` L688-788 | ✅ |
| 再次验证 | L859 | ✅ |
| maxRounds 边界 | L802 / L864-874 | ✅ |

**判定：Complete**

迭代闭环完整，达到 `maxRounds` 时会明确提示用户 `"已达到最大迭代次数 ${maxRounds}，停止迭代"`。

---

### 2.13 对话 → /goal 切换

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| 普通对话中输入 `/goal` | `engine-bridge.sendChat` L249-253 | ✅ |
| 切换到 goal 流程 | `executeCommand` → `executeGoalCommand` | ✅ |
| conversationHistory 处理 | `executeGoalCommand` 传入 `{ current: this.conversationHistory }` | ✅ |

**判定：Complete**

切换链路完整，`/goal` 被拦截后走 goal 流程，并共享当前对话历史。

---

### 2.14 /goal → 工具确认 → 恢复

| 环节 | 实现位置 | 状态 |
|------|---------|------|
| goal 执行中触发工具确认 | `goal-runner.executeSingleStep` L1364-1377 | ✅ |
| 确认后恢复 | `pendingConfirmRef.current.resolve` | ✅ |
| 恢复到正确 goal 步骤 | `executeSingleStep` 继续执行当前 step | ✅ |

**判定：Complete**

GoalRunner 与 sendChat 共享同一个 `pendingConfirmRef`，确认后正确恢复到 goal 步骤，不会误入 sendChat 路径。

---

## 三、Dimension 4：错误路径完整性

### 4.1 LLM 调用失败路径

| 错误类型 | 处理位置 | 用户反馈 | 恢复路径 |
|---------|---------|---------|---------|
| 超时 | `loop.ts` L1007-1013 catch → 重试/报错 | `error` 事件 | 连续错误达上限后终止 |
| API Key 错误 | `engine-bridge.sendChat` L278-284 | `error` 事件 | 无，需用户配置 |
| 限流 | `loop.ts` catch → consecutiveErrors 重试 | `error` 事件 | 最多 `maxConsecutiveErrors` 次 |
| 网络断开 | `loop.ts` catch | `error` 事件 | 重试 |
| 降级链触发 | `modelRouter.route` + `notifyRoutingFallback` | `progress` 提示 | 自动降级到可用模型 |

**判定：Partial**

主路径完整，但存在一个断点：`engine-bridge.sendChat` L278-284 在检测到 provider 不可用时直接 `return`，**没有发送 `done` 事件**。渲染层可能因此永久处于 loading 状态。

---

### 4.2 工具执行失败路径

| 错误类型 | 处理位置 | 行为 |
|---------|---------|------|
| 文件不存在 | `tools/executor.ts` / 各工具实现 | 返回 `[工具错误]` 并 `isError=true` |
| 权限拒绝 | 安全扫描/执行器 | 返回错误结果注入 LLM 上下文 |
| 命令超时 | `shell_exec` 等工具 | 返回超时错误 |
| 熔断器打开 | `worker-executor.ts` L227-246 | Worker 直接返回失败，不施压下游 |

**判定：Complete**

工具失败不会崩溃 Agent Loop，错误信息会回注上下文让 LLM 自主处理。

---

### 4.3 /goal 执行中失败路径

| 失败点 | 处理位置 | 是否生成结构化失败报告 |
|-------|---------|----------------|
| GoalParser 失败 | `handleGoalCommand` catch | ❌ 仅返回错误消息 |
| 某步骤执行失败 | `executePlanWithSingleAgent` catch L1673-1695 | ❌ 仅标记 step 失败 |
| GoalVerifier 失败 | `verifyPlan` catch L616-620 | ❌ 仅标记 plan 失败 |
| 整体失败摘要 | `renderGoalCompletionSummary` | ⚠️ 文本摘要，非结构化报告 |

**判定：Missing**

审查提示词要求通过 `failure-report.ts` 生成结构化失败报告，但 `src/agent/failure-report.ts` 文件在磁盘上不存在，`goal-runner.ts` 中各失败点仅设置 `plan.status = 'failed'` 并调用 `addSystemMessage` 输出文本错误。/goal 失败时用户无法获得包含失败步骤、原因分类、建议行动、回滚指引的结构化报告。

---

### 4.4 IPC 通道失败路径

| 通道类型 | try-catch 覆盖 | 引擎未初始化处理 |
|---------|---------------|----------------|
| `ipcMain.handle` | 大部分有 try-catch | 多数返回默认值或错误对象 |
| `ipcMain.on` | 较少（fire-and-forget） | 通常静默忽略 |

**判定：Partial**

- `ipcMain.handle` 基本都有 try-catch 或引擎未初始化守卫。
- `chat:send`（`ipcMain.on`）在 `engine.sendChat` 内部异常时由 `.catch` 捕获并发送 `error` + `done`，覆盖较好。
- 但 `agent:followUp` / `agent:setFollowUpMode` / `agent:clearAllQueues` 等 `ipcMain.on` 通道在引擎未初始化或参数无效时仅 `console.warn`，**没有返回任何错误给渲染层**（单向通道本身无返回值，但可发送 `agent:queueStatus` 事件通知）。

---

### 4.5 MCP 连接失败路径

| 协议 | 失败处理 | UI 反馈 |
|-----|---------|--------|
| stdio/http/sse/streamable_http/websocket | `mcpManager.connect` 抛错 → `engine.connectServer` catch | `MCPConnectionResult { success: false, error }` |

**判定：Complete**

5 种传输协议的连接失败都会通过 `mcp:connect` 返回结果对象，UI 可据此显示错误。

---

### 4.6 Checkpoint 回滚失败路径

| 失败条件 | 处理位置 | 行为 |
|---------|---------|------|
| 工作区不干净 | `CheckpointManager.rollback` | 返回 `{ success: false, error: '工作区不干净' }` |
| git checkout 失败 | `CheckpointManager.rollback` | 返回 `{ success: false, error }` |
| hash 不匹配 | 创建/恢复时校验 | 失败时中止 |

**判定：Complete**

回滚失败路径完整，不会破坏性覆盖用户未提交修改。

---

### 4.7 配置加载失败路径

| 失败条件 | 处理位置 | 行为 |
|---------|---------|------|
| Zod 校验失败 | `loader.ts` L275-287 | 尝试 `.bak` 恢复，失败则抛错 |
| 环境变量缺失 | `replaceEnvVars` L18-30 | fail-fast 抛 `ConfigValidationError` |
| 文件不存在 | `loadYamlFile` L130-132 | 返回 null，使用默认值 |
| YAML 解析失败 | `loadYamlFile` L143-149 | 返回空对象，使用默认值 |

**判定：Complete**

配置加载失败路径完整，启动时会给出明确错误提示，不会用无效配置静默运行。

---

### 4.8 子 Agent 异常隔离

| 隔离机制 | 实现位置 | 状态 |
|---------|---------|------|
| Worker 异常捕获 | `executeWorkerIsolated` | ✅ |
| 异常不影响主 Agent | `worker-executor.execute` 返回结构化 `WorkerResult` | ✅ |
| 不影响其他 Worker | 各 Worker 独立调用 `executeWorkerIsolated` | ✅ |
| 自动重试 | `executeWorkerIsolated` 对可重试错误重试 | ✅ |
| 熔断器 | `CircuitBreaker` L227-246 | ✅ |

**判定：Complete**

子 Agent 异常被完整隔离，不会上溯影响主 Agent 或其他 Worker。

---

### 4.9 abortController 中止路径

| 中止点 | 实现位置 | 是否生效 |
|-------|---------|---------|
| 用户点击停止 | `engine-bridge.stopGeneration` L524-529 | ✅ |
| LLM stream 中止 | `loop.ts` L1839 / L939-943 | ✅ |
| Agent Loop 迭代中止 | `loop.ts` L936-944 | ✅ |
| 已开始执行的工具 | `shell_exec` 等工具 | ⚠️ 不立即中止 |

**判定：Partial**

AbortSignal 可以中止 LLM 流和 Agent Loop 迭代，但**已经开始执行的工具（如 `shell_exec`）不会立即被 kill**，需要等待工具自身超时。对于长时间运行的 shell 命令，用户体验上"停止"不会立刻生效。

---

### 4.10 pendingPlanEditResolvers 泄漏

| 问题 | 证据 | 影响 |
|-----|------|------|
| 用户关闭 StepEditor 不响应 | `engine-bridge.resolvePlanEdit` 仅在响应时删除 resolver | Promise 永久挂起，goal 流程卡住 |
| 渲染进程崩溃 | 同上 | resolver 永久挂起 |
| 无超时清理 | 无 `setTimeout` 或窗口关闭监听器 | 内存泄漏 + 功能卡死 |

**判定：Broken**

这是明确的断点。`pendingPlanEditResolvers` 只有成功响应时才会被清理，没有超时、取消或窗口关闭清理机制。

---

### 4.11 迭代闭环达 maxRounds 后

| 行为 | 实现位置 | 状态 |
|-----|---------|------|
| 明确提示用户 | `legacyIterativeLoop` L873 | ✅ |
| DualLoop 耗尽提示 | `runDualLoopPlan` L986-988 | ✅ |
| plan.status 置为 failed | `executeGoalPlan` L1140-1144 / `runDualLoopPlan` L1174 | ✅ |

**判定：Complete**

达到最大迭代次数后有明确用户提示，不会静默失败。

---

### 4.12 fail-open 守卫的可观测性

| 安全模块 | 失败处理 | 用户感知 |
|---------|---------|--------|
| SkillSecurityGate | `console.warn`（`engine-bridge.ts` L1136-1139） | ❌ 仅日志 |
| HookRunner | `logger.error` / `logger.warn`（`loop.ts` L600 等） | ❌ 仅日志 |
| CiteResolver | `logger.debug`（`loop.ts` L460-464） | ❌ 仅日志 |
| MacroManager | `logger.warn`（`macros/manager.ts`） | ❌ 仅日志 |
| BudgetMonitor | `logger.warn`（`loop.ts` L1589-L1601） | ❌ 仅日志 |
| ContextPacker | `logger.warn`（`worker-executor.ts` L331） | ❌ 仅日志 |
| CircuitBreaker 检查异常 | `catch { }`（`worker-executor.ts` L243-245） | ❌ 静默 |

**判定：Partial**

Phase 59/后续各阶段的可选安全/监控模块在装配或运行时失败时普遍采用 `logger.warn` fail-open 策略，但**没有向渲染层发送事件或提示**，用户无法感知到安全模块未生效。这与审查提示词中"用户是否能感知到安全模块未生效"的要求不符。

---

## 四、Findings 明细

```yaml
- id: F-001
  level: Partial
  dimension: 维度2-用户场景闭环完整性
  location:
    file: src/config/watcher.ts
    line: 文件不存在
  title: 配置热重载 watcher 缺失
  problem: |
    审查提示词维度 2.7 要求"save → reload → 通知"链路完整，但 src/config/watcher.ts 不存在。
    config:save 后通过 engine.updateConfig(config) 使当前进程配置生效，并通过 config:reloaded
    事件通知渲染层；但用户手动修改磁盘上的 config.yaml 后，应用不会自动热重载。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 296-298
      text: "场景七：配置变更闭环 — ... watcher 检测变更 → 热重载 → 通知渲染层 ConfigReloadNotice"
    code_location:
      file: desktop/main/index.ts
      line: 419-428
      text: "config:save 仅调用 saveConfig + engine?.updateConfig(config)，无文件监听注册"
    search_performed:
      - pattern: "**/config/watcher.ts"
        scope: "routedev/"
        match_count: 0
      - pattern: "chokidar|fs.watch|watchFile"
        scope: "src/config/"
        match_count: 0
  impact: |
    用户无法通过直接编辑 YAML 文件实现热重载；SettingsPage 外的配置变更需要手动重启或点击"重新加载"。
  recommendation: |
    补全 src/config/watcher.ts，使用 fs.watch 或 chokidar 监听全局/项目配置文件变更；
    变更后调用 loadConfig + engine.reloadConfig + 发送 config:reloaded 事件到渲染层。
  status: open

- id: F-002
  level: Partial
  dimension: 维度2-用户场景闭环完整性
  location:
    file: src/agent/task-orchestrator.ts
    line: 104-110
  title: TaskOrchestrator 未实际调用 RequirementsClarifier
  problem: |
    维度 2.11 要求需求澄清闭环完整，但 TaskOrchestrator.handle 仅在 shouldSkipRequirements
    返回 false 时返回 pipeline_start，并未调用 RequirementsClarifier 生成追问并收集用户回答。
    src/requirements-clarifier.ts 或 src/agent/requirements-clarifier.ts 文件在磁盘上均不存在。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 301-302
      text: "场景十一：需求澄清闭环 — TaskOrchestrator 判定需澄清 → RequirementsClarifier 分析模糊度 → 生成追问 → 用户回答 → 继续/降级"
    code_location:
      file: src/agent/task-orchestrator.ts
      line: 104-110
      text: |
        if (this.shouldSkipRequirements(userInput, classification)) {
          this.stage = 'planning';
          return { type: 'pipeline_start', intent, input: userInput };
        }
        return { type: 'pipeline_start', intent, input: userInput };
    search_performed:
      - pattern: "requirements-clarifier"
        scope: "src/"
        match_count: 0
      - pattern: "RequirementsClarifier"
        scope: "src/agent/"
        match_count: 0
  impact: |
    需求澄清功能只有入口判断，没有生成追问和收集回答的实际执行，复杂任务可能在没有充分澄清的情况下直接进入规划/执行。
  recommendation: |
    在 TaskOrchestrator 中接入 RequirementsClarifier：当需要澄清时返回 clarification_needed action，
    由渲染层展示追问并回传答案后再进入 planning；如暂不需要完整实现，应将 autoRequirements 默认关闭并在文档中说明。
  status: open

- id: F-003
  level: Partial
  dimension: 维度2-用户场景闭环完整性
  location:
    file: src/runtime/goal-runner.ts
    line: 1967-1969
  title: Goal 流程内多 Agent 编排路径已退化
  problem: |
    维度 2.5 要求多 Agent 协作闭环完整，但 goal-runner.ts 中 Phase 58 已删除
    executePlanWithMultiAgent，goal 流程内部不再显式 spawn 多个子 Agent 并行执行原始 plan 步骤，
    仅通过 DAG/Compose 路径实现并行。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 294-295
      text: "场景五：多 Agent 协作闭环 — 主 Agent 调用 spawn_agent → 子 Agent 创建 → 子 Agent 执行任务 → 结果回传 Blackboard → 主 Agent 汇总"
    code_location:
      file: src/runtime/goal-runner.ts
      line: 1967-1969
      text: "// Phase 58：executePlanWithMultiAgent（legacy 路径）已删除"
    search_performed:
      - pattern: "executePlanWithMultiAgent"
        scope: "src/"
        match_count: 0
  impact: |
    spawn_agent 工具本身可用，但 /goal 命令不再以"主 Agent spawn 多个子 Agent"的方式编排原始计划，
    多 Agent 协作的入口发生迁移，用户可能无法按预期触发。
  recommendation: |
    在文档中明确说明多 Agent 协作现在由 DAG/Compose 路径承载；如需保留 spawn_agent 主入口，
    应在 goal 流程中增加显式多 Agent 编排分支。
  status: open

- id: F-004
  level: Broken
  dimension: 维度4-错误路径完整性
  location:
    file: desktop/main/engine-bridge.ts
    line: 278-284
  title: sendChat provider 不可用时未发送 done 事件
  problem: |
    维度 4.1 要求 LLM 调用失败后用户可见反馈并终止 loading。engine-bridge.sendChat 在 provider
    不可用时发送 error 后直接 return，没有发送 chat:stream 的 done 事件。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 419
      text: "chat:send → chat:stream 事件链是否完整 — send 触发后，main 是否在所有路径（成功/失败/中止）都发送 chat:stream 的 done/error 事件，否则渲染层会永久 loading"
    code_location:
      file: desktop/main/engine-bridge.ts
      line: 278-284
      text: |
        if (!client || !client.isReady()) {
          this.options.onStream({ type: 'error', error: `提供商 ${routeDecision.providerId} 不可用。请检查 API Key 配置。` });
          return;
        }
    search_performed:
      - pattern: "onStream\\(\\{ type: 'done' \\})"
        scope: "desktop/main/engine-bridge.ts"
        match_count: 1
  impact: |
    渲染层在 provider 不可用时收到 error 后可能永久显示 loading，无法自动退出等待状态。
  recommendation: |
    在 engine-bridge.ts L284 返回前补发 this.options.onStream({ type: 'done' })。
  status: open

- id: F-005
  level: Broken
  dimension: 维度4-错误路径完整性
  location:
    file: desktop/main/engine-bridge.ts
    line: 761-781 / 511-517
  title: pendingPlanEditResolvers 存在 Promise 泄漏风险
  problem: |
    维度 4.10 要求检查用户关闭 StepEditor 未响应时是否会导致 Promise 永久挂起。
    engine-bridge.executeGoalCommand 中的 requestPlanEdit 将 resolver 存入
    pendingPlanEditResolvers，只有 resolvePlanEdit 被调用时才删除。若用户关闭 StepEditor
    或渲染进程崩溃，goal-runner 将永久等待。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 362-363
      text: "pendingPlanEditResolvers 泄漏 — 用户关闭 StepEditor 未响应时，pendingPlanEditResolvers Map 中的 Promise 是否会永久挂起 goal-runner"
    code_location:
      file: desktop/main/engine-bridge.ts
      line: 778-781
      text: |
        const edited = await new Promise<...>((resolve) => {
          this.pendingPlanEditResolvers.set(requestId, resolve);
          this.options.onPlanEditRequest!(requestId, planSnapshot);
        });
    code_location_2:
      file: desktop/main/engine-bridge.ts
      line: 511-517
      text: |
        resolvePlanEdit(requestId: string, steps: ...) {
          const resolver = this.pendingPlanEditResolvers.get(requestId);
          if (resolver) {
            this.pendingPlanEditResolvers.delete(requestId);
            resolver(steps);
          }
        }
    search_performed:
      - pattern: "pendingPlanEditResolvers"
        scope: "desktop/main/engine-bridge.ts"
        match_count: 6
  impact: |
    用户关闭计划编辑器后，/goal 流程卡住，后续 /goal 命令也无法执行（goalRunner 被占用）。
  recommendation: |
    为 pendingPlanEditResolvers 添加超时机制（如 5 分钟），超时后 resolve(null) 并删除；
    在窗口关闭或会话重置时清空 Map。
  status: open

- id: F-006
  level: Missing
  dimension: 维度4-错误路径完整性
  location:
    file: src/agent/failure-report.ts
    line: 文件不存在
  title: /goal 失败结构化报告模块缺失
  problem: |
    维度 4.3 要求 /goal 执行中失败时通过 failure-report.ts 生成结构化报告。但 src/agent/failure-report.ts
    在磁盘上不存在，goal-runner.ts 中各失败点仅设置 plan.status = 'failed' 并调用 addSystemMessage
    输出文本错误，无法生成包含失败步骤、原因分类、建议行动、回滚指引的结构化报告。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 355-356
      text: "/goal 执行中失败路径 — GoalParser 失败 / 某步骤执行失败 / GoalVerifier 失败，是否都能通过 failure-report.ts 生成结构化报告"
    code_location:
      file: src/runtime/goal-runner.ts
      line: 1673-1695
      text: "步骤失败仅设置 step.error 和 gateManager.updateGate，无 FailureReporter 调用"
    search_performed:
      - pattern: "failure-report"
        scope: "src/"
        match_count: 0
      - pattern: "FailureReporter|generateFailureReport"
        scope: "src/"
        match_count: 0
  impact: |
    /goal 失败时用户只能看到零散文本错误，无法获得结构化失败报告，不利于复盘和恢复。
  recommendation: |
    实现 src/agent/failure-report.ts，在 executeGoalPlan 的异常/失败出口调用 FailureReporter.generate(plan)，
    并通过 addSystemMessage 或 goal:event 推送给渲染层。
  status: open

- id: F-007
  level: Partial
  dimension: 维度4-错误路径完整性
  location:
    file: src/agent/loop.ts
    line: 1263-1276 / 1501-1517
  title: 工具执行开始后无法被 abort 立即中断
  problem: |
    维度 4.9 要求 abortController 中止路径能正确中止正在执行的 LLM 调用和工具调用。当前 AbortSignal
    只在 LLM stream 迭代中检查，已经开始执行的 shell_exec 等工具不会因为 abort 而立即被 kill。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 361
      text: "abortController 中止路径 — 用户点停止 / abortControllerRef.abort() 后，正在执行的 LLM 调用和工具调用是否都正确中止"
    code_location:
      file: src/agent/loop.ts
      line: 1263-1276
      text: "并行工具执行使用 Promise.allSettled，未传入 AbortSignal"
    code_location_2:
      file: src/agent/loop.ts
      line: 1501-1517
      text: "串行工具执行使用 await this.toolExecutor.executeToolStructured/executeTool(...)，未传入 signal"
    search_performed:
      - pattern: "executeTool\\(.*signal"
        scope: "src/"
        match_count: 0
  impact: |
    用户点击"停止"后，若当前正在执行长时间 shell 命令，UI 虽已停止接收流，但底层命令仍继续运行，可能产生意外副作用。
  recommendation: |
    将 signal 透传到 toolExecutor.executeTool / executeToolStructured，在支持的工具（如 shell_exec）内部
    监听 signal.aborted 并 kill 子进程。
  status: open

- id: F-008
  level: Partial
  dimension: 维度4-错误路径完整性
  location:
    file: 多个可选模块装配/调用点
    line: 详见 evidence
  title: fail-open 安全模块失败用户不可感知
  problem: |
    维度 4.12 要求 Phase 59 安全模块装配失败时用户能感知到安全模块未生效。代码中各可选模块失败时
    普遍仅 logger.warn / console.warn，没有向渲染层发送事件。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 364
      text: "fail-open 守卫的可观测性 — Phase 59 五个安全模块装配失败仅 logger.warn，用户是否能感知到安全模块未生效"
    code_location:
      file: desktop/main/engine-bridge.ts
      line: 1136-1139
      text: "createSecurityGateFromConfig catch 仅 console.warn，返回 undefined"
    code_location_2:
      file: src/agent/loop.ts
      line: 600
      text: "Hook execution failed, continuing — 仅 logger.error"
    code_location_3:
      file: src/agent/loop.ts
      line: 1589-1601
      text: "BudgetMonitor alert / check failed — 仅 logger.warn"
    code_location_4:
      file: src/agent/multi/worker-executor.ts
      line: 243-245
      text: "熔断器检查异常 catch { } 空处理"
    search_performed:
      - pattern: "security:module-failed|guard:failed"
        scope: "src/"
        match_count: 0
  impact: |
    当安全/监控模块未成功装配时，用户和 UI 都不知道保护已失效，可能误以为安全策略生效。
  recommendation: |
    定义统一的 security:module-failed 或 guard:failed 事件，在关键安全模块装配/调用失败时通过 IPC
    推送到渲染层，由设置页或状态栏显示警告。
  status: open

- id: F-009
  level: Partial
  dimension: 维度2-用户场景闭环完整性
  location:
    file: src/agent/loop.ts
    line: 154
  title: Follow-up 队列无持久化与崩溃恢复
  problem: |
    维度 2.10 要求检查队列持久化与崩溃恢复。ReActAgentLoop 的 followUpQueue 是纯内存数组，
    进程重启后丢失，无写入磁盘或会话恢复逻辑。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 300-301
      text: "场景十：Follow-up 插话闭环 — ... 检查队列持久化与崩溃恢复"
    code_location:
      file: src/agent/loop.ts
      line: 154
      text: "private followUpQueue: FollowUpMessage[] = [];"
    search_performed:
      - pattern: "followUpQueue"
        scope: "src/agent/loop.ts"
        match_count: 12
      - pattern: "session-state|follow-up.*persist|writeFile.*follow"
        scope: "src/"
        match_count: 0
  impact: |
    应用崩溃或重启后，用户之前排队的 follow-up 任务全部丢失。
  recommendation: |
    可选：将 follow-up 队列持久化到 .routedev/session-state.json，启动时恢复；
    或在 UI 层提示用户 follow-up 为当前会话级别。
  status: open

- id: F-010
  level: Partial
  dimension: 维度4-错误路径完整性
  location:
    file: desktop/main/index.ts
    line: 804-837
  title: Follow-up/Steering 单向 IPC 错误未反馈到渲染层
  problem: |
    维度 4.4 要求 IPC handler 的 try-catch 完整。agent:followUp、agent:clearAllQueues、
    agent:setFollowUpMode 等 ipcMain.on 通道在引擎未初始化或参数无效时仅 console.warn，
    没有通知渲染层。
  evidence:
    claim_source:
      file: RouteDev-功能完整度审查提示词.md
      line: 357-358
      text: "IPC 通道失败路径 — ipcMain.handle 中每个 handler 的 try-catch 是否完整，引擎未初始化时是否返回友好错误而非崩溃"
    code_location:
      file: desktop/main/index.ts
      line: 809-813
      text: "引擎未初始化时仅 console.warn('[agent:followUp] 引擎未初始化，调用被忽略')"
    code_location_2:
      file: desktop/main/index.ts
      line: 827-837
      text: "模式无效时仅 console.warn('[agent:setFollowUpMode] 无效 mode，调用被忽略')"
    search_performed:
      - pattern: "agent:queueStatus.*send|chat:stream.*error.*follow"
        scope: "desktop/main/index.ts"
        match_count: 0
  impact: |
    用户排队 follow-up 失败时看不到任何提示，可能误以为已入队。
  recommendation: |
    在单向 IPC 处理失败时发送 agent:queueStatus 或 chat:stream error 事件到渲染层，给出明确反馈。
  status: open
```

---

## 五、审查汇总

### 按级别统计（按场景/错误路径条目计数）

| 级别 | 数量 |
|------|------|
| Complete | 15 |
| Partial | 9 |
| Missing | 1 |
| Broken | 1 |
| Orphan | 0 |

### 按维度统计

| 维度 | Complete | Partial | Missing | Broken | Orphan |
|------|----------|---------|---------|--------|--------|
| 2. 用户场景闭环 | 9 | 5 | 0 | 0 | 0 |
| 4. 错误路径完整性 | 6 | 4 | 1 | 1 | 0 |

> 注：
> - Dimension 2 共 14 个场景：9 个 Complete，5 个 Partial（计划编辑、多 Agent、配置热重载、Follow-up、需求澄清）。
> - Dimension 4 共 12 条错误路径：6 个 Complete，4 个 Partial（LLM 调用失败、IPC 通道失败、abort 中止、fail-open 可观测性），1 个 Missing（failure-report.ts 缺失），1 个 Broken（pendingPlanEditResolvers 泄漏）。

### Findings 级别分布

| 级别 | 数量 | Findings |
|------|------|---------|
| Partial | 7 | F-001, F-002, F-003, F-007, F-008, F-009, F-010 |
| Missing | 1 | F-006 |
| Broken | 2 | F-004, F-005 |
| 合计 | 10 | — |

---

## 六、Top 5 高优先级问题

1. **[F-006] /goal 失败结构化报告模块缺失** — Missing
   - 审查提示词基线明确要求通过 failure-report.ts 生成结构化失败报告，但该模块不存在，导致 /goal 失败后用户无法获得可操作的恢复指引。

2. **[F-005] pendingPlanEditResolvers 泄漏** — Broken
   - 用户关闭 StepEditor 后 /goal 流程会永久挂起，导致核心目标执行功能卡死，影响最直接。

3. **[F-004] sendChat provider 不可用时未发送 done 事件** — Broken
   - 渲染层可能永久 loading，属于基础对话路径的明显断点。

4. **[F-001] 配置热重载 watcher 缺失** — Partial
   - 审查提示词基线明确要求的功能缺失，影响配置管理闭环。

5. **[F-007] 工具执行开始后无法被 abort 中断** — Partial
   - 用户"停止"体验不完整，长时间 shell 命令可能产生副作用，安全风险高于一般 Partial 问题。

---

## 七、自检声明

- [x] 已读取审查提示词并建立基线
- [x] 已逐项评估维度 2 的 14 个场景与维度 4 的 12 条错误路径
- [x] 每条 finding 均提供代码位置与证据
- [x] 未将已知排除项（CLI 残留、默认关闭功能）报告为问题
- [x] 已按级别和维度给出统计表
- [x] 已列出 Top 5 高优先级问题
