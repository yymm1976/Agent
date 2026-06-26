// src/agent/requirements-clarifier.ts
// Phase 37 Task 1：需求澄清器
// 当用户输入模糊目标时主动提问澄清，降低"猜错需求"导致的返工
// LLM 调用失败时降级为基于规则的模糊度检测（检查歧义词）

import type { ILLMClient, LLMMessage, LLMRequestOptions } from '../router/types.js';
import { logger } from '../utils/logger.js';

// --- 类型定义 ---

/** 澄清问题 */
interface ClarificationQuestion {
  /** 问题唯一标识 */
  id: string;
  /** 问题文本 */
  question: string;
  /** 为什么问这个问题（给用户上下文） */
  context: string;
  /** 是否可选（可选问题用户可以跳过） */
  optional: boolean;
  /** 问题类型：文本 / 单选 / 多选 */
  type: 'text' | 'single-choice' | 'multi-choice';
  /** 单选/多选时的选项列表 */
  options?: string[];
}

/** 澄清结果 */
interface ClarificationResult {
  /** 是否需要澄清 */
  needsClarification: boolean;
  /** 模糊度分数 0~1（越高越模糊） */
  score: number;
  /** 澄清问题列表 */
  questions: ClarificationQuestion[];
  /** 增强后的目标文本（enrichGoal 调用后填充） */
  enrichedGoal?: string;
}

/** 构造参数 */
interface RequirementsClarifierOptions {
  /** LLM 客户端（应使用便宜的分类器模型） */
  llmClient: ILLMClient;
  /** 模型 ID */
  modelId: string;
  /** 模糊度阈值，达到此值才追问（默认 0.4） */
  threshold?: number;
  /** 最多追问问题数（默认 3） */
  maxQuestions?: number;
  /** 置信度高时是否自动跳过（默认 true，score < 0.2 时跳过） */
  skipIfConfident?: boolean;
}

// --- Prompt 设计 ---

const CLARIFY_SYSTEM_PROMPT = `你是 RouteDev 的需求模糊度分析器。请分析用户输入的目标描述的模糊度，并生成澄清问题。

输出严格的 JSON 格式（不要输出任何其他内容）：
{
  "score": 0.0-1.0,
  "reasoning": "模糊度判定理由",
  "questions": [
    {
      "id": "q1",
      "question": "澄清问题文本",
      "context": "为什么问这个问题",
      "optional": true|false,
      "type": "text"|"single-choice"|"multi-choice",
      "options": ["选项A", "选项B"]
    }
  ]
}

模糊度判定维度（逐条检查）：
1. 缺少具体对象：未指明要操作的文件/模块/函数
2. 缺少范围：未说明修改的边界（哪些改、哪些不改）
3. 缺少标准：未给出验收标准或成功条件
4. 包含歧义词汇：如"这个""那个""优化""重构""改进""一些"等指代不明的词

评分标准：
- 0.0~0.2：目标清晰，有明确对象、范围和标准，可直接执行
- 0.2~0.5：部分模糊，但可推断意图
- 0.5~0.8：明显模糊，需要澄清才能执行
- 0.8~1.0：极度模糊，几乎无法理解意图

问题生成规则：
- 仅在 score >= 0.3 时生成问题
- 问题数量不超过 maxQuestions 参数
- 每个问题应针对一个具体的模糊维度
- optional=true 表示该问题可跳过
- type 为 single-choice/multi-choice 时必须提供 options`;

const ENRICH_SYSTEM_PROMPT = `你是需求整合助手。请将用户原始目标与澄清回答合并为一段清晰、完整的目标描述。

输出严格的 JSON 格式（不要输出任何其他内容）：
{
  "enrichedGoal": "合并后的目标描述"
}

要求：
- 保留原始目标的核心意图
- 将回答中的关键信息融入目标描述
- 使目标描述包含明确的对象、范围和标准
- 输出应是一段自然流畅的文字，不是列表`;

// --- 规则层歧义词（LLM 失败时降级使用） ---

// 指代不明的词
const AMBIGUOUS_WORDS = [
  '这个', '那个', '这些', '那些', '它', '它们',
  'this', 'that', 'these', 'those', 'it',
];
// 模糊动作词
const VAGUE_ACTION_WORDS = [
  '优化', '重构', '改进', '改善', '调整', '修改', '处理', '搞定', '弄一下', '搞一下',
  'optimize', 'refactor', 'improve', 'enhance', 'fix', 'update', 'handle',
];
// 模糊量词
const VAGUE_QUANTIFIERS = [
  '一些', '几个', '好多', '很多', '适当', '合理',
  'some', 'several', 'many', 'proper', 'appropriate',
];

/**
 * RequirementsClarifier——需求澄清器
 *
 * 工作流程：
 *   1. clarify()：调用 LLM 分析目标模糊度，返回 0~1 分数和追问列表
 *      - score < threshold → needsClarification=false，直接执行
 *      - score >= threshold → 生成 1~maxQuestions 个澄清问题
 *      - LLM 失败时降级为基于规则的模糊度检测
 *   2. enrichGoal()：将用户回答合并到目标文本，生成增强后的目标
 */
export class RequirementsClarifier {
  private readonly options: Required<RequirementsClarifierOptions>;

  constructor(options: RequirementsClarifierOptions) {
    this.options = {
      threshold: 0.4,
      maxQuestions: 3,
      skipIfConfident: true,
      ...options,
    };
  }

  /**
   * 分析目标模糊度，决定是否需要澄清
   *
   * @param goalText 用户输入的目标描述
   * @returns 澄清结果（含模糊度分数和问题列表）
   */
  async clarify(goalText: string): Promise<ClarificationResult> {
    // 先尝试 LLM 分析
    try {
      const llmResult = await this.analyzeWithLlm(goalText);
      return this.buildResult(llmResult.score, llmResult.questions, goalText);
    } catch (error) {
      // LLM 失败降级：基于规则的模糊度检测
      logger.warn('RequirementsClarifier: LLM 分析失败，降级为规则检测', {
        error: error instanceof Error ? error.message : String(error),
      });
      const ruleResult = this.analyzeWithRules(goalText);
      return this.buildResult(ruleResult.score, ruleResult.questions, goalText);
    }
  }

  /**
   * 将用户回答合并到目标文本，生成增强后的目标
   *
   * @param goalText 原始目标描述
   * @param answers 用户对澄清问题的回答（key 为问题 id，value 为回答内容）
   * @returns 增强后的目标文本
   */
  async enrichGoal(goalText: string, answers: Record<string, string>): Promise<string> {
    // 无回答时直接返回原文
    if (Object.keys(answers).length === 0) {
      return goalText;
    }

    try {
      const response = await this.callLlm(
        ENRICH_SYSTEM_PROMPT,
        this.buildEnrichUserMessage(goalText, answers),
      );
      const parsed = this.parseJson(response.content) as { enrichedGoal?: string };
      if (parsed.enrichedGoal && typeof parsed.enrichedGoal === 'string') {
        return parsed.enrichedGoal;
      }
      // LLM 返回但字段缺失，降级为简单拼接
      return this.fallbackEnrich(goalText, answers);
    } catch (error) {
      logger.warn('RequirementsClarifier: enrichGoal LLM 调用失败，降级为简单拼接', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fallbackEnrich(goalText, answers);
    }
  }

  // --- 内部方法 ---

  /**
   * 调用 LLM 分析模糊度
   */
  private async analyzeWithLlm(goalText: string): Promise<{
    score: number;
    questions: ClarificationQuestion[];
  }> {
    const userMessage = `目标描述：${goalText}\n\nmaxQuestions：${this.options.maxQuestions}`;
    const response = await this.callLlm(CLARIFY_SYSTEM_PROMPT, userMessage);
    const parsed = this.parseJson(response.content) as {
      score?: number;
      reasoning?: string;
      questions?: Array<Partial<ClarificationQuestion>>;
    };

    const score = this.clampScore(parsed.score);
    const questions = this.normalizeQuestions(parsed.questions, this.options.maxQuestions);

    logger.debug('RequirementsClarifier: LLM 分析完成', {
      score,
      questionCount: questions.length,
    });

    return { score, questions };
  }

  /**
   * 基于规则的模糊度检测（LLM 失败降级方案）
   * 检查歧义词、模糊动作词、模糊量词
   */
  private analyzeWithRules(goalText: string): {
    score: number;
    questions: ClarificationQuestion[];
  } {
    const lowerText = goalText.toLowerCase();
    let ambiguousCount = 0;
    const matchedWords: string[] = [];

    // 检查歧义词
    for (const word of AMBIGUOUS_WORDS) {
      if (lowerText.includes(word.toLowerCase())) {
        ambiguousCount++;
        matchedWords.push(word);
      }
    }
    // 检查模糊动作词
    for (const word of VAGUE_ACTION_WORDS) {
      if (lowerText.includes(word.toLowerCase())) {
        ambiguousCount++;
        matchedWords.push(word);
      }
    }
    // 检查模糊量词
    for (const word of VAGUE_QUANTIFIERS) {
      if (lowerText.includes(word.toLowerCase())) {
        ambiguousCount++;
        matchedWords.push(word);
      }
    }

    // 每个歧义词贡献 0.2 分，上限 1.0
    const score = Math.min(ambiguousCount * 0.2, 1.0);

    // 根据匹配的歧义词生成规则化问题
    const questions: ClarificationQuestion[] = [];
    if (matchedWords.some((w) => VAGUE_ACTION_WORDS.includes(w))) {
      questions.push({
        id: 'q_action',
        question: '请具体说明要做什么操作？（如：新增函数、修改某段逻辑、删除某文件）',
        context: '目标中包含模糊动作词，需要明确具体操作',
        optional: false,
        type: 'text',
      });
    }
    if (matchedWords.some((w) => AMBIGUOUS_WORDS.includes(w))) {
      questions.push({
        id: 'q_target',
        question: '请指明操作的具体对象是哪个文件或模块？',
        context: '目标中包含指代不明的词，需要明确操作对象',
        optional: false,
        type: 'text',
      });
    }
    if (questions.length < this.options.maxQuestions) {
      questions.push({
        id: 'q_criteria',
        question: '完成后如何验证？（如：测试通过、类型检查无误）',
        context: '目标未给出验收标准',
        optional: true,
        type: 'text',
      });
    }

    // 截断到 maxQuestions
    return {
      score,
      questions: questions.slice(0, this.options.maxQuestions),
    };
  }

  /**
   * 根据分数和阈值构建最终结果
   */
  private buildResult(
    score: number,
    questions: ClarificationQuestion[],
    goalText: string,
  ): ClarificationResult {
    // 置信度高时自动跳过（score < 0.2 视为足够清晰）
    if (this.options.skipIfConfident && score < 0.2) {
      return { needsClarification: false, score, questions: [] };
    }

    // 分数低于阈值 → 不需要澄清
    if (score < this.options.threshold) {
      return { needsClarification: false, score, questions: [] };
    }

    // 分数达到阈值 → 需要澄清，附带问题
    return {
      needsClarification: true,
      score,
      questions: questions.slice(0, this.options.maxQuestions),
    };
  }

  /**
   * 调用 LLM（统一封装）
   */
  private async callLlm(systemPrompt: string, userMessage: string) {
    const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];
    const requestOptions: LLMRequestOptions = {
      model: this.options.modelId,
      messages,
      systemPrompt,
      temperature: 0.3,
      maxTokens: 1000,
      stream: false,
    };
    return this.options.llmClient.complete(requestOptions);
  }

  /**
   * 构建 enrichGoal 的用户消息
   */
  private buildEnrichUserMessage(
    goalText: string,
    answers: Record<string, string>,
  ): string {
    const answerLines = Object.entries(answers)
      .map(([id, answer]) => `  [${id}] ${answer}`)
      .join('\n');
    return `原始目标：${goalText}\n\n用户澄清回答：\n${answerLines}`;
  }

  /**
   * 降级拼接：LLM 失败时简单合并回答
   */
  private fallbackEnrich(goalText: string, answers: Record<string, string>): string {
    const answerText = Object.entries(answers)
      .map(([id, answer]) => `[${id}] ${answer}`)
      .join('；');
    return `${goalText}（补充：${answerText}）`;
  }

  /**
   * 将分数限制在 [0, 1] 范围
   */
  private clampScore(score: unknown): number {
    if (typeof score !== 'number' || isNaN(score)) return 0.5;
    return Math.max(0, Math.min(1, score));
  }

  /**
   * 规范化问题列表：过滤无效项、补全字段、截断到 maxQuestions
   */
  private normalizeQuestions(
    raw: Array<Partial<ClarificationQuestion>> | undefined,
    maxQuestions: number,
  ): ClarificationQuestion[] {
    if (!Array.isArray(raw)) return [];

    const valid = raw
      .filter((q) => typeof q.question === 'string' && q.question.length > 0)
      .map((q, idx) => {
        const type: ClarificationQuestion['type'] =
          q.type === 'single-choice' || q.type === 'multi-choice' ? q.type : 'text';
        return {
          id: typeof q.id === 'string' && q.id.length > 0 ? q.id : `q${idx + 1}`,
          question: q.question!,
          context: typeof q.context === 'string' ? q.context : '',
          optional: typeof q.optional === 'boolean' ? q.optional : true,
          type,
          options:
            type !== 'text' && Array.isArray(q.options)
              ? q.options.filter((o) => typeof o === 'string')
              : undefined,
        } as ClarificationQuestion;
      });

    return valid.slice(0, maxQuestions);
  }

  /**
   * 从 LLM 响应中提取并解析 JSON
   * 支持 markdown 代码块包裹和裸 JSON
   */
  private parseJson(content: string): Record<string, unknown> {
    const jsonStr = this.extractJson(content);
    if (!jsonStr) {
      throw new Error('LLM 响应中未找到 JSON');
    }
    return JSON.parse(jsonStr) as Record<string, unknown>;
  }

  /**
   * 从文本中提取 JSON 字符串（处理 markdown 代码块）
   */
  private extractJson(content: string): string | null {
    // 1. 优先匹配 markdown 代码块
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    // 2. 匹配裸 JSON 对象（从第一个 { 到最后一个 }）
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }
    return null;
  }
}

// 暴露规则关键词供测试
export { AMBIGUOUS_WORDS, VAGUE_ACTION_WORDS, VAGUE_QUANTIFIERS };
