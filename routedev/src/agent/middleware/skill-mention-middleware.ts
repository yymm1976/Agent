// src/agent/middleware/skill-mention-middleware.ts
// Phase 94：Skill 名提及自动注入中间件
//
// 解决问题：用户消息明确要求"按 XXX Skill 流程执行"时，主 Agent 仍自己探索
// 不调用 spawn_agent，导致流程跑不通。
//
// 机制：在 onUserMessage 阶段扫描用户消息，检测到 Skill 流程提及模式时，
//   向 metadata 注入 skillFlowHint，loop.ts 在系统提示词或首条 user 消息中
//   追加"第一动作必须是 spawn_agent"强约束。
//
// 检测模式：
//   1. "按 XXX Skill 流程执行" / "按 XXX Skill 执行"
//   2. "用审阅链" / "用 review chain" / "用 reviewchain"
//   3. "用子 Agent" / "用 spawn_agent"
//   4. "XXX-orchestrator" / "XXX 流程"
//
// 设计原则：
//   1. 仅注入提示，不阻断消息处理
//   2. 只在首次用户消息检测（避免重复注入）
//   3. 提示内容明确指向 spawn_agent

import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import { logger } from '../../utils/logger.js';

/** Skill 流程提及模式 */
const SKILL_FLOW_PATTERNS: RegExp[] = [
  /按\s+[\w-]+\s+[Ss]kill\s*(流程)?\s*(执行|跑|跑通|走)/,
  /用\s+[\w-]+\s+[Ss]kill/,
  /用\s*(审阅链|审查链|review\s*chain|reviewchain)/i,
  /用\s*(子\s*[Aa]gent|spawn_agent|spawn-agent)/,
  /[\w-]+-orchestrator/i,
  /[\w-]+\s+流程/,
];

/**
 * Skill 名提及中间件
 *
 * 注册到 onUserMessage 阶段，检测用户消息中的 Skill 流程提及模式，
 * 注入 spawn_agent 强约束提示到 metadata。
 */
export class SkillMentionMiddleware {
  /** 获取中间件处理器（注册到 onUserMessage 阶段） */
  getHandler(): MiddlewareHandler {
    return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
      if (ctx.phase !== 'onUserMessage' || !ctx.messages || ctx.messages.length === 0) {
        await next();
        return;
      }

      // 取最后一条用户消息文本
      const lastMsg = ctx.messages[ctx.messages.length - 1];
      const userText = this.extractUserText(lastMsg);
      if (!userText) {
        await next();
        return;
      }

      // 检测 Skill 流程提及
      const matchedPattern = SKILL_FLOW_PATTERNS.find(p => p.test(userText));
      if (matchedPattern) {
        ctx.metadata.skillFlowMentioned = true;
        ctx.metadata.skillFlowHint =
          `[系统强约束] 检测到用户要求按 Skill 流程执行（匹配模式: ${matchedPattern.source}）。` +
          `你的第一动作必须是 spawn_agent(planner) 拆需求，不要预先读任何文件；` +
          `后续按 planner → coder → reviewer 链路分发，主 Agent 只做编排。` +
          `违反此约束将导致任务失败。`;
        logger.info('Skill flow mention detected, injecting spawn_agent constraint', {
          pattern: matchedPattern.source,
          userTextPreview: userText.slice(0, 80),
        });
      }

      await next();
    };
  }

  /** 从 LLMMessage 提取用户文本（兼容 string 和 content array 格式） */
  private extractUserText(msg: unknown): string {
    if (typeof msg === 'string') return msg;
    const m = msg as { content?: unknown };
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((c: unknown) => {
          if (typeof c === 'string') return c;
          const block = c as { text?: string; type?: string };
          return block?.text ?? '';
        })
        .join('');
    }
    return '';
  }
}
