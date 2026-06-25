# Phase 38 — Harness 中间件、子 Agent 工具化与知识管理增强

> **版本目标：** v3.0.0
> **前置依赖：** Phase 37 完成（v2.9.0）
> **新增测试要求：** ≥ 35 个
> **研究依据：** DEEP_RESEARCH_agent_frameworks_2026-06-23.md（deepagents-in-action / deer-flow / cognee / multica 四项目对标调研）；AUDIT-REPORT-2026-06-21.md（全量代码审查）
> **核心命题：** RouteDev 的 Agent Loop 和 KnowledgeGraph 核心代码已经成熟，但存在三个系统性架构缺口——(1) 中间件管道只激活了 1/5 的能力（`onActing`），其余四个阶段形同虚设；(2) 子 Agent 调度是硬编码管道而非可组合工具，灵活性不足；(3) 知识图谱只进不出，缺少反馈闭环（`improve`）和遗忘机制（`forget`），且 `ingestToGraph()` 桥接函数从未被调用。本 Phase 从调研的四个项目中提取经过验证的设计模式，以最小改动量补齐这三个缺口。

---

## 研究背景：三个架构缺口的来源

### 1. 中间件管道"五用一" — 关注点分离不足

**现状：** `AgentMiddlewarePipeline`（`src/agent/middleware.ts`，67 行）定义了 5 个阶段——`onAgent`、`onReasoning`、`onActing`、`onModelCall`、`onSystemPrompt`，但 `loop.ts` 只调用了 `onActing`（工具执行前权限检查）。其余四个阶段虽然类型声明存在，但从未被 `loop.ts` 触发。

**调研启示：** deepagents-in-action 和 deer-flow 都采用"洋葱模型"——每个 LLM 调用穿过 8-19 层中间件，分别负责安全检查、上下文压缩、循环检测、人工审批等。deer-flow 的 `LoopDetectionMiddleware`（检测重复工具调用循环并强制输出文本答案）直接解决了 Agent 陷入死循环的问题。ETCLOVG 七层分类法（Execution / Tooling / Context / Lifecycle / Observability / Verification / Governance）为中间件分层提供了标准参考。

**类比：** 现在的 loop.ts 像一根没有阀门的水管——水（消息）从头流到尾，安全检查、Token 追踪、结果脱敏都是焊在管子上的。洋葱模型是给水管装一节一节的阀门，每节管一件事，出问题可以单独关掉某一节。

### 2. 子 Agent 调度硬编码 — 灵活性不足

**现状：** `SpawnAgentTool`（`src/tools/builtin/spawn-agent.ts`，123 行）已定义但接线状态待验证。`WorkerExecutor` 是独立的执行器，只能通过 `ExecutionOrchestrator` 的硬编码管道调用。Agent 不能像使用 `file_read` 一样灵活地调度子 Agent。

**调研启示：** deer-flow 的"子 Agent 即工具"模式——把调度子 Agent 包装成一个标准 `task` 函数调用（`description` + `prompt` + `subagent_type`），Agent 可以像使用其他工具一样派遣子 Agent。关键设计决策：子 Agent 不能再调度子 Agent（`disallowed_tools` 默认包含 `task`），从设计上杜绝无限递归。multica 的"看板模式"（Issue Board + @mention 委派）在大规模多 Agent 场景下防止"上下文爆炸"。

**类比：** RouteDev 当前的方式像"建固定流水线"——先规划再执行，流程写死。deer-flow 的方式像"雇临时工"——主 Agent 喊一声"我需要一个调研助手"，系统就派一个出来，完事就解散。

### 3. 知识图谱"只进不出" — 缺少反馈和遗忘

**现状：** `KnowledgeGraph`（`src/agent/memory/graph.ts`，687 行）有丰富的能力——PPR 排序、社区检测、Jaccard 聚类、置信度计算、过时归档——但存在四个关键缺口：
- `ingestToGraph()`（`src/agent/memory/dream-to-graph.ts`）从未被 `/dream` 命令调用，Dream 结果不会流入知识图谱
- 没有 `improve()` 反馈机制——Agent 使用知识图谱中的知识后，无法根据结果更新置信度
- 没有 `forget()` 能力——只能按固定 30 天窗口归档，不能按使用频率衰减
- `recall()` 只有单一策略（双路径精确+泛化，固定权重 0.7/0.3），不能根据查询类型自适应路由
- `GraphNode.embedding?` 字段声明了但从未写入或读取

**调研启示：** cognee 用四个方法管好整个知识系统——`remember`/`recall`/`forget`/`improve`。其中 `improve()` 是反馈闭环的关键：Agent 使用知识完成任务后，根据结果给那条知识打分，对的加分、错的减分。cognee 的 `recall()` 支持 6 种检索策略（TEMPORAL/SEMANTIC/GRAPH/HYBRID 等），自动路由器根据查询特征选择最佳策略。

**类比：** RouteDev 的知识图谱像一个只收不退的图书馆——新书不断入库，但从不清理过时的书，也不知道哪些书被读者验证过是正确的。`improve()` 是给图书馆加一个"读者反馈"系统，`forget()` 是加一个"旧书淘汰"机制。

---

## Task 1：中间件管道全面激活（≥ 8 测试）

### 1.1 问题定义

`AgentMiddlewarePipeline` 定义了 5 个阶段但只激活了 `onActing`。权限检查、Token 追踪、结果脱敏、上下文注入等逻辑散落在 `loop.ts` 的不同位置，无法独立启用/禁用/替换。Agent 陷入工具调用死循环时没有检测机制。

### 1.2 设计方向

**核心改动：** 在 `loop.ts` 的 ReAct 循环中增加其余四个中间件阶段的调用点。

```
当前 loop.ts 的调用链：
  buildMessages → callLLM → parseToolCalls → [onActing 中间件] → executeTool → injectResult

目标调用链（洋葱模型）：
  [onSystemPrompt 中间件] → buildMessages
  → [onModelCall 中间件] → callLLM → [onReasoning 中间件] → parseToolCalls
  → [onActing 中间件] → executeTool → injectResult
  → [onAgent 中间件（迭代结束时）]
```

**五个阶段的职责划分（供思考）：**

| 阶段 | 时机 | 典型中间件 | 当前状态 |
|------|------|-----------|---------|
| `onSystemPrompt` | system prompt 构建前 | 上下文注入（KnowledgeGraph recall 结果）、项目约定注入（AGENTS.md） | ❌ 未激活 |
| `onModelCall` | LLM 调用前 | Token 预算检查、请求日志、缓存检查 | ❌ 未激活 |
| `onReasoning` | LLM 返回后、工具执行前 | 循环检测、reasoning 输出过滤/摘要 | ❌ 未激活 |
| `onActing` | 工具执行前 | 权限检查（PermissionEngine）、安全检查 | ✅ 已激活 |
| `onAgent` | 每次迭代结束后 | 会话级 Token 累计、进度报告、idle 检测 | ❌ 未激活 |

**新增内置中间件：`LoopDetectionMiddleware`**

参考 deer-flow 的设计——检测重复工具调用循环并强制打破：

核心逻辑（供思考）：
- 维护一个滑动窗口（最近 N 次工具调用），记录 `(toolName, argsHash)` 对
- 如果同一 `(toolName, argsHash)` 在窗口内出现 ≥ 3 次 → 判定为循环
- 打破方式：向 messages 注入一条 system 消息，指示 Agent "你似乎陷入了循环，请总结当前进展并给出下一步计划"
- 配置项：`loopDetection.windowSize`（默认 10）、`loopDetection.maxRepeats`（默认 3）、`loopDetection.enabled`（默认 true）

**从 loop.ts 提取已有逻辑为中间件（供思考）：**
- Token 追踪（当前在 `callLLMStream` 内直接调用 profiler）→ `TokenTrackingMiddleware`（`onModelCall` 阶段）
- 结果脱敏（当前在工具结果注入前直接调用 sanitizer）→ `ResultSanitizeMiddleware`（`onActing` 阶段的后续处理器）
- Steering 消息注入（当前在迭代开始时 `drainSteering()`）→ `SteeringMiddleware`（`onAgent` 阶段）

**不需要移动的：**
- 权限检查已经在 `onActing` 阶段，保持不变
- Hook 系统（`HookRunner`）保持独立——Hook 是 step/tool/session 级生命周期事件，中间件是 LLM 调用链内的拦截点，两者职责不同

### 1.3 配置设计

```yaml
middleware:
  loopDetection:
    enabled: true
    windowSize: 10
    maxRepeats: 3
  tokenTracking:
    enabled: true      # 可观测性不应是实验性的（陷阱 #22）
  resultSanitize:
    enabled: true      # 安全中间件不可关闭
  steering:
    enabled: true
```

### 1.4 思考引导

- 中间件的注册顺序是否影响执行结果？（`onActing` 阶段：权限检查应该在安全检查之前还是之后？如果权限拒绝后安全检查还跑了，是浪费还是信息补充？）
- 从 loop.ts 提取逻辑为中间件时，如何保证不破坏现有测试？（渐进式：先保持原有调用不变，新增中间件并行执行，验证结果一致后再移除原有调用）
- `LoopDetectionMiddleware` 的 argsHash 应该怎么算？（JSON.stringify + 简单 hash？还是只比较关键参数？如果 tool 有随机参数如 timestamp，每次 hash 不同就检测不到循环）
- 中间件异常应该怎么处理？（当前 `onActing` 的 `metadata.permissionDenied` 是一种 fail-closed 模式。其他阶段呢？`onModelCall` 中间件抛异常是阻断 LLM 调用还是跳过该中间件？）

---

## Task 2：子 Agent 工具化与防递归增强（≥ 7 测试）

### 2.1 问题定义

当前子 Agent 调度有两种路径：(1) `ExecutionOrchestrator` 硬编码的 `WorkerExecutor.execute()` 管道，(2) `SpawnAgentTool` 的依赖注入模式。但两者之间没有打通——Agent 在 ReAct 循环中不能灵活地决定"我需要派一个子 Agent 去做这件事"。同时缺少子 Agent 的递归防护和并行上限。

### 2.2 设计方向

**核心改动：** 将 `SpawnAgentTool` 完善为 deer-flow 式的 `task` 工具，并在 `app-init.ts` 中正确接线。

**`SpawnAgentTool` 增强（供思考）：**

```
当前签名：
  SpawnAgentFunction = (taskDescription, options?) => Promise<{ success, result, tokenUsage?, error? }>

增强签名：
  SpawnAgentFunction = (params: {
    description: string,       // 短标签（UI 显示用）
    prompt: string,            // 给子 Agent 的详细指令
    subagentType: 'general' | 'researcher' | 'coder' | 'reviewer',
    maxIterations?: number,    // 默认 20
    isolated?: boolean,        // 是否使用独立上下文（不继承父 Agent 对话历史）
  }) => Promise<SpawnResult>

SpawnResult = {
  success: boolean,
  result: string,
  tokenUsage?: TokenUsage,
  modifiedFiles?: string[],
  error?: string,
}
```

**防递归机制（关键设计决策）：**

参考 deer-flow 的做法——子 Agent 的工具列表中**不包含** `spawn_agent`：

```
创建子 Agent 时：
  1. 复制父 Agent 的 ToolRegistry
  2. 从子 Agent 的 ToolRegistry 中移除 spawn_agent
  3. 子 Agent 尝试调用 spawn_agent → "工具不存在"错误
```

这个设计的优雅之处在于：不需要复杂的递归深度计数器，而是从工具集层面直接阻断。子 Agent 物理上不可能再派遣孙子 Agent。

**并行上限（供思考）：**
- 维护一个全局的"活跃子 Agent 计数器"
- 配置项 `agent.maxConcurrentSubAgents`（默认 3）
- 达到上限时，`spawn_agent` 返回错误："已达到最大并行子 Agent 数，请等待当前任务完成"
- 或者排队等待（哪种用户体验更好？）

**`subagentType` 的角色 prompt 差异（供思考）：**

| 类型 | 角色 prompt 方向 | 默认工具集 |
|------|----------------|-----------|
| `general` | 通用助手，无特殊限制 | 全部工具（除 spawn_agent） |
| `researcher` | 专注信息搜集，不做文件修改 | file_read, code_search, web_search, web_fetch, list_directory |
| `coder` | 专注代码编写，不做调研 | file_read, file_write, file_edit, shell_exec, git_op |
| `reviewer` | 专注代码审查，不做修改 | file_read, code_search, list_directory |

### 2.3 接线验证

**第一步：** 验证 `SpawnAgentTool` 当前是否在 `app-init.ts` 中正确接线。如果 `SpawnAgentFunction` 注入点是空的或指向桩函数，需要先完成接线。

**第二步：** 确保 `spawn_agent` 工具在 `ToolRegistry` 中注册，且 `requiresApproval: true` 保持不变（子 Agent 调度需要用户确认）。

**第三步：** 在 `ExecutionOrchestrator` 的多 Agent 路径中，考虑是否迁移到 `spawn_agent` 工具调用模式，还是保持现有的硬编码管道（两者可以并存——硬编码管道用于 `/goal` 的预规划执行，`spawn_agent` 工具用于 Agent 在 ReAct 循环中的临时委派）。

### 2.4 思考引导

- 子 Agent 的对话历史应该是独立的还是继承父 Agent 的？（独立 = 上下文隔离，不会污染父 Agent；继承 = 子 Agent 有更多背景信息但 Token 消耗更大。deer-flow 选择了独立，multica 通过 Issue Board 传递必要的上下文）
- `spawn_agent` 的结果应该怎么返回给父 Agent？（直接作为工具返回值注入消息？还是写入 Blackboard 让父 Agent 自行读取？前者更简单直接，后者更适合多步骤场景）
- 子 Agent 执行期间，父 Agent 应该是阻塞等待还是可以继续做其他事？（当前 `SpawnAgentTool` 是 Promise——阻塞等待。如果需要非阻塞，需要一个"异步任务"模式：spawn 返回 taskId，后续用 `check_task` 工具查询结果）

---

## Task 3：知识图谱反馈闭环与遗忘机制（≥ 10 测试）

### 3.1 问题定义

KnowledgeGraph 有丰富的读取能力（recall、PPR、社区检测、聚类），但写入侧只有"增加"和"归档"，缺少两个关键能力：
1. **反馈闭环**（`improve`）：Agent 使用知识图谱中的知识完成任务后，无法根据结果更新知识节点的置信度
2. **主动遗忘**（`forget`）：只能按固定 30 天窗口归档，不能按使用频率衰减，也不能响应用户的显式遗忘请求

同时，`/dream` 命令没有调用 `ingestToGraph()`——Dream 结果不会流入知识图谱，`dream-to-graph.ts` 整个模块是死代码。

### 3.2 设计方向

**3.2.1 修复 `/dream` 命令的知识图谱桥接**

当前 `/dream` 命令流程：
```
checkpoint → DreamConsolidator.consolidate() → saveToDisk() → 结束
```

目标流程：
```
checkpoint → DreamConsolidator.consolidate() → saveToDisk()
                                                ↓
                                          ingestToGraph(dreamResult, knowledgeGraph)
                                                ↓
                                          返回 IngestResult（created/merged/superseded/archived）
```

**注意（陷阱 #52）：** `DreamConsolidator` 和 `KnowledgeGraph` 是两个独立的记忆系统，通过显式的 `ingestToGraph()` 调用桥接。不要在 `DreamConsolidator` 内部硬编码 KnowledgeGraph 依赖。桥接调用应该发生在 `/dream` 命令的 handler 中。

**3.2.2 新增 `improve()` 方法**

参考 cognee 的 `improve(query, correctAnswer, feedbackScore)` 设计：

```
KnowledgeGraph.improve(params: {
  query: string,           // 触发召回的查询文本
  nodeIds: string[],       // 被使用的节点 ID 列表（来自 recall 结果）
  outcome: 'useful' | 'partially_useful' | 'incorrect' | 'unused',
  details?: string,        // 可选的补充说明
}): ImproveResult

ImproveResult = {
  updatedNodes: number,
  supersededNodes: number,
  details: string,         // 人可读的操作摘要
}
```

**反馈对置信度的影响（供思考）：**
- `useful` → `validatedCount += 1`，刷新 `updatedAt`
- `partially_useful` → 不改变 `validatedCount`，但刷新 `updatedAt`（延缓衰减）
- `incorrect` → 标记为 `deprecated`，创建 `conflicts_with` 边指向新知识（如果有的话）
- `unused` → 递增一个 `unusedCount` 计数器（供 `forget` 使用）

**谁来触发 improve？**
- **自动触发**：`/goal` 完成后，`GoalVerifier` 的验证结果可以作为知识反馈。如果验证通过，之前 recall 的知识标记为 `useful`；如果验证失败，标记为 `partially_useful` 或 `incorrect`
- **手动触发**：新增 `/memory feedback` 命令，让用户显式评价某条知识
- **Dream 阶段**：`DreamConsolidator` 的 consolidate 结果可以作为批量反馈

**3.2.3 新增 `forget()` 方法**

```
KnowledgeGraph.forget(params: {
  nodeIds?: string[],       // 显式指定要遗忘的节点
  criteria?: {
    unusedFor?: number,     // 天数：unusedCount 持续超过 N 天
    staleFor?: number,      // 天数：updatedAt 距今超过 N 天
    type?: NodeType,        // 只遗忘特定类型的节点
  },
  dryRun?: boolean,         // 预览模式：只返回会被遗忘的节点，不实际执行
}): ForgetResult

ForgetResult = {
  forgotten: number,
  nodes: Array<{ id: string; content: string; type: NodeType }>,
}
```

**遗忘策略（供思考）：**
- 不是直接删除节点，而是标记为 `deprecated`（与 `archiveStaleNodes()` 一致）
- 如果节点被其他非 deprecated 节点引用（入边），则不遗忘（避免悬空引用）
- `dryRun=true` 时返回待遗忘列表，让用户确认后再执行
- 配置项 `memory.autoForget.unusedDays`（默认 60）、`memory.autoForget.staleDays`（默认 90，当前硬编码的 30 天太激进）

**3.2.4 新增 `/memory` 命令扩展**

```
/memory list                    → 列出知识图谱中的节点（按类型分组，按置信度排序）
/memory forget --stale 90       → 预览遗忘 90 天未更新的节点
/memory forget --stale 90 --yes → 确认执行遗忘
/memory feedback <nodeId> useful → 手动标记某条知识为有用
/memory feedback <nodeId> wrong  → 手动标记某条知识为错误
```

### 3.3 思考引导

- `improve()` 的 `outcome` 应该有几个等级？cognee 用的是数值分数（`feedbackScore`），但离散等级（useful/partially_useful/incorrect）可能更容易让 Agent 和用户理解。哪种更好？
- 自动触发 `improve()` 时，如何确定哪些节点是被"使用"过的？当前 `recall()` 返回 `RecallResult[]`，但调用方没有记录"这些结果被用在了哪里"。需要在 `recall()` 返回时记录一个"最近召回"列表吗？
- `forget()` 的"入边保护"策略——如果一个节点被 5 个其他节点引用，但它本身已经过时了 2 年，应该遗忘吗？（保护 vs 过期的权衡）
- 知识图谱目前没有跨会话持久化（`toJSON()`/`fromJSON()` 存在但没有代码调用它们）。`forget()` 和 `improve()` 修改了节点后，需要触发持久化吗？（如果是，持久化的时机是什么？每次修改？每次 Dream？会话结束？）

---

## Task 4：多策略记忆检索与图谱持久化（≥ 7 测试）

### 4.1 问题定义

当前 `KnowledgeGraph.recall()` 只有一种策略——双路径（精确 + 泛化）固定权重合并。不同类型的查询应该使用不同的检索策略：
- "我之前决定用什么框架？" → 应该优先搜索 `decision` 类型节点
- "项目有哪些已知的错误？" → 应该优先搜索 `event` 类型节点
- "关于认证模块的所有知识" → 应该用图遍历（BFS 深度搜索）
- "上次那个 bug 怎么修的？" → 应该用时间排序（最近的优先）

同时，`GraphNode.embedding?` 字段声明了但从未使用，缺少语义搜索能力。KnowledgeGraph 没有跨会话持久化。

### 4.2 设计方向

**4.2.1 多策略 Recall**

重构 `recall()` 方法，支持多种检索策略：

```
type RecallStrategy = 'semantic' | 'graph' | 'temporal' | 'type_weighted' | 'hybrid'

KnowledgeGraph.recallV2(params: {
  query: string,
  strategy?: RecallStrategy,    // 不指定时使用 auto 路由
  maxResults?: number,
  typeFilter?: NodeType,
  since?: Date,                 // 时间下界
}): RecallResult[]
```

**各策略的实现方向（供思考）：**

| 策略 | 核心逻辑 | 适用场景 |
|------|---------|---------|
| `semantic` | 关键词匹配 + Jaccard 相似度（当前 precise 路径的增强版） | 通用查询 |
| `graph` | 从匹配节点出发做 BFS 深度 3 遍历，收集关联节点 | "关于 X 的所有知识" |
| `temporal` | 按 `updatedAt` 降序排列，最近的优先 | "最近发生了什么" |
| `type_weighted` | 根据查询中的关键词（"决定/决策"→decision，"错误/bug"→event）提升对应类型节点的权重 | 带类型暗示的查询 |
| `hybrid` | 同时运行 semantic + graph + temporal，加权合并（semantic 0.4 + graph 0.3 + temporal 0.3） | 不确定时的默认策略 |

**4.2.2 自动策略路由器**

参考 cognee 的做法——用一个简单的规则路由器（不调用 LLM）根据查询特征自动选择策略：

```
function autoSelectStrategy(query: string): RecallStrategy {
  // 决策关键词检测
  if (匹配 "决定/决策/选了/采用/方案") return 'type_weighted' (boost decision)
  if (匹配 "错误/bug/异常/崩溃/修复") return 'type_weighted' (boost event)
  if (匹配 "最近/刚才/上次/今天") return 'temporal'
  if (匹配 "关于/所有/全部/涉及") return 'graph'
  // 默认
  return 'hybrid'
}
```

**注意（陷阱 #50 延伸）：** 策略路由器不调用 LLM，用纯文本关键词匹配。目的是零额外 Token 成本。

**4.2.3 知识图谱跨会话持久化**

当前 KnowledgeGraph 每次会话从 `ContextManager` 构造函数中创建空实例，会话结束后丢失。需要添加持久化：

```
持久化路径：.routedev/memory/knowledge-graph.json

时机：
  - 加载：ContextManager 构造时（如果文件存在则 fromJSON() 恢复）
  - 保存：每次 ingestToGraph() / improve() / forget() 后触发（debounce 500ms 避免频繁写入）
  - 会话结束：on-session-end hook 中保存

冲突处理：
  - 如果文件在会话期间被外部修改（罕见场景），以内存状态为准覆盖磁盘
```

**4.2.4 embedding 字段的去留（供思考）**

`GraphNode.embedding?` 字段声明了但从未使用。两个方向：
- **方向 A：实现轻量语义搜索** — 使用一个轻量的 embedding 模型（如 sentence-transformers 的 ONNX 版本）为节点生成向量，用余弦相似度做语义搜索。优点：比关键词匹配更准确。缺点：引入模型依赖，增加延迟。
- **方向 B：移除 embedding 字段** — 承认当前阶段不需要向量搜索，Jaccard + 关键词 + PPR 已经足够。在注释中说明"未来如果需要语义搜索，可以重新引入"。优点：减少维护负担。缺点：关闭了语义搜索的门。

这个选择需要根据实际使用场景判断——如果 RouteDev 的用户主要用中文查询，关键词匹配可能不够（中文分词复杂）；如果主要用英文，Jaccard + 关键词已经可用。

### 4.3 思考引导

- 多策略 `recallV2` 是否应该保持对旧 `recall()` 的向后兼容？（`recall()` 可以变成 `recallV2({ query, strategy: 'hybrid' })` 的别名）
- 策略路由器的关键词列表应该放在配置文件中还是硬编码？（配置文件可以让用户自定义，但增加了配置复杂度）
- 持久化文件应该用 JSON 还是 JSONL？（JSON 简单但大文件读写慢；JSONL 可以增量追加但需要合并逻辑。知识图谱的节点数量级是多少？如果 < 1000 个节点，JSON 足够）
- `autoSelectStrategy` 的中文关键词匹配怎么做？（简单 includes？jieba 分词后匹配？还是用正则？中文的"决定"和"决策"含义接近但字面不同，英文的 "decide" 和 "decision" 共享词根）

---

## Task 5：集成测试与文档同步（≥ 3 测试）

### 5.1 集成测试

- **中间件链集成测试**：验证完整的洋葱模型调用链（5 个阶段按顺序执行，中间件异常不阻断循环，`LoopDetectionMiddleware` 在 3 次重复后打破循环）
- **子 Agent 工具化集成测试**：验证 Agent 在 ReAct 循环中调用 `spawn_agent` 工具 → 子 Agent 执行 → 结果注入父 Agent 消息的完整流程。验证子 Agent 无法调用 `spawn_agent`（防递归）
- **知识图谱完整生命周期测试**：创建知识 → recall → improve（useful）→ 验证 validatedCount 递增 → improve（incorrect）→ 验证 deprecated → forget → 验证节点被标记

### 5.2 文档同步

- **AGENTS.md**：新增陷阱 #60-64（见下方）
- **CODEMAP.md**：新增 `middleware` 扩展模块、`spawn_agent` 增强、`improve()`/`forget()` 方法、多策略 recall 说明
- **CHANGELOG.md**：v3.0.0 条目，记录四个 Task 的完成情况和关键设计决策
- **package.json**：版本号升级至 3.0.0

---

## 新增陷阱警告

**60. 中间件阶段顺序不可随意调整：** `onSystemPrompt → onModelCall → onReasoning → onActing → onAgent` 是 ReAct 循环的自然顺序。如果把 `onAgent` 提前到 `onActing` 之前，会话级 Token 统计会漏掉最后一次工具调用。新增中间件时，考虑它应该在哪个阶段执行——在权限检查之前还是之后？

**61. `LoopDetectionMiddleware` 的 argsHash 需要归一化：** 工具参数中可能包含时间戳、随机 ID 等每次都不同的字段。argsHash 应该排除这些字段（只比较"语义参数"），否则永远检测不到循环。具体排除哪些字段由每个工具的 `hashRelevantParams` 配置决定。

**62. 子 Agent 的 ToolRegistry 是父 Agent 的浅拷贝：** `spawn_agent` 创建子 Agent 时，复制父 Agent 的 ToolRegistry 但移除 `spawn_agent`。如果父 Agent 在子 Agent 执行期间注册了新工具，子 Agent 看不到。这是有意的隔离——子 Agent 的工具集应该在创建时确定。

**63. `improve()` 的 `incorrect` 反馈不直接删除节点：** 标记为 `deprecated` 并创建 `conflicts_with` 边。被 deprecated 的节点在 `recall()` 中默认排除（`includeSuperseded: false`），但通过 `listNodes({ deprecated: true })` 仍可访问。真正的物理删除只在 `forget()` 的 `criteria.staleFor` 超过阈值后执行。

**64. 知识图谱持久化文件可能被多进程写入：** Desktop 端（Electron 主进程）和 CLI 端可能同时操作同一个项目的知识图谱。使用文件锁（`proper-lockfile` 或简单的 `.lock` 文件）防止并发写入损坏。如果锁获取失败，降级为"本次会话不持久化"并 `logger.warn`。

---

## 思考引导总结

以下问题供执行人在实现时思考，不是强制要求：

1. **中间件的性能开销**：5 个阶段 × 每个阶段 N 个中间件 = 每次 LLM 调用多出 5N 次函数调用。在流式输出期间（每秒可能 10+ 次 LLM 调用），这个开销是否可接受？是否需要 benchmark？

2. **子 Agent 的错误应该怎么传递给父 Agent？** deer-flow 用 `result_holder` + 5 秒轮询；RouteDev 当前用 Promise。如果子 Agent 执行了 30 秒后失败，父 Agent 应该怎么处理——重试？换一个子 Agent？还是放弃这个子任务？

3. **知识图谱的 `validatedCount` 是否应该有上限？** 如果一个节点被验证了 1000 次，它的置信度会非常高，但可能只是因为被频繁 recall 而非真的可靠。是否需要引入"验证收益递减"（如 `log(validatedCount)` 代替线性增长）？

4. **`forget()` 的 dryRun 结果怎么展示给用户？** CLI 端可以用表格（节点 ID + 内容预览 + 类型 + 最后更新时间），Desktop 端可以用卡片列表。两种 UI 的交互设计需要提前考虑。

5. **多策略 recall 和 Phase 36 的"任务感知裁剪"（`classifyInfoValue()` + `declareFocus()`）是否有关联？** 如果 Worker 执行时 recall 的知识与当前任务关注点不匹配，应该被过滤掉吗？这个过滤应该在 recall 阶段还是在 Worker 的 `filterContext()` 阶段？

6. **知识图谱持久化后，`ContextManager` 的构造方式需要改变吗？** 当前 `ContextManager` 在构造函数中创建空的 `KnowledgeGraph`。如果要从磁盘加载，构造函数的签名可能需要接受一个可选的 `graphPath` 参数。

7. **Phase 36 设计的 `validUntil`/`supersededBy` 过时标记和本 Phase 的 `forget()` 机制是什么关系？** `validUntil` 是节点级别的时效声明（"这条知识在 X 日期前有效"），`forget()` 的 `criteria.staleFor` 是系统级别的衰减策略（"超过 N 天没更新的节点可以遗忘"）。两者应该叠加使用还是取其一？

8. **中间件和 Hook 的职责边界在哪里？** 当前设计是"中间件在 LLM 调用链内，Hook 在生命周期事件上"。但如果一个功能（如 Token 追踪）既需要在每次 LLM 调用前检查预算（中间件），又需要在会话结束时汇总（Hook），应该怎么拆分？

9. **子 Agent 工具化后，Phase 31 的 `ExecutionOrchestrator` 和 `TaskOrchestrator`（目前仍是死代码）是否可以借助 `spawn_agent` 真正激活？** `TaskOrchestrator` 的 `development` 意图需要执行"需求确认→分解→执行→审查"流水线，如果"执行"步骤可以用 `spawn_agent` 工具实现，是否比硬编码管道更灵活？
