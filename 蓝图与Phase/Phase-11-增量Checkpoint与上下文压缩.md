# Phase 11：增量 Checkpoint + 上下文压缩（MiMo Code 风格）

**回应**：Phase 10 完成报告的 CONCERN

| # | CONCERN | 处理 |
|---|---------|------|
| C1 | 对话历史硬截断 20 条，/goal 步骤会快速填满历史 | **本 Phase 核心任务**：上下文压缩策略（80% 窗口阈值 + 优先级保留） |
| C2 | GoalPlan 只在内存中，重启即丢失 | Phase 10 已解决（GoalPlan 持久化） |
| C5 | /rollback 不撤回 GoalPlan 步骤状态 | Phase 11 不涉及，留待 Phase 12 /resume 设计时一并处理 |
| C7 | /diff 未实现（API 已有但无 CLI 命令） | Phase 11 不涉及，留待 UI 阶段 |

---

**目标**：实现 MiMo Code 风格的增量 Checkpoint 系统——用独立的 CheckpointWriter 子 Agent 维护 11 字段结构化记忆，在 token 消耗的 20%/45%/70% 节点自动写入；同时实现上下文压缩策略，在对话历史接近模型窗口上限时智能裁剪并从 checkpoint 重建上下文。

**蓝图参考**：第十节 10.3（增量 Checkpoint）+ 10.4（上下文压缩策略）

**前置依赖**：Phase 9（/goal 命令 + executeGoalPlan）、Phase 10（CheckpointManager + GoalPlan 持久化）

---

## 架构说明

Phase 11 解决的是 RouteDev 的"记忆"问题。打个比方：Phase 10 的检查点是"存档/读档"（代码层面的 Git 快照），Phase 11 的 Checkpoint 是"写日记"（知识层面的结构化摘要）。两者互补——Git 快照管代码回滚，Checkpoint 管上下文压缩。

```
Phase 9/10 的问题：
  /goal 有 8 个步骤，每步的对话都堆在 conversationHistoryRef 里
  → 步骤 5 时，步骤 1 的细节已经被 20 条截断丢掉了
  → 模型"忘了"步骤 1 做了什么，可能重复或矛盾

Phase 11 的解决：
  [CheckpointWriter]（独立子 Agent，用最便宜的模型）
    Token 消耗 20% → 首次 checkpoint：记录"我做了什么、为什么、下一步"
    Token 消耗 45% → 增量更新：只记录变化，不重写全部
    Token 消耗 70% → 晚期 checkpoint：为压缩做准备

  [ContextManager]（上下文压缩器）
    对话历史 > 80% 窗口 → 触发压缩：
      保留：系统 prompt + /goal 上下文 + 最近 N 条消息
      替换：旧消息 → checkpoint 摘要（"步骤 1 修改了 auth.ts，因为..."）
      效果：模型"记得"关键结论，但不占用 token 在细节上

  [notes.md]（主 Agent 的草稿纸）
    主 Agent 工作中随手写笔记（"发现 config.ts 有个 bug"、"用户偏好 TypeScript"）
    CheckpointWriter 写 checkpoint 时读取 notes.md，归类到 11 个字段中，然后清空
```

**关键约束**：
- CheckpointWriter 是**独立 LLM 调用**，不共享主 Agent 的上下文——用最便宜的模型（`config.checkpoint.modelId`，默认 deepseek-v4-flash）
- 每次 checkpoint 是对前一次的**增量更新**，不是全量重写（节省 token）
- 上下文压缩在**两次 run() 之间**触发，不在 run() 内部——避免干扰正在进行的 ReAct 循环
- notes.md 是主 Agent **唯一**的记忆写入通道。主 Agent 不直接操作 checkpoint 数据
- 压缩是**有损的**——旧消息被摘要替代，细节会丢失。但关键决策和结论通过 checkpoint 保留

---

## 具体任务

**接口对齐观察表**（已验证实际代码库）：

| # | 接口 | 实际签名 | Phase 11 用法 | 备注 |
|---|------|---------|--------------|------|
| 1 | `TokenTracker.getUsagePercent()` | `getUsagePercent(): number` | `tracker.getUsagePercent()` | 返回 0-1 的浮点数（如 0.2 = 20%） |
| 2 | `LLMClientManager.listAll()` | `listAll(): Map<string, ILLMClient>` | `[...clientManager.listAll().values()][0]` | **返回 Map，不是数组** |
| 3 | `LLMClient.complete()` | `complete(options: LLMRequestOptions): Promise<LLMResponse>` | CheckpointWriter 调用 | LLMRequestOptions 含 model, messages, systemPrompt, maxTokens, temperature |
| 4 | `getAppDataDir()` | `getAppDataDir(): string` | ContextManager 持久化路径 | 已验证存在 |
| 5 | `ensureDir()` | `ensureDir(dirPath: string): void` | 创建 memory 目录 | 已验证存在 |
| 6 | `ILLMMessage` | `{ role: MessageRole; content: string \| ContentPart[] }` | CheckpointWriter 读取对话历史 | role 只有 system/user/assistant，无 tool |

---

### Task 1：Checkpoint 记忆类型定义

**文件：** 创建 `src/agent/memory/types.ts`

定义 Checkpoint 记忆的 11 个结构化字段 + 触发级别枚举 + ContextManager 配置。

- [ ] **Step 1：创建 memory 目录 + 类型定义**

```typescript
// src/agent/memory/types.ts
// 增量 Checkpoint + 上下文压缩的类型定义（Phase 11）
// 蓝图参考：第十节 10.3（CheckpointWriter）、10.4（上下文压缩策略）

import type { LLMMessage } from '../../router/types.js';

/** Checkpoint 触发级别（对应 config.checkpoint.triggers） */
export type CheckpointLevel = 'initial' | 'incremental' | 'compress';

/** Checkpoint 触发结果 */
export interface CheckpointTriggerResult {
  /** 需要执行的动作（null 表示当前不需要触发） */
  action: CheckpointLevel | null;
  /** 当前 token 消耗百分比（0-1） */
  usagePercent: number;
  /** 触发阈值（20/45/70） */
  threshold: number;
}

/**
 * 结构化 Checkpoint 数据（11 字段）
 * 蓝图 10.3：每次 checkpoint 是对前一次的增量更新
 */
export interface CheckpointData {
  /** 1. 当前意图——用户想做什么 */
  currentIntent: string;
  /** 2. 下一步动作——接下来该做什么 */
  nextAction: string;
  /** 3. 工作约束——不能做什么、必须遵守什么 */
  workingConstraints: string[];
  /** 4. 任务树——主任务 + 子任务状态 */
  taskTree: TaskTreeNode;
  /** 5. 当前正在操作的文件 */
  currentWorkingFiles: string[];
  /** 6. 涉及的所有文件（包括历史） */
  involvedFiles: string[];
  /** 7. 跨任务发现——意外发现的关联或模式 */
  crossTaskDiscoveries: string[];
  /** 8. 错误与修复方案 */
  errorsAndFixes: ErrorAndFix[];
  /** 9. 运行时状态（环境变量、工具状态等） */
  runtimeState: Record<string, string>;
  /** 10. 设计决策及理由 */
  designDecisions: DesignDecision[];
  /** 11. 杂项笔记 */
  miscNotes: string[];
}

/** 任务树节点 */
export interface TaskTreeNode {
  /** 任务描述 */
  description: string;
  /** 状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** 子任务 */
  children: TaskTreeNode[];
}

/** 错误与修复记录 */
export interface ErrorAndFix {
  /** 错误描述 */
  error: string;
  /** 修复方案 */
  fix: string;
  /** 是否已修复 */
  resolved: boolean;
}

/** 设计决策 */
export interface DesignDecision {
  /** 决策内容 */
  decision: string;
  /** 为什么这样决定 */
  reason: string;
}

/** CheckpointWriter 的输入 */
export interface CheckpointWriterInput {
  /** 触发级别 */
  level: CheckpointLevel;
  /** 当前对话历史（最近 N 条，不是全部） */
  recentMessages: LLMMessage[];
  /** 上一次的 checkpoint 数据（首次时为 null） */
  previousCheckpoint: CheckpointData | null;
  /** notes.md 的内容 */
  notes: string;
  /** 当前 token 消耗百分比 */
  usagePercent: number;
}

/** CheckpointWriter 的输出 */
export interface CheckpointWriterOutput {
  /** 更新后的 checkpoint 数据 */
  checkpoint: CheckpointData;
  /** Writer 自己的备注（调试用） */
  writerNotes: string;
}

/** 上下文压缩配置 */
export interface ContextManagerConfig {
  /** 模型上下文窗口大小（token 数） */
  contextWindow: number;
  /** 压缩触发阈值（默认 0.8 = 80%） */
  compressionThreshold: number;
  /** 压缩后保留的最近消息数 */
  keepRecentMessages: number;
  /** Checkpoint 是否启用 */
  checkpointEnabled: boolean;
}

/** 上下文压缩结果 */
export interface CompressionResult {
  /** 压缩前的消息数 */
  originalCount: number;
  /** 压缩后的消息数 */
  compressedCount: number;
  /** 被压缩的消息摘要（用于调试） */
  summary: string;
  /** 压缩后保留的 checkpoint 快照 */
  checkpointSnapshot: CheckpointData | null;
}
```

- [ ] **Step 2：提交**

```powershell
git add src/agent/memory/types.ts
git commit -m "feat(memory): add checkpoint and context compression type definitions for Phase 11"
```

---

### Task 2：CheckpointWriter 子 Agent 实现

**文件：** 创建 `src/agent/memory/checkpoint-writer.ts`

CheckpointWriter 是独立的子 Agent——它不参与主对话，只在触发时被调用，用最便宜的模型生成结构化记忆。

- [ ] **Step 1：实现 CheckpointWriter**

```typescript
// src/agent/memory/checkpoint-writer.ts
// CheckpointWriter：独立的记忆维护子 Agent
// 蓝图 10.3：主 Agent 只管写代码，记忆维护完全外包
//
// 工作流程：
//   1. 被 ContextManager 调用（token 消耗达到阈值时）
//   2. 接收：最近对话 + 上次 checkpoint + notes.md
//   3. 调用 LLM（最便宜模型）生成 11 字段结构化摘要
//   4. 增量更新：只改有变化的字段，不重写全部
//   5. 清空 notes.md（已归类到 checkpoint 中）

import type { ILLMClient } from '../../router/types.js';
import type {
  CheckpointData,
  CheckpointWriterInput,
  CheckpointWriterOutput,
  CheckpointLevel,
} from './types.js';
import { logger } from '../../utils/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export class CheckpointWriter {
  private llmClient: ILLMClient;
  private modelId: string;
  private maxTokens: number;
  private notesPath: string;

  constructor(
    llmClient: ILLMClient,
    modelId: string,
    maxTokens: number = 500,
    notesPath?: string,
  ) {
    this.llmClient = llmClient;
    this.modelId = modelId;
    this.maxTokens = maxTokens;
    // notes.md 默认在项目根目录
    this.notesPath = notesPath ?? path.join(process.cwd(), '.routedev-notes.md');
  }

  /** 执行 checkpoint 写入 */
  async write(input: CheckpointWriterInput): Promise<CheckpointWriterOutput | null> {
    try {
      const systemPrompt = this.buildSystemPrompt(input.level);
      const userMessage = this.buildUserMessage(input);

      const response = await this.llmClient.complete({
        model: this.modelId,
        messages: [{ role: 'user', content: userMessage }],
        systemPrompt,
        maxTokens: this.maxTokens,
        temperature: 0.3,
      });

      const checkpoint = this.parseOutput(response.content, input.previousCheckpoint);
      if (!checkpoint) {
        logger.warn('CheckpointWriter: failed to parse LLM output');
        return null;
      }

      // 增量模式：合并未变化的字段
      const merged = input.previousCheckpoint
        ? this.mergeWithPrevious(checkpoint, input.previousCheckpoint)
        : checkpoint;

      // 清空 notes.md（已归类）
      if (input.notes.trim()) {
        await this.clearNotes();
      }

      return {
        checkpoint: merged,
        writerNotes: `Level: ${input.level}, usage: ${(input.usagePercent * 100).toFixed(0)}%`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('CheckpointWriter failed', { error: msg });
      return null;
    }
  }

  /** 读取 notes.md */
  async readNotes(): Promise<string> {
    try {
      return await fs.readFile(this.notesPath, 'utf-8');
    } catch {
      return '';
    }
  }

  /** 向 notes.md 追加内容（供主 Agent 调用） */
  async appendNote(content: string): Promise<void> {
    try {
      await fs.appendFile(this.notesPath, content + '\n', 'utf-8');
    } catch (error) {
      logger.warn('Failed to append note', { error: String(error) });
    }
  }

  /** 清空 notes.md */
  private async clearNotes(): Promise<void> {
    try {
      await fs.writeFile(this.notesPath, '', 'utf-8');
    } catch {
      // 忽略
    }
  }

  private buildSystemPrompt(level: CheckpointLevel): string {
    const levelDesc: Record<CheckpointLevel, string> = {
      initial: '这是首次 checkpoint。请从对话中建立基础快照，记录所有已知信息。',
      incremental: '这是增量 checkpoint。只更新有变化的字段，未变化的字段保持原值。',
      compress: '这是晚期 checkpoint，即将进行上下文压缩。请确保所有关键信息都被记录，压缩后旧对话将不可见。',
    };

    return [
      '你是 CheckpointWriter，负责维护项目记忆的结构化摘要。',
      '你必须输出一个 JSON 对象，包含以下 11 个字段：',
      '',
      '{',
      '  "currentIntent": "用户当前想做什么（一句话）",',
      '  "nextAction": "下一步该做什么（一句话）",',
      '  "workingConstraints": ["约束条件列表"],',
      '  "taskTree": { "description": "主任务", "status": "in_progress", "children": [...] },',
      '  "currentWorkingFiles": ["当前正在操作的文件路径"],',
      '  "involvedFiles": ["所有涉及过的文件路径"],',
      '  "crossTaskDiscoveries": ["跨任务的发现或关联"],',
      '  "errorsAndFixes": [{ "error": "错误描述", "fix": "修复方案", "resolved": true }],',
      '  "runtimeState": { "键": "值" },',
      '  "designDecisions": [{ "decision": "决策", "reason": "理由" }],',
      '  "miscNotes": ["其他笔记"]',
      '}',
      '',
      levelDesc[level],
      '只输出 JSON，不要输出其他内容。',
    ].join('\n');
  }

  private buildUserMessage(input: CheckpointWriterInput): string {
    const parts: string[] = [];

    // 上次 checkpoint（如果有）
    if (input.previousCheckpoint) {
      parts.push('## 上次 Checkpoint 数据\n```json\n' + JSON.stringify(input.previousCheckpoint, null, 2) + '\n```');
    }

    // 最近对话（截取关键内容）
    parts.push('## 最近对话');
    for (const msg of input.recentMessages.slice(-10)) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join(' ');
      const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
      parts.push(`[${msg.role}]: ${truncated}`);
    }

    // notes.md
    if (input.notes.trim()) {
      parts.push('## notes.md 内容\n' + input.notes);
    }

    parts.push(`\n当前 token 消耗：${(input.usagePercent * 100).toFixed(0)}%`);

    return parts.join('\n\n');
  }

  private parseOutput(content: string, previous: CheckpointData | null): CheckpointData | null {
    try {
      // 处理可能的 markdown code block 包裹
      const extracted = this.extractJson(content);
      const parsed = JSON.parse(extracted);

      // 验证必要字段
      if (typeof parsed.currentIntent !== 'string') return null;

      // 填充缺失字段为默认值
      return {
        currentIntent: parsed.currentIntent ?? '',
        nextAction: parsed.nextAction ?? '',
        workingConstraints: Array.isArray(parsed.workingConstraints) ? parsed.workingConstraints : [],
        taskTree: parsed.taskTree ?? { description: '', status: 'pending', children: [] },
        currentWorkingFiles: Array.isArray(parsed.currentWorkingFiles) ? parsed.currentWorkingFiles : [],
        involvedFiles: Array.isArray(parsed.involvedFiles) ? parsed.involvedFiles : [],
        crossTaskDiscoveries: Array.isArray(parsed.crossTaskDiscoveries) ? parsed.crossTaskDiscoveries : [],
        errorsAndFixes: Array.isArray(parsed.errorsAndFixes) ? parsed.errorsAndFixes : [],
        runtimeState: typeof parsed.runtimeState === 'object' ? parsed.runtimeState : {},
        designDecisions: Array.isArray(parsed.designDecisions) ? parsed.designDecisions : [],
        miscNotes: Array.isArray(parsed.miscNotes) ? parsed.miscNotes : [],
      };
    } catch {
      return null;
    }
  }

  private extractJson(content: string): string {
    // 处理 ```json ... ``` 包裹
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    return match ? match[1].trim() : content.trim();
  }

  private mergeWithPrevious(
    updated: CheckpointData,
    previous: CheckpointData,
  ): CheckpointData {
    return {
      // 标量字段：用新值
      currentIntent: updated.currentIntent || previous.currentIntent,
      nextAction: updated.nextAction || previous.nextAction,
      taskTree: updated.taskTree.description ? updated.taskTree : previous.taskTree,
      // 数组字段：合并去重
      workingConstraints: this.mergeArrays(updated.workingConstraints, previous.workingConstraints),
      currentWorkingFiles: [...new Set([...updated.currentWorkingFiles, ...previous.currentWorkingFiles])],
      involvedFiles: [...new Set([...updated.involvedFiles, ...previous.involvedFiles])],
      crossTaskDiscoveries: this.mergeArrays(updated.crossTaskDiscoveries, previous.crossTaskDiscoveries),
      errorsAndFixes: [...previous.errorsAndFixes, ...updated.errorsAndFixes],
      runtimeState: { ...previous.runtimeState, ...updated.runtimeState },
      designDecisions: [...previous.designDecisions, ...updated.designDecisions],
      miscNotes: this.mergeArrays(updated.miscNotes, previous.miscNotes),
    };
  }

  private mergeArrays(updated: string[], previous: string[]): string[] {
    const set = new Set([...previous]);
    for (const item of updated) set.add(item);
    return [...set];
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/memory/checkpoint-writer.ts
git commit -m "feat(memory): implement CheckpointWriter sub-agent with 11-field structured memory"
```

---

### Task 3：ContextManager 上下文压缩

**文件：** 创建 `src/agent/memory/context-manager.ts`

上下文压缩器——在两次 run() 之间检测 token 使用情况，触发 checkpoint 写入和/或历史压缩。

- [ ] **Step 1：实现 ContextManager**

```typescript
// src/agent/memory/context-manager.ts
// 上下文压缩器：监控 token 使用 → 触发 checkpoint → 压缩对话历史
// 蓝图 10.4：当消息 token 数超过模型窗口的 80% 时触发压缩
//
// 工作时机：
//   - 不在 run() 内部运行（避免干扰 ReAct 循环）
//   - 在两次 run() 之间由 App.tsx 调用
//   - /goal 模式下在每个步骤之间调用
//
// 压缩保留策略（优先级从高到低）：
//   1. 系统 prompt（始终保留）
//   2. 当前 /goal 上下文（始终保留）
//   3. 最近 N 条完整消息（可配置）
//   4. 包含决策的消息（优先保留）
//   5. 历史消息 → 替换为 checkpoint 摘要

import type { LLMMessage, TokenUsageInfo, ILLMClient } from '../../router/types.js';
import type { CheckpointData, ContextManagerConfig, CompressionResult } from './types.js';
import { CheckpointWriter } from './checkpoint-writer.js';
import type { CheckpointLevel } from './types.js';
import { logger } from '../../utils/logger.js';

export class ContextManager {
  private config: ContextManagerConfig;
  private writer: CheckpointWriter;
  private currentCheckpoint: CheckpointData | null = null;
  /** 已触发的 checkpoint 级别（避免重复触发） */
  private triggeredLevels: Set<CheckpointLevel> = new Set();

  constructor(config: ContextManagerConfig, writer: CheckpointWriter) {
    this.config = config;
    this.writer = writer;
  }

  /**
   * 检查是否需要触发 checkpoint
   * @param usagePercent 当前 token 消耗百分比（0-1）
   * @param triggers 触发配置 [{ level: 20, action: 'initial' }, ...]
   */
  shouldTriggerCheckpoint(
    usagePercent: number,
    triggers: Array<{ level: number; action: CheckpointLevel }>,
  ): CheckpointLevel | null {
    if (!this.config.checkpointEnabled) return null;

    for (const trigger of triggers) {
      const threshold = trigger.level / 100;
      if (usagePercent >= threshold && !this.triggeredLevels.has(trigger.action)) {
        return trigger.action;
      }
    }
    return null;
  }

  /** 执行 checkpoint 写入 */
  async triggerCheckpoint(
    level: CheckpointLevel,
    messages: LLMMessage[],
    usagePercent: number,
  ): Promise<CheckpointData | null> {
    const notes = await this.writer.readNotes();

    const output = await this.writer.write({
      level,
      recentMessages: messages.slice(-20), // 只传最近 20 条
      previousCheckpoint: this.currentCheckpoint,
      notes,
      usagePercent,
    });

    if (output) {
      this.currentCheckpoint = output.checkpoint;
      this.triggeredLevels.add(level);
      logger.info('Checkpoint triggered', {
        level,
        usagePercent: `${(usagePercent * 100).toFixed(0)}%`,
      });
      return output.checkpoint;
    }
    return null;
  }

  /**
   * 检查是否需要压缩上下文
   * @param messageCount 当前对话历史条数
   * @param estimatedTokens 估算的 token 数（简单按字符数 / 4 估算）
   */
  shouldCompress(messageCount: number, estimatedTokens: number): boolean {
    if (!this.config.checkpointEnabled) return false;
    const threshold = this.config.contextWindow * this.config.compressionThreshold;
    return estimatedTokens >= threshold;
  }

  /**
   * 压缩对话历史
   * 保留：最近 N 条 + checkpoint 摘要
   * 替换：旧消息 → 一条系统消息包含 checkpoint 数据
   */
  compress(messages: LLMMessage[]): { compressed: LLMMessage[]; result: CompressionResult } {
    const originalCount = messages.length;

    if (messages.length <= this.config.keepRecentMessages + 2) {
      return {
        compressed: messages,
        result: {
          originalCount,
          compressedCount: messages.length,
          summary: '消息数不足，跳过压缩',
          checkpointSnapshot: this.currentCheckpoint,
        },
      };
    }

    // 分割：旧消息 vs 最近消息
    const keepCount = this.config.keepRecentMessages;
    const oldMessages = messages.slice(0, messages.length - keepCount);
    const recentMessages = messages.slice(messages.length - keepCount);

    // 构建压缩摘要
    const summaryParts: string[] = [];

    // 1. 从 checkpoint 提取关键信息
    if (this.currentCheckpoint) {
      const cp = this.currentCheckpoint;
      summaryParts.push(`[记忆摘要] 当前意图: ${cp.currentIntent}`);
      if (cp.nextAction) summaryParts.push(`下一步: ${cp.nextAction}`);
      if (cp.involvedFiles.length > 0) summaryParts.push(`涉及文件: ${cp.involvedFiles.join(', ')}`);
      if (cp.errorsAndFixes.length > 0) {
        summaryParts.push(`错误记录: ${cp.errorsAndFixes.map(e => `${e.error}→${e.fix}`).join('; ')}`);
      }
      if (cp.designDecisions.length > 0) {
        summaryParts.push(`设计决策: ${cp.designDecisions.map(d => `${d.decision}(${d.reason})`).join('; ')}`);
      }
      if (cp.crossTaskDiscoveries.length > 0) {
        summaryParts.push(`发现: ${cp.crossTaskDiscoveries.join('; ')}`);
      }
    } else {
      // 没有 checkpoint 时，从旧消息中提取摘要
      summaryParts.push(`[历史摘要] 之前有 ${oldMessages.length} 条对话消息已被压缩。`);
      // 提取旧消息中的关键文件引用
      const mentionedFiles = new Set<string>();
      for (const msg of oldMessages) {
        const text = typeof msg.content === 'string' ? msg.content : '';
        const fileMatches = text.match(/[\w/]+\.\w{1,5}/g);
        if (fileMatches) fileMatches.forEach(f => mentionedFiles.add(f));
      }
      if (mentionedFiles.size > 0) {
        summaryParts.push(`提及文件: ${[...mentionedFiles].slice(0, 10).join(', ')}`);
      }
    }

    // 2. 构建压缩后的消息
    const compressed: LLMMessage[] = [
      {
        role: 'system' as const,
        content: summaryParts.join('\n'),
      },
      ...recentMessages,
    ];

    const result: CompressionResult = {
      originalCount,
      compressedCount: compressed.length,
      summary: `压缩 ${oldMessages.length} 条旧消息 → checkpoint 摘要`,
      checkpointSnapshot: this.currentCheckpoint,
    };

    logger.info('Context compressed', {
      original: originalCount,
      compressed: compressed.length,
      hasCheckpoint: !!this.currentCheckpoint,
    });

    return { compressed, result };
  }

  /** 获取当前 checkpoint 数据 */
  getCheckpoint(): CheckpointData | null {
    return this.currentCheckpoint;
  }

  /** 手动设置 checkpoint（用于从磁盘恢复） */
  setCheckpoint(checkpoint: CheckpointData): void {
    this.currentCheckpoint = checkpoint;
  }

  /** 重置触发状态（新对话时调用） */
  resetTriggers(): void {
    this.triggeredLevels.clear();
    this.currentCheckpoint = null;
  }

  /** 持久化 checkpoint 到磁盘 */
  async saveCheckpoint(): Promise<void> {
    if (!this.currentCheckpoint) return;
    try {
      const { join } = await import('path');
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { getAppDataDir, ensureDir } = await import('../../utils/paths.js');
      const dir = join(getAppDataDir(), 'memory');
      ensureDir(dir);
      await writeFile(
        join(dir, 'current-checkpoint.json'),
        JSON.stringify(this.currentCheckpoint, null, 2),
        'utf-8',
      );
    } catch (error) {
      logger.warn('Failed to save checkpoint', { error: String(error) });
    }
  }

  /** 从磁盘加载 checkpoint */
  async loadCheckpoint(): Promise<void> {
    try {
      const { join } = await import('path');
      const { readFile } = await import('node:fs/promises');
      const { getAppDataDir } = await import('../../utils/paths.js');
      const filePath = join(getAppDataDir(), 'memory', 'current-checkpoint.json');
      const content = await readFile(filePath, 'utf-8');
      this.currentCheckpoint = JSON.parse(content);
    } catch {
      // 文件不存在，忽略
    }
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/memory/context-manager.ts
git commit -m "feat(memory): implement ContextManager with token-triggered compression"
```

---

### Task 4：App.tsx 集成

**文件：** 修改 `src/cli/App.tsx`

将 CheckpointWriter + ContextManager 集成到主对话流程和 /goal 流程中。

- [ ] **Step 1：初始化 Writer 和 Manager**

在 useRef 区域添加：

```typescript
import { CheckpointWriter } from '../agent/memory/checkpoint-writer.js';
import { ContextManager } from '../agent/memory/context-manager.js';

// 在 useRef 初始化区域：
// 找到 checkpoint 配置对应的模型（最便宜的模型）
const checkpointModelId = config.checkpoint.modelId;
const checkpointProvider = config.providers.find(p =>
  p.models.some(m => m.id === checkpointModelId)
);
const checkpointClient = checkpointProvider
  ? clientManager.get(checkpointProvider.id) ?? [...clientManager.listAll().values()][0]
  : [...clientManager.listAll().values()][0];

const writerRef = useRef(new CheckpointWriter(
  checkpointClient,
  checkpointModelId,
  config.checkpoint.maxTokensPerCheckpoint,
));

// 找到当前模型的上下文窗口大小
const currentModelConfig = config.providers
  .flatMap(p => p.models)
  .find(m => m.id === currentModel);

const contextManagerRef = useRef(new ContextManager(
  {
    contextWindow: currentModelConfig?.contextWindow ?? 128000,
    compressionThreshold: 0.8,
    keepRecentMessages: 6,
    checkpointEnabled: config.checkpoint.enabled,
  },
  writerRef.current,
));

// 在 useEffect 初始化区域添加：
useEffect(() => {
  contextManagerRef.current.loadCheckpoint().catch(err => {
    logger.warn('ContextManager loadCheckpoint failed', { error: String(err) });
  });
}, []);
```

- [ ] **Step 2：在 handleSubmit 中集成（普通对话后触发 checkpoint）**

在 `handleSubmit` 的 ReAct loop 事件处理完成后（`done` 事件处理之后、token 统计更新之后），插入：

```typescript
// ===== Phase 11：增量 Checkpoint =====
if (config.checkpoint.enabled) {
  const usagePercent = tracker.getUsagePercent();
  const triggers = config.checkpoint.triggers.map(t => ({
    level: t.level,
    action: t.action as 'initial' | 'incremental' | 'compress',
  }));

  const triggerAction = contextManagerRef.current.shouldTriggerCheckpoint(usagePercent, triggers);
  if (triggerAction) {
    const cp = await contextManagerRef.current.triggerCheckpoint(
      triggerAction,
      conversationHistoryRef.current,
      usagePercent,
    );
    if (cp) {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `🧠 记忆已保存 (${triggerAction}): ${cp.currentIntent}`,
      }]);
      await contextManagerRef.current.saveCheckpoint();
    }
  }

  // 上下文压缩检查
  const estimatedTokens = conversationHistoryRef.current.reduce((acc, msg) => {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return acc + Math.ceil(text.length / 4);
  }, 0);

  if (contextManagerRef.current.shouldCompress(
    conversationHistoryRef.current.length,
    estimatedTokens,
  )) {
    const { compressed, result } = contextManagerRef.current.compress(
      conversationHistoryRef.current,
    );
    conversationHistoryRef.current = compressed;
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system' as const,
      content: `📦 上下文已压缩: ${result.originalCount} → ${result.compressedCount} 条`,
    }]);
  }
}
```

- [ ] **Step 3：在 executeGoalPlan 中集成（每个步骤之间触发）**

在 `executeGoalPlan` 的步骤循环中，每个步骤执行完毕之后、下一个步骤开始之前，插入相同的 checkpoint + 压缩逻辑：

```typescript
// ===== Phase 11：步骤间 checkpoint + 压缩 =====
// 与 Step 2 逻辑相同，放在 step.status = 'completed' 之后
if (config.checkpoint.enabled) {
  const usagePercent = tracker.getUsagePercent();
  const triggers = config.checkpoint.triggers.map(t => ({
    level: t.level,
    action: t.action as 'initial' | 'incremental' | 'compress',
  }));

  const triggerAction = contextManagerRef.current.shouldTriggerCheckpoint(usagePercent, triggers);
  if (triggerAction) {
    await contextManagerRef.current.triggerCheckpoint(
      triggerAction,
      conversationHistoryRef.current,
      usagePercent,
    );
    await contextManagerRef.current.saveCheckpoint();
  }

  // 步骤间压缩
  const estimatedTokens = conversationHistoryRef.current.reduce((acc, msg) => {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return acc + Math.ceil(text.length / 4);
  }, 0);

  if (contextManagerRef.current.shouldCompress(conversationHistoryRef.current.length, estimatedTokens)) {
    const { compressed } = contextManagerRef.current.compress(conversationHistoryRef.current);
    conversationHistoryRef.current = compressed;
  }
}
```

- [ ] **Step 4：/clear 时重置触发状态**

在 `/clear` 命令处理中添加：

```typescript
case '/clear':
  // 已有逻辑...
  contextManagerRef.current.resetTriggers();
  break;
```

- [ ] **Step 5：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): integrate CheckpointWriter and ContextManager into main loop"
```

---

### Task 5：/memory 命令

**文件：** 修改 `src/cli/App.tsx`

新增 /memory 命令，查看/操作结构化记忆。

- [ ] **Step 1：实现 /memory 命令**

```typescript
case '/memory': {
  const subCmd = parts[1]?.toLowerCase();

  switch (subCmd) {
    case undefined:
    case 'show': {
      const checkpoint = contextManagerRef.current.getCheckpoint();
      if (!checkpoint) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '还没有记忆数据。记忆会在 token 消耗达到阈值时自动创建。',
        }]);
      } else {
        const lines: string[] = [
          `🧠 当前记忆：`,
          `  意图: ${checkpoint.currentIntent}`,
          `  下一步: ${checkpoint.nextAction || '无'}`,
          `  约束: ${checkpoint.workingConstraints.length > 0 ? checkpoint.workingConstraints.join('; ') : '无'}`,
          `  当前文件: ${checkpoint.currentWorkingFiles.length > 0 ? checkpoint.currentWorkingFiles.join(', ') : '无'}`,
          `  涉及文件: ${checkpoint.involvedFiles.length} 个`,
          `  错误记录: ${checkpoint.errorsAndFixes.length} 条`,
          `  设计决策: ${checkpoint.designDecisions.length} 条`,
        ];
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: lines.join('\n'),
        }]);
      }
      break;
    }

    case 'notes': {
      const notes = await writerRef.current.readNotes();
      if (!notes.trim()) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: 'notes.md 为空。',
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `📝 notes.md:\n${notes}`,
        }]);
      }
      break;
    }

    case 'write': {
      // 手动触发一次 checkpoint
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: '🧠 正在手动写入记忆...',
      }]);
      const usagePercent = tracker.getUsagePercent();
      const cp = await contextManagerRef.current.triggerCheckpoint(
        'incremental',
        conversationHistoryRef.current,
        usagePercent,
      );
      if (cp) {
        await contextManagerRef.current.saveCheckpoint();
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `🧠 记忆已保存: ${cp.currentIntent}`,
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '记忆写入失败。',
        }]);
      }
      break;
    }

    case 'clear': {
      contextManagerRef.current.resetTriggers();
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: '记忆已清除。下次对话将重新开始记忆积累。',
      }]);
      break;
    }

    default:
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          '记忆命令：',
          '  /memory show   - 查看当前记忆',
          '  /memory notes  - 查看 notes.md',
          '  /memory write  - 手动写入记忆',
          '  /memory clear  - 清除记忆',
        ].join('\n'),
      }]);
  }
  break;
}
```

- [ ] **Step 2：更新 /help**

在 /help 中添加：
```
  /memory show           - 查看当前记忆
  /memory write          - 手动写入记忆
```

- [ ] **Step 3：更新 /status**

在 /status 中添加记忆状态：

```typescript
const checkpoint = contextManagerRef.current.getCheckpoint();
const memoryStatus = checkpoint ? `有记忆 (${checkpoint.currentIntent.slice(0, 20)})` : '无记忆';
// 添加到 status 输出中：
`记忆: ${memoryStatus}`,
```

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): add /memory command for checkpoint inspection and management"
```

---

### Task 6：notes.md 工具集成（可选增强）

**文件：** 修改 `src/cli/App.tsx` + 修改 `src/agent/prompts.ts`

让主 Agent 知道 notes.md 的存在，并在系统 prompt 中提示它可以写入笔记。

- [ ] **Step 1：在系统 prompt 中添加 notes.md 说明**

在 `src/agent/prompts.ts` 的 `DEFAULT_SYSTEM_PROMPT_ZH` 末尾追加：

```
## 记忆笔记
你可以随时通过工具或对话中提到需要记住的信息。系统会在适当时候将这些信息整理为结构化记忆。
如果你发现了重要的项目约束、设计决策或错误修复方案，请在回复中明确标注。
```

- [ ] **Step 2：在 App.tsx 中添加 note 快捷记录**

当 ReAct loop 的 `done` 事件包含工具调用结果时，如果结果中包含关键信息（文件路径、错误修复），自动追加到 notes.md：

```typescript
// 在 done 事件处理后（可选增强，优先级低）：
// 如果模型回复中提到了"记住"、"注意"等关键词，自动追加到 notes
if (doneContent && /(?:记住|注意|记住这个|remember)/i.test(doneContent)) {
  const noteContent = doneContent.length > 200 ? doneContent.slice(0, 200) : doneContent;
  writerRef.current.appendNote(`[auto] ${noteContent}`).catch(() => {});
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/agent/prompts.ts src/cli/App.tsx
git commit -m "feat(prompts): add notes.md awareness to system prompt"
```

---

### Task 7：单元测试

**文件：**
- 创建 `tests/memory/checkpoint-writer.test.ts`
- 创建 `tests/memory/context-manager.test.ts`

- [ ] **Step 1：CheckpointWriter 测试**

测试点（mock ILLMClient）：

- write() 首次 checkpoint (initial) → 返回完整 11 字段
- write() 增量 checkpoint (incremental) → 只更新有变化的字段
- write() 晚期 checkpoint (compress) → 确保关键信息不丢失
- write() LLM 返回 markdown code block 包裹的 JSON → 正确解析
- write() LLM 返回非法 JSON → 返回 null
- write() 有 notes.md 内容 → 写入后 notes.md 被清空
- readNotes() 文件不存在 → 返回空字符串
- appendNote() → 文件内容追加

- [ ] **Step 2：ContextManager 测试**

测试点：

- shouldTriggerCheckpoint() 低于所有阈值 → 返回 null
- shouldTriggerCheckpoint() 超过 20% → 返回 'initial'
- shouldTriggerCheckpoint() 已触发过 'initial'，不超过 45% → 返回 null
- shouldTriggerCheckpoint() 超过 45% → 返回 'incremental'
- shouldCompress() 低于 80% → 返回 false
- shouldCompress() 超过 80% → 返回 true
- compress() 消息少于 keepRecentMessages → 不压缩
- compress() 消息多于 keepRecentMessages → 旧消息被替换为摘要
- compress() 有 checkpoint 时 → 摘要包含 checkpoint 数据
- compress() 无 checkpoint 时 → 摘要从旧消息提取文件引用
- resetTriggers() → 清除已触发的级别
- saveCheckpoint() + loadCheckpoint() 往返一致

- [ ] **Step 3：运行全部测试 → 提交**

```powershell
pnpm test
git add tests/memory/
git commit -m "test(memory): add tests for CheckpointWriter and ContextManager"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 175 个用例，Phase 10 的 155 + Phase 11 新增 ~20）
4. CheckpointWriter 能调用 LLM 生成 11 字段结构化记忆
5. 增量 checkpoint 只更新有变化的字段，不全量重写
6. CheckpointWriter 处理 LLM 返回 markdown code block 包裹的 JSON
7. ContextManager 在 token 消耗 20%/45%/70% 时分别触发 initial/incremental/compress
8. 同一级别不重复触发（triggeredLevels 机制）
9. 上下文压缩在 token 超过窗口 80% 时触发
10. 压缩保留系统 prompt + 最近 N 条消息 + checkpoint 摘要
11. /memory show 显示当前记忆状态
12. /memory write 手动触发 checkpoint 写入
13. /memory clear 重置触发状态
14. notes.md 读取/追加/清空正常工作
15. checkpoint 数据持久化到 AppData/RouteDev/memory/current-checkpoint.json
16. /help 和 /status 反映新增功能

## 注意事项

- **CheckpointWriter 用最便宜的模型**：`config.checkpoint.modelId`（默认 `deepseek-v4-flash`）。从 `config.providers` 中找到该模型所属的 provider，获取对应的 `ILLMClient`。如果找不到该模型，fallback 到第一个可用的 client
- **ContextManager 需要知道模型的 contextWindow**：从 `config.providers[].models[]` 中查找当前使用的模型的 `contextWindow` 字段。如果找不到，使用默认值 128000（GPT-4o 的窗口大小）
- **压缩是有损操作**：旧消息被替换为摘要，细节丢失。这就是为什么 checkpoint 的 11 字段要尽量全面——关键信息必须在 checkpoint 中
- **Token 估算简单化**：当前使用 `字符数 / 4` 估算 token 数。这对中英文混合内容不够精确，但作为压缩触发的判断足够（宁可早触发不晚触发）
- **/goal 步骤间压缩**：`executeGoalPlan` 中每个步骤执行完后检查是否需要压缩。这避免了 8 步 /goal 执行到后面步骤时上下文爆炸
- **conversationHistoryRef.current = compressed**：压缩后直接替换 ref 中的历史。这是安全的，因为压缩发生在两次 run() 之间，run() 内部不会看到变化
- **CheckpointData 11 个字段的 LLM 输出可能不完整**：parseOutput() 对缺失字段使用默认值填充，确保返回完整的 CheckpointData
- **mergeWithPrevious()**：增量模式下，数组字段合并去重（involvedFiles、errorsAndFixes 等），标量字段用新值覆盖旧值（currentIntent、nextAction）
- **notes.md 路径**：默认在项目根目录 `.routedev-notes.md`。使用 `.` 前缀隐藏文件。CheckpointWriter 构造函数接受 `notesPath` 参数可覆盖
- **持久化路径**：`AppData/RouteDev/memory/current-checkpoint.json`（与 Phase 10 的 `checkpoints/` 目录平级）。使用 `getAppDataDir()` 工具函数
- **Phase 10 的 CheckpointManager vs Phase 11 的 CheckpointWriter**：两者名字相似但功能完全不同。CheckpointManager（Phase 10）= Git 快照/回滚；CheckpointWriter（Phase 11）= LLM 驱动的记忆摘要。两者独立运行，互不影响

---

*Phase 11 | 蓝图 V1.0 | 预估新增文件：~4 个 | 预估修改文件：~2 个（App.tsx + prompts.ts）*
