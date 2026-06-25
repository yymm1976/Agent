import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

export class AskUserTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'ask_user',
    description: '当用户需求不明确、需要选择方案或确认关键信息时，使用此工具向用户提问并等待回答。支持单个或多个问题。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '单个问题文本',
        },
        questions: {
          type: 'array',
          items: { type: 'string' },
          description: '多个问题文本，用户会逐个回答',
        },
      },
      required: [],
    },
    requiresApproval: true,
    category: 'system',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const hasQuestion = typeof args.question === 'string' && args.question.trim().length > 0;
    const hasQuestions = Array.isArray(args.questions) && args.questions.some((q) => typeof q === 'string' && q.trim().length > 0);
    return hasQuestion || hasQuestions
      ? { valid: true, errors: [] }
      : { valid: false, errors: ['需要 question 或 questions 参数'] };
  }

  async execute(_args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    return {
      success: false,
      output: '',
      error: 'ask_user 必须通过用户提问确认流程执行',
      durationMs: 0,
    };
  }
}
