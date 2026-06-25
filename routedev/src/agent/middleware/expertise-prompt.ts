// src/agent/middleware/expertise-prompt.ts
// Phase 40 Task 4：用户经验适配中间件
// 注册到 onSystemPrompt 阶段，根据用户经验等级注入行为指令片段。
//   - beginner：完整行为规范（详细解释、逐步执行、立即报告错误）
//   - intermediate：关键决策规范（仅关键架构说明、自动修复、批量≤3）
//   - expert：最小化输出规范（直接结果、静默重试、无限制批量）

import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import {
  ExpertiseManager,
  type UserExpertise,
} from '../../config/expertise-manager.js';

/** 各等级的 System Prompt 注入片段 */
const EXPERTISE_PROMPTS: Record<UserExpertise, string> = {
  beginner: `## 行为规范
- 请在每次操作前简要说明意图，让用户了解即将发生什么
- 生成的代码请包含详细的解释性注释
- 操作完成后简要总结"为什么这样做"
- 遇到错误时立即报告，并建议修复方案
- 逐步执行操作，不要批量处理`,
  intermediate: `## 行为规范
- 仅在关键架构决策时说明理由
- 对复杂逻辑添加注释，简单逻辑无需注释
- 遇到错误时尝试自动修复，失败后再报告
- 可以批量处理最多 3 个相关文件`,
  expert: `## 行为规范
- 最小化文本输出，直接给出结果
- 不主动添加代码注释
- 遇到错误时静默重试（最多 2 次），仍失败才报告
- 可以批量处理任意数量的文件`,
};

/**
 * 用户经验适配中间件
 * 在 onSystemPrompt 阶段将 EXPERTISE_PROMPTS[level] 追加到 systemPrompt。
 */
export class ExpertisePromptMiddleware {
  constructor(private expertiseManager: ExpertiseManager) {}

  /** 获取中间件处理器（注册到 onSystemPrompt 阶段） */
  getHandler(): MiddlewareHandler {
    return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
      const level = this.expertiseManager.getLevel();
      const promptFragment = EXPERTISE_PROMPTS[level];

      if (ctx.systemPrompt !== undefined && promptFragment) {
        ctx.systemPrompt += '\n\n' + promptFragment;
      } else if (ctx.systemPrompt === undefined && promptFragment) {
        ctx.systemPrompt = promptFragment;
      }

      ctx.metadata.expertiseLevel = level;
      ctx.metadata.expertisePromptInjected = true;

      await next();
    };
  }

  /**
   * 获取注入片段的 token 估算（用于预算管理）
   * 估算值：beginner ~120 tokens, intermediate ~60 tokens, expert ~30 tokens
   */
  static getEstimatedTokens(level: UserExpertise): number {
    const estimates: Record<UserExpertise, number> = {
      beginner: 120,
      intermediate: 60,
      expert: 30,
    };
    return estimates[level];
  }
}
