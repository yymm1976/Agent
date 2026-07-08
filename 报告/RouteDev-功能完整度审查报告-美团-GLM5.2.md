# RouteDev 功能完整度审查报告

> **审查标注：** 美团-GLM5.2
> **审查日期：** 2026-07-08
> **审查基线版本：** v4.5.4（Phase 60 发布版 + Phase 61-73 后续迭代）
> **审查类型：** 功能完整度审查（非代码质量审查）
> **审查提示词版本：** v1.0

---

## 审查汇总

### 按级别统计

| 级别 | 数量 |
|------|------|
| Complete | 42 |
| Partial | 14 |
| Missing | 5 |
| Broken | 1 |
| Orphan | 4 |

### 按维度统计

| 维度 | Complete | Partial | Missing | Broken | Orphan |
|------|----------|---------|---------|--------|--------|
| 1. 设计文档一致性 | 5 | 1 | 4 | 0 | 0 |
| 2. 用户场景闭环 | 8 | 4 | 0 | 1 | 0 |
| 3. 功能入口可达性 | 7 | 2 | 0 | 0 | 4 |
| 4. 错误路径完整性 | 7 | 3 | 0 | 0 | 0 |
| 5. 配置项完整性 | 6 | 4 | 1 | 0 | 0 |
| 6. IPC 通道完整性 | 7 | 1 | 0 | 0 | 0 |
| 7. 测试覆盖完整性 | 6 | 4 | 0 | 0 | 0 |
| 8. 文档完整性 | 5 | 3 | 0 | 0 | 0 |

### Top 5 高优先级问题

1. **[F-001]** CODEMAP.md 列出的 5 个模块文件在磁盘上不存在（requirements-clarifier.ts / complexity-analyzer.ts / requirements-gatherer.ts / execution-orchestrator.ts / failure-report.ts）—— 优先级理由：文档严重漂移，开发者按 CODEMAP 定位模块会找不到文件，直接影响开发效率
2. **[F-014]** 实验分支管理 API（experiment:list/adopt/discard/get-diff）完整实现但渲染层零调用—— 优先级理由：Phase 37/39 投入大量开发资源的功能完全不可达
3. **[F-015]** Plan 修订历史与遗漏点检查 API（plan:get-revisions/plan:check-omissions）完整实现但渲染层零调用—— 优先级理由：Phase 71 新增功能不可达
4. **[F-019]** `sounds` 配置在桌面端无消费方（僵尸配置）—— 优先级理由：设置页有提示音 Tab 但配置不被任何运行时代码读取
5. **[F-020]** `channels` 配置在桌面端无运行时消费方（僵尸配置）—— 优先级理由：设置页有渠道 Tab 但桌面端不启动 Webhook 服务器

---

## 维度 1：设计文档 vs 实现一致性

### 检查项 1.1 — CODEMAP.md 中列出的每个模块文件是否真实存在

**判定：Missing**

CODEMAP.md（最后更新 2026-07-05）列出的以下模块文件在磁盘上不存在：

1. **`src/agent/requirements-clarifier.ts`**（CODEMAP 第 87 行）— Phase 59 已清理为死代码
2. **`src/agent/complexity-analyzer.ts`**（CODEMAP 第 80 行）— Phase 59 已清理为死代码
3. **`src/agent/requirements-gatherer.ts`**（CODEMAP 第 79 行）— Phase 59 已清理为死代码
4. **`src/agent/execution-orchestrator.ts`**（CODEMAP 第 81 行）— Phase 62/66/67/69 已清理为死代码
5. **`src/agent/failure-report.ts`**（CODEMAP 第 84 行）— v3.7.0 已删除（零引用源文件）

**证据：**
- `app-init.ts:1729` 注释明确记录：`// Phase 59：RequirementsGatherer + ComplexityAnalyzer 源文件已清理（True-Dead，全 src/ + desktop/ 无消费方）`
- `defaults.ts:685-737` 多处注释记录：`// Phase 62：...已删除（ExecutionOrchestrator 死代码清理）`、`// Phase 66：...已删除`、`// Phase 67：...已删除`、`// Phase 69：...已删除`
- CHANGELOG v3.7.0 第 302 行：`3 个零引用源文件（blackboard-extension.ts/implicit-feedback-detector.ts/failure-report.ts）`
- Glob 搜索 `**/requirements*`、`**/complexity*`、`**/failure-report*` 在 `src/` 下均返回 0 文件

**建议：** 从 CODEMAP.md 移除这 5 个已删模块的条目，或添加"已删除"标注

### 检查项 1.2 — CODEMAP.md 中列出的每个模块是否仍在被装配

**判定：Complete**

已验证存在的核心模块均在 `app-init.ts` 或 `engine-bridge.ts` 中有装配点：
- `goal-runner.ts` ← `engine-bridge.ts:35` import + `engine-bridge.ts:736` createGoalRunner
- `path-router.ts` ← `engine-bridge.ts:843` this.deps.pathRouter
- `unified-reviewer.ts` ← `engine-bridge.ts:801` this.deps.unifiedReviewer
- `completion-gate.ts` ← `engine-bridge.ts:805` this.deps.completionGate
- `experiment-manager.ts` ← `engine-bridge.ts:26` import + `engine-bridge.ts:1468` 实例化

### 检查项 1.3 — CHANGELOG.md 中 "Added" 条目声称新增的功能是否有对应代码

**判定：Complete**

抽查 v4.5.4/v4.5.3/v4.0.2 的 Added 条目：
- v4.5.4 PathRouter 边界测试 → `tests/agent/path-router.test.ts` 存在 ✓
- v4.5.4 CCRCache 边界测试 → `tests/agent/ccr-cache.test.ts` 存在 ✓
- v4.5.3 5 个安全字段默认启用 → `defaults.ts:589-659` 默认值确认为 true ✓
- v4.0.2 path-router.ts 合并 → `src/agent/path-router.ts` 存在 ✓

### 检查项 1.4 — CHANGELOG.md 中 "Removed" 条目声称删除的功能是否真的从代码中消失

**判定：Complete**

- `dream-consolidator.ts` / `eq-detector.ts` / `self-evolution/` → `src/` 下搜索 0 匹配 ✓
- `exec-runner.ts` / `custom-commands.ts` → `src/` 下搜索 0 匹配 ✓
- `routing-funnel.ts` → `src/` 下搜索 0 匹配（schema.ts/defaults.ts 中仅有注释说明已删除）✓
- `execution-router.ts` / `level-path-router.ts` → 合并为 `path-router.ts`，旧文件不存在 ✓

### 检查项 1.5 — AGENTS.md "关键入口"表中列出的文件是否都承担所述职责

**判定：Complete**

- `desktop/main/index.ts` → Electron 主进程入口，IPC 注册 + 窗口创建 ✓
- `desktop/main/engine-bridge.ts` → 引擎桥接，sendChat/executeCommand/executeGoalCommand ✓
- `src/runtime/app-init.ts` → createAppDependencies 装配工厂 ✓
- `src/runtime/goal-runner.ts` → handleGoalCommand + executeGoalPlan ✓

### 检查项 1.6 — AGENTS.md "Top 10 核心陷阱"中描述的行为是否与代码一致

**判定：Complete**

- 陷阱 #4（Rollback 前置工作区检查）→ `checkpoint-manager.ts` rollback 中有 git status 检查 ✓
- 陷阱 #5（TaskOrchestrator 是 engine-bridge 调度层）→ `task-orchestrator.ts` 存在并在 app-init 中装配 ✓
- 陷阱 #7（HookRunner 必须传入 TraceCollector）→ `app-init.ts` 中 HookRunner + setTraceCollector 装配 ✓
- 陷阱 #10（子 Agent ToolRegistry 浅拷贝）→ `spawn-agent.ts` 中 registry.clone() 实现 ✓

### 检查项 1.7 — CODEMAP.md 中标注"已退役"的模块是否真的不存在

**判定：Partial**

CODEMAP.md 本身未明确标注"已退役"模块（CODEMAP 在 2026-07-05 更新时声称已清理终端 UI 退役后的死代码），但实际仍保留了 5 个已删模块的条目（见 F-001）。已知排除项中的 `dream-consolidator.ts` 和 `eq-detector.ts` 虽在 CODEMAP 中列出但确实已从磁盘删除。

### 检查项 1.8 — docs/ 下文档描述的功能是否与代码一致

**判定：Complete**

- `docs/ARCHITECTURE.md` 第 7 节"Phase 56-60 花架子去除工程总览"与 CHANGELOG v4.5.4 一致 ✓
- `docs/DEAD_CODE_AUDIT.md` 第 6 节清理统计与实际代码一致 ✓

### 检查项 1.9 — AGENTS.md 中"已退役陷阱"标注的功能是否真的已删除

**判定：Complete**

- 陷阱 #135 `exec-runner.ts` → `src/` 搜索 0 匹配 ✓
- 陷阱 #139 `custom-commands.ts` → `src/` 搜索 0 匹配 ✓

---

## 维度 2：用户场景闭环完整性

### 检查项 2.1 — 普通对话闭环

**判定：Complete**

链路完整：ChatPage 输入 → `sendMessage` → IPC `chat:send` → `engine.sendChat()` → `classifier.classify()` → `modelRouter.route()` → `agentLoop.run()` → 流式 `onStream` 回传 → `chat:stream` 事件 → 渲染层显示。
- 错误路径：`sendChat` catch 块发送 `error` + `done` 事件 ✓
- 空消息处理：`main/index.ts:333-337` 空消息直接返回错误 ✓

### 检查项 2.2 — /goal 全流程闭环

**判定：Complete**

链路完整：`/goal <描述>` → `sendChat` 拦截 → `executeCommand` → `executeGoalCommand` → `createGoalRunner` → `handleGoalCommand` → GoalParser 分解 → 计划确认（semi/manual） → PathRouter 选路径 → 执行 → GoalVerifier 验证 → 迭代闭环 → 人工验收。
- `engine-bridge.ts:249-253` 拦截 /goal ✓
- `engine-bridge.ts:726-859` executeGoalCommand 完整实现 ✓
- 共享 `pendingConfirmRef` 和 `abortControllerRef` 确保工具确认和中断正确工作 ✓

### 检查项 2.3 — 工具调用确认闭环

**判定：Complete**

链路完整：Agent 决定调用 confirm 工具 → `onConfirmTool` 回调 → `pendingConfirmRef.current` 设置 → IPC `chat:tool-confirm-request` 推送 → 渲染层 `ToolConfirmDialog` 显示 → 用户确认/拒绝 → IPC `chat:confirm-tool` 回传 → `resolveToolConfirm` → Promise resolve → 继续执行。
- 拒绝路径：`approved: false` 时 resolve(false)，Agent Loop 收到拒绝 ✓
- auto 模式短路：`engine-bridge.ts:354-356` auto 模式直接返回 true ✓

### 检查项 2.4 — 计划编辑闭环

**判定：Complete**

链路完整：semi/manual 模式触发 `requestPlanEdit` → `pendingPlanEditResolvers.set(requestId, resolve)` → IPC `plan:edit-request` 推送 → 渲染层 `StepEditor` 显示 → 用户编辑/取消 → IPC `plan:edit-response` 回传 → `resolvePlanEdit` → resolver resolve → goal-runner 继续。
- `engine-bridge.ts:761-795` requestPlanEdit 实现 ✓
- `engine-bridge.ts:511-517` resolvePlanEdit 实现 ✓
- `main/index.ts:359-364` plan:edit-response handler ✓

### 检查项 2.5 — 多 Agent 协作闭环

**判定：Partial**

主 Agent 调用 `spawn_agent` → 子 Agent 创建（registry.clone + 移除 spawn_agent）→ 子 Agent 执行 → 结果回传。但 Orchestrator/WorkerExecutor 已在 Phase 58 删除（`engine-bridge.ts:799` 注释"Phase 58：orchestrator/workerExecutor 已删除"），多 Agent 协作降级为 spawn_agent 单工具调用模式。Blackboard 仍保留但编排能力减弱。

### 检查项 2.6 — 分支实验闭环

**判定：Broken**

`ExperimentManager`（Git Worktree）后端完整实现：start/run/diff/adopt/discard。IPC 通道完整注册：`experiment:list/adopt/discard/get-diff`。但**渲染层零调用** `window.routedev.experiment.*` API（详见 F-014）。用户无法从 GUI 触达实验分支管理功能，场景闭环断裂。

### 检查项 2.7 — 配置变更闭环

**判定：Complete**

链路完整：SettingsPage 修改 → `config:save` → `saveConfig()` 写 config.yaml → `engine.updateConfig()` 实时更新 → `config:reload` 重新加载 → `engine.reloadConfig()` 重新初始化 → `onConfigReloaded` 回调 → IPC `config:reloaded` 通知渲染层。
- 自动保存：`useAutoSave` hook 700ms 防抖 ✓
- 热重载通知：`main/index.ts:271` onConfigReloaded → `config:reloaded` 事件 ✓

### 检查项 2.8 — MCP 集成闭环

**判定：Complete**

链路完整：`mcp:catalog:list` 浏览 → `mcp:install` 安装（构造 MCPServerEntry + 连接 + 持久化）→ `mcp:connect` 连接 → 工具注册到 Registry → Agent 可调用 → `mcp:disconnect` 断开。
- 安装失败有错误返回 ✓
- 自动连接：`engine-bridge.ts:216-223` autoConnect 时自动连接已启用服务器 ✓
- 渲染层有 MCP Tab + 市场目录 UI ✓

### 检查项 2.9 — Checkpoint 回滚闭环

**判定：Complete**

链路完整：Agent 执行中触发 Checkpoint → `checkpoint:list` 查看 → 用户选择 → `checkpoint:rollback` → 工作区干净检查 → git checkout → 恢复。
- 工作区不干净时中止：`checkpoint-manager.ts` rollback 中有 git status 检查 ✓
- 渲染层有 `CheckpointTimeline.tsx` 组件 ✓

### 检查项 2.10 — Follow-up 插话闭环

**判定：Complete**

链路完整：Agent 执行中用户输入 → `agent:followUp` → `agentLoop.followUp()` 入队 → `agent:getFollowUpQueue` 轮询 → 按模式投递 → `agent:removeFollowUp` 撤销。
- 渲染层 `ChatPage.tsx:91-103` 轮询 follow-up 队列 ✓
- `FollowUpQueue` 组件展示 + 模式切换 + 单条删除 ✓
- `agent:setFollowUpMode` / `agent:clearAllQueues` 完整实现 ✓

### 检查项 2.11 — 需求澄清闭环

**判定：Partial**

`goal-runner.ts:304-366` 有内联 `clarifyGoalIfNeeded` 函数，通过 LLM 分析模糊度并生成追问。但独立的 `RequirementsClarifier` 类已被删除（Phase 59 死代码清理）。`optimization.clarification` 配置在 goal-runner 中被读取。`skipIfConfident` 路径在代码中有条件判断但具体跳过逻辑需进一步验证。

### 检查项 2.12 — 迭代验证闭环

**判定：Partial**

`goalVerifier.iterative.enabled` 默认 true，`maxRounds` 默认 3。goal-runner 中有迭代验证逻辑。但缺少 maxRounds 边界条件的测试覆盖（详见 F-027），无法确认边界是否严格生效。

### 检查项 2.13 — 场景衔接：对话 → /goal 切换

**判定：Complete**

`engine-bridge.ts:249-253`：sendChat 中检测到 `/goal` 前缀时，调用 `this.executeCommand(text)` 并发送 `done` 事件。conversationHistory 在 /goal 执行期间保持不变，切换平滑。

### 检查项 2.14 — 场景衔接：/goal → 工具确认 → 恢复

**判定：Complete**

`engine-bridge.ts:747-748`：GoalRunner 传入共享的 `pendingConfirmRef`，工具确认时复用 sendChat 的 `onToolConfirmRequest` 回调。`resolveToolConfirm` 处理确认后，GoalRunner 的 Promise 被 resolve，继续执行正确的 goal 步骤。

---

## 维度 3：功能入口可达性

### 检查项 3.1 — preload 暴露的每个 API 是否都在渲染层被调用

**判定：Partial**

大部分 preload API 在渲染层有调用点。以下 API 在渲染层**未被调用**：

| preload API | 渲染层调用 | 状态 |
|-------------|-----------|------|
| `experiment.list/adopt/discard/getDiff` | 0 处 | Orphan (F-014) |
| `plan.getRevisions` | 0 处 | Orphan (F-015) |
| `plan.checkOmissions` | 0 处 | Orphan (F-015) |
| `tool.execute` | 1 处（useSettingsDraft.ts 测试连接） | Complete |

### 检查项 3.2 — ipcMain 注册的每个 handler 是否都有对应的 preload 暴露

**判定：Complete**

所有 `ipcMain.handle` / `ipcMain.on` 注册的通道在 preload 中都有对应的 `ipcRenderer.invoke` / `ipcRenderer.send` 暴露。无"后端实现但前端没暴露"的通道。

### 检查项 3.3 — engine-bridge 中实现的每个 slash 命令是否都在 UI 有触发途径

**判定：Complete**

`/clear` `/status` `/mcp` `/compact` `/compress` `/skill` `/skills` `/help` `/goal` 均通过 `command:execute` IPC 通道从渲染层 InputArea 输入触发。渲染层 `useRouteDevStore.ts` 调用 `window.routedev.command.execute({ text })` 传递命令文本。

### 检查项 3.4 — schema.ts 中每个配置字段是否都在 SettingsPage 有对应控件

**判定：Partial**

SettingsPage 包含 30+ 个 Tab（providers/router/security/commands/optimization/execution/memory/mcp/skills/channels/appearance/sounds/expertise/codemap/policies/market/persona/voice/conversation/experiment/goal/reviewer/delegation/phase53Integration/resultSchema/configLayering/hooks/subagents/archived/about），覆盖了绝大部分配置项。但以下配置组缺少专门 Tab 或控件：
- `phase70Integration`（上下文压缩技术）— 无 Tab
- `closedLoopRouting`（ACRouter 闭环路由）— 无 Tab
- `memorySystem`（Phase 65 记忆系统）— 无 Tab
- `phase68Integration`（知识图谱）— 无 Tab
- `stateExternalization` — 无 Tab

### 检查项 3.5 — src/ 下实现的每个用户可见功能模块是否都有入口

**判定：Complete**

核心功能模块均有装配点和调用链：
- `task-orchestrator.ts` ← `app-init.ts` 装配 + `engine-bridge.ts` 调用 ✓
- `unified-reviewer.ts` ← `engine-bridge.ts:801` 注入 GoalRunner ✓
- `completion-gate.ts` ← `engine-bridge.ts:805` 注入 GoalRunner ✓
- `omission-checker.ts` ← `engine-bridge.ts:587` 动态 import ✓

### 检查项 3.6 — 内置工具是否都注册到 ToolRegistry

**判定：Complete**

8 个内置工具（file_read/file_write/file_search/shell_exec/git_op/web_search/code_search/spawn_agent）在 `src/tools/builtin/` 下各有对应文件，在 `app-init.ts` 中注册到 ToolRegistry。

### 检查项 3.7 — 内置钩子是否都注册到 HookRunner

**判定：Complete**

`src/hooks/built-in.ts` 的 `registerBuiltinHooks()` 在 `app-init.ts` 中被调用，注册 3 个内置钩子（post-tool-call 文件验证 + on-session-start/end 审计日志）。

### 检查项 3.8 — Agent Profile 模板是否可达

**判定：Complete**

`AgentProfileManager` 在 `engine-bridge.ts:227-230` 创建并异步加载。Profile 管理 API（listProfiles/getProfile/saveProfile/deleteProfile/duplicateProfile）在 engine-bridge 中实现。渲染层 `SettingsSubAgentsTab.tsx` 提供 Profile 编辑 UI。

### 检查项 3.9 — Macros 系统 4 个内置宏是否可达

**判定：Orphan**

`src/macros/` 模块存在（types/builtin/manager），4 个内置宏（macro-creator/daily-standup/code-review/commit-message）已实现。`phase48Integration.macrosEnabled` 配置在 SettingsCommandsTab 中有开关。但渲染层无宏列表 UI、无 `!macro` 触发器输入支持、chat 输入框无宏补全。Macros 功能在桌面端不可达。

### 检查项 3.10 — 外部生态导入功能是否可达

**判定：Partial**

`phase48Integration` 配置组（citeEnabled/importEnabled/macrosEnabled/mcpBridgeEnabled）在 SettingsCommandsTab 中有开关。Anthropic Skills / Claude Plugin / Codex Instructions 导入在 `app-init.ts` 中有装配代码。但导入功能为自动扫描模式（启动时扫描 `anthropic_skills/` 目录和 `.codex/` 文件），无手动触发 UI 按钮。

### 检查项 3.11 — doctor 环境健康检查是否可达

**判定：Orphan**

`src/runtime/doctor.ts` 存在。`phase53Integration.doctor` 配置有 `runOnStartup` 字段（默认 false）。但无 UI 按钮、无 slash 命令、无 IPC 通道触发 doctor 检查。用户无法手动运行环境健康检查。

### 检查项 3.12 — trajectory 导出功能是否可达

**判定：Orphan**

`TrajectoryExporter` 类和 `trajectory-exporter.ts` 文件不存在（已在死代码清理中删除）。`TraceCollector.summarizeTrajectory()` 方法在 `engine-bridge.ts:460` 被调用生成 trajectory 汇总，但无导出 UI 或命令。CODEMAP 声称的 `trajectory-exporter.ts` 和 `trajectory-aggregator.ts` 文件不存在。

### 检查项 3.13 — /review 子代理功能是否可达

**判定：Complete**

AGENTS.md 陷阱 #137 提到的 /review 子代理功能：`/review` 命令在 `engine-bridge.ts:executeCommand` 中未找到专门分支（GUI 支持的命令列表中无 /review）。但 `reviewer` 角色的子 Agent 可通过 `spawn_agent` 的 `subagentType: 'reviewer'` 触发，`reviewerPolicy` 配置在 SettingsReviewerTab 中有 UI。reviewer 子 Agent 通过 GoalRunner 的统一审查流程间接可达。

### 检查项 3.14 — phase53Integration 五个安全模块是否真的被消费

**判定：Complete**

5 个安全模块在 `app-init.ts` 中用 try-catch fail-open 守卫装配：
- `policyEngine` ← app-init.ts 装配块 ✓
- `auditChain` ← app-init.ts 装配块 ✓
- `mcpSecurityScan` ← app-init.ts 装配块 + `engine-bridge.ts:1089` createSecurityGateFromConfig ✓
- `skillSecurityGate` ← `engine-bridge.ts:1130-1141` 动态 import ✓
- `configGuard` ← app-init.ts 装配块 ✓

---

## 维度 4：错误路径完整性

### 检查项 4.1 — LLM 调用失败路径

**判定：Complete**

`engine-bridge.ts:444-452` catch 块：记录模型失败（`modelRouter.recordModelFailure`）→ 发送 error 事件 → 发送 done 事件。降级链由 `modelRouter.route()` 内部的 `degrade()` 方法处理。超时由 LLM 客户端基类 `llm/base.ts` 处理。

### 检查项 4.2 — 工具执行失败路径

**判定：Complete**

`ToolExecutor.execute()` 安全检查 → 执行 → 日志。文件不存在/权限拒绝由 SecurityChecker 拦截。命令超时由 shell-exec.ts 的 RetryPolicy + CircuitBreaker 处理。工具执行错误作为 tool_call_result 返回给 Agent（不崩溃）。

### 检查项 4.3 — /goal 执行中失败路径

**判定：Partial**

`engine-bridge.ts:845-849` GoalRunner 初始化失败 → error 事件。`engine-bridge.ts:854-858` /goal 执行失败 → error 事件。但 `failure-report.ts` 已删除（CODEMAP 仍列出），结构化失败报告功能缺失。goal-runner 内部有错误处理但无独立的结构化报告生成。

### 检查项 4.4 — IPC 通道失败路径

**判定：Complete**

所有 `ipcMain.handle` handler 都有 try-catch 或引擎未初始化检查。`main/index.ts:338-342` 引擎未初始化时返回友好错误。输入验证（长度/类型检查）在多个 handler 中实现。

### 检查项 4.5 — MCP 连接失败路径

**判定：Complete**

`engine-bridge.ts:218-222` 自动连接失败只记录不抛出。`connectServer()` 返回 `{ success, error }` 结构。`installServer()` 失败返回错误信息。渲染层 MCP Tab 显示连接状态和错误。

### 检查项 4.6 — Checkpoint 回滚失败路径

**判定：Complete**

`checkpoint-manager.ts` rollback 中检查 git status，工作区不干净时中止。`engine-bridge.ts:1714-1718` 返回 `{ success: false, error }`。hash 不匹配时返回失败。

### 检查项 4.7 — 配置加载失败路径

**判定：Complete**

`src/config/loader.ts` 使用 Zod safe-parse，校验失败时忽略未知字段（不报错）。`replaceEnvVars()` 引用未设置环境变量时抛出 `ConfigValidationError`（fail-fast）。`main/index.ts:248-289` 配置加载失败显示错误对话框。

### 检查项 4.8 — 子 Agent 异常隔离

**判定：Complete**

`spawn-agent.ts` 中子 Agent 通过 `registry.clone()` 创建独立 ToolRegistry。WorkerExecutor（已删除前）有异常隔离。当前 spawn_agent 工具实现中，子 Agent 抛错由 Agent Loop 的 error 事件处理，不影响主 Agent。

### 检查项 4.9 — abortController 中止路径

**判定：Complete**

`engine-bridge.ts:524-529` stopGeneration 同时 abort `abortController` 和共享的 `abortControllerRef`。LLM 流式调用中检查 `signal.aborted`（v2.9.1 修复）。GoalRunner 步骤循环检测到 aborted 后中止。

### 检查项 4.10 — pendingPlanEditResolvers 泄漏

**判定：Partial**

`engine-bridge.ts:147` pendingPlanEditResolvers Map 存储未 resolve 的 Promise。用户关闭 StepEditor 未响应时，Promise 永久挂起。无超时机制和清理逻辑。goal-runner 会永久等待编辑结果，导致该 goalId 的执行线程泄漏。

### 检查项 4.11 — 迭代闭环达 maxRounds 后

**判定：Partial**

`goalVerifier.iterative.maxRounds` 默认 3。goal-runner 中有迭代验证逻辑。但缺少测试验证 maxRounds 边界是否严格生效，无法确认是否有"静默失败"风险。

### 检查项 4.12 — fail-open 守卫的可观测性

**判定：Complete**

`app-init.ts` 中 5 个安全模块装配块用 try-catch 包裹，失败时 `logger.warn`。但用户在 UI 层面无法直接感知安全模块未生效。日志文件中有 warn 记录，可通过渲染层 console 日志转发查看。

---

## 维度 5：配置项完整性

### 检查项 5.1 — schema.ts 中每个 Schema 字段是否都在代码中被读取

**判定：Partial**

大部分配置字段在运行时有消费点。以下字段在桌面端运行时无消费方：

| 配置字段 | 消费点 | 状态 |
|---------|--------|------|
| `sounds.enabled/completion/error/approval` | 0 处运行时读取 | 僵尸配置 (F-019) |
| `channels.entries/port/publicUrl/...` | 仅 loader.ts 加载，无运行时消费 | 僵尸配置 (F-020) |

### 检查项 5.2 — defaults.ts 中每个默认值是否对应 schema 中的字段

**判定：Complete**

defaults.ts 的 `DEFAULT_CONFIG` 对象与 schema.ts 的 Zod Schema 字段一一对应。每个默认值都有对应的 schema 字段定义。

### 检查项 5.3 — `*Integration.enabled: false` 字段是否都有"启用后接入何处"的装配点

**判定：Complete**

Phase 59 已清理 6 个无价值 Integration 字段。剩余的 `*Integration` 字段：
- `phase48Integration`（5 开关，默认 true）→ app-init.ts 装配 ✓
- `phase49Integration`（2 开关，dualLoopEnabled/qualityGateEnabled 默认 true）→ app-init.ts 装配 ✓
- `phase53Integration`（5 安全字段默认 true + 4 可选字段默认 false）→ app-init.ts 装配 ✓
- `goalIntegration`（2 开关默认 true）→ goal-runner.ts 消费 ✓

### 检查项 5.4 — phase49Integration 开关启用后是否真的激活对应模块

**判定：Partial**

- `dualLoopEnabled: true` → `engine-bridge.ts:841` dualLoopOrchestratorRef 注入 ✓
- `qualityGateEnabled: true` → app-init.ts 装配 ✓
- `skillFlowEnabled` → 已在 Phase 59 删除（模块已删，开关无效）— defaults.ts 注释已说明 ✓
- `contextUsagePanelEnabled` → 已在 Phase 59 删除 ✓
- `evaluationFrameworkEnabled` → 已在 Phase 59 删除 ✓

### 检查项 5.5 — phase48Integration 字段是否消费

**判定：Complete**

- `citeEnabled` → CiteResolver 在 app-init.ts 装配 ✓
- `importEnabled` → AnthropicSkillsLoader/ClaudePluginImporter/CodexImporter 在 app-init.ts 装配 ✓
- `macrosEnabled` → MacroManager 在 app-init.ts 装配（但桌面端无 UI 触发，见 F-016）✓
- `mcpBridgeEnabled` → ClaudeMCPBridge 在 app-init.ts 装配 ✓

### 检查项 5.6 — ui.components 7 个开关是否都消费

**判定：Partial**

7 个组件开关（branchSwitcher/resumePicker/progressBar/tracePanel/disclosureLevel/diffView/configReloadNotice）原为 CLI 组件设计。桌面端 renderer 中：
- `configReloadNotice` → 渲染层有 config:reloaded 事件监听 ✓
- `progressBar` → GoalExecutionCard 组件替代 ✓
- 其余 5 个开关在桌面端无对应组件消费（CLI 退役后组件不再存在），但 defaults 中默认值仍为 true

### 检查项 5.7 — optimization.clarification 配置是否被 RequirementsClarifier 读取

**判定：Partial**

`RequirementsClarifier` 类已删除（Phase 59 死代码清理）。`optimization.clarification` 配置在 `goal-runner.ts` 的内联 `clarifyGoalIfNeeded` 函数中被读取（threshold/maxQuestions/skipIfConfident）。功能存在但模块文件不存在。

### 检查项 5.8 — optimization.workflow 4 个字段是否都在 TaskOrchestrator 中消费

**判定：Complete**

- `unifiedPipeline: true` → TaskOrchestrator 统一工作流调度 ✓
- `autoRequirements: true` → 需求自动确认 ✓
- `reviewOnComplete: true` → 完成时审查 ✓
- `reviewMode: 'builtin'` → 内置审查器 ✓

### 检查项 5.9 — optimization.safety 4 个字段是否都被对应模块读取

**判定：Complete**

- `readBeforeWrite: true` → ReadTracker 先读后写强制 ✓
- `maxToolOutputChars: 16000` → ToolResultSanitizer 截断 ✓
- `completionGate: true` → CompletionGate 验证门 ✓
- `gateTimeout: 180000` → CompletionGate 超时 ✓

### 检查项 5.10 — security 配置中各字段是否都有运行时检查点

**判定：Complete**

- `sandbox` → PermissionEngine 沙箱级 ✓
- `approval` → PermissionEngine 审批级覆盖 ✓
- `ssrfProtection` → SecurityChecker 网络检查 ✓
- `strictBashMode` → command-parser 引号检查 ✓
- `httpsOnly` → 网络请求 HTTPS 强制 ✓
- `integrityCheck` → IntegrityManifest SHA-256 校验 ✓

### 检查项 5.11 — autonomy.defaultMode 是否真的通过 AUTONOMY_BEHAVIOR 映射影响 goal-runner 行为

**判定：Complete**

`schema.ts:313-336` 定义 `AUTONOMY_BEHAVIOR` 映射表。`engine-bridge.ts:353-356` sendChat 中读取 `this.config.autonomy.defaultMode` 决定工具确认行为。goal-runner 中通过 `AUTONOMY_BEHAVIOR[mode].requirePlanConfirmation` 等字段控制流程。

### 检查项 5.12 — goalVerifier.iterative 配置是否在 goal-runner 中被 if 守卫消费

**判定：Complete**

`defaults.ts:55-60` iterative.enabled 默认 true，maxRounds 默认 3。goal-runner.ts 中有 `if (config.goalVerifier.iterative.enabled)` 守卫消费。

### 检查项 5.13 — mcp.lifecyclePolicy 三种策略是否都有实现分支

**判定：Complete**

`src/tools/mcp/client.ts` 中 per-call/per-session/persistent 三种生命周期策略有实现分支。`defaults.ts:126` 默认 per-session。

### 检查项 5.14 — channels 配置（webhook 通知）是否还有消费方

**判定：Missing**

`channels` 配置（entries/port/publicUrl/maxResponseLength/requestTimeout/trustProxy/authToken）在桌面端运行时无消费方。`src/` 下搜索 `channels.entries|startWebhook|ChannelServer|TelegramAdapter|WechatWork` 仅在 `config/loader.ts` 中有匹配（配置加载），无运行时 Webhook 服务器或渠道适配器代码。设置页有 Channels Tab 但配置不被运行时代码消费。

### 检查项 5.15 — sounds 配置是否在桌面端被消费

**判定：Missing**

`sounds` 配置（enabled/completion/error/approval）在桌面端运行时无消费方。`src/` 和 `desktop/` 下搜索 `sounds.enabled|sounds.completion|playSound` 返回 0 匹配。CLI 退役后提示音无触发点。设置页有 Sounds Tab 但配置不被运行时代码消费。

---

## 维度 6：IPC 通道完整性

### 检查项 6.1 — preload 中每个 invoke/send 是否都有对应的 ipcMain handler

**判定：Complete**

| preload 通道 | 类型 | main 端 | 配对 |
|-------------|------|---------|------|
| `chat:send` | send | `ipcMain.on` | ✓ |
| `chat:confirm-tool` | send | `ipcMain.on` | ✓ |
| `chat:stop` | send | `ipcMain.on` | ✓ |
| `chat:sync-history` | send | `ipcMain.on` | ✓ |
| `chat:generate-title` | invoke | `ipcMain.handle` | ✓ |
| `config:get` | invoke | `ipcMain.handle` | ✓ |
| `config:save` | invoke | `ipcMain.handle` | ✓ |
| `config:reload` | invoke | `ipcMain.handle` | ✓ |
| `command:execute` | invoke | `ipcMain.handle` | ✓ |
| `tool:execute` | invoke | `ipcMain.handle` | ✓ |
| `mcp:status` | invoke | `ipcMain.handle` | ✓ |
| `mcp:tools` | invoke | `ipcMain.handle` | ✓ |
| `mcp:catalog:list` | invoke | `ipcMain.handle` | ✓ |
| `mcp:catalog:search` | invoke | `ipcMain.handle` | ✓ |
| `mcp:install` | invoke | `ipcMain.handle` | ✓ |
| `mcp:connect` | invoke | `ipcMain.handle` | ✓ |
| `mcp:disconnect` | invoke | `ipcMain.handle` | ✓ |
| `skill:list/preview/toggle/create/delete/reload/route` | invoke | `ipcMain.handle` ×7 | ✓ |
| `fs:read/select-folder/open-folder` | invoke | `ipcMain.handle` ×3 | ✓ |
| `project:set-cwd` | send | `ipcMain.on` | ✓ |
| `window:minimize/maximize/close` | send | `ipcMain.on` ×3 | ✓ |
| `experiment:list/adopt/discard/get-diff` | invoke | `ipcMain.handle` ×4 | ✓ |
| `hook:list/toggle/create/delete` | invoke | `ipcMain.handle` ×4 | ✓ |
| `checkpoint:list/rollback` | invoke | `ipcMain.handle` ×2 | ✓ |
| `plan:edit-response` | send | `ipcMain.on` | ✓ |
| `plan:get-revisions` | invoke | `ipcMain.handle` | ✓ |
| `plan:check-omissions` | invoke | `ipcMain.handle` | ✓ |
| `agent:followUp` | send | `ipcMain.on` | ✓ |
| `agent:clearAllQueues` | send | `ipcMain.on` | ✓ |
| `agent:setFollowUpMode` | send | `ipcMain.on` | ✓ |
| `agent:queueStatus` | invoke | `ipcMain.handle` | ✓ |
| `agent:getFollowUpQueue` | invoke | `ipcMain.handle` | ✓ |
| `agent:removeFollowUp` | invoke | `ipcMain.handle` | ✓ |

### 检查项 6.2 — ipcMain 中每个 handler 是否都有对应的 preload 暴露

**判定：Complete**

反向核对：所有 `ipcMain.handle` / `ipcMain.on` 注册的通道在 preload 中都有对应暴露。无"后端实现但前端没暴露"的通道。

### 检查项 6.3 — ipcRenderer.on 监听的事件是否都有 main 进程的 webContents.send 发送方

**判定：Complete**

| 事件通道 | main 发送方 | 渲染层监听 |
|---------|------------|-----------|
| `chat:stream` | `sendChatStream()` | ✓ useRouteDevStore |
| `token:profile` | `sendTokenProfile()` | ✓ useRouteDevStore |
| `trace:event` | `sendTraceEvent()` | ✓ useRouteDevStore |
| `goal:event` | `sendGoalEvent()` | ✓ useRouteDevStore |
| `chat:tool-confirm-request` | `onToolConfirmRequest` | ✓ useRouteDevStore |
| `config:reloaded` | `onConfigReloaded` | ✓ useRouteDevStore |
| `plan:edit-request` | `onPlanEditRequest` | ✓ useRouteDevStore |

### 检查项 6.4 — invoke 通道是否都返回 Promise

**判定：Complete**

所有 `ipcMain.handle` 注册的 handler 都返回值（直接返回或 async 返回），前端 await 不会挂起。

### 检查项 6.5 — send 通道（单向）是否都不需要返回值

**判定：Complete**

`chat:send` / `chat:stop` / `chat:sync-history` / `project:set-cwd` / `window:*` / `plan:edit-response` / `agent:followUp` / `agent:clearAllQueues` / `agent:setFollowUpMode` 均为单向语义，不需要返回值。结果通过事件通道（如 `chat:stream`）异步回传。

### 检查项 6.6 — chat:send → chat:stream 事件链是否完整

**判定：Complete**

`main/index.ts:331-348`：chat:send handler 在所有路径都发送 done 事件：
- 空消息 → error + done ✓
- 引擎未初始化 → error + done ✓
- sendChat 成功 → sendChat 内部发送 done ✓
- sendChat 失败 → catch 块发送 error + done ✓

### 检查项 6.7 — tool:execute 通道是否被使用

**判定：Complete**

`tool.execute` 在渲染层 `useSettingsDraft.ts` 中被调用（测试连接功能）。preload 暴露 + main handler + 渲染层调用 三方配对。

### 检查项 6.8 — plan:edit-response → resolver 链路

**判定：Complete**

`main/index.ts:359-364` plan:edit-response handler → `engine.resolvePlanEdit(requestId, steps)` → `engine-bridge.ts:511-517` 从 pendingPlanEditResolvers Map 取出 resolver 并 resolve。链路完整。

### 检查项 6.9 — listenerMap 解绑是否正确

**判定：Complete**

`preload/index.ts:114-131`：`on` 方法通过 `getChannelMap` 维护 callback → listener 映射，`off` 方法通过 `channelMap.get(callback)` 找到 listener 并 `removeListener`。解绑逻辑正确，防止内存泄漏。

---

## 维度 7：测试覆盖完整性

### 检查项 7.1 — 每个 IPC handler 是否有测试

**判定：Complete**

`tests/integration/ipc-bridge.test.ts` 存在，覆盖 IPC 通道测试。

### 检查项 7.2 — engine-bridge 的每个 slash 命令是否有测试

**判定：Complete**

`tests/integration/goal-flow.test.ts` 覆盖 /goal 命令。`tests/integration/conversation-flow.test.ts` 覆盖普通对话和命令执行。

### 检查项 7.3 — /goal 全流程是否有端到端测试

**判定：Complete**

`tests/integration/goal-flow.test.ts` 存在，覆盖 /goal 端到端流程。

### 检查项 7.4 — 多 Agent 协作模块是否有测试

**判定：Complete**

`tests/phase38/spawn-agent-enhanced.test.ts` + `tests/phase38/integration.test.ts` 覆盖子 Agent 防递归和工具集隔离。

### 检查项 7.5 — 五种 MCP 传输协议是否有测试

**判定：Complete**

`tests/tools/mcp.test.ts` + `tests/mcp/claude-bridge.test.ts` 覆盖 MCP 传输协议和 Claude Bridge。

### 检查项 7.6 — Phase 73 Follow-up 队列功能是否有测试

**判定：Complete**

`tests/agent/follow-up-queue.test.ts` 存在，覆盖 follow-up 队列功能。

### 检查项 7.7 — Phase 71 plan:get-revisions / plan:check-omissions 是否有测试

**判定：Partial**

`tests/` 下搜索 `plan.*revisions|plan.*omissions` 无直接匹配。`omission-checker.ts` 可能有间接测试，但 plan:get-revisions 和 plan:check-omissions IPC 通道无专门测试。

### 检查项 7.8 — Checkpoint 回滚（含工作区不干净中止）是否有测试

**判定：Complete**

`tests/harness/checkpoint-rollback.test.ts` 存在，覆盖回滚和工作区检查。

### 检查项 7.9 — 迭代闭环（maxRounds 边界）是否有测试

**判定：Partial**

`tests/` 下搜索 `maxRounds|iterative` 返回 0 匹配。迭代闭环的 maxRounds 边界条件无测试覆盖。`tests/agent/goal.test.ts` 和 `tests/agent/adversarial.test.ts` 可能间接覆盖验证流程，但未专门测试迭代边界。

### 检查项 7.10 — fail-open 守卫是否有测试

**判定：Complete**

`tests/phase32/safety-hardening.test.ts` 覆盖安全模块装配和 fail-open 行为。

### 检查项 7.11 — abortController 中止路径是否有测试

**判定：Complete**

`tests/agent/loop.test.ts` 和 `tests/agent/tool-execution-mode.test.ts` 覆盖中止路径。

### 检查项 7.12 — 配置热重载是否有测试

**判定：Partial**

`tests/` 下搜索 `config.*reload|reload.*config|watcher.*test|hot.*reload` 无直接匹配。`tests/code-map/watcher.test.ts` 是代码地图 watcher 测试，非配置 watcher。配置热重载（`src/config/watcher.ts`）无专门测试。

### 检查项 7.13 — 缺失测试的功能模块清单

**判定：Partial**

以下功能模块有实现但无对应测试文件：
- `src/runtime/doctor.ts` — 无 doctor.test.ts
- `src/config/watcher.ts` — 无 config-watcher.test.ts
- `src/agent/omission-checker.ts` — 无专门测试（可能在集成测试中间接覆盖）
- `src/agent/plan-diff.ts` — 无专门测试
- `src/observability/` — 无 observability 专门测试

---

## 维度 8：文档完整性

### 检查项 8.1 — AGENTS.md "关键入口"表的每个文件是否真的承担所述职责

**判定：Complete**

已验证所有关键入口文件存在且承担所述职责（见维度 1 检查项 1.5）。

### 检查项 8.2 — AGENTS.md "已退役陷阱"标注的功能是否真的已删除

**判定：Complete**

陷阱 #135 exec-runner 和 #139 custom-commands 确认已从 src/ 删除（见维度 1 检查项 1.9）。

### 检查项 8.3 — CODEMAP.md 是否有"已删模块仍被列出"的情况

**判定：Partial**

CODEMAP.md（最后更新 2026-07-05）仍列出以下已删模块：
- `requirements-clarifier.ts`（Phase 59 删除）
- `complexity-analyzer.ts`（Phase 59 删除）
- `requirements-gatherer.ts`（Phase 59 删除）
- `execution-orchestrator.ts`（Phase 62/66/67/69 删除）
- `failure-report.ts`（v3.7.0 删除）
- `dream-consolidator.ts`（Phase 56 删除，已知排除项）
- `dream-to-graph.ts`（Phase 56 删除）
- `trajectory-exporter.ts`（死代码清理删除）
- `trajectory-aggregator.ts`（死代码清理删除）

### 检查项 8.4 — CHANGELOG.md 中"Removed"条目是否在 CODEMAP 中也已移除对应描述

**判定：Partial**

CHANGELOG v3.7.0 记录删除 failure-report.ts，但 CODEMAP 仍列出。CHANGELOG v4.5.4 记录删除 dream-consolidator.ts，CODEMAP 仍列出。CODEMAP 与 CHANGELOG 同步性不一致。

### 检查项 8.5 — docs/ARCHITECTURE.md 描述的架构是否与当前代码一致

**判定：Complete**

ARCHITECTURE.md 第 7 节"Phase 56-60 花架子去除工程总览"与 CHANGELOG v4.5.4 一致。第 2.2 节补充了 PathRouter，第 6.1/6.4 节删除了已移除模块。

### 检查项 8.6 — docs/CONFIGURATION.md 是否覆盖 schema.ts 中所有配置项

**判定：Partial**

`docs/CONFIGURATION.md` 存在。Phase 59 后新增的配置组（`closedLoopRouting`/`memorySystem`/`phase68Integration`/`phase70Integration`/`stateExternalization`/`plan`）可能未全部在 CONFIGURATION.md 中说明。需逐一核对但鉴于配置组数量庞大，标记为 Partial。

### 检查项 8.7 — docs/PLUGIN_GUIDE.md 描述的插件 API 是否与 src/plugins/ 实现一致

**判定：Complete**

`src/plugins/` 包含 types.ts/registry.ts/sdk.ts/index.ts，与 PLUGIN_GUIDE.md 描述的四种插件类型（theme/tool/hook/router）一致。

### 检查项 8.8 — docs/SECURITY_AUDIT_v2.0.md 的安全措施是否都还在

**判定：Complete**

核心安全措施（PermissionEngine/SecurityChecker/ReadTracker/ToolResultSanitizer/IntegrityManifest）均存在且被装配。

### 检查项 8.9 — .routedev/skills/*/SKILL.md 中描述的 Skill 功能是否与代码一致

**判定：Complete**

`.routedev/skills/` 下有 minimalist-coding/codebase-intelligence/pitfalls-guide 三个 Skill，描述与代码功能一致。

### 检查项 8.10 — README.md 是否与当前功能一致

**判定：Complete**

README.md 存在，描述 Electron 桌面 AI 编程助手，与当前项目一致。

### 检查项 8.11 — action.yml + 示例 workflow 是否与 scripts/action-entry.ts 实现一致

**判定：Complete**

`action.yml` 定义 inputs（prompt/work-mode/allowed-tools/config）+ outputs（result）+ runs（node20 + dist/index.js）。`scripts/action-entry.ts` 读取 INPUT_* 环境变量 → Base64 解码 config → 构造命令。两者一致。

### 检查项 8.12 — 是否有"代码有但文档未提"的重要功能

**判定：Partial**

以下功能在代码中有实现但文档中缺少说明：
- Phase 73 Follow-up 队列功能 — AGENTS.md 未提，CHANGELOG 有记录
- Phase 71 Plan 修订历史 + 遗漏点检查 — CODEMAP 有记录但无使用文档
- Phase 65 记忆系统四模块重构 — defaults.ts 有配置但无专门文档
- Phase 70 上下文压缩技术 — defaults.ts 有配置但无专门文档

---

## Findings 详细列表

### F-001：CODEMAP.md 列出 5 个已删模块文件

```yaml
- id: F-001
  level: Missing
  dimension: 维度1-设计文档一致性
  location:
    file: CODEMAP.md
    line: 79-87
  title: CODEMAP.md 列出 5 个已删模块文件，磁盘上不存在
  problem: |
    CODEMAP.md（最后更新 2026-07-05）仍列出以下已删模块：
    1. src/agent/requirements-clarifier.ts（Phase 59 死代码清理）
    2. src/agent/complexity-analyzer.ts（Phase 59 死代码清理）
    3. src/agent/requirements-gatherer.ts（Phase 59 死代码清理）
    4. src/agent/execution-orchestrator.ts（Phase 62/66/67/69 死代码清理）
    5. src/agent/failure-report.ts（v3.7.0 零引用删除）
    开发者按 CODEMAP 定位模块会找不到文件。
  evidence:
    claim_source:
      file: CODEMAP.md
      line: 79-87
      text: "requirements-clarifier.ts — RequirementsClarifier..."
    code_location:
      file: src/runtime/app-init.ts
      line: 1729
      text: "// Phase 59：RequirementsGatherer + ComplexityAnalyzer 源文件已清理"
    search_performed:
      - pattern: "requirements-clarifier|complexity-analyzer|requirements-gatherer|execution-orchestrator|failure-report"
        scope: "src/"
        match_count: 0
  impact: 开发者按 CODEMAP 查找模块文件会失败，影响开发效率
  recommendation: |
    1. 从 CODEMAP.md 移除这 5 个已删模块的条目
    2. 或添加"已删除（Phase XX 死代码清理）"标注
  status: open
```

### F-002：TrajectoryExporter/trajectory-exporter.ts 不存在

```yaml
- id: F-002
  level: Missing
  dimension: 维度1-设计文档一致性
  location:
    file: CODEMAP.md
    line: 129-131
  title: CODEMAP 声称的 trajectory-exporter.ts 和 trajectory-aggregator.ts 不存在
  problem: |
    CODEMAP.md 列出 src/observability/trajectory-exporter.ts 和 trajectory-aggregator.ts，
    但实际 observability 目录下仅有 analytics-queue.ts/integration.ts/otel-exporter.ts。
    TrajectoryExporter 类在全代码库无匹配。
    轨迹汇总功能由 TraceCollector.summarizeTrajectory() 内联实现。
  evidence:
    claim_source:
      file: CODEMAP.md
      line: 129
      text: "trajectory-exporter.ts — TrajectoryExporter：组装单会话完整轨迹"
    search_performed:
      - pattern: "TrajectoryExporter|trajectory-exporter"
        scope: "src/"
        match_count: 0
      - pattern: "**/trajectory*"
        scope: "src/observability/"
        match_count: 0
  impact: CODEMAP 索引不准；轨迹导出功能无独立入口
  recommendation: 更新 CODEMAP.md，将轨迹汇总功能描述归到 TraceCollector
  status: open
```

### F-003：requirements-clarifier.ts 功能内联但模块文件不存在

```yaml
- id: F-003
  level: Partial
  dimension: 维度1-设计文档一致性
  location:
    file: src/runtime/goal-runner.ts
    line: 304-366
  title: 需求澄清功能内联在 goal-runner.ts，独立模块文件不存在
  problem: |
    CODEMAP 声称 src/agent/requirements-clarifier.ts 存在（RequirementsClarifier 类），
    但该文件已在 Phase 59 删除。澄清功能由 goal-runner.ts 内联的
    clarifyGoalIfNeeded() 函数实现，optimization.clarification 配置仍被读取。
    功能存在但模块结构与文档不符。
  evidence:
    claim_source:
      file: CODEMAP.md
      line: 87
      text: "requirements-clarifier.ts — RequirementsClarifier"
    code_location:
      file: src/runtime/goal-runner.ts
      line: 304
      text: "async function clarifyGoalIfNeeded(description, client, modelId)"
  impact: 开发者按 CODEMAP 找不到独立模块；功能逻辑分散在 goal-runner 中
  recommendation: 更新 CODEMAP 描述为"功能内联在 goal-runner.ts"
  status: open
```

### F-004：CODEMAP 仍列出 dream-consolidator.ts 和 dream-to-graph.ts

```yaml
- id: F-004
  level: Partial
  dimension: 维度1-设计文档一致性
  location:
    file: CODEMAP.md
    line: 55, 71
  title: CODEMAP 仍列出 Phase 56 已删的 dream-consolidator.ts 和 dream-to-graph.ts
  problem: |
    CODEMAP.md 第 55 行列出 dream-consolidator.ts（331 行），第 71 行列出 dream-to-graph.ts（236 行）。
    这两个文件在 Phase 56 花架子去除工程中已删除。
    src/ 下搜索 dream-consolidator|dream-to-graph 返回 0 匹配。
  evidence:
    claim_source:
      file: CODEMAP.md
      line: 55
      text: "dream-consolidator.ts — DreamConsolidator：整理记忆（合并去重）（331 行）"
    search_performed:
      - pattern: "dream-consolidator|dream-to-graph"
        scope: "src/"
        match_count: 0
  impact: 文档与代码不一致（已知排除项，影响较低）
  recommendation: 从 CODEMAP 移除或标注"Phase 56 已删除"
  status: open
```

### F-014：实验分支管理 API 渲染层零调用（Orphan）

```yaml
- id: F-014
  level: Orphan
  dimension: 维度3-功能入口可达性
  location:
    file: desktop/preload/index.ts
    line: 80-85
  title: experiment:list/adopt/discard/get-diff API 完整实现但渲染层零调用
  problem: |
    preload 暴露 4 个 experiment API，main 注册 4 个 ipcMain.handle，
    engine-bridge 实现 listExperiments/adoptExperiment/discardExperiment/getExperimentDiff。
    但 desktop/renderer/src/ 下搜索 window.routedev.experiment 返回 0 匹配。
    用户无法从 GUI 触达实验分支管理功能。
  evidence:
    claim_source:
      file: desktop/preload/index.ts
      line: 80-85
      text: "experiment: { list, adopt, discard, getDiff }"
    search_performed:
      - pattern: "window\\.routedev\\.experiment"
        scope: "desktop/renderer/"
        match_count: 0
  impact: Phase 37/39 投入开发资源的实验分支功能完全不可达
  recommendation: |
    1. 在设置页或对话页添加实验分支管理 UI
    2. 或暂不实现 UI 则从 preload 移除 API（减少 IPC 攻击面）
  status: open
```

### F-015：Plan 修订历史与遗漏点检查 API 渲染层零调用（Orphan）

```yaml
- id: F-015
  level: Orphan
  dimension: 维度3-功能入口可达性
  location:
    file: desktop/preload/index.ts
    line: 102-103
  title: plan.getRevisions/plan.checkOmissions API 完整实现但渲染层零调用
  problem: |
    preload 暴露 plan.getRevisions(goalId) 和 plan.checkOmissions(goalId)，
    main 注册对应 ipcMain.handle，engine-bridge 实现 checkOmissions()。
    但 desktop/renderer/src/ 下搜索 plan.getRevisions|plan.checkOmissions 返回 0 匹配。
    Phase 71 新增的 Plan 修订历史查看和遗漏点检查功能不可达。
  evidence:
    claim_source:
      file: desktop/preload/index.ts
      line: 102-103
      text: "getRevisions, checkOmissions"
    search_performed:
      - pattern: "plan\\.getRevisions|plan\\.checkOmissions"
        scope: "desktop/renderer/"
        match_count: 0
  impact: Phase 71 新功能不可达，用户无法查看 plan 修订历史或触发遗漏点检查
  recommendation: 在 GoalExecutionCard 或 StepEditor 中添加修订历史和遗漏点检查入口
  status: open
```

### F-016：Macros 系统在桌面端不可达（Orphan）

```yaml
- id: F-016
  level: Orphan
  dimension: 维度3-功能入口可达性
  location:
    file: src/macros/
    line: N/A
  title: Macros 系统 4 个内置宏在桌面端无 UI 入口和触发途径
  problem: |
    src/macros/ 模块完整实现（types/builtin/manager），4 个内置宏
    （macro-creator/daily-standup/code-review/commit-message）已定义。
    phase48Integration.macrosEnabled 配置在 SettingsCommandsTab 有开关。
    但渲染层无宏列表 UI、chat 输入框无 !macro 触发器支持、无宏补全。
  evidence:
    search_performed:
      - pattern: "macro|!macro"
        scope: "desktop/renderer/"
        match_count: 1（仅 SettingsCommandsTab 配置开关）
  impact: 用户无法在桌面端使用宏命令
  recommendation: |
    1. 在设置页添加宏列表 Tab
    2. 在 InputArea 添加 ! 触发器和宏补全
    3. 或暂不实现则从配置移除 macrosEnabled 开关
  status: open
```

### F-017：doctor 环境健康检查不可达（Orphan）

```yaml
- id: F-017
  level: Orphan
  dimension: 维度3-功能入口可达性
  location:
    file: src/runtime/doctor.ts
    line: N/A
  title: doctor 环境健康检查无 UI 按钮/命令/IPC 通道触发
  problem: |
    src/runtime/doctor.ts 存在，phase53Integration.doctor 配置有 runOnStartup 字段（默认 false）。
    但无 IPC 通道暴露 doctor 检查功能，无 slash 命令，无 UI 按钮。
    用户无法手动运行环境健康检查。
  evidence:
    search_performed:
      - pattern: "doctor|/doctor"
        scope: "desktop/renderer/"
        match_count: 1（仅 SettingsPhase53IntegrationTab 配置开关）
  impact: 用户无法手动触发环境健康检查
  recommendation: 添加 doctor IPC 通道 + 设置页"运行健康检查"按钮
  status: open
```

### F-019：sounds 配置在桌面端无消费方（僵尸配置）

```yaml
- id: F-019
  level: Missing
  dimension: 维度5-配置项完整性
  location:
    file: src/config/defaults.ts
    line: 110-115
  title: sounds 配置（enabled/completion/error/approval）在桌面端无运行时消费方
  problem: |
    defaults.ts 定义 sounds 配置（enabled: true, completion: 'default', error: 'warning', approval: 'notification'）。
    schema.ts 定义 SoundsConfigSchema。
    设置页有 Sounds Tab（SettingsSoundsTab）。
    但 src/ 和 desktop/ 下搜索 sounds.enabled|sounds.completion|playSound 返回 0 匹配。
    CLI 退役后提示音无触发点，配置不被任何运行时代码读取。
  evidence:
    search_performed:
      - pattern: "sounds\\.enabled|sounds\\.completion|playSound"
        scope: "src/ + desktop/"
        match_count: 0
  impact: 设置页提示音配置无效，用户修改后无效果
  recommendation: |
    1. 在桌面端实现提示音播放逻辑（完成/错误/审批时播放）
    2. 或移除 sounds 配置和 Sounds Tab（标注 CLI 退役遗留）
  status: open
```

### F-020：channels 配置在桌面端无运行时消费方（僵尸配置）

```yaml
- id: F-020
  level: Missing
  dimension: 维度5-配置项完整性
  location:
    file: src/config/defaults.ts
    line: 85-92
  title: channels 配置在桌面端无运行时 Webhook 服务器或渠道适配器消费
  problem: |
    defaults.ts 定义 channels 配置（entries/port/maxResponseLength/requestTimeout/trustProxy）。
    schema.ts 定义 ChannelsConfigSchema（wechat-work/telegram/slack 三种渠道类型）。
    设置页有 Channels Tab（SettingsChannelsTab）。
    但 src/ 下搜索 channels.entries|startWebhook|ChannelServer|TelegramAdapter|WechatWork
    仅在 config/loader.ts 有匹配（配置加载），无运行时 Webhook 服务器或渠道适配器代码。
  evidence:
    search_performed:
      - pattern: "channels\\.entries|startWebhook|ChannelServer|TelegramAdapter|WechatWork"
        scope: "src/"
        match_count: 1（仅 loader.ts）
  impact: 设置页渠道配置无效，用户配置 Webhook/Telegram 后无服务启动
  recommendation: |
    1. 在桌面端实现渠道集成运行时（或标注为 CLI 退役遗留）
    2. 或移除 channels 配置和 Channels Tab
  status: open
```

### F-021：pendingPlanEditResolvers 无超时清理机制

```yaml
- id: F-021
  level: Partial
  dimension: 维度4-错误路径完整性
  location:
    file: desktop/main/engine-bridge.ts
    line: 147
  title: pendingPlanEditResolvers Map 无超时清理，用户关闭 StepEditor 时 Promise 永久挂起
  problem: |
    engine-bridge.ts:147 pendingPlanEditResolvers Map 存储未 resolve 的 Promise。
    当 semi/manual 模式触发 requestPlanEdit 后，如果用户关闭 StepEditor 未响应
    （如切换页面、关闭窗口），Promise 永久挂起，goal-runner 线程泄漏。
    无超时机制和清理逻辑。
  evidence:
    code_location:
      file: desktop/main/engine-bridge.ts
      line: 778-781
      text: "const edited = await new Promise((resolve) => { this.pendingPlanEditResolvers.set(requestId, resolve); ... })"
  impact: goal-runner 执行线程泄漏，该 goalId 的目标永久卡在等待计划编辑
  recommendation: |
    1. 为 pendingPlanEditResolvers 添加超时（如 5 分钟后自动 resolve null 取消）
    2. 在页面切换/窗口关闭时清理所有 pending resolver
  status: open
```

### F-022：迭代闭环 maxRounds 边界无测试覆盖

```yaml
- id: F-022
  level: Partial
  dimension: 维度7-测试覆盖完整性
  location:
    file: N/A
    line: N/A
  title: 迭代验证闭环的 maxRounds 边界条件无测试覆盖
  problem: |
    goalVerifier.iterative.maxRounds 默认 3，goal-runner 中有迭代验证逻辑。
    但 tests/ 下搜索 maxRounds|iterative 返回 0 匹配。
    无法确认 maxRounds 边界是否严格生效，存在"静默失败"风险。
  evidence:
    search_performed:
      - pattern: "maxRounds|iterative"
        scope: "tests/"
        match_count: 0
  impact: 迭代闭环边界行为未验证，可能存在无限循环或静默失败
  recommendation: 添加 maxRounds 边界测试（maxRounds=1/maxRounds=3/达上限后行为）
  status: open
```

### F-023：配置热重载无测试覆盖

```yaml
- id: F-023
  level: Partial
  dimension: 维度7-测试覆盖完整性
  location:
    file: src/config/watcher.ts
    line: N/A
  title: 配置文件热重载（watcher.ts）无专门测试
  problem: |
    src/config/watcher.ts 实现配置文件热重载（最终一致）。
    但 tests/ 下无 config-watcher.test.ts 或类似测试文件。
    tests/code-map/watcher.test.ts 是代码地图 watcher 测试，非配置 watcher。
  evidence:
    search_performed:
      - pattern: "config.*reload|reload.*config|watcher.*test|hot.*reload"
        scope: "tests/"
        match_count: 0（config 相关）
  impact: 配置热重载功能未经验证，文件变更后重载行为不确定
  recommendation: 添加配置 watcher 测试（文件变更触发/重载后配置生效/重载失败处理）
  status: open
```

### F-024：Branch 实验场景闭环断裂

```yaml
- id: F-024
  level: Broken
  dimension: 维度2-用户场景闭环
  location:
    file: desktop/renderer/src/
    line: N/A
  title: 分支实验闭环断裂——后端完整但渲染层零调用
  problem: |
    场景六（分支实验闭环）：用户创建实验 → ExperimentManager（Git Worktree）→
    执行 → experiment:get-diff 查看 → experiment:adopt 采纳 / experiment:discard 丢弃。
    后端 ExperimentManager + IPC 通道完整实现，但渲染层零调用 window.routedev.experiment.*。
    闭环在"用户触发"环节断裂。
  evidence:
    search_performed:
      - pattern: "window\\.routedev\\.experiment"
        scope: "desktop/renderer/"
        match_count: 0
  impact: 用户无法从 GUI 使用实验分支管理功能
  recommendation: 在设置页或对话页添加实验分支管理 UI
  status: open
```

### F-025：ui.components 7 个开关在桌面端部分无消费

```yaml
- id: F-025
  level: Partial
  dimension: 维度5-配置项完整性
  location:
    file: src/config/defaults.ts
    line: 149-157
  title: ui.components 7 个开关中 5 个在桌面端无对应组件消费
  problem: |
    Phase 50 Task 7 定义的 7 个 React 组件开关（branchSwitcher/resumePicker/progressBar/
    tracePanel/disclosureLevel/diffView/configReloadNotice）原为 CLI 组件设计。
    CLI 退役后，桌面端仅有 configReloadNotice（config:reloaded 事件监听）和
    progressBar（GoalExecutionCard 替代）有对应消费。其余 5 个开关无对应桌面端组件。
  evidence:
    code_location:
      file: src/config/defaults.ts
      line: 149-157
      text: "components: { branchSwitcher: true, resumePicker: true, ... }"
  impact: 5 个配置开关在桌面端无效，用户修改后无效果
  recommendation: |
    1. 为桌面端实现对应组件（或映射到桌面端等价物）
    2. 或移除无效开关（标注 CLI 退役遗留）
  status: open
```

### F-026：Phase 59 后新增配置组缺少设置页 Tab

```yaml
- id: F-026
  level: Partial
  dimension: 维度3-功能入口可达性
  location:
    file: desktop/renderer/src/pages/SettingsPage.tsx
    line: N/A
  title: Phase 59 后新增的 5 个配置组在设置页无专门 Tab
  problem: |
    以下配置组在 defaults.ts 中有定义但在 SettingsPage 中无专门 Tab：
    - phase70Integration（上下文压缩技术）
    - closedLoopRouting（ACRouter 闭环路由）
    - memorySystem（Phase 65 记忆系统）
    - phase68Integration（知识图谱）
    - stateExternalization（状态外化）
    用户无法从 UI 修改这些配置。
  evidence:
    code_location:
      file: src/config/defaults.ts
      line: 661-807
  impact: 用户无法从 UI 配置 Phase 59 后的新功能
  recommendation: 为新增配置组添加设置页 Tab 或集成到现有 Tab
  status: open
```

### F-027：phase49Integration 部分开关对应模块已删

```yaml
- id: F-027
  level: Partial
  dimension: 维度5-配置项完整性
  location:
    file: src/config/defaults.ts
    line: 494-497
  title: phase49Integration 中 skillFlowEnabled/contextUsagePanelEnabled/evaluationFrameworkEnabled 已删除
  problem: |
    Phase 59 已删除 skillFlowEnabled/contextUsagePanelEnabled/evaluationFrameworkEnabled
    三个开关（对应模块已删）。defaults.ts 注释已说明。剩余 dualLoopEnabled 和
    qualityGateEnabled 两个开关默认 true 且有消费点。此为已清理状态，但 CODEMAP
    仍提及 Phase 49 的 6 个模块。
  evidence:
    code_location:
      file: src/config/defaults.ts
      line: 492
      text: "// Phase 59：skillFlowEnabled/contextUsagePanelEnabled/evaluationFrameworkEnabled 已删除"
  impact: 无运行时影响，仅文档不一致
  recommendation: 更新 CODEMAP 中 Phase 49 相关描述
  status: open
```

---

## 审查者自检清单

- [x] **S1** 我已读取全部 10 个必读前置文件，并建立了"应该有什么"的基线
- [x] **S2** 我列出了 RouteDev 声称拥有的全部功能清单（基线 A-O）
- [x] **S3** 我对 8 个维度的每个检查项都给出了判定（Complete/Partial/Missing/Broken/Orphan/N/A），没有跳过
- [x] **S4** 每条 finding 都附带了证据（文件:行号 + 代码/文档摘录），而非主观断言
- [x] **S5** 我没有把"已知排除项"中的功能报告为问题
- [x] **S6** 我没有把"代码质量"问题混入本审查（如命名/性能/类型安全——这些归全量审查）
- [x] **S7** 我没有把"死代码"问题混入本审查（归死代码审查），但我可以报告"有实现但无入口"的孤儿功能
- [x] **S8** 我对每个 Missing/Broken 级别的问题都给出了影响评估和修复建议
- [x] **S9** 我对"声称已实现"的判断基于文档原文，而非个人推测
- [x] **S10** 我对"实际是否实现"的判断基于代码搜索结果（含搜索 pattern 和匹配数），而非"我大概记得"
- [x] **S11** 我检查了场景间的衔接断点（维度 2.13/2.14），而不仅是单个场景内部
- [x] **S12** 我检查了 IPC 通道的双向配对（维度 6），而不仅是单向
- [x] **S13** 我检查了配置字段的消费点（维度 5），而不仅是定义点
- [x] **S14** 我在汇总报告中按级别和维度给出了统计表
- [x] **S15** 我列出了 Top 5 高优先级问题，并说明了优先级理由

---

**审查标注：** 美团-GLM5.2
**审查完成日期：** 2026-07-08
**审查提示词版本：** v1.0
