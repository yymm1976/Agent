# RouteDev 架构总览

> 本文档描述 RouteDev v2.0.0 的整体架构、模块关系与数据流。

## 1. 架构分层

RouteDev 采用五层架构，自下而上依次为：

```
┌─────────────────────────────────────────────────┐
│  Desktop 层 (Electron)                           │
│  Renderer (React GUI) / Main / Preload           │
├─────────────────────────────────────────────────┤
│  运行时层 (Runtime)                               │
│  app-init / goal-runner / notification / doctor  │
├─────────────────────────────────────────────────┤
│  Agent 层 (Agent)                                 │
│  ReAct Loop / Goal / Compose / Durable / Multi   │
├─────────────────────────────────────────────────┤
│  工具层 (Tools)                                   │
│  内置工具 / MCP / 权限引擎 / 安全检查             │
├─────────────────────────────────────────────────┤
│  基础设施层 (Infrastructure)                      │
│  Router / Config / Logger / Harness / Plugins    │
└─────────────────────────────────────────────────┘
```

## 2. 核心模块

### 2.1 Router 层 (`src/router/`)
- **ScenarioClassifier**：任务复杂度分类器（规则 + LLM 双路径）
- **ModelRouter**：根据分类结果选择最优模型
- **TokenTracker**：多维度 Token 归因统计 + 每日重置 + 预算检查
- **LLM Client**：OpenAI / Anthropic 双协议适配

### 2.2 Agent 层 (`src/agent/`)
- **ReActAgentLoop**：核心 ReAct 循环（think → act → observe → answer）
- **GoalParser / GoalVerifier**：目标分解与验证
- **DurableExecutor**：持久化执行器，断点恢复
- **ComposePipeline**：四阶段自动编排（requirements → coding → testing → review）
- **Orchestrator / WorkerExecutor**：多 Agent 编排
- **BranchManager**：分支对话管理
- **ContextCompactor**：五阶段渐进压缩
- **WorkModeController**：三模式权限（build / plan / compose）
- **PathRouter**（Phase 58 统一）：路径路由器，合并原 execution-router + level-path-router，提供 `selectPath(level)` / `route(plan, options)` / `detectLevelSwitch(level, signals)` 三类方法

### 2.3 工具层 (`src/tools/`)
- **ToolRegistry**：工具注册中心
- **ToolExecutor**：工具执行器（安全检查 → 执行 → 记录）
- **PermissionEngine**：三层权限引擎（deny > confirm > auto）
- **SecurityChecker**：路径 / 命令 / 敏感文件安全检查
- **内置工具**：file_read / file_write / shell_exec / code_search / file_search / git_op / web_search / notes
- **MCPClientManager**：MCP 协议工具发现与注册

### 2.4 Desktop 层 (`desktop/`)
- **main/index.ts**：Electron 主进程，窗口管理 + IPC 注册
- **main/engine-bridge.ts**：引擎桥接，desktop 与 `src/runtime/` 的唯一连接点，包含 `sendChat`（含 Trajectory 汇总 / CircuitBreaker / 微摘要）+ `executeCommand` + `/goal` 执行
- **renderer/**：React GUI（SettingsPage / ChatPage / TokenPage / TracePage）
- **preload/**：安全 IPC API 暴露

### 2.5 运行时层 (`src/runtime/`)
- **app-init**：服务装配与依赖注入入口
- **goal-runner**：`/goal` 多步任务执行器
- **notification**：通知调度
- **doctor**：环境与配置健康检查

### 2.6 基础设施
- **Config** (`src/config/`)：Zod Schema + YAML 加载 + 热重载
- **Harness** (`src/harness/`)：AuditLogger / CheckpointManager / TraceCollector
- **Plugins** (`src/plugins/`)：四类插件（Theme / Tool / Hook / Router）
- **Prompts** (`src/prompts/`)：三级优先级模板系统
- **Memory** (`src/agent/memory/`)：知识图谱 / 上下文管理 / 检查点写入 / notes
- **Utils** (`src/utils/`)：错误类体系 / 日志 / 路径 / 重试 / Token 估算

## 3. 数据流

### 3.1 简单对话流
```
用户输入(desktop renderer) → IPC → engine-bridge.sendChat → ScenarioClassifier → ModelRouter → ReActAgentLoop → LLM → 响应渲染(desktop renderer)
```

### 3.2 /goal 多步任务流
```
/goal 输入 → GoalParser → GoalPlan → 逐步执行(ReActAgentLoop) → GoalVerifier → 完成
```

### 3.3 Compose 管线流
```
/compose → requirements(只读) → coding(读写) → testing(测试) → review(审查) → 完成
```

## 4. 安全模型

RouteDev 采用七层安全防护：

1. **权限层**：PermissionEngine 三层决策（deny > confirm > auto）
2. **目录边界**：SecurityChecker 限制文件操作在项目目录内
3. **命令黑名单**：危险命令拦截（rm -rf / curl / wget 等）
4. **敏感文件保护**：.env / credentials.json / *.key 访问控制
5. **网络确认**：web_search 等网络工具需用户确认
6. **子进程隔离**：shell_exec 在独立子进程执行
7. **审计日志**：所有敏感操作记录到 JSONL 审计文件

## 5. 扩展机制

### 插件系统
四类插件通过统一接口接入：
- **ThemePlugin**：自定义颜色主题
- **ToolPlugin**：注册自定义工具
- **HookPlugin**：生命周期钩子（pre-step / post-step / on-error）
- **RouterPlugin**：自定义路由决策

### MCP 集成
通过 MCP 协议接入外部工具服务器，支持 stdio / http / sse / streamable_http / websocket 五种传输方式。

## 6. Phase 50 模块接入总览

Phase 50 将 41 项"已开发待集成"的资产接入生产代码执行链路。所有接入模块默认 `enabled: false`，用户在设置页面手动开启（渐进接入原则）。每个接入点均有 try/catch 兜底，接入失败时降级到原行为而非崩溃。

### 6.1 /goal 流程接入（Task 1）

| 模块 | 接入点 | 配置开关 |
|------|--------|----------|
| GoalPersistence | `goal-runner.ts` executeGoalPlan 持久化 | `goalIntegration.persistenceEnabled` |
| GoalAuditor | `goal-runner.ts` verify 阶段 | `goalIntegration.auditEnabled` |

注：GoalPromptBuilder / RequirementChangeAnalyzer 已在 Phase 59 删除（无用户可见产物或职责重叠）。

数据流：`/goal 输入 → GoalParser → GoalPersistence.save → 执行 → GoalAuditor.audit → 完成`

### 6.2 多 Agent 编排接入（Task 2）

| 模块 | 接入点 | 配置开关 |
|------|--------|----------|
| StrategySelector | `orchestrator.ts` plan 阶段 | `orchestrationIntegration.strategyEnabled` |
| ExecutionStateGraph | `orchestrator.ts` execute 阶段 | `orchestrationIntegration.stateGraphEnabled` |

### 6.3 子 Agent 委托体系接入（Task 3）

`spawn-agent.ts` 通过 `wrapSpawnAgentWithDelegation` 包装器接入 5 个模块：

| 模块 | 接入顺序 | 配置开关 |
|------|----------|----------|
| ContextPacker | 1. 按角色打包上下文附加到 prompt | `delegationIntegration.contextPackerEnabled` |
| DelegationGate | 2. spawn 前检查委托资格 | `delegationIntegration.delegationGateEnabled` |
| DelegationEnforcer | 3. 创建契约 + 校验工具调用 | `delegationIntegration.delegationEnforcerEnabled` |
| SubAgentLifecycle | 4. 注册 + 状态转换 + 反滥用 | `delegationIntegration.lifecycleEnabled` |
| SubAgentScoreCardCollector | 5. 执行后收集评分卡 | `delegationIntegration.scoreCardEnabled` |

注：`delegation-contract.ts` 随 enforcer 接入自动解除传递性死链。

### 6.4 Phase 48/49 模块接入确认（Task 5/6）

| 模块 | 接入点 | 配置开关 |
|------|--------|----------|
| CiteResolver | `app-init.ts` 创建实例 | `phase48Integration.citeEnabled` |
| ClaudePluginImporter | `app-init.ts` 创建实例 | `phase48Integration.importEnabled` |
| CodexInstructionImporter | `app-init.ts` 创建实例 | `phase48Integration.importEnabled` |
| MacroManager | `app-init.ts` 创建实例 | `phase48Integration.macrosEnabled` |
| ClaudeMCPBridge | `app-init.ts` 创建实例 | `phase48Integration.mcpBridgeEnabled` |
| SkillFlowEngine | `app-init.ts` 创建实例 | `phase49Integration.skillFlowEnabled` |
| DualLoopOrchestrator | `app-init.ts` 创建实例 | `phase49Integration.dualLoopEnabled` |
| SkillQualityGate | `app-init.ts` 创建实例（未接入主流程，setter 不存在） | `phase49Integration.skillQualityGateEnabled` |

注：RoutingFunnel 已在 Phase 59 删除（路由由 ModelRouter + ScenarioClassifier + PathRouter 承担）。ContextUsagePanel 与 EvaluationFramework 已在 Phase 72 删除（死代码清理，无消费方）。

### 6.5 React 组件接入（Task 7）

> 已随终端 UI 退役（Phase 72）：原表中的 BranchSwitcher / ResumePicker / ProgressBar / TracePanel / DisclosureLevel / DiffView / ConfigReloadUI 均为 CLI Ink 组件，随 `src/cli/` 一并删除。Desktop renderer 提供等价的 React GUI 实现（见 2.4 Desktop 层）。

### 6.6 branch-operations 接入（Task 4）

`branch-operations.ts` 经评估保留（有独特功能：delete/insert/undo/redo/squash），通过 `BranchManager.createOperations()` 工厂方法接入。

## 7. Phase 56-60 花架子去除工程总览

Phase 56-60 是 RouteDev 的架构瘦身工程，删除 ~3000 行死代码与无用户可见产物的模块，统一路由层，安全能力默认启用。

### 7.1 D 档清除（Phase 56）

删除无消费方的重型模块：
- `src/agent/self-evolution/` 整个目录（selfEvolution/godelProposer/selfHarness 配置字段移除）
- `src/agent/dream-consolidator.ts`（无入口模块）
- `src/agent/eq-detector.ts`（接口不匹配）

### 7.2 C 档收窄（Phase 57）

将低频能力降级为可选：
- `voice` 移至 `src/optional/voice/`，默认关闭（Phase 72 已彻底删除）
- `vision` 默认关闭，需显式 `vision.enabled: true`
- `/dream` 改名为 `/consolidate-memory`（Phase 60 删除 deprecated alias）
- `persona-templates.ts` 删除，硬编码人格改为 config 驱动（`persona.systemPromptAppend`）

### 7.3 路由合并（Phase 58）

三套路由统一为单一 PathRouter：
- `src/agent/execution-router.ts` + `src/agent/level-path-router.ts` 合并为 `src/agent/path-router.ts`
- `ExecutionRoute` 类型从 `'single' | 'dag' | 'compose' | 'legacy'` 收窄为 `'single' | 'dag' | 'compose'`
- `executionRouter.mode` 枚举从 `'auto' | 'legacy' | 'explicit'` 收窄为 `'auto' | 'explicit'`（旧 `legacy` 值由 z.preprocess 自动迁移为 `auto`）
- 删除 `executePlanWithMultiAgent`（legacy 路径执行函数）

### 7.4 B 档闭环补齐（Phase 59）

清算所有 `*Integration.enabled: false` 字段，消灭"幽灵功能"：
- **删除 6 个无价值字段**：routingFunnelEnabled / processEvaluation / archAwareMetrics / saturationMonitor / promptBuilderEnabled / requirementChangeEnabled
- **安全相关 5 个字段默认启用**（false → true）：policyEngine / auditChain / mcpSecurityScan / skillSecurityGate / configGuard；装配块加 fail-open 守卫（try-catch + logger.warn）
- **删除重复字段**：`phase52Integration.mcpSecurity`（与 `phase53Integration.mcpSecurityScan` 重复，保留 53 的）

### 7.5 A 档打磨（Phase 60）

- 核心模块边界测试补强：PathRouter（6 用例）+ CCRCache（5 用例）
- 删除 `/dream` deprecated alias
- 文档同步，版本发布 v4.5.4

## 8. Phase 72 架构变更总览

Phase 72 是 RouteDev 的前端收敛与死代码清算工程：终端 UI 退役，desktop 成为唯一前端；核心装配层独立为 `src/runtime/`；engine-bridge 桥接能力补齐；channels / voice / patterns / evaluation 等死模块彻底清除。

### 8.1 终端 UI 退役

- 删除 Ink + `App.tsx` + `components/` + `commands/`
- `src/cli/` 整体重命名为 `src/runtime/`，剥离终端 UI 后保留 app-init / goal-runner / notification / doctor 等运行时装配
- desktop Electron 成为唯一前端，所有交互经 `desktop/main/engine-bridge.ts` 进入运行时层

### 8.2 cli/ → runtime/ 重命名

- 核心装配层独立为 `src/runtime/`，与 `desktop/` 解耦
- `desktop/main/engine-bridge.ts` 是 desktop 与 `src/runtime/` 的唯一连接点

### 8.3 engine-bridge 补齐

`engine-bridge.sendChat` 补齐三项能力：
- **Trajectory 汇总**：聚合执行轨迹用于 trace 展示
- **CircuitBreaker**：熔断保护，避免 LLM 调用连环失败拖垮主进程
- **微摘要**：响应附带精简摘要，供 renderer 快速渲染

### 8.4 死代码清理

- `src/channels/` 整个子系统删除（ChannelManager / ChannelMessageRouter / WebhookServer / 各适配器）
- `src/optional/voice/` 删除（Phase 57 收窄后的最终清算）
- `patterns/` / `evaluation/` 等无消费方模块删除
- `persona-engine` / `preference-manager` / `context-usage-panel` 等死模块删除
- `errors.ts` 删除 3 个未使用错误类
- `schema.ts` export 收敛，仅暴露外部消费的类型
- `tournament` 选项移除
