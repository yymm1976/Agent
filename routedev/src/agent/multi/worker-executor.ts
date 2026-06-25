// src/agent/multi/worker-executor.ts
// WorkerExecutor：执行单个步骤，注入角色 system prompt + Blackboard 上下文
//
// Phase 21 Task 3：用 executeWorkerIsolated 包装核心执行逻辑
//   - Worker 崩溃不上溯，异常转结构化 WorkerOutcome
//   - 可重试错误（timeout/llm_error/tool_failure）自动重试
//   - 不可重试错误（permission_denied/unknown）立即返回失败
//
// Phase 35 Task 1：Worker 上下文选择性传递
//   - filterContext() 在 execute() 内部对 conversationHistory 做角色感知过滤
//   - 三种策略：tail（默认）+ keyword + budget
//   - 配置开关 optimization.workerContext，关闭时回退到完整历史透传（向后兼容）
//   - Blackboard 的 completedSteps 通过 systemPrompt 注入，不依赖 conversationHistory
//
// Phase 36 Task 2：任务感知上下文裁剪（SWE-Pruner 启发）
//   - classifyInfoValue()：过滤前先对消息做三分类（该扔/该缓存/该存）
//   - declareFocus()：从 task.description 提取关注点关键词（纯文本处理，不调用 LLM）
//   - filterContext() 增强：先丢弃"该扔"类消息，再用 focusKeywords 计算相关性分数

import type {
  ILLMClient,
  LLMMessage,
  ContentPart,
  RoutingResult,
} from '../../router/types.js';
import type { ReActAgentLoop } from '../loop.js';
import type {
  ConfirmToolCallback,
} from '../loop-config.js';
import type { WorkerTask, WorkerResult } from './types.js';
import { WORKER_ROLE_PROMPTS, executeWorkerIsolated, type WorkerFunction } from './orchestrator.js';
import { logger } from '../../utils/logger.js';
import type { WorkerContextConfig } from '../../config/schema.js';
import { estimateTokens } from '../../utils/token-estimate.js';

/** 默认 Worker 上下文配置（未注入 config 时使用） */
const DEFAULT_WORKER_CONTEXT_CONFIG: WorkerContextConfig = {
  enabled: true,
  strategy: 'tail',
  maxMessages: 5,
  maxTokens: 4000,
  fallbackToFull: true,
};

export interface WorkerExecutorOptions {
  agentLoop: ReActAgentLoop;
  /** Phase 35 Task 1：上下文过滤配置（可选，未传则用默认值） */
  workerContextConfig?: WorkerContextConfig;
}

export class WorkerExecutor {
  private agentLoop: ReActAgentLoop;
  private readonly workerContextConfig: WorkerContextConfig;
  /**
   * I13 修复：rollback 互斥锁
   * Promise-based mutex——确保同一时刻只有一个 rollback 操作在执行，
   * 避免多个 Worker 并发重试时 rollback 竞态导致状态不一致
   */
  private rollbackMutex: Promise<void> = Promise.resolve();

  constructor(agentLoop: ReActAgentLoop, options?: WorkerExecutorOptions) {
    this.agentLoop = agentLoop;
    // 兼容旧签名：WorkerExecutor(agentLoop) 也能工作
    this.workerContextConfig = options?.workerContextConfig ?? DEFAULT_WORKER_CONTEXT_CONFIG;
  }

  /**
   * I13 修复：Promise-based 互斥锁包装器
   * 确保传入的异步操作串行执行，避免 rollback 竞态
   */
  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    // 等待前一个锁释放
    const previous = this.rollbackMutex;
    let release!: () => void;
    this.rollbackMutex = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * C4 修复：Worker 重试前回滚
   *
   * 问题：Worker 执行失败后重试时，上一次尝试产生的部分修改（文件写入、工具副作用）
   * 未被清理，导致重试基于脏状态执行，可能产生不一致结果。
   *
   * 修复：在每次重试前调用此方法，清理上一次尝试的中间状态：
   *   1. 记录上一次尝试修改的文件（用于审计/调试）
   *   2. 重置闭包捕获的状态变量
   *   3. 实际文件回滚需调用方接入 git stash/revert（此处仅清理内存状态）
   *
   * I13 修复：使用 Promise-based mutex 保护，避免并发 rollback 竞态
   *
   * @param workerId Worker 标识（用于日志）
   * @param attemptNumber 当前尝试序号（0=首次，1=第一次重试...）
   * @param modifiedFiles 上一次尝试修改的文件列表
   * @param stateReset 状态重置回调（重置闭包变量）
   */
  private async rollbackBeforeRetry(
    workerId: string,
    attemptNumber: number,
    modifiedFiles: string[],
    stateReset: () => void,
  ): Promise<void> {
    await this.withMutex(async () => {
      logger.warn('Worker rollback before retry', {
        workerId,
        attemptNumber,
        modifiedFilesCount: modifiedFiles.length,
        modifiedFiles: modifiedFiles.slice(0, 10), // 仅记录前 10 个，避免日志膨胀
      });
      // 重置闭包状态变量，确保重试从干净状态开始
      stateReset();
    });
  }

  /**
   * 执行一个 Worker 任务
   *
   * Phase 21 Task 3：内部用 executeWorkerIsolated 包装实际执行逻辑，
   * 实现异常隔离 + 自动重试。公共签名保持不变（向后兼容）。
   *
   * Phase 35 Task 1：在传给 agentLoop.run() 之前调用 filterContext() 过滤 conversationHistory，
   * 避免给每个 Worker 都传递完整 20 条消息（token 浪费）。
   * Blackboard 的 completedSteps 通过 systemPrompt 注入，过滤不影响协作上下文可见性。
   */
  async execute(
    task: WorkerTask,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    conversationHistory: LLMMessage[],
    baseSystemPrompt: string,
    signal?: AbortSignal,
    onConfirmTool?: ConfirmToolCallback,
  ): Promise<WorkerResult> {
    const rolePrompt = task.rolePrompt || WORKER_ROLE_PROMPTS[task.role];
    const blackboardContext = this.formatBlackboard(task.blackboardSnapshot);

    const enhancedPrompt = [
      baseSystemPrompt,
      '',
      `## 你的角色: ${task.role}`,
      rolePrompt,
      '',
      '## 当前协作上下文',
      blackboardContext,
    ].join('\n');

    // Phase 35 Task 1：对 conversationHistory 做角色感知过滤
    // 过滤逻辑在 execute() 内部，调用方无需预先过滤（避免双重过滤）
    const filteredHistory = this.filterContext(task, conversationHistory);

    // 闭包变量：捕获每次执行尝试的中间状态（重试时会重置）
    let capturedModifiedFiles: string[] = [];
    let capturedInputTokens = 0;
    let capturedOutputTokens = 0;
    // C4 修复：跟踪尝试次数，首次调用为 0，重试时递增
    let attemptNumber = 0;

    // 核心执行函数：返回 conclusion 字符串，失败时抛出（由 executeWorkerIsolated 捕获）
    const workerFn: WorkerFunction = async (_workerId, _t) => {
      // C4 修复：重试前回滚上一次尝试的中间状态
      if (attemptNumber > 0) {
        await this.rollbackBeforeRetry(
          `worker-${task.stepId}-${task.role}`,
          attemptNumber,
          capturedModifiedFiles,
          () => {
            capturedModifiedFiles = [];
            capturedInputTokens = 0;
            capturedOutputTokens = 0;
          },
        );
      }
      attemptNumber++;

      let responseText = '';
      // 每次尝试前重置闭包变量
      capturedModifiedFiles = [];
      capturedInputTokens = 0;
      capturedOutputTokens = 0;

      for await (const event of this.agentLoop.run({
        userMessage: task.description,
        llmClient,
        routeDecision,
        conversationHistory: filteredHistory,
        systemPrompt: enhancedPrompt,
        signal,
        onConfirmTool,
      })) {
        switch (event.type) {
          case 'text_delta':
            responseText += event.text;
            break;
          case 'tool_call_result':
            if (event.toolName.includes('file_') || event.toolName.includes('git_')) {
              // 全局匹配文件路径，过滤版本号等非路径项
              const fileMatches = event.result.matchAll(/(?:[\w./-]+\/)*[\w-]+\.\w{1,5}/g);
              for (const m of fileMatches) {
                const f = m[0];
                // 排除纯数字版本号、无字母扩展名等
                if (/[a-zA-Z]/.test(f) && !/^\d+(\.\d+)+$/.test(f) && !capturedModifiedFiles.includes(f)) {
                  capturedModifiedFiles.push(f);
                }
              }
            }
            break;
          case 'done':
            if (event.content) responseText = event.content;
            if (event.usage) {
              capturedInputTokens = event.usage.inputTokens;
              capturedOutputTokens = event.usage.outputTokens;
            }
            break;
        }
      }

      return responseText.length > 200
        ? responseText.slice(0, 200) + '...'
        : responseText;
    };

    // 用 executeWorkerIsolated 包装：异常隔离 + 自动重试
    const workerId = `worker-${task.stepId}-${task.role}`;
    const outcome = await executeWorkerIsolated(workerId, task, workerFn);

    if (outcome.success) {
      return {
        stepId: task.stepId,
        role: task.role,
        success: true,
        conclusion: outcome.result,
        modifiedFiles: capturedModifiedFiles,
        tokenUsage: { inputTokens: capturedInputTokens, outputTokens: capturedOutputTokens },
      };
    }

    // 失败：异常已被隔离为结构化 WorkerError
    logger.error('Worker execution failed (isolated)', {
      stepId: task.stepId,
      workerId,
      errorType: outcome.error.type,
      error: outcome.error.message,
      retryCount: outcome.error.retryCount,
    });
    return {
      stepId: task.stepId,
      role: task.role,
      success: false,
      conclusion: `执行失败: ${outcome.error.message}`,
      modifiedFiles: [],
      tokenUsage: { inputTokens: capturedInputTokens, outputTokens: capturedOutputTokens },
    };
  }

  /**
   * Phase 35 Task 1 + Phase 36 Task 2：对 conversationHistory 做任务感知过滤
   *
   * Phase 35 三种策略：
   *   - tail：保留最近 N 条消息（默认 5 条），简单可预测
   *   - keyword：从 task.description 提取关键词，保留包含关键词的消息
   *   - budget：从最新消息向前累积，超出 token 预算则停止
   *
   * Phase 36 Task 2 增强（在策略执行前）：
   *   步骤零：classifyInfoValue() 三分类——丢弃"该扔"类消息（纯工具原始输出）
   *   步骤一：declareFocus() 从 task.description 提取关注点关键词
   *   步骤二：策略执行时使用 focusKeywords 计算相关性分数（M/N 方案）
   *
   * 关键约束：
   *   1. 当前 userMessage（task.description）由 agentLoop.run() 单独传入，不在 conversationHistory 中
   *   2. Blackboard 的 completedSteps 通过 systemPrompt 注入，过滤不影响协作上下文
   *   3. 关闭过滤（enabled=false）时回退到完整历史透传（向后兼容）
   *
   * @param task Worker 任务（提供 description 用于关键词提取）
   * @param conversationHistory 完整对话历史
   * @returns 过滤后的消息数组（不包含当前 userMessage）
   */
  filterContext(task: WorkerTask, conversationHistory: LLMMessage[]): LLMMessage[] {
    // 关闭过滤：完整历史透传（向后兼容）
    if (!this.workerContextConfig.enabled) {
      return conversationHistory;
    }

    // 空历史或单条历史：无需过滤
    if (conversationHistory.length <= 1) {
      return [...conversationHistory];
    }

    try {
      // Phase 36 Task 2 步骤零：三分类——丢弃"该扔"类消息
      const classified = this.classifyAndPrune(conversationHistory);

      // Phase 36 Task 2 步骤一：提取关注点关键词
      const focusKeywords = this.declareFocus(task.description);

      // Phase 36 Task 2 步骤二：策略执行（keyword 策略使用 focusKeywords）
      const filtered = this.applyFilterStrategy(task, classified, focusKeywords);
      logger.debug('Worker context filtered', {
        strategy: this.workerContextConfig.strategy,
        before: conversationHistory.length,
        afterClassify: classified.length,
        after: filtered.length,
        focusKeywords: focusKeywords.length,
        stepId: task.stepId,
        role: task.role,
      });
      return filtered;
    } catch (err) {
      // 过滤异常时回退到完整历史（fallbackToFull 默认 true）
      if (this.workerContextConfig.fallbackToFull) {
        logger.warn('Worker context filter failed, falling back to full history', {
          error: err instanceof Error ? err.message : String(err),
          stepId: task.stepId,
        });
        return conversationHistory;
      }
      throw err;
    }
  }

  /**
   * 根据配置策略应用过滤
   * Phase 36 Task 2：keyword 策略使用 focusKeywords 计算相关性分数
   */
  private applyFilterStrategy(
    task: WorkerTask,
    history: LLMMessage[],
    focusKeywords: string[],
  ): LLMMessage[] {
    const strategy = this.workerContextConfig.strategy;

    switch (strategy) {
      case 'tail':
        return this.filterByTail(history);

      case 'keyword':
        return this.filterByKeyword(task, history, focusKeywords);

      case 'budget':
        return this.filterByBudget(history);

      default:
        // 未知策略回退到 tail
        return this.filterByTail(history);
    }
  }

  /**
   * 策略 A：Tail + Blackboard 注入
   * 只保留最近 N 条消息（默认 5 条）
   * Blackboard 的 completedSteps 已通过 systemPrompt 注入，不依赖 conversationHistory
   */
  private filterByTail(history: LLMMessage[]): LLMMessage[] {
    const maxMessages = this.workerContextConfig.maxMessages;
    if (history.length <= maxMessages) {
      return [...history];
    }
    return history.slice(-maxMessages);
  }

  /**
   * 策略 B：关键词相关性过滤（Phase 36 Task 2 增强）
   *
   * Phase 35：从 task.description 提取关键词，保留包含关键词的消息
   * Phase 36 Task 2：使用 declareFocus() 提取的 focusKeywords 计算相关性分数（M/N 方案）
   *   - 分数 = 消息包含的关键词数 / 总关键词数
   *   - 分数 >= 阈值（默认 0.2）的消息保留
   *   - 至少保留最近 2 条消息，避免过滤太激进丢失必要背景
   *
   * @param task Worker 任务（保留用于向后兼容，实际关键词由 focusKeywords 参数提供）
   * @param history 已经过三分类过滤的消息
   * @param focusKeywords declareFocus() 提取的关注点关键词
   */
  private filterByKeyword(
    task: WorkerTask,
    history: LLMMessage[],
    focusKeywords: string[],
  ): LLMMessage[] {
    // 优先使用 declareFocus 提取的 focusKeywords，回退到 extractKeywords
    const keywords = focusKeywords.length > 0
      ? focusKeywords
      : this.extractKeywords(task.description);

    if (keywords.length === 0) {
      // 无关键词可提取：回退到 tail 策略
      return this.filterByTail(history);
    }

    // 计算每条消息的相关性分数（M/N 方案）
    const RELEVANCE_THRESHOLD = 0.2;
    const scored: Array<{ msg: LLMMessage; score: number }> = [];
    for (const msg of history) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const matchedCount = keywords.filter(kw => content.includes(kw)).length;
      const score = matchedCount / keywords.length;
      scored.push({ msg, score });
    }

    // 保留分数 >= 阈值的消息，保持原始顺序
    const matched = scored.filter(s => s.score >= RELEVANCE_THRESHOLD).map(s => s.msg);

    // 至少保留最近 2 条消息（避免过滤太激进）
    if (matched.length < 2) {
      return this.filterByTail(history);
    }

    return matched;
  }

  /**
   * 策略 C：Token 预算裁剪
   * 从最新消息开始向前累积，超出预算则停止
   */
  private filterByBudget(history: LLMMessage[]): LLMMessage[] {
    const maxTokens = this.workerContextConfig.maxTokens;
    const result: LLMMessage[] = [];
    let usedTokens = 0;

    // 从最新消息向前遍历
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const msgTokens = estimateTokens(content);

      if (usedTokens + msgTokens > maxTokens) {
        break;
      }
      result.unshift(msg);
      usedTokens += msgTokens;
    }

    // 至少保留 1 条消息（最新的）
    if (result.length === 0 && history.length > 0) {
      result.push(history[history.length - 1]);
    }

    return result;
  }

  /**
   * Phase 36 Task 2 步骤零：信息价值三分类
   *
   * 来自《7 步设计 Agent 记忆系统》——在裁剪之前先对消息做三分类：
   *   - 该扔：能从外部重新推导的信息（纯工具返回的原始数据）
   *   - 该缓存：短期高价值（当前任务上下文、推理中间步骤）
   *   - 该存：不可推导的信息（架构决策、bug 根因）
   *
   * 最保守版本：只有纯工具原始输出（content 全部为 tool_result 类型）归入"该扔"，
   * 其余全部归入"该缓存"。"该存"暂不区分（宁严勿松，减少误删风险）。
   *
   * @param history 完整对话历史
   * @returns 过滤掉"该扔"类消息后的历史
   */
  private classifyAndPrune(history: LLMMessage[]): LLMMessage[] {
    return history.filter(msg => {
      const classification = this.classifyInfoValue(msg);
      // "该扔"类消息直接丢弃，"该缓存"和"该存"保留
      return classification !== 'discard';
    });
  }

  /**
   * 对单条消息做信息价值分类
   *
   * 判断规则（最保守版本）：
   *   - content 是 ContentPart[] 且所有部分都是 tool_result → discard（该扔）
   *   - 其余 → cache（该缓存）
   *
   * @param msg 单条 LLM 消息
   * @returns 'discard' | 'cache' | 'persist'
   */
  private classifyInfoValue(msg: LLMMessage): 'discard' | 'cache' | 'persist' {
    // content 是字符串：一定不是纯工具输出 → cache
    if (typeof msg.content === 'string') {
      return 'cache';
    }

    // content 是 ContentPart[]：检查是否全部为 tool_result
    const parts = msg.content as ContentPart[];
    if (!Array.isArray(parts) || parts.length === 0) {
      return 'cache';
    }

    // 所有部分都是 tool_result 类型 → discard（纯工具原始输出）
    const allToolResults = parts.every(p => p.type === 'tool_result');
    if (allToolResults) {
      return 'discard';
    }

    // 混合内容（如 tool_result + text）→ cache
    return 'cache';
  }

  /**
   * Phase 36 Task 2 步骤一：关注点声明
   *
   * 来自 SWE-Pruner 论文——从 task.description 提取 3-5 个关注点关键词。
   * 纯文本处理，不调用 LLM（零额外 token 成本）。
   *
   * 提取策略：
   *   1. 先用 extractKeywords() 提取结构化标识符（文件路径、函数名、驼峰命名等）
   *   2. 如果不足 3 个，补充通用分词（按标点/空白切分，去停用词，取 TF 最高的词）
   *   3. 最多返回 5 个关键词
   *
   * @param description Worker 任务描述
   * @returns 关注点关键词列表（最多 5 个）
   */
  private declareFocus(description: string): string[] {
    // 步骤 1：结构化标识符提取（复用现有 extractKeywords）
    const structuralKeywords = this.extractKeywords(description);

    // 如果已有 >= 3 个结构化关键词，直接返回（最多 5 个）
    if (structuralKeywords.length >= 3) {
      return structuralKeywords.slice(0, 5);
    }

    // 步骤 2：通用分词补充
    const generalKeywords = this.extractGeneralKeywords(description);

    // 合并去重，最多 5 个
    const merged = [...new Set([...structuralKeywords, ...generalKeywords])];
    return merged.slice(0, 5);
  }

  /**
   * 通用关键词提取（中英文混合分词）
   *
   * 策略：
   *   1. 按标点和空白切分
   *   2. 过滤停用词（中文 + 英文常见停用词）
   *   3. 过滤过短词（< 2 字符）
   *   4. 按词频排序，取前 5 个
   */
  private extractGeneralKeywords(text: string): string[] {
    // 中英文停用词
    const stopWords = new Set([
      // 中文停用词
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
      '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
      '把', '这', '那', '它', '他', '她', '们', '与', '或', '但', '而', '及', '以',
      '为', '对', '从', '向', '里', '外', '中', '下', '后', '前', '时', '地', '得',
      // 英文停用词
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'can', 'need', 'to', 'of', 'in',
      'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
      'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why',
      'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
      'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so', 'than',
      'too', 'very', 'just', 'this', 'that', 'these', 'those', 'it', 'its',
    ]);

    // 按非字母数字字符切分（支持中英文）
    const tokens = text
      .split(/[^a-zA-Z0-9\u4e00-\u9fff]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2) // 过滤过短词
      .filter(t => !stopWords.has(t.toLowerCase()));

    // 按词频排序
    const freq = new Map<string, number>();
    for (const token of tokens) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }

    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * 从步骤描述中提取关键词
   * 提取规则：文件路径、函数名、引号包裹的标识符、驼峰/下划线命名
   */
  private extractKeywords(description: string): string[] {
    const keywords = new Set<string>();

    // 文件路径（如 src/agent/loop.ts）
    const pathMatches = description.matchAll(/(?:[\w./-]+\/)*[\w-]+\.\w{1,5}/g);
    for (const m of pathMatches) {
      const p = m[0];
      if (/[a-zA-Z]/.test(p) && !/^\d+(\.\d+)+$/.test(p)) {
        keywords.add(p);
        // 同时提取文件名（不含路径）
        const basename = p.split('/').pop();
        if (basename) keywords.add(basename);
      }
    }

    // 引号包裹的标识符（如 "filterContext"）
    const quotedMatches = description.matchAll(/["'`]([A-Za-z_][\w./-]{2,})["'`]/g);
    for (const m of quotedMatches) {
      keywords.add(m[1]);
    }

    // 驼峰/下划线命名（如 filterContext、worker_executor）
    const identifierMatches = description.matchAll(/\b([a-z][a-zA-Z0-9]*_[a-z][a-zA-Z0-9_]*)\b/g);
    for (const m of identifierMatches) {
      keywords.add(m[1]);
    }
    const camelMatches = description.matchAll(/\b([a-z]+[A-Z][a-zA-Z0-9]{2,})\b/g);
    for (const m of camelMatches) {
      keywords.add(m[1]);
    }

    return Array.from(keywords);
  }

  private formatBlackboard(snapshot: WorkerTask['blackboardSnapshot']): string {
    const parts: string[] = [];

    if (snapshot.currentGoal) {
      parts.push(`目标: ${snapshot.currentGoal.description}`);
    }

    if (snapshot.completedSteps.length > 0) {
      parts.push('已完成:');
      for (const step of snapshot.completedSteps) {
        parts.push(`  - [${step.source.role}] ${step.value}`);
      }
    }

    if (snapshot.projectFacts.length > 0) {
      parts.push('已知信息:');
      for (const fact of snapshot.projectFacts) {
        parts.push(`  - ${fact.key}: ${fact.value}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : '（无上下文）';
  }
}
