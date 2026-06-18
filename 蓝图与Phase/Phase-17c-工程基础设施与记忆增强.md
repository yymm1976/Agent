# Phase 17c — 工程基础设施与记忆增强

> **Phase 类型：** 增强（Enhancement）
> **前置依赖：** Phase 17b 已完成（验收 14/14，486 测试通过，App.tsx 369 行）
> **目标版本：** v0.17c.0
> **执行人注意：** 本 Phase 引入三项外部研究成果（架构师知识库 CodeMap 模式 + graph-memory 知识图谱 + Claude Code 源码架构），并收束 Phase 17b 执行人的低优先级 CONCERN。

---

## 背景

Phase 17b 成功完成后，项目的架构债务已清零（App.tsx 瘦身、安全漏洞修复、命令迁移完成）。但在工程基础设施层面仍有三个短板：

1. **代码导航缺失**：执行人每次开工都要全库扫描定位文件，浪费大量 token。没有"代码库索引"文件。
2. **上下文压缩原始**：DreamConsolidator 当前只做简单的 CheckpointData 合并，没有渐进压缩策略。
3. **记忆系统扁平**：Checkpoint 和 Context 是线性列表，没有知识图谱结构，无法按相关性排序记忆。

本 Phase 从三个外部项目提取可落地的模式：

| 来源 | 借鉴模式 | 对应 Task |
|------|---------|-----------|
| 架构师知识库（Obsidian wiki） | CodeMap 三层导航 + 硬验收门自动化 | Task 1 |
| Claude Code 泄露源码（512K 行 TS） | 五阶段渐进上下文压缩 + 文件式记忆层级 | Task 2 |
| graph-memory（502 星，MIT） | 个性化 PageRank + 双路径召回 + 知识图谱 | Task 3 |

**核心原则：** 借鉴的是设计思想和算法，不是代码。所有实现必须适配 RouteDev 的现有架构（ReAct Loop、ServiceContext、CheckpointManager），不引入新依赖。

---

## 接口对齐观察表

以下签名已通过 Phase 17b 执行报告确认（执行人实际交付）：

| 接口 / 函数 | Phase 17b 后签名 | 文件位置 | 备注 |
|---|---|---|---|
| `ServiceContext` | 25 字段接口（原 22 + checkpointManager + mcpManager + commandBridge） | `src/cli/service-context.ts` | Phase 17b 扩展了 3 个字段 |
| `CommandBridge` | `{ addSystemMessage, clearChat, setAutonomyMode, requestAbort, requestConfirm, exit, startGoal, getState }` | `src/cli/service-context.ts` | Phase 17b 新增接口，含 startGoal 和 getState |
| `ToolResponse` | `{ content: string; isError: boolean; metadata?: Record<string, unknown> }` | `src/tools/types.ts` | Phase 17b Task 9 新增 |
| `ToolExecutor.executeSafe()` | `executeSafe(name, args): Promise<ToolResponse>` | `src/tools/executor.ts` | Phase 17b 新增，包装异常 |
| `AgentMiddlewarePipeline` | `register(phase, handler)` + `execute(phase, ctx)` | `src/agent/middleware.ts` | Phase 17b Task 8 新增 |
| `StallDetector` | `register/unregister/reportActivity/start/stop` | `src/utils/stall-detector.ts` | Phase 17b Task 10 新增 |
| `HandoffData` | `{ currentGoal, completedSteps, nextAction, constraints, workingFiles, openQuestions, timestamp }` | `src/agent/handoff.ts` | Phase 17b Task 11 新增 |
| `DreamConsolidator.consolidate(cp)` | `consolidate(checkpoint: CheckpointData): Promise<DreamResult>` | `src/agent/dream-consolidator.ts` | Task 2 需增强 |
| `DreamResult` | `{ beforeSize, afterSize, mergedCount, consolidated, summary }` | `src/agent/dream-consolidator.ts` | Task 2 需扩展 |
| `CheckpointManager` | `create(options?)/list()/rollback(id)` | `src/harness/checkpoint-manager.ts` | Task 3 需扩展 |
| `ContextManager` | `getCheckpoint(): CheckpointData \| null` + `resetTriggers(): void` | `src/agent/memory/context-manager.ts` | Task 2/3 需增强 |
| `chat-runner.ts` | Phase 17b 新模块，从 App.tsx 提取的聊天执行逻辑 | `src/cli/chat-runner.ts` | 执行人额外交付 |
| `goal-runner.ts` | Phase 17b 新模块，从 App.tsx 提取的目标执行逻辑 | `src/cli/goal-runner.ts` | 执行人额外交付 |

> **执行人注意：** Phase 17b 实际交付了 2 个超出规格的模块（chat-runner.ts、goal-runner.ts）和 ServiceContext 的 3 个新字段。开始 Task 前请先 `cat` 这些文件确认实际签名，不要仅依赖上表。

---

## Task 1：代码导航基础设施 — CODEMAP.md + AGENTS.md + 验收脚本

> **来源：** 架构师知识库 CodeMap 三层导航模式 + 硬验收门模式
> **价值：** 让执行人像查索引一样定位文件，每次搜索节省数千 token。验收脚本让"看起来对"变成"测试通过"。

### Step 1：创建 `AGENTS.md`

**文件：** `AGENTS.md`（项目根目录，与 package.json 同级）

全局入口索引，保持精简（≤ 80 行），只放指针和陷阱。

**内容要求：**

```markdown
# RouteDev — Agent 导航入口

> 执行任何 Task 前，先读本文件和 CODEMAP.md。

## 技术栈
- TypeScript 6.x / Node.js 20+ / pnpm
- CLI：Ink 7.0.6 + React 19.2.7
- 测试：Vitest（`pnpm vitest run`）
- 构建：tsup（`pnpm build`）

## 关键入口
- CLI 入口：`src/index.tsx`（不是 bin/）
- 主界面：`src/cli/App.tsx`（369 行）
- 聊天逻辑：`src/cli/chat-runner.ts`（Phase 17b 提取）
- 目标执行：`src/cli/goal-runner.ts`（Phase 17b 提取）
- 代码索引：`CODEMAP.md`（先读这个再搜索代码）

## 项目约定
- 提交格式：`feat(scope): ...` / `fix(scope): ...` / `test(scope): ...`
- 每个新模块必须有对应测试
- 接口签名变更时必须更新本文件和 Phase 文件中的观察表

## 陷阱警告（不要踩的坑）
- `ModelRouter.route()` 接受 `ClassificationResult`，不是 `ScenarioTier`
- `LLMClientManager.listAll()` 返回 `Map<string, ILLMClient>`，不是数组
- `Checkpoint` 用 `description` + `timestamp`，没有 `tag` + `createdAt`
- `BranchManager.switchBranch()`，不是 `switchToBranch()`
- `DreamConsolidator.consolidate()` 需要传 `CheckpointData` 参数
- `TokenTracker.getStats()` 返回 `TokenStats`，没有 `getTodayUsage()`
- `src/agent/executor.ts` 是 NoOpToolExecutor 空桩，实际工具执行走 `ToolRegistryAdapter`
```

> **执行人注意：** 陷阱列表来自架构师多轮验证的高频错误。实现过程中发现新陷阱时追加到此文件。

---

### Step 2：创建 `CODEMAP.md`

**文件：** `CODEMAP.md`（项目根目录）

代码库索引——列出每个目录/关键文件的职责、行数和依赖关系。

**你必须实际扫描每个目录后填写**，不要猜测。格式要求：

```markdown
# RouteDev — 代码库索引（CODEMAP）

> 搜索代码前先读本文件定位目标模块，再进入具体文件。
> 最后更新：[填写日期]

## 目录总览
[src/ 目录树，每个一级目录一行注释]

## 模块详解
### src/cli/ — CLI 界面层
**职责：** [一句话]
**关键文件：**
- `文件名` — [一句话描述]（[行数] 行）
**依赖：** [列出依赖的其他模块]

[对 src/ 下每个一级目录重复上述格式]

## 测试目录
[tests/ 目录结构概览]

## 工具目录
[scripts/ 目录结构概览]
```

---

### Step 3：创建硬验收门脚本

**文件：** `scripts/verify.ts`

自动化验收脚本，把"人读文字判断"变成"脚本自动判定"。

**要求：**
- 使用 `pnpm tsx` 运行（如果没有 tsx 依赖则 `pnpm add -D tsx`）
- 检查项至少覆盖：App.tsx 行数 ≤ 400、无 switch(cmd) 块、所有命令文件存在、WebhookServer 三项安全、企业微信 timing-safe、token 估算无旧写法、console.log 已清理、新模块存在、全量测试通过
- 输出 ✅/❌ 格式，末尾汇总
- 退出码：0 = 全部通过，1 = 有失败

---

### Step 4：单元测试

验收脚本本身需要测试（至少验证它能运行且输出格式正确）。

---

### Step 5：提交

```bash
git add AGENTS.md CODEMAP.md scripts/verify.ts
git commit -m "feat(infra): add CodeMap, AGENTS.md and hard verification gate"
```

---

## Task 2：渐进上下文压缩管线（借鉴 Claude Code）

> **来源：** Claude Code 源码中的五阶段上下文压缩（budget trimming → snipping → micro-compaction → context collapse → auto-compaction）
> **价值：** 当前 DreamConsolidator 只做简单合并。渐进压缩让系统从"便宜操作"开始，只在必要时调用 LLM 做摘要，大幅降低 token 消耗。

### 核心设计

Claude Code 的上下文管理分五个阶段，从最便宜到最贵依次升级：

| 阶段 | 名称 | 成本 | 做什么 |
|------|------|------|--------|
| L1 | Budget Trimming | 零（纯字符串操作） | 截断工具输出，保留首尾 + 摘要 |
| L2 | Snipping | 零（数组操作） | 删除旧消息，只保留标题 |
| L3 | Micro-Compaction | 零（正则操作） | 删除过期标记、僵尸消息 |
| L4 | Context Collapse | 低（结构化重组） | 语义去重，合并重复工具结果 |
| L5 | Auto-Compaction | 高（LLM 调用） | 调用模型做完整摘要 |

**关键原则：只在 L1-L4 不够用时才升级到 L5。** 大多数场景到 L3 就够了。

### Step 1：创建 `src/agent/context-compaction.ts`

```typescript
// src/agent/context-compaction.ts
// 渐进上下文压缩管线（借鉴 Claude Code 五阶段模型）

export interface CompactionResult {
  /** 压缩前 token 数 */
  beforeTokens: number;
  /** 压缩后 token 数 */
  afterTokens: number;
  /** 实际执行的最高阶段 */
  maxStageReached: 1 | 2 | 3 | 4 | 5;
  /** 被移除的消息数 */
  removedMessages: number;
  /** L5 摘要（仅当执行了 L5 时有值） */
  summary?: string;
}

export interface CompactionConfig {
  /** 目标 token 预算（低于此值则不压缩） */
  targetTokens: number;
  /** 当前 token 估算函数 */
  estimateTokens: (text: string) => number;
  /** L5 摘要函数（可选，不提供则跳过 L5） */
  summarize?: (messages: LLMMessage[]) => Promise<string>;
}

export class ContextCompactor {
  constructor(private config: CompactionConfig) {}

  /**
   * 渐进压缩：从 L1 到 L5 依次尝试，达到目标预算即停止。
   */
  async compact(messages: LLMMessage[]): Promise<{
    messages: LLMMessage[];
    result: CompactionResult;
  }> {
    let current = [...messages];
    const before = this.totalTokens(current);
    const result: CompactionResult = {
      beforeTokens: before,
      afterTokens: before,
      maxStageReached: 1,
      removedMessages: 0,
    };

    // L1: Budget Trimming — 截断大工具输出
    current = this.stage1TrimToolOutputs(current);
    result.afterTokens = this.totalTokens(current);
    if (result.afterTokens <= this.config.targetTokens) return { messages: current, result };

    // L2: Snipping — 删除最旧的非关键消息
    result.maxStageReached = 2;
    const snipped = this.stage2SnipOldMessages(current);
    result.removedMessages += current.length - snipped.length;
    current = snipped;
    result.afterTokens = this.totalTokens(current);
    if (result.afterTokens <= this.config.targetTokens) return { messages: current, result };

    // L3: Micro-Compaction — 删除过期标记和僵尸消息
    result.maxStageReached = 3;
    current = this.stage3MicroCompact(current);
    result.afterTokens = this.totalTokens(current);
    if (result.afterTokens <= this.config.targetTokens) return { messages: current, result };

    // L4: Context Collapse — 语义去重
    result.maxStageReached = 4;
    current = this.stage4Collapse(current);
    result.afterTokens = this.totalTokens(current);
    if (result.afterTokens <= this.config.targetTokens) return { messages: current, result };

    // L5: Auto-Compaction — LLM 摘要（如果有 summarize 函数）
    if (this.config.summarize) {
      result.maxStageReached = 5;
      const summary = await this.config.summarize(current);
      current = [{ role: 'system', content: `[上下文摘要] ${summary}` }];
      result.afterTokens = this.totalTokens(current);
    }

    return { messages: current, result };
  }

  // L1: 截断超过 2000 字符的工具输出，保留首 500 + 尾 500 + "[...截断...]"
  private stage1TrimToolOutputs(messages: LLMMessage[]): LLMMessage[] { /* ... */ }

  // L2: 保留最近 10 条消息 + 所有 system 消息，删除中间消息
  private stage2SnipOldMessages(messages: LLMMessage[]): LLMMessage[] { /* ... */ }

  // L3: 删除 content 为空或仅含标记的消息
  private stage3MicroCompact(messages: LLMMessage[]): LLMMessage[] { /* ... */ }

  // L4: 合并连续相同 role 的消息，去重相同工具结果
  private stage4Collapse(messages: LLMMessage[]): LLMMessage[] { /* ... */ }

  private totalTokens(messages: LLMMessage[]): number {
    return messages.reduce((sum, m) => sum + this.config.estimateTokens(m.content), 0);
  }
}
```

> **执行人注意：** L1-L4 是纯字符串/数组操作，零 LLM 调用，零 token 成本。L5 才是模型摘要。这是 Claude Code 最核心的设计哲学——**能用便宜方法解决的，绝不用贵的**。具体实现请参考 Claude Code 的 `context-compaction` 逻辑（可从 Dive-into-Claude-Code 仓库获取源码分析）。

### Step 2：集成到 DreamConsolidator

修改 `src/agent/dream-consolidator.ts`，让 `consolidate()` 方法使用 ContextCompactor 作为内部压缩引擎：

- 将现有的简单合并逻辑替换为 ContextCompactor 的调用
- `DreamResult` 扩展：新增 `maxStageReached` 和 `compactionStages` 字段
- `consolidate()` 的 `CheckpointData` 参数中提取消息历史，传给 compactor

### Step 3：集成到 ContextManager

修改 `src/agent/memory/context-manager.ts`：

- 新增 `compactIfNeeded()` 方法：检查当前上下文是否超过阈值，超过则调用 ContextCompactor
- 在每次 `getCheckpoint()` 调用前自动检查

### Step 4：单元测试

- L1：大工具输出被截断到 500+500+标记
- L2：超过 10 条消息后旧消息被删除
- L3：空消息被清理
- L4：连续相同 role 消息被合并
- L5：summarize 被调用（mock）
- 渐进性：如果 L1 后已达标，不执行 L2+
- DreamConsolidator 集成：consolidate 返回 maxStageReached

---

## Task 3：知识图谱记忆增强（借鉴 graph-memory）

> **来源：** adoresever/graph-memory（502 星，MIT，TypeScript）— 知识图谱上下文引擎
> **价值：** 用图结构替代扁平列表管理记忆，实现按相关性排序和跨会话知识发现。

### 核心设计

graph-memory 有三个算法值得借鉴：

1. **个性化 PageRank (PPR)**：根据当前查询动态排序记忆节点，而非按时间或频率排序。同一个图对不同查询返回不同排序。
2. **双路径召回**：精确路径（向量搜索 → 图遍历）和泛化路径（社区匹配 → 代表节点）并行搜索后合并。
3. **Label Propagation 社区检测**：自动将记忆分成知识域，每个社区有 LLM 生成的摘要。

**关键约束：不引入 SQLite 或向量数据库依赖。** 用纯内存数据结构实现，可选持久化到 JSON 文件。

### Step 1：创建 `src/agent/memory/graph.ts`

```typescript
// src/agent/memory/graph.ts
// 轻量知识图谱（借鉴 graph-memory，纯内存实现）

export type NodeType = 'fact' | 'decision' | 'skill' | 'event';
export type EdgeType = 'relates_to' | 'derived_from' | 'supersedes' | 'conflicts_with';

export interface GraphNode {
  id: string;
  type: NodeType;
  content: string;
  embedding?: number[];       // 可选向量（用于相似度计算）
  validatedCount: number;      // 被引用次数（用于排序）
  createdAt: number;
  updatedAt: number;
  deprecated: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  weight: number;             // 0-1，关系强度
}

export class KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private adjacency = new Map<string, Set<string>>();

  // 基础 CRUD
  addNode(node: GraphNode): void { /* ... */ }
  addEdge(edge: GraphEdge): void { /* ... */ }
  getNode(id: string): GraphNode | undefined { /* ... */ }
  listNodes(filter?: { type?: NodeType; deprecated?: boolean }): GraphNode[] { /* ... */ }

  /**
   * 个性化 PageRank（PPR）
   * 从 seedNodes 出发，沿边传播分数。
   * 返回按 PPR 分数降序排列的节点列表。
   *
   * 算法（~120 行，参考 graph-memory/src/graph/pagerank.ts）：
   * 1. 初始化：seedNodes 分数 = 1.0，其他 = 0.0
   * 2. 迭代 N 次（默认 20）：每个节点把 (1-damping) 的分数均分给邻居
   * 3. damping 默认 0.85
   * 4. 返回按分数排序的节点
   */
  personalizedPageRank(seedNodeIds: string[], options?: {
    damping?: number;        // 默认 0.85
    iterations?: number;     // 默认 20
    topK?: number;           // 返回前 K 个，默认 10
  }): Array<{ node: GraphNode; score: number }> { /* ... */ }

  /**
   * 双路径召回
   * 精确路径：keyword 匹配 seed → BFS 扩展（depth 2）→ PPR 排序
   * 泛化路径：社区匹配 → 取代表节点 → BFS（depth 1）→ PPR 排序
   * 合并去重后返回
   */
  recall(query: string, options?: {
    maxResults?: number;     // 默认 10
    preciseWeight?: number;  // 精确路径权重，默认 0.7
  }): Array<{ node: GraphNode; score: number; path: 'precise' | 'generalized' | 'both' }> { /* ... */ }

  /**
   * Label Propagation 社区检测（~100 行，参考 graph-memory/src/graph/community.ts）
   * 每个节点初始社区 = 自己的 ID
   * 迭代：每个节点采纳邻居中最常见的社区标签
   * 直到收敛或达到最大迭代数
   */
  detectCommunities(maxIterations?: number): Map<string, string[]> {
    // 返回 communityId → nodeIds[]
    /* ... */
  }

  // 持久化
  toJSON(): string { /* ... */ }
  static fromJSON(json: string): KnowledgeGraph { /* ... */ }
}
```

> **执行人注意：** PPR 和 Label Propagation 算法可以从 graph-memory 源码（MIT 许可）直接参考实现，但必须去掉 SQLite 和 OpenAI 依赖。图数据存储在内存 Map 中，可选序列化为 JSON 持久化。

### Step 2：集成到 ContextManager

修改 `src/agent/memory/context-manager.ts`：

- 新增 `knowledgeGraph: KnowledgeGraph` 字段
- 每次 checkpoint 写入时，从 CheckpointData 中提取关键事实，作为 GraphNode 添加
- `getCheckpoint()` 返回时，用 PPR 按当前查询相关性排序记忆，而非简单的时间顺序
- 可选：社区检测结果缓存，在 `resetTriggers()` 时刷新

### Step 3：集成到 DreamConsolidator

修改 `src/agent/dream-consolidator.ts`：

- consolidate() 时调用 `knowledgeGraph.detectCommunities()` 发现知识域
- 对每个社区生成 LLM 摘要（利用 Task 2 的 L5 压缩）
- 合并相似节点（余弦相似度 > 0.90 的节点合并，保留 validatedCount 高的）
- DreamResult 扩展：新增 `communities: number` 和 `graphNodes: number` 字段

### Step 4：单元测试

- KnowledgeGraph 基础 CRUD
- PPR：从 seed 出发，邻居节点分数 > 远处节点
- PPR：不同 seed 返回不同排序
- 双路径召回：keyword 匹配 + 社区匹配都返回结果
- Label Propagation：紧密连接的节点归入同一社区
- 持久化：toJSON → fromJSON 不丢数据
- DreamConsolidator 集成：consolidate 后 graphNodes > 0

---

## Task 4：Phase 17b CONCERN 收束 + 集成模块收尾

> **来源：** Phase 17b 执行人报告的 4 个 CONCERN + 2 个未集成模块
> **价值：** 消除死代码，对齐版本号，确保 Phase 17b 新增模块被实际使用。

### Step 1：处理 `src/agent/executor.ts` 空桩（CONCERN-01）

检查 `executor.ts` 的引用关系：
- 如果全项目无 import → 删除文件 + 对应测试
- 如果仍有引用 → 用 `ToolRegistryAdapter` 替换 NoOpToolExecutor，或在文件中加注释标明其角色

### Step 2：处理 `createServiceContext` 死代码（CONCERN-03）

检查 ServiceContext 构造函数 `createServiceContext`（或 App.tsx 中的 `buildServiceContext`）是否被调用。如果函数签名已扩展但无调用方：
- 确认 App.tsx 中是否正确使用了这个函数
- 如果确实无调用方，添加 `// @internal — reserved for future plugin system` 注释

### Step 3：集成 retry/watcher/completion 模块

Phase 18 交付了 3 个未集成模块，Phase 17b 没有处理。本 Task 集成它们：

1. **`src/utils/retry.ts`**（RetryPolicy + CircuitBreaker）：
   - 在 `src/tools/builtin/shell-exec.ts` 中用 `resilientExecute` 包装 shell 命令
   - 在 `src/channels/adapters/` 中用 `RetryPolicy` 包装 HTTP 请求

2. **`src/config/watcher.ts`**（ConfigWatcher）：
   - 在 `src/cli/App.tsx` 的 useEffect 中启动 ConfigWatcher
   - 配置变更时通过 CommandBridge.addSystemMessage 通知用户

3. **`src/cli/completion.ts`**（Tab 补全）：
   - 在 `src/cli/InputBox.tsx` 中集成 Tab 补全逻辑

### Step 4：版本号对齐（CONCERN-02 预处理）

虽然版本号最终对齐在 Phase 23，但本 Task 统一所有内部引用：
- `package.json` 的 version 字段改为 `0.17c.0`
- `src/cli/args.ts` 中的版本打印从硬编码改为读取 `package.json`
- `src/cli/splash.ts` 中的版本号同步

### Step 5：单元测试

- retry 集成：shell-exec 在命令失败时自动重试
- watcher 集成：配置文件修改后触发通知
- completion 集成：Tab 键触发补全建议
- 版本号：args.ts 和 splash.ts 显示相同的版本号

---

## 验收标准

1. **AGENTS.md** 存在且 ≤ 80 行，包含陷阱警告列表
2. **CODEMAP.md** 存在且覆盖所有 src/ 子模块，内容经实际代码验证
3. **verify.ts** 脚本存在，`pnpm tsx scripts/verify.ts` 全部通过
4. **ContextCompactor** 五阶段渐进压缩可用，L1-L4 零 LLM 调用（测试通过）
5. **DreamConsolidator** 集成 ContextCompactor，consolidate 返回 maxStageReached
6. **KnowledgeGraph** PPR + 双路径召回 + Label Propagation 可用（测试通过）
7. **ContextManager** 集成 KnowledgeGraph，记忆按 PPR 相关性排序
8. **executor.ts** 空桩已处理（删除或替换）
9. **retry/watcher/completion** 三个模块已集成到主流程
10. **版本号** args.ts 和 splash.ts 显示一致的版本号
11. **全量测试通过**，无回归
12. **新增测试 ≥ 25 个**

---

## 补充说明

**A. Claude Code 源码参考仓库：**
- [VILA-Lab/Dive-into-Claude-Code](https://github.com/VILA-Lab/Dive-into-Claude-Code)（学术论文级架构分析，1.7K 星）
- [chauncygu/collection-claude-code-source-code](https://github.com/chauncygu/collection-claude-code-source-code)（含 Python 重写和 nano 版）

**B. graph-memory 参考仓库：**
- [adoresever/graph-memory](https://github.com/adoresever/graph-memory)（502 星，MIT，TypeScript）
- 核心算法文件：`src/graph/pagerank.ts`（~120 行）、`src/graph/community.ts`（~100 行）、`src/recaller/recall.ts`（~200 行）

**C. 不引入新依赖的原则：**
- KnowledgeGraph 用纯内存 Map/Set 实现
- ContextCompactor 用纯字符串/数组操作
- PPR 和 Label Propagation 是纯数学算法，无需外部库
- 如果执行人认为需要某个依赖（如向量计算库），先上报 CONCERN 等架构师裁决

**D. 执行人新发现的模块：**
Phase 17b 实际交付了 2 个超出规格的模块（`chat-runner.ts`、`goal-runner.ts`），且 ServiceContext 扩展了 `mcpManager` 字段。这些在接口观察表中已标注，但执行人仍应先验证实际签名再使用。
