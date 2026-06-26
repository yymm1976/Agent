// src/agent/dream-consolidator.ts
// DreamConsolidator：整理记忆（合并去重）
// 支持两种模式：
//   1. 原有模式（无 compactor）：调用 LLM 整理 checkpoint
//   2. 渐进压缩模式（有 compactor）：将 checkpoint 转为消息列表，用 ContextCompactor 压缩

import type { ILLMClient, LLMRequestOptions, LLMMessage } from '../router/types.js';
import type { CheckpointData } from './memory/types.js';
import { ContextCompactor } from './context-compaction.js';
import { logger } from '../utils/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

export interface DreamResult {
  beforeSize: number;
  afterSize: number;
  mergedCount: number;
  /** 整理后的 checkpoint（已合并重复项） */
  consolidated: CheckpointData;
  /** Dream 输出的人类可读摘要 */
  summary: string;
  /** 上下文压缩达到的最高阶段（仅在使用 ContextCompactor 时存在） */
  maxStageReached?: 1 | 2 | 3 | 4 | 5;
  /** 执行的压缩阶段列表（如 [1, 2, 3]） */
  compactionStages?: number[];
}

interface DreamOptions {
  llmClient: ILLMClient;
  modelId: string;
  /** 整理阈值（记忆字段项数超过此值时触发 LLM 整理） */
  threshold?: number;
  /** 可选的上下文压缩器（提供后启用渐进压缩管线） */
  compactor?: ContextCompactor;
}

export class DreamConsolidator {
  private client: ILLMClient;
  private modelId: string;
  private threshold: number;
  private compactor: ContextCompactor | null;

  constructor(options: DreamOptions) {
    this.client = options.llmClient;
    this.modelId = options.modelId;
    this.threshold = options.threshold ?? 5;
    this.compactor = options.compactor ?? null;
  }

  async consolidate(checkpoint: CheckpointData): Promise<DreamResult> {
    if (!checkpoint) {
      return {
        beforeSize: 0,
        afterSize: 0,
        mergedCount: 0,
        consolidated: checkpoint,
        summary: '没有记忆可整理。',
      };
    }

    const beforeSize = this.sizeOf(checkpoint);
    const totalCount = this.totalItemCount(checkpoint);

    // 如果提供了 compactor，使用渐进压缩管线
    if (this.compactor) {
      return this.consolidateWithCompactor(checkpoint, beforeSize, totalCount);
    }

    // 原有逻辑（无 compactor → LLM 整理）
    if (totalCount < this.threshold) {
      return {
        beforeSize,
        afterSize: beforeSize,
        mergedCount: 0,
        consolidated: checkpoint,
        summary: `记忆字段项数（${totalCount}）低于阈值（${this.threshold}），无需整理。`,
      };
    }

    // 触发 LLM 整理
    try {
      const request: LLMRequestOptions = {
        model: this.modelId,
        messages: [{
          role: 'user',
          content: this.buildPrompt(checkpoint),
        }],
        systemPrompt: [
          '你是一个记忆整理助手。',
          '对记忆数据进行去重、合并、精简。要求：',
          '- 完全相同的内容保留一份',
          '- 相似内容合并为更精炼的描述',
          '- 保留所有关键信息，不删除核心事实',
          '- 错误记录按主题归类',
          '只输出 JSON，不要其他内容。',
        ].join('\n'),
        maxTokens: 2000,
        temperature: 0.3,
      };

      const response = await this.client.complete(request);
      const consolidated = this.parseOutput(response.content, checkpoint);
      if (!consolidated) {
        return {
          beforeSize,
          afterSize: beforeSize,
          mergedCount: 0,
          consolidated: checkpoint,
          summary: 'LLM 输出解析失败，保持原状。',
        };
      }

      const afterSize = this.sizeOf(consolidated);
      const mergedCount = beforeSize - afterSize;

      return {
        beforeSize,
        afterSize,
        mergedCount,
        consolidated,
        summary: `整理完成: 字段项数从 ${beforeSize} → ${afterSize}（合并了 ${mergedCount} 项）`,
      };
    } catch (error) {
      logger.warn('Dream consolidate failed', { error: String(error) });
      return {
        beforeSize,
        afterSize: beforeSize,
        mergedCount: 0,
        consolidated: checkpoint,
        summary: `整理失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 使用 ContextCompactor 进行渐进压缩整理
   * 将 CheckpointData 转为消息列表 → 交给 compactor 压缩 → 报告阶段
   */
  private async consolidateWithCompactor(
    checkpoint: CheckpointData,
    beforeSize: number,
    totalCount: number,
  ): Promise<DreamResult> {
    const messages = this.checkpointToMessages(checkpoint);
    const { result: compactionResult } = await this.compactor!.compact(messages);
    const stages = this.stagesUpTo(compactionResult.maxStageReached);

    // L5 生成了摘要 → 直接使用
    if (compactionResult.summary) {
      return {
        beforeSize,
        afterSize: beforeSize, // checkpoint 结构不变，摘要单独存储
        mergedCount: 0,
        consolidated: checkpoint,
        summary: `渐进压缩完成（达到 L${compactionResult.maxStageReached}）：${compactionResult.summary}`,
        maxStageReached: compactionResult.maxStageReached,
        compactionStages: stages,
      };
    }

    // L1-L4 完成，未生成摘要
    if (totalCount < this.threshold) {
      return {
        beforeSize,
        afterSize: beforeSize,
        mergedCount: 0,
        consolidated: checkpoint,
        summary: `记忆项数（${totalCount}）低于阈值（${this.threshold}），压缩达到 L${compactionResult.maxStageReached}。`,
        maxStageReached: compactionResult.maxStageReached,
        compactionStages: stages,
      };
    }

    // L1-L4 压缩后仍超阈值但无 summarize 函数 → 降级到 LLM 整理
    try {
      const request: LLMRequestOptions = {
        model: this.modelId,
        messages: [{
          role: 'user',
          content: this.buildPrompt(checkpoint),
        }],
        systemPrompt: [
          '你是一个记忆整理助手。',
          '对记忆数据进行去重、合并、精简。要求：',
          '- 完全相同的内容保留一份',
          '- 相似内容合并为更精炼的描述',
          '- 保留所有关键信息，不删除核心事实',
          '- 错误记录按主题归类',
          '只输出 JSON，不要其他内容。',
        ].join('\n'),
        maxTokens: 2000,
        temperature: 0.3,
      };

      const response = await this.client.complete(request);
      const consolidated = this.parseOutput(response.content, checkpoint);
      if (!consolidated) {
        return {
          beforeSize,
          afterSize: beforeSize,
          mergedCount: 0,
          consolidated: checkpoint,
          summary: `LLM 输出解析失败，压缩达到 L${compactionResult.maxStageReached}。`,
          maxStageReached: compactionResult.maxStageReached,
          compactionStages: stages,
        };
      }

      const afterSize = this.sizeOf(consolidated);
      const mergedCount = beforeSize - afterSize;
      return {
        beforeSize,
        afterSize,
        mergedCount,
        consolidated,
        summary: `整理完成: ${beforeSize} → ${afterSize}（合并 ${mergedCount} 项），压缩达到 L${compactionResult.maxStageReached}。`,
        maxStageReached: compactionResult.maxStageReached,
        compactionStages: stages,
      };
    } catch (error) {
      logger.warn('Dream consolidate with compactor failed', { error: String(error) });
      return {
        beforeSize,
        afterSize: beforeSize,
        mergedCount: 0,
        consolidated: checkpoint,
        summary: `整理失败: ${error instanceof Error ? error.message : String(error)}，压缩达到 L${compactionResult.maxStageReached}。`,
        maxStageReached: compactionResult.maxStageReached,
        compactionStages: stages,
      };
    }
  }

  /** 将 CheckpointData 转为 LLMMessage 列表（供 compactor 处理） */
  private checkpointToMessages(cp: CheckpointData): LLMMessage[] {
    const messages: LLMMessage[] = [];
    // 核心信息作为 system 消息
    messages.push({
      role: 'system',
      content: `当前意图: ${cp.currentIntent}\n下一步: ${cp.nextAction}`,
    });
    // 工作约束
    if (cp.workingConstraints.length > 0) {
      messages.push({
        role: 'user',
        content: `工作约束:\n${cp.workingConstraints.map((c) => `- ${c}`).join('\n')}`,
      });
    }
    // 文件信息
    if (cp.currentWorkingFiles.length > 0 || cp.involvedFiles.length > 0) {
      messages.push({
        role: 'assistant',
        content: `当前文件: ${cp.currentWorkingFiles.join(', ')}\n涉及文件: ${cp.involvedFiles.join(', ')}`,
      });
    }
    // 跨任务发现
    if (cp.crossTaskDiscoveries.length > 0) {
      messages.push({
        role: 'user',
        content: `跨任务发现:\n${cp.crossTaskDiscoveries.map((d) => `- ${d}`).join('\n')}`,
      });
    }
    // 错误与修复
    if (cp.errorsAndFixes.length > 0) {
      messages.push({
        role: 'assistant',
        content: `错误与修复:\n${cp.errorsAndFixes.map((e) => `- ${e.error} → ${e.fix}`).join('\n')}`,
      });
    }
    // 设计决策
    if (cp.designDecisions.length > 0) {
      messages.push({
        role: 'user',
        content: `设计决策:\n${cp.designDecisions.map((d) => `- ${d.decision} (${d.reason})`).join('\n')}`,
      });
    }
    // 杂项笔记
    if (cp.miscNotes.length > 0) {
      messages.push({
        role: 'assistant',
        content: `杂项:\n${cp.miscNotes.map((n) => `- ${n}`).join('\n')}`,
      });
    }
    return messages;
  }

  /** 生成 1 到 maxStage 的阶段列表 */
  private stagesUpTo(max: 1 | 2 | 3 | 4 | 5): number[] {
    return Array.from({ length: max }, (_, i) => i + 1);
  }

  private sizeOf(cp: CheckpointData): number {
    return (
      (cp.currentIntent ? 1 : 0) +
      (cp.nextAction ? 1 : 0) +
      cp.workingConstraints.length +
      cp.currentWorkingFiles.length +
      cp.involvedFiles.length +
      cp.crossTaskDiscoveries.length +
      cp.errorsAndFixes.length +
      Object.keys(cp.runtimeState).length +
      cp.designDecisions.length +
      cp.miscNotes.length
    );
  }

  private totalItemCount(cp: CheckpointData): number {
    return this.sizeOf(cp);
  }

  private buildPrompt(cp: CheckpointData): string {
    return JSON.stringify(cp, null, 2);
  }

  private parseOutput(content: string, original: CheckpointData): CheckpointData | null {
    try {
      const extracted = this.extractJson(content);
      const parsed = JSON.parse(extracted);

      return {
        currentIntent: parsed.currentIntent ?? original.currentIntent,
        nextAction: parsed.nextAction ?? original.nextAction,
        workingConstraints: Array.isArray(parsed.workingConstraints) ? parsed.workingConstraints : original.workingConstraints,
        taskTree: parsed.taskTree ?? original.taskTree,
        currentWorkingFiles: Array.isArray(parsed.currentWorkingFiles) ? parsed.currentWorkingFiles : original.currentWorkingFiles,
        involvedFiles: Array.isArray(parsed.involvedFiles) ? parsed.involvedFiles : original.involvedFiles,
        crossTaskDiscoveries: Array.isArray(parsed.crossTaskDiscoveries) ? parsed.crossTaskDiscoveries : original.crossTaskDiscoveries,
        errorsAndFixes: Array.isArray(parsed.errorsAndFixes) ? parsed.errorsAndFixes : original.errorsAndFixes,
        runtimeState: typeof parsed.runtimeState === 'object' && parsed.runtimeState !== null ? parsed.runtimeState : original.runtimeState,
        designDecisions: Array.isArray(parsed.designDecisions) ? parsed.designDecisions : original.designDecisions,
        miscNotes: Array.isArray(parsed.miscNotes) ? parsed.miscNotes : original.miscNotes,
      };
    } catch {
      return null;
    }
  }

  private extractJson(content: string): string {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    return match ? match[1].trim() : content.trim();
  }

  /** 保存 dream 结果到磁盘 */
  async saveToDisk(checkpoint: CheckpointData, result: DreamResult): Promise<string> {
    const dir = path.join(getAppDataDir(), 'memory');
    ensureDir(dir);
    const filePath = path.join(dir, 'dream-result.json');
    const data = {
      checkpoint,
      summary: result.summary,
      beforeSize: result.beforeSize,
      afterSize: result.afterSize,
      timestamp: Date.now(),
    };
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return filePath;
  }
}
