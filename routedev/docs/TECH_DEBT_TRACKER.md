# RouteDev 技术债跟踪表

> **用途：** 集中记录所有已知技术债，避免后续审查重复发现已排期项。
> **审查员指引：** 报告 findings 前请先对照本表 §1，已排期至 Phase-79+ 的 24 项不再重复报告。仅报告本表未覆盖的新问题。
> **维护规则：** 每轮审查后更新；修复完成的项移至 §3 历史区；新发现的项追加到 §1。
> **最后更新：** 2026-07-20（TD-25/26/27 架构决策已实施）

---

## 1. 活跃技术债清单（24 项，排期 Phase-79+）

按优先级排序。ID 格式：`TD-<序号>`（本表内部 ID） + 历史报告 ID（如 G-011 / F-004）。

| # | TD ID | 历史 ID | 优先级 | 类别 | 简述 | 排期 Phase | 触发来源 |
|---|-------|---------|--------|------|------|-----------|----------|
| 1 | TD-01 | G-011 / F-N019 | High | 测试基建 | 桌面聊天链路缺入口级集成测试 | Phase-79 Task 1 | gpt5.6terra / grok-4.5 / Qwen3.7max |
| 2 | TD-02 | F-004 | Medium | 文件拆分 | goal-runner.ts 44 imports 未拆分 | Phase-79 Task 2 | Qwen3.7max |
| 3 | TD-03 | F-N001 | High | 权限系统 | PermissionEngine 未接入 onActing 中间件 | Phase-79 Task 3 | Qwen3.7max + grok-4.5 |
| 4 | TD-04 | F-N002 / F-N009 | High | 权限系统 | IPC tool:execute 缺权限校验 | Phase-79 Task 4 | Qwen3.7max + grok-4.5 |
| 5 | TD-05 | F-N006 / F-N007 | Medium | 确认机制 | auto 模式 + 子 Agent 工具确认机制未实现 | Phase-79 Task 5 | Qwen3.7max + grok-4.5 |
| 6 | TD-06 | F-N017 / F-N018 | Medium | 信任系统 | TrustGradient 未接线 + 无集成测试 | Phase-79 Task 6（P2-8 持久化层已接通，动态升级仍待接线） | Qwen3.7max + grok-4.5 |
| 7 | TD-07 | F-N026 长期 | Low | IPC 治理 | IPC handler 统一校验中间件（本轮已补薄弱项，统一中间件化待后续） | Phase-79 Task 7 | Qwen3.7max + grok-4.5 |
| 8 | TD-08 | F-6.01 / F1-1 | Medium | 文件拆分 | createAgentSubsystem 1233 行拆分（15 项独立职责） | Phase-80+ | GLM-5.2 / DeepSeekV4Flash |
| 9 | TD-09 | F-6.02 | Medium | 文件拆分 | walkAndExtract 740 行拆分 | Phase-80+ | GLM-5.2 |
| 10 | TD-10 | F-6.03 | Medium | 文件拆分 | wrapSpawnAgentWithDelegation 345 行拆分 | Phase-79+ | GLM-5.2 |
| 11 | TD-11 | F-6.05 | Medium | 文件拆分 | SettingsPage 组件 462 行拆分 | Phase-79+ | GLM-5.2 |
| 12 | TD-12 | F-1.01 | Low | 跨层引用 | GoalExecutionCard value import 跨层 | 排期 | GLM-5.2 |
| 13 | TD-13 | F-10.01-04 | Low | 死配置清理 | CLI 退役死配置清理 | 排期 | GLM-5.2 |
| 14 | TD-14 | V2-019 | High | 韧性/升级 | 无 schema migration 机制（28+ 文件） | Phase-80+ | Qwen3.7max |
| 15 | TD-15 | F2-1/F2-2/F2-4/F2-5 | High | 类型安全 | Zod schema 运行时校验（AppDependencies / useRouteDevStore / database.ts / JSON.parse 安全敏感路径） | Phase-80+ | DeepSeekV4Flash |
| 16 | TD-16 | F-701 | Critical | 测试覆盖 | goal-runner 子模块零测试 | Phase-79+ | Qwen3.7max |
| 17 | TD-17 | F4-1 | Medium | 性能/架构 | 默认 Core 工具 19 个 vs 注释承诺 ≤10 | Phase-79+ | DeepSeekV4Flash |
| 18 | TD-18 | F1-2 | Medium | 架构耦合 | app-init-tools.ts 跨层创建 agentLoop | Phase-80+ | DeepSeekV4Flash |
| 19 | TD-19 | F1-3/F1-4 | Medium | 架构耦合 | ESM 循环依赖 + Pack 门控散布 30 处 | Phase-80+ | DeepSeekV4Flash |
| 20 | TD-20 | F3-3 | Medium | 错误处理 | 136 处 console 未用结构化 logger | Phase-80+ | DeepSeekV4Flash |
| 21 | TD-21 | F2-3 | Medium | 类型安全/测试 | 测试双重断言跳过类型检查（as unknown as） | Phase-79+ | DeepSeekV4Flash |
| 22 | TD-22 | F6-3 | Low | 代码质量 | error instanceof Error 模式统一（204 处 69 文件） | 排期 | DeepSeekV4Flash |
| 23 | TD-23 | F1-5 | Low | 可维护性 | Phase N 时间戳注释噪音清理 | 排期 | DeepSeekV4Flash |
| 24 | TD-24 | V2-005 | Low | 安全/日志 | defaults.ts API Key 日志脱敏（maskApiKey 已就绪） | 排期 | Qwen3.7max |
| 25 | TD-25 | F-09 | Medium | 架构决策 | ACRouter 解冻：packs.acRouter.enabled→true，功能由 closedLoopRouting.enabled 控制 | **已修复 2026-07-20** | 2026-07-19 架构审查 |
| 26 | TD-26 | F-10 | Medium | 架构决策 | KG vs HybridRetriever：保留 KG，移除 HybridRetriever 接线 | **已修复 2026-07-20** | 2026-07-19 架构审查 |
| 27 | TD-27 | F-01/02/06 | Low | 架构决策 | TrustGradient pack 拆分：F-01 临时授权提升为 Core，F-02/F-06 保留 pack 门控 | **已修复 2026-07-20** | 2026-07-19 架构审查 |

---

## 2. 活跃技术债详情

### TD-01: ChatBridge/Desktop 集成测试（G-011 / F-N019）

- **问题**：`desktop/main/bridges/chat-bridge.ts` 是桌面端聊天链路入口，承载 sendChat / stopGeneration / resolveToolConfirm 等核心 IPC，但无入口级集成测试覆盖。现有测试仅覆盖 store 层（`useRouteDevStore`）和组件层（`MessageBubble` 等），bridge 层的 requestId 隔离 / AbortController 生命周期 / 跨进程通信无测试保障。
- **风险**：G-004 requestId 隔离机制（2026-07-11 已修复）无回归测试，后续改动可能引入并发污染。
- **排期**：Phase-79 Task 1。需搭建 Electron 进程内集成测试基建（mock IPC + 真实 bridge 实例）。

### TD-02: goal-runner.ts 文件拆分（F-004）

- **问题**：`src/runtime/goal-runner.ts` 含 44 个 imports，单文件承载 Goal 生命周期 / 步骤调度 / 工具确认 / 恢复 / 持久化 等多职责，体量过大。
- **风险**：改动成本高，审查 token 消耗大，子 Agent 难以整体理解。
- **排期**：Phase-79 Task 2。参照 `app-init.ts` 拆分模式（app-init-agent / app-init-memory / app-init-observability / app-init-router / app-init-tools）。

### TD-03: PermissionEngine onActing 中间件（F-N001）

- **问题**：`src/tools/permission-engine.ts` 已实现工具级权限校验，但未接入 `ReActAgentLoop` 的 `onActing` 中间件钩子。工具执行仍依赖 `executor.ts` 内的 `securityChecker` 单点校验。
- **风险**：PermissionEngine 规则配置（用户在设置页配置的 allow/deny/confirm 规则）实际不生效，设置页 UI 是"装饰性"的。
- **排期**：Phase-79 Task 3。在 Loop 的 onActing 钩子插入 PermissionEngine.check() 调用，fail-closed 默认策略。

### TD-04: IPC tool:execute 权限校验（F-N002 / F-N009）

- **问题**：`desktop/main/index.ts` 的 `tool:execute` IPC handler 直接调用 executor，未经过 PermissionEngine 校验。Renderer 进程可通过 IPC 绕过工具级权限规则。
- **风险**：若 Renderer 进程被 XSS 攻击，攻击者可调用任意工具（包括 shell-exec / file-write）。
- **排期**：Phase-79 Task 4。在 tool:execute handler 增加权限校验层，复用 PermissionEngine。

### TD-05: auto 模式 + 子 Agent 确认机制（F-N006 / F-N007）

- **问题**：配置中存在 `autoApprovePatterns`（F-N008 已从默认值移除 web_search/web_fetch/todo_write），但 auto 模式逻辑未在 Loop 中接线。子 Agent（spawn-agent）的工具调用无确认机制，子 Agent 可执行任意工具。
- **风险**：auto 模式开关是装饰性的；子 Agent 是权限逃逸点。
- **排期**：Phase-79 Task 5。实现 auto 模式 + 子 Agent 工具确认的委托回父 Agent 机制。

### TD-06: TrustGradient 接线 + 集成测试（F-N017 / F-N018）

- **问题**：`src/tools/trust-gradient.ts` 已实现信任梯度计算，但未接入运行时。无行为级集成测试验证信任升级 / 降级逻辑。
- **风险**：信任梯度系统是"装配但未连接"的孤立模块（Phase 53 §1.2 已识别此类问题的模式）。
- **排期**：Phase-79 Task 6。接线到 PermissionEngine（作为 trustAutoAllowed 的判断依据）+ 编写行为级集成测试。
- **状态更新（2026-07-25，P2-8 部分修复）**：持久化层已接通——新建 `src/tools/project-trust-store.ts`，TrustGradientManager 通过 `attachPersistence(store, cwd)` 注入后 `setLevel` 自动持久化到 `.routedev/trust.json`，`loadInheritedFromStore()` 启动时加载继承级别（支持父目录递归查找）。**核心问题仍存在**：`checkOperation()` 仍未接入工具执行路径，动态升级对实际工具调用无影响；行为级集成测试仍缺失。

### TD-07: IPC handler 统一校验中间件（F-N026 长期）

- **问题**：`desktop/main/index.ts` 有 30+ IPC handler，校验逻辑分散。2026-07-11 已补 10+ handler 的薄弱校验（plan:check-omissions / trace:replay / chat:generate-title 等），但仍是逐个 handler 手写校验，未抽取统一中间件。
- **风险**：新增 handler 时容易遗漏校验；校验逻辑不一致。
- **排期**：Phase-79 Task 7。抽取 `createValidatedHandler<T>(schema, handler)` 统一中间件，所有 handler 强制走中间件包装。

### TD-08: createAgentSubsystem 1240 行拆分
- **来源**：GLM-5.2 审查 F-6.01
- **位置**：src/runtime/app-init-agent.ts:91-1330
- **状态**：排期 Phase-80+
- **方案**：参照 app-init-memory.ts 等拆分模式，将 15 个区块抽取为独立函数

### TD-09: walkAndExtract 740 行拆分
- **来源**：GLM-5.2 审查 F-6.02
- **位置**：src/code-map/extractor.ts:215-954
- **状态**：排期 Phase-80+
- **方案**：按 4 种语言抽取为 walkAndExtractTs/Py/Java/Go，主函数改为 dispatcher

### TD-10: wrapSpawnAgentWithDelegation 345 行拆分
- **来源**：GLM-5.2 审查 F-6.03
- **位置**：src/tools/builtin/spawn-agent.ts:466-810
- **状态**：排期 Phase-79+
- **方案**：每阶段抽取为独立函数 applyDelegationPolicy/packContext/checkDelegationGate 等

### TD-11: SettingsPage 组件 462 行拆分
- **来源**：GLM-5.2 审查 F-6.05
- **位置**：desktop/renderer/src/pages/SettingsPage.tsx:83-544
- **状态**：排期 Phase-79+
- **方案**：Tab 导航抽取为 SettingsTabNav，对话框抽取为 SettingsDialogs，30+ Tab 配置驱动

### TD-12: GoalExecutionCard value import 跨层
- **来源**：GLM-5.2 审查 F-1.01
- **位置**：desktop/renderer/src/components/GoalExecutionCard.tsx:19
- **状态**：排期
- **方案**：将 PlanDiffEngine 纯逻辑下沉到 desktop/shared/plan-diff.ts 共享区，或改为 IPC 调用

### TD-13: CLI 退役死配置清理
- **来源**：GLM-5.2 审查 F-10.01-04
- **位置**：src/config/schema-observability.ts, schema-router.ts, defaults.ts
- **状态**：排期
- **方案**：删除 UIComponentsSchema/SoundsConfigSchema/ChannelsConfigSchema/ReasoningModeSchema，配合配置迁移脚本处理已有用户配置

### TD-14: schema migration 机制（V2-019）

- **来源**：Qwen3.7max 审查 V2-019
- **位置**：跨 `src/memory/*` 与 `src/agent/memory/*`（28+ 文件）
- **状态**：排期 Phase-80+
- **问题**：`memory-store.ts`、`session-memory-store.ts` 等 JSON 文件 load 时直接 `JSON.parse`，没有 version 字段、无 migration 路径。用户从 v4.5 → v4.6 时若改了字段，load 后类型断言不匹配会丢数据。
- **方案**：在每个 JSON 顶层加 `__schemaVersion: number`，加 `migrate(data, fromVersion)` 工具；与 TD-15 的 Zod schema 校验协同实施
- **第三轮处理**：跳过（涉及 28+ 文件，属大型重构）

### TD-15: Zod schema 运行时校验（F2-1 / F2-2 / F2-4 / F2-5）

- **来源**：DeepSeekV4Flash 审查 F2-1 / F2-2 / F2-4 / F2-5
- **位置**：
  - `src/runtime/app-init.ts:399`（`as AppDependencies` 全集断言）
  - `desktop/renderer/src/store/useRouteDevStore.ts`（10 处 IPC 事件回调类型断言）
  - `src/code-map/database.ts`（系统性 `as Record<string, unknown>` + 逐字段断言）
  - 84 处 `JSON.parse(x) as Xxx` 无校验（src/ 35 + desktop/ 3 + tests/ 8）
- **状态**：排期 Phase-80+
- **问题**：TypeScript `as` 仅是编译期断言，不提供运行时校验；反序列化数据来自磁盘/LLM 输出/网络响应/localStorage，可能被篡改或版本迁移后格式不兼容
- **方案**：为安全敏感路径创建 Zod schema，在 `parse()` 替代 `as` 断言；优先覆盖：integrity-manifest、goal-persistence、checkpoint-manager、AppDependencies 合并点、IPC payload
- **第三轮处理**：跳过（涉及 51 文件，仅安全敏感路径建议单独处理）

### TD-16: goal-runner 子模块零测试（F-701）

- **来源**：Qwen3.7max 审查 F-701
- **位置**：`src/runtime/goal-runner-core.ts` / `goal-runner-confirm.ts` / `goal-runner-scheduler.ts` / `goal-runner-recovery.ts`
- **状态**：排期 Phase-79+
- **问题**：goal-runner 拆分后的 4 个子模块无独立单元测试，仅通过端到端 `/goal` 命令间接覆盖
- **风险**：DAG 编排、步骤确认、恢复逻辑的边界条件无回归保障
- **方案**：为每个子模块编写单元测试，覆盖正常流程 + 异常恢复 + 超时降级

### TD-17: 默认 Core 工具 19 个 vs ≤10（F4-1）

- **来源**：DeepSeekV4Flash 审查 F4-1
- **位置**：`src/runtime/app-init-tools.ts:99`
- **状态**：排期 Phase-79+
- **问题**：注释写"Core 工具（始终注册，≤10 个）"，但实际注册 19 个（基础 10 + VFS 4 + Plan 5）。发布门禁不满足。
- **方案**：将 VFS 和 Plan 工具移入对应 Pack（`packs.vfsPlan.enabled`），Core 仅保留 10 个基础工具；或更新注释为 ≤20

### TD-18: app-init-tools 跨层创建 agentLoop（F1-2）

- **来源**：DeepSeekV4Flash 审查 F1-2
- **位置**：`src/runtime/app-init-tools.ts:249-256`
- **状态**：排期 Phase-80+
- **问题**：工具子系统（tools/层）创建了本属于 Agent 层的 `ReActAgentLoop` 实例，违反 CODEMAP.md 层次结构定义；agent 子系统只能被动接收已创建的 agentLoop，丧失配置控制权
- **方案**：调整创建顺序——tools 子系统返回 registry/toolExecutor/adapter 后，由 agent 子系统负责创建 ReActAgentLoop，通过创建后注入方式解耦

### TD-19: ESM 循环依赖 + Pack 门控散布（F1-3 / F1-4）

- **来源**：DeepSeekV4Flash 审查 F1-3 / F1-4
- **位置**：
  - `src/runtime/goal-runner-core.ts:56-58`（静态 import 三个子模块，子模块反向 import GoalRunnerCtx 类型和 MAX_CONTEXT_ITEMS 常量）
  - Pack 门控 `config.packs?.xxx?.enabled` 散布在 6 个文件共 30 处（app-init-agent 19 / app-init-tools 3 / app-init-memory 4 / app-init-router 2 / goal-runner-scheduler 1 / goal-runner-recovery 1）
- **状态**：排期 Phase-80+
- **问题**：循环依赖当前因常量仅在函数体内访问才未触发 TDZ，非常脆弱；Pack 门控散布导致新增 Pack 时改动点过多
- **方案**：
  1. 将常量和类型移到独立的 `goal-runner-types.ts` 共享文件，消除循环依赖
  2. 在 `app-init.ts` 增加显式"装配配方"步骤，计算功能矩阵 `EnabledPacks` 驱动子模块装配

### TD-20: 136 处 console 未用结构化 logger（F3-3）

- **来源**：DeepSeekV4Flash 审查 F3-3
- **位置**：src/ 61 处（29 文件）+ desktop/ 75 处（20 文件），共 136 处 49 文件
- **状态**：排期 Phase-80+
- **问题**：生产代码混用 `console.warn/log/error` 与结构化 `logger`，desktop/main/index.ts 以 30 处 console 居首
- **方案**：统一使用 `logger.warn/error/debug` 替代 `console.*`；desktop/main/index.ts 的启动日志可接受但应标注 `// eslint-disable-next-line no-console` 或迁移到 logger

### TD-21: 测试双重断言跳过类型检查（F2-3）

- **来源**：DeepSeekV4Flash 审查 F2-3
- **位置**：`desktop/main/__tests__/chat-bridge.integration.test.ts:123`（`as unknown as AppDependencies`）+ 8 处 `as any`
- **状态**：排期 Phase-79+
- **问题**：测试代码使用双重断言完全跳过类型检查，mock 注入缺乏类型安全
- **方案**：使用 `Partial<AppDependencies>` + 工厂函数显式填充所需字段

### TD-22: error instanceof Error 模式统一（F6-3）

- **来源**：DeepSeekV4Flash 审查 F6-3
- **位置**：204 处 69 文件
- **状态**：排期
- **问题**：错误处理模式不统一，部分代码用 `error instanceof Error`，部分用 `String(error)` 或 `(error as Error).message`
- **方案**：统一为 `error instanceof Error ? error.message : String(error)` 模式，或抽取 `toErrorMessage(error)` 工具函数

### TD-23: Phase N 时间戳注释噪音清理（F1-5）

- **来源**：DeepSeekV4Flash 审查 F1-5
- **位置**：app-init-agent.ts 78 处、app-init-tools.ts 35 处、goal-runner-core.ts 40 处（Phase 30-82，跨度 50+ Phase）
- **状态**：排期
- **问题**：大量"Phase N"时间戳注释无信息量，增加阅读负担
- **方案**：稳定超过 2 个版本的 Phase 注释改为架构注释（描述"什么/为什么"而非"哪个阶段加的"），仅保留 `// Design:` 或 `// Rationale:` 有信息量的注释

### TD-24: defaults.ts API Key 日志脱敏（V2-005）

- **来源**：Qwen3.7max 审查 V2-005
- **位置**：`src/config/defaults.ts:221-229`
- **状态**：排期
- **问题**：`process.env.GLM_WEB_SEARCH_API_KEY` 等 9 个 `*_API_KEY` 直接从进程环境读到默认 config，未做脱敏日志；`logger.debug` 若误开 `level=debug`，会把整 config 打日志
- **方案**：使用第三轮新建的 `src/security/env-filter.ts` 中的 `maskApiKey()` 包装 logger 调用
- **备注**：第三轮 audit-report-fixer 核验发现 defaults.ts 当前无 logger.debug 调用（任务为 no-op），但未来添加日志时需注意脱敏；maskApiKey 工具已就绪

### TD-25: ACRouter 解冻条件与路径（F-09）— ✅ 已修复 2026-07-20

- **来源**：2026-07-19 架构审查（Freeze 层深度审查）
- **位置**：`src/router/orchestrator.ts`、`src/router/routing-memory.ts`、`src/router/regret-tracker.ts`；装配点 `app-init-router.ts:99`
- **状态**：✅ 已修复（2026-07-20）
- **修复方式**：`packs.acRouter.enabled` 默认值从 `false` 改为 `true`（defaults.ts），ACRouter 从 freeze 提升为 standard-pack。组件默认装配但功能休眠——有效门控仅为 `closedLoopRouting.enabled`（默认 false）。用户在配置中启用 `closedLoopRouting.enabled: true` 后，/goal 路径自动使用 RoutingOrchestrator 做加权投票路由决策。架构全程 fail-open，orchestrator 失败自动回退基础路由。
- **遗留**：冷启动渐进策略和 HashEmbedder 精度验证留待用户实际启用后观察。

### TD-26: KG vs HybridRetriever 二选一（F-10）— ✅ 已修复 2026-07-20

- **来源**：2026-07-19 架构审查（Freeze 层深度审查）
- **位置**：Core 路径 `src/agent/memory/recall-injector.ts` + `graph-core.ts`；原 Freeze 路径 `src/memory/memory-store.ts` + `hybrid-retriever.ts` + `local-maintenance.ts`
- **状态**：✅ 已修复（2026-07-20，选方案 A）
- **修复方式**：移除 HybridRetriever/MemoryStore/LocalMaintenance 全部接线——app-init-memory.ts 创建块、AppDependencies/GoalRunnerDeps 接口字段、goal-runner-scheduler.ts 三处使用块、defaults.ts memorySystem 配置。源文件保留于 src/memory/ 冻结归档（不删除，避免破坏直接引用它们的测试）。Schema 保留向后兼容。Core KG recallV2 混合策略覆盖相同用例。

### TD-27: TrustGradient pack 拆分（F-01/F-02/F-06）— ✅ 已修复 2026-07-20

- **来源**：2026-07-19 架构审查（Freeze 层深度审查 + 核实修正）
- **位置**：F-01 `src/tools/trust-gradient.ts`；F-02 `src/agent/middleware/quality-signal.ts`；F-06 `src/agent/middleware/expertise-prompt.ts`
- **状态**：✅ 已修复（2026-07-20，选方案 A）
- **修复方式**：app-init-agent.ts 中 F-01 TrustGradientManager 的装配条件从 `trustCfg && config.packs?.trustGradient?.enabled` 改为 `trustCfg`（移除 pack 门控），临时授权作为 Core 无条件装配。F-02/F-06 的 `packs.trustGradient.enabled` 门控保持不变。

---

## 3. 已修复技术债历史（按时间倒序）

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

1. **对照 §1 活跃清单**：已排期至 Phase-79+ 的 24 项不要重复报告。可以补充 Phase-79 未覆盖的细节，但需明确引用 TD-ID。
2. **对照 §3 已修复历史**：已修复项不要重复报告。如发现回归，标注"TD-XX 回归"。
3. **新发现项**：追加到 §1 末尾，分配新 TD-ID（递增），填写触发来源。

### 审查 prompt 模板片段

可在审查 prompt 中加入以下声明：

```
已知技术债见 docs/TECH_DEBT_TRACKER.md。§1 列出的 24 项已排期 Phase-79+，不要重复报告。
仅报告本表未覆盖的新问题。已修复项（§3）如发现回归请标注。
```

---

## 5. 相关文档

- [Phase-79 技术债收尾与权限测试基建](../蓝图与Phase/Phase-79-技术债收尾与权限测试基建.md) — 7 项技术债解决方案规划
- [phase-71-audit-report.md](./phase-71-audit-report.md) — Phase 71 审计报告（跨 Phase RISK 跟踪）
- [DEAD_CODE_AUDIT.md](./DEAD_CODE_AUDIT.md) — 死代码审计历史
- [报告/修改记录.md](../报告/修改记录.md) — 各轮审查修复记录
