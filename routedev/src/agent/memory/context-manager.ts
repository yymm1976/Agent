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
//
// Phase 21 Task 5 增强：
//   - CompressionEvent 类型 + CompressionCallback 回调
//   - compressEnhanced() 方法：两轮压缩（offload 大输出 + 摘要老消息）
//   - system prompt 永不压缩
//   - 大工具输出（>2000 tokens）offload 到 .routedev/offloaded/

import type { LLMMessage, ILLMClient } from '../../router/types.js';
import type { CheckpointData, ContextManagerConfig, CompressionResult } from './types.js';
import { CheckpointWriter } from './checkpoint-writer.js';
import type { CheckpointLevel } from './types.js';
import { KnowledgeGraph } from './graph.js';
import type { GraphNode, GraphEdge, NodeType } from './graph.js';
import type { MemoryConfig } from '../../config/schema.js';
import { ContextCompactor } from '../context-compaction.js';
import { logger } from '../../utils/logger.js';
import { estimateTokens } from '../../utils/token-estimate.js';
import { join } from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { getAppDataDir, ensureDir } from '../../utils/paths.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Phase 21 Task 5：压缩事件类型
// ============================================================

/** 压缩事件（记录压缩前后的 token 变化和操作统计） */
export interface CompressionEvent {
  /** 压缩前 token 数 */
  tokensBefore: number;
  /** 压缩后 token 数 */
  tokensAfter: number;
  /** 被摘要替换的消息数 */
  messagesCompressed: number;
  /** 被 offload 的大工具输出数 */
  offloadedOutputs: number;
  /** 事件时间戳 */
  timestamp: number;
}

/** 压缩回调函数类型 */
export type CompressionCallback = (event: CompressionEvent) => void;

/** compressEnhanced 方法的选项 */
export interface CompressEnhancedOptions {
  /** 最大 token 数（默认为 contextWindow * 0.8） */
  maxTokens?: number;
  /** offload 目录（默认为 .routedev/offloaded/） */
  offloadDir?: string;
  /** 保留最近的 N 条消息（默认 6） */
  preserveLast?: number;
  /** 触发 offload 的工具输出 token 阈值（默认 2000） */
  offloadThreshold?: number;
}

export class ContextManager {
  private config: ContextManagerConfig;
  private writer: CheckpointWriter;
  private currentCheckpoint: CheckpointData | null = null;
  /** 已触发的 checkpoint 级别（避免重复触发） */
  private triggeredLevels: Set<CheckpointLevel> = new Set();
  /** 知识图谱（每次 checkpoint 时增量更新） */
  private knowledgeGraph: KnowledgeGraph = new KnowledgeGraph();
  /** 可选的上下文压缩器（提供后支持渐进压缩） */
  private compactor: ContextCompactor | null = null;
  /** Phase 21 Task 5：压缩回调列表 */
  private compressionCallbacks: CompressionCallback[] = [];
  /** Phase 38 Task 4.2：图谱持久化 throttle 定时器 */
  private graphSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** C5 修复：trailing flush 标记——throttle 窗口内有新更新时为 true */
  private graphSavePending = false;
  /** Phase 38 Task 4.2：throttle 延迟（毫秒） */
  private static readonly GRAPH_SAVE_DEBOUNCE_MS = 500;
  /** Phase 45：记忆配置（推理/自动学习/注入阈值） */
  private memoryConfig: MemoryConfig;

  constructor(config: ContextManagerConfig, writer: CheckpointWriter) {
    this.config = config;
    this.writer = writer;
    this.memoryConfig = config.memory ?? { inference: true, autoLearn: true, injectThreshold: 0.7 };
    // Phase 38 Task 4.2：从磁盘加载知识图谱
    this.loadGraphFromDisk();
  }

  /** 设置上下文压缩器（启用 compactIfNeeded 功能） */
  setCompactor(compactor: ContextCompactor): void {
    this.compactor = compactor;
  }

  /** Phase 21 Task 5：注册压缩回调 */
  onCompression(callback: CompressionCallback): void {
    this.compressionCallbacks.push(callback);
  }

  /** Phase 21 Task 5：移除压缩回调 */
  offCompression(callback: CompressionCallback): void {
    this.compressionCallbacks = this.compressionCallbacks.filter(cb => cb !== callback);
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
      // 增量更新知识图谱（从 checkpoint 提取关键事实）
      this.ingestCheckpointToGraph(output.checkpoint);
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

  // ============================================================
  // Phase 21 Task 5：增强压缩（两轮 + offload + 回调）
  // ============================================================

  /**
   * 增强压缩：两轮压缩 + 大工具输出 offload
   *
   * 压缩优先级（从先到后）：
   *   1. system prompt 永不压缩
   *   2. 第一轮：offload 大工具输出（>offloadThreshold tokens）到 offloadDir
   *   3. 第二轮：从最老消息开始摘要替换，保留 system prompt 和最后 preserveLast 条
   *
   * @param messages 原始消息列表
   * @param options 压缩选项
   * @returns 压缩后的消息列表和压缩事件
   */
  async compressEnhanced(
    messages: LLMMessage[],
    options?: CompressEnhancedOptions,
  ): Promise<{ compressed: LLMMessage[]; result: CompressionEvent }> {
    const maxTokens = options?.maxTokens ?? Math.floor(this.config.contextWindow * 0.8);
    const preserveLast = options?.preserveLast ?? 6;
    const offloadThreshold = options?.offloadThreshold ?? 2000;
    const offloadDir = options?.offloadDir;

    const tokensBefore = this.estimateTotalTokens(messages);

    // 未超阈值 → 不压缩，返回 no-op 事件
    if (tokensBefore <= maxTokens) {
      const noOpEvent: CompressionEvent = {
        tokensBefore,
        tokensAfter: tokensBefore,
        messagesCompressed: 0,
        offloadedOutputs: 0,
        timestamp: Date.now(),
      };
      return { compressed: messages, result: noOpEvent };
    }

    let messagesCompressed = 0;
    let offloadedOutputs = 0;
    const result = [...messages];

    // 第一轮：offload 大工具输出（>offloadThreshold tokens）
    for (let i = 0; i < result.length; i++) {
      const msg = result[i];
      // 只处理 tool 角色或包含 tool_result 的消息
      const content = this.extractTextContent(msg);
      const tokenCount = this.estimateTokens(content);

      if (tokenCount > offloadThreshold && this.isToolMessage(msg)) {
        // offload 到文件（如果提供了 offloadDir）
        if (offloadDir) {
          try {
            await this.offloadToFile(content, offloadDir, i);
          } catch (error) {
            logger.warn('Failed to offload tool output', {
              index: i,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        // 替换为摘要占位符
        const preview = content.slice(0, 200);
        result[i] = {
          ...msg,
          content: this.replaceTextContent(msg, `[offloaded] ${preview}...`),
        };
        offloadedOutputs++;
      }
    }

    // 第二轮：从最老消息开始摘要替换，保留 system prompt (i=0) 和最后 preserveLast 条
    // system prompt 永不压缩
    for (
      let i = 1;
      i < result.length - preserveLast && this.estimateTotalTokens(result) > maxTokens;
      i++
    ) {
      const msg = result[i];
      // system 消息不压缩（虽然 i=0 已跳过，但中间也可能有 system 消息）
      if (msg.role === 'system') continue;

      const content = this.extractTextContent(msg);
      // 已被 offload 的消息不再摘要
      if (content.startsWith('[offloaded]')) continue;

      const preview = content.slice(0, 100);
      result[i] = {
        ...msg,
        content: this.replaceTextContent(msg, `[已压缩] ${preview}...`),
      };
      messagesCompressed++;
    }

    const tokensAfter = this.estimateTotalTokens(result);
    const event: CompressionEvent = {
      tokensBefore,
      tokensAfter,
      messagesCompressed,
      offloadedOutputs,
      timestamp: Date.now(),
    };

    // 触发回调
    for (const cb of this.compressionCallbacks) {
      try {
        cb(event);
      } catch (error) {
        logger.warn('Compression callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Context compressed (enhanced)', {
      tokensBefore,
      tokensAfter,
      messagesCompressed,
      offloadedOutputs,
    });

    return { compressed: result, result: event };
  }

  /** 估算消息列表的总 token 数 */
  private estimateTotalTokens(messages: LLMMessage[]): number {
    return messages.reduce((sum, msg) => {
      return sum + this.estimateTokens(this.extractTextContent(msg));
    }, 0);
  }

  /** 估算单条文本的 token 数（复用中文感知函数） */
  private estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  /** 从消息中提取文本内容（支持 string 和 ContentPart[]） */
  private extractTextContent(msg: LLMMessage): string {
    if (typeof msg.content === 'string') {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .map(part => {
          if (part.type === 'text') return part.text;
          if (part.type === 'tool_result') return part.content;
          if (part.type === 'tool_use') return JSON.stringify(part.arguments);
          return '';
        })
        .join('');
    }
    return '';
  }

  /** 替换消息的文本内容（保持消息结构） */
  private replaceTextContent(msg: LLMMessage, newContent: string): string | LLMMessage['content'] {
    // 如果原内容是字符串，直接替换
    if (typeof msg.content === 'string') {
      return newContent;
    }
    // 如果原内容是 ContentPart[]，替换 text 和 tool_result 的内容
    if (Array.isArray(msg.content)) {
      const replaced = msg.content.map(part => {
        if (part.type === 'text') return { ...part, text: newContent };
        if (part.type === 'tool_result') return { ...part, content: newContent };
        return part;
      });
      return replaced;
    }
    return newContent;
  }

  /** 判断是否为工具相关消息（tool_result 或包含 tool_use） */
  private isToolMessage(msg: LLMMessage): boolean {
    if (typeof msg.content !== 'string') {
      return Array.isArray(msg.content) && msg.content.some(
        part => part.type === 'tool_result' || part.type === 'tool_use',
      );
    }
    // 字符串内容：检查是否像工具输出（含 tool_result 标记）
    return false;
  }

  /** 将大工具输出 offload 到文件 */
  private async offloadToFile(
    content: string,
    offloadDir: string,
    index: number,
  ): Promise<void> {
    await mkdir(offloadDir, { recursive: true });
    const filename = `output-${index}-${Date.now()}.txt`;
    const filepath = join(offloadDir, filename);
    await writeFile(filepath, content, 'utf-8');
    logger.debug('Tool output offloaded', { filepath, size: content.length });
  }

  /**
   * 如果上下文超过阈值，使用 ContextCompactor 进行渐进压缩
   * 需要先通过 setCompactor() 设置压缩器，否则原样返回
   * @param messages 当前消息列表
   * @returns 压缩后的消息列表及压缩信息
   */
  async compactIfNeeded(
    messages: LLMMessage[],
  ): Promise<{
    messages: LLMMessage[];
    compacted: boolean;
    maxStageReached?: 1 | 2 | 3 | 4 | 5;
    beforeTokens?: number;
    afterTokens?: number;
  }> {
    // 未设置压缩器 → 原样返回
    if (!this.compactor) {
      return { messages, compacted: false };
    }

    // 估算当前 token 数（使用中文感知的 estimateTokens 函数）
    const estimatedTokens = messages.reduce((sum, msg) => {
      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : '')).join('')
          : '';
      return sum + estimateTokens(text);
    }, 0);

    // 未超阈值 → 不压缩
    if (!this.shouldCompress(messages.length, estimatedTokens)) {
      return { messages, compacted: false };
    }

    // 调用渐进压缩管线
    const { messages: compacted, result } = await this.compactor.compact(messages);
    logger.info('Context compacted by ContextCompactor', {
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      maxStageReached: result.maxStageReached,
    });
    return {
      messages: compacted,
      compacted: true,
      maxStageReached: result.maxStageReached,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    };
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

  /**
   * 召回相关记忆：用知识图谱的双路径召回按查询相关性排序记忆
   * Phase 45：根据 config.memory.inference 控制是否启用推理，
   * 并根据 config.memory.injectThreshold 过滤低于阈值的记忆节点。
   * @param query 查询字符串（按关键词匹配）
   * @returns 召回的节点列表（按分数降序）
   */
  recallMemories(query: string): Array<{ node: GraphNode; score: number; path: 'precise' | 'generalized' | 'both' }> {
    // 禁用推理时不返回任何记忆
    if (!this.memoryConfig.inference) {
      return [];
    }
    const memories = this.knowledgeGraph.recall(query);
    // 应用注入阈值过滤，只返回相关度足够的记忆
    return memories.filter(m => m.score >= this.memoryConfig.injectThreshold);
  }

  /** 获取内部知识图谱（用于测试和 DreamConsolidator 共享） */
  getKnowledgeGraph(): KnowledgeGraph {
    return this.knowledgeGraph;
  }

  // ============================================================
  // Phase 38 Task 4.2：知识图谱持久化
  // ============================================================

  /** 知识图谱持久化文件路径 */
  private getGraphPath(): string {
    const cwd = this.config.cwd ?? '.';
    return path.join(cwd, '.routedev', 'memory', 'knowledge-graph.json');
  }

  /** 从磁盘加载知识图谱（文件不存在或损坏时保持空图谱） */
  private loadGraphFromDisk(): void {
    const graphPath = this.getGraphPath();
    try {
      const data = fs.readFileSync(graphPath, 'utf-8');
      this.knowledgeGraph = KnowledgeGraph.fromJSON(data);
      logger.debug('知识图谱已从磁盘加载', { path: graphPath });
    } catch {
      // 文件不存在或损坏，保持空图谱
    }
  }

  /**
   * 保存知识图谱到磁盘（C5 修复：throttle + trailing flush）
   *
   * C5 修复：原 debounce 在快速连续更新时会丢失中间数据（每次调用都重置定时器，
   * 导致持续更新时永不保存）。改为 throttle + trailing flush：
   *   - leading edge：首次调用启动 500ms 定时器
   *   - throttle 窗口内的后续调用标记 pending，不重置定时器
   *   - 定时器触发后执行保存，若 pending 为 true 则再启动一轮（trailing flush）
   * 这样确保：1) 每 500ms 至多保存一次（不频繁写入）2) 最后一次更新一定被保存
   *
   * 保存时机：
   *   - improve() 后
   *   - forget() 后
   *   - ingestToGraph() 后（在 /dream handler 中触发）
   *   - 会话结束 hook 中
   */
  saveGraphToDisk(): void {
    // throttle：定时器已运行时，标记 pending（trailing flush 会处理）
    if (this.graphSaveTimer) {
      this.graphSavePending = true;
      return;
    }
    // leading edge：启动定时器
    this.graphSaveTimer = setTimeout(() => {
      this.doSaveGraphToDisk();
      this.graphSaveTimer = null;
      // trailing flush：throttle 窗口内有新更新，再保存一次确保最终状态落地
      if (this.graphSavePending) {
        this.graphSavePending = false;
        this.saveGraphToDisk();
      }
    }, ContextManager.GRAPH_SAVE_DEBOUNCE_MS);
  }

  /** 立即同步保存（跳过 throttle，用于会话结束等必须落地的场景） */
  flushGraphToDisk(): void {
    if (this.graphSaveTimer) {
      clearTimeout(this.graphSaveTimer);
      this.graphSaveTimer = null;
    }
    this.graphSavePending = false;
    this.doSaveGraphToDisk();
  }

  /** 实际执行保存 */
  private doSaveGraphToDisk(): void {
    const graphPath = this.getGraphPath();
    try {
      fs.mkdirSync(path.dirname(graphPath), { recursive: true });
      fs.writeFileSync(graphPath, this.knowledgeGraph.toJSON(), 'utf-8');
      logger.debug('知识图谱已保存到磁盘', { path: graphPath });
    } catch (e) {
      logger.warn('保存知识图谱失败', { error: String(e) });
    }
  }

  /**
   * 从 CheckpointData 提取关键事实，作为 GraphNode 添加到知识图谱
   * - currentIntent / nextAction → fact
   * - workingConstraints → fact
   * - crossTaskDiscoveries → fact
   * - errorsAndFixes → event
   * - designDecisions → decision
   * - miscNotes → fact
   * 同 ID 节点会更新 validatedCount + updatedAt
   *
   * Phase 45：根据 config.memory.autoLearn 控制是否自动从 checkpoint 学习。
   * 关闭时直接跳过，避免自动污染知识图谱。
   */
  private ingestCheckpointToGraph(cp: CheckpointData): void {
    // 自动学习关闭时不从 checkpoint 提取知识
    if (!this.memoryConfig.autoLearn) {
      return;
    }
    const now = Date.now();
    const added: GraphNode[] = [];

    // 工具：构造或更新节点（同 ID 累加 validatedCount）
    const upsertNode = (id: string, type: NodeType, content: string): GraphNode => {
      const existing = this.knowledgeGraph.getNode(id);
      if (existing) {
        existing.validatedCount += 1;
        existing.updatedAt = now;
        if (existing.deprecated) existing.deprecated = false;
        return existing;
      }
      const node: GraphNode = {
        id,
        type,
        content,
        validatedCount: 1,
        createdAt: now,
        updatedAt: now,
        deprecated: false,
      };
      this.knowledgeGraph.addNode(node);
      added.push(node);
      return node;
    };

    // 简单确定性 ID：type + 内容哈希（避免重复添加同一条事实）
    const makeId = (type: string, content: string): string => {
      return `${type}:${content.slice(0, 64)}`;
    };

    // 1. 当前意图 + 下一步动作 → fact 节点，互相 relates_to
    if (cp.currentIntent) {
      const intentNode = upsertNode(makeId('intent', cp.currentIntent), 'fact', `意图: ${cp.currentIntent}`);
      if (cp.nextAction) {
        const actionNode = upsertNode(makeId('action', cp.nextAction), 'fact', `下一步: ${cp.nextAction}`);
        this.addEdgeSafe(intentNode.id, actionNode.id, 'relates_to');
      }
    }

    // 2. 工作约束 → fact
    for (const c of cp.workingConstraints) {
      upsertNode(makeId('constraint', c), 'fact', `约束: ${c}`);
    }

    // 3. 跨任务发现 → fact
    for (const d of cp.crossTaskDiscoveries) {
      upsertNode(makeId('discovery', d), 'fact', `发现: ${d}`);
    }

    // 4. 错误与修复 → event
    for (const ef of cp.errorsAndFixes) {
      const errNode = upsertNode(makeId('error', ef.error), 'event', `错误: ${ef.error}`);
      const fixNode = upsertNode(makeId('fix', ef.fix), 'event', `修复: ${ef.fix}`);
      this.addEdgeSafe(errNode.id, fixNode.id, 'derived_from');
    }

    // 5. 设计决策 → decision
    for (const dd of cp.designDecisions) {
      upsertNode(makeId('decision', dd.decision), 'decision', `决策: ${dd.decision}（理由: ${dd.reason}）`);
    }

    // 6. 杂项笔记 → fact
    for (const note of cp.miscNotes) {
      upsertNode(makeId('note', note), 'fact', `笔记: ${note}`);
    }

    // 7. 涉及文件 → fact，与意图 relates_to
    if (cp.currentIntent) {
      const intentId = makeId('intent', cp.currentIntent);
      for (const file of cp.involvedFiles) {
        const fileNode = upsertNode(makeId('file', file), 'fact', `文件: ${file}`);
        this.addEdgeSafe(intentId, fileNode.id, 'relates_to');
      }
    }
  }

  /** 安全添加边（端点存在才加） */
  private addEdgeSafe(source: string, target: string, type: GraphEdge['type']): void {
    if (source === target) return;
    const edge: GraphEdge = { source, target, type, weight: 1 };
    this.knowledgeGraph.addEdge(edge);
  }
}
