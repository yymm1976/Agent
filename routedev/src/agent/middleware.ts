// src/agent/middleware.ts
// Agent 中间件管线（借鉴 AgentScope 2.0 五阶段模型）

import type { LLMMessage, LLMToolDefinition } from '../router/types.js';

/** 中间件可拦截的五个阶段 */
export type MiddlewarePhase =
  | 'onAgent'        // Agent 启动时（进入 ReAct 循环前）
  | 'onReasoning'    // 每次 LLM 推理前
  | 'onActing'       // 每次工具调用前
  | 'onModelCall'    // LLM API 调用时（可替换/缓存）
  | 'onSystemPrompt'; // 系统提示词生成时

/** 中间件上下文 */
export interface MiddlewareContext {
  phase: MiddlewarePhase;
  messages?: LLMMessage[];
  toolDefinitions?: LLMToolDefinition[];
  systemPrompt?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** 中间件处理器 */
export type MiddlewareHandler = (
  ctx: MiddlewareContext,
  next: () => Promise<void>,
) => Promise<void>;

/** 中间件注册与管理 */
export class AgentMiddlewarePipeline {
  private handlers = new Map<MiddlewarePhase, MiddlewareHandler[]>();

  register(phase: MiddlewarePhase, handler: MiddlewareHandler): void {
    const list = this.handlers.get(phase) || [];
    list.push(handler);
    this.handlers.set(phase, list);
  }

  /**
   * 注销指定阶段的处理器（Phase 22 修复：支持插件 disable 时移除钩子）
   * @returns 是否成功移除（找不到时返回 false）
   */
  unregister(phase: MiddlewarePhase, handler: MiddlewareHandler): boolean {
    const list = this.handlers.get(phase);
    if (!list) return false;
    const idx = list.indexOf(handler);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.handlers.delete(phase);
    return true;
  }

  async execute(phase: MiddlewarePhase, ctx: MiddlewareContext): Promise<void> {
    const handlers = this.handlers.get(phase) || [];
    let index = 0;
    const next = async (): Promise<void> => {
      if (index < handlers.length) {
        const handler = handlers[index++];
        await handler(ctx, next);
      }
    };
    await next();
  }
}
