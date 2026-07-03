# Phase 63 — 上下文状态外部化重构

> **版本目标：** v4.6.2
> **前置依赖：** Phase 62（动态工作流模式与隔离治理）完成
> **后继依赖：** 无（本 Phase 是独立能力增强，可与 Phase 64-68 并行）
> **新增测试要求：** ≥ 40 个
> **研究依据：** 精读 arXiv:2606.02373《Harness-1: Reinforcement Learning for Search Agents with State-Externalizing Harnesses》（UC Irvine + UIUC，2026-06）全文 + GitHub 代码 https://github.com/pat-jj/harness-1 （Apache-2.0）。论文核心论断：传统 agent 把所有状态管理（记住看过什么 / 哪些证据有用 / 哪些约束未解决 / 哪些声明已验证）**塞进 policy 上下文 transcript**，迫使 LLM 同时优化"语义决策"和"可恢复簿记"两个目标，导致上下文膨胀、压缩后状态丢失、policy 难以学习。Harness-1 把可恢复簿记**移到环境侧确定性维护**——环境维护六大数据结构（候选池 / 策展集 / 证据链接 / 验证记录 / 压缩去重观察 / 预算感知上下文），policy 只回答四问（What do I know? / What should I search for next? / What should I prune? / Do I have enough information?）。论文在 8 个检索基准平均策展召回 0.730，比次强开源 +11.4 分；held-out 迁移基准增益最强。RL 奖励设计：轮次惩罚延迟启动（前 20 轮免罚，TURN_PENALTY_MIN_TURNS=20，最高 0.02）、工具多样性奖励（TOOL_DIVERSITY_BONUS=0.25，目标 6 种工具）、不用 KL 约束（KL_PENALTY_COEF=0.0，允许自由探索）。
> **核心命题：** RouteDev 的 [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 当前是"压缩 transcript"——L1 截断 / L2 snipping / L3 清空 / L4 合并 / L5 LLM 摘要，**所有状态都塞在 transcript 内**，压缩即丢失状态。Phase 63 借鉴 Harness-1 把可恢复簿记移到环境侧——新增 `CuratedSet`（带重要性标签的策展集）、`PruneChunksTool`（减法式策展）、`K-sentence 压缩`（替代完全截断）、`CONTENT_DEDUP`（复用 [CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 内容寻址）、`TOKEN_BUDGET_MARKER`（预算感知渲染）、`VerificationRecords`（已验证声明不重复验证）。policy（LLM）只回答四问，不再承担簿记负担。

---

## 项目现状审计与可行性结论

### 1. 论文与 RouteDev 缺口的映射

| Harness-1 数据结构 | V8D Flag | 核心 Contribution | RouteDev 现状缺口 | Phase 63 Task |
|--------------------|----------|-------------------|-------------------|---------------|
| 候选池 Candidate Pool | AUTO_POPULATE_FIRST_SEARCH | 首次搜索自动填 top-8 | context-compaction 无"候选池"概念，所有内容平铺在 messages | Task 1（CuratedSet 含候选池） |
| 策展集 Curated Set | SUBTRACTIVE_CURATION + IMPORTANCE_TAGGING | 减法式策展（policy 决定移除哪些，而非添加）+ 重要性标签 | context-compaction 是"截断式"（L1-L5 截断），非"策展式"（无 agent 主动裁剪） | Task 1 + Task 2 |
| 重要性标签 | IMPORTANCE_TAGGING | 每条 chunk 标 critical/useful/obsolete | 所有消息同等优先级，L2 snipping 仅按时间"保留最近 10 条" | Task 1 |
| 证据链接 Evidence Links | EVIDENCE_GRAPH | 文档间引用关系图 | 无引用关系追踪，L4 合并仅按 role 去重 | 本 Phase 暂不落地（Phase 65 接知识图谱时合并） |
| 验证记录 Verification Records | VERIFY_TOOL | 跟踪已验证声明避免重复 | [completion-gate](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/completion-gate.ts) 每轮全量重跑 typecheck/tests，无"已验证"标记 | Task 6 |
| 压缩去重观察 Compressed Observations | SENTENCE_COMPRESS K=4 + CONTENT_DEDUP | 句子级压缩保留 K 个关键句 + 内容哈希去重 | L2 snipping 完全删除中间消息；L4 合并去重仅按 role 不按内容 | Task 3 + Task 4 |
| 预算感知上下文 Budget-aware Context | TOKEN_BUDGET_MARKER | 按剩余 token 预算动态渲染 | context-compaction 用固定 targetTokens 阈值触发，agent 无"剩余预算"感知 | Task 5 |
| Policy 四问 | system prompt | What do I know / next / prune / enough | LLM 仅看完整 transcript，无结构化四问引导 | Task 1（CuratedSet 渲染时注入四问） |
| 轮次惩罚延迟启动 | TURN_PENALTY_MIN_TURNS=20 | 前 20 轮免罚避免短视 | 无 RL 奖励，不适用（本 Phase 仅借鉴"延迟启动"思想用于预算阈值） | Task 5 |
| 工具多样性奖励 | TOOL_DIVERSITY_BONUS=0.25 | 鼓励多工具探索 | 不适用 RL，但借鉴用于"建议 agent 多样化工具使用"提示 | 不落地 |
| KL 约束 | KL_PENALTY_COEF=0.0 | 允许自由探索 | 不适用 RL | 不落地 |
| 8 基准召回 0.730 | — | 环境侧策展召回比次强开源 +11.4 | — | 验收参照 |

### 2. 可行性总评

- **Task 1（CuratedSet 环境侧策展集）：** 高度可行。现有 [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 已有 CompactionResult，新增 CuratedSet 类作为环境侧数据结构，与 CCRCache 同级。
- **Task 2（PruneChunksTool 减法式策展）：** 可行。新增工具遵循 [tools/builtin](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/builtin) 模式，agent 主动调用而非机械截断。
- **Task 3（句子级压缩 K=4）：** 可行。L2 snipping 当前完全删除中间消息，改为"保留每条消息的 K 个关键句"是局部增强，不破坏现有 L1/L3/L4/L5。
- **Task 4（CONTENT_DEDUP 内容去重）：** 高度可行。复用 [CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的 createHash 内容寻址模式，L4 合并按内容哈希去重。
- **Task 5（TOKEN_BUDGET_MARKER 预算感知渲染）：** 可行。在上下文插入预算标记，agent 感知剩余预算主动触发压缩。
- **Task 6（VerificationRecords + 配置收口）：** 中等可行。需扩展 completion-gate 与 PolicyEngine 集成。

---

## 核心设计原则

### 原则 1：环境侧确定性维护优先于 policy 上下文簿记

论文核心论断——可恢复簿记（看过什么 / 哪些有用 / 哪些已验证）应移到环境侧确定性维护，不应塞进 policy transcript。Phase 63 的每个 Task 都要回答："这个状态是环境侧确定性维护，还是塞进 transcript 让 LLM 自己记？" 答案总是"环境侧"。

### 原则 2：减法式策展优先于加法式堆叠

论文 SUBTRACTIVE_CURATION——policy 决定移除哪些 chunk，而非添加哪些。当前 context-compaction 是"截断式"（机械删除旧消息），Phase 63 转向"策展式"（agent 主动调用 PruneChunksTool 裁剪低价值 chunk，保留高价值）。重要性标签辅助决策。

### 原则 3：句子级压缩优先于完全截断

论文 SENTENCE_COMPRESS K=4——保留每条消息的 K 个关键句，而非完全删除。完全截断丢失信息密度高的重要句（如约束声明、API 签名）。Phase 63 的 L2 snipping 用 K-sentence 压缩替代完全截断。

### 原则 4：内容寻址去重优先于结构去重

论文 CONTENT_DEDUP——按内容哈希去重，而非按 role 或 timestamp。当前 L4 合并按 role 去重，无法识别"不同 role 但内容相同"的冗余。Phase 63 复用 [CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的内容寻址模式。

### 原则 5：预算感知让 agent 主动压缩

论文 TOKEN_BUDGET_MARKER——上下文插入预算标记，agent 感知剩余预算主动触发压缩。当前 context-compaction 是被动触发（达到 80% 阈值），agent 无感知。Phase 63 让 agent 看到"剩余预算"，主动决定 prune 什么。

### 原则 6：反写死原则（延续 Phase 51）

所有新增数据结构与压缩策略必须有配置开关、设置页面入口、明确代码接线点。默认关闭，用户在设置页开启。CuratedSet 与 K-sentence 压缩因影响上下文质量，默认关闭。

### 原则 7：Fail-open，不破坏现有压缩管线

CuratedSet 查询失败、PruneChunksTool 异常、K-sentence 压缩失败时，降级为现有 L1-L5 行为，不阻塞主流程。

### 原则 8：死代码防护与执行人自审（延续 Phase 51/53）

**死代码零容忍**：本 Phase 新增的每个类、函数、配置字段、接口必须有明确的消费方（调用点或读取点）。

**执行人自审硬性要求**（每个 Task 完成后必须执行，未通过不得提交）：

1. **新增模块消费验证**：用 `rtk grep` 搜索新增类/函数名，确认至少有一个调用点（测试文件除外）
2. **配置字段消费验证**：新增的每个 zod schema 字段，必须确认有读取方（`rtk grep` 字段名确认非零引用）
3. **导出必要性验证**：新增的 `export` 必须有外部消费者；同文件内使用的 schema 用 `const` 而非 `export const`（延续 Phase 53 类型清理）
4. **knip 扫描**：Task 完成后运行 `npx knip`，新增文件不得出现在"未引用"列表中（动态 import 接线的 policy 文件除外，需在自审报告中说明）
5. **自审报告**：每个 Task 的最后一个 Step 必须是"死代码自审"，在提交信息中附自审结论（如"knip 通过，新增 5 个 export 均有消费方"）

**禁止**：
- 禁止新增"未来可能用到"的配置字段（YAGNI）
- 禁止新增未被调用的工具函数
- 禁止 export 仅供同文件使用的常量/类型

---

## Task 1：环境侧策展集 CuratedSet（≥ 8 测试）

### 1.1 论文借鉴

Harness-1 核心数据结构——**Curated Set（带重要性标签的策展集）**。环境侧维护一个策展集，每条 chunk 带 `critical / useful / obsolete` 重要性标签。policy 通过 SUBTRACTIVE_CURATION 决定移除哪些（减法式），IMPORTANCE_TAGGING 辅助决策。论文证明 8 个检索基准平均策展召回 0.730，比次强开源 +11.4 分。RouteDev 的 [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 当前所有内容平铺在 messages 数组，无"策展集"概念，L2 snipping 仅按时间"保留最近 10 条"，无重要性标签。

### 1.2 设计

新增 `CuratedSet` 类，作为环境侧数据结构（与 [CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 同级）：

```ts
// src/agent/curated-set.ts
/**
 * 环境侧策展集
 * 论文借鉴：Harness-1 Curated Set + IMPORTANCE_TAGGING + SUBTRACTIVE_CURATION
 *
 * 与 context-compaction 的区别：
 *   1. 环境侧确定性维护（不塞进 transcript）
 *   2. 重要性标签（critical/useful/obsolete）辅助决策
 *   3. 减法式策展（policy 决定移除哪些，而非添加）
 *   4. 候选池自动填充（AUTO_POPULATE_FIRST_SEARCH）
 *
 * Policy 四问（渲染时注入 system prompt）：
 *   1. What do I know? — 列出已检索文档涵盖的关键主题
 *   2. What should I search for next? — 系统性考虑未尝试的搜索方法
 *   3. What should I prune? — 移除什么，新搜索是否更好
 *   4. Do I have enough information? — 是否有足够信息或存在关键缺口
 */

/** 重要性标签（论文 IMPORTANCE_TAGGING） */
export type ImportanceTag = 'critical' | 'useful' | 'obsolete';

/** 策展集条目 */
export interface CuratedChunk {
  /** chunk ID（内容哈希前 12 位，复用 CCRCache 模式） */
  id: string;
  /** 原始内容 */
  content: string;
  /** 重要性标签 */
  importance: ImportanceTag;
  /** 来源（如 'file-read:src/router/router.ts' / 'web-fetch:https://...'） */
  source: string;
  /** token 估算 */
  tokenEstimate: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 最后访问时间戳（用于 LRU 淘汰） */
  lastAccessedAt: number;
  /** 访问次数（用于热度排序） */
  accessCount: number;
}

export interface CuratedSetConfig {
  /** 候选池自动填充数量（AUTO_POPULATE_FIRST_SEARCH，默认 8） */
  autoPopulateCount: number;
  /** 策展集最大 token 预算（默认 8000） */
  maxTokenBudget: number;
  /** 是否启用重要性标签（IMPORTANCE_TAGGING，默认 true） */
  importanceTaggingEnabled: boolean;
  /** 是否启用减法式策展（SUBTRACTIVE_CURATION，默认 true） */
  subtractiveCurationEnabled: boolean;
}

export class CuratedSet {
  /** 策展集（按 id 索引） */
  private chunks = new Map<string, CuratedChunk>();
  /** 候选池（待策展的 chunk，AUTO_POPULATE_FIRST_SEARCH 填充） */
  private candidatePool: CuratedChunk[] = [];
  /** 是否已触发首次填充 */
  private firstPopulateDone = false;

  constructor(private readonly config: CuratedSetConfig) {}

  /**
   * 添加 chunk 到候选池
   * 首次添加时自动策展 top-N（AUTO_POPULATE_FIRST_SEARCH）
   */
  async add(content: string, source: string): Promise<CuratedChunk>;

  /**
   * 自动策展候选池 top-N 到策展集
   * 按内容哈希去重 + 重要性估算（基于关键词启发式）
   */
  private autoPopulate(): void;

  /**
   * 估算重要性标签（启发式）
   * - critical：含 'error' / 'fail' / 'crash' / API 签名 / 约束声明
   * - useful：含代码 / 配置 / 命令
   * - obsolete：含日志输出 / 调试信息 / 重复内容
   */
  private estimateImportance(content: string): ImportanceTag;

  /**
   * 减法式策展：policy 决定移除哪些 chunk
   * @param chunkIds 要移除的 chunk ID 列表
   * @returns 实际移除的 chunk 列表
   */
  prune(chunkIds: string[]): CuratedChunk[];

  /**
   * 提升重要性（policy 可调用，将 useful 提升为 critical）
   */
  promote(chunkId: string, to: ImportanceTag): boolean;

  /**
   * 渲染策展集为 system prompt 片段
   * 注入 policy 四问引导
   */
  renderToPrompt(tokenBudget: number): {
    /** 渲染后的 system prompt 片段 */
    prompt: string;
    /** 实际使用的 token 数 */
    usedTokens: number;
    /** 被渲染的 chunk 列表（按重要性排序） */
    renderedChunks: CuratedChunk[];
  };

  /**
   * 查询策展集（按关键词或 source）
   */
  query(params: { keyword?: string; source?: string; importance?: ImportanceTag }): CuratedChunk[];

  /** 获取策展集统计 */
  getStats(): {
    totalChunks: number;
    totalTokens: number;
    byImportance: Record<ImportanceTag, number>;
    candidatePoolSize: number;
  };
}
```

### 1.3 接线点

- 新增：`src/agent/curated-set.ts`
- 修改：`src/agent/context-compaction.ts` — compact 入口前先查询 CuratedSet，渲染策展集到 system prompt
- 修改：`src/cli/app-init.ts` — 装配 CuratedSet 单例，注入 ContextCompactor
- 复用：[CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的 createHash 模式生成 chunk id

### 1.4 Step 分解

- [ ] **Step 1: 定义 CuratedChunk 与 CuratedSetConfig 类型**

新建 `src/agent/curated-set.ts`，实现上述接口。`autoPopulateCount` 默认 8（论文值），`maxTokenBudget` 默认 8000，`importanceTaggingEnabled` 与 `subtractiveCurationEnabled` 默认 true。

- [ ] **Step 2: 实现 add 与 autoPopulate**

`add` 把 chunk 加入 candidatePool；若 `firstPopulateDone === false` 且 candidatePool 达到 autoPopulateCount，触发 `autoPopulate`：按内容哈希去重 + 启发式估算重要性 + 选 top-N 加入策展集。

- [ ] **Step 3: 实现 estimateImportance 启发式**

关键词匹配：
- critical：含 `error|fail|crash|exception|throw|必须|禁止|不要`（约束声明）+ API 签名（`function|interface|class`）
- useful：含代码块（```）+ 配置（`config|setting`）+ 命令（`pnpm|npm|git`）
- obsolete：纯日志输出（`log|debug|info:`）+ 重复内容（与已有 chunk 哈希相同）

- [ ] **Step 4: 实现 prune 与 promote**

`prune(chunkIds)` 从 chunks Map 删除指定 ID，返回被移除的 chunk 列表（减法式策展）。`promote(chunkId, to)` 更新 importance 标签。

- [ ] **Step 5: 实现 renderToPrompt 与 policy 四问**

按 importance 排序（critical → useful → obsolete），按 tokenBudget 截断。渲染格式：
```
[策展集 - 剩余预算 X tokens]
## 关键信息（critical）
- chunk1: ...
- chunk2: ...
## 有用信息（useful）
- chunk3: ...

## Policy 四问
1. What do I know? 上述已检索的关键主题
2. What should I search for next? 考虑未尝试的搜索方法
3. What should I prune? 用 PruneChunksTool 移除低价值 chunk
4. Do I have enough information? 是否有足够信息或存在关键缺口
```

- [ ] **Step 6: 实现 query 与 getStats**

`query` 按关键词/source/importance 过滤。`getStats` 返回统计。

- [ ] **Step 7: 接入 context-compaction**

在 [context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 的 compact 入口前，若 config 启用 curatedSet，调用 `curatedSet.renderToPrompt(tokenBudget)`，渲染结果作为 system 消息插入 messages 头部。fail-open：渲染失败时跳过，继续走 L1-L5。

- [ ] **Step 8: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
curatedSet: z.object({
  enabled: z.boolean().default(false),
  autoPopulateCount: z.number().int().min(1).max(20).default(8),
  maxTokenBudget: z.number().int().default(8000),
  importanceTaggingEnabled: z.boolean().default(true),
  subtractiveCurationEnabled: z.boolean().default(true),
}).default({}),
```

- [ ] **Step 9: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/curated-set.test.ts`，覆盖：
- add 首次触发 autoPopulate
- autoPopulate 按哈希去重
- estimateImportance 三类标签启发式
- prune 减法式策展
- promote 提升重要性
- renderToPrompt 按 tokenBudget 截断
- renderToPrompt 注入 policy 四问
- query 按关键词/importance 过滤

- [ ] **Step 10: 提交**

```powershell
git add -A
git commit -m "feat(phase-63): 环境侧策展集 CuratedSet

新增 CuratedSet，环境侧确定性维护带重要性标签的策展集
论文借鉴：Harness-1 Curated Set + IMPORTANCE_TAGGING + SUBTRACTIVE_CURATION
减法式策展：policy 决定移除哪些 chunk，而非添加"
```

---

## Task 2：减法式策展 PruneChunksTool（≥ 6 测试）

### 2.1 论文借鉴

Harness-1 的 SUBTRACTIVE_CURATION——policy 通过工具调用主动裁剪策展集，而非机械截断。论文证明减法式策展让 policy 学会"识别低价值信息"，比固定规则截断召回率高。RouteDev 的 [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 当前 L2 snipping 机械删除旧消息，agent 无主动裁剪能力——只能被动接受截断结果。

### 2.2 设计

新增 `PruneChunksTool` 工具，让 agent 主动调用裁剪 CuratedSet：

```ts
// src/tools/builtin/prune-chunks.ts
/**
 * 减法式策展工具
 * 论文借鉴：Harness-1 SUBTRACTIVE_CURATION——policy 主动裁剪
 *
 * 与 context-compaction 截断的区别：
 *   1. agent 主动调用（而非被动接受截断）
 *   2. 按内容价值裁剪（而非按时间）
 *   3. 支持批量裁剪 + 单条提升
 */
import type { Tool } from '../types.js';

export interface PruneChunksParams {
  /** 要移除的 chunk ID 列表 */
  chunkIds: string[];
  /** 移除原因（用于追踪） */
  reason: string;
}

export interface PromoteChunkParams {
  /** chunk ID */
  chunkId: string;
  /** 提升到的重要性标签 */
  to: 'critical' | 'useful';
  /** 提升原因 */
  reason: string;
}

export const pruneChunksTool: Tool = {
  name: 'prune_chunks',
  description: `减法式策展工具：从策展集中移除低价值 chunk，释放 token 预算。
适用场景：
- 当策展集接近 token 预算上限时
- 当发现某些 chunk 已过时（obsolete）或重复
- 当新搜索结果比旧 chunk 更有价值

输入：chunkIds（要移除的 chunk ID 列表）+ reason（移除原因）
输出：实际移除的 chunk 列表 + 释放的 token 数

注意：critical 标签的 chunk 移除前会要求二次确认（除非 force=true）`,
  category: 'context_management',
  parameters: {
    type: 'object',
    properties: {
      chunkIds: { type: 'array', items: { type: 'string' }, description: '要移除的 chunk ID 列表' },
      reason: { type: 'string', description: '移除原因' },
      force: { type: 'boolean', description: '是否强制移除 critical chunk（默认 false）' },
    },
    required: ['chunkIds', 'reason'],
  },
};

export const promoteChunkTool: Tool = {
  name: 'promote_chunk',
  description: `提升 chunk 重要性标签：将 useful 提升为 critical，或 obsolete 提升为 useful。
适用场景：
- 发现某 chunk 是关键约束声明
- 发现某 chunk 包含 API 签名
- 发现某 chunk 是错误根因

输入：chunkId + to（目标标签）+ reason
输出：是否提升成功`,
  category: 'context_management',
  parameters: {
    type: 'object',
    properties: {
      chunkId: { type: 'string', description: 'chunk ID' },
      to: { type: 'string', enum: ['critical', 'useful'], description: '目标重要性标签' },
      reason: { type: 'string', description: '提升原因' },
    },
    required: ['chunkId', 'to', 'reason'],
  },
};
```

### 2.3 接线点

- 新增：`src/tools/builtin/prune-chunks.ts`
- 修改：`src/tools/registry.ts` — 注册 prune_chunks 与 promote_chunk 工具
- 修改：`src/tools/builtin/index.ts` — 导出新工具
- 复用：[CuratedSet](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/curated-set.ts) 的 prune 与 promote 方法
- 修改：`src/agent/prompts.ts` — system prompt 增加"策展集管理"工具说明

### 2.4 Step 分解

- [ ] **Step 1: 定义 PruneChunksParams 与 PromoteChunkParams 类型**

新建 `src/tools/builtin/prune-chunks.ts`，实现上述工具定义。`force` 默认 false（critical chunk 需二次确认）。

- [ ] **Step 2: 实现 prune_chunks 工具执行器**

执行流程：
1. 从 toolContext 获取 curatedSet 实例
2. 校验 chunkIds 都存在
3. 若含 critical chunk 且 force=false，返回"需二次确认"提示
4. 调用 `curatedSet.prune(chunkIds)`
5. 返回移除列表 + 释放 token 数

- [ ] **Step 3: 实现 promote_chunk 工具执行器**

调用 `curatedSet.promote(chunkId, to)`，返回是否成功。

- [ ] **Step 4: 注册工具**

在 [registry.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/registry.ts) 注册 prune_chunks 与 promote_chunk。注意：这两个工具只在 curatedSet.enabled=true 时注册（避免未启用时污染工具列表）。

- [ ] **Step 5: system prompt 注入工具说明**

在 [prompts.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/prompts.ts) 的 system prompt 模板中，若 curatedSet.enabled=true，追加：
```
## 策展集管理工具
- prune_chunks: 移除低价值 chunk，释放 token 预算
- promote_chunk: 提升 chunk 重要性标签
当策展集接近预算上限时，主动调用 prune_chunks 移除 obsolete chunk。
```

- [ ] **Step 6: 配置开关**

prune_chunks 与 promote_chunk 工具的注册由 `curatedSet.enabled` 控制（Task 1 已定义）。无需独立配置。

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/tools/prune-chunks.test.ts`，覆盖：
- prune_chunks 移除 useful chunk 成功
- prune_chunks 移除 critical chunk 需 force=true
- prune_chunks 不存在的 chunkId 报错
- promote_chunk useful → critical 成功
- promote_chunk obsolete → useful 成功
- curatedSet.enabled=false 时工具未注册

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-63): 减法式策展 PruneChunksTool

新增 prune_chunks + promote_chunk 工具，agent 主动裁剪策展集
论文借鉴：Harness-1 SUBTRACTIVE_CURATION——policy 主动裁剪
与 context-compaction 截断的区别：按内容价值裁剪，而非按时间"
```

---

## Task 3：句子级压缩 K=4（≥ 6 测试）

### 3.1 论文借鉴

Harness-1 的 SENTENCE_COMPRESS K=4——保留每条消息的 K 个关键句，而非完全删除。论文证明句子级压缩在保留信息密度的同时减少 token——完全截断丢失信息密度高的重要句（如约束声明、API 签名、错误根因），句子级压缩保留这些关键句。RouteDev 的 [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 当前 L2 snipping 完全删除中间消息（仅保留最近 10 条 + system），信息密度高的重要句随删除一起丢失。

### 3.2 设计

新增 `KSentenceCompressor` 类，替代 L2 snipping 的完全删除：

```ts
// src/agent/ksentence-compressor.ts
/**
 * 句子级压缩 K=4
 * 论文借鉴：Harness-1 SENTENCE_COMPRESS K=4
 *
 * 与 L2 snipping 完全删除的区别：
 *   1. 保留每条消息的 K 个关键句（默认 4）
 *   2. 关键句按信息密度评分（含关键词 + 长度 + 位置）
 *   3. 保留原消息占位（标注被压缩），不破坏 tool_use/tool_result 对偶
 */
export interface KSentenceConfig {
  /** 保留的关键句数量（默认 4，论文值） */
  k: number;
  /** 信息密度评分权重 */
  scoring: {
    /** 关键词权重（含 error/fail/必须/禁止 等） */
    keywordWeight: number; // 默认 0.5
    /** 长度权重（中等长度句子信息密度更高） */
    lengthWeight: number; // 默认 0.3
    /** 位置权重（首句与末句更重要） */
    positionWeight: number; // 默认 0.2
  };
}

export class KSentenceCompressor {
  constructor(private readonly config: KSentenceConfig) {}

  /**
   * 压缩单条消息内容
   * @param content 原始内容
   * @returns 压缩后内容 + 压缩标记
   */
  compress(content: string): {
    /** 压缩后内容（K 个关键句 + 压缩标记） */
    compressed: string;
    /** 原始句数 */
    originalSentenceCount: number;
    /** 保留句数 */
    keptSentenceCount: number;
    /** 是否被压缩（句数 <= K 时不压缩） */
    wasCompressed: boolean;
  };

  /**
   * 句子分割（支持中英文标点）
   */
  private splitSentences(text: string): string[];

  /**
   * 信息密度评分
   */
  private scoreSentence(sentence: string, index: number, total: number): number;

  /**
   * 批量压缩消息数组
   * 仅压缩 assistant/user/tool 消息，system 消息不压缩
   */
  compressMessages(messages: LLMMessage[]): LLMMessage[];
}
```

### 3.3 接线点

- 新增：`src/agent/ksentence-compressor.ts`
- 修改：`src/agent/context-compaction.ts` — L2 snipping 调用 KSentenceCompressor.compressMessages 替代完全删除
- 修改：`src/agent/context-compaction.ts` — CompactionConfig 增加可选 kSentenceCompressor 字段

### 3.4 Step 分解

- [ ] **Step 1: 定义 KSentenceConfig 类型**

新建 `src/agent/ksentence-compressor.ts`，实现上述接口。`k` 默认 4（论文值），scoring 权重默认 0.5/0.3/0.2。

- [ ] **Step 2: 实现 splitSentences**

支持中英文标点：`。！？.!?` + 换行符。保留标点在句尾。

- [ ] **Step 3: 实现 scoreSentence**

```
score = keywordWeight × keywordScore
      + lengthWeight × lengthScore
      + positionWeight × positionScore
```
- keywordScore：含 `error|fail|crash|必须|禁止|不要|function|interface|class|return|throw` 等关键词得 1，否则 0
- lengthScore：长度在 20-200 字符得 1，<20 或 >200 衰减
- positionScore：首句或末句得 1，中间句得 0.5

- [ ] **Step 4: 实现 compress**

1. splitSentences
2. 若句数 <= k，返回原内容，wasCompressed=false
3. 否则按 score 降序选 top-k，按原顺序排列
4. 压缩标记：`[...K-sentence 压缩：保留 4/12 句...]` + 压缩后内容

- [ ] **Step 5: 实现 compressMessages**

遍历 messages，跳过 system 消息，对 assistant/user/tool 消息调用 compress。保留原消息 role 与 metadata，仅替换 content。

- [ ] **Step 6: 接入 L2 snipping**

在 [context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 的 stage2SnipOldMessages 中，若 config 启用 kSentenceCompressor，调用 `compressor.compressMessages(toBeSnipped)`，压缩后保留（替代完全删除）。保留最近 N 条不压缩（N=SNIP_KEEP_RECENT=10）。

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
kSentenceCompression: z.object({
  enabled: z.boolean().default(false),
  k: z.number().int().min(1).max(10).default(4),
  keywordWeight: z.number().min(0).max(1).default(0.5),
  lengthWeight: z.number().min(0).max(1).default(0.3),
  positionWeight: z.number().min(0).max(1).default(0.2),
}).default({}),
```

- [ ] **Step 8: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/ksentence-compressor.test.ts`，覆盖：
- splitSentences 中英文标点
- scoreSentence 关键词得分
- scoreSentence 长度得分
- scoreSentence 位置得分
- compress 句数 <= k 不压缩
- compress 句数 > k 保留 top-k
- compressMessages 跳过 system 消息
- compressMessages 保留 role 与 metadata

- [ ] **Step 9: 提交**

```powershell
git add -A
git commit -m "feat(phase-63): 句子级压缩 K=4

新增 KSentenceCompressor，L2 snipping 用 K-sentence 压缩替代完全截断
论文借鉴：Harness-1 SENTENCE_COMPRESS K=4
信息密度评分：关键词 0.5 + 长度 0.3 + 位置 0.2"
```

---

## Task 4：内容去重 CONTENT_DEDUP（≥ 6 测试）

### 4.1 论文借鉴

Harness-1 的 CONTENT_DEDUP——按内容哈希去重，而非按 role 或 timestamp。论文证明内容去重能识别"不同 role 但内容相同"的冗余（如多个 assistant 消息引用同一段代码）。RouteDev 的 [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 当前 L4 合并按 role 去重（合并连续相同 role 的消息），无法识别"不同 role 但内容相同"的冗余。RouteDev 已有 [CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的内容寻址能力，可直接复用。

### 4.2 设计

新增 `ContentDeduplicator` 类，复用 CCRCache 的 createHash 模式：

```ts
// src/agent/content-deduplicator.ts
/**
 * 内容去重
 * 论文借鉴：Harness-1 CONTENT_DEDUP——按内容哈希去重
 *
 * 与 L4 合并按 role 去重的区别：
 *   1. 按 SHA-256 内容哈希去重（跨 role）
 *   2. 保留首个出现，后续重复替换为引用标记
 *   3. 引用标记指向 CuratedSet 中的 chunk（若已策展）
 *
 * 复用：CCRCache 的 createHash('sha256') 模式
 */
import { createHash } from 'node:crypto';
import type { LLMMessage } from '../router/types.js';

export interface ContentDedupConfig {
  /** 是否启用内容去重（CONTENT_DEDUP，默认 true） */
  enabled: boolean;
  /** 哈希算法（默认 sha256） */
  hashAlgorithm: 'sha256' | 'md5';
  /** 最小去重内容长度（短于此长度不去重，默认 50 字符） */
  minLength: number;
  /** 是否替换为引用标记（true）或直接删除（false） */
  replaceWithReference: boolean;
}

export interface DedupResult {
  /** 去重后的消息数组 */
  messages: LLMMessage[];
  /** 被去重的消息数 */
  deduplicatedCount: number;
  /** 释放的 token 数 */
  savedTokens: number;
  /** 内容哈希到首次出现位置的映射 */
  hashToFirstIndex: Map<string, number>;
}

export class ContentDeduplicator {
  constructor(
    private readonly config: ContentDedupConfig,
    private readonly estimateTokens: (text: string) => number,
  ) {}

  /**
   * 内容去重
   * 遍历消息，按内容哈希识别重复，保留首个，后续替换为引用标记或删除
   */
  dedup(messages: LLMMessage[]): DedupResult;

  /**
   * 计算内容哈希
   * 标准化（去空白 + 小写）后 SHA-256
   */
  private hashContent(content: string): string;

  /**
   * 生成引用标记
   * @param firstIndex 首次出现的消息索引
   * @param hash 内容哈希前 12 位
   */
  private buildReferenceMarker(firstIndex: number, hash: string): string;
}
```

### 4.3 接线点

- 新增：`src/agent/content-deduplicator.ts`
- 修改：`src/agent/context-compaction.ts` — L4 合并阶段调用 ContentDeduplicator.dedup
- 复用：[CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的 createHash 模式
- 复用：[token-estimate](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/utils/token-estimate.ts) 工具

### 4.4 Step 分解

- [ ] **Step 1: 定义 ContentDedupConfig 与 DedupResult 类型**

新建 `src/agent/content-deduplicator.ts`，实现上述接口。`enabled` 默认 true，`hashAlgorithm` 默认 sha256，`minLength` 默认 50，`replaceWithReference` 默认 true。

- [ ] **Step 2: 实现 hashContent**

标准化：trim + 去多余空白 + 小写。哈希：`createHash('sha256').update(normalized).digest('hex')`。

- [ ] **Step 3: 实现 buildReferenceMarker**

格式：`[...DEDUP:hash=abc12345 first=#5...]`，表示"此内容与第 5 条消息相同，哈希 abc12345"。

- [ ] **Step 4: 实现 dedup**

遍历 messages：
1. 跳过 system 消息（不参与去重）
2. 提取 content（string 或 ContentPart[] 拼接）
3. 若长度 < minLength，跳过
4. 计算哈希，若 hashToFirstIndex 已存在：
   - replaceWithReference=true：替换为引用标记
   - replaceWithReference=false：标记为删除
5. 否则记录 hashToFirstIndex
6. 统计 deduplicatedCount 与 savedTokens

- [ ] **Step 5: 接入 L4 合并**

在 [context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 的 stage4Collapse 中，若 config 启用 contentDeduplicator，先调用 `deduplicator.dedup(current)`，再执行原有 role 合并。

- [ ] **Step 6: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
contentDedup: z.object({
  enabled: z.boolean().default(false),
  hashAlgorithm: z.enum(['sha256', 'md5']).default('sha256'),
  minLength: z.number().int().min(0).default(50),
  replaceWithReference: z.boolean().default(true),
}).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/content-deduplicator.test.ts`，覆盖：
- hashContent 标准化（空白/大小写不敏感）
- dedup 跨 role 识别重复
- dedup 短内容（< minLength）不去重
- dedup replaceWithReference=true 替换为标记
- dedup replaceWithReference=false 直接删除
- dedup savedTokens 统计正确

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-63): 内容去重 CONTENT_DEDUP

新增 ContentDeduplicator，L4 合并按 SHA-256 内容哈希去重
论文借鉴：Harness-1 CONTENT_DEDUP——按内容哈希去重（跨 role）
复用：CCRCache 的 createHash 模式"
```

---

## Task 5：预算感知渲染 TOKEN_BUDGET_MARKER（≥ 6 测试）

### 5.1 论文借鉴

Harness-1 的 TOKEN_BUDGET_MARKER——上下文插入预算标记，policy 感知剩余预算主动触发压缩。论文设计：每轮渲染时插入 `[BUDGET: used=12000/20000 remaining=8000 (40%)]` 标记，policy 看到剩余预算不足时主动调用 prune 工具。RouteDev 的 [context-compaction](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 当前是被动触发（达到 80% 阈值才压缩），agent 无"剩余预算"感知——agent 不知道还剩多少 token，无法主动决策。

### 5.2 设计

新增 `BudgetAwareRenderer` 类，在上下文渲染时插入预算标记：

```ts
// src/agent/budget-aware-renderer.ts
/**
 * 预算感知渲染
 * 论文借鉴：Harness-1 TOKEN_BUDGET_MARKER——按剩余 token 预算动态渲染
 *
 * 与 context-compaction 被动触发的区别：
 *   1. 主动渲染预算标记到 system prompt
 *   2. policy 看到剩余预算，主动调用 prune_chunks 工具
 *   3. 三级预算阈值（论文 TURN_PENALTY_MIN_TURNS=20 启发：延迟启动）
 *      - 50% 软通知（保护缓存前缀，不压缩）
 *      - 80% 触发压缩
 *      - 90% 强制压缩
 */
export interface BudgetRenderConfig {
  /** 是否启用预算感知渲染（TOKEN_BUDGET_MARKER，默认 false） */
  enabled: boolean;
  /** 上下文窗口大小（token，默认 200000） */
  contextWindow: number;
  /** 软通知阈值（默认 0.5） */
  softNotifyThreshold: number;
  /** 触发压缩阈值（默认 0.8） */
  triggerThreshold: number;
  /** 强制压缩阈值（默认 0.9） */
  forceThreshold: number;
  /** 是否在每轮渲染预算标记 */
  renderEveryTurn: boolean;
}

export interface BudgetSnapshot {
  /** 已用 token */
  used: number;
  /** 总预算 */
  total: number;
  /** 剩余 token */
  remaining: number;
  /** 使用比例（0-1） */
  ratio: number;
  /** 当前级别（safe / soft-notify / trigger / force） */
  level: 'safe' | 'soft-notify' | 'trigger' | 'force';
}

export class BudgetAwareRenderer {
  constructor(
    private readonly config: BudgetRenderConfig,
    private readonly estimateTokens: (text: string) => number,
  ) {}

  /**
   * 计算当前预算快照
   */
  computeBudget(messages: LLMMessage[]): BudgetSnapshot;

  /**
   * 渲染预算标记
   * 输出格式：[BUDGET: used=12000/200000 remaining=188000 (6%) level=safe]
   */
  renderMarker(snapshot: BudgetSnapshot): string;

  /**
   * 渲染建议（基于预算级别）
   * - safe：无建议
   * - soft-notify：建议关注预算，可考虑 prune obsolete chunk
   * - trigger：建议立即调用 prune_chunks 释放预算
   * - force：必须 prune，否则将强制压缩（L5 摘要）
   */
  renderAdvice(snapshot: BudgetSnapshot): string;

  /**
   * 渲染完整预算提示（marker + advice）
   * 注入到 system prompt 末尾
   */
  renderBudgetPrompt(messages: LLMMessage[]): {
    /** 预算提示文本 */
    prompt: string;
    /** 预算快照 */
    snapshot: BudgetSnapshot;
  };
}
```

### 5.3 接线点

- 新增：`src/agent/budget-aware-renderer.ts`
- 修改：`src/agent/prompts.ts` — system prompt 渲染时调用 BudgetAwareRenderer.renderBudgetPrompt
- 修改：`src/agent/loop.ts` — 每轮 LLM 调用前更新预算提示
- 复用：[token-estimate](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/utils/token-estimate.ts)
- 复用：[cache-optimizer](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/router/cache-optimizer.ts) 的 decideCompactionAction 三级阈值

### 5.4 Step 分解

- [ ] **Step 1: 定义 BudgetRenderConfig 与 BudgetSnapshot 类型**

新建 `src/agent/budget-aware-renderer.ts`，实现上述接口。`contextWindow` 默认 200000，三个阈值默认 0.5/0.8/0.9，`renderEveryTurn` 默认 true。

- [ ] **Step 2: 实现 computeBudget**

遍历 messages 累加 tokenEstimate，计算 ratio = used / contextWindow。级别判定：
- ratio < softNotifyThreshold → 'safe'
- softNotifyThreshold <= ratio < triggerThreshold → 'soft-notify'
- triggerThreshold <= ratio < forceThreshold → 'trigger'
- ratio >= forceThreshold → 'force'

- [ ] **Step 3: 实现 renderMarker**

格式：`[BUDGET: used=12000/200000 remaining=188000 (6%) level=safe]`

- [ ] **Step 4: 实现 renderAdvice**

按级别返回建议：
- safe：空字符串
- soft-notify：`当前预算充足，但建议关注。可考虑用 prune_chunks 移除 obsolete chunk 释放空间。`
- trigger：`预算触发压缩阈值。建议立即调用 prune_chunks 移除低价值 chunk，避免 L5 摘要损失信息。`
- force：`预算强制压缩阈值。必须立即 prune，否则下一步将触发 L5 LLM 摘要（有损压缩）。`

- [ ] **Step 5: 实现 renderBudgetPrompt**

调用 computeBudget + renderMarker + renderAdvice，拼接为完整提示文本。

- [ ] **Step 6: 接入 system prompt 渲染**

在 [prompts.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/prompts.ts) 的 system prompt 渲染逻辑中，若 config 启用 budgetAwareRenderer，调用 `renderer.renderBudgetPrompt(messages)`，结果追加到 system prompt 末尾。

- [ ] **Step 7: 接入 loop 每轮更新**

在 [loop.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/loop.ts) 每轮 LLM 调用前，若 renderEveryTurn=true，重新渲染预算提示（messages 可能已变化）。

- [ ] **Step 8: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
budgetAwareRendering: z.object({
  enabled: z.boolean().default(false),
  contextWindow: z.number().int().default(200000),
  softNotifyThreshold: z.number().min(0).max(1).default(0.5),
  triggerThreshold: z.number().min(0).max(1).default(0.8),
  forceThreshold: z.number().min(0).max(1).default(0.9),
  renderEveryTurn: z.boolean().default(true),
}).default({}),
```

- [ ] **Step 9: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/budget-aware-renderer.test.ts`，覆盖：
- computeBudget safe 级别
- computeBudget soft-notify 级别
- computeBudget trigger 级别
- computeBudget force 级别
- renderMarker 格式正确
- renderAdvice 四级建议
- renderBudgetPrompt 拼接 marker + advice
- 配置关闭时不渲染

- [ ] **Step 10: 提交**

```powershell
git add -A
git commit -m "feat(phase-63): 预算感知渲染 TOKEN_BUDGET_MARKER

新增 BudgetAwareRenderer，上下文插入预算标记，agent 感知剩余预算
论文借鉴：Harness-1 TOKEN_BUDGET_MARKER——按剩余 token 预算动态渲染
三级阈值：50%软通知/80%触发/90%强制（复用 cache-optimizer 阈值模式）"
```

---

## Task 6：验证记录 VerificationRecords + 配置收口（≥ 8 测试）

### 6.1 论文借鉴

Harness-1 的 VERIFY_TOOL——跟踪已验证声明避免重复验证。论文证明：已验证的声明（如"函数 X 已通过 typecheck"）不需要每轮重新验证，节省大量 LLM/工具调用。RouteDev 的 [completion-gate](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/completion-gate.ts) 每轮全量重跑 typecheck/lint/tests，无"已验证"标记——即使某文件未修改，typecheck 仍全量执行。Phase 62 的 LoopUntilDoneGate 也每轮全量调用 completionGate.run，无验证记录复用。

### 6.2 设计

新增 `VerificationRecords` 类，记录已验证的声明：

```ts
// src/agent/verification-records.ts
/**
 * 验证记录
 * 论文借鉴：Harness-1 VERIFY_TOOL——跟踪已验证声明避免重复验证
 *
 * 与 completion-gate 全量重跑的区别：
 *   1. 按文件粒度记录验证结果（文件未修改则复用上次结果）
 *   2. 按声明粒度记录（如"函数 X 已通过 typecheck"）
 *   3. 提供 isVerified(query) 查询接口
 *
 * 复用：CCRCache 的内容哈希模式（文件内容哈希作为验证 key）
 */
import { createHash } from 'node:crypto';

export interface VerificationRecord {
  /** 验证 ID */
  id: string;
  /** 验证类型（typecheck / lint / test / claim） */
  type: 'typecheck' | 'lint' | 'test' | 'claim';
  /** 验证目标（文件路径 / 函数签名 / 声明文本） */
  target: string;
  /** 目标内容哈希（文件内容或声明文本的 SHA-256） */
  targetHash: string;
  /** 是否通过 */
  passed: boolean;
  /** 验证时间戳 */
  verifiedAt: number;
  /** 验证来源（如 'completion-gate:round-3' / 'cross-model-reviewer'） */
  source: string;
}

export interface VerificationRecordsConfig {
  /** 是否启用验证记录（VERIFY_TOOL，默认 false） */
  enabled: boolean;
  /** 记录最大数量（默认 1000） */
  maxRecords: number;
  /** 记录过期时间（ms，默认 1 小时） */
  ttlMs: number;
}

export class VerificationRecords {
  /** 记录按 (type + target + targetHash) 索引 */
  private records = new Map<string, VerificationRecord>();

  constructor(private readonly config: VerificationRecordsConfig) {}

  /**
   * 记录一次验证结果
   */
  record(record: Omit<VerificationRecord, 'id' | 'verifiedAt'>): VerificationRecord;

  /**
   * 查询某验证是否已通过（且目标内容未变）
   * @param type 验证类型
   * @param target 验证目标
   * @param currentHash 当前目标内容哈希（若与记录的 targetHash 不同则视为未验证）
   */
  isVerified(type: VerificationRecord['type'], target: string, currentHash: string): boolean;

  /**
   * 批量查询文件验证状态
   * @param files 文件路径 + 当前内容哈希列表
   */
  batchIsVerified(files: Array<{ path: string; hash: string }>): Map<string, boolean>;

  /**
   * 清理过期记录
   */
  cleanup(): number;

  /**
   * 计算文件内容哈希
   */
  hashContent(content: string): string;
}
```

### 6.3 接线点

- 新增：`src/agent/verification-records.ts`
- 修改：`src/agent/completion-gate.ts` — run 入口前调用 batchIsVerified 跳过未修改文件的 typecheck
- 修改：`src/agent/loop-until-done-gate.ts`（Phase 62 Task 3） — 每轮调用 isVerified 复用上次结果
- 修改：`src/cli/app-init.ts` — 装配 VerificationRecords 单例
- 复用：[CCRCache](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/ccr-cache.ts) 的 createHash 模式

### 6.4 Step 分解

- [ ] **Step 1: 定义 VerificationRecord 与 VerificationRecordsConfig 类型**

新建 `src/agent/verification-records.ts`，实现上述接口。`enabled` 默认 false，`maxRecords` 默认 1000，`ttlMs` 默认 3600000（1 小时）。

- [ ] **Step 2: 实现 record**

key 格式：`${type}:${target}:${targetHash}`。LRU 淘汰：超过 maxRecords 时删除最早记录。

- [ ] **Step 3: 实现 isVerified**

查询 key 是否存在 + verifiedAt 是否在 ttlMs 内 + targetHash 是否匹配。三者都满足返回 true。

- [ ] **Step 4: 实现 batchIsVerified**

遍历文件列表，对每个文件调用 isVerified（type='typecheck'），返回 Map<filePath, boolean>。

- [ ] **Step 5: 实现 cleanup**

删除 verifiedAt 超过 ttlMs 的记录，返回清理数量。

- [ ] **Step 6: 接入 completion-gate**

在 [completion-gate.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/completion-gate.ts) 的 run 入口前，若 config 启用 verificationRecords，调用 `batchIsVerified(modifiedFiles)`，跳过已验证文件的 typecheck（仅跑未验证或内容已变的文件）。验证完成后调用 record 记录结果。

- [ ] **Step 7: 配置开关**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加：

```ts
verificationRecords: z.object({
  enabled: z.boolean().default(false),
  maxRecords: z.number().int().default(1000),
  ttlMs: z.number().int().default(3600000),
}).default({}),
```

- [ ] **Step 8: 配置收口（顶层 stateExternalization）**

在 [schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) 增加顶层 `stateExternalization` 字段，聚合 Task 1-6 的所有子配置：

```ts
stateExternalization: z.object({
  enabled: z.boolean().default(false), // 总开关
  curatedSet: z.object({
    enabled: z.boolean().default(false),
    autoPopulateCount: z.number().int().min(1).max(20).default(8),
    maxTokenBudget: z.number().int().default(8000),
    importanceTaggingEnabled: z.boolean().default(true),
    subtractiveCurationEnabled: z.boolean().default(true),
  }).default({}),
  kSentenceCompression: z.object({
    enabled: z.boolean().default(false),
    k: z.number().int().min(1).max(10).default(4),
    keywordWeight: z.number().min(0).max(1).default(0.5),
    lengthWeight: z.number().min(0).max(1).default(0.3),
    positionWeight: z.number().min(0).max(1).default(0.2),
  }).default({}),
  contentDedup: z.object({
    enabled: z.boolean().default(false),
    hashAlgorithm: z.enum(['sha256', 'md5']).default('sha256'),
    minLength: z.number().int().min(0).default(50),
    replaceWithReference: z.boolean().default(true),
  }).default({}),
  budgetAwareRendering: z.object({
    enabled: z.boolean().default(false),
    contextWindow: z.number().int().default(200000),
    softNotifyThreshold: z.number().min(0).max(1).default(0.5),
    triggerThreshold: z.number().min(0).max(1).default(0.8),
    forceThreshold: z.number().min(0).max(1).default(0.9),
    renderEveryTurn: z.boolean().default(true),
  }).default({}),
  verificationRecords: z.object({
    enabled: z.boolean().default(false),
    maxRecords: z.number().int().default(1000),
    ttlMs: z.number().int().default(3600000),
  }).default({}),
}).default({}),
```

- [ ] **Step 9: defaults.ts 同步**

在 [defaults.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/defaults.ts) 增加 stateExternalization 默认值，所有子开关默认 false。

- [ ] **Step 10: 设置页 UI**

在 desktop renderer 设置页新增"上下文状态外部化"分区：
- 总开关
- 子开关（CuratedSet / KSentenceCompression / ContentDedup / BudgetAwareRendering / VerificationRecords）
- 参数滑块（autoPopulateCount / k / contextWindow / maxRecords）
- "查看策展集"按钮（展示当前 CuratedSet 统计：totalChunks / byImportance）
- "查看验证记录"按钮（展示当前 VerificationRecords 统计）
- CuratedSet 子开关说明：开启后 agent 可用 prune_chunks / promote_chunk 工具

UI 风格遵循用户偏好（圆角、紫色调、lucide-react 图标）。

- [ ] **Step 11: 全量验证**

```powershell
pnpm typecheck
pnpm test
pnpm build:electron
```

预期：全绿，新增 ≥ 40 个测试通过。

- [ ] **Step 12: 文档同步**

更新 README.md 与 ARCHITECTURE.md，说明上下文状态外部化架构。在 CONTEXT_USAGE.md 增加 Harness-1 章节。

- [ ] **Step 13: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/verification-records.test.ts`，覆盖：
- record 记录验证结果
- isVerified 已验证且哈希匹配返回 true
- isVerified 哈希不匹配返回 false
- isVerified 超过 ttlMs 返回 false
- batchIsVerified 批量查询
- cleanup 清理过期记录
- LRU 淘汰（超过 maxRecords）
- 配置关闭时跳过

新建 `tests/config/state-externalization-schema.test.ts`，覆盖：
- stateExternalization 默认值正确
- 子开关独立启用
- curatedSet.autoPopulateCount 默认 8
- verificationRecords.ttlMs 默认 3600000

- [ ] **Step 14: 提交**

```powershell
git add -A
git commit -m "feat(phase-63): 验证记录 + 配置收口

新增 VerificationRecords，按文件粒度记录验证结果避免重复验证
配置收口：stateExternalization 总开关 + 5 个子开关 + 参数滑块
论文借鉴：Harness-1 VERIFY_TOOL + 六大数据结构完整落地
版本：v4.6.2"
```

---

## 风险与回滚

### 风险 1：CuratedSet 自动策展误判重要性标签
- **缓解**：estimateImportance 是启发式，误判时 agent 可用 promote_chunk 工具手动修正；importanceTaggingEnabled 可关闭
- **回滚**：关闭 `stateExternalization.curatedSet.enabled`，回退到 L1-L5 截断式压缩

### 风险 2：PruneChunksTool 误删 critical chunk
- **缓解**：critical chunk 移除需 force=true（默认 false）；agent 需在 reason 字段说明移除原因
- **回滚**：关闭 curatedSet.enabled，PruneChunksTool 不注册（工具列表无此工具）

### 风险 3：K-sentence 压缩丢失关键信息
- **缓解**：信息密度评分优先保留含关键词的句子；句数 <= k 时不压缩；system 消息不压缩
- **回滚**：关闭 `stateExternalization.kSentenceCompression.enabled`，L2 snipping 回退到完全删除

### 风险 4：CONTENT_DEDUP 误判不同语义内容为重复
- **缓解**：minLength 默认 50（短内容不去重）；replaceWithReference=true 保留引用标记（不直接删除）
- **回滚**：关闭 `stateExternalization.contentDedup.enabled`，L4 合并回退到按 role 去重

### 风险 5：预算感知渲染干扰 agent 决策
- **缓解**：预算标记仅追加到 system prompt 末尾，不修改原 prompt；renderEveryTurn 可关闭（仅首轮渲染）
- **回滚**：关闭 `stateExternalization.budgetAwareRendering.enabled`，回退到被动阈值触发

### 风险 6：VerificationRecords 缓存过期导致漏验证
- **缓解**：ttlMs 默认 1 小时；文件内容哈希变化时强制重新验证；提供"清除验证记录"按钮
- **回滚**：关闭 `stateExternalization.verificationRecords.enabled`，completion-gate 全量重跑

### 风险 7：策展集与 transcript 双重维护内存膨胀
- **缓解**：CuratedSet.maxTokenBudget 默认 8000；CCRCache.maxSize 默认 50；提供"立即清除"按钮
- **回滚**：关闭 stateExternalization 总开关，所有环境侧数据结构清空

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 40 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] 上下文状态外部化总开关默认关闭，设置页可开启
- [ ] CuratedSet 环境侧确定性维护（候选池自动填充 + 重要性标签 + 减法式策展）
- [ ] PruneChunksTool 与 PromoteChunkTool 工具可调用，critical chunk 移除需 force=true
- [ ] KSentenceCompressor L2 snipping 用 K-sentence 压缩替代完全截断
- [ ] ContentDeduplicator L4 合并按 SHA-256 内容哈希去重（跨 role）
- [ ] BudgetAwareRenderer 上下文插入预算标记，agent 感知剩余预算
- [ ] VerificationRecords 按文件粒度记录验证结果，未修改文件跳过重跑
- [ ] Policy 四问注入到 system prompt（CuratedSet 渲染时）
- [ ] 设置页"上下文状态外部化"分区可调，"查看策展集"/"查看验证记录"按钮可用
- [ ] fail-open：所有数据结构异常时降级为现有 L1-L5 行为，不阻塞主流程
- [ ] README.md、ARCHITECTURE.md、CONTEXT_USAGE.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过，新增 export 均有消费方
- [ ] 配置字段自审：新增的每个 zod schema 字段有读取方
- [ ] 执行人自审报告已附在每个 Task 的提交信息中
