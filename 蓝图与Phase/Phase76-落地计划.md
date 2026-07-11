# Phase 76 落地计划：论文借鉴点深度分析

## 概述

本文档基于 `报告/论文借鉴报告-Phase76.md` 提出的 6 个借鉴点，对照 RouteDev 项目（Phase 75 收尾）的实际代码实现，逐点做生产落地可行性分析，并给出 Phase 76 的具体实施范围与任务拆解。

### 分析方法

对每个借鉴点，分析前已实际阅读以下关键代码文件，确保结论有代码位置支撑而非泛泛而谈：

| 文件 | 关键发现 |
|------|----------|
| `src/harness/trace-collector.ts` | 被动记录 span 流落盘到 `.routedev/traces/{date}/{sessionId}.trace.jsonl`；`summarizeTrajectory()` 输出 token/retry/success 指标但只返回数据不回流 |
| `src/router/regret-tracker.ts` | 全是只读指标计算（cumulativeRegret / movingAverageRegret / regretByTier / neighborHitRate），无任何回调或回流机制 |
| `src/agent/memory/graph.ts` | `validUntil` / `supersededBy` / `unusedCount` 字段已存在；`improve()` / `forget()` / `supersedeNode()` / `archiveStaleNodes()` 方法已实现 |
| `src/agent/memory/recall-injector.ts` | 简单召回+格式化，threshold=0.7，maxMemories=5，无合成/蒸馏 |
| `src/agent/memory/context-manager.ts` | `compressEnhanced()` 两轮压缩（offload 大输出 + 摘要老消息），按 token 量触发，不区分信息价值 |
| `src/harness/experiment-manager.ts` | `Experiment` 接口无 knowledge/learnings 字段，`runInExperiment` 后只更新 runCount/tokenUsage，无知识沉淀 |
| `src/prompts/manager.ts` | 三级优先级模板（项目覆盖/用户自定义/内置），纯人工维护，无数据驱动优化 |
| `src/agent/loop-memory.ts` | 失败记录持久化到 `.routedev/loop-memory/<goal-id>.md`，归档到 `archived/`，最多保留 5 次失败 |

### 关键代码验证（grep 结果）

- **`improve()` 在 src 中没有任何外部调用**——只在 `graph.ts` 内部定义，证实"接口已就绪但缺触发器"
- **`archiveStaleNodes()` 在 src 中没有任何外部调用**——同上
- **`forget()` 只在 `src/memory/unified-memory.ts:213` 一处被调用**（删除单个 nodeId 场景），没有批量遗忘触发器
- **`supersedeNode()` 只在 `graph.ts` 内部被 `improve()` 和 `clusterSimilarNodes()` 调用**
- **项目中没有任何 `powerMonitor` / `idle-time` / `setInterval` 触发器**（grep `powerMonitor|idle-time|setInterval.*60000|setInterval.*3600` 无匹配）——证实 Dreaming 需从零添加触发器

### 推荐结论速览

- **Phase 76 建议纳入**：P0 #1（Harness 闭环回流骨架）+ P0 #2（Memory Dreaming 触发器与最小合成）+ P1 #4（ICF 干扰剔除）
- **建议推迟**：P1 #3（APO，依赖 P0 #1 数据基础，Phase 80）+ P2 #6（AgentX 知识资产，依赖 P0 #1 骨架，Phase 78-79）
- **不建议实施**：P2 #5（Submerged Knowledge 探测——论文报告"不适用"章节已明确判定，RouteDev 的循环验证架构不依赖单次解码 Hits@k）

---

## 总览表

| # | 借鉴点 | 可行性 | 难度 | ROI | 建议 Phase | 状态 |
|---|--------|--------|------|-----|-----------|------|
| 1 | Harness 层闭环回流 | 高（数据已齐，缺口在回流管道） | 中 | **高** | 76 | 建议实施（骨架） |
| 2 | 跨会话记忆合成（Dreaming） | 高（graph.ts 接口已就绪，缺触发器） | 中 | **高** | 76（触发器+最小合成）+ 77（完整合成） | 建议实施（分两期） |
| 3 | APO 自动 Prompt 优化 | 中（依赖 P0 #1 数据 + experiment-manager A/B 集成） | 中高 | 中高 | 80 | 推迟（依赖 P0 #1） |
| 4 | ICF 上下文遗忘管理 | 高（信号源都已存在，接入点清晰） | 中 | 中 | 76 | 建议实施 |
| 5 | Submerged Knowledge 探测 | 低（RouteDev 循环验证架构不依赖单次解码） | 中高 | **低** | — | **不建议实施** |
| 6 | AgentX 结构化知识资产 | 中（依赖 P0 #1 回流骨架） | 中 | 中 | 78-79 | 推迟（依赖 P0 #1） |

---

## 详细分析

### P0 #1：Harness 层闭环回流

#### 落地可行性分析

**技术可行性：高**

RouteDev 现有架构完全能支撑，所有数据源已就绪：

- **数据源 1（trace）**：`src/harness/trace-collector.ts:498` 的 `listSessions()` 和 `:517` 的 `readSessionRecords(sessionId)` 可读取历史 trace；`summarizeTrajectory()`（:398）已输出 `totalTokens` / `toolCallCount` / `retryCount` / `firstAttemptSuccessRate` / `success` / `terminationReason` 等指标。数据落盘格式为 `.routedev/traces/{date}/{sessionId}.trace.jsonl`，结构化可解析。
- **数据源 2（regret）**：`src/router/regret-tracker.ts:26` 的 `computeCumulativeRegret()`、`:52` 的 `computeMovingAverageRegret()`、`:74` 的 `getRegretByTier()` 已输出按 tier 分桶的遗憾指标。数据源是 `RoutingHistory.getRecords()`，已持久化。
- **数据源 3（loop-memory）**：`src/agent/loop-memory.ts` 的失败记录归档到 `.routedev/loop-memory/archived/`，是跨会话失败模式的现成输入。
- **数据回流目标**：`src/prompts/manager.ts` 的 `PromptTemplateManager` 已支持三级优先级（项目覆盖/用户自定义/内置），回流建议可写入 `{AppData}/prompts/{id}.md`（用户级）或 `{project}/.routedev/prompts/{id}.md`（项目级），无需改架构。
- **审批机制参照**：`src/skills/skill-lifecycle.ts` 的 Refinement 阶段已有"基于评估结果优化 Skill 定义需用户审批"的语义，可复用同样的安全约束。

**缺口**：trace 和 regret 数据没有跨会话回流到 harness 配置。`regret-tracker.ts` 全是只读方法（grep 验证：无任何 setter 或 callback）；`trace-collector.ts` 的 `summarizeTrajectory()` 返回 `TrajectorySummary` 对象但无消费者。

**改动范围**：
- 新增 `src/harness/harness-evolution.ts`（核心回流引擎，约 400-500 行）
- 新增 `src/harness/suggestion-store.ts`（建议持久化，约 150 行）
- 修改 `src/runtime/app-init.ts`（注册定时触发器，约 30 行）
- 修改 `desktop/main/index.ts` 或新增 IPC 通道（审批 UI 桥接，约 80 行）
- 不改任何现有数据收集器（trace-collector / regret-tracker / loop-memory 保持只读）

**成本分析**：
- **难度：中**（数据已齐，难点在"建议生成"的 prompt 设计和审批 UI）
- **工作量**：约 700-800 行新增代码 + 200 行测试
- **预估耗时**：3-4 个开发日

**风险分析**：
- **建议质量风险**：LLM 生成的 prompt 修订建议可能误导用户。**缓解**：建议不自动应用，写入 `.routedev/harness-suggestions.jsonl` 由用户审批（与 skill-lifecycle.ts 的 Refinement 审批一致）
- **数据膨胀风险**：trace 文件随时间增长，`listSessions()` 默认 limit=20。**缓解**：回流引擎只读最近 N 天的 trace，设置 maxSessions 扫描上限
- **向后兼容风险**：低——不改任何现有数据收集器，纯新增模块
- **对现有功能影响**：极低——回流是离线异步过程，不阻塞 ReAct 循环

**前置条件**：
- 无硬前置条件。trace-collector、regret-tracker、loop-memory 都已独立运行。
- 软前置：建议先完成 `src/runtime/app-init.ts` 的定时器基础设施（Dreaming 也会复用）。

#### 效益分析

**直接效益**：
- **解决痛点**：trace 和 regret 数据"收集了但不回流"——这是 RouteDev 在"路由层"和"会话内"已闭环后，"harness 层"缺失的最后一环（对应 LangChain Loop 4 Hill Climbing）
- **量化预期**：
  - 重复失败模式识别：从 `loop-memory/archived/` 聚类失败原因，预计可识别 60-70% 的重复失败模式（loop-memory.ts 已有 `MAX_KEPT_FAILURES=5` 的截断，归档目录是未挖掘的金矿）
  - prompt 修订建议：基于失败 trace 让 LLM 批评当前 system prompt（APO 思路），预计 30-40% 的建议具有可执行性
  - regret 高的 tier 路由调整：`getRegretByTier()` 已按 simple/medium/complex/reasoning 分桶，可针对性建议"complex tier 考虑换模型"

**间接效益**：
- 为 P1 #3（APO Prompt 优化）提供数据基础——APO 需要"一批失败 trace"作为 minibatch，回流引擎正好产出这个
- 为 P2 #6（AgentX 结构化知识资产）提供骨架——知识资产的本质就是"回流的沉淀"
- 提升 `loop-memory/archived/` 的价值——目前归档即"冷数据"，回流后变为"学习语料"

**ROI 评估：高**
- 成本：中（700-800 行，3-4 日）
- 效益：高（这是 RouteDev 从"会学习路由"升级到"会学习整个 harness"的关键一跃，直接对应 LangChain 第 4 层和 AgentX 的核心价值）
- 比值：高 ROI

#### 落地方案

**Phase：76（骨架）**

Phase 76 只做闭环回流的"骨架"——数据读取 + 建议生成 + 审批持久化，不做 A/B 测试和 bandit 选择（留给 Phase 80 的 APO）。

**任务拆解**：

- **76-1: 设计并实现 `HarnessSuggestion` 数据模型与 `suggestion-store.ts`**
  - 定义 `HarnessSuggestion` 接口：`{ id, type: 'prompt'|'tool'|'grader', targetId, currentContent, suggestedContent, rationale, evidence: { traceIds, regretTiers, failurePatterns }, status: 'pending'|'approved'|'rejected'|'applied', createdAt, decidedAt? }`
  - 实现 `SuggestionStore`：持久化到 `.routedev/harness-suggestions.jsonl`（append-only，与 progress-ledger 一致）
  - 提供 `list(status?)` / `add(suggestion)` / `updateStatus(id, status)` 方法
  - 工作量：约 150 行

- **76-2: 实现 `harness-evolution.ts` 核心回流引擎**
  - `collectFailures()`：扫描 `.routedev/loop-memory/archived/*.md`，提取失败原因（loop-memory.ts 的 `LoopFailure` 结构已知：iteration/reason/missingItems/gateFailures/reviewIssues）
  - `clusterFailures()`：对失败原因做简单聚类（关键词 + 频次，不依赖 LLM）——产出"重复失败模式"
  - `collectRegretSignals()`：调用 `regret-tracker.getRegretByTier()`，识别 regret 高于阈值的 tier
  - `collectTracePatterns()`：读取最近 N 个 trace session，统计 `summarizeTrajectory()` 的 `retryCount` 高的 session
  - `generateSuggestions()`：把三类信号打包为 prompt，让 LLM 输出结构化建议（JSON 格式，与 `HarnessSuggestion` 对齐）——这一步复用 `PromptTemplateManager`，新增 `harness.evolution` 模板
  - `runCycle()`：编排上述步骤，输出建议列表写入 `SuggestionStore`
  - 工作量：约 400-500 行

- **76-3: 在 `app-init.ts` 注册定时触发器**
  - 复用 Electron 的 `powerMonitor`（Dreaming 也会用）：app 启动后 5 分钟首次运行，之后每 4 小时运行一次（避开用户活跃时段的兜底）
  - 触发器调用 `harness-evolution.runCycle()`，fail-open（任何错误只记日志，不阻塞主进程）
  - 工作量：约 30 行

- **76-4: IPC 通道 + 审批 UI 桥接**
  - 新增 IPC：`harness:list-suggestions` / `harness:decide-suggestion` / `harness:apply-suggestion`
  - `apply-suggestion` 时根据 `type` 分发：`prompt` → 写入 `{AppData}/prompts/{targetId}.md`；`tool` → 暂存待人工编辑；`grader` → 暂存待人工编辑
  - **关键安全约束**：`apply` 不直接覆盖现有模板，先备份原模板到 `.routedev/prompts-backup/{id}.{timestamp}.md`
  - 工作量：约 80 行

- **76-5: 测试**
  - `harness-evolution.test.ts`：mock trace/regret/loop-memory 数据，验证聚类和建议生成
  - `suggestion-store.test.ts`：验证持久化和状态流转
  - 工作量：约 200 行测试

**验证标准**：
1. `pnpm test` 全绿，新增测试覆盖 `HarnessSuggestion` 生命周期和 `runCycle()` 主流程
2. `pnpm typecheck` 通过
3. 手动验证：构造 3 个失败 trace + 2 个高 regret tier，运行 `runCycle()`，`harness-suggestions.jsonl` 中出现至少 1 条 `pending` 建议
4. 手动验证：通过 IPC 审批建议后，`{AppData}/prompts/{id}.md` 文件出现且原模板已备份

**回滚方案**：
- **代码级回滚**：`harness-evolution.ts` 和 `suggestion-store.ts` 是纯新增模块，删除即回滚；`app-init.ts` 的定时器注册是 30 行，可独立 revert
- **数据级回滚**：`harness-suggestions.jsonl` 是 append-only，可清空文件回滚；已 apply 的建议可通过 `prompts-backup/` 恢复原模板
- **运行时回滚**：定时器触发器加 `enabled` 配置开关（`config.harness.evolutionEnabled`，默认 true），可在设置面板关闭

---

### P0 #2：跨会话记忆合成（Memory Dreaming）

#### 落地可行性分析

**技术可行性：高**

graph.ts 的基础设施已完整就绪，证实论文报告"接口已预留但缺触发器"的判断：

- **`improve()` 方法（graph.ts:679）已实现**：支持 `useful` / `partially_useful` / `incorrect` / `unused` 四种反馈，能更新 `validatedCount`、刷新 `updatedAt`、标记 `deprecated`、创建新节点并 `supersedeNode` 关联。**但在 src 中没有任何外部调用**（grep 验证）。
- **`forget()` 方法（graph.ts:765）已实现**：支持按 `nodeIds` 或 `criteria`（`unusedFor` / `staleFor` / `type`）批量遗忘，有入边保护（`hasActiveInboundEdge`）。**只在 `unified-memory.ts:213` 一处被调用**（删除单个 nodeId），没有批量遗忘触发器。
- **`archiveStaleNodes()` 方法（graph.ts:648）已实现**：超过指定天数未更新的节点降级为 deprecated。**在 src 中没有任何外部调用**。
- **`supersededBy` / `validUntil` / `unusedCount` 字段（graph.ts:35-39）已存在**，但只有 `clusterSimilarNodes()` 内部会设置（语义合并场景），没有"时效性"触发器设置 `validUntil`。
- **`recall-injector.ts`** 只做召回+格式化（threshold=0.7，maxMemories=5），无合成逻辑。

**缺口**：
1. **没有触发器**：项目中无 `powerMonitor` / `idle-time` / `setInterval`（grep 验证），Dreaming 进程无处启动
2. **没有合成逻辑**：`recall-injector.ts` 直接返回 `GraphNode.content`，无跨会话事实合成、无偏好提取、无时效性扫描
3. **没有跨会话输入聚合**：`loop-memory/archived/` + `progress-ledger` + `trace` 三个数据源没有被聚合读取

**改动范围**：
- 新增 `src/runtime/memory-dreamer.ts`（Dreaming 主进程，约 350-400 行）
- 修改 `src/runtime/app-init.ts`（注册空闲触发器，约 40 行——与 76-3 共享定时器基础设施）
- 修改 `src/agent/memory/recall-injector.ts`（可选：合成后注入，约 30 行）
- 不改 `graph.ts`（复用现有 `improve` / `forget` / `archiveStaleNodes` / `supersedeNode` 接口）

**成本分析**：
- **难度：中**（graph.ts 已有基础设施，难点在"何时触发"和"合成 prompt 设计"）
- **工作量**：约 450-500 行新增代码 + 150 行测试
- **预估耗时**：3 个开发日

**风险分析**：
- **空闲检测误判风险**：`powerMonitor` 的 `idle` 事件在 Electron 中可能因系统休眠状态不准确。**缓解**：结合 `idle-state` 事件 + 最小空闲时长阈值（如 10 分钟）双判断
- **合成质量风险**：LLM 合成的"偏好/事实"可能错误。**缓解**：合成结果写入 graph.ts 节点时 `validatedCount=1`（低置信度），经 `improve(useful)` 多次确认后才会在 `recall()` 中排序靠前（PPR 权重 0.6 + 置信度权重 0.4）
- **资源占用风险**：Dreaming 调用 LLM 消耗 token。**缓解**：设置单次 Dreaming 预算上限（如 10K tokens），超限中止
- **对现有功能影响**：低——Dreaming 是异步离线过程，不阻塞 ReAct 循环；graph.ts 的接口都是线程安全的（纯内存操作）

**前置条件**：
- 软前置：P0 #1 的定时器基础设施（76-3）可复用——建议 P0 #1 和 P0 #2 共用 `app-init.ts` 的触发器注册逻辑
- 无硬前置条件

#### 效益分析

**直接效益**：
- **解决痛点**：RouteDev 记忆是"事件流"而非"合成状态"——`recall-injector.ts` 召回的是原始事件（`GraphNode.content`），没有跨会话的偏好/约束/时效性维护
- **量化预期**：
  - 时效性维护：扫描 `validUntil` 过期或 `unusedCount` 高的节点，调用 `forget()` 或 `archiveStaleNodes()`——预计可清理 20-30% 的过时节点（graph.ts 的 `archiveStaleNodes` 默认 30 天未更新即归档，但从未被触发）
  - 偏好提取：从 `loop-memory/archived/` 多次失败中提取"用户偏好"（如"用户偏好函数式风格"），写入 graph.ts 的 `fact` 节点
  - 跨会话事实合成：从多会话的 `projectFacts` 合成稳定事实，`validatedCount` 累加提升置信度

**间接效益**：
- 激活 graph.ts 的"死代码"——`improve()` / `archiveStaleNodes()` 是已实现但未触发的接口，Dreaming 让它们真正生效
- 提升 `recall-injector.ts` 的召回质量——合成后的高置信度节点排序更靠前
- 为 P1 #4（ICF）提供支持——Dreaming 标记的 `supersededBy` 节点可作为 ICF 干扰剔除信号

**ROI 评估：高**
- 成本：中（450-500 行，3 日，复用 graph.ts 现有接口）
- 效益：高（桌面应用天然有长空闲期，Dreaming 是低成本高收益；graph.ts 字段已为 Dreaming 预留）
- 比值：高 ROI

#### 落地方案

**Phase：76（触发器 + 最小合成）+ 77（完整合成）**

Phase 76 只做"触发器 + 时效性维护"（最小闭环），Phase 77 做"偏好提取 + 跨会话事实合成"（需要 LLM 合成 prompt 设计）。

**任务拆解（Phase 76 部分）**：

- **76-6: 实现 `memory-dreamer.ts` 触发器骨架**
  - 使用 Electron `powerMonitor` 的 `idle-state` 事件（idle 时间 > 10 分钟触发）
  - 备用触发器：app 启动后 10 分钟若未活跃则触发一次
  - 单次 Dreaming 预算上限：10K tokens（通过 `estimateTokens` 预估）
  - fail-open：任何错误只记日志，不阻塞主进程
  - 工作量：约 100 行

- **76-7: 实现"时效性维护"合成（无 LLM 调用）**
  - `scanStaleNodes()`：遍历 graph.ts 节点，识别 `validUntil < now` 或 `unusedCount > 3` 的节点
  - `applyForgetting()`：对识别的节点调用 `graph.forget({ criteria: { staleFor: 30 } })` 或 `graph.archiveStaleNodes(30)`
  - `markSuperseded()`：扫描 `loop-memory/archived/` 中的失败决策，若 graph.ts 有对应 `decision` 节点，调用 `graph.supersedeNode(oldId, newId)`（需先创建修正后的新节点）
  - 输出 Dreaming 报告：遗忘 N 个节点、归档 M 个节点、标记 K 个 superseded
  - 工作量：约 150 行（无 LLM 调用，纯本地操作）

- **76-8: 集成到 `app-init.ts`**
  - 与 76-3 的 `harness-evolution` 触发器共享定时器基础设施
  - Dreaming 触发频率：每 6 小时一次（或 idle 10 分钟后触发）
  - 工作量：约 30 行

- **76-9: 测试**
  - `memory-dreamer.test.ts`：mock graph.ts 节点（含 `validUntil` 过期、`unusedCount` 高的场景），验证遗忘和归档触发
  - 工作量：约 100 行测试

**Phase 77 任务（推迟，仅列出方向）**：
- 偏好提取：从 `loop-memory/archived/` 多次失败中用 LLM 提取"用户偏好"写入 graph.ts
- 跨会话事实合成：从多会话 `projectFacts` 合成稳定事实，`validatedCount` 累加
- UI：设置面板加"记忆状态"页（对应 ChatGPT 的 Memory summary page），可审查/编辑/删除

**验证标准（Phase 76 部分）**：
1. `pnpm test` 全绿，`memory-dreamer.test.ts` 覆盖时效性维护主流程
2. `pnpm typecheck` 通过
3. 手动验证：构造 graph.ts 节点含 `validUntil < now`，运行 `scanStaleNodes()`，节点被标记 `deprecated=true`
4. 手动验证：构造 `unusedCount > 3` 的节点，运行 `applyForgetting()`，节点被遗忘（`deprecated=true`）
5. 手动验证：idle 10 分钟后（mock `powerMonitor` 事件），Dreaming 自动触发并产出报告

**回滚方案**：
- **代码级回滚**：`memory-dreamer.ts` 是纯新增模块，删除即回滚；`app-init.ts` 的触发器注册可独立 revert
- **数据级回滚**：`graph.ts` 的 `forget()` 和 `archiveStaleNodes()` 只标记 `deprecated=true` 不删除节点，可手动恢复（设置 `deprecated=false`）
- **运行时回滚**：Dreaming 触发器加 `enabled` 配置开关（`config.memory.dreamingEnabled`，默认 true）

---

### P1 #3：APO 自动 Prompt 优化

#### 落地可行性分析

**技术可行性：中**

APO 本身不难，难在与 `experiment-manager.ts` 的 A/B 测试集成。

- **APO 输入现成**：P0 #1 的 `harness-evolution.ts` 会产出"一批失败 trace"（minibatch），这正是 APO 需要的输入
- **优化目标清晰**：`src/prompts/manager.ts` 的 `PromptTemplateManager` 已支持三级优先级，APO 生成的候选 prompt 可写入 `{AppData}/prompts/{id}.md`（用户级）做 A/B
- **A/B 测试基础设施存在但不完整**：`src/harness/experiment-manager.ts` 的 `createExperiment()` 基于 git worktree 创建实验分支，`runInExperiment()` 在 worktree 中执行任务。**但 `Experiment` 接口（experiment-manager.ts:20-43）没有 `promptVariant` 字段**，无法区分实验用的是哪个 prompt 版本。

**缺口**：
1. `Experiment` 接口需扩展 `promptVariant?: { templateId, content }` 字段
2. `runInExperiment()` 需在 worktree 中注入候选 prompt（覆盖 `{project}/.routedev/prompts/{id}.md`）
3. 缺少 bandit 选择器——需要在多个候选 prompt 间根据 `summarizeTrajectory().firstAttemptSuccessRate` 做 reward 选优
4. 缺少冲突检测——`src/agent/parallel-experiment.ts` 有冲突检测，但 APO 的 prompt 变体可能与现有实验冲突

**改动范围**：
- 新增 `src/prompts/apo-optimizer.ts`（APO 核心引擎，约 500-600 行）
- 修改 `src/harness/experiment-manager.ts`（扩展 `Experiment` 接口 + `runInExperiment` 注入 prompt，约 80 行）
- 新增 `src/prompts/bandit-selector.ts`（候选 prompt 选择器，约 200 行）
- 依赖 P0 #1 的 `harness-evolution.ts` 提供 minibatch 输入

**成本分析**：
- **难度：中高**（APO 本身不难，难在与 experiment-manager 的 A/B 集成 + bandit 选择器设计）
- **工作量**：约 800-900 行新增代码 + 250 行测试
- **预估耗时**：5-6 个开发日

**风险分析**：
- **prompt 退化风险**：APO 生成的候选 prompt 可能在某些场景下退化为更差。**缓解**：bandit 选择器保留原 prompt 作为"基线臂"，候选 prompt 必须在 N 次 A/B 后显著优于基线才提议合入
- **A/B 实验污染风险**：多个候选 prompt 的实验 worktree 可能交叉影响。**缓解**：每次 A/B 只对比 2 个 prompt（基线 + 1 候选），串行而非并行
- **token 成本风险**：APO 的"梯度生成" + "反向编辑" + "A/B 测试"每轮消耗大量 token。**缓解**：设置单轮 APO 预算上限（如 50K tokens）
- **对现有功能影响**：中——修改 `Experiment` 接口需全局搜索调用点同步更新（AGENTS.md 规定）

**前置条件**：
- **硬前置**：P0 #1 的 `harness-evolution.ts` 必须先完成，提供失败 trace minibatch
- 软前置：`experiment-manager.ts` 的 `runInExperiment` 需先支持 prompt 注入（可独立于 APO 完成）

#### 效益分析

**直接效益**：
- **解决痛点**：`src/prompts/manager.ts` 的 prompt 是"一次设计后静态使用"——`BUILTIN_TEMPLATES` 中的 `main.system` 等模板自 Phase 30 重构后纯人工维护，无数据驱动优化
- **量化预期**：
  - 失败 trace 驱动的 prompt 修订：预计 30-40% 的候选 prompt 在 A/B 后显著优于基线（APO 论文 EMNLP 2023 报告的提升区间）
  - bandit 选择器效率：保留 K=3 个候选，相比全量对比节省 60% 的 A/B 次数

**间接效益**：
- 让 `experiment-manager.ts` 的 A/B 基础设施真正用于 prompt 优化（目前主要用于代码实验）
- 为 P2 #6（AgentX 知识资产）提供"成功 prompt 变体"作为可检索知识

**ROI 评估：中高**
- 成本：中高（800-900 行，5-6 日，依赖 P0 #1）
- 效益：中高（让 prompt 优化从"人工经验"变成"数据驱动"）
- 比值：中高 ROI，但因依赖 P0 #1 必须推迟

#### 落地方案

**Phase：80（推迟）**

**任务拆解（仅列方向，Phase 80 时细化）**：
- 80-1: 扩展 `Experiment` 接口加 `promptVariant` 字段
- 80-2: 实现 `apo-optimizer.ts`（梯度生成 + 反向编辑）
- 80-3: 实现 `bandit-selector.ts`（K 臂选择器）
- 80-4: 集成 `experiment-manager.ts` 做 A/B 测试
- 80-5: 通过 bandit 选优后提议合入 `prompts/manager.ts` 的用户级模板

**验证标准**：
1. 候选 prompt 在 N=5 次 A/B 后 `firstAttemptSuccessRate` 显著优于基线（p < 0.05）
2. bandit 选择器在 K=3 候选下收敛到最优臂

**回滚方案**：
- 候选 prompt 写入 `{AppData}/prompts/{id}.md`，删除文件即回滚到内置默认
- A/B 实验在 git worktree 中进行，不污染主工作区

---

### P1 #4：ICF 上下文遗忘管理

#### 落地可行性分析

**技术可行性：高**

所有干扰信号源都已存在，接入点清晰。

- **接入点**：`src/agent/memory/context-manager.ts:386` 的 `compressEnhanced()` 目前是两轮压缩（offload 大输出 :433 + 摘要老消息 :462）。ICF 可作为"第三轮干扰剔除"插入在第一轮后、第二轮前（:460 与 :462 之间）。
- **干扰信号源 1（失败路径）**：`src/agent/loop-memory.ts` 的 `LoopFailure` 已记录 `iteration` / `reason` / `missingItems` / `gateFailures` / `reviewIssues`，可标记相关 tool_result 为"已证伪"
- **干扰信号源 2（rejected verdict）**：`src/agent/unified-reviewer.ts` 的 rejected verdict 可标记被推翻的中间产物（需确认接口）
- **干扰信号源 3（superseded 知识）**：`src/agent/memory/graph.ts` 的 `supersededBy` 非空节点可标记对应上下文消息过时（Dreaming 触发后会更多此类节点）

**缺口**：
1. `AgentMessage` 没有 `icfMark` 字段——需在 `src/agent/message-types.ts` 加 `'refuted' | 'outdated' | 'exploratory'` 标记
2. 压缩策略没有"干扰剔除"轮——`compressEnhanced()` 只按 token 量和优先级保留
3. 被剔除内容需保留摘要（避免 LLM 重复探索）——复用 `src/agent/memory/micro-summary.ts`

**改动范围**：
- 修改 `src/agent/message-types.ts`（加 `icfMark` 字段，约 10 行）
- 修改 `src/agent/memory/context-manager.ts`（在 `compressEnhanced` 插入第三轮干扰剔除，约 120 行）
- 新增 `src/agent/memory/icf-marker.ts`（标记逻辑：从 loop-memory 和 reviewer 信号标注 `icfMark`，约 150 行）
- 修改 `src/agent/loop-memory.ts`（暴露失败路径的 toolCallId 关联，约 30 行）

**成本分析**：
- **难度：中**（信号源都已存在，难点在 `icfMark` 的标注时机和压缩优先级设计）
- **工作量**：约 310 行新增/修改代码 + 120 行测试
- **预估耗时**：2-3 个开发日

**风险分析**：
- **误剔除风险**：`icfMark` 标注错误可能剔除有用信息。**缓解**：被剔除内容先用 `micro-summary.ts` 压成一行摘要（"已尝试 X 方案，因 Y 失败"），不直接删
- **标注时机风险**：`icfMark` 需在失败发生时即时标注，而非压缩时扫描（性能考虑）。**缓解**：在 `loop-memory.recordFailure()` 时同步标注相关消息
- **对现有功能影响**：低——`compressEnhanced` 的前两轮逻辑不变，第三轮是新增插入

**前置条件**：
- 软前置：P0 #2 的 Dreaming 触发后，`supersededBy` 信号会更丰富，ICF 效果更好——但 ICF 不依赖 Dreaming，可独立实施

#### 效益分析

**直接效益**：
- **解决痛点**：`compressEnhanced()` 是"容量管理"而非"干扰管理"——失败的探索路径、被 reviewer 推翻的中间产物、过时的工具输出仍可能留在上下文中干扰推理
- **量化预期**：
  - 对长 /goal 任务（50+ 步）特别有用：预计减少 15-25% 的无效上下文 token（失败探索路径被摘要替换）
  - 避免 LLM 重复探索：被剔除内容保留一行摘要，LLM 看到"已尝试 X 方案，因 Y 失败"后不会重试

**间接效益**：
- 提升 `loop-memory.ts` 的价值——失败记录不仅注入 system prompt，还直接清理上下文
- 与 P0 #2（Dreaming）协同——Dreaming 标记的 `supersededBy` 节点成为 ICF 的信号源

**ROI 评估：中**
- 成本：中（310 行，2-3 日）
- 效益：中（对长任务有效，短任务无明显收益；ICF-Bench 的核心发现就是"模型自己做不到 ICF，需要 harness 帮忙"）
- 比值：中 ROI，但因独立性强、风险低，适合 Phase 76 同期实施

#### 落地方案

**Phase：76**

**任务拆解**：

- **76-10: 扩展 `AgentMessage` 加 `icfMark` 字段**
  - 在 `src/agent/message-types.ts` 给 `AgentMessage` 加可选字段 `icfMark?: 'refuted' | 'outdated' | 'exploratory'`
  - 默认 undefined，不影响现有消息
  - 工作量：约 10 行

- **76-11: 实现 `icf-marker.ts` 标注逻辑**
  - `markRefuted(failure: LoopFailure, messages: AgentMessage[])`：从 `loop-memory` 的失败记录中提取相关 toolCallId，标注对应 `tool_result` 消息为 `icfMark='refuted'`
  - `markOutdated(graph: KnowledgeGraph, messages: AgentMessage[])`：扫描 graph.ts 中 `supersededBy` 非空的节点，标注对应消息为 `icfMark='outdated'`
  - `markExploratory(messages: AgentMessage[])`：启发式识别探索性消息（如 `thinking` 类型但后续被推翻的）
  - 工作量：约 150 行

- **76-12: 在 `compressEnhanced` 插入第三轮干扰剔除**
  - 在 `context-manager.ts:460`（第一轮 offload 后）和 `:462`（第二轮摘要前）之间插入
  - 遍历消息，对 `icfMark !== undefined` 的消息：
    1. 用 `micro-summary.ts` 压成一行摘要（"已尝试 X 方案，因 Y 失败" / "此信息已过时，被 Z 替代"）
    2. 替换原消息内容为摘要
    3. 统计 `interferenceRemoved` 数量写入 `CompressionEvent`
  - 工作量：约 120 行

- **76-13: 在 `loop-memory.recordFailure` 同步触发标注**
  - 修改 `loop-memory.ts:55` 的 `recordFailure`，在持久化后调用 `icf-marker.markRefuted`
  - 工作量：约 30 行

- **76-14: 测试**
  - `icf-marker.test.ts`：验证三类标注逻辑
  - `context-manager.test.ts` 扩展：验证第三轮干扰剔除触发后 `interferenceRemoved` 统计正确
  - 工作量：约 120 行测试

**验证标准**：
1. `pnpm test` 全绿，新增测试覆盖三类 `icfMark` 标注和第三轮剔除
2. `pnpm typecheck` 通过
3. 手动验证：构造 50+ 步的 /goal 任务，含 3 次失败探索，压缩后 `interferenceRemoved >= 3` 且上下文中保留摘要
4. 手动验证：被剔除的消息内容被替换为 `[已证伪] 已尝试 X 方案，因 Y 失败` 格式

**回滚方案**：
- **代码级回滚**：`icf-marker.ts` 是纯新增模块，删除即回滚；`compressEnhanced` 的第三轮插入可独立 revert（删除 :460-:462 之间的插入块）
- **数据级回滚**：`icfMark` 是可选字段，回滚后旧消息不受影响
- **运行时回滚**：第三轮剔除加 `enabled` 配置开关（`config.memory.icfEnabled`，默认 true）

---

### P2 #5：Submerged Knowledge 探测

#### 落地可行性分析

**技术可行性：低**

论文报告"不适用"章节第 2 条已明确判定，本节做诚实复核：

- **论文核心洞察**：揭示 LLM 生成错误答案时正确知识常在高概率候选中（Hits@k 评估）
- **RouteDev 架构不匹配**：RouteDev 是 agent loop 架构，单步生成的"正确性"由外循环验证（`src/agent/dual-loop-orchestrator.ts`）+ CompletionGate（`src/agent/completion-gate.ts` 用 typecheck/lint/tests via spawnSync）把关，**不依赖单次解码的 Hits@k**
- **现有替代方案更强**：在 reviewer 的 `cannotVerify` 状态下，RouteDev 已有 `LoopMemory`（`src/agent/loop-memory.ts`）避免重复犯错——直接打回让内循环重跑比用 Hits@k 取 top-k 候选更可靠

**改动范围（如强行实施）**：
- 需在 `src/agent/unified-reviewer.ts` 的 `cannotVerify` 状态下引入 top-k 候选解码
- 需修改 LLM 调用层支持 `logprobs` 返回（`src/router/` 多个文件）
- 需新增候选评分器对比 top-k 与当前答案
- 工作量：约 600-800 行

**风险分析**：
- **过度设计风险**：RouteDev 的循环验证架构已经用"重试 + 失败记忆"替代了单次解码可靠性，引入 Hits@k 是在已有更强机制上叠加弱机制
- **token 成本风险**：top-k 解码需要 `logprobs` 参数，多个候选的评分消耗额外 token
- **对现有功能影响**：中——修改 reviewer 状态机可能影响 `dual-loop-orchestrator` 的重试逻辑

**前置条件**：无

#### 效益分析

**直接效益**：
- **解决痛点**：无——RouteDev 没有单次解码可靠性的痛点（循环验证已覆盖）
- **量化预期**：不可量化——RouteDev 的失败模式是"多步推理错误"而非"单次解码错误"

**间接效益**：
- 无明显间接效益

**ROI 评估：低**
- 成本：中高（600-800 行，4-5 日）
- 效益：低（RouteDev 架构不依赖单次解码）
- 比值：低 ROI

#### 落地方案

**不建议实施**。

**理由**：
1. 论文报告"不适用"章节第 2 条已明确判定："RouteDev 是 agent loop 架构，单步生成的'正确性'由外循环验证 + CompletionGate 把关，不依赖单次解码的 Hits@k。在 reviewer 的 `cannotVerify` 状态下用 Hits@k 取 top-k 候选属于过度设计——不如直接打回让内循环重跑（RouteDev 已有 LoopMemory 避免重复犯错）。"
2. RouteDev 的循环验证（Dual-Loop + Cross-Model Review + CompletionGate）已经用"重试 + 失败记忆"机制覆盖了单次解码可靠性问题，引入 Hits@k 是在更强机制上叠加弱机制
3. 修改 reviewer 状态机有破坏 `dual-loop-orchestrator` 重试逻辑的风险，得不偿失

**如未来需要实施（仅作记录）**：
- Phase：不建议分配
- 验证标准：N/A
- 回滚方案：N/A

---

### P2 #6：AgentX 结构化知识资产

#### 落地可行性分析

**技术可行性：中**

这个借鉴点在论文报告中没有单独列出，但与 P0 #1（Harness Evolution）高度相关——AgentX Harness Evolution 的另一面是"将成功/失败实验转为可检索知识资产"。

- **现有实验管理**：`src/harness/experiment-manager.ts` 的 `Experiment` 接口（:20-43）有 `id` / `name` / `branch` / `worktreePath` / `baseBranch` / `baseCommit` / `status` / `createdAt` / `runCount` / `lastRunAt` / `tokenUsage`。**缺口**：没有 `knowledge` / `learnings` 字段，实验后无知识沉淀。
- **现有 `runInExperiment`（:320）**：执行后只更新 `runCount` / `lastRunAt` / `tokenUsage`，不记录实验结论（成功模式、失败原因、可复用知识）
- **现有 `adoptExperiment`（:476）**：合并后只标记 `status='adopted'`，不提取"这个实验为什么成功"的知识
- **可检索基础设施**：`src/agent/memory/graph.ts` 的 `KnowledgeGraph` 已支持 PPR 召回 + 社区检测 + 置信度，可复用为知识资产的检索层

**缺口**：
1. `Experiment` 接口需扩展 `knowledge?: { successPattern, failureReason, reusableLearnings }` 字段
2. `runInExperiment` 后需自动生成知识资产（LLM 总结"这个实验学到了什么"）
3. 知识资产需写入 `KnowledgeGraph` 作为 `skill` 或 `fact` 类型节点
4. `recall-injector.ts` 需能在新实验开始时召回相关历史实验知识

**改动范围**：
- 修改 `src/harness/experiment-manager.ts`（扩展 `Experiment` 接口 + `runInExperiment` 后调用知识提取，约 100 行）
- 新增 `src/harness/knowledge-extractor.ts`（LLM 提取实验知识，约 250 行）
- 修改 `src/agent/memory/recall-injector.ts`（新实验开始时召回相关历史知识，约 40 行）
- 依赖 P0 #1 的 `harness-evolution.ts` 提供失败 trace 作为知识提取输入

**成本分析**：
- **难度：中**（知识提取 prompt 设计是主要难点）
- **工作量**：约 390 行新增/修改代码 + 130 行测试
- **预估耗时**：3 个开发日

**风险分析**：
- **知识质量风险**：LLM 提取的"成功模式"可能过拟合到特定实验。**缓解**：知识资产写入 graph.ts 时 `validatedCount=1`，需多次实验验证后才提升置信度
- **知识污染风险**：失败实验的知识可能误导后续实验。**缓解**：失败知识标记 `type='event'`（graph.ts 的 NodeType），与成功知识 `type='skill'` 区分
- **对现有功能影响**：低——扩展 `Experiment` 接口是向后兼容的（新字段可选）

**前置条件**：
- **硬前置**：P0 #1 的 `harness-evolution.ts` 必须先完成，提供失败 trace 和回流骨架
- 软前置：`experiment-manager.ts` 的 `runInExperiment` 需先支持 `ExperimentRunner` 注入（目前 `runner: ExperimentRunnerLike | null`，:137——已支持但 runner 实现可能未注入）

#### 效益分析

**直接效益**：
- **解决痛点**：`experiment-manager.ts` 实验后无知识沉淀——`runInExperiment` 执行完就结束，成功/失败经验不积累
- **量化预期**：
  - 实验知识复用：新实验开始时召回相关历史实验知识，预计可减少 20-30% 的重复实验
  - 失败模式传承：失败实验的"为什么失败"知识可避免后续实验走同样弯路

**间接效益**：
- 激活 `experiment-manager.ts` 的"死数据"——目前 `experiment-registry.json` 只记录元数据，无可检索知识
- 与 P0 #1 协同——P0 #1 回流到 prompt/tool/grader，P2 #6 沉淀为可检索知识资产，形成"回流 + 沉淀"双闭环

**ROI 评估：中**
- 成本：中（390 行，3 日，依赖 P0 #1）
- 效益：中（减少重复实验，但依赖实验频率——RouteDev 是单用户桌面应用，实验频率可能不高）
- 比值：中 ROI，但因依赖 P0 #1 必须推迟

#### 落地方案

**Phase：78-79（推迟）**

**任务拆解（仅列方向，Phase 78-79 时细化）**：
- 78-1: 扩展 `Experiment` 接口加 `knowledge` 字段
- 78-2: 实现 `knowledge-extractor.ts`（LLM 提取实验知识）
- 78-3: 知识写入 `KnowledgeGraph` 作为 `skill` / `event` 节点
- 79-1: 修改 `recall-injector.ts` 在新实验开始时召回相关历史知识
- 79-2: UI 展示实验知识资产

**验证标准**：
1. 实验完成后 `Experiment.knowledge` 字段非空
2. 新实验开始时 `recall-injector` 召回相关历史实验知识（置信度 > 0.7）
3. 知识资产在 graph.ts 中可通过 `recall()` 检索到

**回滚方案**：
- `knowledge` 是可选字段，回滚后旧实验不受影响
- 知识资产写入 graph.ts 后可通过 `forget()` 删除

---

## Phase 76 整体规划

### 建议纳入的借鉴点（3 个）

| 借鉴点 | 任务编号 | 工作量 | 理由 |
|--------|---------|--------|------|
| P0 #1 Harness 闭环回流（骨架） | 76-1 ~ 76-5 | 约 1130 行 | ROI 高，数据已齐，是 RouteDev 升级的关键一跃 |
| P0 #2 Memory Dreaming（触发器+最小合成） | 76-6 ~ 76-9 | 约 580 行 | ROI 高，graph.ts 接口已就绪，桌面应用天然有长空闲期 |
| P1 #4 ICF 上下文遗忘管理 | 76-10 ~ 76-14 | 约 550 行 | ROI 中但独立性强、风险低，对长 /goal 任务有效 |

**Phase 76 总工作量**：约 2260 行（含测试），预估 8-10 个开发日

### 建议推迟的借鉴点（2 个）

| 借鉴点 | 推迟到 | 理由 |
|--------|--------|------|
| P1 #3 APO 自动 Prompt 优化 | Phase 80 | 硬依赖 P0 #1 的 `harness-evolution.ts` 提供失败 trace minibatch；A/B 测试集成复杂度高 |
| P2 #6 AgentX 结构化知识资产 | Phase 78-79 | 硬依赖 P0 #1 的回流骨架；知识提取 prompt 设计需要 P0 #1 的失败 trace 作为输入 |

### 不建议实施的借鉴点（1 个）

| 借鉴点 | 理由 |
|--------|------|
| P2 #5 Submerged Knowledge 探测 | 论文报告"不适用"章节已判定：RouteDev 的循环验证架构（Dual-Loop + Cross-Model Review + CompletionGate）不依赖单次解码 Hits@k，引入它是过度设计 |

### Phase 76 的整体目标

**主题**：从"会学习路由的 agent"升级为"会学习整个 harness 的 agent"——启动 Harness 层闭环回流与跨会话记忆合成

**三个并行主线**：

1. **Harness 闭环回流主线（76-1 ~ 76-5）**：
   - 数据读取（trace + regret + loop-memory）→ 失败聚类 → LLM 生成建议 → 审批持久化 → 应用到 prompt/tool/grader
   - 这是 LangChain Loop 4 Hill Climbing 在 RouteDev 的落地，与 ACRouter 的路由层闭环互补

2. **Memory Dreaming 主线（76-6 ~ 76-9）**：
   - 空闲触发（powerMonitor idle）→ 扫描过时节点 → 遗忘/归档/supersede → 激活 graph.ts 的"死代码"接口
   - Phase 76 只做"时效性维护"（无 LLM 调用），Phase 77 做"偏好提取 + 跨会话事实合成"（需 LLM）

3. **ICF 干扰剔除主线（76-10 ~ 76-14）**：
   - 扩展 `AgentMessage.icfMark` → 从 loop-memory 和 graph.ts 信号标注 → `compressEnhanced` 第三轮剔除
   - 与 P0 #2 协同——Dreaming 标记的 `supersededBy` 节点成为 ICF 的信号源

**主线间的依赖**：
- 76-1 ~ 76-5（P0 #1）与 76-6 ~ 76-9（P0 #2）共享 `app-init.ts` 的定时器基础设施（76-3 和 76-8 合并实现）
- 76-10 ~ 76-14（P1 #4）与 76-6 ~ 76-9（P0 #2）协同——Dreaming 产出 `supersededBy` 信号供 ICF 使用，但 ICF 不硬依赖 Dreaming（可独立实施）

---

## 风险矩阵

| 风险 | 来源借鉴点 | 严重度 | 概率 | 缓解措施 |
|------|-----------|--------|------|----------|
| LLM 生成的 prompt 修订建议误导用户 | P0 #1 | 高 | 中 | 建议不自动应用，写入 `harness-suggestions.jsonl` 由用户审批（参照 skill-lifecycle.ts Refinement 审批） |
| trace 文件随时间膨胀导致扫描慢 | P0 #1 | 中 | 中 | 回流引擎只读最近 N 天的 trace，设置 maxSessions 扫描上限（listSessions 默认 limit=20） |
| 空闲检测误判（powerMonitor idle 不准确） | P0 #2 | 中 | 中 | 结合 `idle-state` 事件 + 最小空闲时长阈值（10 分钟）双判断 |
| Dreaming 合成的"偏好/事实"错误 | P0 #2 | 中 | 中 | 合成结果 `validatedCount=1`（低置信度），经 `improve(useful)` 多次确认后才排序靠前 |
| Dreaming 单次消耗过多 token | P0 #2 | 低 | 中 | 单次 Dreaming 预算上限 10K tokens，超限中止 |
| `icfMark` 误剔除有用信息 | P1 #4 | 中 | 中 | 被剔除内容先用 `micro-summary.ts` 压成一行摘要，不直接删 |
| `icfMark` 标注时机错误 | P1 #4 | 低 | 低 | 在 `loop-memory.recordFailure()` 时即时标注，不依赖压缩时扫描 |
| 扩展 `Experiment` 接口未同步调用点 | P2 #6（推迟） | 中 | 低 | AGENTS.md 规定接口签名变更必须全局搜索调用点同步更新 |
| APO 候选 prompt 在某些场景退化 | P1 #3（推迟） | 中 | 中 | bandit 选择器保留原 prompt 作为基线臂，候选必须显著优于基线才合入 |
| P0 #1 和 P0 #2 共享定时器导致相互阻塞 | P0 #1 + P0 #2 | 低 | 低 | 两个 runCycle 用独立的 try-catch 包裹，fail-open 互不影响 |
| Phase 76 工作量超预期 | 全部 | 中 | 中 | 优先级：76-1~76-5（P0 #1）> 76-6~76-9（P0 #2）> 76-10~76-14（P1 #4）；若超期可把 P1 #4 推迟到 Phase 77 |

---

## 附录：代码位置索引

### P0 #1 相关代码位置

| 位置 | 说明 |
|------|------|
| `src/harness/trace-collector.ts:498` `listSessions()` | 读取历史 trace session |
| `src/harness/trace-collector.ts:517` `readSessionRecords()` | 读取指定 session 的 record |
| `src/harness/trace-collector.ts:398` `summarizeTrajectory()` | 输出 trajectory 级汇总指标 |
| `src/router/regret-tracker.ts:26` `computeCumulativeRegret()` | 累积遗憾指标 |
| `src/router/regret-tracker.ts:74` `getRegretByTier()` | 按 tier 分桶遗憾 |
| `src/agent/loop-memory.ts:24` `LOOP_MEMORY_DIR` | 失败记录持久化目录 |
| `src/agent/loop-memory.ts:26` `LOOP_MEMORY_ARCHIVE_DIR` | 归档目录（跨会话输入源） |
| `src/prompts/manager.ts:581` `getTemplate()` | 三级优先级模板查找 |
| `src/prompts/manager.ts:749` `getProjectTemplatesDir()` | 项目级模板目录 |

### P0 #2 相关代码位置

| 位置 | 说明 |
|------|------|
| `src/agent/memory/graph.ts:33` `validUntil` | 过时时间戳字段（已存在，未触发） |
| `src/agent/memory/graph.ts:35` `supersededBy` | 被替代节点 ID 字段（已存在） |
| `src/agent/memory/graph.ts:39` `unusedCount` | 未使用次数字段（已存在） |
| `src/agent/memory/graph.ts:620` `supersedeNode()` | 标记节点被替代（已实现） |
| `src/agent/memory/graph.ts:648` `archiveStaleNodes()` | 归档过期节点（已实现，**无外部调用**） |
| `src/agent/memory/graph.ts:679` `improve()` | 知识反馈更新（已实现，**无外部调用**） |
| `src/agent/memory/graph.ts:765` `forget()` | 主动遗忘（已实现，**仅 unified-memory.ts:213 一处调用**） |
| `src/agent/memory/recall-injector.ts:49` `recallToPrompt()` | 召回+格式化（无合成） |
| `src/memory/unified-memory.ts:213` | `forget()` 的唯一外部调用点 |

### P1 #4 相关代码位置

| 位置 | 说明 |
|------|------|
| `src/agent/memory/context-manager.ts:386` `compressEnhanced()` | 两轮压缩入口（ICF 第三轮插入点） |
| `src/agent/memory/context-manager.ts:433` 第一轮 offload | 大工具输出 offload |
| `src/agent/memory/context-manager.ts:462` 第二轮摘要 | 老消息摘要替换 |
| `src/agent/loop-memory.ts:55` `recordFailure()` | 失败记录（ICF 标注触发点） |
| `src/agent/memory/micro-summary.ts` | 微摘要（ICF 剔除内容保留摘要） |

### P1 #3 / P2 #6 相关代码位置

| 位置 | 说明 |
|------|------|
| `src/harness/experiment-manager.ts:20` `Experiment` 接口 | 需扩展 `promptVariant` / `knowledge` 字段 |
| `src/harness/experiment-manager.ts:320` `runInExperiment()` | 需支持 prompt 注入 + 知识提取 |
| `src/harness/experiment-manager.ts:476` `adoptExperiment()` | 合并后需提取成功模式 |
| `src/harness/experiment-manager.ts:137` `runner: ExperimentRunnerLike \| null` | ExperimentRunner 注入点 |
| `src/prompts/manager.ts:29` `BUILTIN_TEMPLATES` | APO 优化目标 |

---

## 一句话总结

**Phase 76 聚焦"启动 Harness 层闭环回流 + 激活 graph.ts 死代码接口 + 上下文干扰剔除"三条主线，约 2260 行工作量，8-10 个开发日；P1 #3（APO）和 P2 #6（AgentX 知识资产）因硬依赖 P0 #1 推迟到 Phase 78-80；P2 #5（Submerged Knowledge）因 RouteDev 循环验证架构不依赖单次解码，不建议实施。**
