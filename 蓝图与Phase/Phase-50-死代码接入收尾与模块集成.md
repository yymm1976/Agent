# Phase 50 — 死代码接入收尾与模块集成

> **版本目标：** v3.9.1
> **前置依赖：** Phase 49（Skill 固化流水线与 Loop 工程化验证层）完成
> **后继依赖：** Phase 51（外部开源借鉴落地与配置化接入收尾）依赖本 Phase 的子 Agent 委托体系接入
> **新增测试要求：** ≥ 40 个
> **研究依据：** RouteDev 死代码审计报告（~184 项：HIGH 43 项完全未使用 / MEDIUM 41 项已开发待集成 / LOW ~100 项多余 export）；论文 *Harness Updating Is Not Harness Benefit*（arXiv 2605.30621）的启示——harness 的价值在于被激活和被遵循，未接入的模块等于零价值的 harness；RouteDev 源码现状确认（`src/agent/goal-audit.ts`、`src/agents/delegation-enforcer.ts`、`src/agent/multi/orchestrator-strategy.ts`、`desktop/renderer/src/components/` 等 41 项 MEDIUM 文件功能完整但无生产 import）
> **核心命题：** 之前的 Phase 反复出现"模块开发了但不接入生产代码"的问题——功能完整、测试通过，但从未被 import 到执行链路中，等于死代码。论文证明 harness 的价值不在于"存在"而在于"被激活和被遵循"——未接入的模块激活率 = 0%，遵循度 = 0%。Phase 50 的核心任务是把 41 项"已开发待集成"的资产接入生产代码，同时清理 HIGH 级别 43 项真死代码和 LOW 级别 ~100 项多余 export。这不仅是清理工作，更是"把散落的拼图拼回主图"的集成工程。每个接入模块都必须满足反写死原则：有配置开关、有设置页面入口、有明确的代码接线点。

---

## 项目现状审计

### 1. 死代码规模

| 级别 | 类型 | 项数 | 处理方式 |
|------|------|------|----------|
| HIGH | 完全死掉的整文件 | 11 | 删除 |
| HIGH | 完全未调用的函数/方法 | 25 | 22 删 + 3 修复 |
| HIGH | 无引用的 barrel 文件 | 7 | 删除 |
| MEDIUM | 仅测试使用的整文件 | 14 | 保留 + 接入生产 |
| MEDIUM | 未渲染的 React 组件 | 7 | 保留 + 接入 UI |
| MEDIUM | Phase 48/49 新增模块 | ~20 | 保留 + 确认接入 |
| LOW | 多余 export | ~100 | 移除 export 关键字 |
| **合计** | | **~184** | **40 删 + 3 修复 + 7 barrel 删 + 41 接入 + ~100 export 清理** |

### 2. MEDIUM 级别资产的接入归属

| 接入归属 | 文件 | 接入到 |
|----------|------|--------|
| /goal 流程 | goal-audit.ts、goal-persistence.ts、goal-prompt-builder.ts、requirement-change.ts | /goal 命令执行链路 |
| 多 Agent 编排 | branch-orchestrator.ts、orchestrator-strategy.ts、state-graph.ts | Orchestrator 执行链路 |
| 子 Agent 委托 | context-packer.ts、delegation-enforcer.ts、delegation-gate.ts、delegation-contract.ts、sub-agent-lifecycle.ts、sub-agent-score-card.ts | spawn_agent 执行链路 |
| 去重评估 | branch-operations.ts | 与 BranchManager 对比决策 |
| Phase 48 模块 | cite/import/macros/mcp 全部 | 对应功能入口 |
| Phase 49 模块 | SkillFlow/DualLoop 等全部 | 确认已接入 |
| React 组件 | 7 个组件 | ChatPage/SettingsPage UI |

### 3. 可行性总评

- **HIGH 清理（43 项）：** 零风险。完全无引用，删除不影响任何功能。
- **MEDIUM 接入（41 项）：** 中等风险。模块功能已实现且通过测试，但接入生产代码可能暴露集成问题（配置缺失、类型不匹配、事件流未对接）。需逐模块接入 + 集成测试。
- **LOW export 清理（~100 项）：** 零风险。仅移除 export 关键字，不影响内部使用。

---

## 核心设计原则

### 原则 1：接入优先于删除

Phase 50 的首要任务不是删死代码，而是接入活代码。41 项 MEDIUM 资产是之前 Phase 投入开发的成果，如果继续搁置等于浪费。删除 HIGH 死代码和清理 LOW export 是附带清理。

### 原则 2：反写死原则（延续 Phase 51）

每个接入模块都必须满足：
1. **配置开关**——在 `src/config/schema.ts` 有 `enabled` 字段，默认值符合渐进迁移策略
2. **设置页面入口**——在 `SettingsPage.tsx` 有对应控件，用户可切换开关
3. **代码接线点明确**——列出修改哪些现有文件、在哪个调用点插入 import 和调用

### 原则 3：渐进接入而非一次性全开

所有接入模块默认 `enabled: false`，用户在设置页面手动开启。这避免接入后突然改变全局行为，允许逐模块验证。

### 原则 4：论文启示——激活率优先

论文证明 harness 的价值在于被激活。接入时优先确保"模块被调用"（activation），再优化"模块被遵循"（adherence）。先接线让模块进入执行链路，再通过 Phase 51 的 SkillFlow 等机制提升遵循度。

---

## Task 1：/goal 流程接入（≥ 5 测试）

### 1.1 背景

Phase 44/46 开发了 4 个 /goal 相关模块，功能完整但从未接入 /goal 命令的执行链路：

| 文件 | 功能 | 当前状态 |
|------|------|----------|
| `src/agent/goal-audit.ts` | 多层目标审计（completion_gate + verifier_llm + reviewer_agent 三层仲裁） | 仅测试引用 |
| `src/agent/goal-persistence.ts` | 目标持久化到 `.routedev/goals/`，支持 resume | 仅测试引用 |
| `src/agent/goal-prompt-builder.ts` | 构造五段式 goal spec（goal/scope/constraints/doneWhen/risks） | 仅测试引用 |
| `src/agent/requirement-change.ts` | 需求变更分析（diff 生成、影响评估） | 仅测试引用 |

### 1.2 接入点

```typescript
// src/agent/goal-runner.ts（修改已有文件）

/**
 * /goal 执行链路接入
 *
 * 接入顺序：
 *   1. goal-prompt-builder → 构造 goal spec（入口）
 *   2. goal-persistence → 持久化 plan（plan 生成后）
 *   3. goal-audit → 多层审计（验证阶段）
 *   4. requirement-change → 需求变更检测（用户追加需求时）
 */
import { GoalPromptBuilder } from './goal-prompt-builder.js';
import { GoalPersistence } from './goal-persistence.js';
import { GoalAuditor } from './goal-audit.js';
import { RequirementChangeAnalyzer } from './requirement-change.js';

// 在 plan() 阶段接入 prompt builder
const goalSpec = GoalPromptBuilder.build(userInput);

// 在 plan 持久化后接入 persistence
await GoalPersistence.save(plan);

// 在 verify() 阶段接入 audit
const auditResult = await GoalAuditor.audit(plan, executionResult);

// 在用户追加需求时接入 requirement-change
if (userAppendedRequirement) {
  const changeAnalysis = RequirementChangeAnalyzer.analyze(originalPlan, newRequirement);
}
```

### 1.3 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 或 GoalConfigSchema 中增加
const GoalIntegrationSchema = z.object({
  /** 是否启用多层目标审计（默认 false，渐进接入） */
  auditEnabled: z.boolean().default(false),
  /** 是否启用目标持久化（默认 false） */
  persistenceEnabled: z.boolean().default(false),
  /** 是否启用五段式 goal spec 构造（默认 false） */
  promptBuilderEnabled: z.boolean().default(false),
  /** 是否启用需求变更分析（默认 false） */
  requirementChangeEnabled: z.boolean().default(false),
});
```

### 1.4 设置页面接入

在已有 `goal` tab 中增加"目标流程集成"子区域：
- 4 个 Switch：审计/持久化/五段式构造/需求变更分析
- 说明文字：解释每个模块的作用

### 1.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/goal-runner.ts` | 修改 | 4 个接入点：plan/verify/persist/requirement-change |
| `src/config/schema.ts` | 修改 | 增加 `GoalIntegrationSchema` |
| `desktop/renderer/src/components/settings/SettingsGoalTab.tsx` | 修改 | 增加 4 个 Switch 控件 |

### 1.6 测试要求

- auditEnabled=true 时 GoalAuditor 被调用且三层仲裁结果影响最终判定。
- persistenceEnabled=true 时 plan 持久化到 `.routedev/goals/`。
- promptBuilderEnabled=true 时 goal spec 为五段式格式。
- requirementChangeEnabled=true 时追加需求触发变更分析。
- 所有开关默认 false 时回退到原行为（向后兼容）。

---

## Task 2：多 Agent 编排模块接入（≥ 4 测试）

### 2.1 背景

Phase 早期开发了 3 个编排模块，功能完整但未接入 Orchestrator 执行链路：

| 文件 | 功能 | 当前状态 |
|------|------|----------|
| `src/agent/multi/branch-orchestrator.ts` | 基于实验管理器并行执行分支任务 | 仅测试引用 |
| `src/agent/multi/orchestrator-strategy.ts` | 按复杂度自动选择 sequential/parallel/adaptive | 仅测试引用 |
| `src/agent/multi/state-graph.ts` | 步骤级状态机管理 | 仅测试引用 |

### 2.2 接入点

```typescript
// src/agent/multi/orchestrator.ts（修改已有文件）

import { OrchestratorStrategy } from './orchestrator-strategy.js';
import { StateGraph } from './state-graph.js';
import { BranchOrchestrator } from './branch-orchestrator.js';

/**
 * 编排接入：
 *   1. OrchestratorStrategy → plan() 阶段选择编排策略
 *   2. StateGraph → execute() 阶段管理步骤状态
 *   3. BranchOrchestrator → 并行分支任务时调用
 */
```

### 2.3 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const OrchestrationIntegrationSchema = z.object({
  strategyEnabled: z.boolean().default(false),
  stateGraphEnabled: z.boolean().default(false),
  branchOrchestrationEnabled: z.boolean().default(false),
});
```

### 2.4 设置页面接入

在 `subagents` tab 中增加"编排集成"子区域：
- 3 个 Switch：策略选择器/状态图/分支编排

### 2.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/multi/orchestrator.ts` | 修改 | 3 个接入点 |
| `src/config/schema.ts` | 修改 | 增加 `OrchestrationIntegrationSchema` |
| `desktop/renderer/src/components/settings/SettingsSubagentsTab.tsx` | 修改 | 增加 3 个 Switch |

### 2.6 测试要求

- strategyEnabled=true 时按复杂度自动选择策略。
- stateGraphEnabled=true 时步骤状态被管理。
- branchOrchestrationEnabled=true 时并行分支任务被调度。
- 默认 false 时回退到原行为。

---

## Task 3：子 Agent 委托体系接入（≥ 6 测试）

### 3.1 背景

Phase 35 开发了 6 个子 Agent 委托模块，功能完整但未接入 spawn_agent 执行链路。Phase 51 Task 2/3 的委托约束体系依赖这些模块已接入：

| 文件 | 功能 | 当前状态 |
|------|------|----------|
| `src/agents/context-packer.ts` | 按角色权重收集代码符号构建上下文 | 仅测试引用 |
| `src/agents/delegation-enforcer.ts` | 校验子 Agent 工具调用符合委托契约 | 仅测试引用 |
| `src/agents/delegation-gate.ts` | 派发子 Agent 前检查资格 | 仅测试引用 |
| `src/agents/delegation-contract.ts` | 委托契约管理器（仅被 enforcer 引用） | 传递性死链 |
| `src/agents/sub-agent-lifecycle.ts` | 子 Agent 生命周期 + 反滥用检测 | 仅测试引用 |
| `src/agents/sub-agent-score-card.ts` | 子 Agent 评分卡收集器 | 仅测试引用 |

### 3.2 接入点

```typescript
// src/tools/builtin/spawn-agent.ts（修改已有文件）

import { ContextPacker } from '../../agents/context-packer.js';
import { DelegationGate } from '../../agents/delegation-gate.js';
import { DelegationEnforcer } from '../../agents/delegation-enforcer.js';
import { SubAgentLifecycle } from '../../agents/sub-agent-lifecycle.js';
import { SubAgentScoreCardCollector } from '../../agents/sub-agent-score-card.js';

/**
 * 委托体系接入：
 *   1. DelegationGate → spawn 前检查资格
 *   2. ContextPacker → 构建子 Agent 上下文
 *   3. DelegationEnforcer → 执行中校验工具调用合规
 *   4. SubAgentLifecycle → 生命周期管理 + 反滥用
 *   5. SubAgentScoreCardCollector → 执行后收集评分
 */
```

### 3.3 配置接入

```typescript
// src/config/schema.ts — 在 AgentConfigSchema 中增加
const DelegationIntegrationSchema = z.object({
  contextPackerEnabled: z.boolean().default(false),
  delegationGateEnabled: z.boolean().default(false),
  delegationEnforcerEnabled: z.boolean().default(false),
  lifecycleEnabled: z.boolean().default(false),
  scoreCardEnabled: z.boolean().default(false),
});
```

### 3.4 设置页面接入

在 `subagents` tab 中增加"委托体系集成"子区域：
- 5 个 Switch：上下文打包/委托门控/契约校验/生命周期/评分卡

### 3.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/tools/builtin/spawn-agent.ts` | 修改 | 5 个接入点 |
| `src/cli/app-init.ts` | 修改 | 创建实例并注入 |
| `src/config/schema.ts` | 修改 | 增加 `DelegationIntegrationSchema` |
| `desktop/renderer/src/components/settings/SettingsSubagentsTab.tsx` | 修改 | 增加 5 个 Switch |

### 3.6 测试要求

- contextPackerEnabled=true 时子 Agent 上下文按角色权重打包。
- delegationGateEnabled=true 时 spawn 前检查资格，不合格拒绝。
- delegationEnforcerEnabled=true 时子 Agent 越权工具调用被拦截。
- lifecycleEnabled=true 时反滥用检测生效。
- scoreCardEnabled=true 时执行后评分卡被收集。
- delegation-contract.ts 随 enforcer 接入自动解除传递性死链。

---

## Task 4：branch-operations.ts 去重评估（≥ 2 测试）

### 4.1 背景

`src/agent/branch-operations.ts` 提供会话树分支操作（delete/undo/redo/squash），与 `BranchManager` 功能可能重叠。需评估后决策：删除（完全重叠）或接入（有独特功能）。

### 4.2 评估流程

```typescript
// 评估步骤：
// 1. 对比 branch-operations.ts 和 BranchManager 的 API
// 2. 找出 branch-operations.ts 的独特功能（如有）
// 3. 决策：独特功能 → 接入 BranchManager；完全重叠 → 删除
```

### 4.3 配置接入

```typescript
// 如果保留接入：
const BranchOperationsSchema = z.object({
  enabled: z.boolean().default(false),
});
```

### 4.4 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/branch-operations.ts` | 评估后决策 | 删除或接入 BranchManager |
| `src/agent/branch.ts` | 可能修改 | 如接入，在 BranchManager 中调用 |

### 4.5 测试要求

- 评估文档记录对比结果。
- 如删除：确认 BranchManager 覆盖全部功能。
- 如接入：接入后功能可调用。

---

## Task 5：Phase 48 新增模块接入（≥ 5 测试）

### 5.1 背景

Phase 48 开发了 cite/import/macros/mcp 四个模块，均处于"已开发待集成"状态。需确认每个模块的入口已接入：

| 模块 | 入口 | 接入状态 |
|------|------|----------|
| cite（引用系统） | `CiteResolver` 在 sendUserMessage 前调用 | 待确认 |
| import（外部生态导入） | Claude Plugin / Codex Instructions 导入器 | 待确认 |
| macros（宏系统） | `!` 触发器 + Macro 执行 | 待确认 |
| mcp（MCP 桥接） | `.mcp.json` 加载 + 多协议支持 | 待确认 |

### 5.2 接入确认与补全

```typescript
// 逐模块确认接入：
// 1. cite: 确认 CiteResolver 在 ChatPage.sendUserMessage 前被调用
// 2. import: 确认导入器在设置页面有入口
// 3. macros: 确认 ! 触发器在 InputBox 中生效
// 4. mcp: 确认 .mcp.json 加载在 app-init 中执行
```

### 5.3 配置接入

```typescript
// src/config/schema.ts — 确认 Phase 48 配置已存在，补缺失的
const Phase48IntegrationSchema = z.object({
  citeEnabled: z.boolean().default(true),
  importEnabled: z.boolean().default(true),
  macrosEnabled: z.boolean().default(true),
  mcpBridgeEnabled: z.boolean().default(true),
});
```

### 5.4 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `desktop/renderer/src/pages/ChatPage.tsx` | 修改 | 确认 CiteResolver 接入 |
| `src/cli/app-init.ts` | 修改 | 确认 MCP 桥接接入 |
| `desktop/renderer/src/components/InputBox.tsx` | 修改 | 确认 `!` 触发器接入 |
| `desktop/renderer/src/pages/SettingsPage.tsx` | 修改 | 确认导入入口 |

### 5.5 测试要求

- cite 引用解析正确注入上下文。
- import 导入器从设置页面可触发。
- macros `!` 触发器弹出补全列表。
- mcp `.mcp.json` 加载成功。
- 所有模块可通过配置开关禁用。

---

## Task 6：Phase 49 新增模块接入确认（≥ 3 测试）

### 6.1 背景

Phase 49 新增了 SkillFlow 引擎、双循环编排器、Skill 质量门、上下文占用率可视化、评估集框架、意图路由增强等模块。需确认每个模块已接入生产代码：

| 模块 | 文件 | 接入状态 |
|------|------|----------|
| SkillFlow 引擎 | `src/skills/skill-flow-engine.ts` | 已落地，待确认接入 Skill 执行链路 |
| 双循环编排器 | `src/agent/dual-loop-orchestrator.ts` | 已落地，待确认接入 /goal 执行链路 |
| Skill 质量门 | `src/skills/skill-validator.ts` | 待确认接入 SkillGenerator |
| 上下文占用率 | `src/agent/context-usage-info.ts` | 待确认接入 ContextCompactor |
| 评估集框架 | `src/evaluation/evaluation-framework.ts` | 仅测试引用 |
| 意图路由增强 | `src/router/routing-funnel.ts` | 待确认接入 Router |

### 6.2 接入确认与补全

逐模块确认接入点，补缺失的接线。

### 6.3 配置接入

```typescript
// src/config/schema.ts — 确认 Phase 49 配置已存在
const Phase49IntegrationSchema = z.object({
  skillFlowEnabled: z.boolean().default(false),
  dualLoopEnabled: z.boolean().default(false),
  skillQualityGateEnabled: z.boolean().default(false),
  contextUsagePanelEnabled: z.boolean().default(false),
  evaluationFrameworkEnabled: z.boolean().default(false),
  routingFunnelEnabled: z.boolean().default(false),
});
```

### 6.4 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/skills/skill-executor.ts` | 修改 | 确认 SkillFlowEngine 接入 |
| `src/agent/goal-runner.ts` | 修改 | 确认 DualLoopOrchestrator 接入 |
| `src/skills/skill-generator.ts` | 修改 | 确认 SkillValidator 接入 |
| `src/agent/context-compaction.ts` | 修改 | 确认 ContextUsageInfo 接入 |
| `src/router/index.ts` | 修改 | 确认 RoutingFunnel 接入 |

### 6.5 测试要求

- SkillFlow 在 Skill 执行时被调用。
- DualLoop 在 /goal 执行时被调用。
- Skill 质量门在 Skill 生成时运行。
- 所有模块可通过配置开关禁用。

---

## Task 7：7 个 React 组件接入 UI（≥ 5 测试）

### 7.1 背景

7 个 React 组件已定义但从未渲染：

| 组件 | 文件 | 接入到 |
|------|------|--------|
| BranchSwitcher | `components/BranchSwitcher.tsx` | ChatPage 分支切换 UI |
| ResumePicker | `components/ResumePicker.tsx` | 执行恢复交互 |
| ProgressBar | `components/ProgressBar.tsx` | TaskMonitorPanel 任务进度 |
| TracePanel | `components/TracePanel.tsx` | TaskMonitorPanel Trace 可视化 |
| DisclosureLevel | `components/DisclosureLevel.tsx` | 消息列表渐进披露 |
| DiffView | `components/DiffView.tsx` | 文件编辑 diff 可视化 |
| ConfigReloadUI | `components/ConfigReloadUI.tsx` | 配置变更通知 |

### 7.2 接入点

```typescript
// 逐组件接入：
// 1. BranchSwitcher → ChatPage.tsx 顶部分支切换区域
// 2. ResumePicker → 恢复执行时弹出
// 3. ProgressBar → TaskMonitorPanel.tsx 任务进度区域
// 4. TracePanel → TaskMonitorPanel.tsx Trace 标签页
// 5. DisclosureLevel → ChatPage.tsx 消息列表容器
// 6. DiffView → 消息中文件编辑展示
// 7. ConfigReloadUI → 配置变更时顶部通知
```

### 7.3 配置接入

```typescript
// src/config/schema.ts — 在 UIConfigSchema 中增加
const UIComponentsSchema = z.object({
  branchSwitcher: z.boolean().default(true),
  resumePicker: z.boolean().default(true),
  progressBar: z.boolean().default(true),
  tracePanel: z.boolean().default(false),
  disclosureLevel: z.boolean().default(true),
  diffView: z.boolean().default(true),
  configReloadNotice: z.boolean().default(true),
});
```

### 7.4 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `desktop/renderer/src/pages/ChatPage.tsx` | 修改 | 接入 BranchSwitcher/DisclosureLevel/DiffView |
| `desktop/renderer/src/components/TaskMonitorPanel.tsx` | 修改 | 接入 ProgressBar/TracePanel |
| `desktop/renderer/src/components/Layout.tsx` | 修改 | 接入 ConfigReloadUI |
| `src/config/schema.ts` | 修改 | 增加 `UIComponentsSchema` |
| `desktop/renderer/src/pages/SettingsPage.tsx` | 修改 | 增加控件（在 `ui` tab） |

### 7.5 测试要求

- BranchSwitcher 在 ChatPage 顶部渲染且可切换分支。
- ProgressBar 在 TaskMonitorPanel 正确显示进度。
- DiffView 正确渲染文件编辑 diff。
- ConfigReloadUI 在配置变更时弹出通知。
- 各组件可通过配置开关禁用。

---

## Task 8：HIGH 级别死代码清理（≥ 5 测试）

### 8.1 删除 11 个完全死掉的整文件

| # | 文件 | 决策 |
|---|------|------|
| 1 | `src/agent/types.ts` | 删除 |
| 2 | `src/router/reasoning-mode.ts` | 删除 |
| 3 | `src/utils/stall-detector.ts` | 删除 |
| 4 | `src/utils/error-messages.ts` | 删除 |
| 5 | `src/config/codegraph-manager.ts` | 删除 |
| 6 | `src/harness/tracing-executor.ts` | 删除 |
| 7 | `src/harness/experiment-runner.ts` | 删除 |
| 8 | `src/hooks/market-manager.ts` | 删除 |
| 9 | `src/hooks/generator.ts` | 删除 |
| 10 | `src/plugins/sdk.ts` | 删除 |
| 11 | `src/cli/wizard.tsx` | 删除 |

### 8.2 删除 7 个无引用的 barrel 文件

| # | 文件 | 决策 |
|---|------|------|
| 37-43 | cite/index.ts、import/index.ts、macros/index.ts、mcp/index.ts、skills/index.ts、agent/patterns/index.ts、evaluation/index.ts | 全删 |

### 8.3 删除 22 个完全未调用的函数/方法

| # | 文件/符号 | 决策 |
|---|-----------|------|
| 12 | macros/builtin.ts getBuiltinMacro() | 删除 |
| 15 | skill-flow-engine.ts resetRuntimeState() | 删除 |
| 16 | skill-flow-checkpoint-store.ts getBasePath() | 删除 |
| 17 | evaluation-framework.ts getPassThreshold() | 删除 |
| 18 | persona-templates.ts getBuiltinPersona() | 删除 |
| 19 | quality-aggregator.ts resetGlobalQualityAggregator() | 删除 |
| 20 | requirements-clarifier.ts createRequirementsClarifier() | 删除 |
| 21 | memory/context-manager.ts compactIfNeeded() | 删除 |
| 22-24 | preference-manager.ts 三个方法 | 删除 |
| 25 | durable-executor.ts listRecoverable() 同步版 | 删除 |
| 26-29 | cache-optimizer.ts 四个符号 | 删除 |
| 30-31 | deterministic-rules.ts loadCustomRules/mergeRules | 删除 |
| 32-33 | repo-map.ts loadCache/analyzeImpact | 删除 |
| 34 | cli/notification.ts setAuditLogger() | 删除 |
| 35-36 | design-system.ts 两个 | 删除 |

### 8.4 修复 3 个有 bug 的函数

| # | 文件/符号 | 修复方式 |
|---|-----------|----------|
| 13 | claude-plugin-importer.ts convertFromClaudeConfig | 改为调用 importFromClaudeConfig |
| 14 | skill-metadata-extension.ts ParsedSkillWithDrift | 让 ModelDriftDetector 用此接口而非 as 断言 |
| — | （第 3 个修复在 Task 4 评估后确定） | — |

### 8.5 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| 11 个整文件 | 删除 | DeleteFile |
| 7 个 barrel 文件 | 删除 | DeleteFile |
| 22 个函数/方法 | 修改 | 移除函数定义 |
| 2 个 bug 修复 | 修改 | 修复调用/类型 |

### 8.6 测试要求

- 删除后 `rtk err gradlew build` 通过（无编译错误）。
- 删除后现有测试全部通过。
- 修复 convertFromClaudeConfig 后该分支可达。
- 修复 ParsedSkillWithDrift 后 ModelDriftDetector 用接口而非 as。
- 确认无残留 import 指向已删除文件。

---

## Task 9：LOW 级别多余 export 清理（≥ 2 测试）

### 9.1 背景

约 100 个 export 仅在同文件间接使用，移除 export 关键字降为内部类型/函数，零功能影响。主要分布：

| 目录 | 约 |
|------|-----|
| `src/agent/` | 60 |
| `src/agent/memory/` | 10 |
| `src/agent/multi/` | 10 |
| `src/agents/` | 10 |
| `src/skills/skill-flow-types.ts` | 11 |
| `src/router/` | 10 |
| `src/cli/` | 15 |

### 9.2 清理方式

逐文件检查每个 export：如果仅同文件使用，移除 export 关键字。跨文件使用的保留。

### 9.3 代码接入点

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agent/` 下约 15 个文件 | 修改 | 移除多余 export |
| `src/agent/memory/` 下文件 | 修改 | 移除多余 export |
| `src/agent/multi/` 下文件 | 修改 | 移除多余 export |
| `src/agents/` 下文件 | 修改 | 移除多余 export |
| `src/skills/skill-flow-types.ts` | 修改 | 移除 11 个子类型的 export |
| `src/router/` 下文件 | 修改 | 移除多余 export |
| `src/cli/` 下文件 | 修改 | 移除多余 export |

### 9.4 测试要求

- 清理后 `rtk err gradlew build` 通过。
- 清理后现有测试全部通过。
- 确认无跨文件 import 因 export 移除而失败。

---

## Task 10：集成测试与文档同步（≥ 3 测试）

### 10.1 集成测试

```typescript
// tests/integration/phase50-integration.test.ts

/**
 * Phase 50 集成测试
 * 验证各接入模块的端到端完整性
 */
// 1. /goal 流程端到端：prompt-builder → persist → audit → requirement-change
// 2. 子 Agent 委托端到端：gate → context-packer → enforcer → lifecycle → score-card
// 3. UI 组件端到端：BranchSwitcher/ProgressBar/DiffView 渲染正确
// 4. 死代码清理后构建通过
// 5. export 清理后构建通过
```

### 10.2 文档同步

- 更新 `docs/architecture.md`：标注所有接入模块的执行链路位置
- 更新 `docs/configuration.md`：增加 Phase 50 所有新增配置项
- 更新 `docs/dead-code-audit.md`：记录清理结果

### 10.3 测试要求

- /goal 流程端到端测试通过。
- 子 Agent 委托端到端测试通过。
- UI 组件端到端测试通过。

---

## 陷阱警告（#166-#170）

**166. 接入模块可能暴露隐藏的类型不匹配：** MEDIUM 级别模块虽然通过单元测试，但从未被生产代码 import。接入时可能发现类型签名与实际调用方不匹配（如参数名变了、返回类型扩展了）。每个接入点必须有 try/catch 兜底，接入失败时降级到原行为而非崩溃。

**167. 委托契约管理器的传递性死链可能误导接入：** `delegation-contract.ts` 仅被 `delegation-enforcer.ts` 引用，形成传递性死链。接入 enforcer 时 contract 自动解除死链——但如果 enforcer 接入失败，contract 仍然是死代码。必须先确认 enforcer 接入成功，再确认 contract 被间接激活。

**168. branch-operations.ts 与 BranchManager 的去重可能遗漏边缘功能：** Task 4 的去重评估不能只对比 API 列表，还要对比行为语义。branch-operations 的 squash 操作可能在 BranchManager 中有不同实现（如是否保留 squash 历史）。评估必须覆盖所有操作的输入输出行为，而非仅方法签名。

**169. React 组件接入可能破坏现有 UI 布局：** 7 个组件从未渲染，接入到 ChatPage/TaskMonitorPanel 可能导致布局变化（如 DisclosureLevel 改变消息列表容器结构）。每个组件接入后必须视觉验证，且可通过配置开关回退。

**170. export 清理可能误删跨文件使用的类型：** LOW 级别的 ~100 个 export 中，部分可能被测试文件跨文件 import。清理前必须用 `rtk grep` 确认每个 export 仅同文件使用。测试文件的 import 也算跨文件使用，不可移除。

---

## 思考引导总结

1. **接入优先于删除是本 Phase 的核心排序：** 41 项 MEDIUM 资产是之前 Phase 的开发成果，继续搁置等于浪费。Phase 50 先接入活代码，再清理死代码，最后清理多余 export。这个顺序确保"价值最大化"优先于"整洁度"。

2. **论文的 activation failure 概念解释了为何模块不接入等于零价值：** 论文证明 harness 的价值在于被激活。未接入的模块激活率 = 0%，无论功能多完整。Phase 50 的接入工作就是把激活率从 0% 提升到 100%。

3. **渐进接入（默认 false）避免全局行为突变：** 所有接入模块默认 `enabled: false`，用户手动开启。这避免接入后突然改变全局行为，允许逐模块验证。这是"渐进披露"原则在工程层面的体现。

4. **子 Agent 委托体系接入是 Phase 51 的前置依赖：** Phase 51 Task 2/3 的委托约束体系依赖 delegation-enforcer/gate/lifecycle 已接入。如果 Phase 50 不接入这些模块，Phase 51 的委托约束就没有执行载体。

5. **死代码清理的零风险前提是"完全无引用"：** HIGH 级别 43 项在 src/ 和 tests/ 中都无 import 引用，删除零风险。但删除后必须 `rtk err gradlew build` 验证，防止有动态引用（如字符串拼接的路径）被遗漏。

6. **export 清理是"代码卫生"而非功能变更：** LOW 级别 ~100 项只是移除 export 关键字，不改变任何功能。但这能减少公共 API 表面，降低未来误用的风险。

7. **7 个 React 组件接入让 UI 从"最小可用"升级为"完整体验"：** BranchSwitcher/DiffView/TracePanel 等组件已开发但从未渲染，用户从未见到这些功能。接入后用户能直观感知到分支切换、diff 可视化、Trace 时间线等能力的提升。

8. **论文启示——中模型 + 接入完整的 harness > 强模型 + 散乱 harness：** 论文证明中模型从 harness 获益最大。Phase 50 把散落的模块接入主图，就是让 RouteDev 的 harness 从"散乱"变为"完整"。这比升级模型更能提升效果。

9. **Phase 50 是 v3.9.1 的工程化收尾：** v3.9.x 的核心主题是"把开发的模块接入主图"。Phase 50 完成后，RouteDev 的所有已开发模块都在执行链路中，不再有"已开发待集成"的资产。

10. **Phase 50 → Phase 51 的依赖链清晰：** Phase 50 接入子 Agent 委托体系 → Phase 51 在此基础上增加委托约束和智能策略。Phase 50 接入 /goal 流程 → Phase 51 在此基础上增加 Result Schema 验证。Phase 50 是 Phase 51 的地基。
