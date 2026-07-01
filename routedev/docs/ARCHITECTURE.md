# RouteDev 架构总览

> 本文档描述 RouteDev v2.0.0 的整体架构、模块关系与数据流。

## 1. 架构分层

RouteDev 采用五层架构，自下而上依次为：

```
┌─────────────────────────────────────────────────┐
│  渠道层 (Channels)                                │
│  Telegram / Slack / 企业微信 / Webhook            │
├─────────────────────────────────────────────────┤
│  CLI 层 (CLI)                                     │
│  App.tsx / 命令系统 / Ink 组件 / 向导             │
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

### 2.3 工具层 (`src/tools/`)
- **ToolRegistry**：工具注册中心
- **ToolExecutor**：工具执行器（安全检查 → 执行 → 记录）
- **PermissionEngine**：三层权限引擎（deny > confirm > auto）
- **SecurityChecker**：路径 / 命令 / 敏感文件安全检查
- **内置工具**：file_read / file_write / shell_exec / code_search / file_search / git_op / web_search / notes
- **MCPClientManager**：MCP 协议工具发现与注册

### 2.4 CLI 层 (`src/cli/`)
- **App.tsx**：Ink + React 主应用入口
- **CommandRegistry**：命令注册与分发
- **组件**：ChatView / StatusBar / TracePanel / DiffView / ConfirmDialog / ResumePicker 等
- **ServiceContext**：服务依赖注入容器

### 2.5 渠道层 (`src/channels/`)
- **ChannelManager**：多渠道统一管理
- **ChannelMessageRouter**：消息路由
- **WebhookServer**：Webhook 接收端点
- **适配器**：Telegram / Slack / 企业微信

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
用户输入 → ScenarioClassifier → ModelRouter → ReActAgentLoop → LLM → 响应渲染
```

### 3.2 /goal 多步任务流
```
/goal 输入 → GoalParser → GoalPlan → 逐步执行(ReActAgentLoop) → GoalVerifier → 完成
```

### 3.3 Compose 管线流
```
/compose → requirements(只读) → coding(读写) → testing(测试) → review(审查) → 完成
```

### 3.4 渠道消息流
```
Telegram消息 → TelegramAdapter → ChannelMessageRouter → Agent处理 → 响应 → TelegramAdapter回复
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
通过 MCP 协议接入外部工具服务器，支持 stdio 和 SSE 两种传输方式。

## 6. Phase 50 模块接入总览

Phase 50 将 41 项"已开发待集成"的资产接入生产代码执行链路。所有接入模块默认 `enabled: false`，用户在设置页面手动开启（渐进接入原则）。每个接入点均有 try/catch 兜底，接入失败时降级到原行为而非崩溃。

### 6.1 /goal 流程接入（Task 1）

| 模块 | 接入点 | 配置开关 |
|------|--------|----------|
| GoalPromptBuilder | `goal-runner.ts` handleGoalCommand 入口 | `goalIntegration.promptBuilderEnabled` |
| GoalPersistence | `goal-runner.ts` executeGoalPlan 持久化 | `goalIntegration.persistenceEnabled` |
| GoalAuditor | `goal-runner.ts` verify 阶段 | `goalIntegration.auditEnabled` |
| RequirementChangeAnalyzer | `goal-runner.ts` analyzeRequirementChange | `goalIntegration.requirementChangeEnabled` |

数据流：`/goal 输入 → GoalPromptBuilder.build → GoalParser → GoalPersistence.save → 执行 → GoalAuditor.audit → 完成`

### 6.2 多 Agent 编排接入（Task 2）

| 模块 | 接入点 | 配置开关 |
|------|--------|----------|
| StrategySelector | `orchestrator.ts` plan 阶段 | `orchestrationIntegration.strategyEnabled` |
| ExecutionStateGraph | `orchestrator.ts` execute 阶段 | `orchestrationIntegration.stateGraphEnabled` |
| BranchOrchestrator | `orchestrator.ts` planBranches | `orchestrationIntegration.branchOrchestrationEnabled` |

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
| ContextUsagePanel | `app-init.ts` 创建实例 | `phase49Integration.contextUsagePanelEnabled` |
| EvaluationFramework | `app-init.ts` 创建实例 | `phase49Integration.evaluationFrameworkEnabled` |
| RoutingFunnel | `app-init.ts` 创建实例 | `phase49Integration.routingFunnelEnabled` |

### 6.5 React 组件接入（Task 7）

| 组件 | 接入到 | 配置开关 | 默认值 |
|------|--------|----------|--------|
| BranchSwitcher | `App.tsx` 顶部分支切换 | `ui.components.branchSwitcher` | true |
| ResumePicker | `/resume` 命令多快照时触发 | `ui.components.resumePicker` | true |
| ProgressBar | `TaskMonitorPanel` 任务进度 | `ui.components.progressBar` | true |
| TracePanel | `/trace view` 命令触发 | `ui.components.tracePanel` | false |
| DisclosureLevel | `ChatView` 系统消息 >200 字符包裹 | `ui.components.disclosureLevel` | true |
| DiffView | `/diff` 命令触发 | `ui.components.diffView` | true |
| ConfigReloadUI | `App.tsx` 配置变更通知 | `ui.components.configReloadNotice` | true |

### 6.6 branch-operations 接入（Task 4）

`branch-operations.ts` 经评估保留（有独特功能：delete/insert/undo/redo/squash），通过 `BranchManager.createOperations()` 工厂方法接入。
