// src/agent/goal-verifier.ts
// /goal 命令的目标完成度验证器
// 用独立的 LLM（通常比工作模型更强大）验证目标是否完成

import type { ILLMClient, LLMMessage, LLMRequestOptions, RoutingResult, TokenUsageInfo } from '../router/types.js';
import type { GoalPlan, VerificationResult } from './goal-types.js';
import { logger } from '../utils/logger.js';

const VERIFIER_SYSTEM_PROMPT = `你是 RouteDev 的目标验证助手。请根据用户输入的目标、验证条件、步骤执行结果，判断目标是否完成。

输出严格的 JSON 格式（不要输出任何其他内容）：
{
  "passed": true|false,
  "confidence": 0.0-1.0,
  "reasoning": "推理过程（1-3 句话）",
  "missingItems": ["缺失项1", "缺失项2"],
  "suggestions": ["改进建议1", "改进建议2"]
}

判断标准：
1. passed: true 表示目标已完成（满足验证条件）；false 表示未完成
2. confidence: 你对判断的把握度
3. missingItems: 如果未完成，列出缺失的具体项
4. suggestions: 改进建议`;

export interface GoalVerifierOptions {
  /** 路由决策（由独立路由为 verifier 选出） */
  routeDecision: RoutingResult;
  /** LLM 客户端 */
  llmClient: ILLMClient;
  /** 最大 token 数（默认 1000） */
  maxTokens?: number;
  /** 置信度阈值（低于此值视为不确定） */
  confidenceThreshold?: number;
}

export class GoalVerifier {
  async verify(
    plan: GoalPlan,
    options: GoalVerifierOptions,
  ): Promise<VerificationResult> {
    const { routeDecision, llmClient, maxTokens = 1000, confidenceThreshold = 0.7 } = options;

    const userMessage = this.buildUserMessage(plan);

    const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];

    const requestOptions: LLMRequestOptions = {
      model: routeDecision.model.id,
      messages,
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      maxTokens,
      stream: false,
    };

    logger.debug('GoalVerifier invoking LLM', {
      model: routeDecision.model.id,
      stepCount: plan.steps.length,
    });

    const response = await llmClient.complete(requestOptions);
    return this.parseResult(response.content, confidenceThreshold);
  }

  /** 构建用户消息 */
  private buildUserMessage(plan: GoalPlan): string {
    const parts: string[] = [];

    parts.push(`目标: ${plan.description}`);
    if (plan.verificationCriteria) {
      parts.push(`验证条件: ${plan.verificationCriteria}`);
    }

    parts.push('\n步骤执行结果:');
    for (const step of plan.steps) {
      const status = step.status === 'completed' ? '✓' : '✗';
      const result = step.result ? `: ${step.result}` : '';
      const error = step.error ? ` [错误: ${step.error}]` : '';
      parts.push(`${status} 步骤 ${step.id}: ${step.description}${result}${error}`);
    }

    parts.push('\n请判断目标是否完成。');
    return parts.join('\n');
  }

  /** 解析 LLM 响应 */
  private parseResult(content: string, _confidenceThreshold: number): VerificationResult {
    const jsonStr = this.extractJson(content);
    if (!jsonStr) {
      logger.warn('GoalVerifier: no JSON found, returning default failed result');
      return {
        passed: false,
        confidence: 0,
        reasoning: '验证器响应无法解析',
        missingItems: ['验证器响应格式错误'],
        suggestions: ['检查 LLM 响应'],
      };
    }

    try {
      const parsed = JSON.parse(jsonStr) as Partial<VerificationResult>;
      return {
        passed: parsed.passed ?? false,
        confidence: parsed.confidence ?? 0.5,
        reasoning: parsed.reasoning ?? '',
        missingItems: parsed.missingItems ?? [],
        suggestions: parsed.suggestions ?? [],
      };
    } catch (error) {
      logger.error('GoalVerifier: failed to parse JSON', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        passed: false,
        confidence: 0,
        reasoning: '验证器响应 JSON 解析失败',
        missingItems: ['验证器响应格式错误'],
        suggestions: ['检查 LLM 输出'],
      };
    }
  }

  private extractJson(content: string): string | null {
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }

    return null;
  }
}
