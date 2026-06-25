// src/agent/requirements-gatherer.ts
// Phase 31 Task 2：需求确认（Requirements Gathering）
// 根据分类器结果自动选择策略：自动确认 / 主动追问 / 规划模式
// LLM 调用失败时降级为直接执行（不卡住）

import type { ILLMClient, LLMMessage, LLMRequestOptions, RoutingResult } from '../router/types.js';
import type { ClassificationResult } from '../router/types.js';
import { logger } from '../utils/logger.js';
import type {
  RequirementsEvent,
  RequirementsSummary,
  ClarifyingQuestion,
  ProjectContext,
} from './task-orchestrator-types.js';

// --- LLM Prompt 设计 ---

const SUMMARY_SYSTEM_PROMPT = `你是需求分析师。根据用户的输入和项目上下文，生成以下 JSON：
{
  "goal": "一句话描述任务目标",
  "scope": ["涉及的文件或模块"],
  "constraints": ["约束条件"],
  "acceptanceCriteria": ["验收标准"],
  "estimatedComplexity": "low|medium|high"
}
如果信息不足以填写某项，该字段留空数组或空字符串。只输出 JSON，不要其他内容。`;

const QUESTIONS_SYSTEM_PROMPT = (maxQuestions: number) => `你是需求分析师。用户的请求不够明确，请生成最多 ${maxQuestions} 个澄清问题。
每个问题用 JSON 格式：
{
  "questions": [
    { "id": 1, "question": "...", "options": ["选项A", "选项B"] }
  ]
}
如果没有需要澄清的，返回空数组：{"questions": []}。只输出 JSON，不要其他内容。`;

/**
 * RequirementsGatherer——需求确认阶段
 *
 * 策略选择（根据 classifier 结果）：
 *   - medium + confidence ≥ 0.7 → 自动确认（生成摘要，等 y/n）
 *   - complex 或 confidence < 0.7 → 主动追问（生成 2-3 个澄清问题）
 *   - reasoning → 规划模式（不经过需求确认，由调用方处理）
 */
export class RequirementsGatherer {
  /**
   * 收集需求——异步生成器，yield 交互事件
   *
   * 事件序列：
   *   自动确认路径：summary → (等待外部 confirmed/skipped)
   *   主动追问路径：questions → (等待外部回答) → summary → (等待外部 confirmed/skipped)
   *
   * 注意：本方法只生成事件，不处理用户交互。用户交互由 App.tsx 驱动，
   * 通过 setCollectedAnswers 注入答案后再次调用 gather 继续。
   */
  async *gather(params: {
    userInput: string;
    classification: ClassificationResult;
    projectContext?: ProjectContext;
    llmClient: ILLMClient;
    routeDecision: RoutingResult;
    maxQuestions?: number;
    /** 用户对澄清问题的回答（第二轮调用时传入） */
    collectedAnswers?: ClarifyingQuestion[];
  }): AsyncGenerator<RequirementsEvent> {
    const {
      userInput,
      classification,
      projectContext,
      llmClient,
      routeDecision,
      maxQuestions = 2,
      collectedAnswers,
    } = params;

    // reasoning → 跳过（由调用方进入 planning）
    if (classification.tier === 'reasoning') {
      yield { type: 'skipped', reason: 'reasoning 任务进入规划模式，不经过需求确认' };
      return;
    }

    // 如果有收集到的答案，将其合并到用户输入中生成最终摘要
    const effectiveInput = collectedAnswers && collectedAnswers.length > 0
      ? this.mergeAnswers(userInput, collectedAnswers)
      : userInput;

    // 决定策略：complex 或低 confidence → 主动追问；否则自动确认
    const needClarification =
      classification.tier === 'complex' ||
      classification.confidence < 0.7;

    // 主动追问路径（仅当尚未收集到答案时）
    // I7 修复：空数组 [] 是 truthy，需额外判断 length === 0
    if (needClarification && (!collectedAnswers || collectedAnswers.length === 0)) {
      try {
        const questions = await this.generateQuestions(
          userInput,
          projectContext,
          llmClient,
          routeDecision,
          maxQuestions,
        );
        if (questions.length > 0) {
          yield { type: 'questions', questions };
          // 等待外部收集答案后再次调用 gather（本生成器结束）
          return;
        }
      } catch (error) {
        logger.warn('RequirementsGatherer: generateQuestions failed, falling back to summary', {
          error: error instanceof Error ? error.message : String(error),
        });
        // 失败降级：继续走摘要路径
      }
    }

    // 生成需求摘要
    let summary: RequirementsSummary;
    try {
      summary = await this.generateSummary(effectiveInput, projectContext, llmClient, routeDecision);
    } catch (error) {
      logger.warn('RequirementsGatherer: generateSummary failed, skipping requirements', {
        error: error instanceof Error ? error.message : String(error),
      });
      // LLM 失败降级：跳过需求确认，直接执行
      yield {
        type: 'skipped',
        reason: `需求摘要生成失败：${error instanceof Error ? error.message : String(error)}`,
      };
      return;
    }

    // 自动确认路径：yield summary，等外部确认
    yield { type: 'summary', summary, needsConfirmation: true };
  }

  /**
   * 生成需求摘要
   */
  private async generateSummary(
    userInput: string,
    projectContext: ProjectContext | undefined,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
  ): Promise<RequirementsSummary> {
    const contextHint = this.formatContextHint(projectContext);
    const userMessage = `用户请求：${userInput}${contextHint}`;

    const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];
    const requestOptions: LLMRequestOptions = {
      model: routeDecision.model.id,
      messages,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      maxTokens: 1000,
      timeoutMs: 30000,
      stream: false,
    };

    const response = await llmClient.complete(requestOptions);
    return this.parseSummary(response.content);
  }

  /**
   * 生成澄清问题
   */
  private async generateQuestions(
    userInput: string,
    projectContext: ProjectContext | undefined,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    maxQuestions: number,
  ): Promise<ClarifyingQuestion[]> {
    const contextHint = this.formatContextHint(projectContext);
    const userMessage = `用户请求：${userInput}${contextHint}`;

    const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];
    const requestOptions: LLMRequestOptions = {
      model: routeDecision.model.id,
      messages,
      systemPrompt: QUESTIONS_SYSTEM_PROMPT(maxQuestions),
      maxTokens: 800,
      timeoutMs: 30000,
      stream: false,
    };

    const response = await llmClient.complete(requestOptions);
    return this.parseQuestions(response.content);
  }

  /**
   * 解析需求摘要 JSON
   */
  private parseSummary(content: string): RequirementsSummary {
    const jsonStr = this.extractJson(content);
    if (!jsonStr) {
      throw new Error('LLM 响应中未找到 JSON');
    }
    const parsed = JSON.parse(jsonStr) as Partial<RequirementsSummary>;
    return {
      goal: typeof parsed.goal === 'string' ? parsed.goal : '',
      scope: Array.isArray(parsed.scope) ? parsed.scope.filter((s) => typeof s === 'string') : [],
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.filter((s) => typeof s === 'string') : [],
      acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
        ? parsed.acceptanceCriteria.filter((s) => typeof s === 'string')
        : [],
      estimatedComplexity: parsed.estimatedComplexity === 'low' || parsed.estimatedComplexity === 'medium' || parsed.estimatedComplexity === 'high'
        ? parsed.estimatedComplexity
        : 'medium',
    };
  }

  /**
   * 解析澄清问题 JSON
   */
  private parseQuestions(content: string): ClarifyingQuestion[] {
    const jsonStr = this.extractJson(content);
    if (!jsonStr) {
      return [];
    }
    try {
      const parsed = JSON.parse(jsonStr) as { questions?: Array<{ id: number; question: string; options?: string[] }> };
      if (!parsed.questions || !Array.isArray(parsed.questions)) {
        return [];
      }
      return parsed.questions
        .filter((q) => typeof q.question === 'string' && q.question.length > 0)
        .map((q) => ({
          id: typeof q.id === 'number' ? q.id : 0,
          question: q.question,
          options: Array.isArray(q.options) ? q.options.filter((o) => typeof o === 'string') : undefined,
        }));
    } catch {
      return [];
    }
  }

  /**
   * 合并用户输入和澄清答案
   */
  private mergeAnswers(userInput: string, answers: ClarifyingQuestion[]): string {
    const answerText = answers
      .map((a) => `Q: ${a.question}\nA: ${a.options ? a.options.join(', ') : '(自由回答)'}`)
      .join('\n');
    return `${userInput}\n\n[用户补充回答]\n${answerText}`;
  }

  /**
   * 格式化项目上下文提示
   */
  private formatContextHint(projectContext?: ProjectContext): string {
    if (!projectContext) return '';
    const parts: string[] = [];
    if (projectContext.projectType) parts.push(`项目类型: ${projectContext.projectType}`);
    if (projectContext.recentTools && projectContext.recentTools.length > 0) {
      parts.push(`最近使用的工具: ${projectContext.recentTools.join(', ')}`);
    }
    if (projectContext.hasGitChanges !== undefined) {
      parts.push(`Git 有变更: ${projectContext.hasGitChanges ? '是' : '否'}`);
    }
    return parts.length > 0 ? `\n[项目上下文] ${parts.join('；')}` : '';
  }

  /**
   * 从 LLM 响应中提取 JSON（处理 markdown 代码块）
   */
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

/**
 * 创建 RequirementsGatherer 的工厂函数
 */
export function createRequirementsGatherer(): RequirementsGatherer {
  return new RequirementsGatherer();
}
