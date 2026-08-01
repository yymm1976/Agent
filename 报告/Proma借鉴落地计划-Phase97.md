# Phase 97：Proma 开源借鉴落地——统一执行上下文与 9 项能力增强

**目标：** 将 Proma（proma-ai/Proma，本地优先 Agent 桌面应用，双内核 Claude/Pi）的 9 个高价值借鉴点落地为 RouteDev 桌面应用的实际能力提升。Proma 本身不是 Harness，而是「双 Harness 内嵌 + 会话/工作区管理」的客户端，其价值在于验证了一条路线：统一执行模型、统一中断层、工作区能力边界、联合快照回滚。本 Phase 借鉴其设计决策，不复制其代码（AGPL-3.0）。

**架构：** 九 Part 渐进推进——A 统一 Agent Session 与事件生命周期（基础设施，后续 Part 依赖）；B 对话与文件联合回滚；C 全局中断队列；D 工作区能力边界；E 多 Agent 子会话可见性；F 触发来源共用执行引擎与自动化自我迭代；G 结构化输入框引用系统；H 常驻 Agent Island 状态界面；I 极简记忆与 Skills 沉淀。落地顺序严格按 A →（C、D 并行）→（B、E、G 并行）→（F、H），I 随时穿插，因为 A 的 Session/事件语义是其余 Part 的公共基础。

**涉及文件：** 新增约 15 文件，修改约 30 文件。

**前置依赖：** Phase 73（AgentMessage 消息抽象层，message-types.ts 已完成）已完成；Phase 71 Task B2（@-mention 解析，mention-parser.ts）已完成；Phase 95（工程收尾与治理）已完成；Phase 96（工具流式输出 tool_call_delta + ToolExecCallOptions）进行中，其 callOptions 机制为 Part A/B 的 turn 边界提供基础。ScheduleEngine 已于 Phase 74 移除，Part F 需重新设计而非恢复旧代码。

**严禁死代码原则（继承自 Phase 72）：**
1. 每个新增配置字段必须在同一次 PR 内接入消费点
2. 每个新增模块必须有至少一个调用方
3. 每个新增函数必须有测试覆盖
4. 子 Agent 审计时若发现"配置僵尸"或"孤立模块"，直接标 Critical 阻塞合入

---

## Proma 源码参考

| 借鉴点 | Proma 源码/文档 | 核心机制 |
|--------|----------------|----------|
| 统一 Session 与执行上下文 | `apps/electron/src/main/lib/agent-orchestrator.ts` + `automation-scheduler.ts` | 自动化/远程/子 Agent 全部落到 Agent Session 统一抽象，保留模型/工作区/权限/上下文/运行历史 |
| 对话与文件联合回滚 | `apps/electron/src/main/lib/agent-orchestrator.ts`（SDK 文件历史快照） | 按消息定位文件快照并恢复，校验目标路径在工作目录或授权附加目录内 |
| 全局中断队列 | `agent-permission-service.ts` + `agent-ask-user-service.ts` + renderer 全局监听 | 权限/提问/审批统一队列，页面切换不丢，abort 时自动拒绝未处理请求 |
| 工作区能力边界 | `agent-workspace-manager.ts` | 工作区 slug 隔离，每工作区 mcp.json + skills/ + workspace-files/，可附加目录 |
| 多 Agent 可见子会话 | `agent-collaboration-tools.ts` | 子 Agent 权限不能高于父，批量创建部分失败保留，等待全部/任意/N 个 |
| 自动化自我迭代 | `automation-scheduler.ts` | 自动化配置带版本号与迁移逻辑，任务可被用户打开检查 |
| 结构化输入框引用 | renderer Composer（0.16.x 统一入口） | `/` 命令与 Skill、`@` 文件、`&` 会话、`~` Todo，统一解析为结构化引用 |
| 常驻状态界面 | renderer `useGlobalAgentListeners` 顶层挂载 | Agent Island 常驻顶部，集中显示运行/等待/完成/错误 |
| 极简记忆 | `proma-thinking/proma-2026-q2-q3-thinking.md` | 几百字 User Profile schema 拼提示词 + 触发率迭代，严肃内容用 Skills 沉淀 |

---

## Part A：统一 Agent Session 与事件生命周期（基础设施）

### 背景与现状

RouteDev 当前没有统一的「执行上下文」概念：

- `src/agent/loop.ts` 是自研 ReAct 循环，`src/runtime/goal-runner.ts` 是独立的 goal 执行路径，远程（`desktop/main/remote/`）与子 Agent（`src/tools/builtin/spawn-agent.ts`）各自消费不同入口，没有共享的 `triggerSource` 语义。
- `src/agent/loop-config.ts` 的 `ReActEvent` 只有 thinking/text_delta/tool_call_*/approval_required/error/done 等类别，缺少 `agent_start/agent_end`、`turn_start/turn_end`、`message_start/message_update/message_end` 生命周期，也没有统一的 `sequence` 游标。这正是 Harness 评估 4.2 与 Pi 差距分析 P0 所指出的时间线失真根因。
- `src/harness/trace-collector.ts` 已有 sessionId/spanId 雏形，但事件结构未与会话消息统一。

### Proma 借鉴对象

Proma 通过 SDK 层获得完整事件生命周期：`agent_start/agent_end`、`turn_start/turn_end`、`message_start/message_update/message_end`、`tool_execution_start/update/end`，UI 只需按游标追加事件即可还原真实顺序。本 Part 不引入 Pi/Claude SDK（RouteDev 自研引擎已深度耦合桌面状态），而是先让自研引擎满足同一事件语义，为未来接入内核适配器留出插槽。

### Task A1：定义 AgentExecutionContext 统一类型

**目标：** 引入执行上下文类型，让手动/自动化/远程/子 Agent 全部显式携带触发来源。

**文件：**
- 新增：`src/agent/execution-context.ts`
- 新增：`tests/agent/execution-context.test.ts`

- [ ] **Step 1: 定义 AgentExecutionContext**
  ```typescript
  // src/agent/execution-context.ts
  /** 触发来源：手动 / 自动化 / 远程 / 子 Agent 委派 */
  export type TriggerSource = 'user' | 'automation' | 'remote' | 'delegation';

  export interface AgentExecutionContext {
    triggerSource: TriggerSource;
    sessionId: string;
    workspaceId?: string;
    model?: string;
    permissionMode: 'manual' | 'semi' | 'auto';
    attachedResources: string[];
    notificationTarget?: { kind: 'ui' | 'feishu' | 'sse'; id: string };
  }
  ```

- [ ] **Step 2: 在 ReActAgentLoop.run() 与 goal-runner 执行入口统一接收 AgentExecutionContext**
  loop 与 goal 路径都要求显式传入 context，缺失时以 `triggerSource: 'user'` 兜底（fail-open，保持兼容）。

- [ ] **Step 3: 测试覆盖触发来源透传与兜底默认值**

### Task A2：补全事件生命周期（EngineEventV1）

**目标：** 在现有 ReActEvent 之上增加 agent/turn/message 生命周期与公共游标字段，桌面 IPC、远程 SSE、历史存储共用同一结构。

**文件：**
- 新增：`src/harness/event-types.ts`（EngineEventV1 类型）
- 修改：`src/agent/loop.ts`（发出 turn_start/turn_end、message_start/delta/end）
- 修改：`src/agent/loop-config.ts`（扩展 ReActEvent 或提供转换层）
- 修改：`src/harness/trace-collector.ts`（trace 记录携带 sequence 与 turnId）
- 新增：`tests/harness/event-types.test.ts`

- [ ] **Step 1: 定义 EngineEventV1 公共字段**
  ```typescript
  // src/harness/event-types.ts
  export interface EngineEventV1 {
    id: string;
    sessionId: string;
    turnId?: string;
    messageId?: string;
    sequence: number;      // 同一 turn 内单调递增
    timestamp: number;
    type:
      | 'agent_start' | 'agent_end'
      | 'turn_start' | 'turn_end'
      | 'message_start' | 'message_delta' | 'message_end'
      | 'tool_start' | 'tool_delta' | 'tool_end'
      | 'approval_requested' | 'approval_resolved'
      | 'todo_snapshot' | 'runtime_status' | 'runtime_error';
    payload: unknown;
  }
  ```

- [ ] **Step 2: loop 在每次 LLM 调用前发出 turn_start/message_start，流式 delta 复用现有 text_delta/reasoning_delta，收敛时发出 message_end/turn_end**
- [ ] **Step 3: 删除或禁用固定「模型思考中」伪文案，前端状态提示必须来自真实事件**

### Task A3：AgentKernel 接口抽象（预留内核适配插槽）

**目标：** 定义内核边界，自研引擎作为 kernel A 先满足接口，未来 Pi/Claude SDK 可作为 kernel B 接入而不破坏上层。

**文件：**
- 新增：`src/agent/kernel.ts`（AgentKernel 接口 + 会话级 kernel 记录）
- 修改：`src/runtime/app-init.ts`（装配默认 kernel）
- 新增：`tests/agent/kernel.test.ts`

- [ ] **Step 1: 定义 AgentKernel 接口**
  ```typescript
  // src/agent/kernel.ts
  export interface AgentKernel {
    readonly id: string;                       // 'routedev-native' | 'pi' | 'claude-sdk'
    run(ctx: AgentExecutionContext, input: string): AsyncIterable<EngineEventV1>;
    abort(sessionId: string): Promise<void>;
    getSessionState(sessionId: string): KernelSessionState;
  }
  ```

- [ ] **Step 2: 将现有 ReActAgentLoop 包装为 routedev-native kernel（薄适配，不重构 loop 内部）**
- [ ] **Step 3: session 记录 kernel 选择，切换内核时消息持久化不丢（复用现有会话存储）**

---

## Part B：对话与文件联合回滚（TurnSnapshot）

### 背景与现状

`src/harness/checkpoint-manager.ts` 已有 `create()` 与 `rollback()`，rollback 前强制检查 `git status` 工作区干净（陷阱 #18），并带 `.backup` 备份（V2-T01 修复）。但它是 git 层的回滚：对话状态回退时，磁盘文件状态依赖 Git，非代码文件无法恢复，且没有「对话状态 + 文件状态」的联合快照语义。

### Proma 借鉴对象

Proma 通过 SDK 文件历史快照，按消息定位对应的文件状态并恢复；恢复时校验目标路径必须位于当前工作目录或显式授权的附加目录内；派生历史会话到其他目录时复制并重写会话路径。

### Task B1：TurnSnapshot 联合快照

**目标：** 每个 turn 结束后建立「对话状态 + 文件状态」联合检查点。

**文件：**
- 新增：`src/harness/turn-snapshot.ts`
- 修改：`src/agent/loop.ts`（turn_end 时触发快照）
- 修改：`src/harness/checkpoint-manager.ts`（快照落盘复用 safe-write）
- 新增：`tests/harness/turn-snapshot.test.ts`

- [ ] **Step 1: 定义 TurnSnapshot 类型**
  ```typescript
  // src/harness/turn-snapshot.ts
  export interface TurnSnapshot {
    turnId: string;
    userMessage: string;
    agentOutput: string;
    toolCalls: { name: string; callId: string; approved: boolean }[];
    changedFiles: string[];                    // 相对工作目录路径
    fileSnapshots: Record<string, string>;     // 路径 → 内容快照（仅快照 size 与 hash，全量存 hash）
    workingDirectory: string;
    attachmentBoundary: string[];              // 授权附加目录，回滚校验用
  }
  ```

- [ ] **Step 2: loop 在 turn_end 事件后收集本次 turn 的 changedFiles（复用 ReadTracker 的写入追踪）**
- [ ] **Step 3: 快照只记录文件 hash + size（非代码文件同样适用），回滚时按 hash 校验后再恢复内容**
- [ ] **Step 4: 快照与 checkpoint 的关系：TurnSnapshot 轻量、随会话保留；CheckpointManager 保持 git 强回滚，二者共存，TurnSnapshot 优先用于「对话级撤销」**

### Task B2：路径授权校验

**目标：** 回滚恢复任何文件前，校验目标路径必须位于 workingDirectory 或 attachmentBoundary 内。

**文件：**
- 修改：`src/harness/turn-snapshot.ts`（恢复入口校验）
- 新增：`tests/harness/turn-snapshot-boundary.test.ts`

- [ ] **Step 1: 恢复函数先做路径边界校验（normalize + 前缀匹配，禁止符号链接逃逸），越界直接拒绝并记录审计**
- [ ] **Step 2: 派生历史会话到其他目录时，重写快照内的相对路径基准**

---

## Part C：全局中断队列（Interruption）

### 背景与现状

RouteDev 已有 `approval_required` 事件与 `ask-user` 工具（Phase 73 标记 sequential），权限/审批在 renderer 端有队列雏形，但未统一为一种「需要人工介入的中断」抽象：权限请求、向用户提问、计划审批、冲突解决、凭据缺失各走各的弹窗路径；页面切换或渲染层重载后，未处理请求可能丢失；中止会话时未处理权限可能让 Promise 悬挂。

### Proma 借鉴对象

Proma 把所有需要人工介入的状态收敛到统一队列，全局监听器在顶层挂载，页面切换不丢流式事件与权限请求；渲染层重载后可重新取回未处理请求；中止会话时未处理权限自动拒绝。

### Task C1：Interruption 类型与主进程 Broker

**目标：** 定义统一中断类型与主进程队列 Broker，成为审批/提问/计划审批的唯一入口。

**文件：**
- 新增：`src/agent/interruption.ts`（类型）
- 新增：`desktop/main/interruption-broker.ts`（队列 + 超时 + abort 拒绝）
- 修改：`desktop/main/bridges/chat-bridge.ts`（审批路径改走 Broker）
- 新增：`tests/harness/interruption-broker.test.ts`

- [ ] **Step 1: 定义 Interruption 联合类型**
  ```typescript
  // src/agent/interruption.ts
  export type Interruption =
    | { kind: 'permission_request'; id: string; sessionId: string; toolName: string; args: unknown; reason: string }
    | { kind: 'ask_user'; id: string; sessionId: string; question: string; options?: string[] }
    | { kind: 'plan_approval'; id: string; sessionId: string; plan: unknown }
    | { kind: 'conflict_resolution'; id: string; sessionId: string; conflict: unknown }
    | { kind: 'credential_required'; id: string; sessionId: string; provider: string };
  ```

- [ ] **Step 2: InterruptionBroker 提供 submit/list/resolve/reject/reclaim API**
  - submit：入队并广播 EngineEventV1（approval_requested 等）
  - resolve：按 id 解决，Promise 完成
  - reclaim：渲染层重载后重新取回该 session 的未处理中断
  - abort(sessionId)：批量拒绝未处理中断（默认拒绝），杜绝 Promise 悬挂
- [ ] **Step 3: 中断带 60s 超时默认策略（沿用 V2-T02 requestUserConfirmation 超时先例）**

### Task C2：渲染层全局消费

**目标：** 中断事件在顶层全局监听，页面切换不丢。

**文件：**
- 新增：`desktop/renderer/src/hooks/useGlobalInterruptions.ts`
- 修改：`desktop/renderer/src/main.tsx`（顶层挂载）
- 修改：`desktop/renderer/src/store/useRouteDevStore.ts`（中断状态集中管理）

- [ ] **Step 1: 顶层挂载全局中断监听，按 sessionId 存入 store（Map 结构）**
- [ ] **Step 2: 各页面只从 store 读中断并渲染操作区，不各自注册 IPC 监听**
- [ ] **Step 3: 会话中止时调用 Broker.abort，UI 同步清空该 session 的待处理中断**

---

## Part D：工作区能力边界（Workspace）

### 背景与现状

RouteDev 有 project-trust-store（`src/tools/project-trust-store.ts`）、Skills 市场（`src/skills/market-manager.ts`）、MCP 管理，但它们的归属单位没有统一：信任、记忆、Skill、MCP、权限策略散落在不同配置上，没有「工作区」这个统一边界，也没有「附加目录/文件」的概念（API 文档、共享库、测试数据、另一个 Git 仓库只能靠扩大文件系统访问范围）。

### Proma 借鉴对象

Proma 的 `agent-workspace-manager` 把工作区做成 slug 隔离目录，每个工作区自带 `mcp.json` 与 `skills/`，本地目录直接作为项目根不要求导入复制，并支持附加目录与文件；启动时清理失效路径，检测附件中的 Git 根与 worktree。

### Task D1：Workspace 类型与 Manager

**目标：** 引入 Workspace 统一模型，作为 Skill/MCP/记忆/权限的作用域。

**文件：**
- 新增：`src/workspace/types.ts`
- 新增：`src/workspace/manager.ts`
- 修改：`src/config/schema.ts`（workspaces 配置段，带版本号与迁移）
- 修改：`src/config/defaults.ts`
- 新增：`tests/workspace/manager.test.ts`

- [ ] **Step 1: 定义 Workspace 类型**
  ```typescript
  // src/workspace/types.ts
  export interface Workspace {
    id: string;
    slug: string;
    projectRoot: string;                 // 本地目录，不复制
    attachedDirectories: string[];       // 显式附加目录（API 文档 / 共享库 / 另一 Git 仓库）
    attachedFiles: string[];
    enabledSkills: string[];
    enabledMcpServers: string[];
    instructions?: string;
    memoryRef?: string;
    permissionPolicy?: { sandbox: string; allowReadOutside?: boolean };
  }
  ```

- [ ] **Step 2: Manager 提供 CRUD + 启动时校验：失效的 attached 路径自动清理并记录日志**
- [ ] **Step 3: 检测 attached 路径中的 Git 根与 worktree，纳入边界校验**

### Task D2：接入权限引擎与工具边界

**目标：** 文件类工具（file_read/file_write/shell_exec 等）的路径边界改为按工作区授权范围判定，而不是全局放行。

**文件：**
- 修改：`src/tools/permission-engine.ts`（路径边界判定接入 WorkspaceManager）
- 修改：`src/tools/security-enhanced.ts`（ReadTracker 边界同步）
- 新增：`tests/workspace/boundary.test.ts`

- [ ] **Step 1: 工具执行上下文注入 workspaceId，路径校验基于 projectRoot + attachedDirectories 集合**
- [ ] **Step 2: 越界路径在权限层拒绝（不依赖提示词），并进入审计日志**

---

## Part E：多 Agent 子会话可见性增强

### 背景与现状

RouteDev 已有较完整的子 Agent 基础设施：`src/tools/builtin/spawn-agent.ts`（Phase 92 已拆分为 types/utils/delegation 三文件，支持 DetachedSessionOptions、createDetachedSessionContext、buildForkedMessages）、`src/agents/delegation-contract.ts`（grant/obligation/deliverable + Challenge 质疑机制）、`src/agents/delegation-gate.ts`。但存在三个差距：

1. 子 Agent 会话不可见：没有 childSessionId 登记到会话注册表，无法从 UI 打开检查、停止；
2. 权限继承不完整：grant.allowedTools 是白名单，但没有全局 permissionCeiling（子权限不能高于父的硬约束）；
3. 缺少批量创建部分失败保留与等待策略（等待全部/任意/N 个）。

### Proma 借鉴对象

Proma 的子 Agent 是真正可见、可检查、可停止的会话：权限不能高于父 Agent；支持探索/研究/实现/审查角色；批量创建部分失败时已成功任务保留不孤儿；支持等待全部完成、任意一个完成、至少指定数量完成；主 Agent 可代答子 Agent 的问题或处理其权限阻塞；会话恢复后仍可查询子任务结果。

### Task E1：子会话可见性与停止

**目标：** spawn_agent 生成的子 Agent 登记到 SessionRegistry，UI 可打开检查、可停止。

**文件：**
- 修改：`src/agents/subagent-session.ts`（登记 childSessionId）
- 修改：`src/tools/builtin/spawn-agent-types.ts`（SpawnResult 携带 childSessionId）
- 新增：`desktop/main/bridges/agent-bridge.ts`（子会话列表/详情/停止 IPC）
- 新增：`tests/agents/subagent-visibility.test.ts`

- [ ] **Step 1: SpawnResult 增加 childSessionId，SubagentSession 创建时登记到全局会话注册表**
- [ ] **Step 2: 暴露子会话列表/详情/停止 IPC，UI 可在运行中停止单个子 Agent**
- [ ] **Step 3: 会话恢复后仍能按 childSessionId 查询子任务结果**

### Task E2：权限天花板与批量等待策略

**目标：** 补 permissionCeiling 硬约束与批量等待语义。

**文件：**
- 修改：`src/agents/delegation-contract.ts`（grant 增加 permissionCeiling）
- 修改：`src/agents/delegation-gate.ts`（执行期强制校验天花板）
- 修改：`src/tools/builtin/spawn-agent.ts`（批量等待参数）
- 新增：`tests/agents/delegation-ceiling.test.ts`

- [ ] **Step 1: DelegationContract.grant 增加 permissionCeiling（枚举：read_only / sandboxed_write / full），子 Agent 请求权限超限时直接拒绝**
- [ ] **Step 2: 批量 spawn 参数增加 completionMode: 'all' | 'anyOf' | 'minSucceed'（带 minCount），部分失败时已成功任务保留并返回部分结果**
- [ ] **Step 3: 父 Agent 可代答子 Agent 的 ask_user（复用 Part C 中断队列，标识 responder: 'parent'）**

---

## Part F：触发来源共用执行引擎与自动化自我迭代

### 背景与现状

ScheduleEngine 已于 Phase 74 死代码清理中移除（陷阱 #144 已标注废弃），定时能力处于空窗。goal-runner（`src/runtime/goal-runner.ts`）是唯一的长任务执行路径，与手动对话路径（sendChat）分离。没有 automation-scheduler，自动化任务没有自己的配置版本与迁移逻辑。

### Proma 借鉴对象

Proma 的自动化任务也创建/复用真实 Agent Session，通过同一个 headless runner 执行，保留模型、工作区、权限模式、上下文和运行历史；自动化配置带版本号和迁移逻辑；任务可被用户打开检查，失败后可直接进入对应会话继续处理。Proma 更进一步：自动化要能根据执行反馈自我迭代（优化自身提示词与 Skills）。

### Task F1：轻量 automation-scheduler（挂在 AgentSession 上）

**目标：** 重新引入定时执行能力，但每个触发都落到统一 Session 执行，而非独立引擎。

**文件：**
- 新增：`src/runtime/automation-scheduler.ts`
- 修改：`src/config/schema.ts`（automations 配置段，带 version 字段）
- 修改：`src/config/defaults.ts`
- 修改：`src/runtime/app-init.ts`（装配）
- 新增：`tests/runtime/automation-scheduler.test.ts`

- [ ] **Step 1: 定义自动化任务**
  ```typescript
  // src/runtime/automation-scheduler.ts
  export interface AutomationTask {
    id: string;
    name: string;
    cron: string;
    workspaceId?: string;
    permissionMode: 'manual' | 'semi' | 'auto';
    allowlist: string[];                 // 预授权能力白名单（读/写指定工作区/执行测试等）
    prompt: string;
    version: number;                     // 配置迁移用
  }
  ```

- [ ] **Step 2: 定时触发时创建或复用 Agent Session（triggerSource: 'automation'），复用 Part A 执行上下文**
- [ ] **Step 3: 权限白名单而非 bypassPermissions：读文件允许、修改指定工作区允许、删除禁止、发布推送二次批准（走 Part C 中断队列）**
- [ ] **Step 4: 配置带版本号与迁移逻辑，发现磁盘版本更新时不覆盖**

### Task F2：自动化自我迭代（人工审批后生效）

**目标：** 执行反馈回写任务定义，但修订建议不自动应用。

**文件：**
- 修改：`src/runtime/automation-scheduler.ts`（反馈收集）
- 新增：`src/runtime/automation-evolution.ts`（建议生成，复用 loop-memory 失败聚类）
- 新增：`tests/runtime/automation-evolution.test.ts`

- [ ] **Step 1: 每次执行后收集结果（成功/失败/耗时/token），写入任务运行历史**
- [ ] **Step 2: 定期（每 N 次执行）把「重复失败的失败原因」聚类，生成 prompt 修订建议**
- [ ] **Step 3: 建议写入建议队列，用户批准后才应用到任务定义（与 skill-lifecycle 的 Refinement 审批一致）**

---

## Part G：结构化输入框引用系统（ComposerReference）

### 背景与现状

`src/agent/context/mention-parser.ts`（Phase 71 Task B2）已实现 `@`-mention 解析，区分 file/symbol/url 三种类型。但没有统一引用协议：`/` 命令、`&` 会话、`~` Todo、Skill/MCP 引用都不存在，文件引用解析结果也没有结构化注入会话上下文。

### Proma 借鉴对象

Proma 把输入框做成上下文编排器：`/` 调命令/Skill/MCP、`@` 引用文件、`&` 引用会话、`~` 引用 Todo/日历、支持拖拽。核心价值不是快捷符号，而是「用户输入的是任务 + 显式上下文引用」，内部统一解析为结构化引用，而不是把一切拼进一段 prompt。

### Task G1：ComposerReference 统一解析器

**目标：** 扩展 mention-parser 为统一引用解析，输出结构化引用。

**文件：**
- 新增：`src/agent/context/composer-reference.ts`
- 修改：`src/agent/context/mention-parser.ts`（扩展类型映射，保持旧 API 兼容）
- 新增：`tests/agent/composer-reference.test.ts`

- [ ] **Step 1: 定义 ComposerReference**
  ```typescript
  // src/agent/context/composer-reference.ts
  export type ComposerRefType = 'file' | 'directory' | 'session' | 'task' | 'calendar' | 'skill' | 'mcp';
  export interface ComposerReference {
    type: ComposerRefType;
    id: string;
    displayName: string;
    resolvedPath?: string;
    accessScope: 'workspace' | 'attached' | 'system';
  }
  ```

- [ ] **Step 2: 解析器统一处理 `/`（skill/mcp 前缀）、`@`（file/symbol/url）、`&`（session）、`~`（task/calendar），未知符号回退纯文本**
- [ ] **Step 3: 引用解析结果结构化注入会话（作为 AgentMessage 自定义消息类型，复用 Phase 73 的 convertToLlm 过滤），而非纯文本拼接**

### Task G2：IPC 与输入框接入

**文件：**
- 修改：`desktop/shared/ipc-types.ts`（composer:resolve 等）
- 修改：`desktop/main/bridges/chat-bridge.ts`
- 修改：`desktop/preload/index.ts`
- 修改：`desktop/renderer/src/components/chat/`（输入框 @/&/~/ 提示）

- [ ] **Step 1: 新增 composer:resolve IPC，主进程解析引用并返回 accessScope 校验后的结果**
- [ ] **Step 2: 输入框支持符号前缀提示，拖拽文件解析为 file 引用**
- [ ] **Step 3: 会话引用（&）解析为会话快照摘要注入，而非整个会话原文**

---

## Part H：常驻 Agent Island 状态界面

### 背景与现状

评估 4.5 指出 RouteDev 存在「UI 状态在 renderer 二次推导、重启后可能无法重建」的问题。流式事件、权限请求、后台任务状态依赖各页面各自注册监听，页面切换或组件卸载时可能丢失。

### Proma 借鉴对象

Proma 的 Agent Island 常驻顶部，集中显示 Agent 的运行、等待交互、完成和错误状态，可直接处理工具权限请求、提问、计划审批、会话切换、定时任务入口、Todo 与日历状态；底层全局监听器保证页面切换不丢事件。

### Task H1：主进程状态聚合服务

**目标：** 主进程聚合 Agent 运行状态，成为 UI 状态的唯一权威源。

**文件：**
- 新增：`desktop/main/agent-status-service.ts`
- 修改：`desktop/main/engine-bridge.ts`（接入）
- 新增：`tests/desktop/agent-status-service.test.ts`

- [ ] **Step 1: 聚合运行中 session 的状态：running / waiting_interruption / completed / error，附中断队列计数**
- [ ] **Step 2: 状态快照按 sessionId 持久化，重启后可从快照重建 UI 状态**

### Task H2：AgentIsland 组件

**文件：**
- 新增：`desktop/renderer/src/components/agent/AgentIsland.tsx`
- 修改：`desktop/renderer/src/App.tsx`（顶部常驻挂载）
- 修改：`desktop/renderer/src/main.tsx`（全局状态订阅）

- [ ] **Step 1: 顶部常驻状态条：运行中显示 spinner 与时长，等待中断时高亮并可直接处理（复用 Part C 中断队列）**
- [ ] **Step 2: 点击状态条可切换/打开对应 session，后台任务可从状态条进入**
- [ ] **Step 3: 所有状态数据来自 agent-status-service，renderer 不做二次推导**

---

## Part I：极简记忆与 Skills 沉淀

### 背景与现状

RouteDev 已有较重的记忆设施：`src/memory/`（bm25-index、hybrid-retriever、project-memory、unified-memory、provenance-graph）与 `src/agent/memory/`（知识图谱 graph.ts + recall-injector + loop-memory）。但缺少轻量用户档案层，也没有「命中/触发率」观测：哪些记忆条目和 Skill 被真实使用，哪些长期闲置，无法量化。

### Proma 借鉴对象

Proma 明确不做宽泛 RAG 记忆：严肃场景只用几百字 User Profile schema（职业、最近在做的事、水平、交互偏好、必记信息）拼进提示词，靠模型推理能力起效；用触发率统计持续迭代记忆；流程化内容由内置 Coach Skill 引导沉淀为文档和 Skills，而非依赖模糊的关联搜索。

### Task I1：轻量 UserProfile

**目标：** 引入几百字的用户档案 schema，进入系统提示词正式组成部分。

**文件：**
- 新增：`src/memory/user-profile.ts`
- 修改：`src/prompts/manager.ts`（渲染档案）
- 修改：`src/config/schema.ts`（userProfile 配置段）
- 新增：`tests/memory/user-profile.test.ts`

- [ ] **Step 1: 定义 UserProfile schema（职业/当前工作/水平/交互偏好/必记信息，总量控制在几百字内）**
- [ ] **Step 2: prompt 渲染时注入 UserProfile，空档案时安全降级不报错**

### Task I2：触发率统计与低效淘汰

**目标：** 为记忆条目与 Skills 建立使用计数，低触发率降级。

**文件：**
- 新增：`src/memory/hit-stat.ts`（计数 + 报表）
- 修改：`src/skills/market-manager.ts`（Skill 使用计数）
- 修改：`src/agent/memory/recall-injector.ts`（记忆命中计数）
- 新增：`tests/memory/hit-stat.test.ts`

- [ ] **Step 1: 统一 hit-stat 记录点：记忆召回命中、Skill 激活、UserProfile 字段引用**
- [ ] **Step 2: 周期统计（复用 trace 数据），触发率低于阈值的记忆标记 deprecated，Skill 建议移除或重写**

### Task I3：流程沉淀引导（Skills 化）

**目标：** 识别可复用的流程化内容，引导沉淀为 Skill（人工批准后落盘）。

**文件：**
- 新增：`src/skills/coach.ts`（沉淀建议生成）
- 修改：`src/skills/skill-lifecycle.ts`（复用 Refinement 审批路径）

- [ ] **Step 1: 完成任务后检测「重复出现的工作流模式」（基于 trace 的 tool 序列聚类），生成 Skill 草案建议**
- [ ] **Step 2: 建议经用户批准后进入现有 skill-lifecycle 落盘流程，不自动写入**

---

## 执行顺序与依赖关系

```
Part A（统一 Session 与事件生命周期）── 基础设施，其余 Part 依赖其 Session/事件语义
  ├── Part C（全局中断队列）── 依赖 A 的事件类型
  ├── Part D（工作区能力边界）── 独立，可与 C 并行
  ├── Part B（联合回滚）── 依赖 A 的 turn 语义 + 现有 CheckpointManager
  ├── Part E（子会话可见性）── 依赖 A 的 Session 注册 + C 的中断队列
  ├── Part G（输入框引用）── 依赖 A 的会话语义 + C（权限场景）
  └── Part F（统一执行引擎 + 自动化）── 依赖 A + D（工作区）+ C（审批）
  Part H（Agent Island）── 依赖 A + C
  Part I（极简记忆）── 独立，随时可并行
```

**建议执行顺序**：A →（C、D 并行）→（B、E、G 并行）→（F、H），I 穿插进行。

---

## 借鉴点权衡（desktop-only 过滤）

| 借鉴点 | Proma 设计 | RouteDev 适用性 | 决策 |
|--------|-----------|----------------|------|
| 统一 Session 与执行上下文 | AgentSession 统一抽象 + triggerSource | **高**——直接命中评估 P0 事件协议差距 | ✅ 落地（Part A） |
| 事件生命周期 | agent/turn/message start/update/end | **高**——时间线失真根因 | ✅ 落地（Part A2） |
| 对话与文件联合回滚 | SDK 文件历史快照 | **高**——CheckpointManager 升级 | ✅ 落地（Part B） |
| 全局中断队列 | 统一 Interruption + 全局监听 | **高**——审批/提问/审批散落 | ✅ 落地（Part C） |
| 工作区能力边界 | 工作区隔离 + 附加目录 | **高**——信任/Skill/MCP 归属统一 | ✅ 落地（Part D） |
| 多 Agent 可见子会话 | 子会话可检查可停止 + 权限继承 | **中高**——已有 Delegation 基础，补语义 | ✅ 落地（Part E，适度） |
| 自动化自我迭代 | 执行反馈回写 + 配置迁移 | **中**——ScheduleEngine 已移除，重建轻量版 | ✅ 落地（Part F） |
| 结构化输入框引用 | Composer 统一解析 | **中**——mention-parser 已覆盖 @ | ✅ 落地（Part G，扩展现有） |
| 常驻 Agent Island | 全局状态聚合 + 顶层监听 | **中**——解决 UI 二次推导问题 | ✅ 落地（Part H） |
| 极简记忆 | User Profile + 触发率 + Skills 沉淀 | **中**——现有记忆偏重，补轻量层 | ✅ 落地（Part I，适度） |
| 双内核（Claude/Pi SDK 内嵌） | runtime-routing-adapter | **低**——自研引擎已深度耦合，先做 kernel 插槽 | ⚠️ 只做接口预留（Part A3），不引入 SDK |
| 本地优先 JSON/JSONL 存储 | 索引 JSON + 会话 JSONL | **已具备**——trace 已用 JSONL | ❌ 不新增（对齐现有） |
| 消息平台桥接（飞书） | feishu-bridge | **已有远程协议**——SSE 网关 v1 已落地 | ❌ 本 Phase 不做，留待远程 Phase |
| 商业模式（AGPL 双许可） | 开源 + 商业授权 | **不适用** | ❌ 不落地 |
| 打包 native binary 方案 | SDK 外置 200MB | **不适用**——不自研内核 | ❌ 不落地 |

---

## 验收标准

- [ ] Part A：AgentExecutionContext 贯穿 loop/goal/子 Agent 路径；EngineEventV1 事件含 agent/turn/message 生命周期与 sequence 游标；固定「模型思考中」伪文案已删除；kernel 接口有 routedev-native 实现与测试
- [ ] Part B：每个 turn 生成 TurnSnapshot（含文件 hash 与授权边界），恢复前路径校验生效，非代码文件可回滚
- [ ] Part C：Interruption 统一入 Broker，渲染层全局监听不丢事件，渲染层重载可 reclaim，abort 自动拒绝未处理中断
- [ ] Part D：WorkspaceManager 提供 CRUD 与附加目录校验，文件工具路径边界按工作区授权范围判定
- [ ] Part E：spawn_agent 结果携带 childSessionId 且可停止；permissionCeiling 执行期强制；批量等待 completionMode 生效
- [ ] Part F：automation-scheduler 定时触发复用统一 Session 执行，权限白名单生效，配置版本迁移可用，自我迭代建议经审批后应用
- [ ] Part G：ComposerReference 解析器覆盖 / @ & ~ 前缀，引用结构化注入会话，accessScope 校验生效
- [ ] Part H：agent-status-service 聚合状态并持久化，AgentIsland 常驻顶部，UI 状态可从快照重建
- [ ] Part I：UserProfile 进入系统提示词（空档案安全降级）；hit-stat 记录 Skill 与记忆触发率；流程沉淀建议经审批后落盘
- [ ] 所有新增配置/模块有消费点，无死代码
- [ ] 所有新增类型/工具/服务有测试覆盖，`pnpm test` 全绿
- [ ] tsc --noEmit exit 0
