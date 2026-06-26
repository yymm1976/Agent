# RouteDev 死代码审计报告（Phase 50）

> 本文档记录 Phase 50 死代码全量审计结果与清理决策。
> 审计范围：`src/` 全目录 + `tests/` 测试文件。
> 审计方法：6 路并行子代理扫描 + 人工复核。

## 1. 审计规模

| 级别 | 类型 | 项数 | 处理方式 |
|------|------|------|----------|
| HIGH | 完全死掉的整文件 | 11 源文件 + 7 barrel | 删除 |
| HIGH | 完全未调用的函数/方法 | 22 | 删除 22 个 + 修复 2 个 bug |
| MEDIUM | 仅测试使用的整文件 | 14 | 保留 + 接入生产代码（Phase 50 Task 1-7） |
| MEDIUM | 未渲染的 React 组件 | 7 | 保留 + 接入 UI（Phase 50 Task 7） |
| MEDIUM | Phase 48/49 新增模块 | ~20 | 保留 + 确认接入（Phase 50 Task 5/6） |
| LOW | 多余 export | 84 | 移除 export 关键字（Phase 50 Task 9） |
| **合计** | | **~184** | **40 删 + 2 修复 + 7 barrel 删 + 41 接入 + 84 export 清理** |

## 2. HIGH 级别清理详情

### 2.1 删除的 11 个源文件

| # | 文件 | 功能 | 删除原因 |
|---|------|------|----------|
| 1 | `src/agent/types.ts` | 通用 Agent 类型 | 已被其他模块重新定义，无任何 import 引用 |
| 2 | `src/router/reasoning-mode.ts` | 推理模式配置 | 无任何 import 引用 |
| 3 | `src/utils/stall-detector.ts` | 卡顿检测器 | 无任何 import 引用 |
| 4 | `src/utils/error-messages.ts` | 错误消息工具 | 已被 `utils/errors.ts` 取代 |
| 5 | `src/config/codegraph-manager.ts` | CodeGraph CLI 封装 | 无任何 import 引用 |
| 6 | `src/harness/tracing-executor.ts` | Tracing 执行器 | 无任何 import 引用 |
| 7 | `src/harness/experiment-runner.ts` | 实验运行器 | 无任何 import 引用 |
| 8 | `src/hooks/market-manager.ts` | Hook 市场管理器 | 无任何 import 引用 |
| 9 | `src/hooks/generator.ts` | Hook 生成器 | 无任何 import 引用 |
| 10 | `src/plugins/sdk.ts` | 插件 SDK | 无任何 import 引用 |
| 11 | `src/cli/wizard.tsx` | 首次运行配置向导 | 无任何 import 引用 |

### 2.2 删除的 7 个 barrel 文件

| # | 文件 | 删除原因 |
|---|------|----------|
| 1 | `src/cite/index.ts` | 无消费者 import 该 barrel |
| 2 | `src/import/index.ts` | 无消费者 import 该 barrel |
| 3 | `src/macros/index.ts` | 无消费者 import 该 barrel |
| 4 | `src/mcp/index.ts` | 无消费者 import 该 barrel |
| 5 | `src/skills/index.ts` | 无消费者 import 该 barrel |
| 6 | `src/agent/patterns/index.ts` | 无消费者 import 该 barrel |
| 7 | `src/evaluation/index.ts` | 无消费者 import 该 barrel |

### 2.3 删除的 8 个测试文件

| # | 文件 | 删除原因 |
|---|------|----------|
| 1 | `tests/cli/wizard.test.ts` | 测试已删除的 `wizard.tsx` |
| 2 | `tests/harness/tracing-executor.test.ts` | 测试已删除的 `tracing-executor.ts` |
| 3 | `tests/harness/experiment-runner.test.ts` | 测试已删除的 `experiment-runner.ts` |
| 4 | `tests/hooks/generator.test.ts` | 测试已删除的 `generator.ts` |
| 5 | `tests/utils/stall-detector.test.ts` | 测试已删除的 `stall-detector.ts` |
| 6 | `tests/utils/error-messages.test.ts` | 测试已删除的 `error-messages.ts` |
| 7 | `tests/plugins/sdk.test.ts` | 测试已删除的 `sdk.ts` |
| 8 | `tests/cli/notification-audit.test.ts` | 测试已删除的 `notification.ts` 中的 `setAuditLogger` |

### 2.4 修复的 2 个 bug

| # | 文件 | Bug 描述 | 修复方式 |
|---|------|----------|----------|
| 1 | `src/import/claude-plugin-importer.ts` | 调用 `bridge.convertFromClaudeConfig(...)` 但该方法不存在，导致分支永远不可达 | 改为 `bridge.importFromClaudeConfig(...)` |
| 2 | `src/skills/model-drift-detector.ts` | 入参类型为 `ParsedSkill[]` 但内部用 `as SkillMetadataWithDrift` 断言，类型不安全 | 入参改为 `ParsedSkillWithDrift[]`，移除断言 |

### 2.5 删除的 22 个完全未调用的函数/方法

| # | 文件/符号 | 决策 |
|---|-----------|------|
| 1 | `macros/builtin.ts getBuiltinMacro()` | 删除 |
| 2 | `skill-flow-engine.ts resetRuntimeState()` | 删除 |
| 3 | `skill-flow-checkpoint-store.ts getBasePath()` | 删除 |
| 4 | `evaluation-framework.ts getPassThreshold()` | 删除 |
| 5 | `persona-templates.ts getBuiltinPersona()` | 删除 |
| 6 | `quality-aggregator.ts resetGlobalQualityAggregator()` | 删除 |
| 7 | `requirements-clarifier.ts createRequirementsClarifier()` | 删除 |
| 8 | `memory/context-manager.ts compactIfNeeded()` | 删除 |
| 9-11 | `preference-manager.ts` 三个方法 | 删除 |
| 12 | `durable-executor.ts listRecoverable()` 同步版 | 删除 |
| 13-16 | `cache-optimizer.ts` 四个符号 | 删除 |
| 17-18 | `deterministic-rules.ts loadCustomRules/mergeRules` | 删除 |
| 19-20 | `repo-map.ts loadCache/analyzeImpact` | 删除 |
| 21 | `cli/notification.ts setAuditLogger()` | 删除 |
| 22-23 | `design-system.ts` 两个 | 删除 |

## 3. MEDIUM 级别接入详情

### 3.1 /goal 流程模块（4 项）

| 文件 | 功能 | 接入到 |
|------|------|--------|
| `goal-audit.ts` | 三层独立审计 | `goal-runner.ts` verify 阶段 |
| `goal-persistence.ts` | 目标持久化到 `.routedev/goals/` | `goal-runner.ts` executeGoalPlan |
| `goal-prompt-builder.ts` | 五段式 goal spec 构造 | `goal-runner.ts` handleGoalCommand |
| `requirement-change.ts` | 需求变更检测 + 影响分析 | `goal-runner.ts` analyzeRequirementChange |

### 3.2 多 Agent 编排模块（3 项）

| 文件 | 功能 | 接入到 |
|------|------|--------|
| `branch-orchestrator.ts` | 并行分支任务调度 | `orchestrator.ts` planBranches |
| `orchestrator-strategy.ts` | 按复杂度选择策略 | `orchestrator.ts` plan |
| `state-graph.ts` | 步骤级状态机 | `orchestrator.ts` execute |

### 3.3 子 Agent 委托体系（6 项）

| 文件 | 功能 | 接入到 |
|------|------|--------|
| `context-packer.ts` | 按角色权重打包上下文 | `spawn-agent.ts` wrapper 步骤 1 |
| `delegation-enforcer.ts` | 校验工具调用合规 | `spawn-agent.ts` wrapper 步骤 3 |
| `delegation-gate.ts` | 派发前检查资格 | `spawn-agent.ts` wrapper 步骤 2 |
| `delegation-contract.ts` | 委托契约管理 | 随 enforcer 接入自动激活（传递性死链解除） |
| `sub-agent-lifecycle.ts` | 生命周期 + 反滥用 | `spawn-agent.ts` wrapper 步骤 4 |
| `sub-agent-score-card.ts` | 评分卡收集 | `spawn-agent.ts` wrapper 步骤 5 |

### 3.4 React 组件（7 项）

| 组件 | 接入到 |
|------|--------|
| BranchSwitcher | `App.tsx` 顶部分支切换 |
| ResumePicker | `/resume` 命令多快照时触发 |
| ProgressBar | `TaskMonitorPanel` 任务进度 |
| TracePanel | `/trace view` 命令触发 |
| DisclosureLevel | `ChatView` 系统消息 >200 字符包裹 |
| DiffView | `/diff` 命令触发 |
| ConfigReloadUI | `App.tsx` 配置变更通知 |

### 3.5 branch-operations 去重评估

`src/agent/branch-operations.ts` 与 `BranchManager` 功能对比结论：
- **独特功能**：delete/insert/undo/redo/squash 操作（BranchManager 不支持）
- **决策**：保留，通过 `BranchManager.createOperations()` 工厂方法接入

## 4. LOW 级别 export 清理详情

Task 9 清理了 84 个多余 export，覆盖 46 个文件：

| 目录 | 文件数 | export 数 |
|------|--------|-----------|
| `src/agent/` | 26 | 38 |
| `src/agent/memory/` | 4 | 10 |
| `src/agent/multi/` | 5 | 9 |
| `src/agents/` | 6 | 12 |
| `src/skills/skill-flow-types.ts` | 1 | 11 |
| `src/router/` | 1 | 1 |
| `src/cli/` | 3 | 3 |

清理原则：仅同文件使用的 export 移除 export 关键字；跨文件使用的保留。测试文件的 import 也算跨文件使用，不可移除。

## 5. 清理验证

- **typecheck**：`tsc --noEmit` 通过
- **全量测试**：所有测试通过（Phase 50 新增 123 个测试 + Task 10 新增 12 个端到端测试）
- **build**：`tsup` 构建通过
- **build:electron**：`electron-vite build` 构建通过
- **无残留 broken import**：所有已删除文件的引用均已修复
