# RouteDev 去留看板（SLIMDOWN_BOARD）

> **版本：** v1.4（2026-07-11）
> **维护阶段：** Phase 85
> **产品路线：** Core 最小化 + Capability Pack 按需加载（Phase 80–85）
> **配套文档：** `docs/CAPABILITY_LAYERS.md`（分层权威表，若存在）、`../蓝图与Phase/BLUEPRINT-CORE-CAPABILITY-PACK-v3.md`
>
> **用途：** 本看板是 RouteDev 瘦身整改的去留台账，按四区划分当前默认装配模块的去向。
> 每个条目记录：模块名 | 当前入口 | 预计操作 | 依赖项 | 风险等级。
> 审查提示词（功能完整度 / 死代码）应引用本看板作为分层与去留判定基线。
>
> **Phase 82 更新：** 6 个 Pack（goal-advanced / multi-agent / adversarial-review / browser-web / code-map / harness）已完成门控迁移，默认退出装配。其余 Pack（skillLifecycle / ccrCompression / vfsPlan / integrity / compose / trustGradient / kgAdvanced / acRouter）同样已在 Phase 81 完成门控迁移。已迁移条目标注「✅ 已迁移（Phase 81-82）」。
>
> **Phase 83 更新：** 三个 Extended Pack（goal-advanced / multi-agent / adversarial-review）完成接口审计与收口。GoalVerifier 与 UnifiedReviewer 确认归属 Core（对话场景即可用，不归属任何 Pack）。/goal 并行调度与冲突检测确认冻结（代码路径不可达，不删代码，保留类型）。三个 Pack 接口干净，不泄露 Core 内部实现。本 Phase 未为任何 Pack 增加新能力。
>
> **Phase 84 更新：** 会话分支（Session Tree）Core 能力落地。新增三个 Core 模块（C-68 SessionTree / C-69 SessionNode / C-70 session-commands），支持 /tree /fork /clone 命令，ChatPage 集成树视图 UI。旧线性消息可通过 fromLinear 导入为单分支树（向后兼容）。Checkpoint 与会话分支联动（fork 继承 checkpointId，回滚还原工作区）。本次为 Core 新增能力，不涉及 Pack 迁移或 Freeze 变更。
>
> **Phase 85 更新（v4.9.0 发布门禁）：** Phase 85 作为 v4.9.0 发布门禁，聚焦文档与四层架构 + Pi 融合设计对齐，不新增功能模块。主要变更：（1）`AGENTS.md` 正式化"Core 不做"清单（9 项）与防回潮规则（8 条），明确审查发现"功能缺失"时先查清单再决定实现；（2）`docs/CAPABILITY_LAYERS.md` 新增第 8 节补登记 Phase 83-85 分层变更（GoalVerifier/UnifiedReviewer 迁回 Core、Session Tree 三模块、/goal 并行调度补登记 Freeze F-04）；（3）本看板维护阶段更新至 Phase 85。四层分层与 Pack 门控状态无变化，所有 Extended/Standard Pack 维持默认关闭、Freeze 模块维持冻结边界。发布门禁检查项：默认工具集 ≤10、路由 2-3 级、Multi-Agent/Goal 高级编排/对抗审查默认关闭、浏览器/代码地图/Trace 默认关闭、Progressive Trust/Implicit Feedback/KG 高级算法冻结。

---

## 看板四区说明

| 区 | 含义 | 后续动作 |
|----|------|----------|
| **Core 膨胀点** | 默认装配中成本/复杂度异常的 Core 模块，需在原层内瘦身 | 原层内拆分 / 去耦合 / 减行 |
| **Extended Pack 候选** | 中等偏下维护、等待 Pack 机制落地后外置的模块 | Phase-81 落地 Pack 机制后迁出 |
| **Standard Pack 冷处理队列** | 已决定外置、等 Phase-82 迁移的标准能力包 | Phase-82 批量迁移 |
| **Freeze 清单** | 停止接线、不再扩张的实验/高级算法模块 | 冻结边界，禁止新增接线 |

**风险等级：** 低 / 中 / 高（高 = 触达 Core 主路径或被多处消费，迁移需回归测试）

---

## 一、Core 膨胀点

> 下列模块仍在 Core 默认装配路径内，但行数/耦合度异常，需在原层内瘦身（不外置、不冻结）。

| 模块名 | 当前入口 | 预计操作 | 依赖项 | 风险等级 |
|--------|----------|----------|--------|----------|
| goal-runner-scheduler | `src/runtime/goal-runner-scheduler.ts`（1060 行） | 继续拆分：将 DAG/Compose 执行路径与单 Agent 执行路径分离为独立函数模块；抽取 Phase 53 post-step 钩子块 | goal-runner-core、dag-engine、hookRunner、routingHistory | 高 |
| goal-runner-recovery | `src/runtime/goal-runner-recovery.ts`（709 行） | 抽取补救计划生成、DualLoop 恢复、resumeGoalPlan 为独立恢复策略模块 | goal-runner-core、dual-loop-orchestrator、classifier、modelRouter | 高 |
| goal-runner-core | `src/runtime/goal-runner-core.ts`（273 行） | 保留为类型/上下文聚合；确认无跨子模块的隐式共享状态 | goal-runner-confirm/scheduler/recovery | 中 |
| goal-runner-confirm | `src/runtime/goal-runner-confirm.ts`（292 行） | 体积可控，暂不动；待 scheduler 拆分后复核 | goal-runner-core | 低 |
| goal-runner（组合入口） | `src/runtime/goal-runner.ts`（14 行，re-export） | 维持 re-export 门面，保证对外 API 不变 | goal-runner-core | 低 |
| loop.ts | `src/agent/loop.ts`（784 行） | 已委托 LoopContextManager/MiddlewareRunner/MemoryIntegration；复核残余的内联上下文管理逻辑，进一步下沉 | context-manager、middleware-runner、memory-integration、virtual-fs | 高 |
| app-init-agent | `src/runtime/app-init-agent.ts`（1359 行，最大子装配） | 按 Phase（48/49/52/53/55/77）切片为独立接线函数；CodeMap/Hook/Plugin 动态 import 块抽离 | app-init 全部产出、plugins、hooks、code-map、skills | 高 |
| app-init-tools | `src/runtime/app-init-tools.ts`（473 行） | 工具注册按 Core profile / Pack profile 分流；动态 import 的可选工具迁出 | registry、permissionEngine、policyEngine | 中 |
| app-init-memory | `src/runtime/app-init-memory.ts`（391 行） | Phase 65/68/70 记忆子系统装配按 Pack 门控收敛 | contextManager、recallInjector、ccrCache、p70* | 中 |
| app-init（门面） | `src/runtime/app-init.ts`（381 行） | 维持 5 子模块编排门面；监控 InitContext 字段膨胀（当前 30+ 中间变量） | 5 个 app-init-* 子模块 | 中 |
| app-init-observability | `src/runtime/app-init-observability.ts`（195 行） | 体积可控，暂不动 | trace、audit、prompts、blackboard | 低 |
| app-init-router | `src/runtime/app-init-router.ts`（145 行） | 体积可控；ACRouter 装配随 Freeze 区一同旁路 | primaryClient、checkpointClient、compositionalRouter | 低 |

**Core 膨胀点合计：** 12 项，其中高风险 4 项（scheduler / recovery / loop / app-init-agent）。

---

## 二、Extended Pack 候选

> 下列模块维护频率中等偏下，待 Phase-81 Pack 机制落地后迁出为 Extended Pack（按需加载）。
> 迁出前保持现状，禁止新增默认接线。
> **Phase 81-82 进展：** Multi-Agent / Goal 高级编排 / 对抗审查 / Skill 生命周期 已迁出门控，默认退出装配。

| 模块名 | 当前入口 | 预计操作 | 依赖项 | 风险等级 |
|--------|----------|----------|--------|----------|
| Multi-Agent（spawn-agent） | `src/tools/builtin/spawn-agent.ts` | ✅ 已迁移（Phase 81-82）`packs.multiAgent.enabled` 门控注册 | sub-agent-lifecycle、context-packer、blackboard | 中 |
| Multi-Agent（sub-agent-lifecycle） | `src/agents/sub-agent-lifecycle.ts` | ✅ 已迁移（Phase 81-82）随 Multi-Agent Pack 迁出 | delegation-gate、activity-store | 中 |
| Multi-Agent（delegation-gate） | `src/agents/delegation-gate.ts` | ✅ 已迁移（Phase 81-82）随 Multi-Agent Pack 迁出 | delegation-policy、delegation-enforcer | 中 |
| Multi-Agent（context-packer） | `src/agents/context-packer.ts` | ✅ 已迁移（Phase 81-82）随 Multi-Agent Pack 迁出 | sub-agent-lifecycle | 低 |
| Goal 高级编排（goal-runner-scheduler） | `src/runtime/goal-runner-scheduler.ts` | ✅ 已迁移（Phase 81-82）`packs.goalAdvanced.enabled` 门控；Core 仅保留顺序执行 | dag-engine、compositional-router | 高 |
| Goal 高级编排（goal-runner-recovery） | `src/runtime/goal-runner-recovery.ts` | ✅ 已迁移（Phase 81-82）DualLoop/补救恢复门控；Core 仅保留基础重试 | dual-loop-orchestrator、classifier | 高 |
| Goal 高级编排（dag-engine） | `src/agent/workflow/dag-engine.ts` | ✅ 已迁移（Phase 81-82）迁入 Goal 高级编排 Pack | goal-runner-scheduler | 中 |
| Goal 高级编排（dual-loop-orchestrator） | `src/agent/dual-loop-orchestrator.ts` | ✅ 已迁移（Phase 81-82）迁入 Goal 高级编排 Pack；默认 ref 仍为 null | goal-runner-recovery | 中 |
| 对抗审查（adversarial） | `src/agent/cross-model-reviewer.ts` + `tests/agent/adversarial.test.ts` | ✅ 已迁移（Phase 81-82）`packs.adversarial.enabled` 门控 | unified-reviewer、reviewer-tier-evaluator | 中 |
| Skill 生命周期（skill-lifecycle） | `src/skills/skill-lifecycle.ts` | ✅ 已迁移（Phase 81-82）`packs.skillLifecycle.enabled` 门控；Core 仅保留发现+列表 | skillsRouter、market-manager | 中 |
| Hook 增强（hook-enhancement） | `src/hooks/hook-enhancement.ts` | 未迁移：不在 Phase 82 迁移范围，保留现状 | hooks/registry、hooks/adapter | 中 |
| Branch 关联（branch-linkage-manager） | `src/agent/branch-linkage.ts` | 未迁移：不在 Phase 82 迁移范围，保留现状 | branch.ts、goal-persistence、experiment-manager | 中 |
| Experiment（experiment-manager） | `src/harness/experiment-manager.ts` | ✅ 已迁移（Phase 81-82）随 `packs.harness.enabled` 门控（Standard Pack） | trace-collector、scorecard | 低 |
| Experiment（parallel-experiment） | `src/agent/parallel-experiment.ts` | ✅ 已迁移（Phase 81-82）随 harness Pack 迁出 | experiment-manager、branch-linkage | 低 |

**Extended Pack 候选合计：** 14 项，其中 12 项已迁移（Phase 81-82），2 项未迁移（Hook 增强 / Branch 关联）。覆盖 5 个子领域（Multi-Agent / Goal 高级编排 / 对抗审查 / Skill 生命周期 / Hook 增强 / Branch 关联 / Experiment）。

---

## 三、Standard Pack 冷处理队列

> 下列模块已决定外置为 Standard Pack，等 Phase-82 批量迁移。
> 迁移前保持代码可用但不再投入新功能开发；配置门控由 `*Integration.enabled` 过渡到 `packs.<id>.enabled`。
> **Phase 81-82 进展：** 全部 5 个 Pack（browser-web / code-map / ccr / vfs / plan）已完成门控迁移，默认退出装配。

| 模块名 | 当前入口 | 预计操作 | 依赖项 | 风险等级 |
|--------|----------|----------|--------|----------|
| 浏览器/Web（browser-tool） | `src/tools/builtin/browser.ts` | ✅ 已迁移（Phase 81-82）迁入 `browser-web` Pack；`packs.browserWeb.enabled` 门控 | 外部浏览器进程 | 低 |
| 浏览器/Web（web-search） | `src/tools/builtin/web-search.ts` | ✅ 已迁移（Phase 81-82）迁入 `browser-web` Pack | webSearchEnv 配置 | 低 |
| 浏览器/Web（web-fetch） | `src/tools/builtin/web-fetch.ts` | ✅ 已迁移（Phase 81-82）迁入 `browser-web` Pack | 无 | 低 |
| 代码地图（code-graph-query） | `src/tools/builtin/code-graph-query.ts` | ✅ 已迁移（Phase 81-82）迁入 `code-map` Pack；`packs.codeMap.enabled` 门控 | code-map/querier、code-map/database | 中 |
| 代码地图（repo-map） | `src/tools/builtin/repo-map.ts` + `src/tools/repo-map.ts` | ✅ 已迁移（Phase 81-82）迁入 `code-map` Pack | code-map/ranker | 中 |
| 代码地图（code-map-engine） | `src/code-map/*`（extractor/indexer/parser/querier/ranker） | ✅ 已迁移（Phase 81-82）迁入 `code-map` Pack；CodeMapContextMiddleware 随之迁出 | tree-sitter、git-integration | 中 |
| CCR 压缩（ccr-retrieve） | `src/tools/builtin/ccr-retrieve.ts` | ✅ 已迁移（Phase 81-82）迁入 `ccrCompression` Pack；`packs.ccrCompression.enabled` 门控 | ccr-cache | 中 |
| CCR 压缩（ccr-cache） | `src/agent/ccr-cache.ts` | ✅ 已迁移（Phase 81-82）迁入 `ccrCompression` Pack；app-init-memory 装配点加 Pack 门控 | context-manager | 中 |
| VFS（vfs-tool） | `src/agent/tools/vfs-tool.ts` | ✅ 已迁移（Phase 81-82）迁入 `vfsPlan` Pack；`packs.vfsPlan.enabled` 门控 | virtual-fs | 低 |
| VFS（virtual-fs） | `src/agent/context/virtual-fs.ts` | ✅ 已迁移（Phase 81-82）迁入 `vfsPlan` Pack；loop.ts 构造函数改为条件装配 | loop.ts | 中 |
| Plan 工具（plan-get/set/update/add/remove） | `src/agent/tools/plan-tool.ts` | ✅ 已迁移（Phase 81-82）迁入 `vfsPlan` Pack；plan-state 由 Core 保留（loop 依赖） | plan-state | 中 |

**Standard Pack 冷处理队列合计：** 11 项，全部已迁移（Phase 81-82），覆盖 5 个 Pack（browser-web / code-map / ccr / vfs / plan）。

---

## 四、Freeze 清单

> 下列模块停止接线、不再扩张。源码与测试保留，但生产默认不装配、不新增入口、不新增配置消费点。
> 已接线的默认路径在 Phase 79 已旁路或将在 Phase 83/84 继续旁路。

| 模块名 | 当前入口 | 预计操作 | 依赖项 | 风险等级 |
|--------|----------|----------|--------|----------|
| Progressive Trust（TrustGradient 动态升级） | `src/tools/trust-gradient.ts` | Phase 79 已旁路默认动态升级；冻结，禁止重新接入默认权限路径 | permission-engine、context-compaction | 中 |
| KG 高级算法（knowledge-graph） | `src/agent/memory/graph*.ts` + `src/memory/unified-memory.ts` | 冻结；生产默认不装配，仅保留测试可达 | context-manager、recall-injector | 中 |
| KG 高级算法（provenance-graph） | `src/memory/provenance-graph.ts` | 冻结；`phase68Integration.provenanceGraph.enabled` 维持 false | goal-runner-core、app-init-memory | 中 |
| KG 高级算法（kan-obstacle-checker） | `src/skills/kan-obstacle-checker.ts` | 冻结；不新增入口 | skillsRouter | 低 |
| ACRouter（routing-orchestrator） | `src/router/orchestrator.ts` | 冻结；`routingOrchestrator` deps 字段保留但不新增消费 | routing-memory、execution-verifier | 中 |
| ACRouter（routing-memory） | `src/router/routing-memory.ts` | 冻结；维持现有可选装配 | routing-orchestrator | 低 |
| ACRouter（routing-regret-tracker） | `src/router/regret-tracker.ts` | 冻结；不新增回调接线 | routing-orchestrator | 低 |
| /goal 并行调度与冲突检测 | `src/agent/multi/orchestrator.ts`（并行部分） | Phase 83 确认冻结；代码路径不可达，不删代码，保留类型（对齐 CAPABILITY_LAYERS F-04） | orchestrationIntegration | 低 |

**Freeze 清单合计：** 8 项，覆盖 4 个子领域（Progressive Trust / KG 高级算法 / ACRouter / 并行调度与冲突检测）。

---

## 汇总

| 区 | 条目数 | 已迁移 | 高风险 | 主导阶段 |
|----|--------|--------|--------|----------|
| Core 膨胀点 | 12 | — | 4 | Phase 80–81（原层内瘦身） |
| Extended Pack 候选 | 14 | 12 | 2 | Phase 81-82（已迁出 12 项） |
| Standard Pack 冷处理队列 | 11 | 11 | 0 | Phase 81-82（全部迁出） |
| Freeze 清单 | 8 | — | 0 | Phase 83（边界冻结收尾，新增并行/冲突检测） |
| **合计** | **45** | **23** | **6** | — |

---

## 维护约定

1. **新增条目**：任何模块迁层/瘦身/冻结前，先在本看板登记条目（含五要素）。
2. **状态流转**：Core 膨胀点 →（瘦身完成）→ 移出看板；Extended/Standard Pack 候选 →（迁出完成）→ 移出看板并更新 `CAPABILITY_LAYERS.md`；Freeze →（确认退役）→ 移入 `DEAD_CODE_AUDIT.md`。
3. **审查挂钩**：功能完整度审查与死代码审查必须对照本看板判定分层，不得将 Extended/Standard Pack 候选与 Freeze 项误报为死代码或 Missing。
4. **禁止扩张**：Freeze 区模块禁止新增默认接线、新增配置消费点、新增 IPC 入口。

---

*本看板由 Phase 80 Task 3 创建，Phase 82 Task 5 更新迁移状态，Phase 83 完成 Extended Pack 收口与冻结清单补登记，Phase 84 记录会话分支 Core 新增能力，Phase 85 完成 v4.9.0 发布门禁文档对齐与"Core 不做"清单正式化，随整改进度持续更新。*
