// src/tools/builtin/ccr-retrieve.ts
// Phase 55 Task 9：CCR 可逆压缩的取回工具
// 让 LLM 通过 hash 取回被上下文压缩的原始消息，实现 compact 从破坏性变可逆

import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import type { CCRCache } from '../../agent/ccr-cache.js';

const DEFINITION: ToolDefinition = {
  name: 'ccr_retrieve',
  description: '使用 hash 或 hash 前缀取回被上下文压缩的原始消息（CCR 可逆压缩）。',
  parameters: {
    type: 'object',
    properties: {
      hash: {
        type: 'string',
        description: 'CCR marker 中的 hash 值（支持完整 hash 或 12 位前缀）',
      },
    },
    required: ['hash'],
  },
  requiresApproval: false,
  category: 'system',
};

export class CCRRetrieveTool implements ITool {
  readonly definition = DEFINITION;

  constructor(private readonly ccrCache: CCRCache) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const hash = String(args.hash ?? '');

    // 先精确匹配，再前缀匹配
    const messages = this.ccrCache.retrieve(hash) ?? this.ccrCache.retrieveByPrefix(hash);
    if (!messages) {
      return {
        success: false,
        output: '',
        error: `CCR cache 未找到 hash: ${hash}`,
        durationMs: Date.now() - start,
      };
    }

    const formatted = messages
      .map((msg) => {
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        return `[${msg.role}] ${content}`;
      })
      .join('`n---`n');

    return {
      success: true,
      output: formatted,
      durationMs: Date.now() - start,
      metadata: { messageCount: messages.length },
    };
  }

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.hash || typeof args.hash !== 'string') {
      errors.push('hash 参数必填且必须是字符串');
    }
    return { valid: errors.length === 0, errors };
  }
}
