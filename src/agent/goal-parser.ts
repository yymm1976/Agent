// src/agent/goal-parser.ts
// /goal 命令的目标分解器
// 用 LLM 把用户输入的目标描述拆成可执行的步骤列表

import type { ILLMClient, LLMMessage, LLMRequestOptions, RoutingResult, TokenUsageInfo } from '../router/types.js';
import type { GoalPlan, GoalStep } from './goal-types.js';
import { logger } from '../utils/logger.js';

const PARSER_SYSTEM_PROMPT = `你是 RouteDev 的目标分解助手。请把用户输入的目标拆分为可执行的步骤列表。

要求：
1. 步骤数：3-8 步（如果目标很简单，可以 1-2 步）
2. 步骤描述：使用祈使句，简洁明确（如 "读取 package.json"、"运行 pnpm test"）
3. 步骤之间隐式按顺序执行（不需要 dependencies 字段）
4. 如果用户提供了验证条件，请严格遵守

输出严格的 JSON 格式（不要输出任何其他内容）：
{
  "steps": [
    { "id": 1, "description": "步骤1" },
    { "id": 2, "description": "步骤2" }
  ]
}`;

export interface GoalParserOptions {
  /** 验证条件（可空） */
  verificationCriteria?: string;
  /** 路由决策（用于选定 LLM） */
  routeDecision: RoutingResult;
  /** LLM 客户端 */
  llmClient: ILLMClient;
  /** 确认超时（毫秒） */
  timeoutMs?: number;
}

export class GoalParser {
  async parse(
    description: string,
    options: GoalParserOptions,
  ): Promise<GoalPlan> {
    const { verificationCriteria, routeDecision, llmClient, timeoutMs = 30000 } = options;

    const userMessage = verificationCriteria
      ? `目标: ${description}\n验证条件: ${verificationCriteria}`
      : `目标: ${description}`;

    const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];

    const requestOptions: LLMRequestOptions = {
      model: routeDecision.model.id,
      messages,
      systemPrompt: PARSER_SYSTEM_PROMPT,
      maxTokens: 2000,
      timeoutMs,
      stream: false,
    };

    logger.debug('GoalParser invoking LLM', {
      model: routeDecision.model.id,
      description: description.slice(0, 50),
    });

    const response = await llmClient.complete(requestOptions);
    return this.parseAndBuildPlan(description, verificationCriteria, response.content, response.usage);
  }

  /** 解析 LLM 响应并构建 GoalPlan */
  private parseAndBuildPlan(
    description: string,
    verificationCriteria: string | undefined,
    content: string,
    _usage: TokenUsageInfo,
  ): GoalPlan {
    const jsonStr = this.extractJson(content);
    if (!jsonStr) {
      logger.warn('GoalParser: no JSON found in LLM response, creating single-step plan', { content });
      return {
        description,
        verificationCriteria,
        steps: [{
          id: 1,
          description,
          status: 'pending',
          dependencies: [],
        }],
        status: 'pending',
        createdAt: Date.now(),
      };
    }

    try {
      const parsed = JSON.parse(jsonStr) as { steps: Array<{ id: number; description: string }> };

      if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        throw new Error('steps 数组为空或无效');
      }

      const steps: GoalStep[] = parsed.steps.map((s, idx) => ({
        id: s.id ?? idx + 1,
        description: s.description,
        status: 'pending' as const,
        dependencies: idx > 0 ? [parsed.steps[idx - 1].id ?? idx] : [],
      }));

      return {
        description,
        verificationCriteria,
        steps,
        status: 'pending',
        createdAt: Date.now(),
      };
    } catch (error) {
      logger.error('GoalParser: failed to parse JSON, falling back to single-step plan', {
        error: error instanceof Error ? error.message : String(error),
        jsonStr: jsonStr.slice(0, 200),
      });

      return {
        description,
        verificationCriteria,
        steps: [{
          id: 1,
          description,
          status: 'pending',
          dependencies: [],
        }],
        status: 'pending',
        createdAt: Date.now(),
      };
    }
  }

  /** 从 LLM 响应中提取 JSON（处理 markdown 代码块） */
  private extractJson(content: string): string | null {
    // 尝试提取 ```json ... ``` 代码块
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // 尝试找第一个 { 到最后一个 } 的内容
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }

    return null;
  }
}
