# RouteDev 技术债跟踪表

> **用途：** 集中记录所有已知技术债，避免后续审查重复发现已排期项。
> **审查员指引：** 报告 findings 前请先对照本表 §1，本表 §1 已清空，仅报告新发现的问题。
> **维护规则：** 每轮审查后更新；修复完成的项移至 §3 历史区；新发现的项追加到 §1。
> **最后更新：** 2026-07-29（Phase-95 完成，TD-07 / TD-20 已修复移至 §3）

---

## 1. 活跃技术债清单（0 项）

按优先级排序。ID 格式：`TD-<序号>`（本表内部 ID） + 历史报告 ID（如 G-011 / F-004）。

| # | TD ID | 历史 ID | 优先级 | 类别 | 简述 | 解决 Phase | 触发来源 |
|---|-------|---------|--------|------|------|-----------|----------|
| — | — | — | — | — | _暂无活跃项_ | — | — |

---

## 2. 活跃技术债详情

_暂无_

---

## 3. 已修复技术债历史（按时间倒序）

### 2026-07-29 Phase-95 工程收尾与治理（TD-07 / TD-20）

Phase-95 完成 2 项技术债。92 个 IPC handler 全部用 `createValidatedHandler` / `createValidatedHandlerMulti` 包装；src/ 和 desktop/main/ 的 `console.log/info/debug` 全部替换为结构化 `logger`（保留必要场景并标注 `eslint-disable-next-line`）。

| TD ID | 类别 | 简述 | 修复方式 |
|-------|------|------|----------|
| TD-07 | IPC 治理 | 92 个 IPC handler 统一校验中间件 | Task 1：新建 `docs/IPC_HANDLER_INVENTORY.md` 清单文档（按高风险 18 / 中风险 43 / 低风险 31 分级，记录 channel / 参数 schema / 校验规则 / 迁移状态）。Task 2-3：新建 `createValidatedHandlerMulti`（多参数 handler 包装器）+ `ipcValidate.*` 通用校验器工厂（none / string / optionalString / number / optionalNumber / object / optionalObject / boolean），完成剩余 85 个 handler 迁移。92/92 全部包装，其中 18 个高风险 handler 含自定义业务校验（URL 协议白名单 / 命令白名单 / 工具白名单 / 长度上限防 OOM / 一次性确认令牌） |
| TD-20 | 错误处理 | 136 处 console 未用结构化 logger | Task 4-6：src/ 61 处 + desktop/main/ 34 处 console.log/info/debug 全部替换为 `logger.warn/error/debug`，带结构化字段（channel / args / error / length / role 等）。保留必要场景并标注 `// eslint-disable-next-line no-console`：src/utils/paths.ts 3 处（logger 未初始化的早期 bootstrap）、desktop/main/index.ts 1 处（渲染层 console-message 转发到 stdout）。desktop/renderer/ 15 处 `console.warn/error` 保留（渲染层无法用 winston logger，主进程通过 `webContents.on('console-message')` 转发） |

**架构决策**：
- 不重写 handler 业务逻辑（仅包装校验层）；不引入新日志库（用现有 winston logger）
- eslint no-console 规则未启用：项目当前未配置 eslint，添加 eslint 配置 + 依赖超出"工程收尾"范围，留待后续单独 Phase
- 渲染层 `console.warn/error` 保留：渲染层无法使用 winston logger（写文件需主进程 API），主进程通过 `webContents.on('console-message')` 转发到日志文件
- IPC handler 校验工具分层：`createValidatedHandler` 是外层（参数校验），权限校验是内层，二者解耦
- `ipcValidate.*` 校验器工厂返回 null 表示通过，字符串表示错误消息，与 `createValidatedHandler` 签名一致

**验证**：
- `pnpm typecheck`：TypeScript No errors found
- `pnpm test`：全量测试通过（264 passed / 7 skipped test files，3623 passed / 160 skipped tests，0 failed）
- IPC handler 包装覆盖率：92/92 = 100%
- console.log/info/debug 残留：src/ 0 处（仅 sandbox.ts 注释中举例）/ desktop/main/ 1 处（渲染层日志转发，已标注 eslint-disable）

### 2026-07-29 Phase-94 架构耦合治理（TD-18 / TD-19）

Phase-94 完成 2 项 Medium 优先级架构耦合类技术债。通过抽取共享类型文件消除 ESM 循环依赖，引入 EnabledPacks 功能矩阵收敛 Pack 门控散布，调整 agentLoop 创建职责归属。

| TD ID | 类别 | 简述 | 修复方式 |
|-------|------|------|----------|
| TD-18 | 架构耦合 | app-init-tools 跨层创建 agentLoop | `app-init-tools.ts` 中 ReActAgentLoop 创建 + 12 个 setXxx 注入迁移至 `app-init-agent-loop.ts` 的 `setupAgentLoop`。Phase 94 Task 4 修复：agentLoop 实例由 `createAgentSubsystem` 入口先创建并写入 ctx，避免与 `setupAgentMiddleware` 抢占创建权（原迁移将创建放在 setupAgentLoop 开头导致 setupAgentMiddleware 访问 ctx.agentLoop 时为 undefined）。tools 子系统专注工具装配，agent 子系统拥有 agentLoop 配置控制权 |
| TD-19 | 架构耦合 | ESM 循环依赖 + Pack 门控散布 30 处 | Task 1：新建 `src/runtime/goal-runner-types.ts` 承载 `GoalRunnerCtx` 接口和 `MAX_CONTEXT_ITEMS` 常量，core/confirm/scheduler/recovery 4 个子模块改为从 types 文件 import，消除 core.ts 与子模块的 ESM 循环依赖。Task 2：在 `app-init.ts` 定义 `EnabledPacks` 接口和 `computeEnabledPacks(config)` 函数单点计算 Pack 门控状态，5 个子模块 25 处 `config.packs?.xxx?.enabled` 改为 `ctx.enabledPacks.xxx` |

**架构决策**：
- 不重写 goal-runner 子模块逻辑，仅抽取共享类型
- 不新建 Pack 配置 DSL 或注册机制，EnabledPacks 仅承载 `packs?.xxx?.enabled` 维度
- 不改变 ReActAgentLoop 类签名，仅调整创建归属
- agentLoop 创建放在 `createAgentSubsystem` 入口而非 `setupAgentLoop` 内部，确保 middleware/trust/loop 三个阶段都能访问

**验证**：`pnpm typecheck` 通过；`pnpm test` 全量 3623 passed + 160 skipped + 0 failed（含 16 个 app-init.test.ts 用例全部通过）。

### 2026-07-29 Phase-93 类型安全与运行时校验（TD-14 / TD-15）

Phase-93 完成 2 项 High 优先级类型安全类技术债。为安全敏感路径建立 Zod schema 运行时校验体系 + schema migration 框架，防止反序列化数据被篡改或版本升级后格式不兼容导致数据丢失。

| TD ID | 类别 | 简述 | 修复方式 |
|-------|------|------|----------|
| TD-14 | 韧性/升级 | 无 schema migration 机制 | 新建 `src/utils/migration.ts`：实现 `migrate()` / `readSchemaVersion()` / `withSchemaVersion()` 三个工具函数 + 16 个单元测试。为 3 个有 schema 校验路径的 JSON 持久化文件（integrity-manifest / goal-persistence / checkpoint-manager.GoalPlan）接入 migration：save 时用 `withSchemaVersion` 写入 `__schemaVersion`，load 时先 `migrate` 升级版本再 `parseXxx` 校验。未接入无 schema 校验的文件（避免空头支票） |
| TD-15 | 类型安全 | Zod schema 运行时校验 | 新建 `src/config/schemas/` 目录，包含 5 个 schema 文件：`integrity-manifest.ts` / `goal-persistence.ts` / `checkpoint.ts` / `app-dependencies.ts` / `database.ts`，外加 `desktop/shared/ipc-schemas.ts`。每个文件定义 `XxxSchema` + `parseXxx(raw)` 函数（封装 Zod parse + 错误日志），采用宽松校验 + passthrough 策略。替换安全敏感路径的 `as` 断言：`security/integrity-manifest.ts` / `agent/goal-persistence.ts` / `harness/checkpoint-manager.ts` / `runtime/app-init.ts`（AppDependencies 合并点）/ `code-map/database.ts` / `desktop/renderer/src/store/useRouteDevStore.ts`（7 处 IPC 回调） |

**架构决策**：
- 不全量替换 136 处 `as` 断言（仅覆盖 7 个安全敏感路径）
- 不引入 io-ts / runtypes 等替代库（复用现有 Zod）
- migration 框架采用 fail-open 策略（迁移函数抛异常时返回 fallback，不阻塞主流程）
- schema 校验策略分层：装配点 fail-closed（app-init.ts），持久化文件 fail-open（返回 null/空对象，与原行为一致）

**验证**：`pnpm typecheck` 通过；`pnpm test` 全量通过（exit code 0），含 `tests/utils/migration.test.ts` 16 个用例。

### 2026-07-29 Phase-92 大文件拆分（TD-02 / TD-08 / TD-09 / TD-10 / TD-11）

Phase-92 完成 5 个超限文件拆分，处理 5 项 Medium 优先级文件拆分类技术债。主文件行数均降至 300 行以下（仅 spawn-agent-delegation.ts 因 wrapSpawnAgentWithDelegation 单函数 7+ 阶段共享局部状态，进一步拆分需改逻辑而非移代码，保留 405 行）。

| TD ID | 类别 | 简述 | 修复方式 |
|-------|------|------|----------|
| TD-02 | 文件拆分 | goal-runner.ts 44 imports 未拆分 | Phase 79 Task 2 已完成拆分（core/confirm/scheduler/recovery 4 子模块），本 Phase 核实确认：主文件仅 13 行 re-export，零代码逻辑。直接归档 |
| TD-08 | 文件拆分 | createAgentSubsystem 1207 行拆分 | 拆为 4 文件：`app-init-agent.ts` 42 行（dispatcher）+ `app-init-agent-trust.ts` 76 行（TrustGradient + PermissionMiddleware）+ `app-init-agent-middleware.ts` 254 行（PluginSystem + LoopDetection + MentionResolver + ExplorationBudget + SkillMention + CodeMapContext + QualitySignal + ExpertisePrompt + HookRunner）+ `app-init-agent-loop.ts` 931 行（SubAgent + SkillLifecycle + Goal + CompletionGate + TaskOrchestrator + UnifiedReviewer + CodeMap + Phase48 + DualLoop）。装配顺序：middleware → trust → loop，通过函数返回值传递 pluginSystem / hookRunner，无模块级全局 |
| TD-09 | 文件拆分 | walkAndExtract 1003 行拆分 | 拆为 6 文件：`extractor.ts` 137 行（dispatcher + extractFromTree 公共 API）+ `extractor-utils.ts` 69 行（makeNodeId/makeEdgeId/extractSignature/findEnclosingSymbol + PendingReference/ExtractionResult 类型）+ `extractor-ts.ts` 431 行（TS/TSX/JS + 7 个 TS 专用辅助函数）+ `extractor-py.ts` 169 行 + `extractor-java.ts` 250 行 + `extractor-go.ts` 183 行。walkAndExtract 作为回调参数传递给各语言 extractor 避免循环依赖；PendingReference/ExtractionResult 通过 re-export 保持外部 import 路径不变 |
| TD-10 | 文件拆分 | wrapSpawnAgentWithDelegation 1047 行拆分 | 拆为 4 文件：`spawn-agent.ts` 275 行（SpawnAgentTool 类 + re-exports）+ `spawn-agent-types.ts` 264 行（SubagentType + SUBAGENT_TOOL_WHITELIST + TOOL_NAME_ALIASES + 安全常量 + DelegationContext/DetachedSessionOptions/SpawnResult/SpawnAgentParams/SpawnAgentFunction/DelegationIntegrationDeps）+ `spawn-agent-utils.ts` 259 行（normalizeToolName + resolveProfileForSubagent + createChildRegistry + createConcurrencyLimitedSpawnFn + createDetachedSessionContext + extractDetachedSessionAnswer + buildForkedMessages）+ `spawn-agent-delegation.ts` 405 行（wrapSpawnAgentWithDelegation 单函数，7+ 顺序阶段共享局部状态，无法仅移代码进一步拆分）。18 个公共导出通过 re-export 保持调用方 import 路径不变；附带调整 tests/integration/phase48.test.ts 静态分析路径 + scripts/lint-descriptions.ts 排除列表 |
| TD-11 | 文件拆分 | SettingsPage 477 行拆分 | 拆为 3 文件：`SettingsPage.tsx` 184 行（主页面 + hooks + handleExport/handleImport + 配置数组）+ `SettingsTabNav.tsx` 381 行（7 个 Tab 内容渲染块）+ `SettingsDialogs.tsx` 24 行（AlertBanner）。SettingsTabNav 用 `ReturnType<typeof useSettingsDraft>` 等 TS 类型别名简化 props 接口（70+ 字段），不是新设计模式；JSX 与原代码字节级一致 |

**验证**：`pnpm typecheck` 通过；`pnpm test` 全量 3633 passed + 160 skipped + 0 failed（含 tests/runtime / tests/code-map / tests/tools / desktop/renderer 各模块测试全部通过）。

### 2026-07-29 Phase-91 测试基建补全（TD-01 / TD-16）

Phase-91 完成测试基建补全，处理 2 项 Critical/High 测试覆盖类技术债，新增 38 个单元/集成测试。

| TD ID | 类别 | 简述 | 修复方式 |
|-------|------|------|----------|
| TD-16 | 测试覆盖（Critical） | goal-runner 子模块零测试 | 新增 4 个单元测试文件共 38 个用例：`tests/runtime/goal-runner-core.test.ts`（7 tests，工厂装配 / gid 生成 / emit 安全 / 跨模块引用）、`tests/runtime/goal-runner-confirm.test.ts`（11 tests，savePlanRevision 路径校验 / handleGoalCommand 参数解析 / clarifyGoalIfNeeded）、`tests/runtime/goal-runner-scheduler.test.ts`（9 tests，attestation 校验 / status 流转 / 用户中断 / DAG 降级）、`tests/runtime/goal-runner-recovery.test.ts`（11 tests，resumeGoalPlan 步骤过滤 / verifyPlan 异常 / runCompletionGate 门控） |
| TD-01 | 测试基建（High） | ChatBridge 入口级集成测试 | 扩展 `desktop/main/__tests__/chat-bridge.integration.test.ts`，新增 Phase91 Task5 一节 6 个 requestId 隔离回归用例：精准中断隔离（stopGeneration(req-A) 不影响 req-B）、Map 覆盖语义（同 requestId set 不主动 abort 旧 controller）、批量清理生命周期（clearAllAbortControllers 逐个 abort）、完整生命周期（set → get → abort → clear）、并发 3 请求互不重叠。覆盖 G-004 requestId 隔离机制的所有边缘场景 |

**验证**：`pnpm typecheck` 通过；`pnpm test` 3607 passed + 1 flaky（`tests/harness/audit-logger.test.ts > logChannelMessage in/out` 时序问题，单独运行通过，与 Phase-91 改动无关）。

### 2026-07-29 IPC 校验推进 + 测试类型安全 + console 统一（TD-07/20/21）

本轮聚焦"还能解决的技术债"，处理 3 项：1 项完整修复（TD-21），2 项部分推进（TD-07 / TD-20）。

| TD ID | 类别 | 简述 | 处理方式 |
|-------|------|------|----------|
| TD-21 | 类型安全/测试 | chat-bridge.integration.test.ts 双重断言 | `as unknown as AppDependencies` 改为单层 `as AppDependencies`；setupBridge 新增 `completionGateVerify` 选项，消除 4 处 `(ctx.deps as any).completionGate = ...` 后注入；47 个测试全部通过 |
| TD-07 | IPC 治理 | 高风险 handler 缺校验 | 新增 4 个 createValidatedHandler 包装：shell:open-external（URL 协议白名单 http/https/mailto，拒绝 file/javascript/data 等危险协议）、shell:open-path（长度上限 4096）、shell:show-item-in-folder（长度上限 4096）、clipboard:write-text（1MB 上限防 OOM）。原有 3 个 + 新增 4 个 = 7/92 handler 已包装 |
| TD-20 | 错误处理 | desktop/main/index.ts console 统一 | 替换 11/34 处 console：chat:sync-history 6 处 console.error → logger.warn（带结构化字段 length/role/msg）；agent:followUp / clearAllQueues / setFollowUpMode 5 处 console.warn → logger.warn。剩余 23 处含启动日志（4 处合理保留）、渲染层转发（3 处必须用 console）、IPC handler 错误（16 处待后续） |

**文档表格修正**：TD-25/26/27 早在 2026-07-20 已修复，但此前误留在 §1 活跃清单（详情块同时出现在 §2 和 §3）。本轮将其从 §1 表格和 §2 详情区移除，仅保留 §3 历史记录。

### 2026-07-29 死配置清理与工具函数抽取（TD-06/12/13/22/23/24）

经源码核实与方案评估，6 项技术债已处理（4 项修复 / 2 项标注现状）。

| TD ID | 类别 | 简述 | 处理方式 |
|-------|------|------|----------|
| TD-06 | 信任系统 | TrustGradient checkOperation 接线 | checkOperation 已在 permission-engine.ts:327 调用；动态升级旁路是 Phase 79 有意设计（注释明确），仅保留用户显式临时授权 + 日志审计 |
| TD-12 | 跨层引用 | GoalExecutionCard value import 跨层 | 方案不合理——plan-diff.ts 是纯逻辑且 src/ 内部也引用，下沉到 desktop/shared/ 会导致 src/ 反向引用 desktop/，更糟。保留现状 |
| TD-13 | 死配置清理 | UIComponents/Sounds/ReasoningMode schema 删除 | 删除 SoundsConfigSchema/UIComponentsSchema/ReasoningModeSchema 定义及 AppConfigSchema.corresponding 字段；移除 defaults.ts 默认值；删除 SettingsProvidersTab 中 disabled 的推理模式 UI 块；更新 4 个测试文件。旧 config.json 中的字段会被 Zod 默认 strip，不影响 parse |
| TD-22 | 代码质量 | error instanceof Error 模式统一 | 创建 `src/utils/errors.ts:toErrorMessage(error)` 工具函数（安全处理 Error/string/object/null/undefined）+ 7 个单元测试。全库 204 处替换留待后续逐步进行 |
| TD-23 | 可维护性 | Phase N 时间戳注释噪音清理 | 量太大（153 处跨 3 文件），标注为逐步清理。后续修改这些文件时顺手清理即可，不单独开 Phase |
| TD-24 | 安全/日志 | defaults.ts API Key 日志脱敏 | 核实 defaults.ts 当前无 logger.debug 调用（任务为 no-op）。maskApiKey 工具已在 env-filter.ts 就绪，未来添加日志时可用 |

### 2026-07-29 Phase 79 权限/确认链路核实（TD-03/04/05/17）

经源码核实，Phase 79 Task 3/4/5 与 Core 工具数治理已实施，从活跃清单移除。

| TD ID | 类别 | 简述 | 修复方式 |
|-------|------|------|----------|
| TD-03 | 权限系统 | PermissionEngine 接入 onActing 中间件 | `src/agent/loop.ts:697` 串行模式 + `:569` 并行模式均调用 `mwRunner.runOnActing()`，PermissionEngine.check() 经 PermissionMiddleware 注入；deny 拦截 / confirm 驱动用户确认 / auto 放行 |
| TD-04 | 权限系统 | IPC tool:execute 权限校验 | `desktop/main/index.ts:1079-1110` 引入 `IPC_TOOL_WHITELIST`（test_connection/list_directory/file_read），非白名单工具直接拒绝；executeTool 透传 `{ source: 'ipc' }` callContext，无 callContext 时 fail-closed |
| TD-05 | 确认机制 | auto 模式 + autoApprovePatterns 接线 | `src/agent/loop.ts:717-729` auto 模式下 all tools 直接放行（危险操作由 DEFAULT_DENY_RULES 硬拦截）；semi 模式按 PermissionEngine 决策或 autoApprovePatterns 白名单判断 needsConfirmation |
| TD-17 | 性能/架构 | Core 工具数与注释一致性 | `src/runtime/app-init-tools.ts:101-113` 注释"≤10 个"仅指基础 Core 块（10 个：file_read/file_search/git_op/code_search/file_write/shell_exec/file_edit/list_directory/todo_write/ask_user）；VFS 4 + Plan 5 已独立分块（:153-165）并标注"Core，默认可用，无需 Pack 门控" |

### 2026-07-20 Freeze 层架构决策实施（TD-25/26/27）

| TD ID | 类别 | 简述 | 修复方式 |
|-------|------|------|----------|
| TD-25 | 架构决策 | ACRouter 解冻 | packs.acRouter.enabled→true，功能由 closedLoopRouting.enabled 控制 |
| TD-26 | 架构决策 | KG vs HybridRetriever | 保留 KG，移除 HybridRetriever 全部接线（6 文件） |
| TD-27 | 架构决策 | TrustGradient pack 拆分 | F-01 临时授权提升为 Core（移除 pack 门控），F-02/F-06 保留 |

### 2026-07-12 第三轮审查修复（48 项，部分为技术债前提修复）

commit `58183c6`（31 文件，+872/-83）。详见 `报告/修改记录.md`。

本轮修复了 48 项 findings，其中以下项为活跃技术债的前提修复或相关修复：

| 历史 ID | 类别 | 简述 | 修复方式 | 技术债关联 |
|---------|------|------|----------|-----------|
| V2-001 (Critical) | 安全 | process.env 完整透传到 tool 子进程 | 新建 env-filter.ts，统一环境变量过滤 | — |
| V2-T03 (Critical) | 安全 | createConfirmation 令牌可预测 | crypto.randomBytes 替代 Math.random | — |
| V3-003 (Critical) | 安全 | 自动更新无签名校验 | autoDownload=false + 用户确认 | — |
| V3-018 (Critical) | Agent loop | followUpLoop 无限循环 | MAX_FOLLOWUP_ITERATIONS=100 | — |
| V2-T01 | 事务 | rollback 无备份 | .backup 文件备份 + 失败恢复 | — |
| V2-T02 (Critical) | 事务 | requestUserConfirmation 永不超时 | 60s 超时 | — |
| V2-T05/T06/T11/T12 | 事务 | 多处非原子写 | 新建 safe-write.ts 统一原子写入 | TD-14 前提 |
| V2-016/017 | 事务 | goal-persistence/project-memory 非原子写 | safeWriteJSON/safeWriteText | TD-14 前提 |
| V2-021 | Agent loop | LLMRequestOptions 无 signal 字段 | 添加 signal?: AbortSignal + 透传 | — |
| V2-022 | Agent loop | AbortController 覆盖未先 abort | 覆盖前先 abort() | — |
| F3-1 | 错误处理 | 缺少全局未捕获异常处理器 | 注册 unhandledRejection/uncaughtException | — |
| V2-006 (Critical) | ESM | renderer require() 在 ESM 环境失效 | 改用 ESM import | — |
| F8-2 | 文档 | 版本号脱节 | package.json/README.md 统一为 4.9.0 | — |

**误报排除（8 项）**：V2-T20 / V2-T21 / V2-T24 / V2-013 / F4-3 / V2-T13 / V2-T15 / V2-T16

### 2026-07-11 排期技术债一次性修复（13 项）

commit `1f2bf85`（68 文件，+2391/-3605）。详见 `报告/修改记录.md`。

| 历史 ID | 类别 | 简述 | 修复方式 |
|---------|------|------|----------|
| G-004 | 架构隔离 | 并发聊天共享 AbortController | Map<requestId, AbortController> 隔离 |
| G-007 | 架构隔离 | 引擎热重载未释放旧依赖 | AppDependencies.dispose() 协议 |
| F-021 | 架构隔离 | EngineContext 共享可变字段 | readonly 修饰符 |
| G-022a | 文件拆分 | engine-bridge.ts 840 行 | 拆分为 profile/hook/trace 3 个 delegate bridge |
| G-022b | 文件拆分 | graph.ts 1159 行 | 拆分为 graph-core/community/recall + declaration merging |
| G-023 | 类型安全 | BranchOperations 双重断言 | branch.ts 新增 12 个受控公开 API |
| G-026 | 类型安全 | 渲染层 41 文件 deep import | 新建 config-types.ts 中转层 |
| G-010 | 清理 | GitHub Action 退役 | 删除 action.yml/workflow/action-entry.ts/dist |
| G-024 | 清理 | 退役 UI false 短路隐藏 | 删除 SettingsChannelsTab.tsx |
| G-025 | 清理 | synthesizer TODO | [TECH-DEBT] 标注块（排期新功能开发） |
| F-023 | 小修复 | spawn-agent model 可选 | 强制必填 |
| F-031 | 小修复 | config/loader 无大小限制 | MAX_CONFIG_SIZE=1MB + statSync 前置检查 |
| F-N026 短期 | 小修复 | IPC handler 薄弱校验 | 10+ handler 补校验（长期统一中间件化见 TD-07） |

### 2026-07-10 及更早

详见 `报告/修改记录.md` 各轮记录。已修复项不再在此跟踪。

---

## 4. 审查员引用指引

后续审查（任意模型）报告 findings 前必须：

1. **对照 §1 活跃清单**：本表 §1 已清空，仅报告新发现的问题。
2. **对照 §3 已修复历史**：已修复项不要重复报告。如发现回归，标注"TD-XX 回归"。
3. **新发现项**：追加到 §1 末尾，分配新 TD-ID（递增），填写触发来源。

### 审查 prompt 模板片段

可在审查 prompt 中加入以下声明：

```
已知技术债见 docs/TECH_DEBT_TRACKER.md。§1 已清空，仅报告新发现的问题。
已修复项（§3）如发现回归请标注。IPC handler 校验状态见 docs/IPC_HANDLER_INVENTORY.md。
```

---

## 5. 相关文档

- [Phase-79 技术债收尾与权限测试基建](../蓝图与Phase/Phase-79-技术债收尾与权限测试基建.md) — 7 项技术债解决方案规划
- [phase-71-audit-report.md](./phase-71-audit-report.md) — Phase 71 审计报告（跨 Phase RISK 跟踪）
- [DEAD_CODE_AUDIT.md](./DEAD_CODE_AUDIT.md) — 死代码审计历史
- [报告/修改记录.md](../报告/修改记录.md) — 各轮审查修复记录
