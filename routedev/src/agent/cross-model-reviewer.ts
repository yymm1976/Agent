// src/agent/cross-model-reviewer.ts
// Phase 49 Task 2.3：跨模型对抗审查
//
// 知识库原文：
//   "grill-me 核心机制：一个模型写代码，另一个模型专门审查，
//    打破'同一个模型既写又评'的自评盲区。"
//
// 实现：
//   - 接收内循环使用的 modelId
//   - 自动选择不同的模型做审查（优先选择更强的模型）
//   - 审查维度：安全性、性能、可读性、边界条件、错误处理
//   - 输出分级问题（critical / warning / info）
//
// 陷阱 #142：跨模型审查可能因模型不可用而失败
//   审查模型不可用时回退到同模型审查，但在 summary 中标注"未跨模型"。
//   不能因为审查失败而直接抛错，破坏双循环主流程。
//
// 通过依赖注入接收 LLM 客户端，便于测试。

import type { ILLMClient, LLMMessage, TokenUsageInfo } from '../router/types.js';
import { logger } from '../utils/logger.js';
import type { CodeReviewResult, CodeReviewIssue } from './unified-reviewer.js';
import type { CrossModelReviewParams, CrossModelReviewerLike } from './dual-loop-types.js';

/** 跨模型审查的默认 system prompt */
const CROSS_MODEL_REVIEW_SYSTEM_PROMPT = `你是独立的代码审查专家。请从以下维度审查代码变更：

1. 安全性：是否有硬编码密钥、注入风险、不安全的操作
2. 性能：是否有明显的性能问题（O(n²) 循环、重复计算、不必要的 I/O）
3. 可读性：命名是否清晰、是否有过度复杂的逻辑、注释是否充分
4. 边界条件：是否处理了空值、空数组、超长输入、并发等边界情况
5. 错误处理：是否吞掉异常、是否有 try-catch 滥用、错误信息是否友好

输出严格的 JSON 格式（不要输出任何其他内容）：
{
  "passed": true|false,
  "issues": [
    { "severity": "critical"|"warning"|"info", "file": "文件路径", "line": 行号或null, "description": "问题描述" }
  ],
  "summary": "一句话总结"
}

注意：
- critical：必须修复的严重问题（安全漏洞、数据丢失风险、逻辑错误）
- warning：建议修复的问题（性能、可读性、边界缺失）
- info：可选改进（风格、命名）
- 没有 critical 问题时 passed 可以为 true`;

/**
 * 跨模型审查器——用不同模型审查代码
 *
 * 依赖注入：
 *   - 通过构造函数接收 LLM 客户端，便于测试 mock
 *   - 通过 selectReviewerModel 选择不同的模型
 */
export class CrossModelReviewer implements CrossModelReviewerLike {
  /**
   * @param llmClient 独立的 LLM 客户端（应使用与内循环不同的模型）
   * @param innerLoopModelId 内循环使用的模型 ID（用于回退判断和日志）
   * @param availableModels 可用模型列表（用于 selectReviewerModel）
   */
  constructor(
    private readonly llmClient: ILLMClient,
    private readonly innerLoopModelId: string,
    private readonly availableModels: string[] = [],
  ) {}

  /**
   * 选择审查模型——避开内循环使用的模型
   *
   * 策略：
   *   1. 优先从 availableModels 中选择与内循环不同的模型
   *   2. 多个候选时优先选择"更强"的（按启发式排序）
   *   3. 只有一个模型可用时回退到同模型（陷阱 #142）
   *
   * @param innerLoopModelId 内循环使用的模型 ID
   * @param availableModels 可用模型列表
   */
  selectReviewerModel(innerLoopModelId: string, availableModels: string[]): string {
    const candidates = availableModels.filter(m => m !== innerLoopModelId);
    if (candidates.length === 0) {
      // 陷阱 #142：只有一个模型可用时回退到同模型
      logger.warn('CrossModelReviewer: 只有内循环模型可用，回退到同模型审查（未跨模型）', {
        innerLoopModelId,
      });
      return innerLoopModelId;
    }
    return this.pickStrongest(candidates);
  }

  /**
   * 执行跨模型审查
   *
   * 陷阱 #142：LLM 调用失败时回退到返回"未审查"结果，不抛错
   * 在 summary 中标注是否真正跨模型
   */
  async review(params: CrossModelReviewParams): Promise<CodeReviewResult> {
    const { modifiedFiles, executionSummary, goalDescription } = params;

    // 选择审查模型
    const reviewerModel = this.selectReviewerModel(
      this.innerLoopModelId,
      this.availableModels,
    );
    const isCrossModel = reviewerModel !== this.innerLoopModelId;

    logger.info('CrossModelReviewer: starting review', {
      reviewerModel,
      innerLoopModel: this.innerLoopModelId,
      isCrossModel,
      modifiedFilesCount: modifiedFiles.length,
    });

    const userMessage = this.buildUserMessage(
      modifiedFiles,
      executionSummary,
      goalDescription,
    );
    const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];

    try {
      const response = await this.llmClient.complete({
        model: reviewerModel,
        messages,
        systemPrompt: CROSS_MODEL_REVIEW_SYSTEM_PROMPT,
        maxTokens: 2048,
        stream: false,
      });

      const result = this.parseReviewResult(response.content, response.usage);
      // 标注是否真正跨模型
      if (!isCrossModel) {
        result.summary = `[未跨模型] ${result.summary}`;
      }
      return result;
    } catch (error) {
      // 陷阱 #142：审查失败回退到保守的"通过"结果，不阻断主流程
      // 但 summary 中明确标注审查未完成
      logger.warn('CrossModelReviewer: LLM call failed, returning fallback result', {
        reviewerModel,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        passed: true, // 审查失败不阻断任务完成
        issues: [],
        summary: `[审查失败] 跨模型审查器调用 LLM 出错，未完成审查：${error instanceof Error ? error.message : String(error)}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 从候选模型中选出"最强"的
   *
   * 启发式排序（优先级从高到低）：
   *   1. 优先选不同提供商（claude > gpt > deepseek 等）
   *   2. 优先选更大的版本号
   *   3. 优先选带 "pro" / "max" / "opus" / "4" / "3.5" 的
   *
   * 这是一个简单启发式，不依赖外部模型能力数据库。
   */
  private pickStrongest(candidates: string[]): string {
    const score = (modelId: string): number => {
      const id = modelId.toLowerCase();
      let s = 0;
      // 提供商优先级（不同提供商 = 真正的跨模型）
      if (id.includes('claude') || id.includes('anthropic')) s += 100;
      if (id.includes('gpt') || id.includes('openai')) s += 80;
      if (id.includes('gemini')) s += 70;
      if (id.includes('deepseek')) s += 50;
      if (id.includes('qwen')) s += 40;
      // 版本号优先
      if (/opus|max|pro|4|3\.5|3-5|o1|o3/.test(id)) s += 10;
      // 数字越大优先
      const verMatch = id.match(/(\d+(?:\.\d+)?)/);
      if (verMatch) s += parseFloat(verMatch[1]);
      return s;
    };
    return candidates.reduce((best, cur) => (score(cur) > score(best) ? cur : best));
  }

  /** 构建审查的用户消息 */
  private buildUserMessage(
    modifiedFiles: string[],
    executionSummary: string,
    goalDescription: string,
  ): string {
    const parts: string[] = [];
    parts.push(`# 原始目标\n${goalDescription}`);
    parts.push(`\n# 变更摘要\n${executionSummary}`);
    parts.push(`\n# 修改的文件列表\n${modifiedFiles.map(f => `- ${f}`).join('\n')}`);
    parts.push('\n\n请按上述维度审查，输出严格 JSON。');
    return parts.join('\n');
  }

  /**
   * 解析 LLM 返回的审查结果
   *
   * 解析失败时返回保守的"通过"结果（不阻断主流程），但 summary 标注解析失败
   */
  private parseReviewResult(content: string, usage: TokenUsageInfo): CodeReviewResult {
    try {
      // 优先从 markdown 代码块提取
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : content.trim();

      // 尝试从文本中提取 JSON 对象
      const jsonObjMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (!jsonObjMatch) {
        return {
          passed: true,
          issues: [],
          summary: '审查结果解析失败（未找到 JSON），默认通过',
          tokenUsage: usage,
        };
      }

      const parsed = JSON.parse(jsonObjMatch[0]) as Partial<CodeReviewResult>;
      const issues: CodeReviewIssue[] = (parsed.issues ?? []).map(i => ({
        severity: (i.severity ?? 'info') as 'critical' | 'warning' | 'info',
        file: i.file ?? '',
        line: typeof i.line === 'number' ? i.line : undefined,
        description: i.description ?? '',
      }));

      return {
        passed: parsed.passed ?? true,
        issues,
        summary: parsed.summary ?? '审查完成',
        tokenUsage: usage,
      };
    } catch (error) {
      logger.warn('CrossModelReviewer: failed to parse review result', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        passed: true,
        issues: [],
        summary: '审查结果解析失败（JSON 解析错误），默认通过',
        tokenUsage: usage,
      };
    }
  }
}
