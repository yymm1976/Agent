# RouteDev 配置参考

> 本文档列出 RouteDev 所有配置项，按模块分组。
> 配置文件位置：`~/.routedev/config.yaml`（全局）或项目根目录 `.routedev/config.yaml`（项目级）。
> 所有配置项均通过 Zod Schema 校验，非法值会在启动时报错。

## 1. 顶层结构

```yaml
general:
  language: zh-CN
providers: []
router: {}
agent: {}
autonomy:
  defaultMode: semi
checkpoint: {}
mcp: {}
import: {}
ui: {}
security: {}
# Phase 50 新增：
goalIntegration: {}
orchestrationIntegration: {}
delegationIntegration: {}
phase48Integration: {}
phase49Integration: {}
```

## 2. Phase 50 新增配置项

### 2.1 goalIntegration（Task 1：/goal 流程接入）

```yaml
goalIntegration:
  # 是否启用五段式 goal spec 构造（goal/scope/constraints/doneWhen/stopIf）
  promptBuilderEnabled: false
  # 是否启用目标持久化到 .routedev/goals/
  persistenceEnabled: false
  # 是否启用多层目标审计（CompletionGate + VerifierLLM + ReviewerAgent 三层仲裁）
  auditEnabled: false
  # 是否启用需求变更分析（用户追加需求时检测影响）
  requirementChangeEnabled: false
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `promptBuilderEnabled` | boolean | false | 开启后 `/goal` 命令入口调用 `GoalPromptBuilder.build` 构造五段式规范 |
| `persistenceEnabled` | boolean | false | 开启后 plan 生成后调用 `GoalPersistence.save` 持久化到 `.routedev/goals/<id>.json` |
| `auditEnabled` | boolean | false | 开启后 verify 阶段调用 `GoalAuditor.audit` 执行三层独立审计 |
| `requirementChangeEnabled` | boolean | false | 开启后用户追加需求时调用 `RequirementChangeAnalyzer.analyzeChangeImpact` 分析影响 |

### 2.2 orchestrationIntegration（Task 2：多 Agent 编排接入）

```yaml
orchestrationIntegration:
  # 是否启用按复杂度自动选择策略（sequential/parallel/adaptive）
  strategyEnabled: false
  # 是否启用步骤级状态机管理
  stateGraphEnabled: false
  # 是否启用并行分支任务调度
  branchOrchestrationEnabled: false
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `strategyEnabled` | boolean | false | 开启后 `Orchestrator.plan` 按 GoalPlan 步骤数选择策略（≤2=sequential, 3-6=parallel, >6=adaptive） |
| `stateGraphEnabled` | boolean | false | 开启后 `Orchestrator` 用 `ExecutionStateGraph` 管理步骤状态转换（pending→running→completed） |
| `branchOrchestrationEnabled` | boolean | false | 开启后 `Orchestrator.planBranches` 调用 `BranchOrchestrator` 调度并行分支任务 |

### 2.3 delegationIntegration（Task 3：子 Agent 委托体系接入）

```yaml
delegationIntegration:
  # 是否启用上下文打包（按角色权重收集代码符号）
  contextPackerEnabled: false
  # 是否启用委托门控（spawn 前检查资格）
  delegationGateEnabled: false
  # 是否启用契约校验（执行中校验工具调用合规）
  delegationEnforcerEnabled: false
  # 是否启用生命周期管理 + 反滥用检测
  lifecycleEnabled: false
  # 是否启用评分卡收集
  scoreCardEnabled: false
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contextPackerEnabled` | boolean | false | 开启后 `spawn_agent` 调用前用 `ContextPacker.pack` 按角色打包上下文附加到 prompt |
| `delegationGateEnabled` | boolean | false | 开启后 `spawn_agent` 调用前用 `DelegationGate.checkDelegationEligibility` 检查资格，不合格拒绝 |
| `delegationEnforcerEnabled` | boolean | false | 开启后创建 `DelegationContract` + `DelegationEnforcer` 校验工具调用合规（自动激活 `delegation-contract.ts`） |
| `lifecycleEnabled` | boolean | false | 开启后用 `SubAgentLifecycle` 注册子 Agent 状态转换（pending→running→completed/failed）+ 反滥用检测 |
| `scoreCardEnabled` | boolean | false | 开启后执行完成用 `SubAgentScoreCardCollector` 记录评分卡（角色/满意度/Token 使用） |

### 2.4 ui.components（Task 7：React 组件接入）

```yaml
ui:
  components:
    # 分支切换器（ChatPage 顶部）
    branchSwitcher: true
    # 恢复执行选择器（/resume 多快照时触发）
    resumePicker: true
    # 进度条（TaskMonitorPanel 任务进度）
    progressBar: true
    # Trace 面板（/trace view 命令触发，默认关闭需交互式输入）
    tracePanel: false
    # 渐进披露（系统消息 >200 字符时包裹）
    disclosureLevel: true
    # Diff 视图（/diff 命令触发）
    diffView: true
    # 配置变更通知（配置热重载时顶部通知）
    configReloadNotice: true
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `branchSwitcher` | boolean | true | 关闭后 ChatPage 顶部不渲染分支切换器 |
| `resumePicker` | boolean | true | 关闭后 `/resume` 多快照时回退到纯文本列表 |
| `progressBar` | boolean | true | 关闭后 TaskMonitorPanel 不显示进度条 |
| `tracePanel` | boolean | false | 开启后 `/trace view` 触发 TracePanel 组件渲染（默认关闭：需交互式 Ink 输入） |
| `disclosureLevel` | boolean | true | 关闭后系统消息不包裹渐进披露层 |
| `diffView` | boolean | true | 关闭后 `/diff` 命令回退到纯文本 diff |
| `configReloadNotice` | boolean | true | 关闭后配置热重载时不弹出顶部通知 |

### 2.5 phase48Integration（Task 5：Phase 48 模块接入确认）

```yaml
phase48Integration:
  # 引用系统（CiteResolver 在 sendUserMessage 前调用）
  citeEnabled: true
  # 外部生态导入（Claude Plugin / Codex Instructions 导入器）
  importEnabled: true
  # 宏系统（! 触发器 + Macro 执行）
  macrosEnabled: true
  # MCP 桥接（.mcp.json 加载 + 多协议支持）
  mcpBridgeEnabled: true
```

注：Phase 48 模块默认 `true`（已在 Phase 48 验证稳定性），可通过配置关闭。

### 2.6 phase49Integration（Task 6：Phase 49 模块接入确认）

```yaml
phase49Integration:
  # SkillFlow 引擎（5 种节点类型 + onFailure 处理）
  skillFlowEnabled: false
  # 双循环编排器（Inner ReAct + Outer 验证）
  dualLoopEnabled: false
  # Skill 质量门（三层检查 + 模型漂移检测）
  skillQualityGateEnabled: false
  # 上下文占用率可视化（三级阈值 + 分项 token 占用）
  contextUsagePanelEnabled: false
  # 评估集框架（Smoke/Regression 两套 + LLM-as-Judge）
  evaluationFrameworkEnabled: false
  # 意图路由四层漏斗（L0 正则 / L1 向量 / L2 LLM / SafeNet）
  routingFunnelEnabled: false
```

注：Phase 49 模块默认 `false`（架构性变更较大，需用户手动开启）。

## 3. 渐进接入原则

所有 Phase 50 接入模块遵循以下原则：

1. **默认 `enabled: false`**：除 Phase 48 模块（已在 Phase 48 验证）和 UI 组件（默认 true）外，所有接入模块默认关闭
2. **try/catch 降级**：每个接入点均有 try/catch 兜底，接入失败时降级到原行为而非崩溃
3. **配置开关**：在 `src/config/schema.ts` 有对应的 Zod schema 字段
4. **设置页面入口**：在 `SettingsPage.tsx` 有对应控件（Phase 50 Task 7 接入 UI 组件，其他模块的设置入口在后续 Phase 补全）
5. **代码接线点明确**：每个模块的接入点在 `docs/ARCHITECTURE.md` 第 6 节有详细说明

## 4. 配置示例

### 4.1 最小配置（所有 Phase 50 模块关闭）

```yaml
providers: []
goalIntegration:
  promptBuilderEnabled: false
  persistenceEnabled: false
  auditEnabled: false
  requirementChangeEnabled: false
orchestrationIntegration:
  strategyEnabled: false
  stateGraphEnabled: false
  branchOrchestrationEnabled: false
delegationIntegration:
  contextPackerEnabled: false
  delegationGateEnabled: false
  delegationEnforcerEnabled: false
  lifecycleEnabled: false
  scoreCardEnabled: false
```

### 4.2 全功能配置（所有 Phase 50 模块开启）

```yaml
providers: []
goalIntegration:
  promptBuilderEnabled: true
  persistenceEnabled: true
  auditEnabled: true
  requirementChangeEnabled: true
orchestrationIntegration:
  strategyEnabled: true
  stateGraphEnabled: true
  branchOrchestrationEnabled: true
delegationIntegration:
  contextPackerEnabled: true
  delegationGateEnabled: true
  delegationEnforcerEnabled: true
  lifecycleEnabled: true
  scoreCardEnabled: true
phase49Integration:
  skillFlowEnabled: true
  dualLoopEnabled: true
  skillQualityGateEnabled: true
  contextUsagePanelEnabled: true
  evaluationFrameworkEnabled: true
  routingFunnelEnabled: true
ui:
  components:
    tracePanel: true
```

## 5. 配置热重载

RouteDev 支持配置热重载：修改配置文件后无需重启，引擎会自动重新初始化。配置变更时：
- `ConfigReloadUI` 组件在顶部弹出通知（受 `ui.components.configReloadNotice` 开关控制）
- 受影响的模块会重新创建实例（如 `GoalAuditor`、`ContextPacker` 等）
- 对话历史和当前执行状态会保留
