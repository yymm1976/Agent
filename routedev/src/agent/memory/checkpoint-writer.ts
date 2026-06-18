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

import type { ILLMClient, LLMRequestOptions } from '../../router/types.js';
import type {
  CheckpointData,
  CheckpointWriterInput,
  CheckpointWriterOutput,
  CheckpointLevel,
} from './types.js';
import type { NotesManager } from './notes.js';
import { logger } from '../../utils/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export class CheckpointWriter {
  private llmClient: ILLMClient;
  private modelId: string;
  private maxTokens: number;
  private notesPath: string;
  /** 可选的 NotesManager，提供后优先使用其 readAll/clear */
  private notesManager: NotesManager | null = null;

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

  /**
   * 设置 NotesManager（可选）
   * 设置后，checkpoint() 会通过 NotesManager 读取和清空 notes.md
   */
  setNotesManager(notesManager: NotesManager): void {
    this.notesManager = notesManager;
  }

  /**
   * 执行 checkpoint 写入
   *
   * 集成 NotesManager 后的工作流程：
   *   1. 若设置了 NotesManager 且 input.notes 为空，从 NotesManager 读取 notes.md
   *   2. 调用 LLM 生成结构化 checkpoint
   *   3. 若 notes 非空，清空 notes.md（已归类到 checkpoint）
   */
  async write(input: CheckpointWriterInput): Promise<CheckpointWriterOutput | null> {
    try {
      // 若设置了 NotesManager 且 input.notes 为空，从 NotesManager 读取
      let notes = input.notes;
      if (!notes.trim() && this.notesManager) {
        notes = await this.notesManager.readAll();
      }

      const systemPrompt = this.buildSystemPrompt(input.level);
      const userMessage = this.buildUserMessage({ ...input, notes });

      const requestOptions: LLMRequestOptions = {
        model: this.modelId,
        messages: [{ role: 'user', content: userMessage }],
        systemPrompt,
        maxTokens: this.maxTokens,
        temperature: 0.3,
      };

      const response = await this.llmClient.complete(requestOptions);

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
      if (notes.trim()) {
        if (this.notesManager) {
          await this.notesManager.clear();
        } else {
          await this.clearNotes();
        }
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

  /**
   * checkpoint 别名：读取 notes.md → 分类到结构化字段 → 清空 notes.md
   * 与 write() 等价，提供蓝图描述的方法名
   */
  async checkpoint(input: CheckpointWriterInput): Promise<CheckpointWriterOutput | null> {
    return this.write(input);
  }

  /** 读取 notes.md（优先使用 NotesManager） */
  async readNotes(): Promise<string> {
    if (this.notesManager) {
      return this.notesManager.readAll();
    }
    try {
      return await fs.readFile(this.notesPath, 'utf-8');
    } catch {
      return '';
    }
  }

  /** 向 notes.md 追加内容（供主 Agent 调用；优先使用 NotesManager） */
  async appendNote(content: string): Promise<void> {
    if (this.notesManager) {
      await this.notesManager.append(content);
      return;
    }
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

  /** 获取 notes.md 路径（供测试） */
  getNotesPath(): string {
    return this.notesPath;
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
        : (Array.isArray(msg.content)
            ? msg.content
                .filter(c => c.type === 'text')
                .map(c => (c as { type: 'text'; text: string }).text)
                .join(' ')
            : '');
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

  private parseOutput(content: string, _previous: CheckpointData | null): CheckpointData | null {
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
        runtimeState: typeof parsed.runtimeState === 'object' && parsed.runtimeState !== null ? parsed.runtimeState : {},
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
