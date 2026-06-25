// src/agent/middleware/loop-detection.ts
// 循环检测中间件：检测重复工具调用循环并强制打破
// 参考 deer-flow 的 LoopDetectionMiddleware 设计
// 维护滑动窗口（最近 N 次工具调用），记录 (toolName, argsHash) 对
// 如果同一 (toolName, argsHash) 在窗口内出现 ≥ maxRepeats 次 → 判定为循环
// 打破方式：向 ctx.metadata 注入 loopDetected 标记

import type { MiddlewareHandler } from '../middleware.js';

/** djb2 字符串哈希（非加密强度，仅用于参数指纹） */
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & 0xffffffff; // 强制 32 位
  }
  return hash;
}

/** 计算工具参数的指纹 */
function computeArgsHash(args: Record<string, unknown> | undefined): number {
  if (!args) return djb2Hash('');
  try {
    return djb2Hash(JSON.stringify(args));
  } catch {
    return djb2Hash(String(args));
  }
}

/** 窗口内单条记录 */
interface WindowEntry {
  toolName: string;
  argsHash: number;
}

export interface LoopDetectionOptions {
  /** 滑动窗口大小（默认 10） */
  windowSize?: number;
  /** 窗口内允许的最大重复次数（默认 3） */
  maxRepeats?: number;
}

export class LoopDetectionMiddleware {
  private windowSize: number;
  private maxRepeats: number;
  private window: WindowEntry[] = [];

  constructor(options: LoopDetectionOptions = {}) {
    this.windowSize = options.windowSize ?? 10;
    this.maxRepeats = options.maxRepeats ?? 3;
  }

  /** 返回符合 MiddlewareHandler 签名的处理器（注册到 onReasoning 阶段） */
  getHandler(): MiddlewareHandler {
    return async (ctx, next) => {
      // 从 ctx.metadata 中读取本轮 LLM 返回的工具调用列表
      // loop.ts 在调用 onReasoning 前会把 toolCalls 写入 ctx.metadata.toolCalls
      const toolCalls = ctx.metadata.toolCalls as
        | Array<{ name: string; arguments?: Record<string, unknown> }>
        | undefined;

      if (toolCalls && Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const entry: WindowEntry = {
            toolName: tc.name,
            argsHash: computeArgsHash(tc.arguments),
          };
          this.window.push(entry);

          // 维护滑动窗口
          if (this.window.length > this.windowSize) {
            this.window.shift();
          }

          // 统计窗口内相同 (toolName, argsHash) 出现次数
          const repeats = this.window.filter(
            (e) => e.toolName === entry.toolName && e.argsHash === entry.argsHash,
          ).length;

          if (repeats >= this.maxRepeats) {
            ctx.metadata.loopDetected = true;
            ctx.metadata.loopBreakSuggestion =
              `检测到工具 "${entry.toolName}" 在最近 ${this.window.length} 次调用中重复 ${repeats} 次，` +
              `疑似陷入循环。请尝试换一种方法或直接用文本回复用户。`;
            // 检测到循环后清空窗口，避免下一轮重复触发
            this.window = [];
            break;
          }
        }
      }

      await next();
    };
  }

  /** 重置窗口（新会话时调用） */
  reset(): void {
    this.window = [];
  }
}
