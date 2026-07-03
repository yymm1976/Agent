// src/agent/middleware/mention-resolver.ts
// Phase 71 Task B2：@-mention 统一引用协议中间件
// 注册到 onUserMessage 阶段，解析用户输入中的 @-mention
//   - 把解析结果注入到 ctx.metadata.mentions（供后续工具使用）
//   - 把 @-mention 替换为带绝对路径的标准化形式（如 @src/foo.ts → @/abs/path/foo.ts）
//
// fail-open：解析失败时不阻塞用户消息，只记日志，保留原始消息

import type { MiddlewareContext, MiddlewareHandler } from '../middleware.js';
import { parseMentions, type Mention } from '../context/mention-parser.js';
import { logger } from '../../utils/logger.js';

/**
 * @-mention 解析中间件
 * 在 onUserMessage 阶段解析用户输入中的 @-mention
 * - 注入 ctx.metadata.mentions 供后续工具消费
 * - 标准化替换 @raw 为 @resolved（让 Agent 看到统一格式的绝对路径）
 *
 * 协议约定：
 *   - loop.ts 在调用 onUserMessage 前，把用户消息写入 ctx.metadata.userMessage
 *   - 中间件读取 ctx.metadata.userMessage，解析后写回标准化消息
 *   - mentions 列表通过 ctx.metadata.mentions 传递给后续中间件/工具
 */
export class MentionResolverMiddleware {
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** 获取中间件处理器（注册到 onUserMessage 阶段） */
  getHandler(): MiddlewareHandler {
    return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
      // 从 ctx.metadata.userMessage 读取用户消息（loop.ts 在调用前设置）
      const userMessage = ctx.metadata.userMessage as string | undefined;
      if (!userMessage) {
        // 无用户消息，正常透传
        await next();
        return;
      }

      try {
        // 解析 @-mention
        const mentions = parseMentions(userMessage, this.cwd);
        // 注入到 ctx.metadata.mentions 供后续工具使用
        ctx.metadata.mentions = mentions;

        // 标准化替换：把 @raw 替换为 @resolved
        const transformed = this.normalizeMentions(userMessage, mentions);
        ctx.metadata.userMessage = transformed;

        if (mentions.length > 0) {
          logger.debug('MentionResolver 解析完成', {
            count: mentions.length,
            types: mentions.map(m => m.type),
          });
        }
      } catch (err) {
        // fail-open：解析失败时不阻塞用户消息，保留原始消息
        logger.warn('MentionResolver 解析失败 (fail-open)', {
          error: err instanceof Error ? err.message : String(err),
        });
        // 不修改 ctx.metadata.userMessage，保留原始消息
      }

      await next();
    };
  }

  /**
   * 标准化替换：把 @raw 替换为 @resolved
   * 例如：@src/foo.ts → @/abs/path/foo.ts
   *       @MyClass → @src/foo.ts（若 DB 命中）
   * URL 的 raw === resolved，替换为 no-op
   */
  private normalizeMentions(text: string, mentions: Mention[]): string {
    let result = text;
    for (const m of mentions) {
      // raw === resolved 时无需替换（URL 或 DB 未命中的符号）
      if (m.raw === m.resolved) continue;
      // 转义 raw 中的正则特殊字符，避免路径中的 . / \ 被误解析
      const escaped = m.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`@${escaped}`, 'g'), `@${m.resolved}`);
    }
    return result;
  }
}
