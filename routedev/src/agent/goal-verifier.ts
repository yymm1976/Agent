// src/agent/goal-verifier.ts
// /goal 命令的目标完成度验证器
// 用独立的 LLM（通常比工作模型更强大）验证目标是否完成
//
// Phase 21 Task 2：增加可选 gates 参数（FrozenGates），保持向后兼容
// Phase 21 Task 4：增加对抗性验证（adversarialCheck）+ Challenge 类型

import type { ILLMClient, LLMMessage, LLMRequestOptions, RoutingResult, TokenUsageInfo } from '../router/types.js';
import type { GoalPlan, VerificationResult, Challenge } from './goal-types.js';
import type { FrozenGates } from './goal-gates.js';
import { logger } from '../utils/logger.js';

/** 对抗性验证配置 */
export interface AdversarialOptions {
  /** 是否启用对抗性验证 */
  enabled: boolean;
  /** 严重度阈值（低于此值的 challenge 不返回，默认 0.5） */
  threshold?: number;
  /** 对抗性验证用的 LLM 客户端（应为 fast tier 廉价模型） */
  adversarialClient?: ILLMClient;
}

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
  /**
   * 对抗性验证配置（Phase 21 Task 4 新增，可选）
   * 启用后用独立 LLM 客户端尝试推翻结论
   */
  adversarial?: AdversarialOptions;
}

export class GoalVerifier {
  /**
   * 验证目标是否完成
   *
   * @param plan 目标计划
   * @param options 验证选项
   * @param gates 冻结的验收门控（Phase 21 Task 2 新增，可选）
   *              传入时会将 gates 的状态加入 LLM 上下文，辅助验证
   *              不传时保持向后兼容
   */
  async verify(
    plan: GoalPlan,
    options: GoalVerifierOptions,
    gates?: FrozenGates,
  ): Promise<VerificationResult> {
    const {
      routeDecision,
      llmClient,
      maxTokens = 1000,
      confidenceThreshold = 0.7,
      adversarial,
    } = options;

    const userMessage = this.buildUserMessage(plan, gates);

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
      hasGates: !!gates,
      adversarialEnabled: !!adversarial?.enabled,
    });

    const response = await llmClient.complete(requestOptions);
    const result = this.parseResult(response.content, confidenceThreshold);

    // Phase 21 Task 4：对抗性验证（可选）
    // challenges 作为附加信息，不改变 passed 结果
    if (adversarial?.enabled && adversarial.adversarialClient) {
      try {
        const challenges = await this.adversarialCheck(
          plan.description,
          this.buildResultSummary(plan, result),
          adversarial.adversarialClient,
          adversarial.threshold ?? 0.5,
        );
        if (challenges.length > 0) {
          result.challenges = challenges;
          logger.info('Adversarial check produced challenges', {
            count: challenges.length,
            maxSeverity: Math.max(...challenges.map(c => c.severity)),
          });
        }
      } catch (error) {
        // 对抗性验证失败不阻塞主验证流程
        logger.warn('Adversarial check failed (non-blocking)', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  /**
   * 对抗性验证：用独立 LLM 客户端尝试推翻结论
   *
   * 设计意图：降低"同模型自我验证"的确认偏差。
   * adversarialClient 应使用 fast tier 廉价模型（与主 Agent 不同）。
   *
   * @param goalText 原始目标
   * @param result 主验证的结论摘要
   * @param adversarialClient 独立 LLM 客户端
   * @param threshold 严重度阈值（默认 0.5），低于此值的质疑不返回
   * @param model 对抗性验证用的模型 ID（默认 'fast'）
   * @returns 过滤后的质疑列表
   */
  async adversarialCheck(
    goalText: string,
    result: string,
    adversarialClient: ILLMClient,
    threshold = 0.5,
    model = 'fast',
  ): Promise<Challenge[]> {
    const prompt = [
      '你是严格审查员。尝试推翻以下结论。',
      '',
      '目标:',
      goalText,
      '',
      '结果:',
      result,
      '',
      '列出有实质意义的质疑，严格 JSON 数组格式（不要输出其他内容）:',
      '[{"severity": 0.0-1.0, "description": "质疑描述", "suggestion": "改进建议"}]',
      '',
      '注意：severity < 0.3 的轻微问题不要列出。',
    ].join('\n');

    const response = await adversarialClient.complete({
      model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
    });

    try {
      const jsonStr = this.extractJson(response.content) || response.content;
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return [];
      const challenges = parsed as Challenge[];
      // 过滤：severity 在 [0,1] 范围内且 >= threshold
      return challenges.filter(
        c =>
          typeof c.severity === 'number' &&
          c.severity >= 0 &&
          c.severity <= 1 &&
          c.severity >= threshold &&
          typeof c.description === 'string' &&
          c.description.length > 0,
      );
    } catch {
      logger.warn('Adversarial check: JSON 解析失败，返回空数组');
      return [];
    }
  }

  /** 构建结果摘要（给对抗性验证用） */
  private buildResultSummary(plan: GoalPlan, result: VerificationResult): string {
    const parts: string[] = [];
    parts.push(`验证结论: ${result.passed ? '通过' : '未通过'}`);
    parts.push(`置信度: ${(result.confidence * 100).toFixed(0)}%`);
    parts.push(`推理: ${result.reasoning}`);
    if (result.missingItems.length > 0) {
      parts.push(`缺失项: ${result.missingItems.join('; ')}`);
    }
    return parts.join('\n');
  }

  /** 构建用户消息 */
  private buildUserMessage(plan: GoalPlan, gates?: FrozenGates): string {
    const parts: string[] = [];

    parts.push(`目标: ${plan.description}`);
    if (plan.verificationCriteria) {
      parts.push(`验证条件: ${plan.verificationCriteria}`);
    }

    // Phase 21 Task 2：注入 gates 状态
    if (gates && gates.gates.length > 0) {
      parts.push('\n冻结的验收门控:');
      for (const gate of gates.gates) {
        const statusIcon = {
          passed: '✓',
          failed: '✗',
          pending: '○',
          skipped: '−',
        }[gate.status];
        parts.push(`  ${statusIcon} [${gate.id}] ${gate.criteria}`);
        if (gate.evidence) parts.push(`      证据: ${gate.evidence}`);
      }
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
    // 1. 优先匹配 markdown 代码块
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // 2. 根据第一个非空白字符判断是数组还是对象
    const trimmed = content.trimStart();
    const firstChar = trimmed[0];

    if (firstChar === '[') {
      // JSON 数组：匹配从第一个 [ 到最后一个 ]
      const firstBracket = content.indexOf('[');
      const lastBracket = content.lastIndexOf(']');
      if (firstBracket >= 0 && lastBracket > firstBracket) {
        return content.slice(firstBracket, lastBracket + 1);
      }
    } else if (firstChar === '{') {
      // JSON 对象：匹配从第一个 { 到最后一个 }
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return content.slice(firstBrace, lastBrace + 1);
      }
    } else {
      // 兜底：尝试查找 { } 或 [ ]
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return content.slice(firstBrace, lastBrace + 1);
      }
      const firstBracket = content.indexOf('[');
      const lastBracket = content.lastIndexOf(']');
      if (firstBracket >= 0 && lastBracket > firstBracket) {
        return content.slice(firstBracket, lastBracket + 1);
      }
    }

    return null;
  }
}
