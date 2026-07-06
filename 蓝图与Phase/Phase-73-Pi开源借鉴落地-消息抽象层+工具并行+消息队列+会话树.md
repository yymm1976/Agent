# Phase 73：Pi 开源借鉴落地——消息抽象层+工具并行精化+消息队列+会话树增强

**目标：** 将 Pi 开源项目（earendil-works/pi，67.9k Stars）的 4 个高价值借鉴点落地为 RouteDev 桌面应用的实际能力提升。每个借鉴点已核验 Pi 源码实现，并对照 RouteDev 现状评估可行性。RouteDev 是 Electron + React 桌面应用（非 CLI），借鉴时保留桌面交互范式，不引入 CLI 模式。附带供应链安全加固。

**架构：** 五 Part 渐进推进——① AgentMessage 消息抽象层（基础设施，后续 Part 依赖）；② 工具并行执行精化（per-tool executionMode）；③ Steering/Follow-up 双消息队列（桌面核心 UX）；④ 会话树结构增强（CompactionEntry + BranchSummaryEntry + append-only 持久化）；⑤ 供应链安全加固（npm pin + age-gate）。落地顺序严格按 A→B→C→D，因为 A 的消息类型抽象是 C 的 steering 自定义类型和 D 的 CompactionEntry 注入的基础。

**涉及文件：** 新增约 10 文件，修改约 20 文件。

**前置依赖：** Phase 72（外部借鉴落地与代码地图优化）已完成；Phase 61（ACRouter 闭环模型路由）已完成；Phase 70（上下文压缩技术优化）已完成。第八轮死代码清理已完成（engine-bridge.ts Wiring-Bug 修复，16 个 deps 已补传）。

**严禁死代码原则（继承自 Phase 72）：**
1. 每个新增配置字段必须在同一次 PR 内接入消费点
2. 每个新增模块必须有至少一个调用方
3. 每个新增函数必须有测试覆盖
4. 子 Agent 审计时若发现"配置僵尸"或"孤立模块"，直接标 Critical 阻塞合入

---

## Pi 源码参考

| 借鉴点 | Pi 源码文件 | 核心机制 |
|--------|------------|----------|
| AgentMessage/convertToLlm | `packages/agent/src/types.ts` + `agent-loop.ts` | declaration merging + 双层转换（transformContext→convertToLlm） |
| per-tool executionMode | `packages/agent/src/types.ts` + `agent-loop.ts` | executionMode 字段 + batch 级 sequential 检测 + 两阶段并行 |
| Steering/Follow-up | `packages/agent/src/agent.ts` + `agent-loop.ts` | PendingMessageQueue + 双层循环注入点 + QueueMode |
| 会话树 JSONL | `packages/coding-agent/src/core/session-manager.ts` | append-only + id/parentId + CompactionEntry + BranchSummaryEntry |

---

## Part A：AgentMessage 消息抽象层（基础设施）

### 背景与现状

RouteDev 当前消息类型是扁平的 `LLMMessage`（`src/router/types.ts`）：

```typescript
export interface LLMMessage {
  role: MessageRole;  // 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[];
}
```

所有消息必须是 user/assistant/tool/system，无法表达"UI 通知""状态变更""artifact 引用"等非 LLM 消息。loop 直接把 `messages: LLMMessage[]` 传给 LLM 客户端，没有过滤/转换层。context-compaction.ts 直接操作 LLMMessage[]，compaction 逻辑和消息格式强耦合。steering 消息被硬编码为 user role（`[用户转向指令] ${msg.content}`），LLM 无法区分真实用户消息和系统注入的转向指令。

### Pi 源码实现

Pi 的核心设计是 **AgentMessage = LLM Message + 自定义消息类型**，通过 TypeScript declaration merging 扩展：

```typescript
// Pi: packages/agent/src/types.ts
export interface CustomAgentMessages {}  // 空接口，应用通过 declaration merging 扩展
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// 应用扩展
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}
```

Pi 在每次 LLM 调用前执行双层转换：

```typescript
// Pi: packages/agent/src/agent-loop.ts streamAssistantResponse()
// 1. transformContext: AgentMessage[] → AgentMessage[]（裁剪旧消息、注入外部上下文）
if (config.transformContext) {
  messages = await config.transformContext(messages, signal);
}
// 2. convertToLlm: AgentMessage[] → Message[]（过滤 UI-only、转换自定义类型）
const llmMessages = await config.convertToLlm(messages);
// 3. 调用 LLM
const response = await streamFunction(config.model, llmContext, { ...config, signal });
```

默认 `convertToLlm` 只保留 user/assistant/toolResult：
```typescript
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(m => ["user", "assistant", "toolResult"].includes(m.role));
}
```

### Task A1：引入 AgentMessage 联合类型

**目标：** 在 RouteDev 中引入 AgentMessage 类型，保留现有 LLMMessage 作为子集，新增 CustomAgentMessages 空接口供插件扩展。

**文件：**
- 新增：`src/agent/message-types.ts`（AgentMessage 联合类型 + CustomAgentMessages 接口）
- 修改：`src/agent/loop.ts`（消息数组类型从 LLMMessage[] 改为 AgentMessage[]）
- 修改：`src/agent/loop-config.ts`（新增 convertToLlm 钩子）
- 新增：`tests/agent/message-types.test.ts`

- [ ] **Step 1: 定义 AgentMessage 联合类型**
  ```typescript
  // src/agent/message-types.ts
  import { LLMMessage } from '../router/types';

  /** 自定义 Agent 消息类型接口，插件通过 declaration merging 扩展 */
  export interface CustomAgentMessages {}

  /** Agent 消息 = 标准 LLM 消息 + 自定义消息类型 */
  export type AgentMessage = LLMMessage | CustomAgentMessages[keyof CustomAgentMessages];

  /** 默认 convertToLlm：只保留 LLM 能理解的消息 */
  export function defaultConvertToLlm(messages: AgentMessage[]): LLMMessage[] {
    return messages.filter(
      (m): m is LLMMessage =>
        m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'system'
    );
  }
  ```

- [ ] **Step 2: 在 LoopConfig 中加 convertToLlm 钩子**
  ```typescript
  // src/agent/loop-config.ts
  convertToLlm?: (messages: AgentMessage[]) => LLMMessage[];
  // 默认使用 defaultConvertToLlm
  ```

- [ ] **Step 3: 在 ReActAgentLoop 调用 LLM 前插入 convertToLlm**
  ```typescript
  // src/agent/loop.ts — 在调用 llmClient.stream() 前
  const convertFn = this.config.convertToLlm ?? defaultConvertToLlm;
  const llmMessages = convertFn(messages as AgentMessage[]);
  // 用 llmMessages 调用 LLM
  ```

- [ ] **Step 4: 将 context-compaction.ts 的入口签名对齐 transformContext**
  ```typescript
  // src/agent/context-compaction.ts
  // 签名改为 transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>
  // 内部逻辑不变，只是类型从 LLMMessage[] 扩展为 AgentMessage[]
  ```

---

## Part B：工具并行执行精化（per-tool executionMode）

### 背景与现状

RouteDev 已有并行执行（`loop.ts` L970-1180），但只有全局 `parallelToolExecution: boolean` 开关，无 per-tool 粒度。`ask_user` 工具被硬编码为串行特殊处理（`if (toolCall.name === 'ask_user')`），无法声明式表达。

### Pi 源码实现

Pi 的工具类型有 `executionMode?: "sequential" | "parallel"` 字段。执行时的决策逻辑：

```typescript
// Pi: packages/agent/src/agent-loop.ts executeToolCalls()
// batch 中任意一个工具是 sequential → 整个 batch 串行
const hasSequentialToolCall = toolCalls.some(
  (tc) => context.tools?.find(t => t.name === tc.name)?.executionMode === "sequential",
);
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
  return executeToolCallsSequential(...);
}
return executeToolCallsParallel(...);
```

并行执行分两阶段（preflight 串行 + 执行并发）：
- 阶段 1：串行 preflight（emit tool_execution_start + beforeToolCall + 参数校验）
- 阶段 2：`Promise.all` 并发执行所有待执行函数
- 阶段 3：按 assistant source order emit toolResult 消息

### Task B1：在 ToolDefinition 中加 executionMode 字段

**目标：** 给 RouteDev 的工具定义加 `executionMode` 字段，batch 级 sequential 检测，删除 ask_user 硬编码。

**文件：**
- 修改：`src/tools/types.ts`（ToolDefinition 加 executionMode）
- 修改：`src/agent/loop.ts`（batch 级 sequential 检测 + 删除 ask_user 硬编码）
- 修改：`src/tools/builtin/ask-user.ts`（标记 executionMode: 'sequential'）
- 修改：`src/tools/builtin/file-edit.ts`（标记 executionMode: 'sequential'，有文件系统竞争）
- 修改：`src/tools/builtin/shell-exec.ts`（标记 executionMode: 'sequential'，有进程竞争）
- 新增：`tests/agent/tool-execution-mode.test.ts`

- [ ] **Step 1: 在 ToolDefinition 中加 executionMode**
  ```typescript
  // src/tools/types.ts
  export interface ToolDefinition {
    // ... 现有字段 ...
    /** 工具执行模式：'sequential' 串行（有状态竞争），'parallel' 并行（默认） */
    executionMode?: 'sequential' | 'parallel';
  }
  ```

- [ ] **Step 2: 在 ReActAgentLoop 并行分支前加 batch 级检测**
  ```typescript
  // src/agent/loop.ts — 并行执行分支前
  const hasSequential = result.toolCalls.some(tc => {
    const tool = this.toolRegistry.get(tc.name);
    return tool?.executionMode === 'sequential';
  });
  if (this.config.parallelToolExecution && !hasSequential && result.toolCalls.length > 1) {
    // 走并行分支
  } else {
    // 走串行分支
  }
  ```

- [ ] **Step 3: 给有状态竞争的工具标记 sequential**
  - `ask-user.ts`：`executionMode: 'sequential'`
  - `file-edit.ts`：`executionMode: 'sequential'`
  - `shell-exec.ts`：`executionMode: 'sequential'`
  - `web-search.ts` / `code-search.ts`：保持默认（parallel）

- [ ] **Step 4: 删除 loop.ts 中 ask_user 硬编码**
  搜索 `ask_user` 特殊处理分支，删除，改由 executionMode 声明式控制。

---

## Part C：Steering/Follow-up 双消息队列（桌面核心 UX）

### 背景与现状

RouteDev 已有 steering（`task-orchestrator-types.ts`），但**没有 follow-up**。用户无法排队"Agent 做完这个之后再做那个"。steering 消息被硬编码为 user role 字符串拼接（`[用户转向指令] ${msg.content}`），LLM 无法区分真实用户消息和转向指令。无 QueueMode（一次 drain 全部，不支持 one-at-a-time 逐步引导）。无 clearSteeringQueue API。

### Pi 源码实现

Pi 的 PendingMessageQueue 只有 30 行：

```typescript
// Pi: packages/agent/src/agent.ts
class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  public mode: QueueMode;  // "all" | "one-at-a-time"

  enqueue(message: AgentMessage): void { this.messages.push(message); }
  hasItems(): boolean { return this.messages.length > 0; }
  drain(): AgentMessage[] {
    if (this.mode === "all") { const drained = this.messages.slice(); this.messages = []; return drained; }
    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }
  clear(): void { this.messages = []; }
}
```

核心循环是双层 while：
- **内层循环**：tool calls + steering 驱动。turn 结束后检查 steering 队列，有则注入并继续
- **外层循环**：follow-up 驱动。内层循环自然退出时检查 follow-up 队列，有则注入并重新进入内层循环

steering 在 turn 结束后（工具已执行完）注入，follow-up 在 agent 本会停止时注入。shouldStopAfterTurn 优先于 steering/follow-up（compaction 等场景可强制停止）。

### Task C1：新增 follow-up 队列 + 双层循环

**目标：** 在 ReActAgentLoop 中新增 follow-up 队列，改造循环为双层结构。steering 消息改为自定义 AgentMessage 类型。

**文件：**
- 修改：`src/agent/loop.ts`（加 followUpQueue + 双层循环 + steering 类型改造）
- 修改：`src/agent/loop-config.ts`（加 steeringMode/followUpMode 配置）
- 修改：`src/agent/task-orchestrator-types.ts`（SteeringMessage 改为 AgentMessage 自定义类型）
- 修改：`desktop/main/engine-bridge.ts`（暴露 followUp/clearAllQueues IPC）
- 修改：`desktop/renderer/src/App.tsx`（UI 支持 follow-up 队列展示）
- 新增：`tests/agent/follow-up-queue.test.ts`

- [ ] **Step 1: 定义 steering 自定义消息类型**
  ```typescript
  // src/agent/message-types.ts — 通过 declaration merging 扩展
  declare module './message-types' {
    interface CustomAgentMessages {
      steering: { role: 'steering'; content: string; enqueuedAt: number; mode: string };
    }
  }
  ```

- [ ] **Step 2: 新增 followUpQueue 和 clearAllQueues API**
  ```typescript
  // src/agent/loop.ts
  private followUpQueue: AgentMessage[] = [];
  private followUpMode: 'all' | 'one-at-a-time' = 'one-at-a-time';

  followUp(message: AgentMessage): void { this.followUpQueue.push(message); }
  clearFollowUpQueue(): void { this.followUpQueue = []; }
  clearAllQueues(): void { this.clearSteeringQueue(); this.clearFollowUpQueue(); }
  ```

- [ ] **Step 3: 改造循环为双层结构**
  内层循环：现有 ReAct 循环 + turn 结束后检查 steering 队列。
  外层循环：内层循环自然退出时检查 follow-up 队列，有则注入并重新进入内层循环。

- [ ] **Step 4: steering 消息注入改为自定义类型 + convertToLlm 转换**
  steering 消息以 `{ role: 'steering', content, enqueuedAt }` 存入消息流。
  convertToLlm 中将 steering 转换为 user 消息（带前缀），LLM 可看到，UI 可高亮区分。

- [ ] **Step 5: 暴露 IPC API 给 renderer**
  - `agent:followUp` — 排队 follow-up 消息
  - `agent:clearAllQueues` — 清空所有队列
  - `agent:queueStatus` — 查询队列状态（条数）

- [ ] **Step 6: UI 支持 follow-up 队列展示**
  在消息输入区下方显示"已排队 N 条后续消息"，支持点击展开/删除。

---

## Part D：会话树结构增强（CompactionEntry + BranchSummaryEntry + append-only）

### 背景与现状

RouteDev 已有 BranchManager（`src/agent/branch.ts`）和 BranchPersistence（`src/agent/branch-persistence.ts`），核心树结构（id/parentId/children）已对齐 Pi。但存在三个差距：

1. **持久化非 append-only**：`tree.jsonl` 整树重写（有 .bak 备份），Pi 是每条 entry 追加一行
2. **BranchNode 只存 LLMMessage**：无法表达 compaction/model_change 等元数据事件
3. **无 CompactionEntry 和 BranchSummaryEntry**：compaction 不在树结构记录，切换分支时被放弃分支上下文完全丢失

### Pi 源码实现

Pi 的会话 entry 是联合类型：

```typescript
// Pi: session-manager.ts
export type SessionEntry =
  | SessionMessageEntry          // { type: "message", message: AgentMessage }
  | CompactionEntry              // { type: "compaction", summary, firstKeptEntryId, tokensBefore }
  | BranchSummaryEntry           // { type: "branch_summary", fromId, summary }
  | ModelChangeEntry             // { type: "model_change", provider, modelId }
  | LabelEntry                   // { type: "label", targetId, label }
  | CustomEntry                  // { type: "custom", customType, data }
  | ...;
```

重建 context 的算法：从 leaf 往 root 走，找路径上最新的 CompactionEntry，用 compaction 摘要 + firstKeptEntryId 之后的 entry 重建 context。BranchSummaryEntry 在切换分支时生成，让 LLM 知道"之前探索过什么方案"。

### Task D1：补 CompactionEntry + BranchSummaryEntry

**目标：** 扩展 BranchNode 为联合类型，新增 CompactionEntry 和 BranchSummaryEntry。compaction 操作改为追加节点而非原地修改。切换分支时生成摘要节点。

**文件：**
- 修改：`src/agent/branch.ts`（BranchNode 扩展为联合类型）
- 修改：`src/agent/branch-persistence.ts`（append-only JSONL + entry 类型序列化）
- 修改：`src/agent/context-compaction.ts`（压缩时追加 CompactionEntry 节点）
- 修改：`src/agent/branch-operations.ts`（切换分支时生成 BranchSummaryEntry）
- 新增：`tests/agent/session-tree-entries.test.ts`

- [ ] **Step 1: 扩展 BranchNode 为联合类型**
  ```typescript
  // src/agent/branch.ts
  export type BranchNode = MessageNode | CompactionNode | BranchSummaryNode | ModelChangeNode;

  export interface MessageNode extends BaseNode {
    type: 'message';
    message: AgentMessage;
  }
  export interface CompactionNode extends BaseNode {
    type: 'compaction';
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  }
  export interface BranchSummaryNode extends BaseNode {
    type: 'branch_summary';
    fromId: string;
    summary: string;
  }
  export interface ModelChangeNode extends BaseNode {
    type: 'model_change';
    provider: string;
    modelId: string;
  }
  ```

- [ ] **Step 2: context-compaction.ts 压缩时追加 CompactionEntry**
  压缩后不原地修改 messages 数组，而是往树追加一个 CompactionNode（含 summary + firstKeptEntryId + tokensBefore）。重建 context 时从 leaf 往 root 找最新 CompactionNode，用其 summary + firstKeptEntryId 之后的 MessageNode 重建。

- [ ] **Step 3: 切换分支时生成 BranchSummaryEntry**
  调用 LLM 生成被放弃分支的摘要（1-2 句话），追加为 BranchSummaryNode。重建 context 时注入为 user 消息（"之前探索过 X 方案，因为 Y 原因放弃"），让 LLM 有探索历史。

- [ ] **Step 4: 持久化改为 append-only JSONL**
  `branch-persistence.ts` 从 `JSON.stringify(tree)` 整体写入改为每行一个 entry 追加。保留 .bak 作为迁移期兜底。load 时检测格式（旧格式整树 JSON vs 新格式 JSONL），自动迁移。

- [ ] **Step 5: 加 model_change entry**
  RouteDev 有多模型路由（ACRouter），模型切换时往树追加 ModelChangeNode。重建 context 时提取最新模型设置。

---

## Part E：供应链安全加固（npm pin + age-gate）

### 背景与现状

RouteDev 当前 npm 依赖管理是标准模式，无精确版本锁定、无发布年龄门控。Pi 的供应链安全实践值得借鉴。

### Pi 实践

Pi 对 npm 依赖安全极其重视：
- `.npmrc` 设置 `save-exact=true`（直接依赖精确版本锁定）
- `.npmrc` 设置 `min-release-age=2`（拒绝发布不到 2 天的依赖）
- `package-lock.json` 是依赖真实来源
- 发布的 CLI 包含 `npm-shrinkwrap.json`

### Task E1：npm 配置加固

**目标：** 在 RouteDev 的 `.npmrc` 中添加供应链安全配置。

**文件：**
- 修改：`.npmrc`

- [ ] **Step 1: 添加 npm 安全配置**
  ```ini
  # .npmrc
  save-exact=true
  min-release-age=2
  ```
  注：RouteDev 是桌面应用不需要 shrinkwrap（Electron 打包已包含依赖），但 save-exact 和 age-gate 对开发依赖安全有效。

---

## 执行顺序与依赖关系

```
Part A（消息抽象层）── 基础设施
  ↓
Part B（工具并行精化）── 独立，可与 A 并行
  ↓
Part C（消息队列）── 依赖 A 的自定义消息类型
  ↓
Part D（会话树增强）── 依赖 A 的消息类型 + C 的 steering 类型
  ↓
Part E（供应链安全）── 独立，可随时并行
```

**建议执行顺序**：A → B（并行）→ C → D，E 随时穿插。

---

## Pi 借鉴点权衡（desktop-only 过滤）

| 借鉴点 | Pi 设计 | RouteDev 适用性 | 决策 |
|--------|---------|----------------|------|
| AgentMessage/convertToLlm | declaration merging + 双层转换 | **高**——桌面有大量 UI-only 状态 | ✅ 落地（Part A） |
| per-tool executionMode | executionMode 字段 + batch 检测 | **高**——file_edit/shell_exec 有竞争 | ✅ 落地（Part B） |
| Steering/Follow-up 队列 | 双队列 + QueueMode + 双层循环 | **高**——桌面核心 UX | ✅ 落地（Part C） |
| 会话树 JSONL | append-only + 丰富 entry 类型 | **中**——已有树骨架，增强 entry | ✅ 落地（Part D，适度） |
| 供应链安全 | save-exact + age-gate | **中**——开发依赖安全 | ✅ 落地（Part E） |
| Extension 热重载 | 主题热重载 + /reload | **低**——Electron 已有 hot-reload | ❌ 不落地（Electron HMR 已覆盖） |
| Agent Skills 标准 | SKILL.md = Markdown | **低**——RouteDev Skills 已更复杂 | ❌ 不落地（现有 Skills 系统更强大） |
| 低级 API | agentLoop() 无 Agent 类 | **低**——桌面不需要嵌入 | ❌ 不落地（loop.ts 已耦合桌面状态） |
| RPC 模式 | stdin/stdout JSONL | **不适用**——桌面用 IPC | ❌ 不落地 |
| 独立 agent-core 包 | npm 包独立 | **不适用**——桌面单体 | ❌ 不落地 |
| Pi Packages 分发 | npm/git 分发扩展 | **不适用**——桌面应用 | ❌ 不落地 |
| "不做"哲学 | 6 个不做 | **不适用**——RouteDev 全功能路线 | ❌ 不落地（设计路线不同） |

---

## 验收标准

- [ ] Part A：AgentMessage 类型可用，convertToLlm 钩子在 LLM 调用前执行，自定义消息类型被过滤
- [ ] Part B：file_edit/shell_exec/ask_user 标记 sequential，并行执行时自动走串行分支，ask_user 硬编码已删除
- [ ] Part C：follow-up 队列可用，用户可排队后续消息，Agent 完成当前工作后自动处理队列
- [ ] Part D：CompactionEntry 追加到树而非原地修改，BranchSummaryEntry 在切换分支时生成，持久化为 append-only JSONL
- [ ] Part E：.npmrc 包含 save-exact=true 和 min-release-age=2
- [ ] 所有新增配置/模块有消费点，无死代码
- [ ] tsc --noEmit exit 0
