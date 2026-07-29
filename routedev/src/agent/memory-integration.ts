// src/agent/memory-integration.ts
// 记忆维护集成器——从 loop.ts 抽取的记忆/引用/宏/Compose 相关职责
// 负责：记忆召回注入、引用解析与提取、宏展开、Compose 阶段流转

import type { LLMMessage } from '../router/types.js';
import { logger } from '../utils/logger.js';
import type { MemoryRecallInjector } from './memory/recall-injector.js';
import type { ComposePipeline } from './compose-pipeline.js';
import type { CiteManager } from '../cite/manager.js';
import type { CiteResolver } from '../cite/resolver.js';
import type { CiteItem, CiteType, CiteResolution } from '../cite/types.js';
import type { MacroManager } from '../macros/manager.js';
import type { ToolResult } from '../tools/types.js';
import type { SystemBlock } from './loop.js';

/**
 * 记忆维护集成器
 *
 * 从 ReActAgentLoop 抽取的记忆维护职责：
 * - 记忆召回注入（recallInjector → systemPrompt）
 * - 引用解析与提取（citeManager + citeResolver）
 * - 宏展开（macroManager）
 * - Compose 阶段流转（composePipeline）
 *
 * 所有操作均 fail-open：未注入对应组件或异常时不影响主流程。
 */
export class MemoryIntegration {
  private recallInjector: MemoryRecallInjector | null = null;
  private citeManager: CiteManager | null = null;
  private citeResolver: CiteResolver | null = null;
  private macroManager: MacroManager | null = null;
  private composePipeline: ComposePipeline | null = null;

  // ===== Setters =====

  /** 注入记忆召回注入器 */
  setRecallInjector(injector: MemoryRecallInjector | null): void {
    this.recallInjector = injector;
  }

  /** 注入引用管理器 */
  setCiteManager(manager: CiteManager | null): void {
    this.citeManager = manager;
  }

  /** 注入引用解析器 */
  setCiteResolver(resolver: CiteResolver | null): void {
    this.citeResolver = resolver;
  }

  /** 注入宏管理器 */
  setMacroManager(manager: MacroManager | null): void {
    this.macroManager = manager;
  }

  /** 注入 Compose 管线 */
  setComposePipeline(pipeline: ComposePipeline | null): void {
    this.composePipeline = pipeline;
  }

  // ===== Getters =====

  get hasComposePipeline(): boolean {
    return this.composePipeline !== null;
  }

  get hasMacroManager(): boolean {
    return this.macroManager !== null;
  }

  // ===== 宏展开 =====

  /**
   * 展开用户输入中的 !macro 触发器
   * 匹配 `!name` 形式的 token，若 MacroManager 中存在同名宏则替换为宏内容；
   * 不存在的宏保持原样（避免误吞用户输入的感叹号）。
   */
  expandMacros(input: string): string {
    if (!this.macroManager) return input;
    // 拆分为 token，对 !xxx 形式的 token 尝试展开
    return input.replace(/!(\w+)/g, (full, name: string) => {
      const macro = this.macroManager!.getMacro(name);
      return macro ? macro.content : full;
    });
  }

  // ===== 记忆召回注入 =====

  /**
   * 主动召回相关记忆，注入到 systemPrompt
   * 注入到 systemPrompt 而非每轮 messages：userMessage 在整个 run() 期间不变，
   * 每轮召回结果相同，注入一次让 effectiveSystemPrompt 继承即可，避免 token 浪费。
   * fail-open：recallInjector 为 null 或 recall 抛错时跳过（recallToPrompt 内部已 try/catch）
   * @returns 更新后的 { systemPrompt, systemBlocks }
   */
  injectRecall(
    systemPrompt: string | undefined,
    systemBlocks: SystemBlock[] | undefined,
    userMessage: string,
  ): { systemPrompt: string | undefined; systemBlocks: SystemBlock[] | undefined } {
    if (!this.recallInjector || !userMessage) {
      return { systemPrompt, systemBlocks };
    }
    const memoryPrompt = this.recallInjector.recallToPrompt(userMessage);
    if (!memoryPrompt) {
      return { systemPrompt, systemBlocks };
    }
    if (systemBlocks) {
      return { systemPrompt, systemBlocks: [...systemBlocks, { type: 'text', text: memoryPrompt }] };
    }
    // 注意：recall 不加分隔符（memoryPrompt 自身已含格式）
    return { systemPrompt: (systemPrompt ?? '') + memoryPrompt, systemBlocks };
  }

  /**
   * Session 结束时反馈 useful（Phase 96 I-2 修复）
   *
   * 把本次 run() 期间召回命中的节点标记为 useful（validatedCount += 1）。
   * 调用时机：ReActAgentLoop.run() 的 finally 块。
   * fail-open：recallInjector 为 null 或 improve 抛错时仅记日志。
   */
  commitMemoryFeedback(): void {
    if (!this.recallInjector) return;
    try {
      // commitUsefulFeedback 是 Phase 96 新增方法；做 typeof 守卫兼容旧版
      const injector = this.recallInjector as unknown as {
        commitUsefulFeedback?: () => void;
      };
      if (typeof injector.commitUsefulFeedback === 'function') {
        injector.commitUsefulFeedback();
      }
    } catch (err) {
      logger.debug('commitMemoryFeedback failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ===== 引用解析 =====

  /**
   * 解析 citeManager 中的引用，返回要注入的上下文
   *
   * 在 callLLMStream 开头调用，把 resolver 产出的：
   *   - injectedContext 拼到 user message 前
   *   - skillPrompts/macroPrompts 追加到 systemPrompt
   *   - allowedTools 暂不消费（预留）
   * fail-open：resolver 不可用或异常时不影响主流程
   */
  async resolveCitations(): Promise<CiteResolution | null> {
    if (!this.citeResolver || !this.citeManager) return null;
    try {
      const items = this.citeManager.list();
      if (items.length === 0) return null;
      const resolution = await this.citeResolver.resolve({ items });
      return resolution;
    } catch (err) {
      logger.debug('resolveCitations failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * 将引用解析结果应用到 messages 和 systemPrompt
   * - injectedContext 拼接到最后一条 user message 前
   * - skillPrompts/macroPrompts 追加到 systemPrompt（用 --- 分隔）
   * @returns 更新后的 { messages, systemPrompt }
   */
  applyCiteResolution(
    messages: LLMMessage[],
    systemPrompt: string | undefined,
    resolution: CiteResolution,
  ): { messages: LLMMessage[]; systemPrompt: string | undefined } {
    let newMessages = messages;
    let newSystemPrompt = systemPrompt;

    // 拼接 injectedContext 到最后一条 user message 前
    if (resolution.injectedContext) {
      const lastUserIdx = messages.length - 1;
      if (lastUserIdx >= 0 && messages[lastUserIdx].role === 'user') {
        newMessages = [...messages];
        newMessages[lastUserIdx] = {
          ...newMessages[lastUserIdx],
          content: `${resolution.injectedContext}\n\n${newMessages[lastUserIdx].content}`,
        };
      }
    }

    // 追加 skill/macro prompts 到 systemPrompt
    const extraPrompts = [
      ...resolution.skillPrompts,
      ...resolution.macroPrompts,
    ].filter(Boolean);
    if (extraPrompts.length > 0) {
      const extraStr = extraPrompts.join('\n\n');
      newSystemPrompt = newSystemPrompt ? `${newSystemPrompt}\n\n---\n${extraStr}` : extraStr;
    }

    return { messages: newMessages, systemPrompt: newSystemPrompt };
  }

  /**
   * 从 LLM 输出文本中提取 [cite:type:source] 标记并 add 到 citeManager
   *
   * 标记格式：[cite:<type>:<source>]，type ∈ file|folder|text|skill|tool|macro|url|message
   * source 为非空字符串（不含 ] 与空白）
   * 失败处理：重复（DuplicateCiteError）/超限（CiteLimitExceededError）/格式不符 均跳过，不抛出
   * fail-open：未注入 citeManager 或提取异常时跳过
   */
  extractCitationsFromText(text: string): void {
    if (!this.citeManager) return;
    try {
      // 全局正则：[cite:type:source]，type 限定为 8 种合法类型，source 不含 ] 与空白
      const CITE_PATTERN = /\[cite:(file|folder|text|skill|tool|macro|url|message):([^\]\s]+)\]/g;
      let match: RegExpExecArray | null;
      while ((match = CITE_PATTERN.exec(text)) !== null) {
        const type = match[1] as CiteType;
        const source = match[2];
        try {
          const item: CiteItem = {
            id: `cite-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            type,
            source,
            label: source,
            createdAt: Date.now(),
            origin: 'trigger',
          };
          this.citeManager.add(item);
        } catch (err) {
          // 重复/超限/格式问题：fail-open，记 debug 日志后继续
          logger.debug('CiteManager.add skipped (fail-open)', {
            type, source, error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // fail-open：标记提取失败不影响主流程
      logger.debug('extractCitationsFromText failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ===== Compose 阶段流转 =====

  /** 获取当前 Compose 阶段的系统提示词覆盖（无 Compose 管线时返回 null） */
  getPhasePrompt(): string | null {
    if (!this.composePipeline) return null;
    const prompt = this.composePipeline.getPhasePrompt();
    return prompt || null;
  }

  /**
   * Compose 阶段自动流转评估
   * @param toolResult 工具执行结果或 LLM 文本回复
   * @returns 是否发生了阶段流转
   */
  evaluateAdvance(toolResult: ToolResult): boolean {
    if (!this.composePipeline) return false;
    return this.composePipeline.evaluateAdvance(toolResult);
  }
}
