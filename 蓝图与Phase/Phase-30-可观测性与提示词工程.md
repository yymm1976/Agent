# Phase 30 — 可观测性与提示词工程

> **版本目标：** v2.2.0
> **前置依赖：** Phase 29 完成（v2.1.0）
> **新增测试要求：** ≥ 40 个
> **蓝图引用：** BLUEPRINT.md §可观测性、§提示词系统
> **核心哲学：** "不测量就不知道钱花在哪"——先装水表，再谈节水。

---

## 背景与动机

RouteDev 已经是一个功能完备的 Agent：29 个 Phase、1339 个测试、123 个文件。但我们有一个致命盲区——**不知道每次对话的 Token 花在了哪里**。

打个比方：你家装了总水表（TokenTracker 记录每天的总用量），但厨房、卫生间、洗衣机都没有分表。某天账单暴涨，你只知道"用多了"，却不知道是马桶漏水还是洗衣机太费水。

Phase 30 要解决三件事：
1. **装分表**（可观测性）：给系统提示词、对话历史、工具定义、工具返回、检索上下文这五个"用水点"分别装水表，每次 LLM 调用都记录各分表读数。
2. **改管道**（上下文优化）：尝试三种节水方案——结构化实体状态、声明式上下文获取、简洁思考约束——但每种都留后路（配置开关），随时可以拧回旧管道。
3. **换门牌**（系统提示词重构）：研究 Claude Code、Cursor、Devin 等竞品的提示词，提炼最佳模式，重写 RouteDev 的"自我介绍"，同时把一直未接入的 PromptTemplateManager 正式通电。

---

## 接口对齐观察表

> **审计方式：** 用 Explore Agent 对代码库逐项核实，以下为已验证的签名和事实。

| 接口/模块 | 已验证签名 | 所在文件:行号 | 备注 |
|-----------|-----------|-------------|------|
| `ContextCompactor` | `class ContextCompactor { constructor(config: CompactionConfig); async compact(messages: LLMMessage[]): Promise<{messages, result: CompactionResult}> }` | `src/agent/context-compaction.ts:59-73` | **死代码**：从未被实例化，`setCompactor()` 从未被调用 |
| `CompactionConfig` | `{ targetTokens, estimateTokens, summarize?, thresholds?, contextWindow? }` | `context-compaction.ts:39-50` | L1-L5 五级渐进压缩 |
| `ContextManager.setCompactor()` | `setCompactor(compactor: ContextCompactor): void` | `src/agent/context-manager.ts:88` | 已定义但无调用方 |
| `ContextManager.compactIfNeeded()` | `async compactIfNeeded(messages): Promise<LLMMessage[]>` | `context-manager.ts:449` | 委托给 compactor |
| `ReActAgentLoop.run()` | `async *run(params: ReActRunParams): AsyncGenerator<ReActEvent>` | `src/agent/loop.ts:85` | params 含 `conversationHistory`, `systemPrompt`, `routeDecision` |
| `ReActRunParams` | `{ userMessage, llmClient, routeDecision, conversationHistory, systemPrompt?, signal?, onConfirmTool? }` | `loop.ts:32-47` | systemPrompt 是独立字段，不在 messages 数组里 |
| `LLMRequestOptions` | `{ model, messages, systemPrompt?, tools?, maxTokens, timeoutMs, stream }` | `loop.ts:494-502` | systemPrompt 由 LLM 客户端协议层处理 |
| `TokenUsageInfo` | `{ inputTokens, outputTokens, totalTokens, cacheCreationInputTokens?, cacheReadInputTokens? }` | `src/router/types.ts:84-91` | cache 字段已定义但从未被填充 |
| `TokenTracker.record()` | `record(usage: TokenUsageInfo, meta: {modelId, agentId, stepId}): void` | `src/router/tracker.ts:43+` | chat-runner:149 调用，goal-runner:203 调用 |
| `TokenTracker.checkBudget()` | `checkBudget(): { exceeded, usagePercent, action }` | `tracker.ts` | **从未被调用**——预算执行是空架子 |
| chat-runner token 流 | `finalUsage` 初始化(89) → done 事件捕获(142) → setTodayTokensUsed(148) → tracker.record(149) | `src/cli/chat-runner.ts` | 只在 done 事件记录一次，无中间步骤归因 |
| goal-runner token 流 | tracker.record(203-207) | `src/cli/goal-runner.ts` | **缺少 setTodayTokensUsed**；验证步骤(292)和对抗步骤(278-288)完全不记录 token |
| `PromptTemplateManager` | `class PromptTemplateManager { async getTemplate(id), async render(id, context), listTemplateIds(), ... }` | `src/prompts/manager.ts:379+` | **死代码**：App.tsx 用 `getSystemPrompt()` 硬编码，从未调用 render() |
| `main.system` 模板 | 7 变量：`{{language}}`, `{{autonomyMode}}`, `{{projectRules}}`, `{{projectMemory}}`, `{{blackboard}}`, `{{availableTools}}`, `{{conversationContext}}` | `manager.ts:30-60` | 模板存在但从未在生产路径渲染 |
| App.tsx 系统提示 | `const systemPrompt = getSystemPrompt(config.general.language)` | `src/cli/App.tsx:98` | 直接调用 fallback 函数，返回硬编码字符串 |
| `getSystemPrompt()` | `function getSystemPrompt(language: string = 'zh-CN'): string` | `src/agent/prompts.ts:62-67` | 仅返回 DEFAULT_SYSTEM_PROMPT_ZH 或 EN |
| `estimateTokens()` | `function estimateTokens(text: string): number` | `src/utils/token-estimate.ts` | CJK 感知启发式（1.5 tok/CJK，0.25 tok/其他） |
| `estimateMessagesTokens()` | `function estimateMessagesTokens(messages: LLMMessage[]): number` | `src/router/token-counter.ts` | 含 ContentPart 支持 |
| `CacheStatsTracker` | `class CacheStatsTracker` | `src/router/cache-optimizer.ts:225-305` | **死代码**：从未实例化 |
| `AppConfigSchema` | Zod schema，顶层 16 个 section | `src/config/schema.ts` | 无 `optimization` 或 `experimental` section |
| `ServiceContext` | 30+ 字段接口 | `src/cli/service-context.ts:68` | 含 `prompts: PromptTemplateManager`, `tracker: TokenTracker` |

### 不一致项

| 项目 | 实际情况 | 修正 |
|------|---------|------|
| `PromptTemplateManager.get()` | 不存在此方法，正确方法是 `getTemplate(id)` 和 `render(id, context)` | Phase 文件使用正确方法名 |
| `ContextCompactor` 已接入 | 代码完整但从未实例化，是死代码 | Phase 30 需要先"激活"再接入 |
| `TokenTracker.checkBudget()` 已执行 | 方法存在但调用方为零 | Phase 30 需要接入 chat/goal runner |
| goal-runner token 记录完整 | 缺少 `setTodayTokensUsed`，验证/对抗步骤不记录 | Phase 30 需修补 |

---

## Task 1：Token 可观测性基础设施（最高优先级）

> **比喻：** 给每个"用水点"装分表。总表已经有了（TokenTracker），现在要装厨房表（系统提示词）、卫生间表（对话历史）、洗衣机表（工具定义）、花园表（工具返回）。

### 1.1 新增 `optimization` 配置节

在 `src/config/schema.ts` 的 `AppConfigSchema` 中新增顶层 section：

```
optimization:
  tokenTracking:
    enabled: true          # 默认开启——可观测性不应是实验性的
    persistSession: true   # 是否写入磁盘
    outputDir: ".routedev/token-logs"
  structuredState:
    enabled: false         # 实验性，默认关闭
  declarativeContext:
    enabled: false         # 实验性，默认关闭
  conciseThinking:
    enabled: false         # 实验性，默认关闭
```

遵循现有模式：`z.preprocess((v) => v ?? {}, OptimizationConfigSchema)`，实验性功能默认 `false`。

**同步更新：** `config.example.yaml` 新增 `optimization:` section 及注释。

### 1.2 新建 `src/agent/token-profiler.ts`

**职责：** 在每次 LLM 调用前，用 `estimateTokens()` 估算各组件的 token 占比。

**核心类型：**

```
TokenProfileSnapshot {
  // 五个"分表"
  systemPrompt: number       // 系统提示词 token 数
  conversationHistory: number // 对话历史 token 数
  toolDefinitions: number     // 工具定义 token 数
  toolResults: number         // 本轮累积的工具返回 token 数
  userMessage: number         // 当前用户消息 token 数

  // 元信息
  totalEstimated: number      // 以上五项之和
  iterationIndex: number      // 第几轮 ReAct 迭代（从 0 开始）
  modelId: string             // 使用的模型 ID
  routeDecision: string       // 路由结果（simple/complex/...）
  timestamp: number           // Unix ms
}
```

**核心函数：**

```
class TokenProfiler {
  profile(params: ProfileParams): TokenProfileSnapshot
  // ProfileParams 包含：systemPrompt, messages, tools, userMessage, iterationIndex, modelId, routeDecision

  getSessionLog(): TokenProfileSnapshot[]
  // 返回本次会话全部快照

  async persistSession(outputDir: string): Promise<string>
  // 写入磁盘，返回文件路径。文件名格式：session-{sessionId}-{date}.jsonl

  getSummary(): TokenProfileSummary
  // 汇总统计：各组件平均占比、最大消耗者排名、总估算 token 数
}
```

**实现要点：**
- 使用已有的 `estimateTokens()`（CJK 感知）进行估算，不调用外部 API
- 工具返回的 token 数 = 遍历 messages 中 `role === 'tool'` 或含工具结果的 assistant 消息
- `toolDefinitions` = 对 `JSON.stringify(tools)` 调用 `estimateTokens()`
- 不做精确计算（那是 API 返回的 `usage` 字段的事），只做占比估算

### 1.3 接入 ReActAgentLoop

在 `src/agent/loop.ts` 的 `run()` 方法中：

**构造函数扩展：**
```
constructor(toolExecutor, config?, profiler?: TokenProfiler)
```

**在每次 LLM 调用前（即调用 `client.stream()` 之前）：**
```
if (profiler) {
  const snapshot = profiler.profile({
    systemPrompt: params.systemPrompt,
    messages: localMessages,
    tools: requestOptions.tools,
    userMessage: params.userMessage,
    iterationIndex: iteration,
    modelId: params.routeDecision.model.id,
    routeDecision: params.routeDecision.tier,
  });
  // 通过新的 ReActEvent 类型通知外部
  yield { type: 'token_profile', snapshot };
}
```

**新增事件类型：**
```
// 在 ReActEvent union 中新增
| { type: 'token_profile'; snapshot: TokenProfileSnapshot }
```

**安全降级：** `profiler` 参数可选，不传则跳过一切 profiling 逻辑，零开销。

### 1.4 接入 chat-runner 和 goal-runner

**chat-runner.ts：**
- 在 `for await` 循环中新增 `case 'token_profile'`，收集快照
- 循环结束后，如果 `optimization.tokenTracking.persistSession` 为 true，调用 `profiler.persistSession()`
- 在 UI 中通过 `addSystemMessage` 简要展示 token 汇总（可选，仅 debug 模式）

**goal-runner.ts：**
- 同样处理 `token_profile` 事件
- **修复已有 bug：** 在 done 事件中补充 `setTodayTokensUsed` 调用（当前缺失）
- **修复已有 bug：** 为 `GoalVerifier.verify()` 的 LLM 调用补充 token 记录
- 在 `renderGoalCompletionSummary` 中加入 token 汇总

### 1.5 接入 TokenTracker.checkBudget()

在 chat-runner.ts 的 `tracker.record()` 之后，新增：
```
const budgetStatus = tracker.checkBudget();
if (budgetStatus.exceeded && budgetStatus.action === 'degrade') {
  // 通知用户，降级到更便宜的模型
  addSystemMessage(`⚠️ Token 预算已达 ${budgetStatus.usagePercent}%，降级到保守模型`);
  // 切换路由策略（具体实现参考现有 router 的 fallback 机制）
}
```

### 1.6 新增 `/token` 命令

在命令系统中注册 `/token` 命令（如果 CommandRegistry 机制可用，通过它注册；否则在 CommandBridge 中添加）：

**功能：**
- 展示当前会话的 TokenProfiler 汇总
- 各组件平均 token 占比（饼图式文字输出）
- 最大消耗者 Top 3
- 本次会话总估算 token 数
- 最近 5 次 LLM 调用的详细快照

**输出示例：**
```
📊 Token 用量分析（本次会话）
───────────────────────────
总计：~45,200 tokens（12 次 LLM 调用）

各组件平均占比：
  系统提示词   ██████████░░░░  38%  (17,176)
  对话历史     ██████░░░░░░░░  24%  (10,848)
  工具定义     ████░░░░░░░░░░  16%  (7,232)
  工具返回     ███░░░░░░░░░░░  12%  (5,424)
  用户消息     ██░░░░░░░░░░░░  10%  (4,520)

💡 优化建议：系统提示词占比最高（38%），考虑精简或启用缓存
```

### 验收标准

- [ ] `optimization` 配置节可通过 YAML 加载，默认值正确
- [ ] `TokenProfiler` 单元测试：profile() 对五组件正确估算，getSessionLog() 返回全部快照
- [ ] `persistSession()` 写入 JSONL 文件，格式正确
- [ ] ReActAgentLoop 在 profiler 传入时 yield `token_profile` 事件，不传时零影响
- [ ] chat-runner 和 goal-runner 正确处理 `token_profile` 事件
- [ ] goal-runner 修复 `setTodayTokensUsed` 缺失 bug
- [ ] `/token` 命令输出正确的汇总信息
- [ ] ≥ 15 个测试

---

## Task 2：结构化实体状态（实验性）

> **比喻：** 对话历史就像一本流水账——记得越多越厚，翻找越慢。结构化实体状态是在流水账旁边放一张"摘要卡片"：当前任务是什么、完成了哪些步骤、卡在哪里。卡片始终只有巴掌大，不管流水账写了多少页。
>
> 这个方案不是替换现有的 L1-L5 压缩（那是"把旧账本缩印"），而是在压缩之后额外维护一张"活的摘要卡片"。

### 2.1 定义 `AgentEntityState` 类型

新建 `src/agent/entity-state.ts`：

```
AgentEntityState {
  taskGoal: string              // 当前任务目标（一句话）
  completedSteps: Array<{
    step: string;
    result: 'ok' | 'failed' | 'partial';
    details?: string;           // 关键产出（文件路径、命令结果摘要）
  }>;
  currentStep: string           // 当前正在做什么
  blockers: string[]            // 当前阻碍
  keyDecisions: string[]        // 重要的技术决策（保留不超过 10 条）
  modifiedFiles: string[]       // 修改过的文件路径
  env: Record<string, string>   // 环境信息（db、version 等）
}
```

### 2.2 新建 `EntityManager`

```
class EntityManager {
  getState(): AgentEntityState
  // 返回当前状态快照

  async updateFromConversation(messages: LLMMessage[], llmClient: ILLMClient): Promise<AgentEntityState>
  // 用小模型从最近的对话中提取状态增量（State Diff），合并到当前状态
  // 只提取最近 3-5 条消息的增量，不重扫全部历史

  toPromptBlock(): string
  // 将状态序列化为可注入 System Prompt 的文本块
  // 格式紧凑，目标 < 200 tokens

  reset(): void
  // 新会话时清空
}
```

**State Diff 模式：**
LLM 调用后，解析返回内容，提取以下格式的增量：
```
{
  "state_updates": {
    "completedSteps": [...新增条目],
    "currentStep": "...更新后的当前步骤",
    "blockers": [...更新后的阻碍列表],
    "modifiedFiles": [...新增文件路径]
  }
}
```

**关键设计：**
- `updateFromConversation` 只在 ContextCompactor 触发 L5（LLM 摘要）时调用，不额外增加 LLM 调用次数
- 如果 `optimization.structuredState.enabled` 为 false，EntityManager 不执行任何操作
- `toPromptBlock()` 输出示例：
  ```
  [当前状态]
  目标：迁移数据库 schema
  已完成：备份(ok)、新增user_id列(ok)
  当前：迁移历史数据
  阻碍：users表有3条null email
  修改文件：src/db/migrate.ts, tests/db.test.ts
  ```

### 2.3 与 ContextCompactor 集成

**激活 ContextCompactor（它目前是死代码）：**

在 `App.tsx` 或 `app-init.ts` 中：
```
if (config.optimization.structuredState.enabled || config.checkpoint.enabled) {
  const compactor = new ContextCompactor({
    targetTokens: config.router.budget.perRequestLimit || 8000,
    estimateTokens: estimateTokens,
    summarize: async (messages) => {
      // 使用小模型生成摘要
      const client = clientManager.getClient(classifierModel);
      const response = await client.complete({ ... });
      return response.content;
    },
  });
  contextManager.setCompactor(compactor);
}
```

**在 L5 阶段注入 EntityManager：**
当 ContextCompactor 到达 L5（LLM 摘要）时，同时将摘要结果传给 `EntityManager.updateFromConversation()`。这样不增加额外 LLM 调用。

**回滚方案：**
- 配置开关 `optimization.structuredState.enabled: false`（默认）
- 关闭后，EntityManager 的 `toPromptBlock()` 返回空字符串
- ContextCompactor 的 L1-L4 不受影响（它们不依赖 EntityManager）
- 即使 EntityManager 出错，`toPromptBlock()` catch 异常后返回空字符串 + 日志警告

### 2.4 注入系统提示词

在 Task 5 重构后的 `main.system` 模板中预留 `{{entityState}}` 变量。`App.tsx` 在渲染模板时传入 `entityManager.toPromptBlock()`。

如果 structuredState 未启用，该变量渲染为空字符串。

### 验收标准

- [ ] `AgentEntityState` 类型定义完整
- [ ] `EntityManager.updateFromConversation()` 能从小模型输出提取 State Diff
- [ ] `toPromptBlock()` 输出 < 200 tokens（用 estimateTokens 验证）
- [ ] ContextCompactor 被正确实例化并接入 ContextManager
- [ ] 配置开关 `structuredState.enabled: false` 时，全部逻辑跳过，零开销
- [ ] EntityManager 异常不中断主流程（catch + warn）
- [ ] ≥ 8 个测试

---

## Task 3：声明式上下文获取（实验性）

> **比喻：** 传统的 RAG 就像你去图书馆，管理员按关键词给你搬来 10 本书，其中 7 本你不需要。声明式上下文获取像是你先告诉管理员"我需要关于 X 的 Y 方面的数据"，管理员精准取来 2 本。
>
> 代价是需要两次 LLM 调用（一次声明需要什么，一次正式回答），但第二次调用的上下文极其精准，没有噪音。

### 3.1 适用条件

**仅在以下条件全部满足时触发：**
1. `optimization.declarativeContext.enabled` 为 true
2. 路由结果为 `complex`（简单任务不值得多一次调用）
3. 项目记忆（ProjectMemoryManager）中有可检索的内容（空知识库不需要声明）

### 3.2 两步调用流程

**新建 `src/agent/declarative-context.ts`：**

```
class DeclarativeContextAcquirer {
  async acquire(params: {
    userMessage: string;
    projectMemory: ProjectMemoryManager;
    llmClient: ILLMClient;
    systemPrompt: string;
  }): Promise<DeclarativeContextResult>

  // DeclarativeContextResult {
  //   neededTopics: string[]      // 模型声明需要的信息主题
  //   retrievedContext: string    // 精准提取的上下文文本
  //   skipped: boolean            // 如果判断不需要额外上下文
  // }
}
```

**第一步：声明需求（极轻量调用）**
```
// 使用小模型（router 的 simple tier）
response = await simpleClient.complete({
  systemPrompt: "你是上下文分析师。判断完成任务需要哪些额外信息。",
  messages: [
    { role: 'user', content: `任务：${userMessage}\n\n可用信息源：${memoryTopicList}\n\n列出你需要的信息主题（JSON 数组），如果不需要额外信息返回空数组。` }
  ],
  maxTokens: 256,  // 极短回复
});
```

**第二步：精准提取**
```
// 根据声明的主题，从 ProjectMemoryManager 中提取精准上下文
const context = await projectMemory.search(neededTopics);
// 格式化为文本块
const contextBlock = formatContextBlock(context);
```

**注入方式：**
将 `contextBlock` 作为用户消息的一部分追加（不修改 system prompt，遵循"动态内容放 Human Turn"原则）：
```
enrichedUserMessage = `${userMessage}\n\n---\n[精准上下文]\n${contextBlock}`
```

### 3.3 安全降级

- **第一步超时或失败：** 跳过声明式获取，用原始 userMessage 继续（fallback 到当前行为）
- **声明结果为空数组：** 直接跳过第二步
- **ProjectMemoryManager 为空或不可用：** 整个流程跳过
- **总超时预算：** 第一步限时 5 秒（`timeoutMs: 5000`），超时即降级

### 3.4 接入 ReActAgentLoop

在 `run()` 方法的开头（构建 messages 之前）：
```
if (config.declarativeContext?.enabled && routeDecision.tier === 'complex' && projectMemory) {
  const declarativeResult = await acquirer.acquire({ ... });
  if (!declarativeResult.skipped) {
    userMessage = `${userMessage}\n\n---\n[精准上下文]\n${declarativeResult.retrievedContext}`;
  }
}
```

**注意：** 这需要 `projectMemory` 作为新参数传入 `run()`，或通过 ServiceContext 间接传递。推荐使用 ReActRunParams 扩展（新增可选字段 `projectMemory?: ProjectMemoryManager`），保持接口的显式性。

### 验收标准

- [ ] `DeclarativeContextAcquirer` 能正确执行两步调用
- [ ] 仅在 complex 路由 + enabled 时触发
- [ ] 超时/失败时正确降级到当前行为
- [ ] 声明结果为空时跳过第二步
- [ ] 不改变 system prompt（动态内容在 user message 中）
- [ ] TokenProfiler 能区分"声明式调用"和"正式调用"的 token 消耗
- [ ] ≥ 7 个测试

---

## Task 4：简洁思考约束（实验性）

> **比喻：** 有些 AI 回答问题像写作文——先来一段"好的，让我来帮你分析一下"，再来一段"综上所述"，最后来一段"希望这对你有帮助"。实际上你只需要中间的干货。这个功能就是给 AI 戴上"字数紧箍咒"。

### 4.1 系统提示词注入

在 Task 5 重构的系统提示词中加入以下段落（当 `optimization.conciseThinking.enabled` 为 true 时）：

```
## 输出纪律
- 直接给出结论和操作，省略"好的"、"让我来"、"综上所述"等过渡语
- 代码修改直接展示 diff 或代码块，不要先描述"我打算..."再展示
- 工具调用结果正确时，用一句话确认即可，不要复述工具返回的内容
- 思考过程（如果有）控制在 5 个要点以内
- 如果用户问"怎么做"，给步骤；如果问"是什么"，给定义；如果问"为什么"，给原因。不要三种都给。
```

### 4.2 工具返回裁剪

在 ReActAgentLoop 中，当工具返回结果超过 2000 字符时：
```
if (conciseThinkingEnabled && toolResult.length > 2000) {
  toolResult = toolResult.substring(0, 800)
    + '\n\n[...已裁剪 ' + (toolResult.length - 1600) + ' 字符，如需完整内容请说"展示完整结果"...]\n\n'
    + toolResult.substring(toolResult.length - 800);
}
```

这与现有 ContextCompactor L1（Budget Trimming）逻辑类似，但更激进（500→800 字符），且只在 conciseThinking 启用时生效。

**注意：** 不要与 L1 冲突。如果 ContextCompactor L1 也启用了，取两者的较小裁剪结果（即不重复裁剪，只取更严格的那个）。

### 4.3 安全降级

- 配置开关 `optimization.conciseThinking.enabled: false`（默认）
- 关闭后，系统提示词不含"输出纪律"段落，工具返回不裁剪
- 如果用户明确说"请详细解释"或"展示完整结果"，临时跳过本轮约束（通过检测用户消息关键词）

### 验收标准

- [ ] 配置开关正确控制"输出纪律"段落的注入
- [ ] 工具返回裁剪在 > 2000 字符时触发
- [ ] 不与 ContextCompactor L1 冲突
- [ ] 用户关键词"详细"、"完整"能临时跳过约束
- [ ] ≥ 5 个测试

---

## Task 5：系统提示词重构

> **比喻：** RouteDev 现在的"自我介绍"是一张便签纸——简短、够用，但信息密度低。我们要把它升级成一份"岗位手册"——结构清晰、重点突出、有明确的行动规范，而且能根据当前项目动态填充内容。

### 5.1 竞品模式提炼

经研究 Claude Code、Cursor v2.0/GPT-4.1、Devin AI 的系统提示词，提炼以下可复用模式：

| 模式 | 来源 | RouteDev 适配 |
|------|------|-------------|
| **首尾呼应**（关键规则放开头和结尾） | Claude Code | 安全规则和 Anti-Yes-Engineer 放首尾 |
| **XML 标签分区**（用标签划分功能区块） | Cursor | 用 `<routing>`, `<tools>`, `<constraints>` 等标签 |
| **工具说明内嵌**（工具描述中包含使用指南） | Cursor GPT-4.1 | 在 tool definition 的 description 中加入 usage hints |
| **进度播报协议**（主动告知用户在做什么） | Cursor | "正在执行：..." / "已完成：..." |
| **自我纠正断言**（发现错误时立即修正） | Cursor | 检测并声明降级、回退、信息丢失 |
| **极简输出纪律**（严格控制废话） | Claude Code | "输出纪律"段落 |
| **完成协议**（明确结束时的输出格式） | Cursor | 任务完成时的标准输出模板 |
| **动态注入区**（隔离可变内容） | Claude Code `<env>` block | 用 `{{变量}}` 隔离所有动态内容 |

### 5.2 新版 `main.system` 模板

重写 `src/prompts/manager.ts` 中的 `main.system` 内置模板。新版结构：

```
<identity>
你是 RouteDev，一个智能开发助手。你通过智能路由自动选择最合适的模型回答问题。
</identity>

<core_rules>
（首尾呼应区——最重要的规则放这里）
1. 安全第一：删除、覆盖、修改关键文件前必须确认
2. 诚实透明：不确定时标注置信度（高/中/低）
3. 静默回退通知：如果降级、工具失败、信息丢失，必须告知用户
{{conciseThinking}}
</core_rules>

<routing_awareness>
你当前使用的模型由路由器根据任务复杂度自动选择。
路由结果：{{routeDecision}}
如果你认为当前模型不适合此任务，请在回复开头声明。
</routing_awareness>

<tool_protocol>
你可以使用以下工具：{{availableTools}}
工具使用纪律：
- 先思考再调用，避免试探性调用
- 工具返回正确时一句话确认，不要复述返回内容
- 工具失败时分析原因再重试，不要盲目重试
- 危险操作（文件修改、命令执行）前声明意图
</tool_protocol>

<progress_narration>
（进度播报——让用户知道你在做什么）
多步骤任务时，用简短标记播报进度：
"[1/3] 读取文件..." → "[2/3] 修改第 42 行..." → "[3/3] 运行测试..."
单步任务不需要播报。
</progress_narration>

<completion_protocol>
（完成协议——任务结束时的标准输出）
任务完成时：
1. 一句话总结做了什么
2. 列出修改的文件（如有）
3. 标注需要用户关注的风险或后续步骤
不要加"还有什么可以帮你的吗？"之类的客套话。
</completion_protocol>

<self_correction>
（自我纠正——发现问题时主动声明）
- 如果发现自己的前一条回复有误，先纠正再继续
- 如果工具返回与预期不符，分析原因而非忽略
- 如果上下文压缩导致信息丢失，声明"以下分析可能不完整"
</self_correction>

<anti_yes_engineer>
（Anti-Yes-Engineer——保留 RouteDev 的核心特色）
不对用户所有请求无条件点头：
- 风险操作先提示影响
- 信息缺失时主动说明缺什么
- 结论优先：即使否定也给出最佳建议
</anti_yes_engineer>

<context>
{{entityState}}
{{projectRules}}
{{projectMemory}}
</context>

<session>
语言：{{language}}
自主度：{{autonomyMode}}
工作目录：{{cwd}}
{{conversationContext}}
</session>

（尾部重复）记住：安全第一，诚实透明，不废话。
```

### 5.3 将 PromptTemplateManager 接入主路径

**修改 App.tsx：**

将：
```
const systemPrompt = getSystemPrompt(config.general.language);
```

改为：
```
const systemPrompt = await serviceContext.prompts.render('main.system', {
  language: config.general.language,
  autonomyMode: config.autonomy.defaultMode,
  projectRules: projectMemory?.getRules() || '',
  projectMemory: projectMemory?.getRecentDecisions() || '',
  blackboard: '',  // 多 Agent 模式下填充
  availableTools: toolExecutor.listAll().map(t => t.name).join(', '),
  conversationContext: '',  // 运行时填充
  routeDecision: '',  // 每次 LLM 调用前填充
  entityState: entityManager?.toPromptBlock() || '',
  conciseThinking: config.optimization?.conciseThinking?.enabled
    ? CONCISE_THINKING_BLOCK : '',
  cwd: serviceContext.cwd,
});
```

**注意：** `render()` 是 async 方法（返回 Promise），App.tsx 的初始化需要 await。由于 App.tsx 是 React 组件，建议在 `useEffect` 或初始化函数中完成渲染，将结果存入 state。

**保留 fallback：**
```
let systemPrompt: string;
try {
  systemPrompt = await serviceContext.prompts.render('main.system', context);
} catch (err) {
  logger.warn('PromptTemplateManager 渲染失败，使用 fallback', err);
  systemPrompt = getSystemPrompt(config.general.language);
}
```

### 5.4 动态变量的运行时更新

某些变量（如 `routeDecision`、`conversationContext`）在每次 LLM 调用前都不同。有两种方案：

**方案 A（推荐）：预渲染 + 运行时拼接**
- 启动时渲染一次模板，将动态变量位置留空（用占位符如 `__ROUTE_DECISION__`）
- 每次 LLM 调用前，用 `replace()` 填入当前值
- 优点：模板渲染开销只在启动时发生一次

**方案 B：每次调用前完整渲染**
- 每次 LLM 调用前都调用 `render()`
- 优点：简单直接
- 缺点：每次都有模板解析开销（但 PromptTemplateManager 有缓存，实际影响很小）

推荐方案 B（简单直接，PromptTemplateManager 已有 `cacheTtlSeconds` 缓存机制）。

### 5.5 PromptTemplateManager 变量扩展

在 `src/prompts/manager.ts` 的 `main.system` 内置模板中，将 variables 数组扩展为：

```
variables: [
  'language', 'autonomyMode', 'projectRules', 'projectMemory',
  'blackboard', 'availableTools', 'conversationContext',
  'routeDecision', 'entityState', 'conciseThinking', 'cwd',
]
```

### 验收标准

- [ ] 新版 `main.system` 模板包含全部 8 个模式区块
- [ ] App.tsx 使用 `PromptTemplateManager.render()` 而非 `getSystemPrompt()`
- [ ] fallback 机制正常工作（render 失败时回退到硬编码字符串）
- [ ] 动态变量（routeDecision 等）在每次 LLM 调用前正确更新
- [ ] `getSystemPrompt()` 函数保留但标记为 `@deprecated`
- [ ] 模板渲染失败不中断启动流程
- [ ] ≥ 8 个测试

---

## Task 6：集成测试与文档同步

### 6.1 集成测试

1. **端到端 Token Profiling 测试：** 模拟一次完整对话（含工具调用），验证 TokenProfiler 在每轮 LLM 调用前都生成了快照，快照的各组件数值合理
2. **端到端结构化状态测试：** 启用 structuredState，模拟多轮对话后验证 EntityManager 的状态与对话内容一致
3. **端到端声明式上下文测试：** 启用 declarativeContext + complex 路由，验证两步调用流程正确执行
4. **降级测试：** 关闭各实验性功能，验证系统行为与 Phase 29 完全一致
5. **系统提示词模板测试：** 验证 render() 输出包含所有区块，动态变量正确替换

### 6.2 文档同步

- **`AGENTS.md`**：新增 Phase 30 相关陷阱
  - "ContextCompactor 是死代码，使用前必须先实例化并接入"
  - "PromptTemplateManager.render() 是 async 方法，React 组件中需在 useEffect 中调用"
  - "TokenProfiler 使用 estimateTokens（启发式），非精确计算"
  - "goal-runner 缺少 setTodayTokensUsed，已修复"
- **`CODEMAP.md`**：新增 `token-profiler.ts`、`entity-state.ts`、`declarative-context.ts` 条目
- **`CHANGELOG.md`**：新增 v2.2.0 条目
- **`config.example.yaml`**：新增 `optimization` section
- **`package.json`**：版本号 v2.1.0 → v2.2.0
- **`README.md`**：更新版本号

### 验收标准

- [ ] 全部集成测试通过
- [ ] 文档更新完成
- [ ] 无 TypeScript 编译错误
- [ ] 全量测试（含新增）零失败
- [ ] ≥ 10 个测试

---

## 全局风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| TokenProfiler 增加 LLM 调用前的延迟 | 用户感知变慢 | `estimateTokens()` 是纯 CPU 计算，< 1ms/次；如果实测有影响，用 `config.optimization.tokenTracking.enabled` 关闭 |
| 结构化状态的 LLM 调用增加成本 | 额外 token 消耗 | 与 L5 摘要共用同一次 LLM 调用，不额外增加；关闭开关后零开销 |
| 声明式上下文的两步调用翻倍延迟 | 复杂任务响应变慢 | 第一步限 5 秒超时；仅在 complex 路由触发；默认关闭 |
| 新版系统提示词导致 LLM 行为退化 | 回复质量下降 | fallback 到旧版 getSystemPrompt()；可通过配置切换 |
| PromptTemplateManager.render() 异步化影响 App.tsx 启动流程 | 启动变慢或出错 | try/catch + fallback；模板有缓存，渲染 < 1ms |

---

## 执行顺序建议

```
Task 1（可观测性）  ─── 最先做，后续 Task 依赖它来测量效果
    │
    ├── Task 2（结构化状态）  ─── 可与 Task 3 并行
    ├── Task 3（声明式上下文）─── 可与 Task 2 并行
    ├── Task 4（简洁思考）     ─── 独立，可与 2/3 并行
    │
Task 5（系统提示词）  ─── 在 2/3/4 之后做，因为需要集成它们的变量
    │
Task 6（集成测试）  ─── 最后做
```

Task 1 是地基（装水表），Task 2-4 是三个独立的改造（可以并行施工），Task 5 是装修（需要知道管道走向），Task 6 是验收。

---

## 测试要求汇总

| Task | 最低测试数 | 重点测试场景 |
|------|-----------|------------|
| 1 | 15 | profile 正确性、事件流、持久化、预算检查、/token 命令 |
| 2 | 8 | State Diff 提取、toPromptBlock 格式、异常降级、开关控制 |
| 3 | 7 | 两步调用、超时降级、空声明跳过、仅 complex 触发 |
| 4 | 5 | 开关控制、裁剪逻辑、关键词跳过、不与 L1 冲突 |
| 5 | 8 | 模板渲染、变量替换、fallback、动态更新 |
| 6 | 10 | 端到端集成、降级、全量回归 |
| **合计** | **≥ 53** | |
