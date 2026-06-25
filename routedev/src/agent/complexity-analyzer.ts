// src/agent/complexity-analyzer.ts
// Phase 31 Task 3：任务分解与复杂度评估
// 规则层（快速，不需要 LLM）+ LLM 层（仅在规则无法判断时调用）
// 凡是能用确定性逻辑解决的，不扔给 LLM——更快、更省、更可控

import type { ILLMClient, LLMMessage, LLMRequestOptions, RoutingResult } from '../router/types.js';
import type { GoalPlan, GoalStep } from './goal-types.js';
import { logger } from '../utils/logger.js';
import type { StepComplexity, WorkerRole, RequirementsSummary } from './task-orchestrator-types.js';

// --- 规则层关键词 ---

// 简单操作关键词（只读类）
const SIMPLE_READ_KEYWORDS = ['读取', '查看', '检查', 'read', 'view', 'check', 'list', 'show', 'cat'];
// 简单操作不能包含的修改类关键词
const MODIFY_KEYWORDS = ['修改', '创建', '删除', '重构', '迁移', 'modify', 'create', 'delete', 'refactor', 'migrate'];
// 复杂操作关键词
const COMPLEX_KEYWORDS = ['重构', '迁移', '架构', 'refactor', 'migrate', 'architecture', 'redesign'];

// LLM 复杂度评估 prompt
const COMPLEXITY_LLM_PROMPT = `分析以下开发步骤的复杂度，返回 JSON 数组：
[{
  "stepId": 1,
  "complexity": "simple|medium|complex",
  "estimatedFiles": 3,
  "needsSubAgent": false,
  "recommendedRole": "coder|tester|searcher|reviewer",
  "parallelizable": true
}]

判定标准：
- simple: 1-2 个文件，单一操作，不需要理解上下文
- medium: 2-5 个文件，需要理解模块结构
- complex: 5+ 文件，跨模块，需要理解业务逻辑

recommendedRole 选择：
- coder: 涉及代码修改
- tester: 涉及测试编写或运行
- searcher: 涉及代码搜索或文档查阅
- reviewer: 涉及代码审查

只输出 JSON 数组，不要其他内容。`;

/**
 * TaskComplexityAnalyzer——任务复杂度评估
 *
 * 评估逻辑（规则 + LLM 混合）：
 *   1. 规则层（快速）：
 *      - 含"读取/查看/检查"且不含"修改/创建" → simple
 *      - 含"重构/迁移/架构" → complex
 *      - 其余 → 需要 LLM 判断
 *   2. LLM 层：仅在规则无法判断时调用
 */
export class TaskComplexityAnalyzer {
  /**
   * 分析每个步骤的复杂度
   * @returns Map<stepId, StepComplexity>
   */
  async analyze(params: {
    steps: GoalStep[];
    requirements: RequirementsSummary;
    llmClient: ILLMClient;
    routeDecision: RoutingResult;
  }): Promise<Map<number, StepComplexity>> {
    const { steps, requirements, llmClient, routeDecision } = params;

    // 第一轮：规则层判定
    const ruleResults = new Map<number, StepComplexity>();
    const needLlm: GoalStep[] = [];

    for (const step of steps) {
      const ruleResult = this.applyRules(step);
      if (ruleResult) {
        ruleResults.set(step.id, ruleResult);
      } else {
        needLlm.push(step);
      }
    }

    logger.debug('TaskComplexityAnalyzer: rule layer results', {
      total: steps.length,
      ruleDecided: ruleResults.size,
      needLlm: needLlm.length,
    });

    // 第二轮：LLM 判定剩余步骤
    if (needLlm.length > 0) {
      try {
        const llmResults = await this.analyzeWithLlm(needLlm, requirements, llmClient, routeDecision);
        for (const [stepId, complexity] of llmResults) {
          ruleResults.set(stepId, complexity);
        }
      } catch (error) {
        logger.warn('TaskComplexityAnalyzer: LLM analysis failed, falling back to medium', {
          error: error instanceof Error ? error.message : String(error),
        });
        // LLM 失败降级：全部按 medium 处理
        for (const step of needLlm) {
          ruleResults.set(step.id, this.fallbackMedium(step));
        }
      }
    }

    // 应用 needsSubAgent 总开关：如果整个任务只有 1 步或全部 simple，不使用子 Agent
    this.applySubAgentSwitch(ruleResults, steps);

    return ruleResults;
  }

  /**
   * 规则层判定——返回 null 表示需要 LLM 判断
   */
  private applyRules(step: GoalStep): StepComplexity | null {
    const desc = step.description.toLowerCase();

    // 简单读取类
    const hasReadKeyword = SIMPLE_READ_KEYWORDS.some((kw) => desc.includes(kw.toLowerCase()));
    const hasModifyKeyword = MODIFY_KEYWORDS.some((kw) => desc.includes(kw.toLowerCase()));
    if (hasReadKeyword && !hasModifyKeyword) {
      return this.buildComplexity(step.id, 'simple', 1, 'searcher', false);
    }

    // 复杂重构类
    const hasComplexKeyword = COMPLEX_KEYWORDS.some((kw) => desc.includes(kw.toLowerCase()));
    if (hasComplexKeyword) {
      return this.buildComplexity(step.id, 'complex', 5, 'coder', false);
    }

    // 规则无法判断
    return null;
  }

  /**
   * LLM 层判定
   */
  private async analyzeWithLlm(
    steps: GoalStep[],
    requirements: RequirementsSummary,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
  ): Promise<Map<number, StepComplexity>> {
    // I5 修复：用 JSON.stringify 构造，正确转义换行/反斜杠等特殊字符
    const stepsText = steps
      .map((s) => JSON.stringify({ stepId: s.id, description: s.description }))
      .join(',\n');

    const userMessage = `需求目标：${requirements.goal}\n待评估步骤：\n[${stepsText}]`;
    const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];

    const requestOptions: LLMRequestOptions = {
      model: routeDecision.model.id,
      messages,
      systemPrompt: COMPLEXITY_LLM_PROMPT,
      maxTokens: 1500,
      timeoutMs: 30000,
      stream: false,
    };

    const response = await llmClient.complete(requestOptions);
    return this.parseLlmResults(response.content, steps);
  }

  /**
   * 解析 LLM 返回的复杂度数组
   */
  private parseLlmResults(content: string, originalSteps: GoalStep[]): Map<number, StepComplexity> {
    const jsonStr = this.extractJson(content);
    if (!jsonStr) {
      throw new Error('LLM 响应中未找到 JSON');
    }

    const parsed = JSON.parse(jsonStr) as Array<{
      stepId: number;
      complexity: 'simple' | 'medium' | 'complex';
      estimatedFiles: number;
      needsSubAgent: boolean;
      recommendedRole: WorkerRole;
      parallelizable: boolean;
    }>;

    const result = new Map<number, StepComplexity>();
    const validStepIds = new Set(originalSteps.map((s) => s.id));

    for (const item of parsed) {
      if (!validStepIds.has(item.stepId)) continue;
      const role: WorkerRole = ['coder', 'tester', 'searcher', 'reviewer'].includes(item.recommendedRole)
        ? item.recommendedRole
        : 'coder';
      result.set(item.stepId, {
        stepId: item.stepId,
        complexity: item.complexity === 'simple' || item.complexity === 'medium' || item.complexity === 'complex'
          ? item.complexity
          : 'medium',
        estimatedFiles: typeof item.estimatedFiles === 'number' ? item.estimatedFiles : 3,
        needsSubAgent: !!item.needsSubAgent,
        recommendedRole: role,
        parallelizable: !!item.parallelizable,
        dependencies: [],
      });
    }

    // 兜底：LLM 漏掉的步骤按 medium
    for (const step of originalSteps) {
      if (!result.has(step.id)) {
        result.set(step.id, this.fallbackMedium(step));
      }
    }

    return result;
  }

  /**
   * 构建 StepComplexity 对象
   */
  private buildComplexity(
    stepId: number,
    complexity: 'simple' | 'medium' | 'complex',
    estimatedFiles: number,
    role: WorkerRole,
    parallelizable: boolean,
  ): StepComplexity {
    return {
      stepId,
      complexity,
      estimatedFiles,
      needsSubAgent: this.decideSubAgent(complexity, estimatedFiles, parallelizable),
      recommendedRole: role,
      parallelizable,
      dependencies: [],
    };
  }

  /**
   * needsSubAgent 判定规则
   * - complex → true
   * - medium && estimatedFiles > 3 → true
   * - parallelizable → true
   * - 其余 → false
   */
  private decideSubAgent(
    complexity: 'simple' | 'medium' | 'complex',
    estimatedFiles: number,
    parallelizable: boolean,
  ): boolean {
    if (complexity === 'complex') return true;
    if (complexity === 'medium' && estimatedFiles > 3) return true;
    if (parallelizable) return true;
    return false;
  }

  /**
   * 降级 medium 复杂度
   */
  private fallbackMedium(step: GoalStep): StepComplexity {
    return this.buildComplexity(step.id, 'medium', 3, 'coder', false);
  }

  /**
   * 应用子 Agent 总开关
   * 如果整个任务只有 1 个步骤，或所有步骤都是 simple，则不使用子 Agent
   */
  private applySubAgentSwitch(results: Map<number, StepComplexity>, steps: GoalStep[]): void {
    if (steps.length <= 1) {
      for (const complexity of results.values()) {
        complexity.needsSubAgent = false;
      }
      return;
    }
    const allSimple = Array.from(results.values()).every((c) => c.complexity === 'simple');
    if (allSimple) {
      for (const complexity of results.values()) {
        complexity.needsSubAgent = false;
      }
    }
  }

  /**
   * 从 LLM 响应中提取 JSON
   */
  private extractJson(content: string): string | null {
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    // 数组形式：找第一个 [ 到最后一个 ]
    const firstBracket = content.indexOf('[');
    const lastBracket = content.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) {
      return content.slice(firstBracket, lastBracket + 1);
    }
    // 对象形式
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return content.slice(firstBrace, lastBrace + 1);
    }
    return null;
  }
}

/**
 * 创建 TaskComplexityAnalyzer 的工厂函数
 */
export function createTaskComplexityAnalyzer(): TaskComplexityAnalyzer {
  return new TaskComplexityAnalyzer();
}

// 暴露规则关键词供测试
export { SIMPLE_READ_KEYWORDS, MODIFY_KEYWORDS, COMPLEX_KEYWORDS };
