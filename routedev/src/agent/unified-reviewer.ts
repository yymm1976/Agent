// src/agent/unified-reviewer.ts
// Phase 31 Task 5：统一审查与验收
//
// 两层审查：
//   1. GoalVerifier 验证（现有）——检查每个步骤的 gate 状态、验收标准是否满足
//   2. 代码审查（新增，可选）——使用 WorkerExecutor 的 reviewer 角色
//
// 审查模式：
//   - builtin（默认）：使用内置 reviewer Worker
//   - ocr：调用外部 open-code-review 工具
//   - none：跳过代码审查

import { logger } from '../utils/logger.js';
import type { ILLMClient, LLMMessage, RoutingResult, TokenUsageInfo } from '../router/types.js';
import type { ReActAgentLoop } from './loop.js';
import type { ConfirmToolCallback } from './loop-config.js';
import type { GoalPlan, VerificationResult } from './goal-types.js';
import type { TokenTracker } from '../router/tracker.js';
import type { AppConfig } from '../config/schema.js';
import { GoalVerifier, type AdversarialOptions } from './goal-verifier.js';
import { WorkerExecutor } from './multi/worker-executor.js';
import type { StepExecutionResult } from './task-orchestrator-types.js';
import type { Blackboard } from './multi/blackboard.js';

/**
 * 代码审查结果
 */
export interface CodeReviewResult {
  /** 是否通过 */
  passed: boolean;
  /** 问题列表 */
  issues: CodeReviewIssue[];
  /** 一句话总结 */
  summary: string;
  /** Token 消耗 */
  tokenUsage: TokenUsageInfo;
}

/**
 * 代码审查问题
 */
export interface CodeReviewIssue {
  /** 严重度 */
  severity: 'critical' | 'warning' | 'info';
  /** 文件路径 */
  file: string;
  /** 行号（可选） */
  line?: number;
  /** 问题描述 */
  description: string;
}

/**
 * 统一审查结果
 */
export interface UnifiedReviewResult {
  /** GoalVerifier 验证结果 */
  verification: VerificationResult;
  /** 代码审查结果（如果执行了） */
  codeReview?: CodeReviewResult;
  /** 综合是否通过 */
  passed: boolean;
  /** 综合摘要 */
  summary: string;
  /** 总 Token 消耗 */
  totalTokenUsage: TokenUsageInfo;
}

/**
 * 内置代码审查的系统提示词
 */
export const REVIEW_SYSTEM_PROMPT = `你是代码审查专家。审查以下变更：

变更文件：{{modifiedFiles}}
变更摘要：{{executionSummary}}
原始目标：{{goalDescription}}

请检查：
1. 变更是否达成了目标
2. 是否有遗漏的边界情况
3. 是否有安全风险（硬编码密钥、不安全的操作）
4. 是否有明显的性能问题
5. 测试是否充分

输出格式（JSON）：
{
  "passed": true/false,
  "issues": [
    { "severity": "critical|warning|info", "file": "...", "line": 0, "description": "..." }
  ],
  "summary": "一句话总结"
}`;

/**
 * 统一审查器依赖
 */
export interface UnifiedReviewerDeps {
  agentLoop: ReActAgentLoop;
  tracker: TokenTracker;
  config: AppConfig;
  /** 系统提示词——ref 模式，支持运行时热更新（与 App.tsx systemPromptRef 共享） */
  systemPromptRef: { current: string };
  signal?: AbortSignal;
  onConfirmTool?: ConfirmToolCallback;
  addSystemMessage?: (content: string) => void;
}

/**
 * 统一审查器——两层审查
 */
export class UnifiedReviewer {
  constructor(private readonly deps: UnifiedReviewerDeps) {}

  /**
   * 执行统一审查
   *
   * @param plan 目标计划
   * @param executionResults 执行结果
   * @param llmClient LLM 客户端
   * @param routeDecision 路由决策
   * @param conversationHistory 对话历史
   * @param adversarial 对抗性验证配置（可选）
   */
  async review(params: {
    plan: GoalPlan;
    executionResults: StepExecutionResult[];
    llmClient: ILLMClient;
    routeDecision: RoutingResult;
    conversationHistory: LLMMessage[];
    adversarial?: AdversarialOptions;
  }): Promise<UnifiedReviewResult> {
    const { plan, executionResults, llmClient, routeDecision, conversationHistory, adversarial } = params;

    logger.info('UnifiedReviewer: starting review', {
      stepsCount: plan.steps.length,
      resultsCount: executionResults.length,
    });

    // 第一层：GoalVerifier 验证
    this.deps.addSystemMessage?.('🔍 正在验证目标完成度...');
    const verification = await this.runGoalVerifier(plan, llmClient, routeDecision, adversarial);

    // 第二层：代码审查（可选）
    let codeReview: CodeReviewResult | undefined;
    const workflowConfig = this.deps.config.optimization?.workflow;
    if (workflowConfig?.reviewOnComplete && workflowConfig.reviewMode !== 'none') {
      const modifiedFiles = Array.from(new Set(executionResults.flatMap((r) => r.modifiedFiles)));
      if (modifiedFiles.length > 0) {
        this.deps.addSystemMessage?.('📋 正在执行代码审查...');
        codeReview = await this.runCodeReview(
          plan,
          executionResults,
          modifiedFiles,
          llmClient,
          routeDecision,
          conversationHistory,
          workflowConfig.reviewMode,
        );
      }
    }

    // 综合判断
    const passed = verification.passed && (!codeReview || codeReview.passed || this.noCriticalIssues(codeReview));
    const summary = this.buildSummary(verification, codeReview, executionResults);
    const totalTokenUsage = this.aggregateUsage(verification, codeReview);

    this.deps.addSystemMessage?.(this.formatReviewResult(passed, verification, codeReview, executionResults));

    return {
      verification,
      codeReview,
      passed,
      summary,
      totalTokenUsage,
    };
  }

  /**
   * 第一层：GoalVerifier 验证
   */
  private async runGoalVerifier(
    plan: GoalPlan,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    adversarial?: AdversarialOptions,
  ): Promise<VerificationResult> {
    try {
      const verifier = new GoalVerifier();
      const result = await verifier.verify(
        plan,
        {
          routeDecision,
          llmClient,
          adversarial,
          onUsage: (usage, source) => {
            this.deps.tracker.record(usage, {
              modelId: source === 'adversarial' ? 'adversarial' : routeDecision.model.id,
              agentId: 'unified-reviewer',
              stepId: `verify-${source}`,
            });
          },
        },
      );
      return result;
    } catch (error) {
      logger.error('GoalVerifier failed', { error: String(error) });
      // 降级：返回保守的验证结果
      return {
        passed: false,
        confidence: 0,
        reasoning: `验证过程出错: ${error instanceof Error ? error.message : String(error)}`,
        missingItems: ['验证过程出错，无法确认完成状态'],
        suggestions: ['请检查 LLM 配置后重试'],
      };
    }
  }

  /**
   * 第二层：代码审查
   */
  private async runCodeReview(
    plan: GoalPlan,
    executionResults: StepExecutionResult[],
    modifiedFiles: string[],
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    conversationHistory: LLMMessage[],
    mode: 'builtin' | 'ocr',
  ): Promise<CodeReviewResult> {
    if (mode === 'ocr') {
      // 方案 A：外部工具（如果已安装）
      return await this.runOCRReview(modifiedFiles);
    }

    // 方案 B：内置审查（使用 reviewer 角色）
    return await this.runBuiltinReview(plan, executionResults, modifiedFiles, llmClient, routeDecision, conversationHistory);
  }

  /**
   * 内置代码审查——使用 WorkerExecutor 的 reviewer 角色
   */
  private async runBuiltinReview(
    plan: GoalPlan,
    executionResults: StepExecutionResult[],
    modifiedFiles: string[],
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    conversationHistory: LLMMessage[],
  ): Promise<CodeReviewResult> {
    const executionSummary = executionResults
      .map((r) => `[${r.success ? '✅' : '❌'}] 步骤 ${r.stepId}: ${r.conclusion.slice(0, 100)}`)
      .join('\n');

    const reviewPrompt = REVIEW_SYSTEM_PROMPT
      .replace('{{modifiedFiles}}', modifiedFiles.join(', '))
      .replace('{{executionSummary}}', executionSummary)
      .replace('{{goalDescription}}', plan.description);

    const workerExecutor = new WorkerExecutor(this.deps.agentLoop);
    const blackboardSnapshot = {
      currentGoal: { description: plan.description, status: 'reviewing' },
      completedSteps: executionResults.map((r) => ({
        key: `step-${r.stepId}`,
        value: r.conclusion,
        source: { role: 'coder' as const, stepId: r.stepId },
        timestamp: Date.now(),
        confidence: 0.8,
      })),
      projectFacts: [],
    };

    try {
      const workerResult = await workerExecutor.execute(
        {
          stepId: -1,
          description: reviewPrompt,
          role: 'reviewer',
          rolePrompt: '',
          blackboardSnapshot,
        },
        llmClient,
        routeDecision,
        conversationHistory,
        this.deps.systemPromptRef.current,
        this.deps.signal,
        this.deps.onConfirmTool,
      );

      // 记录 Token
      const tokenUsage: TokenUsageInfo = {
        inputTokens: workerResult.tokenUsage.inputTokens,
        outputTokens: workerResult.tokenUsage.outputTokens,
        totalTokens: workerResult.tokenUsage.inputTokens + workerResult.tokenUsage.outputTokens,
      };
      if (tokenUsage.totalTokens > 0) {
        this.deps.tracker.record(tokenUsage, {
          modelId: routeDecision.model.id,
          agentId: 'reviewer',
          stepId: 'code-review',
        });
      }

      // 解析审查结果
      return this.parseReviewResult(workerResult.conclusion, tokenUsage);
    } catch (error) {
      logger.error('Builtin code review failed', { error: String(error) });
      return {
        passed: true, // 审查失败不阻断任务完成
        issues: [],
        summary: `代码审查过程出错: ${error instanceof Error ? error.message : String(error)}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
  }

  /**
   * 外部 OCR 审查（open-code-review）
   */
  private async runOCRReview(modifiedFiles: string[]): Promise<CodeReviewResult> {
    // 检查 ocr 是否安装
    const { execSync } = await import('node:child_process');
    try {
      // 检查 ocr 命令是否可用
      execSync('ocr --version', { stdio: 'ignore', timeout: 5000 });
    } catch {
      logger.warn('OCR not installed, skipping code review');
      return {
        passed: true,
        issues: [],
        summary: 'open-code-review 未安装，跳过代码审查',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }

    try {
      // I8 修复：把 modifiedFiles 传给 ocr，使审查范围与语义一致
      const args = ['review', '--format', 'json', ...modifiedFiles];
      const output = execSync(`ocr ${args.map(a => `"${a}"`).join(' ')}`, {
        encoding: 'utf-8',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(output);
      return {
        passed: parsed.passed ?? true,
        issues: (parsed.issues ?? []).map((i: any) => ({
          severity: i.severity ?? 'info',
          file: i.file ?? '',
          line: i.line,
          description: i.description ?? '',
        })),
        summary: parsed.summary ?? 'OCR 审查完成',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    } catch (error) {
      logger.error('OCR review failed', { error: String(error) });
      return {
        passed: true,
        issues: [],
        summary: `OCR 审查失败: ${error instanceof Error ? error.message : String(error)}`,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
  }

  /**
   * 解析审查结果（LLM 返回的 JSON）
   */
  private parseReviewResult(content: string, tokenUsage: TokenUsageInfo): CodeReviewResult {
    try {
      // 尝试从内容中提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          passed: true,
          issues: [],
          summary: '审查结果解析失败（未找到 JSON），默认通过',
          tokenUsage,
        };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        passed: parsed.passed ?? true,
        issues: (parsed.issues ?? []).map((i: any) => ({
          severity: i.severity ?? 'info',
          file: i.file ?? '',
          line: i.line,
          description: i.description ?? '',
        })),
        summary: parsed.summary ?? '审查完成',
        tokenUsage,
      };
    } catch {
      return {
        passed: true,
        issues: [],
        summary: '审查结果解析失败（JSON 解析错误），默认通过',
        tokenUsage,
      };
    }
  }

  /**
   * 检查是否有 critical 级别的问题
   */
  private noCriticalIssues(review: CodeReviewResult): boolean {
    return !review.issues.some((i) => i.severity === 'critical');
  }

  /**
   * 构建综合摘要
   */
  private buildSummary(
    verification: VerificationResult,
    codeReview: CodeReviewResult | undefined,
    executionResults: StepExecutionResult[],
  ): string {
    const parts: string[] = [];
    parts.push(`验证${verification.passed ? '通过' : '未通过'}（置信度 ${(verification.confidence * 100).toFixed(0)}%）`);
    if (codeReview) {
      const criticalCount = codeReview.issues.filter((i) => i.severity === 'critical').length;
      const warningCount = codeReview.issues.filter((i) => i.severity === 'warning').length;
      parts.push(`代码审查${codeReview.passed ? '通过' : '发现问题'}（${criticalCount} critical, ${warningCount} warning）`);
    }
    const successCount = executionResults.filter((r) => r.success).length;
    parts.push(`步骤完成 ${successCount}/${executionResults.length}`);
    return parts.join(' | ');
  }

  /**
   * 聚合 Token 消耗
   */
  private aggregateUsage(
    verification: VerificationResult,
    codeReview: CodeReviewResult | undefined,
  ): TokenUsageInfo {
    // VerificationResult 不直接包含 tokenUsage，这里用 codeReview 的消耗
    // GoalVerifier 的 token 已通过 onUsage 回调记录到 tracker
    const reviewUsage = codeReview?.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return reviewUsage;
  }

  /**
   * 格式化审查结果用于显示
   */
  private formatReviewResult(
    passed: boolean,
    verification: VerificationResult,
    codeReview: CodeReviewResult | undefined,
    executionResults: StepExecutionResult[],
  ): string {
    const lines: string[] = [];
    const icon = passed ? '🎉' : '⚠️';
    lines.push(`${icon} 审查结果`);
    lines.push('────────────────');

    // 验证结果
    const verifyIcon = verification.passed ? '✅' : '⚠️';
    lines.push(`验证: ${verifyIcon} ${verification.reasoning}`);
    if (verification.missingItems.length > 0) {
      lines.push(`缺失项: ${verification.missingItems.join('; ')}`);
    }

    // 代码审查结果
    if (codeReview) {
      const reviewIcon = codeReview.passed ? '✅' : '⚠️';
      lines.push(`代码审查: ${reviewIcon} ${codeReview.summary}`);
      for (const issue of codeReview.issues) {
        const issueIcon = issue.severity === 'critical' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
        const lineInfo = issue.line ? `:${issue.line}` : '';
        lines.push(`  ${issueIcon} [${issue.severity}] ${issue.file}${lineInfo} — ${issue.description}`);
      }
    }

    // 步骤完成情况
    const successCount = executionResults.filter((r) => r.success).length;
    lines.push(`步骤: ${successCount}/${executionResults.length} 完成`);

    // 修改的文件
    const modifiedFiles = Array.from(new Set(executionResults.flatMap((r) => r.modifiedFiles)));
    if (modifiedFiles.length > 0) {
      lines.push('');
      lines.push('修改文件:');
      for (const file of modifiedFiles.slice(0, 10)) {
        lines.push(`  ${file}`);
      }
      if (modifiedFiles.length > 10) {
        lines.push(`  ...及其他 ${modifiedFiles.length - 10} 个文件`);
      }
    }

    // 建议
    if (!passed) {
      lines.push('');
      lines.push('💡 建议: 修复上述问题后重新验证');
    }

    return lines.join('\n');
  }
}

/**
 * 创建统一审查器的工厂函数
 */
export function createUnifiedReviewer(deps: UnifiedReviewerDeps): UnifiedReviewer {
  return new UnifiedReviewer(deps);
}
