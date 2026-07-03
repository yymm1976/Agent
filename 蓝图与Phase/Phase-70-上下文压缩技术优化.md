# Phase 70 — 上下文压缩技术深度优化

> **版本目标：** v4.7.1
> **前置依赖：** Phase 68 完成
> **后继依赖：** 无（本 Phase 是上下文管理层优化，可与 Phase 69 并行）
> **新增测试要求：** ≥ 30 个
> **研究依据：** 深度源码分析 Claude Code 泄露源码（[alex000kim/claude-code](https://github.com/alex000kim/claude-code/tree/main/src)），聚焦 `src/services/compact/` 目录下的 11 个核心模块：`compact.ts`（1705 行）、`autoCompact.ts`（351 行）、`prompt.ts`（374 行）、`microCompact.ts`、`apiMicrocompact.ts`、`sessionMemoryCompact.ts`、`compactWarningHook.ts`、`compactWarningState.ts`、`postCompactCleanup.ts`、`grouping.ts`、`timeBasedMCConfig.ts`。Claude Code 的上下文压缩是**五阶段渐进管道**：（1）工具输出预算裁剪 → （2）局部信息修剪 → （3）微压缩清理 → （4）局部上下文折叠 → （5）全局红线自动压缩。核心设计哲学：**先剔除冗余片段 → 算账报警 → 尝试智能记忆归档 → 暴力总结（最后手段）**。
> **核心命题：** RouteDev 已有 [context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts)（五阶段 L1-L5）和 [context-manager.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/context-manager.ts)（checkpoint + 压缩），但与 Claude Code 的实现相比有三个关键差距：（1）**工具输出预算管理粗糙**——L1 只做简单截断，Claude Code 的 `applyToolResultBudget` 将大内容本地保存 + 原文替换为短摘要，保留了"可回溯性"；（2）**压缩提示词质量低**——L5 摘要没有精心设计的提示词，Claude Code 的 `prompt.ts` 有 374 行专门的压缩提示词，含 NO_TOOLS_PREAMBLE + 9 段结构化摘要模板 + analysis 草稿区；（3）**缺乏自动化压缩守护进程**——RouteDev 的压缩是手动触发或简单阈值触发，Claude Code 的 `autoCompact.ts` 有完整的 Token 预算计算、警告阈值、错误阈值、熔断机制（连续失败 3 次停止重试）。Phase 70 将这三个差距逐一补齐。**让压缩从"粗暴截断"升级为"智能管道"。**

---

## 项目现状审计与可行性结论

### 1. Claude Code 与 RouteDev 压缩实现的逐模块对比

| Claude Code 模块 | 核心实现 | RouteDev 现状缺口 | Phase 70 Task |
|---|---|---|---|
| `applyToolResultBudget`（src/utils/toolResultStorage.ts） | 大内容本地保存 + 短预览替换；按历史状态分 mustReapply/frozen/fresh 三类 | L1 只做简单截断（500首+500尾），无本地保存，无历史状态分类 | Task 1（工具输出预算管理升级） |
| `snipCompactIfNeeded`（src/services/compact/snipCompact.ts） | 保留最近 N 条 + 所有 system 消息，删除中间；计算释放的 token 数 | L2 已实现类似逻辑，但未计算释放的 token 数 | 已有，小幅改进 |
| `microCompact` / `apiMicrocompact` | 清理旧的工具输出内容（grep/cat 等），替换为 `[Old tool result content cleared]` | L3 只删除空消息，不清理旧工具输出 | Task 2（微压缩升级） |
| `contextCollapse`（src/services/contextCollapse/index.js） | 局部对话折叠：识别冗长动作链，生成局部摘要，不修改原始消息 | L4 只合并连续同 role 消息，不识别动作链 | Task 3（上下文折叠升级） |
| `autoCompact.ts` | Token 预算计算（有效窗口 = 上下文窗口 - 预留输出 token）；三级阈值（警告/错误/自动压缩）；熔断机制（连续失败 3 次停止） | 简单阈值触发（80%），无预算计算，无熔断 | Task 4（自动压缩守护进程） |
| `prompt.ts`（374 行） | NO_TOOLS_PREAMBLE + 9 段结构化摘要模板 + analysis 草稿区 + 三种方向（base/partial/up_to） | 无专用压缩提示词 | Task 5（压缩提示词引擎） |
| `sessionMemoryCompact.ts` | 将旧状态压缩到长期记忆中（Session Memory 模式） | 有知识图谱但无"会话记忆"模式 | Task 6（会话记忆压缩） |
| `compactWarningHook.ts` / `compactWarningState.ts` | Token 报警状态管理，决定何时给用户弹警告 | 无用户警告机制 | Task 4 子任务 |
| `postCompactCleanup.ts` | 压缩后清理：重置旧消息 ID、清理缓存树 | 无压缩后清理 | Task 4 子任务 |
| `grouping.ts` | 消息队列按 API 回合分类聚合，防止压缩时割裂 user-assistant 对偶 | 无消息分组保护 | Task 2 子任务 |
| `timeBasedMCConfig.ts` | 基于时间的评估配置 | 无 | 不在本 Phase 范围 |

### 2. 可行性总评

- **Task 1（工具输出预算管理升级）：** 高度可行。RouteDev 已有 L1 截断逻辑，只需升级为"本地保存 + 短预览替换"模式。文件 I/O 已有 `fs/promises` 依赖。
- **Task 2（微压缩升级）：** 可行。RouteDev 的 L3 只需扩展为"清理旧工具输出"。`grouping.ts` 的消息分组保护可复用现有消息遍历逻辑。
- **Task 3（上下文折叠升级）：** 中等可行。需实现"动作链识别"——工程上降维为"连续 tool_use/tool_result 对偶序列"检测。
- **Task 4（自动压缩守护进程）：** 高度可行。RouteDev 已有阈值触发逻辑，只需升级为三级阈值 + 熔断机制。
- **Task 5（压缩提示词引擎）：** 高度可行。纯字符串模板，无复杂逻辑。
- **Task 6（会话记忆压缩）：** 可行。RouteDev 已有知识图谱，只需增加"会话记忆"存储模式。

### 3. 降维原则（Claude Code 源码 → 工程概念）

Claude Code 是完整的生产级实现，**不能照搬其全部复杂度**。本 Phase 的降维映射：

| Claude Code 概念 | 工程降维实现 |
|---|---|
| applyToolResultBudget + 本地保存 | `ToolOutputBudgetManager`：大内容写入 `.routedev/offloaded/` + 短预览替换 |
| mustReapply/frozen/fresh 三类 | 简化为"已处理/未处理"二元状态 |
| contextCollapse 动作链识别 | `ActionChainDetector`：连续 tool_use/tool_result 对偶序列检测 |
| autoCompact 三级阈值 | `AutoCompactGuardian`：警告/错误/自动压缩三级 + 熔断 |
| prompt.ts 374 行模板 | `CompactPromptEngine`：三种方向模板 + analysis 草稿区 |
| sessionMemoryCompact | `SessionMemoryStore`：会话级长期记忆（复用知识图谱） |
| postCompactCleanup | `PostCompactCleanup`：压缩后 ID 重置 + 缓存清理 |

---

## 核心设计原则

### 原则 1：可回溯性优先于简单截断

Claude Code 的核心洞察——大工具输出不是"丢弃"而是"本地保存 + 短预览替换"。用户需要时可以回溯查看原始内容。Phase 70 的 L1 阶段**必须**保留原始内容到本地文件，不能简单截断。

### 原则 2：压缩提示词决定摘要质量

Claude Code 的 `prompt.ts` 有 374 行专门设计的压缩提示词，含 NO_TOOLS_PREAMBLE（防止 LLM 调用工具浪费 turn）+ 9 段结构化摘要模板（Primary Request / Key Technical Concepts / Files and Code Sections / Errors and fixes / Problem Solving / All user messages / Pending Tasks / Current Work / Optional Next Step）+ analysis 草稿区（让 LLM 先思考再输出）。Phase 70 的 L5 阶段**必须**使用精心设计的提示词，不能用简单的"请总结这段对话"。

### 原则 3：压缩是渐进管道，不是单点操作

Claude Code 的五阶段设计——每阶段后检查是否达到目标，达到则停止。Phase 70 **必须**保持渐进管道架构，每阶段独立、可配置、可跳过。

### 原则 4：熔断机制防止无限重试

Claude Code 的 `autoCompact.ts` 有熔断机制——连续失败 3 次后停止重试。Without this, sessions where context is irrecoverably over the limit hammer the API with doomed compaction attempts on every turn. Phase 70 **必须**实现熔断。

### 原则 5：反写死与 Fail-open（延续 Phase 51/61）

所有新增能力必须有配置开关。压缩失败时降级为简单截断（fail-open），不阻塞主流程。

### 原则 6：死代码防护与执行人自审（延续 Phase 53/68）

**死代码零容忍**：本 Phase 新增的每个类、函数、配置字段必须有明确的消费方。

---

## Task 1：工具输出预算管理升级（≥ 6 测试）

### 1.1 Claude Code 借鉴

**Claude Code 实现**（`src/utils/toolResultStorage.ts`）：
- 核心函数：`enforceToolResultBudget`
- 工作流程：
  1. 采集待处理工具结果（按消息分组）
  2. 读取配置与过滤规则（跳过 Read 工具）
  3. 按历史状态分三类：mustReapply（之前已截断）/ frozen（之前处理过但没超限）/ fresh（本轮新出现）
  4. 重新应用历史替换（保证缓存不炸）
  5. 对新内容算总大小
  6. 筛选超长内容去落盘（存到 `session123/tool-results/abc.txt`）
  7. 生成短预览（`<persisted-output>太大了，存到xxx，预览前2000字...</persisted-output>`）
  8. 替换并返回结果

RouteDev 现状：[context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 的 `stage1TrimToolOutputs` 只做简单截断（500首+500尾+[...截断...]标记），无本地保存，无历史状态分类。

### 1.2 设计

新增 `ToolOutputBudgetManager` 类：

```ts
// src/agent/memory/tool-output-budget.ts
// Phase 70 Task 1：工具输出预算管理升级
// 借鉴：Claude Code applyToolResultBudget + 本地保存 + 短预览替换

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';

export interface ToolOutputBudgetConfig {
  /** 单条工具输出最大字符数（超过则落盘） */
  maxCharsPerOutput: number;
  /** 短预览长度（首部） */
  previewHeadChars: number;
  /** 短预览长度（尾部） */
  previewTailChars: number;
  /** 落盘目录 */
  offloadDir: string;
  /** 是否启用（默认 false） */
  enabled: boolean;
}

export const DEFAULT_BUDGET_CONFIG: ToolOutputBudgetConfig = {
  maxCharsPerOutput: 2000,
  previewHeadChars: 500,
  previewTailChars: 500,
  offloadDir: '.routedev/offloaded',
  enabled: false,
};

interface OffloadRecord {
  /** 原始内容的哈希（用于去重） */
  hash: string;
  /** 落盘文件路径 */
  filePath: string;
  /** 短预览 */
  preview: string;
  /** 原始大小 */
  originalSize: number;
}

export class ToolOutputBudgetManager {
  /** 已处理的内容哈希 → 落盘记录（历史状态） */
  private processedHashes = new Map<string, OffloadRecord>();

  constructor(private config: ToolOutputBudgetConfig) {}

  /**
   * 处理消息列表中的工具输出
   * 超过 maxCharsPerOutput 的工具输出：落盘 + 替换为短预览
   * 未超过的保持不变
   */
  async processMessages<T extends { content: string | unknown[] }>(
    messages: T[],
    extractText: (msg: T) => string,
    replaceText: (msg: T, newText: string) => T,
  ): Promise<{ messages: T[]; offloadedCount: number }> {
    if (!this.config.enabled) return { messages, offloadedCount: 0 };

    let offloadedCount = 0;
    const result = [...messages];

    for (let i = 0; i < result.length; i++) {
      const msg = result[i];
      const text = extractText(msg);

      if (text.length <= this.config.maxCharsPerOutput) continue;

      const hash = this.simpleHash(text);

      // 已处理过：复用历史记录（保证缓存不炸）
      const existing = this.processedHashes.get(hash);
      if (existing) {
        result[i] = replaceText(msg, existing.preview);
        continue;
      }

      // 新内容：落盘 + 生成短预览
      try {
        const filePath = await this.offloadToFile(text, i);
        const preview = this.buildPreview(text, filePath);
        const record: OffloadRecord = { hash, filePath, preview, originalSize: text.length };
        this.processedHashes.set(hash, record);
        result[i] = replaceText(msg, preview);
        offloadedCount++;
      } catch (err) {
        // 落盘失败：降级为简单截断
        logger.warn('ToolOutputBudgetManager: 落盘失败，降级为截断', {
          index: i,
          error: err instanceof Error ? err.message : String(err),
        });
        const truncated =
          text.slice(0, this.config.previewHeadChars) +
          '[...截断...]' +
          text.slice(-this.config.previewTailChars);
        result[i] = replaceText(msg, truncated);
        offloadedCount++;
      }
    }

    return { messages: result, offloadedCount };
  }

  /**
   * 获取原始内容（回溯查看）
   */
  async getOriginal(filePath: string): Promise<string | null> {
    try {
      const { readFile } = await import('node:fs/promises');
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ===== 内部辅助 =====

  private async offloadToFile(content: string, index: number): Promise<string> {
    await mkdir(this.config.offloadDir, { recursive: true });
    const filename = `output-${index}-${Date.now()}.txt`;
    const filePath = join(this.config.offloadDir, filename);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  private buildPreview(content: string, filePath: string): string {
    const head = content.slice(0, this.config.previewHeadChars);
    const tail = content.slice(-this.config.previewTailChars);
    return `<persisted-output file="${filePath}" size="${content.length}">\n${head}\n[...已保存到本地，共 ${content.length} 字符...]\n${tail}\n</persisted-output>`;
  }

  private simpleHash(text: string): string {
    let hash = 0;
    for (let i = 0; i < Math.min(text.length, 1000); i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }
}
```

### 1.3 接线点

- 新增：`src/agent/memory/tool-output-budget.ts`
- 修改：[context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) — L1 阶段使用 `ToolOutputBudgetManager` 替代简单截断
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `toolOutputBudget` 配置

### 1.4 Step 分解

- [ ] **Step 1: 定义 ToolOutputBudgetConfig / OffloadRecord 类型**

新建 `src/agent/memory/tool-output-budget.ts`，实现上述类型。

- [ ] **Step 2: 实现 ToolOutputBudgetManager.processMessages**

核心逻辑：遍历消息 → 超长工具输出落盘 → 替换为短预览 → 记录哈希（去重）。

- [ ] **Step 3: 实现历史状态复用**

`processedHashes` Map 存储已处理的内容哈希。相同内容直接复用历史记录，不重复落盘。

- [ ] **Step 4: 实现 getOriginal 回溯**

用户需要时可读取落盘文件查看原始内容。

- [ ] **Step 5: 接入 context-compaction.ts L1 阶段**

在 `stage1TrimToolOutputs` 中使用 `ToolOutputBudgetManager` 替代简单截断。配置关闭时退回原截断逻辑。

- [ ] **Step 6: 配置开关**

```ts
toolOutputBudget: z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(false),
  maxCharsPerOutput: z.number().int().min(500).default(2000),
  previewHeadChars: z.number().int().min(100).default(500),
  previewTailChars: z.number().int().min(100).default(500),
  offloadDir: z.string().default('.routedev/offloaded'),
})).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/memory/tool-output-budget.test.ts`，覆盖：
- 超长输出落盘 + 短预览替换
- 未超长输出保持不变
- 历史哈希复用（相同内容不重复落盘）
- 落盘失败时降级为截断
- getOriginal 回溯读取
- 配置关闭时跳过

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-70): 工具输出预算管理升级

新增 ToolOutputBudgetManager，大内容落盘 + 短预览替换 + 历史哈希复用
借鉴：Claude Code applyToolResultBudget 本地保存模式
fail-open：落盘失败时降级为简单截断"
```

---

## Task 2：微压缩升级 + 消息分组保护（≥ 5 测试）

### 2.1 Claude Code 借鉴

**Claude Code 实现**：
- `microCompact.ts`：清理旧的工具输出内容（grep/cat 等），替换为 `[Old tool result content cleared]`。基于"冷热缓存"与"时间阈值"决策。
- `grouping.ts`：消息队列按 API 回合（Round）分类聚合，防止压缩时割裂 user-assistant 对偶。

RouteDev 现状：[context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 的 L3 只删除空消息，不清理旧工具输出。无消息分组保护。

### 2.2 设计

升级 L3 阶段 + 新增 `MessageGrouper`：

```ts
// src/agent/memory/message-grouper.ts
// Phase 70 Task 2：消息分组保护
// 借鉴：Claude Code grouping.ts — 防止压缩时割裂 user-assistant 对偶

import type { LLMMessage } from '../../router/types.js';

export interface MessageGroup {
  /** 组内消息 */
  messages: LLMMessage[];
  /** 组起始索引 */
  startIndex: number;
  /** 组结束索引（不含） */
  endIndex: number;
  /** 是否为完整的 user-assistant 对偶 */
  isCompleteRound: boolean;
}

export class MessageGrouper {
  /**
   * 将消息列表按 API 回合分组
   * 每组 = 一个 user 消息 + 紧随其后的 assistant 消息 + 工具结果
   * 保证压缩时不会割裂一个完整的对话回合
   */
  groupByRounds(messages: LLMMessage[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    let currentStart = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // user 消息（非 system）开始新组
      if (msg.role === 'user' && i > currentStart) {
        groups.push({
          messages: messages.slice(currentStart, i),
          startIndex: currentStart,
          endIndex: i,
          isCompleteRound: this.isCompleteRound(messages.slice(currentStart, i)),
        });
        currentStart = i;
      }
    }

    // 最后一组
    if (currentStart < messages.length) {
      groups.push({
        messages: messages.slice(currentStart),
        startIndex: currentStart,
        endIndex: messages.length,
        isCompleteRound: this.isCompleteRound(messages.slice(currentStart)),
      });
    }

    return groups;
  }

  /**
   * 标记哪些组可以被压缩（非当前回合的旧组）
   */
  markCompressible(groups: MessageGroup[], keepRecentRounds: number): boolean[] {
    const compressible = groups.map((_, i) => i < groups.length - keepRecentRounds);
    return compressible;
  }

  private isCompleteRound(messages: LLMMessage[]): boolean {
    const hasUser = messages.some((m) => m.role === 'user');
    const hasAssistant = messages.some((m) => m.role === 'assistant');
    return hasUser && hasAssistant;
  }
}
```

### 2.3 接线点

- 新增：`src/agent/memory/message-grouper.ts`
- 修改：[context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) — L3 升级为清理旧工具输出；L2 使用 MessageGrouper 保护回合完整性
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `microCompact` 配置

### 2.4 Step 分解

- [ ] **Step 1: 实现 MessageGrouper**

新建 `src/agent/memory/message-grouper.ts`，实现 `groupByRounds` / `markCompressible`。

- [ ] **Step 2: 升级 L3 微压缩**

在 `stage3MicroCompact` 中增加"清理旧工具输出"逻辑：
- 遍历消息，找到 tool_result 类型的内容
- 超过一定轮次前的 tool_result 替换为 `[Old tool result content cleared]`
- 保留最近 N 轮的工具输出完整

- [ ] **Step 3: 接入 L2 消息分组保护**

在 `stage2SnipOldMessages` 中使用 `MessageGrouper.groupByRounds`，确保不会割裂完整的 user-assistant 对偶。

- [ ] **Step 4: 配置开关**

```ts
microCompact: z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(false),
  /** 清理多少轮之前的工具输出 */
  cleanBeforeRounds: z.number().int().min(1).default(5),
  /** 保留最近多少个完整回合 */
  keepRecentRounds: z.number().int().min(1).default(3),
})).default({}),
```

- [ ] **Step 5: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/memory/message-grouper.test.ts`，覆盖：
- groupByRounds 正确分组
- 完整回合检测（user+assistant）
- markCompressible 标记可压缩组
- L3 清理旧工具输出
- L2 不割裂 user-assistant 对偶

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat(phase-70): 微压缩升级 + 消息分组保护

升级 L3 为清理旧工具输出，新增 MessageGrouper 防止割裂 user-assistant 对偶
借鉴：Claude Code microCompact 冷热缓存 + grouping.ts 回合保护"
```

---

## Task 3：上下文折叠升级（≥ 4 测试）

### 3.1 Claude Code 借鉴

**Claude Code 实现**（`src/services/contextCollapse/index.js`）：
- 自动扫描历史对话，找到冗长、重复、只为完成一个小目标的对话段（例如连续5次调试只为改一个拼写错误）
- 将一长串消息"折叠"成一句精简摘要
- 不修改原始消息，维护折叠中心（Collapse store）+ 提交日志（Commit log）

RouteDev 现状：[context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 的 L4 只合并连续同 role 消息 + 去重工具结果，不识别动作链。

### 3.2 设计

新增 `ActionChainDetector` 类：

```ts
// src/agent/memory/action-chain-detector.ts
// Phase 70 Task 3：上下文折叠升级 — 动作链识别
// 借鉴：Claude Code contextCollapse — 识别冗长动作链，生成局部摘要

import type { LLMMessage } from '../../router/types.js';

export interface ActionChain {
  /** 动作链起始索引 */
  startIndex: number;
  /** 动作链结束索引（不含） */
  endIndex: number;
  /** 动作链类型 */
  chainType: 'debug-loop' | 'repeated-tool' | 'exploration';
  /** 动作链摘要（人类可读） */
  summary: string;
  /** 消息数 */
  messageCount: number;
}

export class ActionChainDetector {
  /**
   * 检测消息列表中的动作链
   * 动作链 = 连续的 tool_use/tool_result 对偶序列，目标单一
   */
  detect(messages: LLMMessage[]): ActionChain[] {
    const chains: ActionChain[] = [];
    let chainStart = -1;
    let toolCallCount = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isToolMessage = this.isToolMessage(msg);

      if (isToolMessage) {
        if (chainStart === -1) chainStart = i;
        toolCallCount++;
      } else {
        // 非工具消息：检查是否形成了动作链
        if (chainStart !== -1 && toolCallCount >= 3) {
          chains.push({
            startIndex: chainStart,
            endIndex: i,
            chainType: this.classifyChain(messages.slice(chainStart, i)),
            summary: this.buildChainSummary(messages.slice(chainStart, i)),
            messageCount: i - chainStart,
          });
        }
        chainStart = -1;
        toolCallCount = 0;
      }
    }

    // 处理末尾的动作链
    if (chainStart !== -1 && toolCallCount >= 3) {
      chains.push({
        startIndex: chainStart,
        endIndex: messages.length,
        chainType: this.classifyChain(messages.slice(chainStart)),
        summary: this.buildChainSummary(messages.slice(chainStart)),
        messageCount: messages.length - chainStart,
      });
    }

    return chains;
  }

  /**
   * 折叠动作链为摘要消息
   */
  collapseChain(chain: ActionChain, messages: LLMMessage[]): LLMMessage {
    return {
      role: 'system',
      content: `[已折叠] ${chain.summary}（${chain.messageCount} 条消息，类型: ${chain.chainType}）`,
    };
  }

  // ===== 内部辅助 =====

  private isToolMessage(msg: LLMMessage): boolean {
    if (typeof msg.content === 'string') return false;
    if (Array.isArray(msg.content)) {
      return msg.content.some(
        (part) => part.type === 'tool_use' || part.type === 'tool_result',
      );
    }
    return false;
  }

  private classifyChain(messages: LLMMessage[]): ActionChain['chainType'] {
    // 简单启发式：连续相同工具调用 → repeated-tool
    // 后续可升级为 LLM 分类
    return 'repeated-tool';
  }

  private buildChainSummary(messages: LLMMessage[]): string {
    const toolNames = new Set<string>();
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_use') toolNames.add(part.name);
        }
      }
    }
    return `使用工具 [${[...toolNames].join(', ')}] 执行了 ${messages.length} 步操作`;
  }
}
```

### 3.3 接线点

- 新增：`src/agent/memory/action-chain-detector.ts`
- 修改：[context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) — L4 阶段使用 `ActionChainDetector` 检测并折叠动作链

### 3.4 Step 分解

- [ ] **Step 1: 实现 ActionChainDetector**

新建 `src/agent/memory/action-chain-detector.ts`，实现 `detect` / `collapseChain`。

- [ ] **Step 2: 接入 L4 阶段**

在 `stage4Collapse` 中，先调用 `ActionChainDetector.detect`，对检测到的动作链调用 `collapseChain` 替换。

- [ ] **Step 3: 配置开关**

```ts
contextCollapse: z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(false),
  /** 触发折叠的最小工具调用数 */
  minToolCallsForChain: z.number().int().min(2).default(3),
})).default({}),
```

- [ ] **Step 4: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/memory/action-chain-detector.test.ts`，覆盖：
- 检测连续工具调用动作链
- 折叠动作链为摘要消息
- 不折叠短序列（< minToolCallsForChain）
- 配置关闭时跳过

- [ ] **Step 5: 提交**

```powershell
git add -A
git commit -m "feat(phase-70): 上下文折叠升级

新增 ActionChainDetector，识别冗长动作链并折叠为摘要
借鉴：Claude Code contextCollapse 动作链识别"
```

---

## Task 4：自动压缩守护进程（≥ 7 测试）

### 4.1 Claude Code 借鉴

**Claude Code 实现**（`src/services/compact/autoCompact.ts`，351 行）：
- **有效窗口计算**：`effectiveContextWindow = contextWindow - reservedTokensForSummary`（预留 20000 token 给摘要输出）
- **三级阈值**：
  - 警告阈值：`effectiveWindow - 20000`
  - 错误阈值：`effectiveWindow - 20000`
  - 自动压缩阈值：`effectiveWindow - 13000`
- **熔断机制**：`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`，连续失败 3 次后停止重试
- **Token 使用率计算**：`calculateTokenWarningState` 返回 `percentLeft / isAboveWarningThreshold / isAboveErrorThreshold / isAboveAutoCompactThreshold / isAtBlockingLimit`
- **Session Memory 优先**：先尝试 `trySessionMemoryCompaction`，失败才用 `compactConversation`

RouteDev 现状：[context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) 只有简单阈值触发（80%），无预算计算，无熔断。[context-manager.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/context-manager.ts) 有 `shouldCompress` 但逻辑简单。

### 4.2 设计

新增 `AutoCompactGuardian` 类：

```ts
// src/agent/memory/auto-compact-guardian.ts
// Phase 70 Task 4：自动压缩守护进程
// 借鉴：Claude Code autoCompact.ts — 三级阈值 + 熔断 + Session Memory 优先

import { estimateTokens } from '../../utils/token-estimate.js';
import { logger } from '../../utils/logger.js';

export interface AutoCompactConfig {
  /** 是否启用自动压缩（默认 false） */
  enabled: boolean;
  /** 上下文窗口大小（token） */
  contextWindow: number;
  /** 预留给摘要输出的 token 数 */
  reservedTokensForSummary: number;
  /** 自动压缩阈值（有效窗口 - 此值） */
  autoCompactBuffer: number;
  /** 警告阈值缓冲 */
  warningBuffer: number;
  /** 错误阈值缓冲 */
  errorBuffer: number;
  /** 最大连续失败次数（熔断） */
  maxConsecutiveFailures: number;
}

export const DEFAULT_GUARDIAN_CONFIG: AutoCompactConfig = {
  enabled: false,
  contextWindow: 200000,
  reservedTokensForSummary: 20000,
  autoCompactBuffer: 13000,
  warningBuffer: 20000,
  errorBuffer: 20000,
  maxConsecutiveFailures: 3,
};

export type CompactAction = 'none' | 'warn' | 'compact' | 'force' | 'blocked';

export interface TokenState {
  /** 当前 token 使用量 */
  currentTokens: number;
  /** 有效上下文窗口（减去预留） */
  effectiveWindow: number;
  /** 剩余百分比 */
  percentLeft: number;
  /** 是否超过警告阈值 */
  isAboveWarning: boolean;
  /** 是否超过错误阈值 */
  isAboveError: boolean;
  /** 是否超过自动压缩阈值 */
  isAboveAutoCompact: boolean;
  /** 是否达到阻塞限制 */
  isAtBlockingLimit: boolean;
  /** 建议动作 */
  suggestedAction: CompactAction;
}

export class AutoCompactGuardian {
  /** 连续失败计数（熔断） */
  private consecutiveFailures = 0;
  /** 上次压缩时间 */
  private lastCompactTime = 0;

  constructor(private config: AutoCompactConfig) {}

  /**
   * 计算当前 Token 状态
   */
  calculateTokenState(messages: unknown[], estimateFn: (msgs: unknown[]) => number): TokenState {
    const currentTokens = estimateFn(messages);
    const effectiveWindow = this.config.contextWindow - this.config.reservedTokensForSummary;
    const percentLeft = Math.max(0, Math.round(((effectiveWindow - currentTokens) / effectiveWindow) * 100));

    const autoCompactThreshold = effectiveWindow - this.config.autoCompactBuffer;
    const warningThreshold = effectiveWindow - this.config.warningBuffer;
    const errorThreshold = effectiveWindow - this.config.errorBuffer;
    const blockingLimit = effectiveWindow - 3000;

    const isAboveWarning = currentTokens >= warningThreshold;
    const isAboveError = currentTokens >= errorThreshold;
    const isAboveAutoCompact = currentTokens >= autoCompactThreshold;
    const isAtBlockingLimit = currentTokens >= blockingLimit;

    let suggestedAction: CompactAction = 'none';
    if (isAtBlockingLimit) suggestedAction = 'force';
    else if (isAboveAutoCompact) suggestedAction = 'compact';
    else if (isAboveError) suggestedAction = 'warn';
    else if (isAboveWarning) suggestedAction = 'warn';

    // 熔断：连续失败超过阈值，阻止压缩
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      if (suggestedAction === 'compact' || suggestedAction === 'force') {
        logger.warn('AutoCompactGuardian: 熔断触发，停止自动压缩', {
          consecutiveFailures: this.consecutiveFailures,
        });
        suggestedAction = 'blocked';
      }
    }

    return {
      currentTokens,
      effectiveWindow,
      percentLeft,
      isAboveWarning,
      isAboveError,
      isAboveAutoCompact,
      isAtBlockingLimit,
      suggestedAction,
    };
  }

  /**
   * 记录压缩成功（重置熔断计数）
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastCompactTime = Date.now();
  }

  /**
   * 记录压缩失败（增加熔断计数）
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    logger.warn('AutoCompactGuardian: 压缩失败', {
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.config.maxConsecutiveFailures,
    });
  }

  /**
   * 获取当前熔断状态
   */
  isCircuitBroken(): boolean {
    return this.consecutiveFailures >= this.config.maxConsecutiveFailures;
  }

  /**
   * 重置熔断（手动恢复）
   */
  resetCircuit(): void {
    this.consecutiveFailures = 0;
  }
}
```

### 4.3 接线点

- 新增：`src/agent/memory/auto-compact-guardian.ts`
- 修改：[context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) — 使用 `AutoCompactGuardian` 替代简单阈值触发
- 修改：[context-manager.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/context-manager.ts) — `shouldCompress` 使用 Guardian 的 TokenState
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `autoCompactGuardian` 配置

### 4.4 Step 分解

- [ ] **Step 1: 定义 AutoCompactConfig / TokenState 类型**

新建 `src/agent/memory/auto-compact-guardian.ts`，实现上述类型。

- [ ] **Step 2: 实现 calculateTokenState**

三级阈值计算 + 熔断检查。复用 [token-estimate.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/utils/token-estimate.ts)。

- [ ] **Step 3: 实现熔断机制**

`recordSuccess` / `recordFailure` / `isCircuitBroken` / `resetCircuit`。连续失败 3 次后 `suggestedAction = 'blocked'`。

- [ ] **Step 4: 接入 context-compaction.ts**

在 `compact` 方法开头使用 `calculateTokenState` 替代简单阈值检查。压缩成功/失败后调用 `recordSuccess` / `recordFailure`。

- [ ] **Step 5: 接入 context-manager.ts**

`shouldCompress` 使用 Guardian 的 TokenState 判断。

- [ ] **Step 6: 配置开关**

```ts
autoCompactGuardian: z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(false),
  contextWindow: z.number().int().min(10000).default(200000),
  reservedTokensForSummary: z.number().int().min(1000).default(20000),
  autoCompactBuffer: z.number().int().min(1000).default(13000),
  warningBuffer: z.number().int().min(1000).default(20000),
  errorBuffer: z.number().int().min(1000).default(20000),
  maxConsecutiveFailures: z.number().int().min(1).default(3),
})).default({}),
```

- [ ] **Step 7: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/memory/auto-compact-guardian.test.ts`，覆盖：
- 低于阈值 → none
- 超过警告阈值 → warn
- 超过自动压缩阈值 → compact
- 达到阻塞限制 → force
- 连续失败 3 次 → blocked（熔断）
- recordSuccess 重置熔断
- resetCircuit 手动恢复
- 配置关闭时跳过

- [ ] **Step 8: 提交**

```powershell
git add -A
git commit -m "feat(phase-70): 自动压缩守护进程

新增 AutoCompactGuardian，三级阈值 + 熔断机制 + Token 状态计算
借鉴：Claude Code autoCompact.ts 预算计算 + 连续失败熔断
熔断：连续失败 3 次后停止自动压缩，防止无限重试"
```

---

## Task 5：压缩提示词引擎（≥ 5 测试）

### 5.1 Claude Code 借鉴

**Claude Code 实现**（`src/services/compact/prompt.ts`，374 行）：
- **NO_TOOLS_PREAMBLE**：`CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.` — 防止 LLM 调用工具浪费 turn
- **三种方向模板**：
  - `BASE_COMPACT_PROMPT`：全量摘要（9 段结构化模板）
  - `PARTIAL_COMPACT_PROMPT`：部分摘要（只摘要最近消息）
  - `PARTIAL_COMPACT_UP_TO_PROMPT`：前缀摘要（只摘要到某条消息）
- **9 段结构化摘要模板**：
  1. Primary Request and Intent
  2. Key Technical Concepts
  3. Files and Code Sections
  4. Errors and fixes
  5. Problem Solving
  6. All user messages
  7. Pending Tasks
  8. Current Work
  9. Optional Next Step
- **analysis 草稿区**：`<analysis>` 标签让 LLM 先思考再输出，`formatCompactSummary` 函数在输出前剥离 analysis
- **NO_TOOLS_TRAILER**：`REMINDER: Do NOT call any tools.` — 双重保险

RouteDev 现状：L5 阶段使用简单的 `summarize` 函数，无专用提示词。

### 5.2 设计

新增 `CompactPromptEngine` 类：

```ts
// src/agent/memory/compact-prompt-engine.ts
// Phase 70 Task 5：压缩提示词引擎
// 借鉴：Claude Code prompt.ts — NO_TOOLS_PREAMBLE + 9段结构化模板 + analysis 草稿区

export type CompactDirection = 'base' | 'partial' | 'up_to';

export class CompactPromptEngine {
  /**
   * 获取压缩提示词
   * @param direction 摘要方向
   * @param customInstructions 自定义指令（可选）
   */
  getPrompt(direction: CompactDirection, customInstructions?: string): string {
    const preamble = this.getNoToolsPreamble();
    const template = this.getTemplate(direction);
    const trailer = this.getNoToolsTrailer();

    let prompt = preamble + template;
    if (customInstructions?.trim()) {
      prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
    }
    prompt += trailer;
    return prompt;
  }

  /**
   * 格式化压缩摘要（剥离 analysis 草稿区）
   */
  formatSummary(rawSummary: string): string {
    let formatted = rawSummary;
    // 剥离 analysis 草稿区
    formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
    // 提取 summary 内容
    const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
    if (summaryMatch) {
      const content = summaryMatch[1] || '';
      formatted = formatted.replace(
        /<summary>[\s\S]*?<\/summary>/,
        `Summary:\n${content.trim()}`,
      );
    }
    // 清理多余空行
    formatted = formatted.replace(/\n\n+/g, '\n\n');
    return formatted.trim();
  }

  // ===== 内部辅助 =====

  private getNoToolsPreamble(): string {
    return `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;
  }

  private getNoToolsTrailer(): string {
    return `

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`;
  }

  private getTemplate(direction: CompactDirection): string {
    switch (direction) {
      case 'base':
        return this.getBaseTemplate();
      case 'partial':
        return this.getPartialTemplate();
      case 'up_to':
        return this.getUpToTemplate();
    }
  }

  private getBaseTemplate(): string {
    return `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis process:
1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
  - The user's explicit requests and intents
  - Your approach to addressing the user's requests
  - Key decisions, technical concepts and code patterns
  - Specific details like file names, code snippets, function signatures, file edits
  - Errors that you ran into and how you fixed them
  - Pay special attention to specific user feedback
2. Double-check for technical accuracy and completeness.

Your summary should include the following sections:
1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created.
4. Errors and fixes: List all errors that you ran into, and how you fixed them.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step that you will take that is related to the most recent work.

<example>
<analysis>[Your thought process]</analysis>
<summary>
1. Primary Request and Intent: [Detailed description]
2. Key Technical Concepts: [Concepts]
3. Files and Code Sections: [Files and code]
4. Errors and fixes: [Errors and fixes]
5. Problem Solving: [Description]
6. All user messages: [Messages]
7. Pending Tasks: [Tasks]
8. Current Work: [Description]
9. Optional Next Step: [Next step]
</summary>
</example>`;
  }

  private getPartialTemplate(): string {
    return `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized.

Before providing your final summary, wrap your analysis in <analysis> tags.

Your summary should include:
1. Primary Request and Intent from recent messages
2. Key Technical Concepts discussed recently
3. Files and Code Sections examined, modified, or created
4. Errors and fixes encountered
5. Problem Solving efforts
6. All user messages from the recent portion
7. Pending Tasks from recent messages
8. Current Work being done
9. Optional Next Step related to most recent work`;
  }

  private getUpToTemplate(): string {
    return `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages will follow after your summary.

Before providing your final summary, wrap your analysis in <analysis> tags.

Your summary should include:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and fixes
5. Problem Solving
6. All user messages
7. Pending Tasks
8. Work Completed
9. Context for Continuing Work: Summarize any context, decisions, or state needed to continue the work`;
  }
}
```

### 5.3 接线点

- 新增：`src/agent/memory/compact-prompt-engine.ts`
- 修改：[context-compaction.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/context-compaction.ts) — L5 阶段使用 `CompactPromptEngine` 生成提示词
- 修改：[context-manager.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/context-manager.ts) — `compressEnhanced` 使用 `formatSummary` 处理输出

### 5.4 Step 分解

- [ ] **Step 1: 实现 CompactPromptEngine**

新建 `src/agent/memory/compact-prompt-engine.ts`，实现 `getPrompt` / `formatSummary`。

- [ ] **Step 2: 实现三种方向模板**

`getBaseTemplate` / `getPartialTemplate` / `getUpToTemplate`。每种含 9 段结构化摘要要求。

- [ ] **Step 3: 实现 NO_TOOLS_PREAMBLE + NO_TOOLS_TRAILER**

双重保险防止 LLM 调用工具。

- [ ] **Step 4: 实现 formatSummary**

剥离 `<analysis>` 草稿区，提取 `<summary>` 内容，清理多余空行。

- [ ] **Step 5: 接入 L5 阶段**

在 `compact` 方法的 L5 阶段使用 `CompactPromptEngine.getPrompt('base')` 生成提示词，使用 `formatSummary` 处理输出。

- [ ] **Step 6: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/memory/compact-prompt-engine.test.ts`，覆盖：
- getPrompt('base') 包含 NO_TOOLS_PREAMBLE
- getPrompt('partial') 包含部分摘要模板
- getPrompt('up_to') 包含前缀摘要模板
- formatSummary 剥离 analysis 草稿区
- formatSummary 提取 summary 内容
- 自定义指令追加

- [ ] **Step 7: 提交**

```powershell
git add -A
git commit -m "feat(phase-70): 压缩提示词引擎

新增 CompactPromptEngine，NO_TOOLS_PREAMBLE + 9段结构化模板 + analysis 草稿区
借鉴：Claude Code prompt.ts 374行专用压缩提示词
三种方向：base/partial/up_to，formatSummary 剥离草稿区"
```

---

## Task 6：会话记忆压缩（≥ 3 测试）

### 6.1 Claude Code 借鉴

**Claude Code 实现**（`src/services/compact/sessionMemoryCompact.ts`）：
- 将旧状态压缩到"长期记忆（Session Memory）"片段中
- 不是单纯作为聊天流水账，而是结构化的会话记忆
- `setLastSummarizedMessageId` 记录已摘要的消息 ID

RouteDev 现状：有知识图谱（[graph.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/graph.ts)）但无"会话记忆"模式。

### 6.2 设计

新增 `SessionMemoryStore` 类：

```ts
// src/agent/memory/session-memory-store.ts
// Phase 70 Task 6：会话记忆压缩
// 借鉴：Claude Code sessionMemoryCompact.ts — 会话级长期记忆

export interface SessionMemory {
  /** 会话 ID */
  sessionId: string;
  /** 会话摘要 */
  summary: string;
  /** 关键决策 */
  keyDecisions: string[];
  /** 涉及文件 */
  involvedFiles: string[];
  /** 错误与修复 */
  errorsAndFixes: Array<{ error: string; fix: string }>;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
}

export class SessionMemoryStore {
  private memories = new Map<string, SessionMemory>();

  /**
   * 保存会话记忆
   */
  save(memory: SessionMemory): void {
    this.memories.set(memory.sessionId, memory);
  }

  /**
   * 获取会话记忆
   */
  get(sessionId: string): SessionMemory | undefined {
    return this.memories.get(sessionId);
  }

  /**
   * 按关键词检索会话记忆
   */
  query(keyword: string, limit = 5): SessionMemory[] {
    const results: Array<{ memory: SessionMemory; score: number }> = [];
    for (const memory of this.memories.values()) {
      const text = `${memory.summary} ${memory.keyDecisions.join(' ')} ${memory.involvedFiles.join(' ')}`;
      const score = this.keywordMatch(keyword, text);
      if (score > 0) results.push({ memory, score });
    }
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.memory);
  }

  /**
   * 获取最近的会话记忆
   */
  getRecent(limit = 5): SessionMemory[] {
    return [...this.memories.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /**
   * 持久化
   */
  serialize(): string {
    return JSON.stringify([...this.memories.values()], null, 2);
  }

  /**
   * 恢复
   */
  deserialize(data: string): void {
    try {
      const arr = JSON.parse(data) as SessionMemory[];
      this.memories.clear();
      for (const m of arr) this.memories.set(m.sessionId, m);
    } catch {
      // 跳过损坏数据
    }
  }

  // ===== 内部辅助 =====

  private keywordMatch(keyword: string, text: string): number {
    const kw = keyword.toLowerCase();
    const lower = text.toLowerCase();
    if (lower.includes(kw)) return 1;
    // 简单词匹配
    const words = kw.split(/\s+/);
    let matchCount = 0;
    for (const w of words) {
      if (lower.includes(w)) matchCount++;
    }
    return matchCount / words.length;
  }
}
```

### 6.3 接线点

- 新增：`src/agent/memory/session-memory-store.ts`
- 修改：[context-manager.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/agent/memory/context-manager.ts) — 压缩时保存会话记忆到 `SessionMemoryStore`
- 修改：[app-init.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/cli/app-init.ts) — 装配 SessionMemoryStore
- 修改：[schema.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/config/schema.ts) — 新增 `sessionMemory` 配置

### 6.4 Step 分解

- [ ] **Step 1: 定义 SessionMemory 接口**

新建 `src/agent/memory/session-memory-store.ts`，实现上述接口。

- [ ] **Step 2: 实现 SessionMemoryStore**

实现 `save` / `get` / `query` / `getRecent` / `serialize` / `deserialize`。

- [ ] **Step 3: 接入 context-manager.ts**

在 `compressEnhanced` 压缩完成后，构造 `SessionMemory` 并保存。

- [ ] **Step 4: 配置开关**

```ts
sessionMemory: z.preprocess((v) => v ?? {}, z.object({
  enabled: z.boolean().default(false),
  persistPath: z.string().default('.routedev/session-memory.json'),
  maxMemories: z.number().int().min(10).default(100),
})).default({}),
```

- [ ] **Step 5: 类型检查与测试**

运行：`pnpm typecheck`
新建 `tests/agent/memory/session-memory-store.test.ts`，覆盖：
- save + get 基本读写
- query 关键词检索
- getRecent 最近记忆
- serialize + deserialize 往返一致性

- [ ] **Step 6: 提交**

```powershell
git add -A
git commit -m "feat(phase-70): 会话记忆压缩

新增 SessionMemoryStore，压缩时保存会话级长期记忆
借鉴：Claude Code sessionMemoryCompact.ts 会话记忆模式
支持关键词检索 + 最近记忆查询"
```

---

## 风险与回滚

### 风险 1：落盘文件泄露敏感信息（工具输出可能含密钥）
- **缓解**：落盘前复用 [result-sanitizer.ts](file:///c:/Users/杨铭/Desktop/Agent/routedev/src/tools/result-sanitizer.ts) 脱敏
- **回滚**：关闭 `toolOutputBudget.enabled`，退回简单截断

### 风险 2：动作链误判（正常对话被折叠）
- **缓解**：`minToolCallsForChain` 默认 3，阈值较高；折叠后保留原始消息在内存
- **回滚**：关闭 `contextCollapse.enabled`

### 风险 3：自动压缩误触发（Token 估算不准）
- **缓解**：`autoCompactBuffer` 默认 13000，留足余量；熔断机制防止无限重试
- **回滚**：关闭 `autoCompactGuardian.enabled`

### 风险 4：压缩提示词过长（占用上下文窗口）
- **缓解**：提示词约 1500 token，相比 200K 窗口可忽略
- **回滚**：退回简单摘要函数

### 风险 5：会话记忆无界增长
- **缓解**：`maxMemories` 默认 100，超出时 FIFO 淘汰
- **回滚**：关闭 `sessionMemory.enabled`

### 风险 6：压缩后上下文断裂（摘要丢失关键信息）
- **缓解**：9 段结构化模板确保关键信息不丢失；`formatSummary` 保留 analysis 草稿区供调试
- **回滚**：关闭所有压缩相关配置，退回原始消息

---

## 验收清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿，新增 ≥ 30 个测试
- [ ] `pnpm build:electron` 构建成功
- [ ] ToolOutputBudgetManager 大内容落盘 + 短预览替换正常
- [ ] 历史哈希复用（相同内容不重复落盘）
- [ ] MessageGrouper 防止割裂 user-assistant 对偶
- [ ] L3 微压缩清理旧工具输出
- [ ] ActionChainDetector 检测并折叠动作链
- [ ] AutoCompactGuardian 三级阈值计算正确
- [ ] 熔断机制：连续失败 3 次后停止自动压缩
- [ ] CompactPromptEngine 生成 NO_TOOLS_PREAMBLE + 9段模板
- [ ] formatSummary 剥离 analysis 草稿区
- [ ] SessionMemoryStore 会话记忆保存/检索正常
- [ ] 所有配置默认关闭，设置页可开启
- [ ] fail-open：各模块失败时降级为简单截断
- [ ] README.md 与 ARCHITECTURE.md 已更新
- [ ] 死代码自审：所有 Task 的 knip 扫描通过
