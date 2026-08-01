# RouteDev 变更记录

所有版本变更记录。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **路径迁移说明（Phase 60 后）：** `src/cli/` 已迁移到 `src/runtime/` 和 `desktop/renderer/src/`，历史条目中引用的 `src/cli/goal-runner.ts` / `src/cli/app-init.ts` / `src/cli/App.tsx` 等路径均已迁移到新位置，详见 `CODEMAP.md`。

### Phase 95 — 工程收尾与治理 — 2026-07-29

完成 92 个 IPC handler 统一校验中间件包装 + 全库 console 替换为结构化 logger，处理 2 项技术债（TD-07 / TD-20）。技术债跟踪表 §1 活跃清单清空。

#### New
- **TD-07 Task 1 IPC handler 清单文档**：新建 `docs/IPC_HANDLER_INVENTORY.md`，记录全部 92 个 IPC handler 的 channel / 参数 schema / 校验规则 / 风险分级 / 迁移状态。按高风险 18 个 / 中风险 43 个 / 低风险 31 个分级，便于审查与回归追踪
- **TD-07 Task 2-3 校验工具**：在 `desktop/main/ipc-guard.ts` 新增 `createValidatedHandlerMulti<TResult>(channel, validators, handler)` 多参数 handler 包装器 + `ipcValidate.*` 通用校验器工厂（none / string / optionalString / number / optionalNumber / object / optionalObject / boolean）

#### Changed
- `desktop/main/index.ts`：完成剩余 85 个 IPC handler 的 `createValidatedHandler` / `createValidatedHandlerMulti` 包装迁移，92/92 全部包装。其中 18 个高风险 handler 含自定义业务校验（shell:open-external URL 协议白名单 / command:execute slash 命令白名单 / tool:execute 工具白名单 / clipboard:write-text 1MB 上限防 OOM / checkpoint:rollback 一次性确认令牌消费）
- `src/` 29 文件 + `desktop/main/index.ts`：61 + 34 = 95 处 `console.log/info/debug` 全部替换为 `logger.warn/error/debug`，带结构化字段（channel / args / error / length / role / msg 等）
- 保留必要场景并标注 `// eslint-disable-next-line no-console`：
  - `src/utils/paths.ts` 3 处 `console.warn`：logger 未初始化的早期 bootstrap 阶段
  - `desktop/main/index.ts` 1 处 `console.log`：渲染层 console-message 转发到 stdout
- `desktop/renderer/` 15 处 `console.warn/error` 保留：渲染层无法使用 winston logger（写文件需主进程 API），主进程通过 `webContents.on('console-message')` 转发到日志文件

#### 架构决策
- 不重写 handler 业务逻辑（仅包装校验层）；不引入新日志库（用现有 winston logger）
- eslint no-console 规则未启用：项目当前未配置 eslint（无 .eslintrc 文件、无 eslint 依赖、无 lint 脚本），添加 eslint 配置 + 依赖超出"工程收尾"范围，留待后续单独 Phase
- 渲染层 `console.warn/error` 保留：渲染层无法使用 winston logger，主进程通过 `webContents.on('console-message')` 转发
- IPC handler 校验工具分层：`createValidatedHandler` 是外层（参数校验），权限校验是内层，二者解耦
- `ipcValidate.*` 校验器工厂返回 null 表示通过，字符串表示错误消息，与 `createValidatedHandler` 签名一致

#### 验证
- `pnpm typecheck`：TypeScript No errors found
- `pnpm test`：全量测试通过（264 passed / 7 skipped test files，3623 passed / 160 skipped tests，0 failed）
- IPC handler 包装覆盖率：92/92 = 100%
- console.log/info/debug 残留：src/ 0 处实际调用 / desktop/main/ 1 处（已标注 eslint-disable）

#### Docs
- `docs/IPC_HANDLER_INVENTORY.md`：新建（Phase 95 Task 1）
- `docs/TECH_DEBT_TRACKER.md`：TD-07 / TD-20 从 §1 活跃清单移至 §3 历史区；活跃项数 2 → 0；§2 详情区清空；§4 审查员指引数字同步更新

### Phase 94 — 架构耦合治理 — 2026-07-29

消除 goal-runner 子模块 ESM 循环依赖，收敛 Pack 门控散布，调整 agentLoop 创建职责归属，降低架构耦合度。处理 2 项 Medium 优先级架构耦合类技术债（TD-18 / TD-19）。

#### New
- **TD-19 Task 1 共享类型文件**：新建 `src/runtime/goal-runner-types.ts`，承载 `GoalRunnerCtx` 接口和 `MAX_CONTEXT_ITEMS` 常量，消除 core.ts 与 confirm/scheduler/recovery 子模块的 ESM 循环依赖
- **TD-19 Task 2 EnabledPacks 功能矩阵**：在 `src/runtime/app-init.ts` 定义 `EnabledPacks` 接口和 `computeEnabledPacks(config)` 函数，单点计算 11 个 Pack 的 enabled 状态。`InitContext` 新增 `enabledPacks` 字段，子模块通过 `ctx.enabledPacks.xxx` 读取，替代散布的 `config.packs?.xxx?.enabled`

#### Changed
- `src/runtime/goal-runner-core.ts`：移除 `GoalRunnerCtx` 接口和 `MAX_CONTEXT_ITEMS` 常量定义，改为 re-export `goal-runner-types.ts`
- `src/runtime/goal-runner-confirm.ts` / `goal-runner-scheduler.ts` / `goal-runner-recovery.ts`：从 `goal-runner-types.ts` import 共享类型和常量
- `src/runtime/app-init-agent.ts`（`createAgentSubsystem`）：入口先创建 `ReActAgentLoop` 实例并写入 `ctx.agentLoop`，确保 `setupAgentMiddleware` / `setupAgentTrust` / `setupAgentLoop` 三个阶段都能访问
- `src/runtime/app-init-agent-loop.ts`（`setupAgentLoop`）：移除 agentLoop 创建代码，改为从 `ctx.agentLoop` 读取；保留 12 个 setXxx 注入调用
- `src/runtime/app-init-tools.ts`：移除 `ReActAgentLoop` 创建及 setXxx 调用；新增 `PolicyEngine` 和 `ToolOutputPipeline` 实例写入 ctx，供 agent 子系统注入
- `src/runtime/app-init-agent-middleware.ts` / `app-init-memory.ts` / `app-init-router.ts`：5 处 `config.packs?.xxx?.enabled` 改为 `ctx.enabledPacks.xxx`
- `src/runtime/goal-runner-scheduler.ts` / `goal-runner-recovery.ts`：2 处 `config.packs?.xxx?.enabled` 改为 `ctx.enabledPacks.xxx`
- `desktop/main/bridges/goal-bridge.ts`：注入 `enabledPacks: computeEnabledPacks(config)` 到 GoalRunnerDeps

#### 架构决策
- 不重写 goal-runner 子模块逻辑，仅抽取共享类型到独立文件
- 不新建 Pack 配置 DSL 或注册机制，EnabledPacks 仅承载 `packs?.xxx?.enabled` 维度
- 不改变 ReActAgentLoop 类签名，仅调整创建归属
- agentLoop 创建放在 `createAgentSubsystem` 入口而非 `setupAgentLoop` 内部，确保 middleware 阶段能访问（原 Task 3 迁移将创建放在 setupAgentLoop 开头导致 setupAgentMiddleware 访问 ctx.agentLoop 时为 undefined，Task 4 修复此问题）
- trustGradient 在 Phase 79 后默认 Core，EnabledPacks 中固定 true（仍保留字段以兼容现有读取）

#### 验证
- `pnpm typecheck`：TypeScript No errors found
- `pnpm test`：全量测试通过（exit code 0），含 16 个 app-init.test.ts 用例全部通过

#### Docs
- `docs/TECH_DEBT_TRACKER.md`：TD-18 / TD-19 从 §1 活跃清单移至 §3 历史区；活跃项数 4 → 2；§4 审查员指引数字同步更新

### Phase 93 — 类型安全与运行时校验 — 2026-07-29

为安全敏感路径建立 Zod schema 运行时校验体系 + schema migration 框架，防止反序列化数据被篡改或版本升级后格式不兼容导致数据丢失。处理 2 项 High 优先级类型安全类技术债（TD-14 / TD-15）。

#### New
- **TD-15 schema 体系**：新建 `src/config/schemas/` 目录，包含 5 个 schema 文件 + `index.ts` 聚合导出：
  - `integrity-manifest.ts`：IntegrityManifestFileSchema + parseIntegrityManifestFile（fail-open，返回空 manifest）
  - `goal-persistence.ts`：PersistedGoalSchema + parsePersistedGoal（fail-open，返回 null）
  - `checkpoint.ts`：GoalPlanSchema + parseGoalPlan（fail-open，返回 null）
  - `app-dependencies.ts`：AppDependenciesMergeSchema + parseAppDependenciesMerge（fail-closed，装配点失败抛错）
  - `database.ts`：FileRowSchema / NodeRowSchema + parseFileRow / parseJsonArrayField（fail-open，返回 undefined/空数组）
- **TD-15 IPC payload schema**：新建 `desktop/shared/ipc-schemas.ts`，提供 parseChatStreamPayload / parseToolConfirmRequest / parseObjectPayload 三个函数，为渲染层 IPC 事件回调提供运行时校验
- **TD-14 migration 工具**：新建 `src/utils/migration.ts`，实现三个核心函数：
  - `migrate(raw, options)`：将原始数据迁移到当前 schema 版本（逐版本迁移 + fail-open 返回 fallback）
  - `readSchemaVersion(raw)`：读取 `__schemaVersion` 字段（缺失视为 0）
  - `withSchemaVersion(data, version)`：标记数据为当前 schema 版本（save 时调用）
- **TD-14 migration 单元测试**：新建 `tests/utils/migration.test.ts`，16 个用例覆盖版本读取、多版本迁移、异常处理、fallback 返回等场景

#### Changed
- `src/security/integrity-manifest.ts`：load 改为先 migrate 再 parseIntegrityManifestFile；save 用 withSchemaVersion 写入 `__schemaVersion`
- `src/agent/goal-persistence.ts`：load / tryReadGoalFile 改为先 migrate 再 parsePersistedGoal；save 用 withSchemaVersion 写入 `__schemaVersion`
- `src/harness/checkpoint-manager.ts`：loadGoalPlan 改为先 migrate 再 parseGoalPlan；saveGoalPlan 用 withSchemaVersion 写入 `__schemaVersion`
- `src/runtime/app-init.ts`：AppDependencies 合并点 `as AppDependencies` 改为 parseAppDependenciesMerge
- `src/code-map/database.ts`：files/nodes 表查询结果 `as Record<string, unknown>` 改为 parseFileRow；JSON 数组字段改为 parseJsonArrayField
- `desktop/renderer/src/store/useRouteDevStore.ts`：7 处 IPC 回调 `as` 断言改为 parse 函数调用（parseChatStreamPayload / parseToolConfirmRequest / parseObjectPayload）

#### 架构决策
- 不全量替换 136 处 `as` 断言（仅覆盖 7 个安全敏感路径：磁盘 / LLM 输出 / 网络 / localStorage / IPC / 装配点 / 数据库行）
- 不引入 io-ts / runtypes 等替代库（复用现有 Zod）
- schema 校验策略分层：装配点 fail-closed（app-init.ts 抛错立即可见），持久化文件 fail-open（返回 null/空对象，与原行为一致，避免阻塞启动）
- migration 框架仅接入 3 个有 schema 校验路径的 JSON 持久化文件，未接入无 schema 校验的文件（避免空头支票）
- schema 采用宽松校验 + passthrough 策略，仅校验顶层关键字段，让业务层在读取时按需做更细的字段校验

#### 验证
- `pnpm typecheck`：TypeScript No errors found
- `pnpm test`：全量测试通过（exit code 0），含 tests/utils/migration.test.ts 16 个用例

#### Docs
- `docs/TECH_DEBT_TRACKER.md`：TD-14 / TD-15 从 §1 活跃清单移至 §3 历史区；活跃项数 6 → 4；§4 审查员指引数字同步更新

### Phase 92 — 大文件拆分 — 2026-07-29

拆分 5 个超限文件，降低单文件改动成本与审查 token 消耗。主文件行数均降至 300 行以下（spawn-agent-delegation.ts 因单函数多阶段共享状态保留 405 行）。处理 5 项 Medium 文件拆分类技术债（TD-02 / TD-08 / TD-09 / TD-10 / TD-11）。

#### New
- **TD-02 goal-runner.ts 核实归档**：Phase 79 Task 2 已完成拆分（core/confirm/scheduler/recovery 4 子模块），本 Phase 核实确认主文件仅 13 行 re-export，直接归档
- **TD-08 app-init-agent.ts 拆分**（1207 → 42 行）：新建 `app-init-agent-trust.ts`（76 行，TrustGradient + PermissionMiddleware）、`app-init-agent-middleware.ts`（254 行，PluginSystem + 8 个中间件 + HookRunner）、`app-init-agent-loop.ts`（931 行，SubAgent + SkillLifecycle + Goal + CompletionGate + Reviewer + CodeMap + DualLoop）。dispatcher 装配顺序：middleware → trust → loop，通过函数返回值传递 pluginSystem / hookRunner 无模块级全局
- **TD-09 extractor.ts 拆分**（1003 → 137 行）：新建 `extractor-utils.ts`（69 行，共享辅助函数 + 类型）、`extractor-ts.ts`（431 行）、`extractor-py.ts`（169 行）、`extractor-java.ts`（250 行）、`extractor-go.ts`（183 行）。walkAndExtract 作为回调参数传递给各语言 extractor 避免循环依赖；PendingReference/ExtractionResult 通过 re-export 保持外部 import 路径不变
- **TD-10 spawn-agent.ts 拆分**（1047 → 275 行）：新建 `spawn-agent-types.ts`（264 行，类型 + 常量）、`spawn-agent-utils.ts`（259 行，9 个工具函数）、`spawn-agent-delegation.ts`（405 行，wrapSpawnAgentWithDelegation 单函数）。18 个公共导出通过 re-export 保持调用方 import 路径不变
- **TD-11 SettingsPage.tsx 拆分**（477 → 184 行）：新建 `components/settings/SettingsTabNav.tsx`（381 行，7 个 Tab 内容渲染）、`components/settings/SettingsDialogs.tsx`（24 行，AlertBanner）。SettingsTabNav 用 ReturnType<typeof useSettingsDraft> 类型别名简化 70+ 字段 props 接口

#### Changed
- `tests/integration/phase48.test.ts`：SPAWN_AGENT_PATH 改为 SPAWN_AGENT_UTILS_PATH（createChildRegistry / resolveProfileForSubagent 迁移到 spawn-agent-utils.ts）
- `scripts/lint-descriptions.ts`：collectBuiltinToolFiles 排除列表新增 3 个非工具文件（spawn-agent-types/utils/delegation）

#### 验证
- `pnpm typecheck`：TypeScript No errors found
- `pnpm test`：全量测试通过（含 tests/runtime / tests/code-map / tests/tools / desktop/renderer 各模块）

#### Docs
- `docs/TECH_DEBT_TRACKER.md`：TD-02 / TD-08 / TD-09 / TD-10 / TD-11 移至 §3 历史区；活跃项数 11 → 6；§4 审查员指引数字同步更新

#### 备注
- `spawn-agent-delegation.ts` 405 行超 300 行目标：wrapSpawnAgentWithDelegation 是单函数，包含 7+ 顺序执行阶段（CR-4b 策略守卫 → ContextPacker → DelegationGate → Enforcer → Lifecycle → 执行 → 活动面板 → detached session → schema 校验 → 收尾 → ScoreCard → SkillLifecycle），共享 taskId/agentId/role/enrichedPrompt/contextTokens 等局部状态。进一步拆分需新建传递状态的接口，属于"改逻辑"而非"仅移动代码"，违反 Phase 92 约束
- `extractor-ts.ts` 431 行超 300 行目标：承载 TS 分支全部 8 种节点类型 + 7 个 TS 专用辅助函数，进一步拆分需引入新设计模式或过度拆分辅助函数

### Phase 91 — 测试基建补全 — 2026-07-29

补全 goal-runner 子模块零测试（TD-16，Critical）和 ChatBridge 入口级集成测试（TD-01，High）两项测试基建类技术债。新增 38 个单元/集成测试用例，全部通过。

#### New
- **TD-16 goal-runner-core 单元测试**（`tests/runtime/goal-runner-core.test.ts`，7 tests）：覆盖 createGoalRunner 工厂的 ctx 装配（返回 handleGoalCommand / executeGoalPlan / resumeGoalPlan 三个独立 API）、gid 生成（deps.goalId 未传时用 nextId 生成 msg- 前缀，传入时使用传入 id）、emit 安全调用（onGoalEvent 抛异常时不阻塞，未注入时 no-op）、跨模块函数引用填充（ctx Object.assign 后包含 confirm/scheduler/recovery 三模块函数）
- **TD-16 goal-runner-confirm 单元测试**（`tests/runtime/goal-runner-confirm.test.ts`，11 tests）：覆盖 savePlanRevision（绝对路径拒绝、越界路径拒绝、正常 JSONL 写入、写入失败 fail-open）、handleGoalCommand（无引号参数解析、路由失败处理）、clarifyGoalIfNeeded（无 onToolConfirmRequest 时跳过澄清、LLM 解析失败 fail-open）
- **TD-16 goal-runner-scheduler 单元测试**（`tests/runtime/goal-runner-scheduler.test.ts`，9 tests）：覆盖 executeGoalPlan attestation 校验（无 attestation 自动修复、校验失败中止执行）、executeSingleStep status 流转（pending→in_progress→completed/failed）、用户中断处理（aborted 状态置为 aborted 并停止）、收尾逻辑（plan.status 设为 completed）、executePlanWithDag 降级（dagEngine 未注入时降级到 single 并日志提示）
- **TD-16 goal-runner-recovery 单元测试**（`tests/runtime/goal-runner-recovery.test.ts`，11 tests）：覆盖 resumeGoalPlan（数据校验、步骤过滤、持久化状态恢复、持久化失败 fail-open）、verifyPlan（classifier 异常 fail-open、空步骤处理）、runCompletionGate（默认 auditMode 行为、未触发条件时不输出"代码验证通过"消息）
- **TD-01 ChatBridge 集成测试扩展**（`desktop/main/__tests__/chat-bridge.integration.test.ts`，+6 tests）：新增 Phase 91 Task 5 一节，覆盖 requestId 隔离回归场景——精准中断隔离（stopGeneration(req-A) 不影响 req-B 的 controller 和 pendingConfirm）、Map 覆盖语义（同 requestId set 新 controller 时不主动 abort 旧 controller）、批量清理生命周期（clearAllAbortControllers 逐个 abort 后清空 Map）、AbortController 完整生命周期（set → get → abort → clear）、并发 3 请求各自独立的 requestId

#### Fixed
- 修复 goal-runner-core.test.ts 中未 await Promise 导致 plan_created 事件未触发的时序问题
- 修复 goal-runner-scheduler.test.ts 中 PathRouter 路由模式配置错误（使用 `mode: 'explicit'` + `explicitRoute: 'dag'` 强制 DAG 路由）
- 修复 goal-runner-recovery.test.ts 中三处断言错误：空步骤消息文案（"无需恢复" → "goal 无步骤"）、classifier 异常断言（应为 status=failed 而非步骤 completed）、runCompletionGate 条件判断（默认 auditMode 不调用 completionGate）

#### 验证
- `pnpm typecheck`：TypeScript No errors found
- `pnpm test`：3607 passed + 1 flaky（`tests/harness/audit-logger.test.ts > logChannelMessage in/out` 时序问题，单独运行通过，与 Phase 91 改动无关）
- Phase 91 新增 5 个测试文件共 38 个用例全部通过

#### Docs
- `docs/TECH_DEBT_TRACKER.md`：TD-01 / TD-16 从 §1 活跃清单移至 §3 历史区；活跃项数 13 → 11；§4 审查员指引数字同步更新
- Phase 91~95 解决计划文档已存在于 `蓝图与Phase/Phase-91-测试基建补全.md`

### 技术债清理（续）— 2026-07-29

Phase 96 之后的后续技术债清理，共处理 9 项技术债（5 项修复 / 4 项部分推进或现状标注）。详见 `docs/TECH_DEBT_TRACKER.md`。

#### 修复
- **TD-13 死配置清理**：删除全库零消费的 SoundsConfigSchema / UIComponentsSchema / ReasoningModeSchema 定义及 AppConfigSchema 对应字段；移除 defaults.ts 默认值；删除 SettingsProvidersTab 中 disabled 的推理模式 UI 块；更新 4 个测试文件
- **TD-22 错误处理统一**：新建 `src/utils/errors.ts:toErrorMessage(error)` 工具函数（安全处理 Error/string/object/null/undefined）+ 7 个单元测试
- **TD-21 测试类型安全**：`chat-bridge.integration.test.ts` 双重断言 `as unknown as AppDependencies` 改为单层 `as AppDependencies`；setupBridge 新增 `completionGateVerify` 选项，消除 4 处 `(ctx.deps as any).completionGate = ...` 后注入；47 个测试全部通过

#### 部分推进
- **TD-07 IPC 校验中间件**：新增 4 个 createValidatedHandler 包装高风险 handler——shell:open-external（URL 协议白名单 http/https/mailto，拒绝 file/javascript/data）、shell:open-path（长度上限）、shell:show-item-in-folder（长度上限）、clipboard:write-text（1MB 上限防 OOM）。共 7/92 handler 已包装
- **TD-20 console 统一**：desktop/main/index.ts 替换 11/34 处 console（chat:sync-history 6 处 + agent:* 5 处）为 logger.warn 带结构化字段。剩余 23 处含启动日志（合理保留）+ 渲染层转发（必须 console）+ IPC handler 错误（待后续）

#### 现状标注
- **TD-06 TrustGradient 接线**：checkOperation 已在 permission-engine.ts 调用；动态升级旁路是 Phase 79 有意设计
- **TD-12 跨层引用**：方案不合理（下沉会导致 src/ 反向引用 desktop/），保留现状
- **TD-23 注释噪音** / **TD-24 日志脱敏**：标注为逐步清理 / no-op

#### 文档修正
- TD-25/26/27 早在 2026-07-20 已修复，此前误留在活跃清单，本轮修正归位至历史区
- 审查员指引数字同步更新（活跃 13 项）

### Phase 96 — PI Agent 对齐 P2 批量修复

对齐 PI Agent 基础功能差距的 P2 级修复（P2-3 ~ P2-10），全部通过 typecheck + test + dist:electron 验证。

#### New
- **P2-3 Skills 统一加载**：FilesystemDiscovery 新增 `addSkillsRoot()` 多目录批量入口，`discoverSkills()` 支持多根扫描
- **P2-4 .gitignore 过滤**：Skills 模块新增 `loadGitignorePatterns()` / `isIgnored()`，扫描时按 .gitignore 规则过滤
- **P2-5 内置 SKILL.md**：新增 4 个内置 Skill（code-review / debug-investigation / test-driven-development / refactor-extraction）
- **P2-6 Prompt 位置参数**：PromptContext 新增 `positionalArgs` / `skillName` 字段；`applyVariables()` 支持 Claude Code 风格 `$1-$9` / `$@` / `$ARGUMENTS` / `$0` 占位符（先替换位置参数，再替换 `{{var}}` 命名参数）
- **P2-7 Hooks observe/on/emit 三段式模型**：HookRunner 新增 `on(event, listener, priority)`（同步监听，可 cancel 短路，返回 unsubscribe）、`observe(event, observer)`（纯观察者，fire-and-forget，并行触发）、`emit(event, data, agentId?, sessionId?)`（三段式入口：先按 priority 执行 on 监听器，再并行触发 observe 观察者）
- **P2-8 ProjectTrustStore per-cwd 持久化**：新建 `src/tools/project-trust-store.ts`，信任级别持久化到 `.routedev/trust.json`；支持 `findInherited(cwd)` 父目录继承（向上递归查找）；原子写入（临时文件+rename+fallback）；TrustGradientManager 新增 `attachPersistence(store, cwd)` / `loadInheritedFromStore()`，`setLevel` 自动 fire-and-forget 持久化。临时授权保持 resume 不恢复设计
- **P2-10 file_read 图片支持**：IMAGE_MIME_MAP 检测 + base64 编码，通过 `ToolResult.images` 注入 LLM 上下文（loop.ts 转为 ContentPart.image）

#### Changed
- **P2-9 TrustGradient 死代码清理**：移除未引用的 `TRUST_LEVEL_ORDER` / `RISK_SEVERITY` 常量，删除无外部调用的 `savePreferences` / `loadPreferences` / `getPreferences` 方法及 `TrustPreference` 接口
- **ToolResult / StructuredToolResult** 新增 `images` 字段；`ToolRegistryAdapter.executeToolStructured` / `loop-config.ts` 对应更新返回类型
- **FilesystemDiscovery** 重构 `discoverSkills()` 为多根扫描 + ignore 模式过滤
- **PromptContext** 索引签名调整为 `string | string[] | undefined`，`applyVariables` 对数组值用 `join(' ')` 转换

#### 修复的过时文档
- `CODEMAP.md`：补登 project-trust-store.ts、trust-gradient.ts、hooks.ts P2-7 三段式、prompts P2-6 位置参数、file-read P2-10 图片支持
- `docs/TECH_DEBT_TRACKER.md`：TD-06 标注 P2-8 部分修复（持久化层接通，动态升级仍旁路）

### Phase 87 — Gemini 工具调用 + clientType 装配修复
- 修复 Gemini 工具调用完全未实现的问题（硬编码 `toolCalls: []` → 完整 function calling 支持）
- 修复 engine-bridge.ts 未传 clientType 导致 DeepSeek/Qwen/Ollama 子类未接入主路径
- Gemini 现在支持非流式和流式工具调用（functionCall/functionResponse）
- 新增 8 个 Gemini 工具调用测试

### Phase 86 — OpenAI Responses API 兼容
- 新增 `openai-responses` 协议，支持 OpenAI Responses API（/v1/responses）
- 新增 OpenAIResponsesClient 客户端实现
- 支持非流式和流式调用
- 支持工具调用（function_call）
- 与现有 Chat Completions API 并行可用，用户可在 Provider 设置中选择

## [4.9.0] - 2026-07-11 — Phase 85 发布门禁（四层架构 + Pi 融合收口）

> **核心目标：** Phase 85 作为 v4.9.0 发布门禁，同步文档与四层架构 + Pi 融合设计，正式化"Core 不做"清单与防回潮规则。不新增功能，聚焦发布前文档对齐。

### Breaking Changes

- 默认工具集从 26+ 收口至 ≤10（`tools.profile: core`）
- 路由简化为 2-3 级
- Multi-Agent / Goal 高级编排 / 对抗审查 默认关闭（Extended Pack）
- 浏览器/代码地图/Trace 等默认关闭（Standard Pack）
- Progressive Trust / Implicit Feedback / KG 高级算法冻结

### New

- 会话分支：`/tree` `/fork` `/clone`（Pi 风格）
- CapabilityPack API 升级（Pi Extensions 风格：工具/命令/事件钩子）
- 用户自建 Pack 支持（`~/.routedev/packs/` 或 `.routedev/packs/`）
- 本地使用计数遥测（`/usage`）
- 设置页四层分组（基础/高级/扩展/实验）
- "Core 不做"清单正式化

### Removed from default

- 详见 `docs/SLIMDOWN_BOARD.md`

### Changed — Phase 85 Task 3：文档同步

- `AGENTS.md`：新增"Core 不做"清单（9 项）与防回潮规则（8 条），引用 `docs/CAPABILITY_LAYERS.md` 与 `docs/SLIMDOWN_BOARD.md`
- `docs/CAPABILITY_LAYERS.md`：新增第 8 节"Phase 85 更新（发布门禁）"
- `docs/SLIMDOWN_BOARD.md`：新增 Phase 85 发布门禁说明，维护阶段更新至 Phase 85

### Migration Notes

- **配置兼容**：`packs` 字段缺省时所有 Pack 默认关闭，仅 Core 生效；旧 `*Integration.enabled` 开关保留但不再控制装配门控
- **恢复高级能力**：设置 `packs.<id>.enabled: true` 或在设置页「能力分层」Tab 开启对应开关
- **恢复全工具集**：设置 `tools.profile: full`（仅调试用）

## Phase 84（v4.5.4 续，2026-07-11）— 会话分支 Core 落地

> **核心目标：** 实现会话树（Session Tree）Core 能力，支持在单一会话内创建多条分支，实现"假设探索"与"方案对比"。

### Phase 84 — 会话分支 Core 落地
- Session Tree 存储模型（树结构 + fork + clone + switchBranch + jumpToNode）
- /tree /fork /clone 命令实现并注册到 chat-bridge 命令分发
- ChatPage 树视图 UI 组件（占位集成，IPC 待接通）
- 向后兼容：旧线性消息可导入为单分支树
- Checkpoint 与会话分支联动

### Added

- **SessionTree 存储模型**：新增 `src/session/session-tree.ts` + `src/session/session-node.ts`；树结构管理整棵会话树，支持 fork（从指定节点分叉新分支）/ clone（深拷贝活跃分支到新树）/ switchBranch（切换活跃分支）/ jumpToNode（跳转到指定节点并切换所属分支）；SessionNode 携带 `checkpointId` 字段关联工作区快照；`fromLinear()` 静态方法支持旧线性消息导入为单分支树（向后兼容）
- **/tree /fork /clone 命令**：新增 `src/session/session-commands.ts` 并在 `desktop/main/bridges/chat-bridge.ts` 的 executeCommand 中注册分发；`/tree` 展示会话树结构与活跃节点高亮；`/fork [nodeId]` 从指定节点分叉并自动切换（无参数时从最后一条用户消息分叉）；`/clone` 深拷贝当前活跃分支到新会话树
- **ChatPage 树视图 UI 组件**：`desktop/renderer/src/pages/ChatPage.tsx` 集成 `SessionTreePanel` 组件作为可折叠侧边面板（GitBranch 图标切换）；当前为占位集成，treeData 传 null 显示空状态，待 IPC 通道（session:tree / session:fork / session:clone）接通后传入真实数据
- **Checkpoint 联动**：fork 时新分支继承分叉点的 `checkpointId`；回滚到带 checkpoint 的节点时同时还原工作区文件；clone 时 `checkpointId` 一并复制，新树与原树共享磁盘快照

### Changed

- `docs/CAPABILITY_LAYERS.md`：新增 Session Tree 三个模块条目（C-68 / C-69 / C-70），归属 Core 层
- `docs/SLIMDOWN_BOARD.md`：新增 Phase 84 更新说明
- 新增 `docs/session-tree.md` 用户文档（会话分支简介 / 命令用法 / Checkpoint 配合 / 典型场景 / 与 Pi 对比）

### Migration Notes

- **旧会话兼容**：旧线性消息通过 `SessionTree.fromLinear()` 自动导入为单分支树，无需手动迁移
- **无破坏性变更**：Session Tree 为新增能力，不影响现有线性对话流程

## Phase 83（v4.5.4 续，2026-07-11）— Extended Pack 收口

> **核心目标：** 三个 Extended Pack 接口审计与文档收口，不新增能力。

### Phase 83 — Extended Pack 收口
- goal-advanced / multi-agent / adversarial-review 三个 Extended Pack 接口审计完成
- GoalVerifier 确认留在 Core（对话也能用）
- 并行调度/冲突检测冻结（代码路径不可达，不删代码）
- 三个 Pack 接口干净（不泄露 Core 内部实现）
- 本 Phase 未为任何 Pack 增加新能力

### Changed

- `docs/CAPABILITY_LAYERS.md`：GoalVerifier（原 E-13）与 UnifiedReviewer（原 E-18）从 Extended Pack 迁回 Core（C-66 / C-67），对话场景即可使用，不归属任何 Pack；adversarial-review Pack 内容收窄为 E-19 / E-20（cross-model-reviewer + ReviewerPolicy）；同步更新按层分布统计与蓝图对齐校验
- `desktop/renderer/src/components/settings/SettingsPacksTab.tsx`：高级区新增「修 bug 不扩功能」维护说明提示框，与实验区冻结说明风格一致
- `docs/SLIMDOWN_BOARD.md`：新增 Phase 83 收口说明，Freeze 清单补登记「/goal 并行调度与冲突检测」冻结条目

## Phase 82（v4.5.4 续，2026-07-11）— 高级能力外置为能力包

> **核心目标：** 在 Phase 81 默认装配收口基础上，将高级能力正式外置为能力包（Capability Pack），提供 Pack API、用户自建 Pack 支持与设置页可视化分组。对齐 `docs/CAPABILITY_LAYERS.md` 四层分层模型。

### Breaking Changes

- **默认工具集收口为 10 个 Core 工具（Phase 81 Task 1）**：新增 `tools.profile`（`core` / `full`，默认 `core`）。`core` 档位仅注册 file-read / file-write / file-edit / file-search / list-directory / shell-exec / git-op / code-search / ask-user / todo-write 共 10 个核心工具；其余工具随对应 Pack 启用而注册。旧配置缺省 `tools.profile` 时默认 `core`，非核心工具不再默认可用。
- **非 Core 模块退出默认装配（Phase 81 Task 3-4）**：新增 `config.packs.*` 配置组（14 个 Pack，默认全部 `false`）。Goal 高级编排 / Multi-Agent / 对抗审查 / Skill 生命周期 / 浏览器 Web / 代码地图 / CCR 压缩 / VFS-Plan / Harness / 完整性校验 / Compose 管道 / TrustGradient / KG 高级 / ACRouter 全部默认不装配。旧配置中 `*Integration.enabled` 开关保留但不再控制装配门控，统一由 `packs.<id>.enabled` 收敛。

### Features

- **CapabilityPack API + PackContext**：提供统一的能力包接口，每个 Pack 通过 `PackContext` 获取宿主能力（ToolRegistry / AgentLoop / Config / Logger），按 `config.packs.<id>.enabled` 条件装配。Schema 定义见 `src/config/schema-observability.ts` 的 `PacksConfigSchema`，消费方分布在 `src/runtime/app-init-tools.ts` / `app-init-agent.ts` / `goal-runner-recovery.ts` / `agent/memory/graph.ts`。
- **用户自建 Pack 支持**：用户可通过配置文件 `packs.<id>.enabled: true` 启用内置 Pack，也可按 Pack 接口约定自建 Pack 并注册到 ToolRegistry。设置页「能力分层」Tab 提供可视化开关。
- **设置页四层分组展示**：`desktop/renderer/src/components/settings/SettingsPacksTab.tsx` 按基础区（Core）/ 高级区（Extended Pack）/ 扩展区（Standard Pack）/ 实验区（Freeze）四层展示。Extended Pack 标「高级」标签，Standard Pack 标「扩展」标签，每个 Pack 开关下方显示成本提示（costHint）。Freeze 区开关禁用仅展示。

### Changed

- `docs/CAPABILITY_LAYERS.md` 新增第 7 节「Phase 81-82 更新（能力 Pack 外置落地）」，标注 6 个已迁移 Pack（goal-advanced / multi-agent / adversarial-review / browser-web / code-map / harness）及 Pack 接口引用
- `docs/CONFIGURATION.md` 新增第 6 节「能力包（Capability Packs）」，列出全部 14 个 Pack 开关、成本提示与 YAML/JSON 配置示例；顶层结构补充 `packs` 与 `tools.profile`
- `docs/SLIMDOWN_BOARD.md` 标注已迁移 Pack 状态，更新冷处理队列中已完成迁移的条目

### Migration Notes

- **旧配置兼容**：`packs` 字段缺省时 Zod `preprocess` 兜底为空对象，等价于所有 Pack 关闭（仅 Core 生效），不会报错。
- **恢复旧行为**：设置 `tools.profile: full` 可恢复 Phase 81 前全部工具注册行为（仅调试用）。
- **按需启用**：在配置文件中设置 `packs.<id>.enabled: true` 或在设置页「能力分层」Tab 开启对应开关即可恢复对应能力。

## Phase 61-77（v4.5.4 续，2026-07-02 ~ 2026-07-10）

> Phase 60 后持续迭代，版本号未单独 bump。以下为各 Phase 一行简述（基于 git log 提取）。

| Phase | 简述 |
|-------|------|
| 61 | ACRouter 闭环模型路由（closedLoopRouting：路由历史回放 + 路由记忆 + 编排器 + 执行验证器） |
| 62 | 动态工作流模式与隔离治理（stateExternalization：K 句压缩 + 内容去重 + 预算感知渲染） |
| 63-64 | （已删除/合并——ExecutionOrchestrator 死代码清理，配置字段移除） |
| 65 | 记忆系统四模块重构（memorySystem：SQLite 存储 + BM25+embedding 混合检索 + 本地维护） |
| 66 | 策略管道编号分段与治理（已删除——ExecutionOrchestrator 死代码清理） |
| 67 | 推理质量诊断与 SNR 过滤（已删除——ExecutionOrchestrator 死代码清理） |
| 68 | 检索/搜索/发现三分与知识图谱（phase68Integration：操作分类 + 溯源图 + KAN 障碍检查 + 定量门控） |
| 69 | Worktree 隔离执行与多代理并行编排（已删除——ExecutionOrchestrator 死代码清理） |
| 70 | 上下文压缩技术深度优化（phase70Integration：工具输出预算 + 微压缩 + 上下文折叠 + 自动压缩守卫 + 压缩提示词 + 会话记忆） |
| 71 | code-map 增强（content hash 缓存 + 增量 PageRank + watch mode）+ @-mention 引用协议 + 进程内 VFS + plan 工具 + offload 清理 + CodebaseMemory 语义检索 + 死代码检测脚本 + 子 Agent 审计流程 |
| 72 | 退役终端 UI 层（cli/→runtime/ 重命名，desktop 为唯一前端）+ 外部借鉴落地（Profile 模板/上下文工程/工具系统/代码地图四线并行）+ 死代码全量清理（channels/voice/patterns/evaluation 等死模块删除） |
| 73 | Pi 开源借鉴落地（消息抽象层 + 工具并行 + 消息队列 + 会话树 + 供应链安全） |
| 74 | 前端交互优化（74-A/B/D/F/H/I 六子 Phase）+ 死代码清理第十三轮（ExecutionOrchestrator 整条链路 + Scheduler 空转 + Phase 65 死记忆） |
| 75 | 第一波（75-A1~A6：husky/lint-staged/commitlint 接入等）+ 第二波（75-B1~B8） |
| 76 | 功能完整度审查 + 落地计划文档 |
| 77 | 运行回放与评分卡（trace:replay/scorecard）+ Goal 冷启动恢复 + 会话状态卡（session:get-status） |

## v4.5.4 (2026-07-02) — Phase 60: 花架子去除工程五（A 档打磨与全量验收发布）

> **核心目标：** 花架子去除工程收尾。核心模块边界测试补强、`/dream` deprecated alias 删除、文档同步、版本发布。本 Phase 不新增功能，只做稳定性补强。

### Breaking Changes（汇总 Phase 56-60）

- 删除 `self-evolution/` 模块（selfEvolution/godelProposer/selfHarness 配置字段移除）
- 删除 `dream-consolidator.ts`（无入口模块）
- 删除 `eq-detector.ts`（接口不匹配）
- `/dream` 命令改名 `/consolidate-memory`，Phase 60 删除 deprecated alias，`/consolidate-memory` 是唯一入口
- `vision` 默认关闭，需显式 `vision.enabled: true`
- `executionRouter.mode: 'legacy'` 配置值移除，未注入路由器回退到 `single`
- 删除配置字段：routingFunnelEnabled / processEvaluation / archAwareMetrics / saturationMonitor / promptBuilderEnabled / requirementChangeEnabled / phase52Integration.mcpSecurity
- `ExecutionRoute` 类型从 `'single' | 'dag' | 'compose' | 'legacy'` 收窄为 `'single' | 'dag' | 'compose'`

### 默认启用（Phase 59）

- `phase53Integration.policyEngine.enabled`（Intent Guard + Playbook 安全核心）
- `phase53Integration.auditChain.enabled`（审计链路合规核心）
- `phase53Integration.mcpSecurityScan.enabled`（MCP 工具安全扫描）
- `phase53Integration.skillSecurityGate.enabled`（Skill 安全校验）
- `phase53Integration.configGuard.enabled`（配置守卫）
- 5 个安全模块装配块加 fail-open 守卫（try-catch + logger.warn），装配失败不阻塞主流程

### Added — Phase 60 Task 1：核心模块边界测试补强

- **PathRouter 边界测试**（6 用例）：`tests/agent/path-router.test.ts` 补 explicit+compose / 0 步 plan / contextUsage 边界值（0.84 不触发、0.85 触发）/ goal-runner 决策模拟
- **CCRCache 边界测试**（5 用例）：`tests/agent/ccr-cache.test.ts` 补 LRU 淘汰 / retrieve 不存在 hash / retrieveByPrefix 完整 hash 与 12 位前缀匹配 / 不匹配前缀返回 null

### Removed — Phase 60 Task 2：删除 /dream deprecated alias

- `src/cli/commands/consolidate-memory.ts` 删除 `dreamAlias` export
- `src/cli/App.tsx` 删除 `dreamAlias` import 与命令注册
- `src/cli/completion.ts` 删除 `dream` 补全项
- 残留扫描 `commands/dream|alias.*dream` 在 `src/` 无匹配

### Changed — Phase 60 Task 3：文档同步

- `routedev/docs/ARCHITECTURE.md` 更新：2.2 节补充 PathRouter；6.1/6.4 节删除已移除模块（GoalPromptBuilder/RequirementChangeAnalyzer/RoutingFunnel）；新增第 7 节"Phase 56-60 花架子去除工程总览"
- `routedev/docs/DEAD_CODE_AUDIT.md` 新增第 6 节"Phase 56-60 花架子去除工程清理统计"
- `routedev/CHANGELOG.md` 新增 v4.5.4 条目，汇总 Phase 56-60 所有 breaking change

### Migration Notes

- **配置兼容**：旧 config 中含已删除字段时，Zod safe-parse 默认忽略未知字段，不会报错
- **安全默认启用**：升级后 5 个安全模块自动开启；若装配失败则 fail-open 跳过并记录警告
- **/dream 命令**：Phase 60 删除 deprecated alias；记忆整合改为自动触发（context-manager checkpoint 压缩 + project-memory 维护），无独立 slash 命令入口
- **路由模式**：旧 `executionRouter.mode: 'legacy'` 由 z.preprocess 自动迁移为 `'auto'`

### Test Stats

- 全量测试：259 个测试文件 / 3552 用例全部通过（0 失败，2 跳过）
- 新增 11 个边界测试（PathRouter 6 + CCRCache 5）
- `pnpm typecheck` + `pnpm typecheck:desktop` + `pnpm build` 通过
- 残留花架子扫描：`dream-to-graph|execution-router|level-path-router|self-evolution|dream-consolidator|eq-detector|EQDetector|GodelProposer|SelfHarnessLoop|SelfEvolutionFramework|persona-templates|routing-funnel|executePlanWithMultiAgent` 在 `src/` 无匹配

### 花架子去除工程总结（Phase 56-60）

| Phase | 主题 | 主要成果 |
|-------|------|----------|
| 56 | D 档清除 | self-evolution + dream-consolidator + eq-detector 全删 |
| 57 | C 档收窄 | voice 移 optional、vision 默认关、dream 改名、persona 简化 |
| 58 | 路由合并 | 统一 PathRouter，删除 executePlanWithMultiAgent |
| 59 | B 档闭环 | 6 字段删除、5 安全字段默认启、7 字段补入口 |
| 60 | A 档打磨 | 边界测试、文档同步、v4.5.4 发布 |

## v4.5.3 (2026-07-02) — Phase 59: 花架子去除工程四（B 档闭环补齐）

> **核心目标：** 清算 `defaults.ts` 中所有 `*Integration.enabled: false` 字段，每个字段给出明确处置——删除 / 默认启用 / 补设置页入口。消灭"幽灵功能"（写了但不接入也不删的第三种状态）。

### Removed — 批次 1：6 个无价值 Integration 字段及对应源文件

- **删除字段：**
  - `phase49Integration.routingFunnelEnabled`（routing-funnel.ts 已在 Phase 50 删除，僵尸配置）
  - `phase52Integration.processEvaluation.enabled`（学术评估指标，无用户可见产物）
  - `phase52Integration.archAwareMetrics.enabled`（学术指标，无用户可见产物）
  - `phase52Integration.saturationMonitor.enabled`（饱和度监控无消费方）
  - `goalIntegration.promptBuilderEnabled`（与 prompts/manager.ts 职责重叠）
  - `goalIntegration.requirementChangeEnabled`（需求变更流程未产品化）
- **删除源文件：** `src/agent/goal-prompt-builder.ts` / `src/agent/requirement-change.ts`
- **保留 evaluation 三个文件：** `src/evaluation/process-defect-ontology.ts` / `architecture-aware-metrics.ts` / `saturation-monitor.ts` 被 score-card / dual-loop / completion-gate 通过 `import type` 引用，仅删配置与实例化，不删源文件
- **清理装配：** `src/cli/app-init.ts` 中相关装配块已移除
- **清理 UI 残留：** `desktop/renderer/src/pages/SettingsPage.tsx` 删除 routingFunnelEnabled Switch；`desktop/renderer/src/components/settings/SettingsPhase52IntegrationTab.tsx` 删除 processEvaluation/archAwareMetrics/saturationMonitor 三个 Card 块
- **清理 GoalTab：** `desktop/renderer/src/components/settings/SettingsGoalTab.tsx` 删除 GoalPromptBuilder 和 RequirementChangeAnalyzer 的 Switch 块；路径判定 Select 移除 'legacy' 选项（Phase 58 已从 schema 移除）
- **清理 engine-bridge：** `desktop/main/engine-bridge.ts` 删除 `goalPromptBuilder` 依赖注入，并修复 `visionAssistant` 可选链
- **清理测试：** `tests/integration/phase50-integration.test.ts` 与 `tests/integration/phase50-final-integration.test.ts` 删除 GoalPromptBuilder / RequirementChange 相关导入与测试用例

### Changed — 批次 2：5 个安全相关字段默认启用

- **改默认值 `false → true`：**
  - `phase53Integration.policyEngine.enabled`（Intent Guard + Playbook 是安全核心）
  - `phase53Integration.auditChain.enabled`（审计链路是合规核心）
  - `phase53Integration.mcpSecurityScan.enabled`（MCP 工具安全扫描）
  - `phase53Integration.skillSecurityGate.enabled`（Skill 安全校验）
  - `phase53Integration.configGuard.enabled`（配置守卫）
- **fail-open 守卫：** `src/cli/app-init.ts` 中 5 个安全模块装配块全部用 try-catch 包裹，装配失败仅 `logger.warn` 不阻塞主流程；异步装配用动态 `import().catch()` 降级
- **测试更新：** `test/phase53-integration.test.ts` 默认值断言从全 false 改为 5 个安全字段 true，DEFAULT_CONFIG 一致性测试同步更新

### Changed — 批次 3：补设置页入口与重复字段清理

- **6 个开关已有 UI 入口：** 经调研，`skillFlowEnabled` / `contextUsagePanelEnabled` / `evaluationFrameworkEnabled` / `skillLifecycle.enabled` / `prefixCache.enabled` / `budgetMonitor.enabled` 在 `SettingsPhase52IntegrationTab.tsx` / `SettingsPhase53IntegrationTab.tsx` 已有控件，无需新建 Tab
- **删除重复字段：** `phase52Integration.mcpSecurity`（与 `phase53Integration.mcpSecurityScan` 重复，保留 53 的）
  - `src/config/defaults.ts` 删除 `mcpSecurity` 配置块
  - `src/config/schema.ts` 删除 `MCPSecurityConfigSchema` 定义 + `Phase52IntegrationConfigSchema` 字段引用
  - `desktop/renderer/src/components/settings/SettingsPhase52IntegrationTab.tsx` 删除 mcpSecurity Card 块

### Changed — 孤儿 schema 清理

- **删除 `SaturationMonitorConfigSchema`：** Task 1 删除 phase52Integration.saturationMonitor 字段时 schema 定义残留，Task 4 残留扫描中发现并清理。`src/evaluation/saturation-monitor.ts` 中独立定义的 `interface SaturationMonitorConfig` 不受影响（evaluation-framework.ts / completion-gate.ts 实际引用此 interface）

### Migration Notes

- **配置兼容：** 旧 config 中含已删除字段时，Zod safe-parse 默认忽略未知字段，不会报错
- **安全默认启用：** 升级后 policyEngine / auditChain / mcpSecurityScan / skillSecurityGate / configGuard 自动开启；若装配失败则 fail-open 跳过并记录警告，不阻塞主流程
- **行为变化：** `phase52Integration.mcpSecurity` 字段已移除，相关配置请在 `phase53Integration.mcpSecurityScan` 中设置

### Test Stats

- 全量测试：259 个测试文件 / 3552 个用例全部通过（0 失败，2 跳过）
- `pnpm typecheck` + `pnpm typecheck:desktop` 通过
- 残留扫描：`routingFunnel|processEvaluation|archAwareMetrics|saturationMonitor|promptBuilderEnabled|requirementChangeEnabled|phase52Integration.mcpSecurity` 在 `src/` 无匹配

## v4.0.2 (2026-07-02) — Phase 58: 花架子去除工程三（路由合并与 legacy 路径删除）

### Changed
- **路由合并**：`src/agent/execution-router.ts` + `src/agent/level-path-router.ts` 合并为单一 `src/agent/path-router.ts`（179 行，单一真相源）；`PathRouter` 类聚合三类方法 `selectPath(level)` / `route(plan, options)` / `detectLevelSwitch(currentLevel, signals)`
- `src/cli/goal-runner.ts` 切换到 `PathRouter`，路径选择逻辑收敛为单次 `router.route()` / `router.selectPath()` 调用；未注入 pathRouter 时回退到 `'single'`（原为 `'legacy'`）
- `src/cli/app-init.ts` 实例化 `PathRouter` 并通过 `AppDependencies.pathRouter` 注入；`App.tsx` 同步传递 `pathRouter: deps.pathRouter`
- `src/config/schema.ts` 的 `executionRouter.mode` 枚举从 `'auto' | 'legacy' | 'explicit'` 收窄为 `'auto' | 'explicit'`，新增 `z.preprocess` 向后兼容：旧配置 `mode: 'legacy'` 自动迁移为 `'auto'`，`explicitRoute: 'legacy'` 自动删除
- `ExecutionRoute` 类型从 `'single' | 'dag' | 'compose' | 'legacy'` 收窄为 `'single' | 'dag' | 'compose'`
- `src/agent/state-migration.ts` / `goal-parser.ts` / `goal-types.ts` 的 import 与注释同步更新到 `path-router.js`

### Removed
- `src/agent/execution-router.ts`（54 行，合并入 path-router.ts）
- `src/agent/level-path-router.ts`（55 行，合并入 path-router.ts）
- `src/agent/execution-router.test.ts`（合并入 path-router.test.ts）
- `src/agent/level-path-router.test.ts`（合并入 path-router.test.ts）
- `src/cli/goal-runner.ts` 中 `executePlanWithMultiAgent` 函数（~90 行，legacy 路径执行函数）与 `case 'legacy'` 分支
- `src/cli/goal-runner.ts` 中 `ExecutionPlan` 类型 import（仅 legacy 函数内部使用）

### Added
- `src/agent/path-router.ts`：统一路径路由器（合并 execution-router + level-path-router）
- `tests/agent/path-router.test.ts`：12 个测试用例，覆盖 selectPath（4）/ route（5）/ detectLevelSwitch（3）

### Migration Notes
- **配置兼容**：旧的 `executionRouter.mode: 'legacy'` 配置会被 `z.preprocess` 自动迁移为 `'auto'`，无需手动改配置
- **行为变化**：未注入 pathRouter 时，goal-runner 回退到 `'single'` 路径（原为 `'legacy'`）；由于 `'legacy'` 路径已被移除，原走 legacy 的用户将自动走 single 路径
- **测试**：`tests/agent/path-router.test.ts` 12 个用例全过；全量 vitest 3584 passed / 3 failed（3 个失败均为 Windows 子进程超时，与本次改动无关）

## v4.0.1 (2026-06-26) — Phase 50: 死代码接入收尾与模块集成

### Added
- **Task 1：/goal 流程接入** — GoalPromptBuilder / GoalPersistence / GoalAuditor / RequirementChangeAnalyzer 四模块接入 `goal-runner.ts` 执行链路；新增 `goalIntegration` 配置组（4 开关，默认 false）；每个接入点 try/catch 降级
- **Task 2：多 Agent 编排接入** — StrategySelector / ExecutionStateGraph / BranchOrchestrator 三模块接入 `orchestrator.ts`；新增 `orchestrationIntegration` 配置组（3 开关，默认 false）
- **Task 3：子 Agent 委托体系接入** — ContextPacker / DelegationGate / DelegationEnforcer / SubAgentLifecycle / SubAgentScoreCardCollector 五模块通过 `wrapSpawnAgentWithDelegation` 包装器接入 `spawn-agent.ts`；新增 `delegationIntegration` 配置组（5 开关，默认 false）；`delegation-contract.ts` 随 enforcer 接入自动解除传递性死链
- **Task 4：branch-operations 去重评估** — 对比 BranchManager 后保留（有独特功能 delete/insert/undo/redo/squash），通过 `BranchManager.createOperations()` 工厂方法接入
- **Task 5：Phase 48 模块接入确认** — CiteResolver / ClaudePluginImporter / CodexInstructionImporter / MacroManager / ClaudeMCPBridge 五模块在 `app-init.ts` 添加最小接入代码；新增 `phase48Integration` 配置组（默认 true）
- **Task 6：Phase 49 模块接入确认** — SkillFlowEngine / DualLoopOrchestrator / SkillQualityGate / ContextUsagePanel / EvaluationFramework / RoutingFunnel 六模块在 `app-init.ts` 添加最小接入代码；新增 `phase49Integration` 配置组（6 开关，默认 false）
- **Task 7：React 组件接入 UI** — BranchSwitcher / ResumePicker / ProgressBar / TracePanel / DisclosureLevel / DiffView / ConfigReloadUI 七组件接入 `App.tsx` / `ChatView.tsx` / 命令处理器；新增 `ui.components` 配置组（7 开关，6 默认 true + tracePanel 默认 false）；CommandBridge 接口扩展 5 个可选回调
- **Task 10：集成测试 + 文档同步** — 新增 `tests/integration/phase50-final-integration.test.ts` 端到端测试（5 场景 12 测试：/goal 流程串联 / 子 Agent 委托全链路 / UI 组件命令触发 / 死代码清理验证 / export 清理验证）；新增 `docs/DEAD_CODE_AUDIT.md` 和 `docs/CONFIGURATION.md` 两份文档；更新 `docs/ARCHITECTURE.md` 增加 Phase 50 模块接入总览

### Changed
- `src/config/schema.ts` 新增 `GoalIntegrationSchema` / `OrchestrationIntegrationSchema` / `DelegationIntegrationSchema` / `Phase48IntegrationSchema` / `Phase49IntegrationSchema` / `UIComponentsSchema` 六组 Zod schema
- `src/config/defaults.ts` 同步新增六组配置默认值
- `src/cli/goal-runner.ts` 接入 4 个 /goal 流程模块（try/catch 降级）
- `src/cli/app-init.ts` 创建 Phase 48/49 模块实例并注入
- `src/tools/builtin/spawn-agent.ts` 修复 DelegationContract 导入源 + 接入委托体系 5 模块
- `src/hooks/registry.ts` 修复预存 broken import（`./generator.js` → `../agent/hooks.js`）
- `src/plugins/index.ts` 移除指向已删除 sdk.ts 的 re-export
- `src/agent/branch.ts` 新增 `createOperations()` 工厂方法
- `src/cli/App.tsx` 新增 5 个 CommandBridge 回调 + JSX 渲染 7 个组件
- `src/cli/components/ChatView.tsx` 新增 `enableDisclosure` prop + 系统消息 >200 字符包裹 DisclosureLevel
- `src/cli/service-context.ts` CommandBridge 接口扩展 5 个可选回调
- `src/cli/commands/resume.ts` / `trace.ts` / `diff.ts` 配置开关触发对应组件渲染
- `desktop/renderer/src/components/Phase50Components.tsx`（新建）6 个桌面端 wrapper 组件
- `package.json` 版本号从 4.0.0 升至 4.0.1（patch：bug 修复 + 死代码清理 + 模块接入，默认 enabled:false 不改变默认行为）

### Removed
- **11 个完全死掉的源文件**：`src/agent/types.ts` / `src/router/reasoning-mode.ts` / `src/utils/stall-detector.ts` / `src/utils/error-messages.ts` / `src/config/codegraph-manager.ts` / `src/harness/tracing-executor.ts` / `src/harness/experiment-runner.ts` / `src/hooks/market-manager.ts` / `src/hooks/generator.ts` / `src/plugins/sdk.ts` / `src/cli/wizard.tsx`
- **7 个无引用的 barrel 文件**：`src/cite/index.ts` / `src/import/index.ts` / `src/macros/index.ts` / `src/mcp/index.ts` / `src/skills/index.ts` / `src/agent/patterns/index.ts` / `src/evaluation/index.ts`
- **8 个测试文件**：`tests/cli/wizard.test.ts` / `tests/harness/tracing-executor.test.ts` / `tests/harness/experiment-runner.test.ts` / `tests/hooks/generator.test.ts` / `tests/utils/stall-detector.test.ts` / `tests/utils/error-messages.test.ts` / `tests/plugins/sdk.test.ts` / `tests/cli/notification-audit.test.ts`
- **22 个完全未调用的函数/方法**：分布在 macros/builtin.ts / skill-flow-engine.ts / skill-flow-checkpoint-store.ts / evaluation-framework.ts / persona-templates.ts / quality-aggregator.ts / requirements-clarifier.ts / memory/context-manager.ts / preference-manager.ts / durable-executor.ts / cache-optimizer.ts / deterministic-rules.ts / repo-map.ts / cli/notification.ts / design-system.ts
- **84 个多余 export**：覆盖 46 个文件（src/agent/ 26 文件 38 export / src/agent/memory/ 4 文件 10 export / src/agent/multi/ 5 文件 9 export / src/agents/ 6 文件 12 export / src/skills/skill-flow-types.ts 11 export / src/router/ 1 文件 1 export / src/cli/ 3 文件 3 export）

### Fixed
- **Bug 1**：`src/import/claude-plugin-importer.ts` 调用 `bridge.convertFromClaudeConfig(...)` 但该方法不存在 → 改为 `bridge.importFromClaudeConfig(...)`（原分支永远不可达）
- **Bug 2**：`src/skills/model-drift-detector.ts` 入参类型为 `ParsedSkill[]` 但内部用 `as SkillMetadataWithDrift` 断言 → 入参改为 `ParsedSkillWithDrift[]`，移除类型断言
- **预存 broken imports**：`src/hooks/registry.ts` 导入已删除的 `./generator.js` → 改为 `../agent/hooks.js`；`src/plugins/index.ts` re-export 已删除的 `sdk.ts` → 移除
- **DelegationContract 导入源**：`spawn-agent.ts` 从 `delegation-enforcer.js` 导入 DelegationContract，但实际定义在 `delegation-contract.js` → 修正导入源
- **resume.ts 配置访问**：`ctx.config.ui.components?` 改为 `ctx.config?.ui?.components?`（mock ctx 缺少 config 字段时报错）
- **ipc-bridge.test.ts hook 测试**：`hooks/generator.ts` 删除后 `engine.createHook()` 桩化返回失败 → 测试改为手动创建 HookConfigRegistry；event 名称从 `'after_tool_call'` 修正为 `'post-tool-call'`；补全 HookConfig 必填字段

### Pitfalls
- 新增 5 条陷阱（#166-170），覆盖接入模块类型不匹配 / 委托契约传递性死链 / branch-operations 去重边缘功能 / React 组件接入破坏布局 / export 清理误删跨文件使用

### Test Stats
- 新增 135 个测试（Task 1-9 单元/集成测试 123 个 + Task 10 端到端测试 12 个），远超 ≥40 要求
- 全量测试全部通过，typecheck / build / build:electron 均通过

## v4.0.0 (2026-06-25) — Phase 49: Skill 固化流水线与 Loop 工程化验证层

### Added
- **Task 1：SkillFlow 引擎** — 新增 `src/skills/skill-flow-engine.ts` + `skill-flow-types.ts` + `skill-flow-checkpoint-store.ts` + `attractor.ts`；5 种节点类型（step / checkpoint / user-gate / loop / branch）；onFailure 处理（retry / abort / goto）；Attractor 吸因子注入器；CheckpointStore 支持任务中断恢复（.routedev/skill-flow/ 持久化 + hash 校验 + stale 检测）；约 45 个测试
- **Task 2：双循环编排器** — 新增 `src/agent/dual-loop-orchestrator.ts` + `dual-loop-types.ts` + `cross-model-reviewer.ts` + `loop-memory.ts`；Inner ReAct + Outer 验证（GoalVerifier + CompletionGate + CrossModelReviewer）；3 步仲裁规则（CompletionGate > GoalVerifier > CrossModelReviewer critical）；LoopMemory 失败记忆持久化（MAX_KEPT_FAILURES=5）；"让 AI 自己改"约束；约 38 个测试
- **Task 3：Skill 质量门** — 新增 `src/skills/quality-gate.ts` + `skill-schema-validator.ts` + `fallback-checker.ts` + `skill-validator.ts` + `model-drift-detector.ts` + `runtime-fallback-detector.ts`；三层检查（Schema + 兜底 + 可选 3 场景验证）；模型漂移检测（同主版本 low / 跨主版本 high）；约 42 个测试
- **Task 4：上下文占用率** — 新增 `src/agent/context-usage-panel.ts` + `src/cite/structured-injector.ts` + `src/skills/progressive-disclosure.ts` + `src/cite/style-sample-injector.ts`；三级阈值（50%/80%/90%）；分项 token 占用（systemPrompt/history/toolResults/references/skillPrompts）；结构化注入（不全量读文件，只注入相关符号块）；渐进式披露（最小注入集 + 按需加载）；打样注入（标注"勿照抄业务逻辑"）；约 40 个测试
- **Task 5：评估集框架** — 新增 `src/evaluation/evaluation-framework.ts` + `online-monitor.ts`；Smoke(10) / Regression(30) 两套评估集；LLM-as-Judge 五大陷阱对策（洗牌 / Rubric / 跨模型 / 多维度 / expectedBehavior）；7 类在线监控信号 + 配置 ROI 评估；约 35 个测试
- **Task 6：意图路由四层漏斗** — 新增 `src/router/routing-funnel.ts`（复用 `deterministic-rules.ts`）；L0 正则 / L1 向量 / L2 LLM / SafeNet 四层；熔断器（连续低置信度 > 5 次触发，5 分钟冷却期）；四条铁律（规则优先 / 意图枚举 / 低置信度反问 / 埋监控）；约 53 个测试
- **Task 7：集成测试与文档同步** — 新增 `tests/integration/phase49-e2e.test.ts` 端到端测试（8 个场景：SkillFlow+双循环 / 质量门 / 上下文占用率 / 评估集 / 意图路由 / 跨模型审查 / 反思模式 / Loop 记忆）；新增 `docs/SKILLFLOW.md`、`docs/DUAL_LOOP.md`、`docs/QUALITY_GATE.md`、`docs/CONTEXT_USAGE.md`、`docs/EVALUATION.md`、`docs/ROUTING.md` 六份文档

### Changed
- `package.json` 版本号从 3.9.0 升至 4.0.0（主版本号升级：Phase 49 引入 SkillFlow 引擎和双循环编排器两大架构性变更）

### Pitfalls
- 新增 17 条陷阱（#139-155），覆盖 SkillFlow 节点循环 / 双循环仲裁 / 质量门 Token 消耗 / 上下文面板性能 / 结构化注入遗漏 / SafeNet 熔断 / 跨模型审查回退 / adversarial 用例失效 / LLM-as-Judge 模型漂移 / 渐进式披露信息缺失 / SkillFlow 中断恢复 / 打样注入过度模仿 / 模型漂移弹窗时机 / 配置 ROI 评估

### Test Stats
- 新增 261 个测试（Task 1-6 单元测试 253 个 + Task 7 集成测试 8 个），远超 ≥8 集成测试要求
- 集成测试覆盖 8 个端到端场景，全部通过（189ms）

## v3.9.0 (2026-06-25) — Phase 48: 引用系统与外部生态兼容层

### Added
- **Task 1：引用系统核心** — 新增 `src/cite/` 模块（types/manager/resolver/index）；8 种引用类型（file/folder/text/skill/tool/macro/url/message）；CiteManager 管理引用标签（add/remove/clear/list/toJSON/formatForUI）；CiteResolver 后端解析引用为 injectedContext + preflightTools + skillPrompts + allowedTools；消息引用版本与失效处理（targetVersion/targetBranchId 校验，outdated/unreachable/deleted 状态）；58 个测试
- **Task 2：Anthropic Skills / Claude Code Plugin 兼容** — 新增 `src/import/` 模块（tool-name-mapper/anthropic-skills-loader/claude-plugin-importer/index）；扫描 `anthropic_skills/` 目录加载 SKILL.md；导入 Claude Code Plugin 包（plugin.json + skills + commands + agents + .mcp.json + hooks）；工具名映射（Read→read_file 等 8 对）；社区来源 Hook 进沙箱试用（陷阱 #129）；未映射工具 warning 不静默失败（陷阱 #132）；47 个测试
- **Task 3：Codex Instructions 导入** — 新增 `src/import/codex-importer.ts`；扫描 `.codex/instructions.md` + `.codex/codex.md` + `.codex/*.md` 按字母顺序合并；3 种导入模式（system_prompt / project_memory / ignore）；project_memory 模式按 `##` 标题切分并打 codex-instruction 标签；hasUpdates 通过 mtime 检测文件更新；12 个测试
- **Task 4：MCP 生态桥接** — 新增 `src/mcp/claude-bridge.ts`；ClaudeMCPBridge 类支持 .mcp.json 导入/导出/自动发现；5 种传输协议（stdio/http/sse/streamable_http/websocket）；3 种会话生命周期（per-call/per-session/persistent）；ID 冲突自动重命名（陷阱 #131）；部分失败不影响其他 server（陷阱 #137）；14 个测试
- **Task 5：Macros 系统** — 新增 `src/macros/` 模块（types/builtin/manager/index）；4 个内置宏（macro-creator/daily-standup/code-review/commit-message）；MacroManager 支持 loadAll/getMacro/listMacros/createMacro/deleteMacro/searchMacros；通过 `!` 触发器引用；preferredProfile 字段联动 Agent Profile；32 个测试
- **Task 6：集成测试与文档同步** — 新增 `tests/integration/phase48-e2e.test.ts` 端到端测试（5 个场景：引用+Skill 联动 / Codex+Macro 联动 / MCP+Tool 引用 / 引用持久化 / 消息引用版本失效）；新增 `docs/CITE.md`、`docs/IMPORT.md`、`docs/MACROS.md` 三份文档

### Changed
- `src/config/schema.ts` 扩展 MCPServerConfigSchema 支持 5 种 transport（sse/streamable_http/websocket 新增）；MCPServerEntrySchema 新增 lifecyclePolicy/origin 字段；MCPConfigSchema 新增 lifecyclePolicy 默认 per-session；新增 ImportConfigSchema（anthropicSkillsAutoEnable/claudePluginAutoEnable/codexInstructions/codexMemoryTag）
- `src/config/defaults.ts` 同步新增 mcp.lifecyclePolicy 和 import 默认值
- `src/tools/mcp/types.ts` 扩展 MCPTransportType 支持 5 种；新增 MCPSseConfig/MCPStreamableHttpConfig/MCPWebsocketConfig 类型；MCPServerEntry 新增 lifecyclePolicy/origin 字段
- `package.json` 版本号从 3.8.1 升至 3.9.0

### Pitfalls
- 新增 14 条陷阱（#125-138），覆盖引用沦为复制粘贴 / 标签过多挤压 / 引用内容过长 / 引用持久化膨胀 / 社区 Hook 危险 / Codex 冲突 / MCP ID 冲突 / 工具名映射不全 / Macro 恶意指令 / 触发器误触发 / CiteResolver 绕过权限 / 消息引用版本不一致 / MCP 多协议降级 / Macro Profile 漂移

### Test Stats
- 新增 163 个测试（Task 1: 58 + Task 2: 47 + Task 3: 12 + Task 4: 14 + Task 5: 32），远超 ≥55 要求
- 全量测试 3243 passed / 2 skipped / 0 failed

## v3.8.1 (2026-06-25) — Phase 48: 功能接线收尾与设置集成

### Fixed
- 权限双旋钮接线：app-init.ts 从 config.security.sandbox/approval 读取并应用（Phase 47 Task 4 功能在交互模式生效）
- loadProjectDoc 接线：app-init.ts 调用 loadProjectDoc 激活多文件名 fallback（Phase 47 Task 8 功能生效）
- ScheduleEngine 实例化：app-init.ts 创建 ScheduleEngine 并注入 ServiceContext（定时任务可实际执行）
- AgentProfileManager 接入 spawn-agent：子 Agent 派遣读取 profile 工具白名单和系统提示词
- TrajectoryAggregator 接入 harness：TraceCollector 整合 TrajectoryAggregator，/trace 命令共享实例

### Added
- SettingsPage 安全 Tab 新增沙箱级选择器与审批级覆盖表格
- ProjectMemoryManager 新增 setProjectDoc/getProjectDoc 方法
- package.json 新增 lint:descriptions npm script

### Removed
- 删除遗留的 src/cli/exec.ts（被 exec-runner.ts 替代）

## [3.8.0] - 2026-06-25

### Phase 47 — 文档瘦身 / 权限双旋钮 / 非交互模式 / 子代理审查 / Checkpoint 可视化 / 自定义命令 / fallback 兼容 / GitHub Action

### Added
- **Task 1：AGENTS.md 瘦身 + pitfalls-guide Skill** — AGENTS.md 从 200+ 行瘦身至 ≤120 行，仅保留 Top 10 核心陷阱；完整 81 条陷阱（1-64 + 126-142）迁移至 `.routedev/skills/pitfalls-guide/SKILL.md`，按 Phase 分章组织
- **Task 2：description 规范 + lint 脚本** — 新增 `scripts/lint-descriptions.ts` 审计 Tool/Skill description（MIN_LENGTH / NO_TRIGGER / NO_VERB 三规则）；`verify.ts` 集成 `checkDescriptionLint` 检查项（过渡期不阻断，陷阱 #134）；新增 `docs/DESCRIPTION_GUIDE.md` 规范文档；改写全部内置工具 description 使其合规
- **Task 3：routedev exec 非交互模式** — 新增 `src/cli/exec-runner.ts` 和 `src/cli/args.ts` 的 `ExecArgs` 类型；支持 `--json` / `--allowedTools` / `--timeout` / `--workMode` / `--maxSteps` / `--output` 参数；总超时返回退出码 2（陷阱 #135）；进度走 stderr / 结果走 stdout
- **Task 4：权限双旋钮（SandboxLevel + ApprovalLevel）** — `src/tools/permission-engine.ts` 新增沙箱级（read-only / workspace-write / full-access）和审批级（always-ask / on-request / never-ask）双旋钮；沙箱级判断在审批级之前（陷阱 #136）；headless 模式下 always-ask 自动 deny；`config.example.yaml` 新增 `security.sandbox` 和 `security.approval` 配置段
- **Task 5：/review 命令** — 新增 `src/cli/commands/review.ts` 对抗性审查命令；调用独立子代理（`subagentType: 'reviewer'` + `isolated: true`）；调用前临时设为 read-only 沙箱兜底（陷阱 #137）；支持 correctness / security / performance / style 四种 focus
- **Task 6：Checkpoint 可视化与语义化摘要** — 新增 `desktop/renderer/src/components/CheckpointTimeline.tsx` 时间轴组件；`CheckpointManager` 新增 `generateSummary()` 和 `setLLMClient()` 方法，LLM 生成不超过 30 字的中文摘要；LLM 超时/失败时降级为原始 description（陷阱 #138）；Checkpoint 接口新增 `summary` 和 `stats` 字段
- **Task 7：自定义 Slash 命令** — 新增 `src/cli/custom-commands.ts` 加载器；从 `.routedev/commands/` 目录加载 .md 文件（frontmatter + 模板变量）；支持 `{{git_diff}}` / `{{git_status}}` / `{{git_branch}}` 和 `$1` 位置参数；模板变量一次性替换不递归（陷阱 #139）；与内置命令冲突时 warn 并忽略
- **Task 8：fallback 兼容** — `src/memory/project-memory.ts` 新增 `loadProjectDoc()` / `mergeDocs()` / `truncateDoc()` 函数；支持 AGENTS.md / AGENTS.local.md / AGENTS.override.md / CLAUDE.md / CLAUDE.local.md 多文件名 fallback；AGENTS.override.md 语义是「跳过」而非「合并」（陷阱 #140）；`maxBytes` 默认 32768（对齐 Codex 32KiB）
- **Task 9：GitHub Action** — 新增 `action.yml`（inputs: prompt / work-mode / allowed-tools / config；outputs: result；runs: node20 + dist/index.js）；新增 `scripts/action-entry.ts` 入口脚本（零依赖，不引入 @actions/core）；config 必须用 Base64 传输（陷阱 #141）；新增 `.github/workflows/routedev-example.yml` 示例 workflow；新增 `docs/CI_SECURITY.md` 安全规范
- **Task 10：集成测试与文档同步** — 新增 `tests/integration/phase47.test.ts` 端到端集成测试（10 个测试覆盖 Task 1-9 协同）；AGENTS.md 新增陷阱 #133-142 简版；SKILL.md 追加 Phase 47 章节（10 条陷阱完整说明）；CODEMAP.md 新增 7 个条目；CHANGELOG.md 新增 v3.8.0 条目

### Changed
- AGENTS.md 行数从 200+ 行瘦身至 74 行（≤120 行约束）
- pitfalls-guide SKILL.md 陷阱总数从 71 条增至 81 条（新增 #133-142）
- `package.json` 版本号从 3.7.0 升至 3.8.0
- `config.example.yaml` 新增 `security.sandbox` / `security.approval` / `projectDoc` 三个配置段

### Pitfalls
- 新增 10 条陷阱（#133-142），覆盖 AGENTS.md 瘦身 / description lint / exec 超时 / 沙箱级优先 / review 沙箱兜底 / Checkpoint 摘要降级 / 模板变量转义 / override 跳过语义 / Base64 传输 / 沙箱缓存刷新

## [3.7.0] - 2026-06-25

### Fixed
- IPC 桥接：9 个桩实现 IPC handler 接通真实后端（CodeGraph/Experiment/Hook）
- Hook 接线：HookConfigRegistry 加载的配置转换为 HookDefinition 并注册到 HookRunner
- HttpRegistryClient：5 个 Not implemented 方法全部实现（fetch + URL 规范化）
- token-alert.json 事件类型修复：新增 on-model-call 事件 + 白名单校验
- 5 个 CLI 命令注册：/clarify /experiment /quality /schedule /trust
- /clarify 不再引用不存在的 /clarify-enrich

### Removed
- 9 个未引用的桌面组件（BranchPanel/BranchReviewModal/ExperimentReviewModal/MessageTimeline/RequirementChangeModal/Sidebar/SubAgentCard/ThinkingSteps/ToolApprovalModal）
- 3 个零引用源文件（blackboard-extension.ts/implicit-feedback-detector.ts/failure-report.ts）
- trust-gradient.ts 中 CompactionAuditLog 和 createSandboxedRegistry 导出
- 2 个死测试（declarative-context.test.ts/entity-state.test.ts）

### Added
- HookConfig → HookDefinition 转换器（adapter.ts）含变量替换和超时
- HookEvent 白名单校验（isValidConfig）
- on-model-call 事件类型

## [3.6.0] - 2026-06-24

### Added
- 语音交互管理（VoiceManager）：STT（web-speech/whisper-local/openai-whisper/off）+ TTS（system/openai/off），支持麦克风权限检查与回退提示
- TTS 安全策略：sanitizeForTTS 移除 markdown/代码块/工具调用/reasoning 标记，只朗读最终回复
- 人格引擎接线（PersonaEngine）：intensity=none 时不注入 system prompt，动态 import + fail-open
- 用户偏好持久化接线（PreferenceManager）：显式偏好 confidence=1.0，异步加载磁盘状态
- 情绪检测器接线（EQDetector）：注册到中间件管线，动态 import + fail-open
- 新增配置段：persona（启用/强度/当前人格 ID）+ voice（STT/TTS 提供商/语言/自动朗读）+ memory（推理/自动学习/注入阈值）+ discovery（功能发现/启动提示）
- App 接线：PersonaEngine / PreferenceManager / EQDetector / VoiceManager 四模块动态 import + fail-open 接入
- 集成测试：12 个测试覆盖 Schema / Defaults / VoiceManager sanitizeForTTS / VoiceManager getFallbackMessage / PersonaEngine / PreferenceManager

## [3.5.0] - 2026-06-24

### Added
- 消息节点持久化与恢复：JSONL 格式 + 备份 + 快照
- 节点级操作补全：删除/插入/撤销/重做/批量编辑
- 需求变更 diff 与影响分析：自动检测需求变更，判断是否需要重新规划
- 消息分支与 /goal/experiment 联动：双向映射 + 结果回写
- 多分支并行实验：文件冲突检测 + 结果对比视图
- UI 增强：消息时间线 + 需求变更弹窗
- 新增配置：conversation（持久化/节点上限/撤销栈）+ experiment（并行/冲突检测/自动清理）

## [3.4.0] - 2026-06-24

### Added
- 代码地图回退方案：tree-sitter 不可用时自动切换到正则引擎（CodeMapFallback）
- 策略冲突仲裁：security > skill > hook 三级优先级，Policy block 优先于 Skill injectPrompt（PolicyArbitrator）
- 远程市场 Registry 接口预留：StubRegistryClient（空列表）+ HttpRegistryClient（待实现）+ createRegistryClient 工厂
- 新增配置段：subAgents（子 Agent 并行上限 + 角色门控）/ goal（澄清 + 确认 + 审计模式 + token 预算）/ hookEnhancement（函数级 Hook + 沙箱 + 试用期 + 分组）
- 市场配置扩展：market.registryUrl / market.registryToken（远程 Registry 拉取）
- App 接线：CodeMapFallback / PolicyArbitrator / RegistryClient 三模块动态 import + fail-open 接入
- 集成测试：12 个测试覆盖 Schema / Defaults / Fallback / Arbitrator / RegistryClient

## [3.3.0] - 2026-06-24

### Added
- 自研代码地图引擎：tree-sitter (WASM) + SQLite + PageRank + Aider 风格渲染
- 代码地图压缩：RepoDistill 预算分配
- 多 Agent 编排升级：图状态机 + 结构化 Handoff + Score Card + 编排策略 + 变量池
- Skill/Hook 市场：SKILL.md 标准 + 草稿/发布生命周期 + 导入导出
- 策略引擎：Intent Guard + Playbook + Tool Guide + Tool Approval
- 推理模式：fast / balanced / accurate 三模式切换
- 分支 UI 闭环：BranchPanel + BranchReviewModal + ToolApprovalModal
- 新增设置：代码地图引擎 / 策略引擎 / 市场 / 推理模式

## [3.2.0] - 2026-06-24

### Added
- 构建管道加固：Windows Defender 排除项 + pre-build 清理 + 重试包装
- 渐进式信任权限系统：TrustGradientManager 接线 + 五级风险分类 + 偏好持久化 + /trust 命令
- 确定性路由：deterministic 分类级别 + 规则表 + 零 LLM 快速通道
- Agent 质量监测：QualitySignalMiddleware + ImplicitFeedbackDetector + QualityAggregator + /quality 命令
- 用户经验适配层：三级经验等级 + 行为差异化 + System Prompt 注入
- 新增设置：渐进式信任 / 质量监测 / 用户体验

## [3.1.0] - 2026-06-24

### Added
- 代码地图增强：双轨制架构（内置轻量 + CodeGraph MCP 外接）
- ContextInjector 中间件：自动注入项目结构到 system prompt
- Skill AI 自动生成：自然语言描述 → SKILL.md
- 代码风格分析器：从现有代码学习编码规范
- Hook AI 自动生成：自然语言描述 → Hook 配置
- Hook 模板库：10 个常用 Hook 模板一键启用
- 分支编辑-审查-合并工作流：Git Worktree 隔离 + 选择性合并
- 分支面板 UI：实时进度 + Diff 审查模态框
- 新增设置：代码地图 / Hooks / 实验分支配置

## v3.0.0 (2026-06-23)

### Phase 38：Harness 中间件、子 Agent 工具化与知识管理增强

本版本聚焦"补齐三个系统性架构缺口"——中间件管道从 1/5 激活到 5/5、子 Agent 从硬编码管道升级为可组合工具、知识图谱从"只进不出"升级为完整反馈闭环。基于 deepagents-in-action / deer-flow / cognee / multica 四项目对标调研提取设计模式。

#### Task 1：中间件管道全面激活
- **五阶段洋葱模型**：激活 onSystemPrompt / onModelCall / onReasoning / onAgent 四个死阶段（onActing 已有），形成完整的中间件管道
- **LoopDetectionMiddleware**：检测重复工具调用循环（滑动窗口 + argsHash），3 次重复后注入系统提示打破循环
- **fail-open 策略**：四个新阶段中间件异常时记录 warn 但继续执行；onActing 保持 fail-closed
- **配置**：`middleware.loopDetection`（enabled/windowSize/maxRepeats）

#### Task 2：子 Agent 工具化与防递归增强
- **增强签名**：SpawnAgentFunction 从 `(taskDescription, options?)` 升级为 `({ description, prompt, subagentType, maxIterations, isolated })`，向后兼容旧字符串参数
- **防递归：工具集物理隔离**：子 Agent 的 ToolRegistry 是父 Agent 的 clone() 但移除 spawn_agent，物理上无法再派遣孙子 Agent（替代深度计数器方案）
- **角色工具集**：general/researcher/coder/reviewer 四种角色，每种角色有工具白名单
- **并行上限**：maxConcurrentSubAgents（默认 3），达到上限时返回错误
- **竞态修复**：不再在共享 registry 上 register/unregister，每次 spawn 创建独立 childRegistry
- **配置**：`agent.maxConcurrentSubAgents`

#### Task 3：知识图谱反馈闭环与遗忘机制
- **/dream 桥接修复**：/dream 命令现在调用 ingestToGraph()，Dream 结果流入知识图谱（之前是死代码）
- **improve() 反馈**：useful 递增 validatedCount、incorrect 标记 deprecated、unused 递增 unusedCount
- **forget() 遗忘**：按 nodeIds 或 criteria（staleFor/unusedFor/type）遗忘，入边保护，dryRun 预览
- **/memory 扩展**：新增 list / forget / feedback 子命令

#### Task 4：多策略记忆检索与图谱持久化
- **recallV2() 多策略**：semantic / graph / temporal / type_weighted / hybrid 五种策略
- **自动策略路由器**：纯关键词匹配（不调用 LLM），根据查询特征选择最佳策略
- **跨会话持久化**：知识图谱保存到 `.routedev/memory/knowledge-graph.json`，debounce 500ms
- **配置**：`knowledgeGraph`（persistence/autoForget/recall）

#### Task 5：集成测试与文档同步
- **3 个集成测试**：中间件链顺序执行 + 子 Agent 防递归 + 知识图谱完整生命周期
- **AGENTS.md**：新增陷阱 #60-64
- **CODEMAP.md**：新增 Phase 38 模块索引
- **总计新增测试**：46 个（Task 1: 12 + Task 2: 17 + Task 3+4: 17 + Task 5: 3），远超 ≥35 要求

---

## v2.9.1 (2026-06-22)

### Phase 38：全量代码审查修复与 UI 打磨

本版本基于一次全量代码审查报告，修复 7 项 Critical、28+ 项 Important 问题，并隐藏桌面端所有页面滚动条。无新功能，聚焦稳定性与安全性。

#### Critical 修复（7 项，1 项经核验为误报）
1. **企业微信适配器 sendResponse 空桩**：改为真正调用 `sendToUser(targetId, text)`，根据返回值决定 success
2. **调度存储读取异常覆盖磁盘**：`load()` 区分 ENOENT（安全初始化空数组）与解析错误（不动 cache）；`save()` 在 cache 为 null 时拒绝写入
3. **ToolExecutor 忽略 requiresConfirmation**：在 ToolExecutionContext 增加 `requestConfirmation` 回调，executor 在文件/网络/shell 安全检查后透传确认请求，无回调时安全默认拒绝
4. **SSRF DNS 级防护未接入**（经核验为误报）：`checkSSRF` 实际已在 web-fetch.ts / web-search.ts 工具层调用，executor 层的 `checkNetworkRequest` 是字符串预拦截，二者分层正确
5. **Steering Queue 只入队不出队**：ReActAgentLoop 增加 `setSteeringConsumer`，在每次迭代前后 drain steering 消息并注入上下文
6. **工具级/会话级 Hook 只注册不触发**：ReActAgentLoop 增加 `setHookRunner`，在工具调用前后、session 起止处触发钩子；DurableExecutor 的 post-step retry 加硬上限 1 次
7. **AbortSignal 流返回后未检查**：callLLMStream 返回后立即检查 `signal.aborted`，已取消时直接 yield error + done 并 return

#### Important 修复（28+ 项）
- **安全与工具**：git blame 路径边界校验、search-utils Windows 路径规范化、file-edit 批量编辑基于原文做唯一性校验、MCP client 版本号从 package.json 动态读取、command-parser 引号平衡检查
- **Agent 循环**：declarative-context 默认改为关闭（实验性功能）、对话历史窗口化（保留最近 40 条）、post-step retry 硬上限
- **路由**：degrade() 即使最低 tier 不可用也返回模型并告警（不抛错）、toModelConfig() 透传 provider 字段、isReady() 拒绝 placeholder API Key、autoApprovePatterns 默认值与 schema 对齐、parseLLMResponse 校验 tier 枚举、validateConfigFile 先替换环境变量再校验
- **渠道**：rate-limit 清理定时器在 stop() 中 clearInterval、Bearer Token 在生产环境强制校验、适配器按 id 存储（支持同类型多实例）、Telegram 长轮询改递归 setTimeout 避免重叠、fetch 加超时、调度引擎 DST 两遍计算、移除未实现的 discord 类型
- **Harness**：trajectory 导出前 flush 缓冲、checkpoint 回滚前置检查覆盖 7 种 git status 字段、检查点元数据按项目隔离、experiment 采纳前检查主工作区脏状态并自动维护 .gitignore

#### UI 打磨
- 隐藏桌面端所有页面滚动条（Webkit `display: none` + Firefox `scrollbar-width: none`），保留滚动能力不影响布局

#### 测试修复（3 项）
- `safety-hardening.test.ts`：版本号期望改为动态读取 package.json
- `wechat-work.test.ts`：sendResponse 测试 mock sendToUser 避免调用真实 API
- `experiment-worktree.test.ts`：beforeEach 预置 .gitignore 排除 .routedev/

#### 验证
- typecheck + typecheck:desktop + test（170 文件 / 2117 用例通过）+ build 全部通过

---

## v2.9.0 (2026-06-20)

### Phase 37：智能交互自动化与开发者工作流增强

本版本聚焦"让 Agent 的交互更智能、工作流更自主"——五个子任务覆盖需求澄清追问、自动化调度与后台行为控制、Git 分支实验与选择性回滚、插件生态兼容研究、集成测试与文档同步。合并了原 Phase 37（需求澄清追问与自动化调度）+ 原 Phase 38（Git 分支实验与回滚增强），并新增插件生态兼容研究维度。

#### Task 1：/goal 需求澄清追问系统
- **RequirementsClarifier**：LLM 分析目标模糊度（0~1 分数），超过阈值时生成 1-3 个澄清问题
- **降级路径**：LLM 不可用时走基于规则的模糊度检测（检查"这个/那个/优化/重构"等歧义词，每词 0.2 分）
- **enrichGoal()**：将用户回答融入原始目标，生成 enrichedGoalText
- **/clarify 命令**：手动触发需求澄清
- **配置**：`optimization.clarification`（enabled/threshold/maxQuestions/skipIfConfident），默认 threshold=0.4

#### Task 2：自动化调度与后台行为控制
- **自研 cron 解析器**：5 字段解析（minute hour dom month dow），支持星号/数字/列表/范围/步进，不引入 node-cron 依赖
- **ScheduleEngine**：setInterval 调度 + fire-and-forget 触发（不阻塞主线程）+ 事件回调
- **ScheduleStore**：JSON 文件持久化（原子写入）
- **/schedule 命令**（别名 /cron）：list/add/remove/pause/resume
- **后台行为配置**：`general.backgroundBehavior`（exit/minimize-to-tray/ask × terminate/continue-in-background/prompt），Zod refine 组合校验
- **配置**：`scheduler`（enabled/maxTasks/defaultTimezone）

#### Task 3：Git 分支实验与选择性回滚
- **ExperimentManager**：基于 Git Worktree 的实验分支管理（start/run/diff/adopt/discard/list）
- **隔离机制**：`git worktree add -b <branch> <path> HEAD` 创建隔离工作目录
- **采纳**：`git merge --no-ff` 合并到主分支，冲突时 `git merge --abort` 中止（不自动解决冲突）
- **/experiment 命令**：start/run/diff/adopt/discard/list
- **/rollback 增强**：新增 file/step/preview 子命令
  - `/rollback file <path>`：文件级回滚
  - `/rollback preview`：预览差异
  - 回滚前自动创建快照检查点，防止误操作

#### Task 4：插件生态兼容研究
- **研究报告**：`docs/PLUGIN_ECOSYSTEM_RESEARCH.md` 覆盖四个维度（MCP 桥梁/约定文件/插件市场/运行时差异）
- **核心结论**：MCP 是工具层事实标准，RouteDev 已具备接入第三方 MCP 生态的能力，无需额外适配层
- **兼容性评估表**：列出 RouteDev 与 Codex/Claude Code 在工具层、约定层、运行时层的兼容项和不兼容项
- **推荐路径**：短期复用现有 MCP 客户端；中期升级 SDK 支持 Streamable HTTP；长期实现 resources/prompts 能力

#### Task 5：集成测试与文档同步
- **6 个测试文件，43 个测试用例**（远超 ≥31 个要求）：
  - `tests/phase37/requirements-clarifier.test.ts`（12 个）：模糊度分析、追问生成、目标富化、阈值边界、降级路径
  - `tests/phase37/schedule-engine.test.ts`（15 个）：cron 解析、任务调度、持久化、时区、通知
  - `tests/phase37/background-behavior.test.ts`（7 个）：配置解析、行为映射、托盘创建、组合校验
  - `tests/phase37/experiment-worktree.test.ts`（6 个）：Worktree 创建/运行/对比/采纳/丢弃
  - `tests/phase37/selective-rollback.test.ts`（3 个）：文件级/步骤级/预览回滚
  - `tests/phase37/plugin-ecosystem.test.ts`（4 个）：MCP 工具描述兼容、服务器配置兼容、命名空间兼容、参数校验兼容
- **AGENTS.md**：新增陷阱 #55-#59（RequirementsClarifier 阈值、ScheduleEngine 不阻塞主线程、系统托盘跨平台差异、Git Worktree 检查点隔离、merge conflict 中止原则）
- **CODEMAP.md**：新增 requirements-clarifier.ts、src/scheduler/、experiment-manager.ts、clarify/schedule/experiment 命令、tests/phase37/、docs/ 索引
- **package.json**：版本号升级到 v2.9.0

---

## v2.8.0 (2026-06-20)

### Phase 36：上下文智能增强与工程方法论集成

本版本聚焦"让 Agent 的记忆与上下文处理从规则驱动升级为智能驱动"——五个子任务覆盖 MCP 代码智能集成、任务感知上下文裁剪、极简编码方法论、知识图谱归纳层、集成测试与文档同步。同时融入了 Karpathy 4 原则（编码前思考/简单优先/手术式修改/目标驱动执行）作为 minimalist-coding Skill 的执行准则。

#### Task 1：codebase-memory-mcp 集成
- **配置层**：`config.example.yaml` 新增 `mcp.servers` 配置段，预配置 codebase-memory 服务器（默认 `enabled: false`，安装后启用）
- **安装脚本**：`scripts/setup-codebase-memory.sh` 自动检测系统架构（linux/macos/windows × x64/arm64）下载二进制
- **Skill 引导**：`.routedev/skills/codebase-intelligence/SKILL.md` 引导 Agent 在代码分析场景使用 codebase-memory-mcp 的 14 个工具（codegraph_search/callers/callees/impact/explore）

#### Task 2：任务感知上下文裁剪（SWE-Pruner 启发）
- **三分类**：`classifyInfoValue()` 对消息做信息价值分类（该扔/该缓存/该存），纯工具原始输出（content 全部为 tool_result）归入"该扔"直接丢弃
- **关注点声明**：`declareFocus()` 从 `task.description` 提取 3-5 个关注点关键词（纯文本处理，零额外 token 成本）
- **M/N 相关性评分**：`filterByKeyword()` 使用 focusKeywords 计算相关性分数（score = matchedCount/keywords.length，阈值 0.2），至少保留最近 2 条消息避免过滤过激进

#### Task 3：极简编码优先级 Skill + /tech-debt 命令
- **minimalist-coding Skill**：融合 Ponytail 6 层方案选择决策树（丢弃→标准库→原生能力→已有依赖→单行→最小实现）+ Karpathy 4 条执行准则
- **/tech-debt 命令**：add/list/resolve 三个子命令，数据持久化到 `.routedev/tech-debt.json`，别名 `/td`
- **红线规则**：信任边界验证、数据丢失处理、安全性检查、可访问性永远不在砍价清单上

#### Task 4：KnowledgeGraph 模式聚类与置信度
- **clusterSimilarNodes()**：Jaccard 相似度聚类合并（同 type 节点，相似度 > 阈值则合并，保留 validatedCount 最高的，创建 supersedes 边）
- **computeConfidence()**：置信度评分 = validatedCount × timeDecay × corroborationBonus（λ=0.01，半衰期约 70 天；corroborationBonus = 1 + 0.1 × distinctSources）
- **validUntil / supersededBy**：过时知识显式标记，recall() 默认排除已 superseded 的节点，`includeSuperseded` 选项允许"时间旅行"查询
- **Dream → KnowledgeGraph 归纳三步**：`ingestToGraph()` 函数实现合并同类（Jaccard > 0.6）→ 冲突检测（标识符完全不同→superseded）→ 时效淘汰（30 天未更新→archived）

#### Task 5：集成测试与文档同步
- **4 个测试文件，45 个测试用例**（远超 ≥16 个要求）：
  - `tests/phase36/focus-aware-pruning.test.ts`（8 个）：三分类、关键词提取、相关性计算、边界条件
  - `tests/phase36/mcp-codebase-integration.test.ts`（7 个）：MCP 配置 schema、config 完整性、脚本存在性、Skill 路由
  - `tests/phase36/minimalist-skill.test.ts`（12 个）：Skill 路由、Skill 内容完整性、tech-debt CRUD、别名、边界条件
  - `tests/phase36/knowledge-clustering.test.ts`（18 个）：聚类正确性、置信度计算、recall 排序、supersedeNode、archiveStaleNodes、Dream 注入
- **AGENTS.md**：新增陷阱 #49-#54（codebase-memory 命名空间、declareFocus 不调用 LLM、confidenceScore 是计算字段、DreamConsolidator 与 KG 可选桥接、熔断模式、description 写法）
- **CODEMAP.md**：新增 tech-debt.ts、dream-to-graph.ts、tests/phase36/、.routedev/skills/ 索引

### Phase 31/32 死代码接线 + 安全加固 + outputStyle 全端适配

本版本基于代码审查报告（AUDIT-REPORT-2026-06-20）进行系统性修复，涵盖 P0 死代码接线、Important 安全修复（9 项）、Minor 健壮性修复（5 项），以及 P1 outputStyle 全端适配。

### P0：Phase 31/32 四个死代码模块接线 + TokenTracker 任务级 API

#### 四个死代码模块完整接线
- **RequirementsGatherer**（需求确认）：在 `App.tsx` `dispatchOrchestratorAction` 中接线 `gather()` 异步生成器，支持多轮交互（澄清问题 → 需求摘要 → 用户确认）
- **TaskComplexityAnalyzer**（复杂度分析）：在 development 流水线中调用 `analyze()`，规则层 + LLM 层混合评估每步复杂度
- **ExecutionOrchestrator**（执行编排）：在 development 流水线中调用 `execute()`，根据复杂度自动选择单 Agent 串行或多 Agent 并行路径
- **UnifiedReviewer**（统一审查）：在 development 流水线中调用 `review()`，两层审查（GoalVerifier + 代码审查）
- **占位 deps 修复**：`ExecutionOrchestrator` 和 `UnifiedReviewer` 的 `systemPrompt` 改为 `systemPromptRef` ref 模式，与 `App.tsx` 共享，支持运行时热更新
- **完整 development 流水线**：`dispatchOrchestratorAction` 的 development 分支从回退 ChatRunner 改为驱动完整流水线（需求确认 → 计划生成 → 复杂度分析 → 执行编排 → 统一审查）

#### TokenTracker 任务级 API 接线
- `goal-runner.ts` 接入 `startTask`/`recordTaskUsage`/`endTask` 三阶段任务级预算追踪
- 任务预算取 `config.router.budget.perRequestLimit`（默认 100000 tokens）
- 预算耗尽时中止 goal 执行，预算接近上限时发出警告
- **设计修正**：`record()` 同时负责日预算和 `taskSpent` 累加，`recordTaskUsage()` 只查询状态（避免双计数）

### P1：Phase 34 outputStyle 全端适配 + CHANGELOG 补全

#### Desktop 端 outputStyle 适配
- `ChatPage.tsx` 将 `outputStyle` 传递给 `ToolCallCard` 组件

#### CLI 组件 outputStyle 适配
- `StatusBar.tsx`：minimal 隐藏 Token/自主/模式字段，verbose 显示编排摘要
- `StepCard.tsx`：minimal 缩短描述（40 字符）+ 隐藏依赖关系，verbose 不截断
- `StepEditor.tsx`：透传 `outputStyle` 给 `StepCard`
- `App.tsx`：StatusBar 和 StepEditor 调用处传入 `outputStyle`

#### CHANGELOG 补全
- 补充缺失的 v2.6.0 条目（Phase 34：Output Style 系统/微摘要系统/动作动词体系/Repo Map/过程评测指标）

### Important：9 项安全修复

1. **权限 deny 规则大小写统一**：`deny-find-delete` 和 `deny-dd-device` 改用 `.toLowerCase()`，防止 `FIND`/`DD` 大小写绕过
2. **Bash 安全检查 Layer 7 复杂度跳过修复**：复杂度超限时仍执行 Layer 1-4（低成本正则），仅跳过 Layer 5-6 注入分析，防止空格填充绕过危险命令检测
3. **权限中间件异常 fail-closed**：`middleware.execute('onActing')` 抛异常时拒绝工具执行（原为 fail-open）
4. **Electron fs:read 符号链接绕过修复**：路径校验改用 `resolveSecurePath`（realpathSync 解析后再校验）
5. **Electron sandbox 启用**：`sandbox: true`，缩小 preload 被 XSS 利用时的攻击面
6. **saveConfig Zod 校验**：配置保存前调用 `AppConfigSchema.parse()`，防止 XSS 场景下写入恶意配置
7. **Slack webhook 签名验证修复**：通用 webhook 路径识别 Slack header（`X-Slack-Signature`/`X-Slack-Request-Timestamp`）
8. **Telegram allowedUserIds 强制要求**：生产环境未配置时拒绝所有消息（开发环境允许）
9. **Checkpoint rollback git status fail-closed**：`git.status()` 异常时中止回滚（原为继续执行 `git reset --hard`）

### Minor：5 项健壮性修复

1. **openai.ts JSON.parse 保护**：`fn?.arguments` 解析添加 try-catch，非法 JSON 时降级为空对象
2. **server.ts 错误响应脱敏**：`{ error: String(error) }` 改为通用错误消息，不泄露内部细节
3. **wechat-work.ts 解密失败返回空字符串**：避免后续 XML 解析异常（原为返回密文）
4. **plugins/registry.ts 沙箱文档**：添加注释强调仅安装可信插件
5. **CSP connect-src 收紧**：生产环境移除 `localhost:5173`（仅开发环境注入）

### 测试与验证
- 全量 typecheck 通过（`tsc --noEmit`）
- 全量测试通过：1953 passed, 1 skipped（158 个测试文件）
- 修复 6 个因本次修改导致的测试失败，更新 2 个预先存在的测试失败

## v2.7.0 (2026-06-20)

### 上下文选择性传递与执行基础设施激活
Phase 35 聚焦"让已写好的基础设施真正跑起来"——三个关键断层修复：多 Agent Worker 收到未过滤的完整对话历史（token 浪费）；HookRunner 系统写好了但从未通电（8 个事件类型零注册）；DurableExecutor 的 StepExecutor 是假桩（永远返回 success）。本 Phase 不写新功能，而是激活已有基础设施。

### Task 1：Worker 上下文选择性传递
- `WorkerExecutor` 新增 `filterContext()` 方法，在 `execute()` 内部对 `conversationHistory` 做角色感知过滤
- 三种过滤策略：tail（保留最近 N 条，默认）、keyword（关键词相关性）、budget（token 预算裁剪）
- 配置开关 `optimization.workerContext`（enabled/strategy/maxMessages/maxTokens/fallbackToFull）
- 关闭过滤时回退到完整历史透传（向后兼容）
- Blackboard 的 completedSteps 通过 systemPrompt 注入，过滤不影响协作上下文可见性

### Task 2：HookRunner 生产激活与文件变更验证
- `app-init.ts` 创建 `HookRunner` 实例并传入 `DurableExecutor`，激活 `runStepWithHooks()`
- 新增 `src/hooks/built-in.ts`，注册 3 个内置钩子：
  - `post-tool-call` 文件验证（file_write/file_edit 后做轻量验证：可读性 + 大小 + JSON 语法）
  - `on-session-start` 会话启动审计日志（action: session_start）
  - `on-session-end` 会话结束审计日志（action: session_end）
- AuditAction 类型扩展 `session_start` / `session_end`
- 验证失败返回 continue + 警告消息（不 abort，仅提醒 Agent）

### Task 3：DurableExecutor 真实接线与会话恢复
- 新增 `src/agent/step-executor.ts`，`AgentLoopStepExecutor` 替换假桩
- 真实调用 `agentLoop.run()` 执行步骤（classify → route → agentLoop.run → StepResult）
- 每个 step 从空 conversationHistory 开始（step 间隔离）
- 应用启动时调用 `listRecoverable()` 检查可恢复执行并打印提示
- 测试场景下 classifier/modelRouter 未传入时回退到桩模式（向后兼容）

### Task 4：执行轨迹导出与聚合分析
- 新增 `src/observability/trajectory-exporter.ts`，`TrajectoryExporter` 组装单会话完整轨迹（审计 + trace + token + goal 摘要）
- 新增 `src/observability/trajectory-aggregator.ts`，`TrajectoryAggregator` 计算跨会话聚合指标（成功率/平均 token/工具使用 Top 5/模型 token 分布）
- `/trace` 命令扩展 `export` 和 `summary` 两个子命令
- 导出格式为 JSON，可被外部工具解析

### Task 5：集成测试与文档同步
- 新增 41 个单元测试（4 个测试文件），覆盖全部 5 个 Task
- AGENTS.md 新增陷阱 #45-48（HookRunner trace 传递/StepExecutor 不再是假桩/Worker 过滤位置/TrajectoryExporter 数据源）
- CODEMAP.md 新增 `src/hooks/`、`src/observability/`、`src/agent/step-executor.ts` 索引
- package.json 版本号升级到 v2.7.0

## v2.6.0 (2026-06-20)

### 交互展示重塑与代码检索增强
Phase 34 聚焦"把信息密度控制权交给用户"——用 `outputStyle` 枚举（minimal/standard/verbose）替换数字 `disclosureLevel`，同时补上 Repo Map 代码检索和 Trajectory 过程评测两个架构短板。研究依据来自《Agent 工具交互展示方案研究报告》和《实用型 Coding Agent 功能体系解构与自研项目构建指南》两份深度研究报告。

### Task 1：Output Style 系统
- `OutputStyleSchema` 枚举（minimal/standard/verbose）替换 `disclosureLevel` 数字
- `UIConfigSchema` 用 `z.preprocess` 实现向后兼容：旧配置 `disclosureLevel: 1/2/3` 自动映射为 `outputStyle: minimal/standard/verbose`
- 新增 `src/cli/output-style.ts`：`outputStyleToDisclosureLevel` / `shouldShowThinking` / `shouldShowToolDetails` / `shouldShowProgress` / `shouldShowAnimation` / `shouldAutoCollapseOnComplete` 等工具函数
- 新增 `/output-style` 命令：支持 `minimal`/`standard`/`verbose` 直接切换 + `next`/`cycle` 循环 + 兼容旧版数字 1/2/3
- `DisclosureLevel` 组件新增 `outputStyle` prop，自动映射默认披露层级
- 新增 15 个测试

### Task 2：完成后折叠与微摘要系统
- 非对称折叠策略：成功 → 折叠过程 + 展示微摘要；失败 → 自动展开过程 + 高亮错误
- 新增 `src/agent/micro-summary.ts`：`extractDecisions`（`<decision>` 标签提取）+ `extractDecisionFallback`（关键词降级提取：决定/选择/采用/改为/优化/重构）+ `estimateFileChanges`（从 tool_call span 估算 +n/-n 行变更）+ `generateMicroSummary`（四要素摘要：状态/统计/关键决策/文件变更）
- 新增 `src/cli/components/MicroSummaryCard.tsx`：非对称折叠卡片，按 `d` 键切换展开/折叠
- 关键决策提取采用方案 A+C 混合：模型遵守 `<decision>` 标签时精确提取，未遵守时降级为关键词匹配
- 新增 13 个测试

### Task 3：动作动词体系与工具执行反馈
- 新增 `src/cli/tool-verb.ts`：14 种内置工具三态动词模板（file_read/write/edit, shell_exec, git_op, code_search 等），running/completed/failed 三态
- 过去时动词（`已读取`/`已修改`/`测试通过`）替代进行时，降低用户焦虑
- `buildResultSuffix` 按 outputStyle 控制结果摘要密度
- 新增 `src/cli/components/Spinner.tsx`：字符旋转动画（⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏，200ms 间隔）+ 30s 阈值后显示计时器
- `chat-runner.ts` 集成：`tool_call_start` 显示进行时 + Spinner，`tool_call_result` 替换为过去时动词 + 结果摘要
- 新增 11 个测试

### Task 4：Repo Map 代码检索增强
- 选择方案 C（轻量正则）零依赖实现：正则提取 export function/class/interface/type/enum/const/let/var/default 和命名导出
- 新增 `src/tools/repo-map.ts`：`extractSignatures` / `buildRepoMap`（扫描目录树，过滤忽略路径，限制 maxFiles=200/maxSignaturesPerFile=20） / `renderRepoMap`（控制总行数）
- 新增 `src/tools/builtin/repo-map.ts`：注册为 `repo_map` 内置工具，路径边界校验防止扫描项目外目录
- 跨平台路径统一：`relativePath` 用 `.replace(/\\/g, '/')` 统一为正斜杠
- 新增 20 个测试

### Task 5：过程评测指标（Harness-level Evaluation）
- 新增 `TrajectorySummary` 接口（13 个字段：taskId/totalTokens/totalCost/toolCallCount/llmCallCount/retryCount/durationMs/success/terminationReason 等）
- `TraceCollector.summarizeTrajectory` 从 span 列表计算汇总指标，优先使用 `session.totalUsage` 覆盖 span 累加值
- `AuditLogger.logTrajectorySummary` 持久化到 JSONL，成功记录为 `success`，失败记录为 `failure`
- `chat-runner.ts` 的 `finally` 块无条件触发汇总，覆盖成功/失败/取消三种终止场景（避免幸存者偏差）
- 新增 9 个测试

### Task 6：预存 typecheck 修复
- 修复 Phase 33 遗留的 5 个 typecheck 错误（workerContext/agentLoop/disclosureLevel/chat-runner 变量作用域）

### 测试统计
- Task 1 Output Style 系统：15 个测试
- Task 2 微摘要系统：13 个测试
- Task 3 动作动词体系：11 个测试
- Task 4 Repo Map：20 个测试
- Task 5 过程评测：9 个测试
- **Phase 34 新增合计：68 个测试**（≥20 要求，超额完成 340%）

### 关键设计决策
1. **Output Style 向后兼容**：不直接删除 `disclosureLevel`，而是在 `UIConfigSchema` 外层用 `z.preprocess` 检测旧字段并自动映射，旧配置文件无需修改即可平滑迁移
2. **微摘要关键决策提取采用"可选提取"策略**：不在系统提示词中强制要求 `<decision>` 标签（避免影响所有模型输出行为），模型遵守标签时精确提取，未遵守时降级为关键词匹配
3. **Repo Map 选择方案 C（轻量正则）**：零依赖、多语言友好，精度低于 tree-sitter 但足够作为代码检索的前置地图
4. **非对称折叠策略**：成功时折叠（minimal/standard 模式），失败时强制展开，符合"成功时用户只需结果，失败时用户需要诊断信息"的直觉
5. **Trajectory 汇总触发点**：在 `chat-runner.ts` 的 `finally` 块中无条件触发，`terminationReason` 区分 completed/error/cancelled，避免幸存者偏差

### 已知预留项
1. Repo Map 预构建缓存未实现，大仓库（500+ 文件）首次扫描可能耗时 >1s
2. Desktop 端（Electron）的 outputStyle 联动未实现，当前仅 CLI 端完成
3. Spinner 组件已创建但未在 chat-runner 中实际渲染
4. 微摘要卡片的"查看 Diff"按钮未实现

## v2.5.0 (2026-06-20)

### 设置补全与默认值校准
Phase 33 聚焦 SettingsPage 的功能补全——审计发现 12 个标签页覆盖约 73% 配置项，但存在 4 个功能性残缺（MCP 表单缺字段、渠道表单缺凭据、模型编辑缺降级 ID、Checkpoint 触发器不可编辑）和 4 个完整模块零入口（goalVerifier / adversarial / updates / prompts）。本 Phase 补全所有缺失入口，并提取纯函数辅助模块支持单元测试。

### Task 1：MCP 服务器表单补全
- stdio 传输方式新增 `args`（逗号分隔）/`env`（key=value 文本框）/`cwd` 三个字段
- http 传输方式新增 `headers`（key=value 文本框）字段
- 两种传输方式通用新增 `connectTimeout` 字段（可选，留空使用默认值）
- 已有 MCP 服务器支持编辑（点击编辑按钮回填表单，复用添加表单字段结构）
- MCP 表单 state 从 `showAddMcp`+`newMcp` 简化为 `mcpForm: McpFormState | null` + `mcpEditingId: string | null`

### Task 2：渠道选项表单补全
- 根据渠道类型动态渲染凭据字段：telegram(3)、wechat-work(5)、slack(3)
- 敏感字段（corpSecret/botToken/signingSecret 等）使用 password 类型 Input + 显示/隐藏切换
- 支持 `${ENV_VAR}` 环境变量引用，配置保存时保持占位符不展开
- Discord 从 Select 下拉列表移除（适配器未实现），显示灰色提示"Discord 适配器开发中，暂不可选"
- 已有渠道支持展开编辑凭据 options

### Task 3：缺失模块与字段补全
- **goalVerifier**（4 字段）插入"记忆 & 检查点"标签页：enabled/modelId/maxTokensPerVerification/autoVerify
- **adversarial**（3 字段）插入"安全设置"标签页：enabled/threshold(slider)/modelTier(select)
- **updates**（2 字段）插入"外观"标签页通用 Card：checkOnStartup/autoUpdate 两个 Switch
- **prompts**（3 字段）插入"可观测性"标签页：projectOverrides/cacheTtlSeconds/userTemplatesDir
- 模型编辑模态新增 `fallbackModelId` 字段（模型级降级 ID）
- Checkpoint `triggers[]` 支持表格编辑（level + action + 删除/添加）
- 版本号从硬编码 `2.2.0` 修复为 `getAppVersion()` 从 package.json 读取

### Task 4：默认值校准思考
- 研究发现 3 个死配置：`gateTimeout`/`gateRetry`/`reviewStrictness` 在 schema/defaults 中定义但实际代码中未消费
- 决策：保持默认值不变，不在此 Phase 补全消费逻辑（避免范围蔓延），记录为后续优化项
- 其余 4 个问题（goalVerifier.modelId/maxToolOutputChars/triggers 阈值/adversarial.threshold）经评估当前默认值合理

### Task 5：集成测试与文档同步
- 新建 `desktop/renderer/src/pages/settings-helpers.ts`：提取 SettingsPage 配置构造逻辑为可测试纯函数
  - `parseStringList`/`parseKeyValuePairs`/`keyValueToText` — 通用解析
  - `constructMcpServer`/`mcpServerToForm` — MCP 配置构造与回填
  - `getChannelOptionFields`/`isChannelTypeSupported`/`constructChannelOptions`/`constructChannelEntry` — 渠道配置
  - `getAppVersion` — 版本号读取
- 新建 `tests/phase33/settings-helpers.test.ts`：17 个测试覆盖所有纯函数（≥15 要求）
- AGENTS.md 新增 Phase 33 陷阱 #41-44
- CODEMAP.md 新增 desktop/ 模块详解 + tests/phase33/ 条目
- package.json 版本号 v2.4.0 → v2.5.0

### 测试统计
- Task 5 纯函数测试：17 个测试（1 个文件）
- **Phase 33 新增合计：17 个测试**

### 关键设计决策
1. **纯函数提取测试策略**：项目 vitest 配置为 `environment: 'node'`，无 React 渲染依赖（`@testing-library/react`/`jsdom`）。将 SettingsPage 的配置构造逻辑提取到独立 `.ts` 模块，绕过 React 组件测试环境限制
2. **MCP 表单添加/编辑共用**：通过 `mcpForm: McpFormState | null` + `mcpEditingId: string | null` 双 state 设计，添加模式 mcpEditingId=null，编辑模式 mcpEditingId=原始 server id，复用同一表单 UI
3. **Discord 处理方案 A**：从 Select 下拉列表移除 Discord 选项（方案 B 保留选项但显示警告会导致用户困惑），底部加灰色提示文字
4. **死配置不补全**：`gateTimeout`/`gateRetry`/`reviewStrictness` 三个配置虽在 schema 中定义但代码未消费，补全消费逻辑属于功能新增而非设置补全，超出本 Phase 范围

## v2.4.0 (2026-06-20)

### 接线验证与收尾
Phase 32 聚焦"写了不接等于没写"——Phase 31 的 8 个模块全部实现并测试，但零个接入生产路径。本 Phase 的唯一目标：让已有的东西真正跑起来。同时回应审查报告的两个 Critical 发现（C1: 8 个模块 100% 死代码；C2: 安全防护层全部未通电）和 Claude 的改进建议。

### Task 1：Phase 31 模块接线（C1/C2 修复）
- **TaskOrchestrator** 接入 `App.tsx` 的 `handleSubmit`：`unifiedPipeline` 为 true 时经 orchestrator 分发，false 时回退到 ChatRunner
- **ToolResultSanitizer** 接入 `loop.ts` 的 6 个工具结果注入点（并行 3 + 串行 3）
- **ReadTracker** 接入 `GuardedToolExecutorAdapter`：先读后写守卫，新建文件例外
- **CompletionGate** 接入 `goal-runner.ts` 验证阶段：GoalVerifier 之后运行 typecheck/lint/tests
- **TokenTracker** 双计数修复：`record()` 不再累加 `taskSpent`，由 `recordTaskUsage()` 单独负责
- **filterSensitiveFields** 接入 `ToolResultSanitizer.sanitize()`：JSON 内容敏感字段脱敏
- **CacheStatsTracker** 接入 `TokenTracker`：缓存命中统计

### Task 2：缓存架构激活
- `RoutingResult.enableCache` 全局启用——所有路由结果默认 `enableCache: true`
- Anthropic 请求的 system prompt 和 tools 定义均带 `cache_control: { type: 'ephemeral' }` 标记
- `CacheAwarePromptBuilder` 和 `CacheStatsTracker` 接入生产路径

### Task 3：Agent 行为 Eval
- 分类器黄金测试集 34 条（`tests/eval/classifier-golden.json`），覆盖命令/关键词/长度/回退全路径
- 降级链 5 级测试：主模型可用 → fallback → 降 tier → 强制最低 → placeholder apiKey
- ConflictDetector 已知盲区记录：不同文件语义冲突不检测、likelyFiles 为空不检测

### Task 4：安全加固
- MCP 工具 `validateArgs()` 新增类型校验（string/number/integer/boolean/array/object/null）
- MCP 工具描述注入检测：`discoverTools()` 中用 `ToolResultSanitizer` 检测 description 中的注入模式，恶意工具跳过注册
- MCP client 版本号从硬编码 `0.8.0` 改为 `ROUTEDEV_VERSION`（`2.4.0`）
- agents.md 陷阱 #22 修正：`DeclarativeContextAcquirer`/`EntityManager` 标注为死代码
- `chat-runner.ts` 传项目上下文给分类器：`detectProjectContext()` 检测项目类型 + git 状态

### Task 5：集成测试与文档同步
- 7 个端到端接线验证测试：缓存启用、Sanitizer 注入检测+脱敏、Token 双计数修复、ReadTracker 守卫
- AGENTS.md 新增 Phase 32 陷阱 #35-40
- 版本号 v2.3.0 → v2.4.0

### 测试统计
- Task 4 安全加固：9 个测试
- Task 3 Agent Eval：44 个测试（含 34 条黄金集）
- Task 5 集成测试：7 个测试
- **Phase 32 新增合计：60 个测试**

### 依赖变更
- `vite` 5.4.21 → 6.4.3（兼容 vitest 4.x）

## v2.3.0 (2026-06-19)

### 统一工作流编排
Phase 31 聚焦"同一件事走同一条路"——把三条互不相通的执行路径（普通聊天 / /goal 命令 / /compose 模式）合并为一条智能流水线，同时激活已写好但从未使用的多 Agent 基础设施。

### Task 1：TaskOrchestrator 核心状态机
- **TaskOrchestrator**（`src/agent/task-orchestrator.ts`）：所有非命令输入的调度中心
- 四种 intent 判定：quick_answer（直达 ChatRunner）/ development（完整流水线）/ explicit_goal（/goal）/ planning（/plan）
- 状态机：idle → understanding → confirming_requirements → planning → executing → reviewing → completed
- **Steering Queue**：用户在 Agent 工作时补充指令排队交付（最大 5 条，溢出丢弃最早并通知）
- 新增 12 个测试

### Task 2：需求确认 RequirementsGatherer
- **RequirementsGatherer**（`src/agent/requirements-gatherer.ts`）：异步生成器，根据 classifier 结果选择策略
- 自动确认（medium + confidence ≥ 0.7）/ 主动追问（complex 或 confidence < 0.7）/ 规划模式（reasoning 跳过）
- LLM 失败降级为 skipped，不卡住
- GoalParser 扩展接受可选 RequirementsSummary 注入 prompt
- 新增 8 个测试

### Task 3：任务分解与复杂度评估
- **TaskComplexityAnalyzer**（`src/agent/complexity-analyzer.ts`）：规则层（快速）+ LLM 层（仅在规则无法判断时调用）混合评估
- needsSubAgent 判定：complex → true；medium + estimatedFiles > 3 → true；parallelizable → true
- 总开关：单步骤或全部 simple 时不使用子 Agent
- 新增 10 个测试

### Task 4：执行编排（单/多 Agent 自适应）
- **ExecutionOrchestrator**（`src/agent/execution-orchestrator.ts`）：根据复杂度选择单/多 Agent 路径
- 单 Agent 路径：串行执行，与现有 goal-runner 行为一致
- 多 Agent 路径：激活 Orchestrator + WorkerExecutor + Blackboard，按并行组执行
- Worker 失败不中断后续步骤（容错）
- Token 追踪正确累加多 Agent 消耗
- 进度播报格式：`[3/5] ✅ 重构认证模块 | ⏱ 12s | ~2,340 tokens`
- 新增 10 个测试

### Task 5：统一审查与验收
- **UnifiedReviewer**（`src/agent/unified-reviewer.ts`）：两层审查
- 第一层：GoalVerifier 验证（复用现有）+ 对抗性验证
- 第二层：代码审查（内置 reviewer Worker 或外部 OCR 工具）
- 三种结果路径：全通过 / 有警告 / 未通过
- 审查模式配置：builtin（默认）/ ocr / none
- 新增 8 个测试

### Task 6：生产安全防护
- **ReadTracker**（`src/tools/read-tracker.ts`）：先读后写强制，新建文件例外
- **ToolResultSanitizer**（`src/tools/result-sanitizer.ts`）：注入检测（不删除内容只加警告）+ 智能截断（优先保留错误区域）
- **CompletionGate**（`src/agent/completion-gate.ts`）：独立代码验证门（typecheck/lint/tests），超时视为 skipped
- **FailureReport**（`src/agent/failure-report.ts`）：结构化失败报告，suggestion 基于规则生成不调用 LLM
- **TokenTracker 扩展**：任务级 Token 熔断（80% 警告、100% 中止），perRequestLimit 接入 checkBudget
- **HookRunner 扩展**：pre-tool-call / post-tool-call / on-session-start / on-session-end 事件
- **系统提示词**：新增 `<execution_discipline>` 区块
- 新增 50+ 个测试

### Task 7：集成测试与文档同步
- 端到端集成测试：Quick Answer 短路、需求确认交互、Steering Queue、Read-before-Write、Prompt Injection 检测、Token 熔断、CompletionGate、FailureReport、扩展钩子、行为评估
- 文档同步：AGENTS.md（12 个新陷阱）、CODEMAP.md（10 个新文件条目）、CHANGELOG.md、config.example.yaml、package.json、README.md
- 新增 11 个集成测试

### 配置项
新增 `optimization.workflow` 和 `optimization.safety` 配置 section：
```yaml
optimization:
  workflow:
    unifiedPipeline: true           # 统一流水线开关
    autoRequirements: true          # 自动需求确认
    reviewOnComplete: true          # 完成后审查
    reviewMode: 'builtin'           # 'builtin' | 'ocr' | 'none'
    reviewModel: 'auto'             # 'auto' 或指定模型
    reviewStrictness: 'medium'      # 'low' | 'medium' | 'high'
  safety:
    readBeforeWrite: true           # 先读后写强制
    maxToolOutputChars: 16000       # 工具输出最大字符数
    completionGate: true            # 完成门开关
    gateTimeout: 180000             # 验证门总超时（毫秒）
    gateRetry: 1                    # 验证失败重试次数
```

## v2.2.0 (2026-06-18)

### 可观测性与提示词工程
Phase 30 聚焦"装水表"——给 Token 流量装分表，让每一笔开销可观测、可归因、可优化。同时把 PromptTemplateManager 正式通电，重写系统提示词为 8 区块结构。

### Task 1：Token 可观测性基础设施
- **TokenProfiler**（`src/agent/token-profiler.ts`）：每次 LLM 调用前记录五组件快照（系统提示词/对话历史/工具定义/工具返回/用户消息）
- **`/token` 命令**：实时查看分组件 token 占比分析
- **ReAct Loop 埋点**：`loop.ts` 在 LLM 调用前 yield `token_profile` 事件
- **goal-runner 修复**：补全 `setTodayTokensUsed` 调用；验证步骤和对抗性验证步骤通过 `onUsage` 回调记录 token
- **TokenTracker.checkBudget() 接入**：chat-runner 循环结束后调用预算检查
- **会话级累计**：`persistSession()` 写入 `.routedev/token-logs/`，不因上下文压缩重置（借鉴 Reasonix Layer 5）
- 新增 19 个测试

### Task 2：结构化实体状态（实验性）
- **EntityManager**（`src/agent/entity-state.ts`）：维护 taskGoal/completedSteps/currentStep/blockers/keyDecisions/modifiedFiles/env
- `toPromptBlock()` 输出 < 200 tokens 的结构化状态块
- `updateFromConversation()` 只取最近 5 条消息，避免 token 膨胀
- 默认关闭（`optimization.structuredState.enabled: false`）
- 新增 19 个测试

### Task 3：声明式上下文获取（实验性）
- **DeclarativeContextAcquirer**（`src/agent/declarative-context.ts`）：两步调用模式（声明需求 → 精准提取）
- 5 秒超时降级：超时后回退到全量上下文，不阻断流程
- complex 路由触发：仅复杂任务启用，简单任务直接走原路径
- 默认关闭（`optimization.declarativeContext.enabled: false`）
- 新增 13 个测试

### Task 4：简洁思考约束（实验性）
- **CONCISE_THINKING_BLOCK**（`src/agent/concise-thinking.ts`）：输出纪律段落注入系统提示词
- `trimToolResult()`：裁剪冗长工具返回，保留关键信息
- `shouldSkipConcise()`：关键词跳过（debug/错误分析等场景不裁剪）
- 默认关闭（`optimization.conciseThinking.enabled: false`）
- 新增 17 个测试

### Task 5：系统提示词重构
- **main.system 模板重写**为 8 区块 XML 标签结构：identity/core_rules/routing_awareness/tool_protocol/progress_narration/completion_protocol/self_correction/anti_yes_engineer
- **PromptTemplateManager 正式接入主路径**：App.tsx 改用 `systemPromptRef` 模式，useEffect 异步渲染模板
- **Fallback 机制**：渲染失败时保留 `getSystemPrompt()` 初始值，不阻断启动
- **变量扩展**：从 7 个扩展到 11 个（新增 routeDecision/entityState/conciseThinking/cwd）
- 新增 11 个测试

### 配置变更
- 新增 `optimization` 顶层 section（`src/config/schema.ts`）
- `config.example.yaml` 同步新增 optimization 配置示例

### 测试覆盖
- 新增 79 个测试（5 个测试文件）
- 全量测试通过

### 文档同步
- AGENTS.md：新增 Phase 30 陷阱（20-22）
- CODEMAP.md：新增 4 个文件条目（token-profiler/entity-state/declarative-context/concise-thinking）
- config.example.yaml：新增 optimization section

## v0.0.1 (2026-06-18)

### 初始发布版本
将版本号重置为 0.0.1，作为项目对外发布的初始版本。本版本包含经过 29 个 Phase 迭代开发的完整功能集。

## v2.1.0 (2026-06-18)

### 安全加固与收尾闭环
Phase 29 是项目的最后一个开发 Phase，回应代码审查报告发现的安全缺口，将安全性从 5/10 提升到 7/10。

### 安全修复（12 项审查问题）
- **S1/S2/S3 命令解析绕过**：引入 `command-parser.ts` tokenize 解析，替代正则/子串匹配
  - `rm -rf "/"`（引号绕过）、`RM -rf /`（大写绕过）均被阻止
  - 新增 `find -delete`、`dd of=/dev/` deny 规则
  - `python program.py` 不再被误拦（子串匹配修复）
- **S5/S6 签名验证降级**：生产模式下 token/signingSecret 未配置时拒绝请求
- **S8 PKCS#7 padding oracle**：严格验证 padding 字节一致性，上界从 32 改为 16
- **S9 环境变量占位符**：`replaceEnvVars` 改为 fail-fast，启动时报错而非运行时 401
- **S11 API Key 占位符**：OpenAI/Anthropic 客户端空 key 时不构造假客户端，`isReady()` 返回 false
- **S12 vision 路径遍历**：`startsWith` 改为 `path.relative`，防止前缀匹配绕过
- **env 注入**：shell-exec 环境变量白名单过滤，阻止 `LD_PRELOAD`/`NODE_OPTIONS` 注入

### 架构修复（4 项）
- **A1 Slack 适配器注册**：ChannelManager 补充 `slack` case 分支
- **A2 末尾 import**：`manager.ts` 末尾 import 移至顶部
- **A4 搜索工具去重**：提取 `walkDir`/`isIgnoredPath`/`matchGlob` 到 `search-utils.ts`

### 运行时健壮性（4 项）
- **B1 isError 字符串匹配**：改为结构化错误标记识别，"修复了3个错误"不再误判
- **B3 isModelAvailable 恒 true**：实现真实检查（provider 配置 + API Key）
- **B4 分类器回退 simple**：改为 `complex`（保守策略，不确定时用强模型）
- **B10 rollback 无前置检查**：添加工作区干净检查，防止丢失未提交更改
- **B13 orchestrator 静默降级**：环检测时输出警告日志

### 边界案例（2 项）
- **B6 wechat parseInt NaN**：CreateTime/agentId 非数字时使用安全默认值

### 测试覆盖
- 新增 97 个测试（16 个测试文件），覆盖所有 Phase 29 修复
- 全量测试通过

### 文档同步
- AGENTS.md：更新陷阱警告（命令解析 tokenize、签名验证生产模式、env fail-fast、rollback 前置检查）
- CODEMAP.md：新增 `command-parser.ts` 和 `search-utils.ts` 条目
- README.md：版本号更新至 v2.1.0

## v2.0.0 (2026-06-18)

### 重大里程碑
经过 28 个 Phase 的迭代开发，RouteDev 正式发布 v2.0.0，达到商业交付标准。

### 核心能力
- **智能路由**：场景分类 → 模型选择 → 成本优化，全链路自动化
- **ReAct Agent Loop**：流式思考-行动循环，支持工具调用和多步任务
- **多 Agent 编排**：Orchestrator 分解任务，Worker 并行执行
- **Compose 管线**：需求→编码→测试→审查全流程自动编排
- **DurableExecutor**：长任务断点恢复，不怕中断
- **7 层安全防护**：权限→目录→命令→文件→网络→进程→审计
- **渐进式上下文**：5 阶段压缩 + 知识图谱 + 梦境整合
- **插件系统**：Theme/Tool/Hook/Router 四类插件，社区可扩展
- **渠道集成**：Telegram / Slack / 企业微信 / Discord

### Phase 28（质量验收与发布准备）
- 10 个 E2E 用户旅程测试
- 性能基线强制门（8 项指标）
- 安全终审（9 项审计，23 个测试）
- 测试覆盖率强化（33 个边界条件测试）
- 完整文档（CHANGELOG / ARCHITECTURE / PLUGIN_GUIDE / SECURITY_AUDIT）
- 蓝图合规度终审 ≥ 95%
- 版本号升级至 v2.0.0

### Phase 27（产品完善与商业交付标准）
- DurableExecutor 运行时集成 + /resume 交互式 UI
- RouterPlugin / ThemePlugin 接入
- 插件状态持久化
- DiffView 动作绑定（apply/reject）
- 通知持久化到审计日志
- Compose + HookRunner TracePanel 可视化
- notes.md 模块（Agent 唯一写通道）

### Phase 26（技术债务清零与架构加固）
- 路径遍历漏洞修复（code-search / file-search）
- 企业微信凭据脱敏
- ServiceContext 类型安全（消除 as any）
- /permissions 命令反映运行时规则
- 异步 I/O 替换同步写入（tracker / durable-executor）
- 自定义错误类体系（RouteDevError + 6 子类）
- 提示词模板五块结构改造

## v1.4.0 (2026-06-18)
Phase 27 完成版本。

## v1.3.0 (2026-06-18)
Phase 26 完成版本。

## v1.2.0 (2026-06-18)
Phase 25（UI 与交互优化）完成版本。

## v1.1.0 (2026-06-18)
Phase 24（功能补全与产品完善）完成版本。包含 CLI 设计系统、Compose 管线、DurableExecutor、HookRunner、/permissions、提示词规范、错误消息、Provider 校验等 8 个模块。

## v1.0.1 (2026-06-18)
Phase 0c（审计修复）完成版本。统一权限引擎、拆分 inferProviderId、收敛 App 组装、同步文档。

## v1.0.0 (2026-06-18)
Phase 20-23 完成版本。WorkModeController 三模式权限矩阵、PermissionEngine 三层权限、四类插件系统、TracePanel、SlackAdapter、SetupWizard 等。

## v0.8.0 - v0.1.0 (2026-06-17 ~ 2026-06-18)
Phase 01-19 迭代版本，涵盖项目骨架、核心类型、Router 层、CLI 对话、Agent Loop、工具框架、MCP 客户端、自主模式、检查点系统、多模态视觉、渠道集成、多 Agent 基础、可观测性、Prompt 模板系统、App 重构等。
