# RouteDev 死代码审查报告

- **审查引擎**: DeepSeekV4Flash
- **审查时间**: 2026-07-07
- **审查范围**: `src/` 全量 + `desktop/` 全量
- **目标项目**: RouteDev (c:\Users\杨铭\Desktop\Agent\routedev)

---

## 目录

1. [Schema-Default 值不一致](#1-schema-default-值不一致)
2. [配置加载器逻辑分析](#2-配置加载器逻辑分析)
3. [AppDependencies 接口字段审查](#3-appdependencies-接口字段审查)
4. [Orphan 模块审查](#4-orphan-模块审查)
5. [Phase 59/62/66/67/69 清理状况](#5-phase-5962666769-清理状况)
6. [JSDoc 描述与实际代码一致性](#6-jsdoc-描述与实际代码一致性)
7. [汇总与建议](#7-汇总与建议)

---

## 1. Schema-Default 值不一致

### 严重程度: 🔴 高（8 处）

`src/config/schema.ts` 中 Zod schema 通过 `.default()` 声明的默认值与 `src/config/defaults.ts` 中 `DEFAULT_CONFIG` 对象的字段值不一致。

| # | 配置路径 | schema.ts 默认值 | defaults.ts 值 | schema 行号 | defaults 行号 |
|---|---------|-----------------|---------------|------------|--------------|
| 1 | `security.devModeAuth` | `false` | `true` | L280 | L76 |
| 2 | `closedLoopRouting.enabled` | `false` | `true` | L1968 | L660 |
| 3 | `stateExternalization.enabled` | `false` | `true` | L1973 | L687 |
| 4 | `skillRouting.enabled` | `false` | `true` | L1998 | L711 |
| 5 | `memorySystem.enabled` | `false` | `true` | L2033 | L749 |
| 6 | `phase52Integration.boundedRecovery.enabled` | `false` | `true` | L1551 | L575 |
| 7 | `phase53Integration.dagEngine.enabled` | `false` | `true` | L1712 | L641 |
| 8 | `phase53Integration.circuitBreaker.enabled` | `false` | `true` | L1728 | L648 |

> **额外发现**: `phase70Integration.autoCompactGuardian.enabled` 也存在同样模式——schema 默认 `false`（L2099），defaults.ts 为 `true`（L817）。

### 影响分析

见下文第 2 节。

---

## 2. 配置加载器逻辑分析

### 当前加载顺序（loader.ts L237-L290）

```
defaults.ts (DEFAULT_CONFIG)  ← 最低优先级
    → 全局配置 (.routedev.yaml)
        → 项目级配置 (.routedev.yaml)
            → Zod schema.safeParse()  ← 最终验证
```

### 关键发现

loader.ts L244: `let config = { ...DEFAULT_CONFIG }` — 以 defaults.ts 为基底。

随后 deepMerge 叠加上层配置，最后通过 `AppConfigSchema.safeParse(config)` 验证。Zod 的 `.default()` 仅在值为 `undefined` 时生效。

**由于 DEFAULT_CONFIG 已为所有上述字段显式赋值 `true`，Zod schema 的 `default(false)` 永远不会在运行时被应用。**

这意味着：
- **8 个 `schema.default(false)` 是死代码**——它们从未在运行时生效
- defaults.ts 是实际运行时默认值的真实来源
- schema.ts 中这些字段的 `.default()` 声明具有误导性
- **风险**: 如果某人今后从 defaults.ts 删除了某个字段而未同步更新 schema，系统会静默切换到 `false` 行为，造成隐蔽的配置变更

### 建议

方案 A（推荐）: 将 schema.ts 中这 8 个字段的 `.default(false)` 统一改为 `.default(true)`，与 defaults.ts 保持一致。然后评估是否要保留 defaults.ts 中的重复赋值（保留可提供明确的"工厂默认值"文档）。

方案 B: 删除 defaults.ts 中这些字段的赋值，让 schema 的 `.default()` 成为唯一默认来源。但需确认 YAML 配置文件中没有依赖 defaults.ts 值的字段。

---

## 3. AppDependencies 接口字段审查

### 严重程度: 🟢 低

经过 Phase 59 的全面清理，AppDependencies 接口（app-init.ts L192-L280）中的僵尸字段已被完整移除。剩余的每个字段在 `desktop/main/engine-bridge.ts` 或 `src/runtime/goal-runner.ts` 中有实际消费方。

字段消费追踪摘要:

| 字段 | 消费方 |
|------|--------|
| `agentLoop` | engine-bridge.sendChat, GoalRunner |
| `trace` | engine-bridge initialize/destroy/sendChat |
| `mcpManager` | engine-bridge MCP 操作 |
| `registry` | engine-bridge listMCPTools |
| `skillsRouter` | engine-bridge Skill 管理 |
| `prompts` | engine-bridge sendChat 渲染 systemPrompt |
| `contextManager` | engine-bridge sendChat 检查点/压缩 |
| `checkpointManager` | engine-bridge initialize/checkpoint 管理 |
| `audit` | engine-bridge sendChat trajectory 汇总 |
| `toolExecutor` | engine-bridge executeTool |
| `filesystemDiscovery` | engine-bridge Skill CRUD |
| `checkpointClient` | engine-bridge initialize |
| `visionAssistant` | engine-bridge sendChat 图片分析 |
| `blackboard` | GoalRunner |
| `unifiedReviewer` | GoalRunner |
| `goalAuditor` | GoalRunner |
| `completionGate` | GoalRunner |
| `hookRunner` | GoalRunner + app-init |

**结论**: AppDependencies 接口无僵尸字段，Phase 59 Task 2 清理完成度高。

---

## 4. Orphan 模块审查

### 严重程度: 🟢 低（外部导入文件未发现）

在搜索中发现的 "predicate-types.ts" 实际上不存在于文件系统中（搜索工具误报）。经逐一核对，`src/agent/` 下所有 .ts 文件至少被 `src/agent/` 内部的另一个文件引用，形成完整的内部调用链。

agent/ 内部模块引用关系（部分示例）:

| 源文件 | 同类内部引用方 | 外部引用方 |
|--------|--------------|-----------|
| `hooks.ts` | middleware.ts | app-init.ts, goal-runner.ts |
| `work-modes.ts` | compose-pipeline.ts, loop.ts | app-init.ts |
| `loop-config.ts` | loop.ts, work-modes.ts, dual-loop-orchestrator.ts | trace-collector.ts, adapter.ts, worker-executor.ts |
| `compose-pipeline.ts` | loop.ts, work-modes.ts | — (仅在 agent/ 内) |
| `branch-linkage.ts` | branch-operations.ts | app-init.ts |
| `parallel-experiment.ts` | loop.ts | app-init.ts |
| `state-migration.ts` | memory/state-migration.ts | goal-runner.ts |
| `plan-attestation.ts` | task-orchestrator.ts | goal-runner.ts |

**结论**: 未发现真正的 orphan 文件。`src/agent/` 模块内部通过内部引用形成完整的调用图，整体作为代理系统的一个大型内聚模块。部分模块（如 `compose-pipeline.ts`）仅在 agent 内部使用而未被外部直接引用，这是合理的模块封装而非死代码。

---

## 5. Phase 59/62/66/67/69 清理状况

### 严重程度: 🟢 低

经过全面的关键字扫描（Phase 59、Phase 62、Phase 66、Phase 67、Phase 69、ExecutionOrchestrator）：

- **Phase 59**: 完整清理。所有已删除模块都有明确的注释标记（app-init.ts L81/L125/L141/L146/L153/L159/L205/L211/L217/L224/L234/L238/L262/L267/L268/L274/L275/L279/L411/L510/L528/L539/L1424/L1482/L1504/L1511/L1686/L2086/L2144/L2267/L2271/L2289）。每个删除点都说明了原因（"僵尸字段，全 src/ + desktop/ 无消费方"）。

- **Phase 62/66/67/69**: 全部标记为"ExecutionOrchestrator 死代码清理"，相关实例化和接口字段已删除。

- **Phase 52/53**: 保留的模块有完整的 config 开关守护和 fail-open 逻辑。

**良好实践**: 代码中的 Phase 注释非常详尽，记录了每个删除决策的上下文。这大大降低了死代码残留的风险和后续维护的心智负担。

---

## 6. JSDoc 描述与实际代码一致性

### 严重程度: 🟡 中

对 `src/config/schema.ts` 中 `stateExternalization`、`memorySystem`、`closedLoopRouting`、`phase70Integration` 的 JSDoc 注释进行了抽查：

- JSDoc 描述的功能与实际实现基本匹配
- 未发现 JSDoc 描述存在而代码完全不存在的"文档幽灵"

**值得注意**: 由于 [Schema-Default 值不一致](#1-schema-default-值不一致) 问题，部分功能的开关行为与 JSDoc 字面意思不符。例如 `stateExternalization.enabled` 的 JSDoc 说"默认禁用"但运行时实际为 `true`。这属于默认值不一致的衍生问题，JSDoc 本身是准确的。

---

## 7. 汇总与建议

### 问题分类矩阵

| 编号 | 问题 | 严重程度 | 影响范围 | 修复难度 |
|------|------|---------|---------|---------|
| P1 | Schema-Default 值不一致（8处） | 🔴 高 | 配置行为歧义，schema 不代表真实默认值 | 低（统一值即可） |
| P2 | JSDoc 默认值描述歧义 | 🟡 中 | 文档可读性 | 低 |
| P3 | 部分 agent 内部模块自闭环引用 | 🟢 低 | 不影响运行 | 无需修复 |
| P4 | Phase 59+ 清理遗留的标记注释过多 | 🟢 低 | 代码噪音 | 低（可考虑归档到外部文档） |

### 主要建议

1. **统一 schema.ts 与 defaults.ts 的默认值**（P1）
   - 短期：将 8 处 `schema.default(false)` 改为 `.default(true)` 以匹配 defaults.ts
   - 长期：确定 schema 是否为配置参数的唯一真实来源。如果是，应从 defaults.ts 移除这些字段的重复声明

2. **清理 Phase 注释噪音**（P4，可选）
   - 考虑将 Phase 删除记录归档到 CHANGELOG 或外部文档，减少源文件中的历史债务注释
   - 如果保留，建议保持当前规范——当前注释质量已足够好

3. **配置文档与代码同步**
   - 建议在 CI 中添加 `schema.defaults()` 与 `defaults.ts` 的差异检测脚本
   - 或添加单元测试验证关键字段的默认值一致性

---

*本次审查基于 `c:\Users\杨铭\Desktop\Agent\routedev` 在 2026-07-07 的文件状态。*