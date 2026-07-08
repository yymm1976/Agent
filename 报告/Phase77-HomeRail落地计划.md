# Phase 77 落地计划：HomeRail 借鉴点深度分析

## 概述

本文档基于 `报告/HomeRail-源码调研报告.md` 第 4 节提出的 7 个借鉴点，对照 RouteDev 项目（Phase 75 收尾、Phase 76 实施中）的实际代码实现，逐点做生产落地可行性分析，并给出 Phase 77 的具体实施范围与任务拆解。

### 分析方法

对每个借鉴点，分析前已实际阅读以下关键代码文件，确保结论有代码位置支撑而非泛泛而谈：

| 文件 | 关键发现 |
|------|----------|
| `src/agent/workflow/dag-engine.ts` (313 行) | `DagNode` 仅 `id/dependsOn/action/variables`（:17-26）；`execute()` 按 Kahn 分层并行（:182-227）；无端口、无条件分支、无 mailbox、无数据传递 |
| `src/harness/trace-collector.ts` (150+ 行) | `listSessions(limit=20)`（:490）和 `readSessionRecords()`（:517）**只读当天目录**（`new Date().toISOString().slice(0,10)`）；`summarizeTrajectory()`（:398）已输出 token/retry/success 指标 |
| `src/harness/audit-logger.ts` (100 行) | Phase 53 已加 SHA-256 哈希链（:40-45）；`AuditAction` 枚举无 scorecard 类型（trace-types.ts:115-139） |
| `src/agent/goal-persistence.ts` (269 行) | **`listResumable()`（:124-134）已实现**，返回 status=executing/paused 的 goal；`save()`（:89）、`load()`（:102）、`archive()`（:155）齐全；数据落盘 `.routedev/goals/<id>.json` |
| `src/runtime/app-init.ts` (2300+ 行) | `goalPersistence` 在 :1552 创建（条件 `persistenceEnabled`）；**grep 验证：`listResumable` 在 app-init 中无任何调用**——恢复接口存在但从未被触发 |
| `src/runtime/graceful-shutdown.ts` (100 行) | `registerShutdownHook(priority,name,fn)`（:76）注册式清理链；只有 shutdown 逻辑，**无 startup 恢复逻辑** |
| `src/router/config.ts` (100 行) + `src/config/schema.ts:139-145` | `RouterConfigSchema` 字段：rules/budget/classifierModel/userPreference/fallbackChain；**无 prohibitedProviders/prohibitedModels**（grep 验证无匹配） |
| `src/agent/progress-ledger.ts` (80 行) | append-only JSONL（`.routedev/progress.jsonl`）；`ProgressEntry`：taskId/status/commitSha/reviewVerdict/timestamp；用于 compaction 后恢复执行位置 |
| `src/agent/multi/blackboard.ts` (70 行) | `currentGoal`/`completedSteps`/`projectFacts`/`version`（乐观锁）；`addCompletedStep()`/`addProjectFact()`；**纯内存，无持久化**；Worker 间共享状态而非直接消息传递 |
| `src/runtime/goal-runner.ts:1038-1071` | goal 执行时调 `goalPersistence.save()` 持久化，status='executing'；**但崩溃后无任何代码调用 listResumable 恢复** |
| `src/router/types.ts:232-244` | `ILLMClient` 接口：`complete()`/`stream()`/`isReady()`；是 API client 抽象，非完整 agent harness |

### 关键代码验证（grep 结果）

- **`listResumable` 在 src/runtime/app-init.ts 中无任何调用**——证实"恢复接口已就绪但缺启动触发器"
- **`prohibited|forbidden|blocklist` 在 src/config/schema.ts 中无匹配**——证实路由配置无 provider/model 级禁止能力
- **`recover|restore|listResumable|resume` 在 app-init.ts 中仅匹配到 `createBoundedRecoveryManager` import（:121，与冷启动无关）**——证实无启动恢复
- **`goalPersistence.save` 只在 goal-runner.ts:1040 一处被调用**——证实 goal 持久化是单向的（写不读）
- **`listSessions` 和 `readSessionRecords` 都用 `new Date().toISOString().slice(0,10)` 拼路径**——证实只能读当天 trace，历史回放需修复

### 推荐结论速览

- **Phase 77 建议纳入（3 个）**：借鉴点 5（运行回放与评分卡）+ 借鉴点 7（冷启动恢复）+ 借鉴点 4（Voice Memo 式会话状态卡）
- **建议推迟（2 个）**：借鉴点 1（端口化 DAG 引擎，Phase 78+，成本高）+ 借鉴点 3（多 Harness 适配器，待需要时）
- **不建议实施（2 个）**：借鉴点 2（DAG Actor 模型，blackboard 已覆盖）+ 借鉴点 6（Provider Policy，场景有限）

### 与 Phase 76 的关系

Phase 76 主题是"启动 Harness 层闭环回流 + 激活 graph.ts 死代码 + 上下文干扰剔除"，3 个论文借鉴点均为**数据回流与记忆合成**方向。Phase 77 的 3 个 HomeRail 借鉴点均为**运行可观测性与崩溃恢复**方向，与 Phase 76 **无任何重叠**，两者正交互补：
- Phase 76 解决"agent 怎么学习"（离线回流）
- Phase 77 解决"agent 怎么被观察和恢复"（运行时可观测 + 崩溃恢复）

---

## 总览表

| # | 借鉴点 | 可行性 | 难度 | ROI | 建议 | 理由 |
|---|--------|--------|------|-----|------|------|
| 1 | 端口化 DAG 引擎 | 中 | 高 | 中 | 推迟（Phase 78+） | 成本高（800-1000 行），桌面单用户 DAG 复杂流程需求不强；PathRouter 已动态选路径 |
| 2 | DAG Actor 模型消息传递 | 中 | 中 | 低 | **不建议** | blackboard.ts 已覆盖多 agent 共享状态；单进程下直接消息传递收益有限 |
| 3 | 多 Harness 适配器架构 | 中 | 高 | 中 | 推迟（待需要时） | RouteDev 走标准 LLM API，当前 ILLMClient 够用；除非要接 Codex 等非标准 harness |
| 4 | Voice Memo 式会话状态卡 | 高 | 中 | 中 | **纳入 Phase 77** | 数据已齐（goal/plan/ledger），UI 呈现提升用户体验；与回放/恢复协同 |
| 5 | 运行回放与评分卡 | 高 | 中 | **高** | **纳入 Phase 77** | trace-collector 数据已落盘，listSessions/readSessionRecords 已存在；缺口在回放命令和 scorecard 渲染 |
| 6 | Provider Policy 策略 | 高 | 低 | 低 | **不建议** | 单用户桌面场景，用户自己配 provider，禁止能力使用频率极低 |
| 7 | 冷启动恢复 | 高 | 中 | **高** | **纳入 Phase 77** | `listResumable()` 已实现但从未被调用；桌面应用崩溃恢复是关键体验 |

---

## 现有代码分析

### 1. DAG 引擎现状（`src/agent/workflow/dag-engine.ts`，313 行）

RouteDev 的 DAG 引擎是"任务调度器"而非"agent 协作图"：

- **`DagNode` 接口（:17-26）**：仅 `id` / `dependsOn` / `action` / `variables` 四个字段。无端口（outputs）、无条件分支、无 mailbox。
- **`DagWorkflow` 接口（:29-34）**：`nodes` + `variables`，无 edges 显式定义。
- **`execute()` 方法（:182-227）**：按 `layeredSort()` 分层 → 同层 `Promise.all` 并行 → 失败重试 `retryLimit` 次 → 累计失败达 `humanEscalationThreshold` 跳过。**执行模型是"分层并行批处理"，不是"事件驱动状态机"**。
- **变量替换（:162-167）**：`resolveVariables()` 只做 `{{name}}` → `variables[name]` 的字符串替换，无结构化数据传递。
- **重试机制（:254-269）**：节点级 `retryLimit` + `failureCounts` 累计，无边级 `retry_policy`。
- **被引用位置**：`goal-runner.ts:26` 引用 `DagEngine/DagWorkflow/DagNode` 类型；`path-router.ts` 按难度选择 single/dag/compose 路径。

**与 HomeRail 差距**：HomeRail 的 `handoff(run, fromNode, port, content)` 实现端口匹配 + 条件路由（on_success/on_failure/always）+ mailbox 投递 + 分支跳过 + 循环网关。RouteDev 无任何此类能力。

### 2. Trace 收集现状（`src/harness/trace-collector.ts`，700+ 行）

- **数据落盘**：`.routedev/traces/{date}/{sessionId}.trace.jsonl`（JSONL）+ `.session.json`（会话元数据）。
- **`listSessions(limit=20)`（:490-514）**：读取 `.routedev/traces/{today}/` 下的 `.session.json` 文件。**关键缺陷：`today = new Date().toISOString().slice(0,10)`（:493），只能读当天目录，历史 trace 无法列出**。
- **`readSessionRecords(sessionId)`（:517-531）**：同样用 `today` 拼路径（:519），**只能读当天 record**。
- **`summarizeTrajectory()`（:398）**：输出 `TrajectorySummary`（trace-types.ts:158-187），含 totalTokens/toolCallCount/retryCount/firstAttemptSuccessRate/success/terminationReason。
- **`endSession()`（:347）**：flush 到磁盘。
- **`recordEvent()`（:85）**：记录 ReAct 事件（thinking/tool_call_start/tool_call_result/done/error）。
- **GUI 桥接**：`onSpan(callback)`（:57）实时推送 span 到渲染层。

**与 HomeRail 差距**：HomeRail 的 `hr replay <run_id>` 能完整回放 DAG 运行（handoff/send_message/receive_message/tool_use/tool_result/usage）。RouteDev 有 trace 数据但**无法回放历史**（today-only bug），也无 replay 命令和 scorecard 概念。

### 3. 审计日志现状（`src/harness/audit-logger.ts`，100+ 行）

- **哈希链（Phase 53 Task 4，:40-45）**：每条记录含 `previousHash` + `hash`，SHA-256 防篡改。
- **`AuditAction` 枚举（trace-types.ts:115-139）**：含 file_write/shell_exec/goal_start/goal_complete/rollback/permission_change 等 20+ 类型，**无 scorecard 类型**。
- **`QualityAuditRecord`（:31-33）**：扩展记录含 `qualityMetadata`（source/signalType/severity）。
- **数据落盘**：JSONL，retentionDays 默认 30 天。

**与 HomeRail 差距**：HomeRail 有 `scorecard` 概念（off/advisory/strict 三模式 + handoff_blockers/quality_gate 配置）。RouteDev 有 quality 信号记录但无 scorecard 聚合呈现。

### 4. Goal 持久化现状（`src/agent/goal-persistence.ts`，269 行）

- **`PersistedGoal` 接口（:36-66）**：`id` / `spec`（五段式）/ `plan`（steps + attestation + archivedVersions）/ `status` / `checkpointIds` / `createdAt` / `updatedAt` / `tokenUsed` / `tokenBudget` / `progressReport`。
- **`GoalPlanStatus`（:33）**：`'planning' | 'executing' | 'paused' | 'completed' | 'failed'`。
- **`save()`（:89-95）**：写 `.routedev/goals/<id>.json`。
- **`load()`（:102-117）**：读单个 goal，ENOENT 返回 null。
- **`listResumable()`（:124-134）**：**已实现！** 扫描 goalsDir 下的 .json，返回 status=executing/paused 的 goal。
- **`archive()`（:155-169）**：移到 archived/ 目录。
- **`generateProgressReport()`（:208-235）**：静态方法，生成 markdown 进度报告。
- **`shouldSoftStop()`（:201-203）**：tokenUsed >= 90% 预算时返回 true。

**关键发现**：`listResumable()` 接口完整就绪，但 `app-init.ts` 中**从未被调用**（grep 验证）。goal-runner.ts:1038-1071 在 goal 执行时调 `save()` 持久化（status='executing'），但应用重启后无任何代码调 `listResumable()` 恢复——**这是"写了不读"的单向持久化**。

### 5. 优雅退出现状（`src/runtime/graceful-shutdown.ts`，100+ 行）

- **`registerShutdownHook(priority, name, fn)`（:76-98）**：集中注册式清理链，按 priority 降序执行。
- **一次性触发**（:50 `shuttingDown` 标志）：重复 SIGINT 直接 `process.exit`。
- **超时强制退出**（:54 `timeoutMs=5000`）：hook 卡死不阻塞退出。
- **fail-open**（:18 设计原则）：单个 hook 失败不阻塞后续。

**关键发现**：只有 shutdown 逻辑，**无 startup 恢复逻辑**。shutdown hook 是"清理资源"，不是"保存恢复点"——虽然 goal-runner 在执行中已 save，但崩溃（非正常 shutdown）时可能 status 仍是 'executing'，重启后 listResumable 能找到但无人调用。

### 6. 路由配置现状（`src/router/config.ts` + `src/config/schema.ts:139-145` + `src/router/types.ts:319-333`）

- **`RouterConfigSchema`（schema.ts:139-145）**：`rules` / `budget` / `classifierModel` / `userPreference` / `fallbackChain`。
- **`RouterRule`（types.ts:319-324）**：`tier` / `modelId` / `fallbackModelId` / `maxTokensPerRequest`。
- **`buildRouterRules()`（config.ts:31-99）**：修复无效 modelId（unconfigured → 已配置模型替换），生成默认规则。
- **`ILLMClient` 接口（types.ts:232-244）**：`complete()` / `stream()` / `isReady()`——是 LLM API client 抽象，不是完整 agent harness。
- **6 个 provider client**：anthropic / openai / deepseek / gemini / ollama / qwen（`src/router/llm/`）。

**与 HomeRail 差距**：HomeRail 的 `ProviderPolicyConfig`（prohibited_providers/prohibited_models/reason）能在模板层禁止特定 provider/model。RouteDev **无此字段**（grep 验证 schema.ts 无 prohibited/forbidden/blocklist 匹配）。

### 7. Progress Ledger 现状（`src/agent/progress-ledger.ts`，80+ 行）

- **append-only JSONL**（`.routedev/progress.jsonl`）：永不覆盖、永不删除。
- **`ProgressEntry`（:22-37）**：`taskId` / `status`（complete/failed/blocked）/ `commitSha` / `commitRange` / `reviewVerdict` / `timestamp`。
- **`appendProgress()`（:71-76）**：`fs.appendFile`，POSIX 原子。
- **用途**：compaction 后从 ledger + git log 恢复执行位置（Phase 75-B2）。

**与 HomeRail 差距**：RouteDev 的 ledger 是"任务级完成记录"，HomeRail 的 voice memo 是"会话级状态摘要"（title/status/summary/known_facts/open_questions/todos/next_action）。两者粒度不同，ledger 是结构化数据，voice memo 是面向用户的状态卡。

### 8. App Init 启动流程现状（`src/runtime/app-init.ts`，2300+ 行）

- **`createAppDependencies()`（:307）**：主工厂函数，集中创建所有服务实例。
- **`goalPersistence` 创建（:1552）**：`goalIntegrationCfg?.persistenceEnabled ? new GoalPersistence(cwd) : null`。
- **Doctor 启动探针（:2237）**：`logger.info('Phase53 Doctor: startup probe complete')`——有启动探针但无 goal 恢复。
- **配置 reload（:1861）**：`createAppDependencies` 重新创建依赖。
- **grep 验证**：`recover|restore|listResumable|resume` 仅匹配 `createBoundedRecoveryManager` import（:121，是 agent 执行中的有界恢复，与冷启动无关）。

**关键发现**：app-init.ts 有 2300+ 行装配逻辑，但**启动时无任何 goal 恢复调用**。`goalPersistence` 实例创建后只传给 goal-runner（:2327），从未调用 `listResumable()`。

---

## 详细分析

### 借鉴点 1：端口化 DAG 引擎

#### 现有代码分析

RouteDev 的 `DagNode` 接口（`dag-engine.ts:17-26`）仅有 4 个字段：

```typescript
export interface DagNode {
  id: string;
  dependsOn: string[];
  action: string;
  variables?: Record<string, string>;
}
```

`execute()` 方法（:182-227）的核心逻辑是分层并行：

```typescript
// :208-224 逐层执行
for (const layer of layers) {
  for (let i = 0; i < layer.length; i += this.maxParallel) {
    const batch = layer.slice(i, i + this.maxParallel);
    const batchOutcomes = await Promise.all(
      batch.map(node => this.executeNode(node, workflow.variables, executor)),
    );
    // ... 收集结果
  }
}
```

变量替换（:162-167）只做字符串模板：

```typescript
resolveVariables(action: string, variables: Record<string, unknown>): string {
  return action.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    const val = variables[name];
    return val == null ? '' : String(val);
  });
}
```

HomeRail 的 `handoff(run, fromNode, port, content)` 实现了端口匹配 + 条件路由 + mailbox 投递 + 分支跳过 + 循环网关（调研报告 3.1.2 节），是事件驱动状态机。

#### 落地可行性

**技术可行性：中**

- `DagNode` 接口改动影响面：`goal-runner.ts:26` 引用 `DagEngine/DagWorkflow/DagNode` 类型，`path-router.ts` 按难度选择路径。接口扩展（加 `outputs?` 字段）向后兼容，但 `execute()` 重写是破坏性改动。
- 现有分层并行模型与事件驱动状态机**fundamentally 不同**——不是加字段能解决，需要重写执行核心。
- RouteDev 的 PathRouter（`src/agent/path-router.ts`）已能动态选择 single/dag/compose，dag 模式是三种之一，使用频率低于 single。

**改动范围**：
- 重写 `src/agent/workflow/dag-engine.ts`（313 行 → 估算 800-1000 行）
- 新增 `DagEdge` / `DagPort` / `Mailbox` 类型定义
- 修改 `goal-runner.ts` 中 dag 路径的 executor 适配新接口
- 修改 `path-router.ts` 的 dag 路由判断（新增条件分支感知）

**成本分析**：
- **难度：高**（执行模型从分层并行改为事件驱动状态机，是架构级改动）
- **工作量**：约 800-1000 行重写 + 200 行测试
- **预估耗时**：5-7 个开发日

#### 效益分析

**直接效益**：
- **解决痛点**：RouteDev 的 DAG 无法表达"review 失败则走修复分支"这样的条件流程
- **量化预期**：难以量化——RouteDev 的 dag 路径使用频率本身不高（PathRouter 按难度选，多数任务走 single）

**间接效益**：
- 为借鉴点 2（Actor 模型）提供基础——但借鉴点 2 不建议实施

#### ROI 评估

- **成本：高**（800-1000 行，5-7 日，架构级改动）
- **效益：中**（桌面单用户场景，复杂 DAG 需求频率不高）
- **比值：中 ROI**——但成本占比过高，挤占 Phase 77 其他高 ROI 借鉴点

#### 结论

**推迟到 Phase 78+**。

理由：
1. 成本高（架构级重写），Phase 77 应聚焦高 ROI 低成本的借鉴点
2. RouteDev 的 PathRouter 已动态选择执行路径，条件路由是"锦上添花"而非"雪中送炭"
3. 桌面单用户场景下，复杂 DAG 条件流程的需求频率不高
4. 与 Phase 76（回流+记忆合成）无协同效应，独立性强但成本不匹配

---

### 借鉴点 2：DAG 节点间消息传递 Actor 模型

#### 现有代码分析

RouteDev 的 `Blackboard`（`src/agent/multi/blackboard.ts:12-70`）已实现多 agent 共享状态：

```typescript
export class Blackboard {
  private currentGoal: { description: string; status: string } | null = null;
  private completedSteps: BlackboardEntry[] = [];
  private projectFacts: BlackboardEntry[] = [];
  private version = 0;  // 乐观锁

  addCompletedStep(stepId, role, conclusion, confidence): void { ... }
  addProjectFact(key, value, confidence): void { ... }
}
```

Worker（子 Agent）通过 blackboard 共享 `completedSteps` 和 `projectFacts`，用乐观锁 `version` 防冲突。这是**共享状态模式**，不是**直接消息传递**。

HomeRail 的 `dag-message-router.ts` 实现 pending inbox + waiters 模式（调研报告 3.1.3 节），节点 A 可以 `send_message(to_node: "B")`，节点 B 可以 `receive_message()` 等待。

#### 落地可行性

**技术可行性：中**

- Blackboard 是纯内存（无持久化），加消息队列在技术上可行
- 但 RouteDev 的 DAG 节点执行是同步批处理（`Promise.all`），不是 HomeRail 的事件驱动——消息传递需要节点能"挂起等待"，与现有执行模型冲突
- 依赖借鉴点 1（端口化 DAG）先完成，否则无意义

**改动范围**：
- 新增 `src/agent/workflow/dag-message-router.ts`（约 200-300 行）
- 修改 `dag-engine.ts` 的 `executeNode` 支持挂起/恢复（依赖借鉴点 1）
- 新增 `send_message`/`receive_message` DAG 工具

**成本分析**：
- **难度：中**（但硬依赖借鉴点 1）
- **工作量**：约 300-400 行（不含借鉴点 1 的基础改动）
- **预估耗时**：2-3 个开发日（在借鉴点 1 完成后）

#### 效益分析

**直接效益**：
- **解决痛点**：DAG 节点间无直接通信——但 blackboard 已覆盖"共享状态"需求
- **量化预期**：极低——单进程下 blackboard 的共享状态模式已足够

#### ROI 评估

- **成本：中**（300-400 行，但硬依赖借鉴点 1 的 800-1000 行）
- **效益：低**（blackboard 已覆盖多 agent 协作需求）
- **比值：低 ROI**

#### 结论

**不建议实施**。

理由：
1. RouteDev 的 blackboard 模式（`blackboard.ts`）已满足多 agent 共享状态需求——`addCompletedStep` / `addProjectFact` / 乐观锁 version 已覆盖"Worker 间协作"
2. 单进程 Electron 应用下，直接消息传递 vs 共享状态的差异不像分布式场景那样显著
3. 硬依赖借鉴点 1（端口化 DAG），而借鉴点 1 已推迟——单独实施无意义
4. HomeRail 的 Actor 模型是为多容器 Worker 设计的（每个节点是独立 Docker 容器），RouteDev 的节点是同进程函数调用，不需要跨进程消息队列

---

### 借鉴点 3：多 Harness 适配器架构

#### 现有代码分析

RouteDev 的 `ILLMClient` 接口（`src/router/types.ts:232-244`）是 LLM API client 抽象：

```typescript
export interface ILLMClient {
  readonly protocol: Protocol;
  readonly providerId: string;
  complete(options: LLMRequestOptions): Promise<LLMResponse>;
  stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent, void, unknown>;
  isReady(): boolean;
}
```

6 个 provider client（`src/router/llm/`：anthropic/openai/deepseek/gemini/ollama/qwen）都实现此接口。RouteDev 的 `ReActAgentLoop`（`src/agent/loop.ts`）自己管理工具调用循环——LLM client 只负责 API 调用，不负责 agent 运行时。

HomeRail 的 `createAgentClient(agentBackend)` 工厂（调研报告 3.3.2 节）把整个 agent 运行时委托给 harness（Claude SDK 自己有工具调用循环），Worker 只负责 DAG 工具注入和事件流转发。

#### 落地可行性

**技术可行性：中**

- 抽象 `AgentHarness` 接口（`run(task, tools, context): AsyncIterable<AgentEvent>`）在技术上可行
- 但 RouteDev 的 agent loop 是核心资产（含中间件链、权限引擎、上下文管理、compaction），把循环委托给外部 harness 意味着放弃这些能力
- 现有 6 个 provider client 都是 API client，不是 harness——适配需要每个 provider 包一层

**改动范围**：
- 新增 `src/router/harness/` 目录 + `AgentHarness` 接口（约 150 行）
- 新增 `HarnessAdapter` 适配现有 ILLMClient 为 AgentHarness（约 200 行/provider × 6 = 大量重复）
- 修改 `agent/loop.ts` 支持 harness 模式切换（约 100 行）
- 修改 `app-init.ts` 注册 harness 工厂

**成本分析**：
- **难度：高**（需要在不破坏现有 agent loop 的前提下加 harness 抽象层）
- **工作量**：约 600-800 行
- **预估耗时**：4-5 个开发日

#### 效益分析

**直接效益**：
- **解决痛点**：无——RouteDev 走标准 LLM API，当前架构够用
- **量化预期**：仅在未来要接 Codex 等"自带工具调用循环"的 harness 时才有价值

**间接效益**：
- 无明显间接效益——除非有明确的非标准 harness 接入需求

#### ROI 评估

- **成本：高**（600-800 行，4-5 日）
- **效益：低-中**（当前无需求，是为未来可能性投资）
- **比值：中 ROI**（但机会成本高，挤占 Phase 77 名额）

#### 结论

**推迟（待需要时实施）**。

理由：
1. RouteDev 当前只走标准 LLM API（6 个 provider 都是 API client），无非标准 harness 接入需求
2. RouteDev 的 agent loop 是核心差异化资产（中间件链、权限引擎、上下文管理），委托给外部 harness 意味着放弃这些能力——得不偿失
3. HomeRail 的多 harness 抽象是为"编排 Claude SDK / Codex / Kimi 三种自带运行时的 harness"设计的，RouteDev 的定位是"自己管理 agent loop"，架构哲学不同
4. 若未来确需接 Codex 等 harness，再单独评估——不应为假设需求提前抽象

---

### 借鉴点 4：Voice Memo 式会话状态卡

#### 现有代码分析

RouteDev 的会话状态分散在多个结构中：

- **goal**：`PersistedGoal`（`goal-persistence.ts:36-66`）含 spec/plan/status/tokenUsed/tokenBudget/progressReport
- **plan**：`PlanState`（`src/agent/context/plan-state.ts`）含步骤状态
- **progress-ledger**：`.routedev/progress.jsonl` 含已完成 task 记录
- **blackboard**：`currentGoal` / `completedSteps` / `projectFacts`（`blackboard.ts:13-15`，纯内存）
- **goal-progress UI**：`src/runtime/components/goal-progress.ts` 的 `renderGoalProgressText` / `renderGoalCompletionSummary`

HomeRail 的 `update_voice_memo` 工具（调研报告 3.4.1 节）将语音会话状态持久化为 TOML 文件：

```typescript
const voiceMemoSchema = {
  properties: {
    title: { type: "string" },
    status: { enum: ["listening", "clarifying", "ready", "executing", "done"] },
    summary: { type: "string" },
    known_facts: { type: "array", maxItems: 8 },
    open_questions: { type: "array", maxItems: 8 },
    todos: { type: "array", maxItems: 10 },
    next_action: { type: "string" },
    ready_to_execute: { type: "boolean" },
  },
  required: ["title", "status", "summary"],
};
```

每次更新是**完整替换**而非追加，是"面向用户、一眼能看懂"的会话状态摘要。

#### 落地可行性

**技术可行性：高**

- 数据源全部已存在：goal（`PersistedGoal`）、plan（`PlanState`）、ledger（`progress-ledger.ts`）、blackboard（`blackboard.ts`）
- React UI 已成熟（`src/runtime/components/`），加状态卡组件是增量
- 不需要 TOML（RouteDev 用 JSON/JSONL），用 React 组件渲染即可

**改动范围**：
- 新增 `src/runtime/components/session-status-card.tsx`（会话状态卡组件，约 150 行）
- 新增 `src/agent/session-status-aggregator.ts`（从 goal/plan/ledger/blackboard 聚合状态，约 100 行）
- 修改 `desktop/main/engine-bridge.ts` 增加 IPC 通道 `session:get-status`（约 30 行）
- 修改渲染层挂载状态卡组件（约 20 行）

**成本分析**：
- **难度：中**（数据聚合逻辑 + UI 组件设计）
- **工作量**：约 300 行
- **预估耗时**：2 个开发日

#### 效益分析

**直接效益**：
- **解决痛点**：会话状态分散在 goal/plan/ledger/blackboard 中，用户无"一眼能看懂"的统一摘要
- **量化预期**：提升用户体验——长 /goal 任务（50+ 步）时，用户能快速看到"当前在做什么、已知什么、待解决什么、下一步是什么"

**间接效益**：
- 与借鉴点 5（回放）协同——状态卡是"当前快照"，回放是"历史时间线"，两者互补
- 与借鉴点 7（冷启动恢复）协同——恢复时展示"上次中断在哪"

#### ROI 评估

- **成本：中**（300 行，2 日）
- **效益：中**（提升用户体验，不是核心功能但增强可观测性）
- **比值：中 ROI**——但因与借鉴点 5/7 协同，整体价值高于单独评估

#### 落地方案

**Phase：77**

**任务拆解**：

- **77-8: 设计 `SessionStatus` 数据模型与聚合器**
  - 定义 `SessionStatus` 接口：`{ title, status, summary, knownFacts: string[], openQuestions: string[], todos: {text, done}[], nextAction, tokenUsed, tokenBudget, updatedAt }`
  - 实现 `aggregateSessionStatus(deps)`：从 `goalPersistence.load(currentGoalId)` 取 goal，从 `PlanState` 取 plan 步骤，从 `progress-ledger` 取已完成 task，从 `blackboard` 取 projectFacts
  - `summary` 字段：goal.description + 当前执行步骤描述
  - `knownFacts`：blackboard.projectFacts 的 value 列表（最多 8 条）
  - `openQuestions`：plan 中 status=blocked 的步骤 description（最多 8 条）
  - `todos`：plan.steps 映射为 {text: description, done: status==='completed'}
  - `nextAction`：当前 in_progress 步骤的 description
  - 工作量：约 100 行

- **77-9: 实现 `session-status-card.tsx` React 组件**
  - 卡片布局：标题 + 状态徽章 + 摘要 + known_facts 列表 + open_questions 列表 + todos 进度条 + next_action 高亮 + token 预算条
  - 状态徽章颜色：executing(蓝) / paused(黄) / completed(绿) / failed(红)
  - 实时更新：通过现有 `onSpan` 回调或新增 IPC `session:status-updated` 事件触发
  - 工作量：约 150 行

- **77-10: IPC 通道 + 渲染层挂载**
  - 新增 IPC：`session:get-status`（返回当前 SessionStatus 快照）
  - 在 goal 执行期间，每完成一个步骤后刷新状态卡（复用 goal-runner 的 step 完成事件）
  - 挂载位置：goal 执行面板顶部（与现有 GoalExecutionCard 协同，不替换）
  - 工作量：约 50 行

**验证标准**：
1. `pnpm test` 全绿，`session-status-aggregator.test.ts` 覆盖数据聚合
2. `pnpm typecheck` 通过
3. 手动验证：执行 /goal 任务，状态卡实时显示 title/status/summary/knownFacts/todos/nextAction
4. 手动验证：token 预算条随执行进度更新

**回滚方案**：
- `session-status-card.tsx` 是纯新增组件，删除即回滚
- IPC 通道是新增，不影响现有功能
- 数据聚合器是只读操作，不修改任何现有状态

---

### 借鉴点 5：运行回放与评分卡

#### 现有代码分析

RouteDev 的 trace 基础设施已相当完整：

- **`TraceCollector.startSession()`（trace-collector.ts:62）**：创建会话，生成 8 字符 ID
- **`TraceCollector.recordEvent()`（:85）**：记录 ReAct 事件（thinking/tool_call_start/tool_call_result/done/error）
- **`TraceCollector.endSession()`（:347）**：flush 到磁盘
- **`TraceCollector.listSessions(limit=20)`（:490-514）**：

```typescript
async listSessions(limit = 20): Promise<TraceSession[]> {
  const dir = this.getStorageDir();
  const today = new Date().toISOString().slice(0, 10);  // ← 只读当天！
  const dayDir = path.join(dir, today);
  const files = await fs.readdir(dayDir);
  // ... 读取 .session.json
}
```

- **`TraceCollector.readSessionRecords(sessionId)`（:517-531）**：

```typescript
async readSessionRecords(sessionId: string): Promise<TraceRecord[]> {
  const dir = this.getStorageDir();
  const today = new Date().toISOString().slice(0, 10);  // ← 同样只读当天！
  const filePath = path.join(dir, today, `${sessionId}.trace.jsonl`);
  // ... 读取 JSONL
}
```

- **`TraceCollector.summarizeTrajectory()`（:398）**：输出 `TrajectorySummary`（trace-types.ts:158-187），含 totalTokens/toolCallCount/retryCount/firstAttemptSuccessRate/success/terminationReason/durationMs
- **`TraceSpan` 类型（trace-types.ts:91-103）**：含 type/startTime/endTime/durationMs/payload/status
- **`TraceSpanType`（trace-types.ts:24-31）**：react_iteration/tool_call/llm_call/worker_task/goal_step/compose_phase/hook

**关键缺陷**：`listSessions` 和 `readSessionRecords` 都用 `new Date().toISOString().slice(0,10)` 拼路径，**只能读当天目录**（`.routedev/traces/{today}/`）。历史 trace 存在但无法通过这两个方法访问——这是回放的第一个阻塞点。

HomeRail 的 `hr replay <run_id>` 能完整回放 DAG 运行（调研报告 4.5 节），所有事件持久化可回放，scorecard 支持 off/advisory/strict 三模式。

#### 落地可行性

**技术可行性：高**

- trace 数据已落盘为结构化 JSONL，格式完整（TraceRecord 含 timestamp/sessionId/event/data）
- `summarizeTrajectory()` 已输出评分卡所需的大部分指标
- **主要缺口**：
  1. `listSessions`/`readSessionRecords` 的 today-only bug——需修复为扫描所有日期目录
  2. 无 replay 命令/IPC 通道
  3. 无 scorecard 概念和渲染

**改动范围**：
- 修复 `src/harness/trace-collector.ts` 的 `listSessions`/`readSessionRecords`（扫描所有日期目录，约 40 行修改）
- 新增 `src/harness/trace-replayer.ts`（回放引擎，约 200 行）
- 新增 `src/harness/scorecard.ts`（评分卡聚合，约 150 行）
- 新增 IPC 通道 `trace:list-sessions`/`trace:replay`/`trace:scorecard`（约 60 行）
- 新增 `desktop/renderer/.../ReplayView.tsx` 回放 UI（约 200 行）
- 新增 `desktop/renderer/.../ScorecardView.tsx` 评分卡 UI（约 150 行）

**成本分析**：
- **难度：中**（数据已齐，难点在 UI 时间线渲染和 scorecard 指标设计）
- **工作量**：约 800 行（含 UI）
- **预估耗时**：3-4 个开发日

#### 效益分析

**直接效益**：
- **解决痛点**：trace 数据"收集了但不能回放"——`listSessions` 的 today-only bug 导致历史 trace 不可访问；有 `summarizeTrajectory()` 但无 scorecard 呈现
- **量化预期**：
  - 历史回放：修复 today-only bug 后，可回放任意历史 session（当前只能看当天）
  - 评分卡：将 `summarizeTrajectory()` 的指标结构化呈现，预计减少 50% 的"为什么这次执行失败"排查时间
  - agent 行为改进：回放让用户能复盘 agent 的决策路径，识别重复失败模式

**间接效益**：
- 与 Phase 76 的 P0 #1（Harness 闭环回流）协同——回放是"人工审查 trace"，回流是"自动从 trace 学习"，两者输入相同
- 为借鉴点 7（冷启动恢复）提供诊断支持——恢复失败时可回放崩溃前的事件

#### ROI 评估

- **成本：中**（800 行，3-4 日）
- **效益：高**（回放和评分卡对调试和持续改进 agent 行为非常有价值，且与现有 trace/audit 基础设施自然衔接）
- **比值：高 ROI**

#### 落地方案

**Phase：77**

**任务拆解**：

- **77-1: 修复 `listSessions`/`readSessionRecords` 的 today-only 缺陷**
  - `listSessions()`（trace-collector.ts:490）：改为扫描 `getStorageDir()` 下所有日期子目录（`YYYY-MM-DD` 格式），合并所有 `.session.json` 后按 startTime 降序排序取 limit 条
  - `readSessionRecords(sessionId)`（:517）：sessionId 对应的 trace 可能在历史日期目录——改为先扫描所有日期目录查找 `${sessionId}.trace.jsonl`，找到后读取
  - 优化：缓存 `sessionId → filePath` 映射避免每次全盘扫描
  - 工作量：约 40 行修改 + 30 行测试

- **77-2: 实现 `trace-replayer.ts` 回放引擎**
  - `replay(sessionId, options?)`：读取 TraceRecord 列表，按 timestamp 排序，逐条还原为时间线事件
  - 时间线事件类型：`{ timestamp, type: 'thinking'|'tool_call'|'tool_result'|'llm_call'|'error'|'done', summary, detail }`
  - `formatTimeline(records)`：把 TraceRecord 转换为可读时间线文本（markdown 格式）
  - `getStepBoundaries(records)`：识别 goal_step 类型的 span，切分为步骤段落
  - 支持 `--step <n>` 参数只回放指定步骤
  - 工作量：约 200 行

- **77-3: 实现 `scorecard.ts` 评分卡聚合**
  - `generateScorecard(sessionId)`：调用 `summarizeTrajectory()` 获取指标 + 读取 audit-log 的质量信号 + 聚合为 `Scorecard` 结构
  - `Scorecard` 接口：`{ sessionId, goalId?, summary: TrajectorySummary, qualitySignals: {type, severity, count}[], verdict: 'pass'|'advisory'|'fail', checks: {name, passed, detail}[] }`
  - `verdict` 判定规则：
    - `pass`：success=true 且 retryCount <= 2 且无 high severity 信号
    - `advisory`：success=true 但 retryCount > 2 或有 medium severity 信号
    - `fail`：success=false 或有 high severity 信号
  - `checks` 列表：{name:'首次成功率', passed: firstAttemptSuccessRate>=0.8, detail:'70%'} 等
  - 工作量：约 150 行

- **77-4: IPC 通道 + 渲染层桥接**
  - 新增 IPC：
    - `trace:list-sessions`（参数：limit?）→ 返回 `TraceSession[]`
    - `trace:replay`（参数：sessionId, step?）→ 返回时间线事件列表
    - `trace:scorecard`（参数：sessionId）→ 返回 `Scorecard`
  - 在 engine-bridge.ts 注册这三个 handler，桥接到 TraceCollector/TraceReplayer/Scorecard
  - 工作量：约 60 行

- **77-5: 实现 `ReplayView.tsx` 回放 UI**
  - 布局：左侧 session 列表（按时间倒序）+ 右侧时间线详情
  - 时间线渲染：每条事件一行，含时间戳 + 类型图标 + 摘要 + 可展开详情
  - 步骤分段：goal_step span 作为段落分隔符，显示"步骤 N/M"
  - 工具调用高亮：tool_call 事件用不同颜色，展开显示 args/result
  - 工作量：约 200 行

- **77-6: 实现 `ScorecardView.tsx` 评分卡 UI**
  - 布局：顶部 verdict 徽章（pass=绿/advisory=黄/fail=红）+ 指标卡片网格 + 检查项列表
  - 指标卡片：总 Token / 工具调用次数 / LLM 调用次数 / 重试次数 / 首次成功率 / 耗时
  - 检查项列表：每项含 name + passed✓/✗ + detail
  - 质量信号区：按 severity 分组展示
  - 工作量：约 150 行

- **77-7: 测试**
  - `trace-replayer.test.ts`：mock TraceRecord 列表，验证时间线还原和步骤切分
  - `scorecard.test.ts`：验证 verdict 判定规则和 checks 聚合
  - 修复 `listSessions`/`readSessionRecords` 的回归测试
  - 工作量：约 150 行测试

**验证标准**：
1. `pnpm test` 全绿，新增测试覆盖回放和评分卡主流程
2. `pnpm typecheck` 通过
3. 手动验证：执行一个 /goal 任务，结束后通过 IPC `trace:list-sessions` 能列出历史 session（含非当天的）
4. 手动验证：`trace:replay` 返回的时间线能正确还原 thinking → tool_call → tool_result → done 的事件流
5. 手动验证：`trace:scorecard` 返回的 verdict 与 `summarizeTrajectory().success` 一致
6. 手动验证：ReplayView 和 ScorecardView 在渲染层正确渲染

**回滚方案**：
- **代码级回滚**：`trace-replayer.ts` 和 `scorecard.ts` 是纯新增模块，删除即回滚
- **修复回滚**：`listSessions`/`readSessionRecords` 的修改是 bugfix，回滚会恢复 today-only 限制（不推荐回滚此修复）
- **UI 回滚**：ReplayView/ScorecardView 是新增组件，删除即回滚
- **运行时回滚**：IPC 通道是新增，不影响现有功能

---

### 借鉴点 6：Provider Policy 策略

#### 现有代码分析

RouteDev 的 `RouterConfigSchema`（`src/config/schema.ts:139-145`）：

```typescript
const RouterConfigSchema = z.object({
  rules: z.array(RouterRuleSchema).default([]),
  budget: z.preprocess((v) => v ?? {}, TokenBudgetSchema),
  classifierModel: z.preprocess((v) => v === '' ? undefined : v, z.string().min(1).default('deepseek-v4-flash')),
  userPreference: UserPreferenceSchema.default('balanced'),
  fallbackChain: z.array(z.string()).default([]),
});
```

`buildRouterRules()`（`src/router/config.ts:31-99`）修复无效 modelId（unconfigured → 已配置模型替换），生成默认规则。

grep 验证：`prohibited|forbidden|blocklist` 在 `src/config/schema.ts` 中无任何匹配——证实路由配置无 provider/model 级禁止能力。

HomeRail 的 `ProviderPolicyConfig`（调研报告 4.6 节）：

```typescript
export interface ProviderPolicyConfig {
  prohibited_providers?: string[];
  prohibited_models?: string[];
  reason?: string;
}
```

#### 落地可行性

**技术可行性：高**

- 在 `RouterConfigSchema` 加 `prohibitedProviders`/`prohibitedModels` 字段即可
- `buildRouterRules()` 过滤掉禁止的 modelId
- zod schema 校验天然支持

**改动范围**：
- 修改 `src/config/schema.ts`（加字段，约 5 行）
- 修改 `src/router/config.ts`（buildRouterRules 过滤，约 20 行）
- 修改 `src/router/types.ts`（RouterConfig 加字段，约 3 行）
- 新增测试（约 50 行）

**成本分析**：
- **难度：低**（纯配置增强）
- **工作量**：约 80 行
- **预估耗时**：0.5 个开发日

#### 效益分析

**直接效益**：
- **解决痛点**：无——RouteDev 是单用户桌面应用，用户自己配 provider，"禁止某些 provider"的场景极少
- **量化预期**：极低——可能仅在"用户配了多个 provider 但想临时禁用某个"时有用

#### ROI 评估

- **成本：低**（80 行，0.5 日）
- **效益：低**（单用户场景使用频率极低）
- **比值：低 ROI**——虽然成本低，但效益也低，不值得占 Phase 77 名额

#### 结论

**不建议实施**。

理由：
1. RouteDev 是 Electron 桌面单用户应用，用户自己配置 provider——"禁止某些 provider"的场景是"用户禁止自己配的 provider"，逻辑上矛盾
2. HomeRail 的 ProviderPolicy 是为"模板层面禁止某些 provider/model 组合"设计的（多用户/多模板场景），RouteDev 无模板系统
3. 虽然成本低（80 行），但效益也低——不值得占 Phase 77 的 4 个名额之一
4. 若未来确需，可作为路由配置增强附带实施（不单独占 Phase）

---

### 借鉴点 7：冷启动恢复

#### 现有代码分析

RouteDev 的 `GoalPersistence.listResumable()`（`src/agent/goal-persistence.ts:124-134`）**已完整实现**：

```typescript
async listResumable(): Promise<PersistedGoal[]> {
  const files = await this.listGoalFiles(this.goalsDir);
  const goals: PersistedGoal[] = [];
  for (const file of files) {
    const goal = await this.tryReadGoalFile(file);
    if (goal && (goal.status === 'executing' || goal.status === 'paused')) {
      goals.push(goal);
    }
  }
  return goals;
}
```

返回所有 status=executing 或 paused 的 goal。

`goal-runner.ts:1038-1071` 在 goal 执行时调 `goalPersistence.save()` 持久化（status='executing'）：

```typescript
if (goalIntegration?.persistenceEnabled && goalPersistence) {
  await goalPersistence.save({
    id: plan.id,
    spec: { goal: plan.description, /* ... */ },
    plan: { steps: plan.steps.map(/* ... */), /* ... */ },
    status: 'executing',
    // ...
  });
}
```

**关键缺陷**：

1. `app-init.ts:1552` 创建了 `goalPersistence` 实例，但**从未调用 `listResumable()`**（grep 验证）
2. 应用重启后，`.routedev/goals/` 下可能有 status='executing' 的 goal（崩溃时未正常标记为 completed/failed），但无任何代码扫描并恢复
3. `goal-runner.ts` 的 `executeGoalPlan` 是从零开始执行，无"从第 N 步恢复"的逻辑
4. `progress-ledger.ts` 的 `appendProgress` 记录了已完成 task，可作为恢复时"跳过已完成步骤"的依据

HomeRail 的 `recoverAllActiveRuns()`（调研报告 4.7 节）在 Manager 重启时从持久化存储恢复所有活跃 DAG 运行到内存状态机。

#### 落地可行性

**技术可行性：高**

- `listResumable()` 已实现，无需开发
- `progress-ledger.ts` 的 `readProgress()`（:79+）可读取已完成 task，用于跳过已完成步骤
- `PersistedGoal.plan.steps` 含每个步骤的 status，可据此判断从哪恢复
- `graceful-shutdown.ts` 的 `registerShutdownHook` 可注册 goal 状态保存 hook

**主要缺口**：
1. `app-init.ts` 启动时无恢复调用
2. `goal-runner.ts` 无"从 PersistedGoal 恢复执行"的入口（现有 `executeGoalPlan` 从分解开始）
3. 崩溃时 goal 的 status 可能仍是 'executing'（非正常退出未更新），需检测"真崩溃 vs 正在执行"
4. 无 UI 提示用户"检测到未完成的 goal，是否恢复"

**改动范围**：
- 新增 `src/runtime/goal-recovery.ts`（恢复管理器，约 200 行）
- 修改 `src/runtime/app-init.ts`（启动时调 `listResumable`，约 40 行）
- 修改 `src/runtime/goal-runner.ts`（新增 `resumeGoalPlan(persistedGoal)` 入口，约 80 行）
- 新增 IPC 通道 `goal:list-resumable`/`goal:resume`/`goal:discard`（约 50 行）
- 新增 `desktop/renderer/.../RecoveryPrompt.tsx` 恢复提示 UI（约 80 行）
- 注册 shutdown hook 保存 goal 状态（约 30 行）

**成本分析**：
- **难度：中**（listResumable 已就绪，难点在 resumeGoalPlan 的步骤恢复逻辑和 UI 提示）
- **工作量**：约 480 行
- **预估耗时**：3 个开发日

#### 效益分析

**直接效益**：
- **解决痛点**：RouteDev 如果崩溃，正在执行的 goal 状态会丢失——`listResumable()` 已存在但从未被调用，是"接口已就绪但缺触发器"的典型（与 Phase 76 graph.ts 的 improve()/forget() 情况类似）
- **量化预期**：
  - 崩溃恢复：桌面应用崩溃是常见场景（Electron 进程崩溃、系统重启、电源中断），恢复能力将"完全丢失"降级为"从最后检查点续跑"
  - 步骤跳过：结合 `progress-ledger` 的已完成 task 记录，恢复时可跳过已完成的步骤，避免重复执行
  - 预计影响：长 /goal 任务（50+ 步、耗时 30+ 分钟）的崩溃恢复价值最高

**间接效益**：
- 激活 `listResumable()` 这个"死接口"——与 Phase 76 激活 graph.ts 死代码接口同理
- 提升用户对长任务的信心——知道"崩了能恢复"才敢跑长任务
- 与借鉴点 4（状态卡）协同——恢复时展示"上次中断在哪"

#### ROI 评估

- **成本：中**（480 行，3 日，listResumable 已就绪）
- **效益：高**（桌面应用崩溃恢复是关键体验，长任务恢复价值高）
- **比值：高 ROI**

#### 落地方案

**Phase：77**

**任务拆解**：

- **77-11: 实现 `goal-recovery.ts` 恢复管理器**
  - `detectResumableGoals(goalPersistence)`：调用 `goalPersistence.listResumable()`，过滤掉"创建时间超过 24 小时且无更新"的陈旧 goal（避免恢复远古 goal）
  - `validateResumable(goal)`：检查 goal.plan.steps 的 status 字段，识别"部分完成"状态（有 completed 步骤但整体 status 仍为 executing）
  - `buildResumePlan(goal, progressLedger)`：从 PersistedGoal 重建 GoalPlan，结合 progress-ledger 的已完成 task 记录，标记已完成的步骤为 'completed'
  - `shouldRecover(goal)`：判断是否值得恢复——status=executing 且有未完成步骤且 tokenUsed < tokenBudget * 0.95
  - 工作量：约 200 行

- **77-12: 在 `goal-runner.ts` 新增 `resumeGoalPlan` 入口**
  - `resumeGoalPlan(persistedGoal: PersistedGoal, deps)`：跳过"目标分解+确认"阶段，直接从 PersistedGoal.plan 重建执行计划
  - 步骤状态恢复：遍历 plan.steps，对 status='completed' 的步骤跳过，对 status='in_progress' 的步骤重新执行（从该步开始）
  - token 预算继承：用 `persistedGoal.tokenUsed` 作为起始已用，`persistedGoal.tokenBudget` 作为预算上限
  - 复用现有 `executeGoalPlan` 的执行核心（DualLoop + CompletionGate + HookRunner）
  - 工作量：约 80 行

- **77-13: 在 `app-init.ts` 启动时调用恢复检测**
  - 在 `createAppDependencies()` 末尾（所有依赖创建完成后），调用 `detectResumableGoals(goalPersistence)`
  - 检测到可恢复 goal 时，不自动恢复（需用户确认），而是通过 IPC 推送到渲染层显示恢复提示
  - fail-open：恢复检测失败只记日志，不阻塞应用启动
  - 工作量：约 40 行

- **77-14: 注册 shutdown hook 保存 goal 状态**
  - 在 `app-init.ts` 注册 `registerShutdownHook(80, 'goal-state-persist', async () => { ... })`
  - 优先级 80（高于 codemap-watcher 的 50，低于 session-memory 的 100）
  - 逻辑：遍历当前正在执行的 goal，更新 `updatedAt` 和 `tokenUsed` 后调 `goalPersistence.save()`
  - 工作量：约 30 行

- **77-15: IPC 通道 + 恢复提示 UI**
  - 新增 IPC：
    - `goal:list-resumable`（无参数）→ 返回 `PersistedGoal[]`（含 progressReport 摘要）
    - `goal:resume`（参数：goalId）→ 触发 `resumeGoalPlan`
    - `goal:discard`（参数：goalId）→ 调 `goalPersistence.archive(goalId)` 归档放弃
  - 新增 `RecoveryPrompt.tsx` 组件：
    - 应用启动时若有可恢复 goal，在主界面顶部显示提示条
    - 每个可恢复 goal 显示：标题 + 进度（completed/total 步）+ token 使用 + "恢复"/"放弃"按钮
    - 用户点"恢复"→ 调 `goal:resume` IPC → 进入 goal 执行面板
    - 用户点"放弃"→ 调 `goal:discard` IPC → 归档 goal，提示条消失
  - 工作量：约 130 行（50 IPC + 80 UI）

- **77-16: 测试**
  - `goal-recovery.test.ts`：mock PersistedGoal（含 executing/paused/completed 状态），验证 detectResumableGoals 过滤逻辑和 buildResumePlan 步骤状态恢复
  - `goal-runner.test.ts` 扩展：验证 resumeGoalPlan 跳过已完成步骤
  - 工作量：约 100 行测试

**验证标准**：
1. `pnpm test` 全绿，新增测试覆盖恢复检测和步骤跳过
2. `pnpm typecheck` 通过
3. 手动验证：执行一个 /goal 任务到第 3 步时强制关闭应用（模拟崩溃），重启后 RecoveryPrompt 显示该 goal 可恢复
4. 手动验证：点"恢复"后，goal 从第 3 步（in_progress）继续执行，前 2 步（completed）不重复执行
5. 手动验证：点"放弃"后，goal 文件移到 archived/，提示条消失
6. 手动验证：正常 shutdown 时 goal 状态被保存（updatedAt 更新）

**回滚方案**：
- **代码级回滚**：`goal-recovery.ts` 是纯新增模块，删除即回滚；`app-init.ts` 的恢复检测调用可独立 revert
- **数据级回滚**：恢复不会修改 PersistedGoal 的原始数据（只读 listResumable）；放弃恢复的 goal 被 archive 到 archived/，可手动移回
- **运行时回滚**：恢复检测加 `enabled` 配置开关（`config.goal.recoveryEnabled`，默认 true），可在设置面板关闭
- **shutdown hook 回滚**：`registerShutdownHook` 的调用可独立 revert，不影响其他 shutdown hook

---

## Phase 77 整体规划

### 建议纳入的借鉴点（3 个）

| 借鉴点 | 任务编号 | 工作量 | 理由 |
|--------|---------|--------|------|
| 借鉴点 5 运行回放与评分卡 | 77-1 ~ 77-7 | 约 950 行 | ROI 高，trace 数据已落盘，缺口在回放命令和 scorecard 渲染；修复 listSessions today-only bug 是必要 bugfix |
| 借鉴点 7 冷启动恢复 | 77-11 ~ 77-16 | 约 580 行 | ROI 高，`listResumable()` 已实现但从未被调用；桌面应用崩溃恢复是关键体验 |
| 借鉴点 4 Voice Memo 式会话状态卡 | 77-8 ~ 77-10 | 约 300 行 | ROI 中，数据已齐，与回放/恢复协同提升可观测性 |

**Phase 77 总工作量**：约 1830 行（含测试），预估 8-10 个开发日

### 建议推迟的借鉴点（2 个）

| 借鉴点 | 推迟到 | 理由 |
|--------|--------|------|
| 借鉴点 1 端口化 DAG 引擎 | Phase 78+ | 成本高（800-1000 行架构级重写），桌面单用户 DAG 复杂流程需求不强；PathRouter 已动态选路径 |
| 借鉴点 3 多 Harness 适配器架构 | 待需要时 | RouteDev 走标准 LLM API，当前 ILLMClient 够用；agent loop 是核心资产，委托给外部 harness 得不偿失 |

### 不建议实施的借鉴点（2 个）

| 借鉴点 | 理由 |
|--------|------|
| 借鉴点 2 DAG Actor 模型消息传递 | blackboard.ts 已覆盖多 agent 共享状态；单进程下直接消息传递收益有限；硬依赖已推迟的借鉴点 1 |
| 借鉴点 6 Provider Policy 策略 | 单用户桌面场景，用户自己配 provider，"禁止自己的 provider"逻辑矛盾；HomeRail 的 ProviderPolicy 是多用户/多模板场景设计 |

### Phase 77 的整体目标

**主题**：从"会执行的 agent"升级为"可观察、可恢复的 agent"——补齐运行可观测性与崩溃恢复能力

**三条并行主线**：

1. **运行回放与评分卡主线（77-1 ~ 77-7）**：
   - 修复 trace 历史访问缺陷 → 回放引擎 → 评分卡聚合 → IPC 桥接 → 回放/评分卡 UI
   - 这是 HomeRail `hr replay` / `hr scorecard` 在 RouteDev 的桌面化落地，与现有 trace-collector/audit-logger 自然衔接

2. **冷启动恢复主线（77-11 ~ 77-16）**：
   - 恢复检测（激活 `listResumable()` 死接口）→ 步骤状态恢复 → 启动时检测 → shutdown hook 保存 → 恢复提示 UI
   - 激活"已实现但从未被调用"的 `listResumable()`，与 Phase 76 激活 graph.ts 死代码接口同理

3. **会话状态卡主线（77-8 ~ 77-10）**：
   - 数据聚合（goal/plan/ledger/blackboard）→ React 状态卡组件 → IPC 桥接
   - HomeRail Voice Memo 模式的桌面化落地，提供"一眼能看懂"的会话状态摘要

**主线间的协同**：
- 借鉴点 5（回放）与借鉴点 4（状态卡）互补：状态卡是"当前快照"，回放是"历史时间线"
- 借鉴点 7（恢复）与借鉴点 4（状态卡）协同：恢复时状态卡展示"上次中断在哪"
- 借鉴点 5（回放）与借鉴点 7（恢复）协同：恢复失败时可回放崩溃前的事件诊断原因

**与 Phase 76 的关系**：
- Phase 76（论文借鉴）：Harness 闭环回流 + Memory Dreaming + ICF 干扰剔除——**离线学习**方向
- Phase 77（HomeRail 借鉴）：运行回放 + 冷启动恢复 + 会话状态卡——**运行可观测与恢复**方向
- 两者**完全正交**，无任何任务/代码重叠，可并行实施

### 任务依赖关系

```
77-1 (修复 listSessions) ──→ 77-2 (回放引擎) ──→ 77-4 (IPC) ──→ 77-5 (回放UI)
                                    ↓
                              77-3 (评分卡) ──→ 77-4 (IPC) ──→ 77-6 (评分卡UI)
                                                                    ↓
                                                              77-7 (测试)

77-11 (恢复管理器) ──→ 77-12 (resumeGoalPlan) ──→ 77-13 (app-init 启动检测)
                              ↓                        ↓
                    77-14 (shutdown hook)    77-15 (IPC + 恢复UI)
                                                    ↓
                                              77-16 (测试)

77-8 (状态聚合器) ──→ 77-9 (状态卡组件) ──→ 77-10 (IPC + 挂载)
```

**建议执行顺序**（按批次）：
- **批次 1**（核心基础）：77-1（修复 listSessions）+ 77-11（恢复管理器）+ 77-8（状态聚合器）——三者独立，可并行
- **批次 2**（引擎层）：77-2（回放引擎）+ 77-3（评分卡）+ 77-12（resumeGoalPlan）+ 77-14（shutdown hook）——依赖批次 1
- **批次 3**（桥接层）：77-4（IPC）+ 77-13（app-init 启动检测）+ 77-15（恢复 IPC+UI）+ 77-10（状态卡 IPC）——依赖批次 2
- **批次 4**（UI 层）：77-5（回放 UI）+ 77-6（评分卡 UI）——依赖批次 3 的 IPC
- **批次 5**（验证）：77-7（测试）+ 77-16（测试）——贯穿全程，每批次完成后增量补充

### 验证标准（Phase 77 整体）

1. `pnpm test` 全绿，新增测试覆盖回放/评分卡/恢复/状态卡主流程
2. `pnpm typecheck` 通过
3. **端到端验证**：
   - 执行一个 5 步 /goal 任务，第 3 步时强制关闭应用（模拟崩溃）
   - 重启应用 → RecoveryPrompt 显示可恢复 goal（借鉴点 7）
   - 点"恢复" → 状态卡显示当前恢复位置（借鉴点 4）→ goal 从第 3 步继续
   - 任务完成后 → 通过回放 UI 查看完整时间线（借鉴点 5）→ 评分卡显示 verdict=pass（借鉴点 5）
4. **历史回放验证**：通过 IPC `trace:list-sessions` 能列出非当天的历史 session（验证 77-1 修复）

### 风险矩阵

| 风险 | 来源借鉴点 | 严重度 | 概率 | 缓解措施 |
|------|-----------|--------|------|----------|
| `listSessions`/`readSessionRecords` 修改引入回归 | 借鉴点 5 | 中 | 低 | 修改是扩大扫描范围（当天 → 所有日期），原有当天行为是子集；加回归测试覆盖 |
| 回放 UI 时间线渲染性能差（长任务 trace 大） | 借鉴点 5 | 中 | 中 | 分页加载（每次 100 条 record）+ 虚拟滚动；设置 maxRecords 上限（如 5000） |
| 评分卡 verdict 判定规则不准确 | 借鉴点 5 | 低 | 中 | 初期用 advisory 模式（只提示不阻断），收集用户反馈后调整阈值 |
| `resumeGoalPlan` 步骤状态恢复错误（漏执行/重复执行） | 借鉴点 7 | 高 | 中 | 结合 progress-ledger 的已完成 task 记录双重验证；恢复前显示"将跳过 N 步，从第 M 步开始"供用户确认 |
| 崩溃时 goal.status 仍是 'executing' 导致误恢复 | 借鉴点 7 | 中 | 中 | 加"陈旧检测"：createdAt 超过 24 小时且无 updatedAt 更新的 goal 不自动恢复，需用户手动确认 |
| shutdown hook 保存 goal 状态时再次崩溃 | 借鉴点 7 | 低 | 低 | shutdown hook 用 try-catch 包裹，fail-open；save() 是原子写（writeFile），不会产生半写文件 |
| 状态卡数据聚合性能差（多个数据源读取） | 借鉴点 4 | 低 | 低 | 数据源都是内存或本地文件；缓存 SessionStatus，每 5 秒刷新一次而非每步刷新 |
| 恢复的 goal 依赖的上下文（conversation history）已丢失 | 借鉴点 7 | 高 | 中 | 恢复时重建上下文：从 PersistedGoal.spec + progress-ledger + goal Persistence 重建；不依赖原 conversation history |
| Phase 77 工作量超预期 | 全部 | 中 | 中 | 优先级：77-1~77-7（借鉴点 5）> 77-11~77-16（借鉴点 7）> 77-8~77-10（借鉴点 4）；若超期可把借鉴点 4 推迟到 Phase 78 |

---

## 附录：代码位置索引

### 借鉴点 5（运行回放与评分卡）相关代码位置

| 位置 | 说明 |
|------|------|
| `src/harness/trace-collector.ts:490` `listSessions()` | **需修复**：today-only bug（:493 `new Date().toISOString().slice(0,10)`） |
| `src/harness/trace-collector.ts:517` `readSessionRecords()` | **需修复**：today-only bug（:519 同上） |
| `src/harness/trace-collector.ts:398` `summarizeTrajectory()` | 评分卡指标来源（TrajectorySummary） |
| `src/harness/trace-collector.ts:347` `endSession()` | flush 到磁盘 |
| `src/harness/trace-types.ts:91-103` `TraceSpan` | span 类型定义 |
| `src/harness/trace-types.ts:106-112` `TraceRecord` | JSONL 一行格式 |
| `src/harness/trace-types.ts:158-187` `TrajectorySummary` | 评分卡指标结构 |
| `src/harness/audit-logger.ts:40-45` `HashChainRecord` | 审计日志（含哈希链） |
| `src/harness/audit-logger.ts:19-25` `QualityMetadata` | 质量信号元数据 |
| `desktop/main/engine-bridge.ts:279` `trace.startSession` | 现有 trace 接入点 |

### 借鉴点 7（冷启动恢复）相关代码位置

| 位置 | 说明 |
|------|------|
| `src/agent/goal-persistence.ts:124-134` `listResumable()` | **已实现但从未被调用**（核心激活对象） |
| `src/agent/goal-persistence.ts:89-95` `save()` | goal 持久化写入 |
| `src/agent/goal-persistence.ts:102-117` `load()` | goal 读取 |
| `src/agent/goal-persistence.ts:155-169` `archive()` | goal 归档（放弃恢复时用） |
| `src/agent/goal-persistence.ts:36-66` `PersistedGoal` | 持久化结构 |
| `src/runtime/goal-runner.ts:1038-1071` | goal 执行时 save（status='executing'） |
| `src/runtime/app-init.ts:1552` | `new GoalPersistence(cwd)` 创建点（**恢复调用应加在此处之后**） |
| `src/runtime/app-init.ts:2327` | goalPersistence 传给 goal-runner |
| `src/runtime/graceful-shutdown.ts:76-98` `registerShutdownHook()` | shutdown hook 注册（保存 goal 状态） |
| `src/agent/progress-ledger.ts:71-76` `appendProgress()` | 已完成 task 记录（恢复时跳过已完成步骤的依据） |
| `src/agent/progress-ledger.ts:79+` `readProgress()` | 读取已完成 task（恢复时用） |

### 借鉴点 4（会话状态卡）相关代码位置

| 位置 | 说明 |
|------|------|
| `src/agent/goal-persistence.ts:36-66` `PersistedGoal` | 状态卡数据源 1（goal/spec/plan/status） |
| `src/agent/context/plan-state.ts` `PlanState` | 状态卡数据源 2（步骤状态） |
| `src/agent/progress-ledger.ts:22-37` `ProgressEntry` | 状态卡数据源 3（已完成 task） |
| `src/agent/multi/blackboard.ts:13-15` | 状态卡数据源 4（currentGoal/completedSteps/projectFacts） |
| `src/runtime/components/goal-progress.ts` `renderGoalProgressText` | 现有 goal 进度渲染（状态卡可复用） |
| `src/runtime/goal-runner.ts:978` `bounded-recovery-attempted` 事件 | goal 事件流（状态卡刷新触发点） |

### 借鉴点 1/2/3/6 相关代码位置（未纳入 Phase 77，仅作索引）

| 位置 | 说明 |
|------|------|
| `src/agent/workflow/dag-engine.ts:17-26` `DagNode` | 借鉴点 1：无 outputs/ports 字段 |
| `src/agent/workflow/dag-engine.ts:182-227` `execute()` | 借鉴点 1：分层并行，非事件驱动 |
| `src/agent/multi/blackboard.ts:12-70` `Blackboard` | 借鉴点 2：已覆盖共享状态 |
| `src/router/types.ts:232-244` `ILLMClient` | 借鉴点 3：API client 抽象（非 harness） |
| `src/router/llm/` | 借鉴点 3：6 个 provider client |
| `src/config/schema.ts:139-145` `RouterConfigSchema` | 借鉴点 6：无 prohibited 字段 |
| `src/router/config.ts:31-99` `buildRouterRules()` | 借鉴点 6：路由规则构建 |

---

## 一句话总结

**Phase 77 聚焦"运行回放与评分卡 + 冷启动恢复 + 会话状态卡"三条主线，约 1830 行工作量，8-10 个开发日；借鉴点 1（端口化 DAG）和借鉴点 3（多 Harness）因成本高/无需求推迟；借鉴点 2（Actor 模型）和借鉴点 6（Provider Policy）因 blackboard 已覆盖/场景矛盾不建议实施。Phase 77 与 Phase 76（离线学习）完全正交，两者正交互补。**
