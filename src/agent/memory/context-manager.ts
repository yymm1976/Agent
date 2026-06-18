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

import type { LLMMessage, ILLMClient } from '../../router/types.js';
import type { CheckpointData, ContextManagerConfig, CompressionResult } from './types.js';
import { CheckpointWriter } from './checkpoint-writer.js';
import type { CheckpointLevel } from './types.js';
import { logger } from '../../utils/logger.js';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { getAppDataDir, ensureDir } from '../../utils/paths.js';

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
   * @param _messageCount 当前对话历史条数（未使用，保留用于扩展）
   * @param estimatedTokens 估算的 token 数（简单按字符数 / 4 估算）
   */
  shouldCompress(_messageCount: number, estimatedTokens: number): boolean {
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
        role: 'system',
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
      const filePath = join(getAppDataDir(), 'memory', 'current-checkpoint.json');
      const content = await readFile(filePath, 'utf-8');
      this.currentCheckpoint = JSON.parse(content);
    } catch {
      // 文件不存在，忽略
    }
  }
}
