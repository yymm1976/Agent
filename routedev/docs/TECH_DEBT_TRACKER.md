# RouteDev 技术债跟踪表

> **用途：** 集中记录所有已知技术债，避免后续审查重复发现已排期项。
> **审查员指引：** 报告 findings 前请先对照本表 §1，已排期至 Phase-79+ 的 13 项不再重复报告。仅报告本表未覆盖的新问题。
> **维护规则：** 每轮审查后更新；修复完成的项移至 §3 历史区；新发现的项追加到 §1。
> **最后更新：** 2026-07-11（Phase-79 立项）

---

## 1. 活跃技术债清单（13 项，排期 Phase-79+）

按优先级排序。ID 格式：`TD-<序号>`（本表内部 ID） + 历史报告 ID（如 G-011 / F-004）。

| # | TD ID | 历史 ID | 优先级 | 类别 | 简述 | 排期 Phase | 触发来源 |
|---|-------|---------|--------|------|------|-----------|----------|
| 1 | TD-01 | G-011 / F-N019 | High | 测试基建 | 桌面聊天链路缺入口级集成测试 | Phase-79 Task 1 | gpt5.6terra / grok-4.5 / Qwen3.7max |
| 2 | TD-02 | F-004 | Medium | 文件拆分 | goal-runner.ts 44 imports 未拆分 | Phase-79 Task 2 | Qwen3.7max |
| 3 | TD-03 | F-N001 | High | 权限系统 | PermissionEngine 未接入 onActing 中间件 | Phase-79 Task 3 | Qwen3.7max + grok-4.5 |
| 4 | TD-04 | F-N002 / F-N009 | High | 权限系统 | IPC tool:execute 缺权限校验 | Phase-79 Task 4 | Qwen3.7max + grok-4.5 |
| 5 | TD-05 | F-N006 / F-N007 | Medium | 确认机制 | auto 模式 + 子 Agent 工具确认机制未实现 | Phase-79 Task 5 | Qwen3.7max + grok-4.5 |
| 6 | TD-06 | F-N017 / F-N018 | Medium | 信任系统 | TrustGradient 未接线 + 无集成测试 | Phase-79 Task 6 | Qwen3.7max + grok-4.5 |
| 7 | TD-07 | F-N026 长期 | Low | IPC 治理 | IPC handler 统一校验中间件（本轮已补薄弱项，统一中间件化待后续） | Phase-79 Task 7 | Qwen3.7max + grok-4.5 |
| 8 | TD-08 | F-6.01 | Medium | 文件拆分 | createAgentSubsystem 1240 行拆分 | Phase-80+ | GLM-5.2 |
| 9 | TD-09 | F-6.02 | Medium | 文件拆分 | walkAndExtract 740 行拆分 | Phase-80+ | GLM-5.2 |
| 10 | TD-10 | F-6.03 | Medium | 文件拆分 | wrapSpawnAgentWithDelegation 345 行拆分 | Phase-79+ | GLM-5.2 |
| 11 | TD-11 | F-6.05 | Medium | 文件拆分 | SettingsPage 组件 462 行拆分 | Phase-79+ | GLM-5.2 |
| 12 | TD-12 | F-1.01 | Low | 跨层引用 | GoalExecutionCard value import 跨层 | 排期 | GLM-5.2 |
| 13 | TD-13 | F-10.01-04 | Low | 死配置清理 | CLI 退役死配置清理 | 排期 | GLM-5.2 |

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

---

## 3. 已修复技术债历史（按时间倒序）

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

1. **对照 §1 活跃清单**：已排期至 Phase-79+ 的 13 项不要重复报告。可以补充 Phase-79 未覆盖的细节，但需明确引用 TD-ID。
2. **对照 §3 已修复历史**：已修复项不要重复报告。如发现回归，标注"TD-XX 回归"。
3. **新发现项**：追加到 §1 末尾，分配新 TD-ID（递增），填写触发来源。

### 审查 prompt 模板片段

可在审查 prompt 中加入以下声明：

```
已知技术债见 docs/TECH_DEBT_TRACKER.md。§1 列出的 13 项已排期 Phase-79+，不要重复报告。
仅报告本表未覆盖的新问题。已修复项（§3）如发现回归请标注。
```

---

## 5. 相关文档

- [Phase-79 技术债收尾与权限测试基建](../蓝图与Phase/Phase-79-技术债收尾与权限测试基建.md) — 7 项技术债解决方案规划
- [phase-71-audit-report.md](./phase-71-audit-report.md) — Phase 71 审计报告（跨 Phase RISK 跟踪）
- [DEAD_CODE_AUDIT.md](./DEAD_CODE_AUDIT.md) — 死代码审计历史
- [报告/修改记录.md](../报告/修改记录.md) — 各轮审查修复记录
