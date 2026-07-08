# HomeRail 源码级调研报告

> 调研对象：https://github.com/xiaotianfotos/homerail.git (main 分支)
> 调研方法：GitHub API + raw 源码抓取，共分析 20+ 核心 .ts 文件
> 调研日期：2026-07-08
> 对比对象：RouteDev（Electron 桌面单用户应用）

---

## 1. 项目概述

### 1.1 定位与设计理念

HomeRail 是一个 **TypeScript 运行时**，把一次性的 agent 对话转化为可审计、可复用的 DAG 工作流。名字即设计：

- **Home** — 运行在 homelab / NAS / 家庭服务器上，服务于那里的人
- **Rail** — DAG 的轨道形态，agent 工作沿显式边流动，而非堆积在聊天窗口

核心设计赌注（引自 ROADMAP.md）：

> Attention is the scarcest resource; everything here aims to spend less of it.

系统形态是一个**朝机器一侧张开的喇叭口**：人这一端窄（语音输入、生成式 UI 输出），机器那一端宽（多 agent、多节点、多环境的 DAG 编排）。

**重要定位澄清**（ROADMAP.md 明确声明）：

- HomeRail **不是**软件开发/开发自动化工具 — 因为软件是最难评估的结果
- HomeRail **不构建** agent harness — 它编排 Claude Agent SDK / Codex / Kimi 等已有 harness
- HomeRail **不是**通用作业运行器 — DAG 围绕 agent 协作和证据交接设计
- HomeRail **不是**托管 SaaS — 运行在操作者拥有的硬件上

### 1.2 与 RouteDev 的定位差异

| 维度 | HomeRail | RouteDev |
|------|----------|----------|
| **部署形态** | 服务端多用户（NAS/家庭服务器常驻） | Electron 桌面单用户 |
| **目标场景** | 易评估结果（视频、报告、配置好的系统） | 软件开发（SWE-bench 类编码任务） |
| **交互入口** | 语音优先，CLI 次之，浏览器 UI 第三 | 桌面 UI 优先 |
| **执行模型** | DAG 多节点编排，每节点独立上下文窗口 | 单 Agent 串行为主，DAG/Compose 为辅 |
| **隔离方式** | Docker 容器（每节点一个容器） | git worktree（experiment-manager） |
| **成熟度** | DAG 运行时最成熟，语音/UI 探索中 | Agent Loop + Dual Loop 成熟，DAG 较简单 |

---

## 2. 架构分析

### 2.1 Monorepo 结构

根 `package.json` 定义了 6 个包，通过 `npm --prefix` 逐个构建（非 workspace 协议）：

```
homerail/
├── homerail_protocol/   # 共享消息与校验契约 — 运行时通信的单一真相源
├── homerail_manager/    # Manager 服务 + DAG 协调器 + 语音面 + 生成式 UI 契约
├── homerail_node/       # Node 服务 — Docker Worker 容器管理
├── homerail_worker/     # Worker 运行时 — harness 适配器
├── homerail_cli/        # hr CLI
├── agent-ui/            # 解耦的浏览器 UI（Vite + React）
├── assets/              # DAG 模板、profile 模板
└── skills/              # 技能系统
```

### 2.2 包间依赖关系

```
homerail_protocol ← (被所有包依赖，单一真相源)
       ↑
homerail_manager (DAG 引擎、HTTP server、语音面)
       ↑                    ↑
homerail_cli (HTTP 客户端)   homerail_node (Docker 容器管理)
                               ↑
                          homerail_worker (harness 适配器，运行在容器内)
                               ↑
                          agent-ui (浏览器 UI，通过 HTTP/WS 连 Manager)
```

关键设计决策：
- **Protocol 是唯一的类型真相源** — `homerail_protocol` 被 worker、manager、cli 共同依赖，所有跨进程通信类型在此定义
- **Manager 不运行在 Worker 镜像中** — Manager 和 Node 是本地服务，Node 负责拉起 Worker 容器
- **Worker 通过 WebSocket 回连 Manager** — URL 格式：`ws://localhost:19191/ws/projects/default/workers/{workerId}`

### 2.3 核心数据流

```
用户 → [语音/CLI/浏览器UI] → Manager HTTP Server
                                    ↓
                            DAG 引擎 (orchestration/dag-engine.ts)
                                    ↓
                            节点调度 (runtime/active-runs.ts, 50KB)
                                    ↓
                            Node 服务 → Docker 容器
                                    ↓
                            Worker (homerail_worker/index.ts)
                                    ↓
                            PromptRunner (prompt-runner.ts)
                                    ↓
                            Agent Factory → Claude SDK / Codex / Kimi
                                    ↓
                            DAG Tools (handoff/send_message/receive_message)
                                    ↓
                            WS 流式回传 → Manager → 用户
```

---

## 3. 核心模块源码分析

### 3.1 DAG 引擎（homerail_manager）

#### 3.1.1 图数据结构

**文件**：`homerail_manager/src/orchestration/graph.ts`

```typescript
export interface DAGEdge {
  from_node: string;
  from_port: string;      // 端口概念 — handoff 通过端口匹配下游边
  to_node: string;
  to_port: string;
  condition: string;       // "on_success" | "on_failure" | "always"
  label?: string;          // "after_dep" 表示纯依赖，无数据传递
  retry_policy?: DAGEdgeRetryPolicy;
}

export interface DAGGraphNode {
  node_id: string;
  node_type: string;       // 支持 "loop_gateway" 等网关类型
  agent: string;
  after: string[];         // 声明式依赖
  outputs: Record<string, DAGOutputRoute>;  // 端口路由表
  gateway_config?: DAGGatewayConfig;         // 循环/条件网关配置
}

export interface ParsedDAG {
  meta: ResolvedWorkflowMeta;
  graph: DAGGraphData;     // nodes + edges
  loop_sources: string[];  // 循环源节点列表
}
```

**关键设计**：
- **端口（Port）机制** — 每个节点有输入/输出端口，handoff 时通过 `from_port` 匹配下游边，实现条件路由
- **两类边**：`after_dep`（纯依赖，无数据传递）和显式边（携带内容到 mailbox）
- **网关节点** — 支持 `loop_gateway` 和 `condition` 类型，实现循环和条件分支
- **Scorecard 策略** — 内建评分卡配置（`ScorecardPolicyConfig`），支持 `off/advisory/strict` 三种模式

#### 3.1.2 DAG 状态机

**文件**：`homerail_manager/src/orchestration/dag-engine.ts` (11KB)

```typescript
export type NodeState =
  | "PENDING" | "READY" | "RUNNING"
  | "COMPLETED" | "FAILED" | "CANCELLED" | "SKIPPED";

export interface DAGRun {
  runId: string;
  graph: DAGGraphData;
  loopSources: Set<string>;
  nodeStates: Map<string, NodeState>;
  handoffedNodes: Set<string>;
  afterSatisfied: Map<string, Set<string>>;    // 依赖满足追踪
  inputSatisfied: Map<string, Set<string>>;     // 输入满足追踪
  mailboxes: Map<string, Map<string, unknown[]>>;  // 每节点每端口的消息队列
}
```

**核心函数**：

1. **`createDAGRun(parsedDAG, runId)`** — 初始化所有节点状态，无 `after_dep` 的节点为 READY，否则 PENDING

2. **`handoff(run, fromNode, port, content)`** — 最核心的交接函数：
   ```typescript
   // 1. 匹配下游边：from_port === port 且 condition 匹配
   const matchingDownstream = run.graph.edges.filter(
     (edge) => edge.from_node === fromNode &&
                edge.label !== "after_dep" &&
                edgeMatchesHandoff(edge, port)
   );
   // 2. 终端失败检测：失败端口 + 无下游 = terminalFailure
   const terminalFailure = isFailurePort(port) && matchingDownstream.length === 0;
   // 3. 更新源节点状态（loop source 保持 RUNNING，否则 COMPLETED）
   // 4. 内容投递到下游 mailbox
   // 5. 满足 after_dep → 尝试提升 PENDING → READY
   // 6. 跳过未走分支（_skipUntakenSatisfiedBranches）
   // 7. 唤醒 loop source / loop gateway receiver
   // 8. 终端失败时递归跳过依赖链（_skipDependentNodes）
   ```

3. **`failNode(run, nodeId, errorData)`** — 节点失败处理，路由到 `on_failure`/`always` 边，递归跳过 `on_success` 下游

4. **`isRunTerminal(run)`** — 判断运行是否结束（无 READY/RUNNING/PENDING 节点）

**失败端口约定**：
```typescript
export const FAILURE_PORTS = new Set(["failed", "failure", "rejected", "error"]);
```

#### 3.1.3 消息路由

**文件**：`homerail_manager/src/orchestration/dag-message-router.ts` (6.7KB)

实现了节点间消息的异步投递，采用 **pending inbox + waiters** 模式：

```typescript
const pendingInbox = new Map<string, RoutedNodeMessage[]>();  // 按(runId:nodeId)索引
const waiters = new Map<string, DeliveryTarget>();              // 等待接收的节点

// send_message: 先查 waiter 直接投递，否则查 dispatch target，最后入队
// receive_message: 先查 pending 直接投递，否则注册 waiter
```

这实现了 **actor 模型风格的消息传递** — 节点可以异步 send 和 receive，消息在 Manager 侧排队。

#### 3.1.4 与 RouteDev 的 /goal + PathRouter 对比

| 维度 | HomeRail DAG 引擎 | RouteDev DagEngine + PathRouter |
|------|-------------------|---------------------------------|
| **图模型** | 端口化有向图（from_port → to_port），支持条件路由 | 依赖列表（dependsOn），无端口概念 |
| **执行模型** | 事件驱动状态机（handoff/failNode 驱动状态转换） | 分层并行（Kahn 拓扑排序 + Promise.all） |
| **数据传递** | mailbox 队列 + 端口路由，内容随 handoff 流动 | 无显式数据传递，靠变量替换 `{{variable}}` |
| **条件分支** | `on_success`/`on_failure`/`always` + failure ports | 无条件分支 |
| **循环** | loop_gateway + loop_sources，mailbox 唤醒机制 | 不支持循环 |
| **重试** | 边级 `retry_policy.max_retries` | 节点级 `retryLimit` + `humanEscalationThreshold` |
| **路由策略** | 模板 YAML 预定义 DAG 结构 | PathRouter 按难度/步骤数/领域数动态选择 single/dag/compose |
| **成熟度** | 非常成熟（50KB active-runs.ts + 11KB dag-engine + 完整回放/评分卡/eval） | 基础可用（313 行，Kahn 算法 + 分层并行） |

**结论**：HomeRail 的 DAG 引擎在图模型、数据传递、条件分支、循环支持上**远超** RouteDev。但 RouteDev 的 PathRouter 有一个 HomeRail 没有的能力：**运行时动态路由**（按难度评估结果选择执行路径），而 HomeRail 的 DAG 结构是模板预定义的。

---

### 3.2 Protocol 契约（homerail_protocol）

#### 3.2.1 类型系统

**文件**：`homerail_protocol/src/types.ts` (12KB)

```typescript
// Agent 后端类型枚举 — 多 harness 支持
export const AgentClientType = {
  CLAUDE: "claude",
  CODEX: "codex",
  CODEX_APPSERVER: "codex_appserver",  // 推荐的语音 harness
  KIMI: "kimi",
  PI_MONO: "pi_mono",
} as const;

// 消息类型 — 支持同步/异步/流式
export const MessageType = {
  REQUEST: "request",
  RESPONSE: "response",
  EVENT: "event",
  STREAM: "stream",
  ASYNC_REQUEST: "async_request",
  ASYNC_RESPONSE: "async_response",
  ASYNC_PROGRESS: "async_progress",
  ASYNC_CONTROL: "async_control",
} as const;
```

**DAG 通信核心类型**：

```typescript
// 交接请求 — agent 通过 handoff 工具将内容交给下游节点
export interface HandoffRequest {
  port: string;        // 输出端口名
  content: unknown;    // 交接内容
  summary?: string;    // 摘要
}

// 图上下文 — 注入给 agent，让它知道自己在图中的位置
export interface GraphContext {
  node_id: string;
  predecessors: EdgeRef[];    // 前驱节点
  successors: EdgeRef[];      // 后继节点
  available_ports: string[];  // 可用输出端口
  graph_nodes: string[];      // 全图节点列表
}

// 线上事件类型 — 用于回放和审计
export type WireEvent =
  | HandoffEvent          // 节点交接
  | SendMessageEvent      // 节点发送消息
  | ReceiveMessageEvent   // 节点接收消息
  | ResumeRequestEvent;   // 恢复请求
```

#### 3.2.2 JSON Schema 验证

**文件**：`homerail_protocol/src/schemas.ts` (12.5KB)

所有协议消息都有 Draft-07 JSON Schema 定义，通过 `allSchemas` 索引注册到验证器：

```typescript
export const allSchemas: Record<string, Record<string, unknown>> = {
  "handoff-request": handoffRequestSchema,
  "handoff-response": handoffResponseSchema,
  "tool-call": toolCallSchema,
  "tool-result": toolResultSchema,
  "send-message": sendMessageSchema,
  "receive-message": receiveMessageSchema,
  "graph-context": graphContextSchema,
  "agent-config": agentConfigSchema,
  "dag-node-config": dagNodeConfigSchema,
  "message-base": messageBaseSchema,
  "request": requestSchema,
  "response": responseSchema,
  "event": eventSchema,
  "stream-message": streamMessageSchema,
  "async-request": asyncRequestSchema,
  "async-response": asyncResponseSchema,
  "async-progress": asyncProgressSchema,
  "async-control": asyncControlSchema,
  "async-result": asyncResultSchema,
};
```

#### 3.2.3 与 RouteDev 的 IPC + engine-bridge 对比

| 维度 | HomeRail Protocol | RouteDev IPC + engine-bridge |
|------|-------------------|------------------------------|
| **契约位置** | 独立包 `homerail_protocol`，所有包共享 | `desktop/shared/ipc-types.ts` + 各模块自有类型 |
| **验证** | JSON Schema Draft-07，运行时可校验 | TypeScript 类型，编译时检查 |
| **消息模式** | request/response/event/stream/async 全覆盖 | IPC 请求-响应为主 |
| **版本化** | 每个类型标注 `@version 0.1.0` | 无显式版本 |
| **DAG 感知** | 内建 HandoffRequest/GraphContext/WireEvent | 无 DAG 通信类型 |

**结论**：HomeRail 的协议设计更正式、更完整（JSON Schema 验证 + 版本化 + 异步消息模式），但 RouteDev 作为单进程 Electron 应用，IPC 的简洁性是合理的权衡。

---

### 3.3 Worker Harness（homerail_worker）

#### 3.3.1 Worker 入口

**文件**：`homerail_worker/src/index.ts` (8.9KB)

两种运行模式：
1. **MANAGER_AGENT_MODE=1** — 启动 Manager Agent 服务器（语音界面后端）
2. **普通 Worker 模式** — 连接 Manager WS，接收 task 事件

```typescript
// Worker 连接 Manager 的 WS URL
const MANAGER_WS_URL =
  process.env.MANAGER_WORKER_WS_URL ??
  `${DEFAULT_MANAGER_WS_BASE}/ws/projects/default/workers/${encodeURIComponent(WORKER_ID)}`;

// 事件处理
client.on("task", async (msg) => {
  // 解析 envelope（来自 TS Manager 的封装）
  const envelope = msg.envelope;
  const runId = envelope?.runId;
  const nodeId = envelope?.nodeId;
  const agentConfig = envelope?.agentConfig;
  
  // 解析后端类型
  const backend = resolveWorkerAgentBackend({
    agentType,
    envBackend: process.env.AGENT_BACKEND,
    hasManagerEnvelope: Boolean(envelope),
  });
  
  // 构造 PromptJob 并执行
  const job: PromptJob = { task, runId, dagConfig, systemPrompt, llmProvider, ... };
  await runPrompt(job, { wsSend, agentBackend: backend, abortSignal, registerInboxHandler });
});
```

还支持：
- **`inject` 事件** — Manager 可中断正在运行的节点（`mode: "interrupt"` → `abortController.abort()`）
- **`dag_inbox` 事件** — 投递其他节点的消息到当前节点的 inbox handler

#### 3.3.2 Prompt Runner — Harness 适配核心

**文件**：`homerail_worker/src/prompt-runner.ts` (15KB)

这是 Worker 的核心，负责：
1. 创建 Agent 客户端（通过 `createAgentClient(agentBackend)` 工厂）
2. 创建 DAG 工具状态（handoff/send_message/receive_message）
3. 流式处理 agent 事件并回传 Manager
4. 审计日志 + 会话存储

```typescript
export async function runPrompt(job: PromptJob, deps: PromptRunnerDeps): Promise<void> {
  const agent = createAgentClient(agentBackend);  // harness 工厂
  const dagState = createDagToolsState(job.dagConfig, job.runId, wsSend);
  const dagTools = createDagTools(dagState);       // handoff/send/receive 工具
  
  for await (const event of agent.run(job.task, dagTools, context)) {
    switch (event.type) {
      case "text":      sendContent(event.text); break;
      case "tool_use":  sendStream({ event: "tool_use", ... }); break;
      case "tool_result": sendStream({ event: "tool_result", ... }); break;
      case "usage":     Object.assign(nodeUsage, event.usage); break;
      case "done":      /* 记录 duration/turns */ break;
      case "error":     sendContent(`[ERROR] ${event.message}`); break;
    }
    if (dagState.yielded) { emitUsage(); break; }  // handoff 后提前退出
  }
  
  if (!dagState.yielded) {
    sendNodeError("agent ended without DAG handoff");  // 必须显式 handoff
  }
}
```

**关键设计**：
- **Secret 脱敏** — 内建 `redactToolTelemetry()` 函数，自动识别并脱敏 api_key/token/password 等敏感信息
- **Usage 跟踪** — 每个 DAG 节点记录 input_tokens/output_tokens/cache_read/cache_creation/duration_ms/num_turns
- **Checkpoint Resume** — 支持 `checkpointResume`（parentSessionId + entryUuid + instruction + attempt）
- **Session 持久化** — `appendTranscriptEntry()` + `saveSession()` 最佳努力写入

#### 3.3.3 Agent Runtime Resolver — Harness 选择

**文件**：`homerail_manager/src/runtime/agent-runtime-resolver.ts` (7.7KB)

```typescript
export type AgentRuntimeSurface = "manager_agent" | "dag";

export function resolveAgentRuntimeConfig(input: AgentRuntimeResolutionInput): AgentRuntimeResolution {
  // 1. 特殊处理 codex_appserver（Manager Agent 语音面专用）
  if (requested === "codex_appserver" && input.surface === "manager_agent") {
    return { agent_type: "codex_appserver", runtime_placement: "host_shell", ... };
  }
  
  // 2. 按 provider 查找 LLM setting
  const setting = settingForInput(input);
  
  // 3. 按 setting 决定 agent_type
  //    - Kimi provider → kimi_code harness
  //    - 其他 → claude-sdk（默认）或用户指定
  
  // 4. 运行时放置策略
  //    - codex_appserver → HOST_SHELL
  //    - Windows → HOST_SHELL（容器兼容性问题）
  //    - 其他 → CONTAINER
}
```

**支持的 Harness**：

| Harness | agent_type | 协议要求 | 运行时放置 | 语音 commentary |
|---------|-----------|---------|-----------|----------------|
| Claude Agent SDK | `claude-sdk` | `anthropic_compatible` | CONTAINER | 静默 |
| Codex App Server | `codex_appserver` | `codex_appserver` | HOST_SHELL | **自动合成** |
| Kimi Code | `kimi_code` | 自定义 | CONTAINER | 静默 |

#### 3.3.4 与 RouteDev 的 LLM Client + Agent Loop 对比

| 维度 | HomeRail Worker | RouteDev Agent Loop |
|------|----------------|---------------------|
| **harness 抽象** | Agent Factory + 统一 AgentEvent 流 | LLM Client（anthropic/openai/deepseek/gemini/ollama/qwen）+ Loop |
| **多模型支持** | Claude SDK / Codex / Kimi（3 个 harness） | 6 个 LLM provider client |
| **工具系统** | DAG Tools（handoff/send/receive）注入 agent | 内建工具 + MCP + 权限引擎 |
| **上下文管理** | 每节点独立上下文窗口，无压缩 | Context Manager + prefix cache + compaction |
| **运行时隔离** | Docker 容器（每节点一个） | 同进程，git worktree 隔离实验 |
| **中断能力** | `inject` 事件 + AbortController | circuit breaker + bounded recovery |

**结论**：RouteDev 的 LLM 多模型支持更广（6 个 provider），但 HomeRail 的 harness 抽象更彻底（每个 harness 是完整的 agent 运行时，而非只是 API client）。HomeRail 的"每节点独立上下文窗口"设计从根本上避免了上下文膨胀问题，这是 RouteDev 的 Context Manager 需要努力解决的。

---

### 3.4 语音界面（homerail_manager voice surface）

#### 3.4.1 Voice Surface Contract

**文件**：`homerail_protocol/src/manager-agent-tools.ts` (17KB)

语音界面通过**工具目录**实现 — Manager Agent 调用特定工具来更新语音面状态：

```typescript
// 语音模式专用的工具集
export const MANAGER_AGENT_COMMON_VOICE_TOOL_NAMES = [
  "update_voice_memo",           // 更新语音备忘录（TOML 文件）
  "update_task_draft",            // 更新任务草稿卡
  "validate_widget_file",         // 验证 TOML widget
  "write_widget_file",            // 写入 TOML widget
  "read_widget_file",             // 读取 TOML widget
  "remove_widget_file",           // 移除 TOML widget
  "show_widget_toml_example",     // 显示 TOML 示例
  "show_status_card",             // 显示状态卡
  "show_list_card",               // 显示列表卡
  "show_progress_card",           // 显示进度卡
  "show_note_card",               // 显示说明卡
  "show_artifact_card",           // 显示 artifact 预览卡
  "show_dynamic_widget",          // 显示动态小组件
  "remove_widget",                // 移除 widget
  "update_voice_surface",         // 批量更新语音面
] as const;
```

**Voice Memo Schema** — 语音会话的核心状态：

```typescript
const voiceMemoSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    status: { type: "string", enum: ["listening", "clarifying", "ready", "executing", "done"] },
    summary: { type: "string" },
    known_facts: { type: "array", maxItems: 8, items: { type: "string" } },
    open_questions: { type: "array", maxItems: 8, items: { type: "string" } },
    todos: { type: "array", maxItems: 10, items: { /* text + done */ } },
    next_action: { type: "string" },
    ready_to_execute: { type: "boolean" },
  },
  required: ["title", "status", "summary"],
};
```

#### 3.4.2 关键设计

1. **Voice Memo 作为可审计状态** — 不是临时聊天记录，而是持久化的 TOML 文件，每次更新是"完整替换"而非追加
2. **Commentary 语音通道** — Codex AppServer 是唯一能从模型原生 reasoning 流自动合成语音 commentary 的 harness
3. **跨轮次意图收集** — `update_voice_memo` 工具描述："Use this while listening to multi-turn user requirements before execution is ready"
4. **Widget 文件系统** — 每个 widget 是一个 TOML 文件，支持 memo/task_draft/progress_status/checklist/artifact_ref/timeline 六种类型

#### 3.4.3 与 RouteDev 对比

RouteDev **没有语音界面**（任务描述确认为"未实现"）。这是 HomeRail 独有的能力。

---

### 3.5 生成 UI（homerail_manager generative UI）

#### 3.5.1 Widget 契约

**文件**：`homerail_protocol/src/manager-agent-widget-tools.ts` (6KB)

```typescript
export interface ManagerAgentWidgetFileToolAdapter {
  updateVoiceMemo(args, context): Promise<ManagerAgentWidgetFileToolResult>;
  validateWidgetFile(args: { widgetType, toml }, context): Promise<...>;
  writeWidgetFile(args: { widgetId?, widgetType, toml }, context): Promise<...>;
  readWidgetFile(args: { widgetId, widgetType? }, context): Promise<...>;
  removeWidgetFile(args: { widgetId }, context): Promise<...>;
  showWidgetTomlExample(args: { widgetType }, context): Promise<...>;
}

export interface ManagerAgentWidgetFileVoiceSurfaceSink {
  addWidget(widget: Record<string, unknown>): void;
  removeWidget(id: string): void;
}
```

**渲染流程**：
1. Manager Agent 调用 `write_widget_file` 工具，传入 TOML 内容
2. Adapter 验证并解析 TOML，生成 normalized widget 对象
3. 通过 `VoiceSurfaceSink.addWidget()` 推送到语音面
4. 浏览器 UI（agent-ui）渲染 widget

**Widget 类型**（从 `show_dynamic_widget` 描述）：

> type 可为 html、metric_strip、timeline、dag_flow、chart、topic_outline、slide_deck 等

**Show 类工具的 Schema**：

```typescript
const widgetSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    status: { type: "string" },
    priority: { type: "string", enum: ["low", "normal", "high"] },
    items: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    active_step: { type: "integer" },
    data: { type: "object", additionalProperties: true },
  },
  required: ["title"],
};
```

#### 3.5.2 与 RouteDev 的 React 渲染对比

| 维度 | HomeRail 生成式 UI | RouteDev React 渲染 |
|------|-------------------|---------------------|
| **UI 生成方式** | Agent 通过工具调用动态生成 widget | 预定义 React 组件树 |
| **契约** | TOML widget 文件 + JSON Schema | TypeScript props |
| **运行时变化** | Agent 决定显示什么、怎么显示 | UI 组件固定，数据流动 |
| **成熟度** | 探索中（契约和 widget 集合会继续变化） | 成熟（完整桌面应用） |

**结论**：HomeRail 的生成式 UI 理念更前卫（agent 决定 UI），但仍在探索中。RouteDev 的 React 渲染更成熟可靠，但缺乏"UI 随 agent 意图动态生成"的能力。

---

### 3.6 Docker Worker 隔离（homerail_node）

#### 3.6.1 模块架构与源码组织

`homerail_node/src/` 实际目录结构（源码级）：

```
homerail_node/src/
├── cli.ts                    (4.7KB)  Node CLI 入口（参数解析 + WS 连接）
├── index.ts                  (1.7KB)  包导出聚合
├── control-plane/
│   ├── lifecycle-handler.ts  (6.0KB)  生命周期请求分发器
│   └── ws-client.ts          (4.5KB)  Manager WS 客户端
├── lifecycle/
│   ├── create.ts             (2.4KB)  容器创建（含 worker 特殊逻辑）
│   ├── start.ts / stop.ts    (~1KB)   启停
│   ├── inspect.ts / remove.ts         检查/删除
│   └── logs.ts                        日志
├── platform/
│   ├── paths.ts              (625B)   路径解析（resolveHomerailHome）
│   ├── homerail-home.ts      (117B)   HOMERAIL_HOME 路径
│   └── local-volume.ts       (127B)   本地卷挂载
├── providers/
│   ├── types.ts              (1.2KB)  ExecutionProvider 契约接口
│   ├── docker-cli-provider.ts (10.7KB) Docker CLI 实现
│   ├── docker-api-provider.ts (6.0KB)  Docker API 实现
│   └── mock-provider.ts      (4.7KB)  测试用 Mock
└── storage/
    ├── mount-policy.ts       (2.3KB)  挂载安全策略
    ├── workspace-prepare.ts  (7.0KB)  工作区准备（git_clone/local_copy/isolated）
    ├── homerail-home.ts      (1.3KB)  Home 路径计算
    └── local-volume.ts       (1.6KB)  卷挂载
```

#### 3.6.2 ExecutionProvider 统一契约（策略模式）

**源码引用**：`homerail_node/src/providers/types.ts`

```typescript
export interface ExecutionProvider {
  create(config: ContainerConfig): Promise<ContainerInfo>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  exec(id: string, cmd: string[]): Promise<ExecResult>;
  logs(id: string): AsyncIterable<string>;
  inspect(id: string): Promise<ContainerInfo>;
  list(): Promise<ContainerInfo[]>;
}
```

**三种实现**（`cli.ts` 中的 `resolveProvider`）：
- `docker-cli`（默认）：通过 `docker` 命令行调用，10.7KB 实现，兼容性最好
- `docker-api`：通过 Docker Engine API 直接调用，6KB 实现，性能更好
- `mock`：测试用，4.7KB 实现，无真实容器

**设计要点**：容器运行时是可插拔的——未来可以增加 Podman、containerd、甚至 Kubernetes Pod 实现，上层 `lifecycle/*` 和 `control-plane/*` 完全无感。

#### 3.6.3 挂载安全策略（MountPolicy）

**源码引用**：`homerail_node/src/storage/mount-policy.ts`

```typescript
const DENIED_PATHS = ["/etc", "/proc", "/sys", "/dev"];

export function validateMounts(mounts: MountEntry[], options: MountPolicyOptions = {}): void {
  // 1. 系统目录禁止挂载
  if (DENIED_PATHS.includes(host)) throw new MountPolicyError(...);
  // 2. Docker socket 需显式授权
  if (host === "/var/run/docker.sock" && !options.allowDockerSocket) throw ...;
  // 3. 只允许 .homerail 树内或 allowedHostRoots 内的路径
  if (!insideHomerailHome && !insideAllowedRoot) throw new MountPolicyError(
    `Mount denied: "${mount.host}" is outside .homerail tree`
  );
}

export function workerAllowedMounts(workspaceId: string): MountEntry[] {
  return [{ host: homerailWorkerWorkspacePath(workspaceId), container: "/workspace", mode: "rw" }];
}
```

**三层安全边界**：
1. **系统目录黑名单**：`/etc`、`/proc`、`/sys`、`/dev` 永远不可挂载
2. **Docker socket 守门**：挂载 `/var/run/docker.sock` 必须显式 `allowDockerSocket: true`
3. **路径白名单**：只允许 `.homerail` 树内或 `allowedHostRoots` 配置内的路径

**Worker 容器强制隔离**（`lifecycle/create.ts`）：

```typescript
export async function createWorkerContainer(opts: CreateWorkerOptions): Promise<ContainerInfo> {
  if ((config.mounts ?? []).length > 0) {
    throw new Error("worker containers do not accept caller-supplied mounts; use workspaceId");
  }
  // 只使用 workerAllowedMounts(workspaceId) 的固定挂载
  const defaultMounts = workerAllowedMounts(workspaceId);
  // ...
}
```

**关键设计**：Worker 容器**不接受调用方提供的挂载**，强制使用 `workspaceId` 推导的固定挂载（仅 `/workspace`）。这防止了恶意 agent 通过挂载敏感目录逃逸。

#### 3.6.4 工作区准备（WorkspaceSpec）

**源码引用**：`homerail_node/src/storage/workspace-prepare.ts`

三种工作区模式：

```typescript
export interface WorkspaceSpec {
  mode?: string;           // "isolated" | "local_copy" | "git_clone"
  repo_url?: string;       // git_clone 模式
  branch?: string;         // git_clone 模式
  source_path?: string;    // local_copy 模式
  source_path_env?: string;
  exclude?: string[];      // local_copy 排除项
}
```

| 模式 | 用途 | 安全机制 |
|------|------|----------|
| `isolated` | 空目录，完全隔离 | 仅 `mkdir -p` |
| `local_copy` | 复制本地目录 | `allowedLocalRoots` 白名单 + 默认排除 `node_modules`/`dist`/`build` 等 |
| `git_clone` | 克隆远程仓库 | URL 必须 `http(s)://` + branch 字符校验（禁 `..`）+ `--single-branch` |

**git_clone 安全校验**：

```typescript
function assertSafeGitCloneSpec(spec: WorkspaceSpec): { repoUrl: string; branch: string } {
  if (!/^https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(repoUrl)) {
    throw new Error("workspace.repo_url must be an http(s) URL");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) {
    throw new Error("workspace.branch contains unsupported characters");
  }
}
```

**并发保护**：`prepareLocks: Map<string, Promise<PreparedWorkspace>>` 防止同一 workspaceId 被并发准备。

**local_copy 默认排除**（`DEFAULT_LOCAL_COPY_EXCLUDES`）：`node_modules`、`dist`、`build`、`coverage`、`.cache`、`.next`、`.nuxt`、`.turbo`、`.vite`、`.DS_Store`。

#### 3.6.5 生命周期请求分发（handleLifecycleRequest）

**源码引用**：`homerail_node/src/control-plane/lifecycle-handler.ts`

通过 WS 消息驱动容器生命周期，支持 8 种操作：

```typescript
export async function handleLifecycleRequest(
  request: LifecycleRequest, provider: ExecutionProvider, send: SendFn
): Promise<void> {
  // resource_type: "container" | "worker"
  // operation: "create" | "start" | "stop" | "remove" | "inspect" | "logs" | "exec" | "list"
  const result = await dispatchOperation(provider, resource_type, operation, spec);
  send({ type: "lifecycle_response", request_id, status: "success", resource_data: result });
}
```

**worker create 的特殊处理**：
- 调用 `prepareWorkerWorkspace(workspaceId, spec.workspace)` 准备工作区
- 设置 label `homerail.resource_type: "worker"`
- 默认镜像 `homerail-worker:latest`
- 默认 workdir `/workspace`

#### 3.6.6 与 RouteDev 的 experiment-manager（git worktree）对比

| 维度 | HomeRail Docker Worker | RouteDev experiment-manager |
|------|----------------------|---------------------------|
| **隔离级别** | 进程级（Docker 容器） | 文件系统级（git worktree） |
| **工作区** | `${HOMERAIL_HOME}/workspace/<workspaceId>/` | git worktree 路径 |
| **工作区准备** | 3 种模式（isolated/local_copy/git_clone）+ 安全校验 | git worktree add |
| **挂载安全** | MountPolicy 三层防护 + Worker 强制固定挂载 | 依赖文件系统权限 |
| **运行时抽象** | ExecutionProvider 策略模式（3 实现） | 无（直接调用本地进程） |
| **资源开销** | 高（每节点一个容器） | 低（共享同一仓库） |
| **环境隔离** | 完全隔离（不同容器可不同依赖） | 仅代码隔离，运行时环境共享 |

**结论**：HomeRail 的 Docker 隔离更彻底，其**MountPolicy 安全策略**和**WorkspaceSpec 三种模式**是值得学习的工程设计——即便 RouteDev 不用 Docker，这种"显式安全边界 + 输入校验"的思路对 local_copy 类操作也有借鉴价值。但对 RouteDev 的桌面单用户定位来说，git worktree 在资源开销上是正确的选择；ExecutionProvider 这种可插拔运行时抽象对 RouteDev 过度设计。

---

## 4. 值得借鉴的点

### 4.1 端口化 DAG 引擎

- **HomeRail 实现**：`dag-engine.ts` 中的 `handoff(run, fromNode, port, content)` 函数。每个节点有输入/输出端口，handoff 时通过 `from_port` 匹配下游边，内容投递到下游 mailbox。支持 `on_success`/`on_failure`/`always` 条件路由、failure ports、分支跳过、循环网关。
- **RouteDev 现状**：`src/agent/workflow/dag-engine.ts` 使用简单的 `dependsOn` 列表 + Kahn 拓扑排序 + 分层并行。无端口概念、无条件分支、无数据传递、无循环。
- **差距**：RouteDev 的 DAG 是"任务调度器"，HomeRail 的 DAG 是"agent 协作图"。RouteDev 的 DAG 无法表达"如果 review 节点失败则走修复分支"这样的条件流程。
- **落地思路**：
  1. 在 `DagNode` 中增加 `outputs: Record<string, { to: string, condition: "on_success"|"on_failure"|"always" }>` 字段
  2. 在 `execute` 中，节点完成后按结果匹配输出端口，而非简单按层推进
  3. 增加 `mailbox` 机制，让节点间可以传递结构化数据
- **ROI**：**中** — RouteDev 的 PathRouter 已经能动态选择 single/dag/compose，条件路由是自然延伸。但桌面单用户场景下，复杂 DAG 的需求频率不高。

### 4.2 DAG 节点间消息传递（Actor 模型）

- **HomeRail 实现**：`dag-message-router.ts` 实现了 pending inbox + waiters 模式。节点 A 可以 `send_message(to_node: "B", content: ...)`，节点 B 可以 `receive_message()` 等待。消息在 Manager 侧排队，支持异步投递。
- **RouteDev 现状**：DAG 节点间无消息传递能力。`Dual Loop Orchestrator` 有 agent 间协作，但通过 blackboard 模式而非直接消息传递。
- **差距**：RouteDev 的多 agent 协作（`src/agent/multi/`）有 blackboard 和 orchestrator，但缺乏 DAG 节点间的直接通信能力。
- **落地思路**：在 RouteDev 的 DAG 引擎中增加 `send_message`/`receive_message` 工具，让每个 DAG 节点可以向后继节点发送结构化消息。
- **ROI**：**低** — RouteDev 的 blackboard 模式已能满足多 agent 协作需求，直接消息传递在单进程场景下收益有限。

### 4.3 多 Harness 适配器架构

- **HomeRail 实现**：`homerail_worker/src/agent/factory.js` + `prompt-runner.ts` 中的 `createAgentClient(agentBackend)` 工厂。统一 `AgentEvent` 流（text/tool_use/tool_result/usage/done/error），不同 harness（Claude SDK / Codex / Kimi）适配到同一接口。
- **RouteDev 现状**：`src/router/llm/` 有 6 个 provider client（anthropic/openai/deepseek/gemini/ollama/qwen），但这些都是 LLM API client，不是完整的 agent harness。RouteDev 的 Agent Loop 自己管理工具调用循环。
- **差距**：RouteDev 把 agent 循环逻辑放在自己的 Loop 里，LLM client 只负责 API 调用。HomeRail 把整个 agent 运行时委托给 harness（Claude SDK 自己有工具调用循环），Worker 只负责 DAG 工具注入和事件流转发。
- **落地思路**：如果 RouteDev 需要支持 Codex 等"自带工具调用循环"的 harness，可以抽象出 `AgentHarness` 接口（统一 `run(task, tools, context): AsyncIterable<AgentEvent>`），让外部 harness 接入。
- **ROI**：**中** — 如果 RouteDev 要支持 Codex 等非标准 LLM harness，这个抽象有价值。如果只走标准 LLM API，当前架构已经够用。

### 4.4 语音面 Voice Memo 作为可审计状态

- **HomeRail 实现**：`update_voice_memo` 工具将语音会话状态持久化为 TOML 文件（title/status/summary/known_facts/open_questions/todos/next_action/ready_to_execute）。每次更新是完整替换，不是追加。
- **RouteDev 现状**：无语音界面。Agent 的会话状态分散在 goal / plan / progress-ledger 等多个结构中。
- **差距**：RouteDev 没有一个"面向用户、一眼能看懂"的会话状态摘要。
- **落地思路**：即使在桌面场景下，也可以设计一个"会话状态卡"组件，用类似 voice memo 的结构（summary + known_facts + open_questions + todos + next_action）来呈现当前 agent 会话状态。
- **ROI**：**中** — 提升用户体验，但不是核心功能。

### 4.5 运行回放与评分卡

- **HomeRail 实现**：CLI 的 `hr replay <run_id>` 和 `hr scorecard <run_id>` 命令。DAG 运行的所有事件（handoff/send_message/receive_message/tool_use/tool_result/usage）都被持久化，可以完整回放。Scorecard 支持 `off/advisory/strict` 三种模式，配置 handoff_blockers/quality_gate 等。
- **RouteDev 现状**：有 `harness/trace-collector.ts` 和 `harness/audit-logger.ts`，但缺乏结构化的回放和评分卡能力。
- **差距**：RouteDev 有 trace 但没有回放 CLI；有 quality-gate 但没有 scorecard。
- **落地思路**：增加 `replay` 命令，将 trace 转换为可读的时间线报告。增加 scorecard 概念，将 quality-gate 的结果结构化呈现。
- **ROI**：**高** — 回放和评分卡对调试和持续改进 agent 行为非常有价值，且与 RouteDev 现有的 trace/audit 基础设施自然衔接。

### 4.6 Provider Policy 策略

- **HomeRail 实现**：`orchestration/provider-policy.ts` + `graph.ts` 中的 `ProviderPolicyConfig`：
  ```typescript
  export interface ProviderPolicyConfig {
    prohibited_providers?: string[];
    prohibited_models?: string[];
    reason?: string;
  }
  ```
  可以在模板层面禁止某些 provider/model 组合。
- **RouteDev 现状**：有 `config/schema.ts` 和 `router/config.ts`，但缺乏 provider/model 级别的策略禁止能力。
- **差距**：RouteDev 的路由器按性能/成本选择模型，但不能在配置层面"禁止"某些组合。
- **落地思路**：在 RouteDev 的路由配置中增加 `prohibitedProviders`/`prohibitedModels` 字段。
- **ROI**：**低** — 简单配置即可实现，但使用场景有限。

### 4.7 冷启动恢复

- **HomeRail 实现**：`homerail_manager/src/index.ts` 中的 `recoverAllActiveRuns()` 和 `recoverStaleVoiceSessions()`。Manager 重启时，从持久化存储恢复所有活跃的 DAG 运行到内存状态机，重置卡住的语音会话。
- **RouteDev 现状**：有 `runtime/graceful-shutdown.ts`，但缺乏运行恢复能力。
- **差距**：RouteDev 如果崩溃，正在执行的 goal/plan 状态会丢失。
- **落地思路**：在 RouteDev 的 goal-persistence 基础上，增加启动时的活跃 goal 恢复逻辑。
- **ROI**：**高** — 对桌面应用来说，崩溃恢复是关键体验。

---

## 5. RouteDev 已超越的点

### 5.1 动态路径路由

RouteDev 的 `PathRouter`（`src/agent/path-router.ts`）能根据**难度评估**（DifficultyLevel L1-L5）动态选择执行路径（single/dag/compose），并支持运行时**动态升降级**（`detectLevelSwitch`）。HomeRail 的 DAG 结构是模板预定义的，没有运行时动态路由能力。

### 5.2 上下文管理

RouteDev 有完整的上下文管理栈：`Context Manager` + `prefix-cache` + `context-compaction` + `token-profiler` + `content-deduplicator`。HomeRail 的设计哲学是"每节点独立上下文窗口，不需要压缩"，但这意味着每个节点拿到的上下文是有限的。RouteDev 在单 agent 内做到了上下文的高效利用。

### 5.3 LLM Provider 覆盖

RouteDev 支持 6 个 LLM provider（anthropic/openai/deepseek/gemini/ollama/qwen），HomeRail 只支持 3 个 harness（Claude SDK/Codex/Kimi）。对国内开发者来说，RouteDev 的 deepseek/qwen 支持更实用。

### 5.4 工具权限引擎

RouteDev 有完整的 `tools/permission-engine.ts` + `tools/trust-gradient.ts` + `tools/security-enhanced.ts` 安全栈。HomeRail 的 Worker 对工具权限的控制较弱（主要靠 DAG 工具注入限制）。

### 5.5 代码地图与记忆系统

RouteDev 有 `code-map/`（代码索引/查询/排序）和 `memory/`（BM25 索引/混合检索/项目记忆/来源图）系统。HomeRail 没有类似能力 — 它的定位是"易评估结果"而非"软件开发"，所以不需要代码理解。

### 5.6 Dual Loop 编排

RouteDev 的 `dual-loop-orchestrator.ts` 实现了"执行-审查"双循环，内含 `completion-gate`/`quality-aggregator`/`cross-model-reviewer`。HomeRail 的 DAG 虽然可以表达"plan → implement → test → review → summarize"流程，但这是模板预定义的，不是运行时动态编排的。

### 5.7 Sub-Agent 生命周期管理

RouteDev 的 `agents/` 目录有完整的 sub-agent 系统：`delegation-contract`/`delegation-enforcer`/`delegation-gate`/`delegation-policy`/`sub-agent-lifecycle`/`sub-agent-score-card`。HomeRail 的多 agent 协作靠 DAG 编排，没有 sub-agent 概念。

---

## 6. 不适用的点

### 6.1 Docker 容器隔离

HomeRail 的 Docker Worker 设计适合服务端多用户场景。RouteDev 是 Electron 桌面应用，强制用户安装 Docker 会显著增加使用门槛。RouteDev 的 git worktree 隔离是更合适的选择。

### 6.2 语音界面（ASR/TTS/VAD）

HomeRail 的语音面设计为"家庭数据中心常驻 agent"服务。RouteDev 是开发工具，开发者通常在编码时不希望对电脑说话。语音界面对 RouteDev 的目标用户场景不适用。

### 6.3 家庭数据中心常驻服务

HomeRail 的长期目标是 NAS 常驻、多终端（手机/平板/TV/车机）访问。RouteDev 是桌面开发工具，不需要常驻服务或多终端访问。

### 6.4 生成式 UI 的 TOML Widget 系统

HomeRail 用 TOML 文件描述 widget，适合"agent 决定 UI"的场景。RouteDev 作为开发工具，用户需要可预测的 UI 布局，React 组件树是更合适的选择。

### 6.5 Codex AppServer Commentary 语音通道

这是 Codex harness 的特定能力，依赖 Codex 的原生 reasoning 流。对 RouteDev 来说不适用。

---

## 7. 总结

### 7.1 核心发现

HomeRail 是一个**设计理念清晰、DAG 引擎成熟、语音/UI 探索中**的项目。它的核心价值在于：

1. **DAG 引擎设计精良** — 端口化图模型 + 事件驱动状态机 + mailbox 消息传递 + 条件分支 + 循环网关，这是目前开源 agent 编排系统中少见的成熟度。

2. **Protocol 契约严谨** — 独立包 + JSON Schema 验证 + 版本化 + 全消息模式覆盖，是跨进程通信的好范本。

3. **多 Harness 适配器抽象** — 将 agent 运行时委托给外部 harness（Claude SDK/Codex/Kimi），自己只负责编排和 DAG 工具注入，是"不重复造轮子"的好实践。

4. **语音面 Voice Memo 模式** — 将会话状态持久化为可审计的 TOML 文件，是"agent 状态可视化"的创新设计。

### 7.2 对 RouteDev 的建议

**高 ROI 借鉴**：
- 运行回放与评分卡（与 RouteDev 现有 trace/audit 基础设施衔接）
- 冷启动恢复（提升桌面应用崩溃恢复体验）

**中 ROI 借鉴**：
- 端口化 DAG 引擎（条件路由 + 数据传递，扩展 RouteDev 的简单 DAG）
- 多 Harness 适配器架构（如果 RouteDev 需要支持非标准 LLM harness）
- Voice Memo 式会话状态卡（提升用户体验）

**不需要借鉴**：
- Docker 容器隔离（git worktree 已够用）
- 语音界面（不适用于开发工具场景）
- 生成式 UI TOML widget（React 组件树更适合）
- 家庭数据中心常驻服务（定位不同）

### 7.3 一句话总结

> HomeRail 的 DAG 引擎和 Protocol 契约值得 RouteDev 学习，但它的服务端多用户、语音优先、生成式 UI 的定位与 RouteDev 的桌面开发工具定位 fundamentally 不同。借鉴要 selective，不要 wholesale。

---

## 附录：抓取的源码文件清单

| # | 文件路径 | 大小 | 用途 |
|---|---------|------|------|
| 1 | `ROADMAP.md` | 5KB | 项目方向 |
| 2 | `README.md` | 12KB | 项目概述 |
| 3 | `README.zh-CN.md` | 12KB | 中文概述 |
| 4 | `package.json` (根) | 1.5KB | monorepo 结构 |
| 5 | `homerail_protocol/src/types.ts` | 12KB | 协议类型定义 |
| 6 | `homerail_protocol/src/schemas.ts` | 12.5KB | JSON Schema |
| 7 | `homerail_protocol/src/manager-agent-tools.ts` | 17KB | Manager Agent 工具目录 |
| 8 | `homerail_protocol/src/manager-agent-widget-tools.ts` | 6KB | Widget 工具适配器 |
| 9 | `homerail_worker/src/index.ts` | 9KB | Worker 入口 |
| 10 | `homerail_worker/src/prompt-runner.ts` | 15KB | Harness 适配核心 |
| 11 | `homerail_manager/src/index.ts` | 1.3KB | Manager 入口 |
| 12 | `homerail_manager/src/orchestration/graph.ts` | 4KB | DAG 图数据结构 |
| 13 | `homerail_manager/src/orchestration/dag-engine.ts` | 11KB | DAG 状态机 |
| 14 | `homerail_manager/src/orchestration/dag-message-router.ts` | 7KB | 消息路由 |
| 15 | `homerail_manager/src/runtime/agent-runtime-resolver.ts` | 8KB | Harness 选择 |
| 16 | `homerail_cli/src/dag.ts` | 27KB | DAG CLI 操作 |
| 17 | `homerail_node/src/index.ts` | 1.7KB | Node 包导出聚合 |
| 18 | `homerail_node/src/cli.ts` | 4.7KB | Node CLI 入口（参数解析+WS 连接） |
| 19 | `homerail_node/src/providers/types.ts` | 1.2KB | ExecutionProvider 契约接口 |
| 20 | `homerail_node/src/lifecycle/create.ts` | 2.4KB | 容器创建（含 worker 特殊逻辑） |
| 21 | `homerail_node/src/control-plane/lifecycle-handler.ts` | 6.0KB | 生命周期请求分发器 |
| 22 | `homerail_node/src/storage/mount-policy.ts` | 2.3KB | 挂载安全策略 |
| 23 | `homerail_node/src/storage/workspace-prepare.ts` | 7.0KB | 工作区准备（3 种模式） |
| 24 | RouteDev `src/agent/workflow/dag-engine.ts` | 10KB | 对比用 |
| 25 | RouteDev `src/agent/path-router.ts` | - | 对比用 |

**未抓取但已获取目录结构的包**：
- `agent-ui/src/` — 浏览器 UI
- `homerail_manager/src/server/` — HTTP 服务器
- `homerail_manager/src/widgets/` — Widget 渲染
- `homerail_worker/src/agent/` — Agent Factory + 各 harness 适配
- `homerail_worker/src/dag-tools/` — DAG 工具实现
- `homerail_worker/src/session/` — 会话存储
- `homerail_worker/src/audit/` — 审计日志
- `homerail_worker/src/manager-agent/` — Manager Agent 服务器
