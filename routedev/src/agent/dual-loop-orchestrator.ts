// src/agent/dual-loop-orchestrator.ts
// Phase 49 Task 2.2：双循环编排器——把内循环 ReAct 和外循环验证统一编排
//
// 知识库要求：
//   - 内循环：ReAct 完成任务（执行 Agent）
//   - 外循环：独立验证审核结果（验证 Agent）
//   - 验证不通过 → 打回重跑（形成闭环）
//   - 执行与验证分离（不同模型，打破自评盲区）
//
// Loop 五模块对应：
//   - 目标来源：goal.plan + goal.gates
//   - 执行 Agent：内循环 ReActAgentLoop
//   - 验证 Agent：外循环 GoalVerifier + CompletionGate + 跨模型审查
//   - 记忆：LoopMemory（失败原因沉淀）
//   - 终止条件：外循环验证通过 OR 达到最大重跑次数
//
// 2.5 节"让 AI 自己改"约束：
//   1. 重跑时把 LoopMemory.buildPrompt() 注入 system prompt
//   2. 重跑时不允许外部 patch/hotfix（由调用方约束）
//   3. 检测到人工修改（git diff 非内循环产出）→ 标记"人工介入"并停止自动重跑
//   4. 连续 maxReruns 次同一原因失败 → 提示用户接管（Pilot 模式）

import { logger } from '../utils/logger.js';
import type { ReActEvent } from './loop-config.js';
import { LoopMemory } from './loop-memory.js';
import type {
  DualLoopParams,
  DualLoopEvent,
  InnerLoopResult,
  LoopFailure,
  OuterLoopEvaluation,
} from './dual-loop-types.js';
import type { VerificationResult } from './goal-types.js';
import type { GateResult } from './completion-gate.js';
import type { CodeReviewResult } from './unified-reviewer.js';
import type { TokenUsageInfo } from '../router/types.js';

/** 陷阱 #141：maxReruns 默认 2 而非 3，避免 Token 爆炸 */
export const DEFAULT_MAX_RERUNS = 2;

/**
 * 双循环编排器
 *
 * 流程：
 *   1. 内循环：ReActAgentLoop.run() 执行任务
 *   2. 外循环：GoalVerifier.verify() + CompletionGate.verify() + 跨模型审查
 *   3. 外循环通过 → 完成
 *   4. 外循环不通过 → 把失败原因注入 LoopMemory → 打回内循环重跑
 *   5. 达到最大重跑次数 → 终止并报告
 *
 * 2.5 节约束：重跑时由 AI 基于记忆自修正，不依赖人工 patch
 */
export class DualLoopOrchestrator {
  /**
   * 运行双循环
   *
   * @param params 运行参数（含依赖注入的各组件）
   * @returns AsyncGenerator<DualLoopEvent> 流式输出事件
   */
  async *run(params: DualLoopParams): AsyncGenerator<DualLoopEvent> {
    const { goal, reactLoop, reactParams } = params;
    const maxReruns = params.maxReruns ?? DEFAULT_MAX_RERUNS;

    // 初始化 LoopMemory
    const loopMemory = new LoopMemory(goal.projectPath);
    if (goal.plan.id) {
      await loopMemory.load(goal.plan.id);
      loopMemory.setGoalId(goal.plan.id);
    }

    let rerunCount = 0;
    let totalUsage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let lastFailureReason = '';

    while (rerunCount <= maxReruns) {
      const iteration = rerunCount + 1;

      // 2.5 节约束 3：重跑前检测人工介入（仅在非首次迭代时检测）
      if (rerunCount > 0 && params.humanInterventionDetector) {
        const intervened = await params.humanInterventionDetector();
        if (intervened) {
          logger.warn('DualLoopOrchestrator: 人工介入检测到，停止自动重跑', { iteration });
          yield {
            type: 'human-intervention-detected',
            iteration,
            message: '检测到非内循环产出的人工修改，已停止自动重跑。请用户确认是否由 AI 接管继续。',
          };
          return;
        }
      }

      // 2.5 节约束 1：把 LoopMemory 中的历史失败原因注入 system prompt
      const memoryPrompt = loopMemory.buildPrompt();
      const innerParams = {
        ...reactParams,
        systemPrompt: (reactParams.systemPrompt ?? '') + memoryPrompt,
      };

      // ===== 内循环：执行任务 =====
      yield { type: 'inner-loop-start', iteration };

      let innerResult: InnerLoopResult = {
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        modifiedFiles: [],
      };
      const modifiedFilesSet = new Set<string>();

      for await (const event of reactLoop.run(innerParams)) {
        yield { type: 'inner-loop-event', event, iteration };

        // 累计 token 使用量
        if (event.type === 'done') {
          innerResult = {
            content: event.content,
            usage: event.usage,
            modifiedFiles: Array.from(modifiedFilesSet),
          };
          totalUsage = this.mergeUsage(totalUsage, event.usage);
        }

        // 从工具调用中收集修改的文件（file-edit/file-write）
        if (event.type === 'tool_call_start' && event.args) {
          const path = this.extractFilePath(event.toolName, event.args);
          if (path) modifiedFilesSet.add(path);
        }
      }

      yield { type: 'inner-loop-complete', iteration, result: innerResult };

      // ===== 外循环：独立验证 =====
      yield { type: 'outer-loop-start', iteration };

      // 2.1 GoalVerifier：LLM 验证目标是否完成
      const verification: VerificationResult = await this.runGoalVerifier(params, goal);

      // 2.2 CompletionGate：工程化验证（typecheck/lint/tests）
      const gateResult: GateResult = await this.runCompletionGate(
        params,
        goal,
        innerResult.modifiedFiles,
      );

      // 2.3 跨模型审查（可选；打破自评盲区）
      let crossModelReview: CodeReviewResult | undefined;
      if (params.crossModelReviewer) {
        crossModelReview = await this.runCrossModelReview(params, innerResult, goal);
      }

      // ===== 判定 =====
      const evaluation = this.evaluateOuterLoop(verification, gateResult, crossModelReview);

      if (evaluation.passed) {
        logger.info('DualLoopOrchestrator: outer loop passed', { iteration });
        yield {
          type: 'dual-loop-complete',
          iteration,
          verification,
          gateResult,
          crossModelReview,
          totalUsage,
        };
        return;
      }

      // ===== 不通过：沉淀失败原因到 LoopMemory，打回重跑 =====
      const failure: LoopFailure = {
        iteration,
        reason: evaluation.reason,
        missingItems: verification.missingItems,
        gateFailures: gateResult.checks.filter(c => !c.ok && !c.skipped),
        reviewIssues: crossModelReview?.issues ?? [],
      };
      loopMemory.recordFailure(failure);

      yield {
        type: 'outer-loop-failed',
        iteration,
        reason: evaluation.reason,
        suggestion: loopMemory.buildResuggestion(),
        verification,
        gateResult,
        crossModelReview,
      };

      // 2.5 节约束 4：连续 maxReruns 次同一原因失败 → Pilot 模式
      if (lastFailureReason === evaluation.reason && rerunCount === maxReruns - 1) {
        logger.warn('DualLoopOrchestrator: 同一原因重复失败，触发 Pilot 模式', {
          iteration,
          repeatedReason: evaluation.reason,
        });
        yield {
          type: 'pilot-mode-triggered',
          iteration,
          repeatedReason: evaluation.reason,
        };
        return;
      }
      lastFailureReason = evaluation.reason;

      rerunCount++;
    }

    // 达到最大重跑次数
    logger.warn('DualLoopOrchestrator: max reruns exhausted', { maxReruns });
    yield {
      type: 'dual-loop-exhausted',
      maxReruns,
      finalMemory: loopMemory.getHistory(),
    };
  }

  /**
   * 评估外循环结果
   *
   * 知识库要求：仲裁规则
   *   - 默认以 CompletionGate 为准
   *   - 高严重度 reviewer 质疑（critical）可推翻 CompletionGate 的 pass
   *
   * 判定顺序：
   *   1. CompletionGate 失败 → 不通过
   *   2. GoalVerifier 失败 → 不通过
   *   3. 跨模型审查发现 critical 问题 → 推翻 pass，不通过
   *   4. 否则通过
   */
  evaluateOuterLoop(
    verification: VerificationResult,
    gateResult: GateResult,
    crossModelReview?: CodeReviewResult,
  ): OuterLoopEvaluation {
    // 1. CompletionGate 优先
    if (!gateResult.passed) {
      const failedChecks = gateResult.checks.filter(c => !c.ok && !c.skipped);
      return {
        passed: false,
        reason: `工程验证未通过：${failedChecks.map(c => c.name).join(', ') || '存在未通过的检查项'}`,
      };
    }

    // 2. GoalVerifier 判定
    if (!verification.passed) {
      const missing = verification.missingItems.length > 0
        ? verification.missingItems.join(', ')
        : verification.reasoning || '未说明';
      return {
        passed: false,
        reason: `目标未完成：${missing}`,
      };
    }

    // 3. 跨模型审查：critical 级别问题可推翻 pass
    if (crossModelReview) {
      const criticalIssues = crossModelReview.issues.filter(i => i.severity === 'critical');
      if (criticalIssues.length > 0) {
        return {
          passed: false,
          reason: `跨模型审查发现 ${criticalIssues.length} 个 critical 问题`,
        };
      }
    }

    return { passed: true, reason: '全部验证通过' };
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /** 执行 GoalVerifier（隔离异常，失败返回保守的"未通过"结果） */
  private async runGoalVerifier(
    params: DualLoopParams,
    goal: DualLoopParams['goal'],
  ): Promise<VerificationResult> {
    try {
      return await params.goalVerifier.verify(
        goal.plan,
        params.verifierOptions,
        goal.gates,
      );
    } catch (error) {
      logger.error('DualLoopOrchestrator: GoalVerifier failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        passed: false,
        confidence: 0,
        reasoning: `GoalVerifier 执行出错: ${error instanceof Error ? error.message : String(error)}`,
        missingItems: ['GoalVerifier 执行异常'],
        suggestions: ['检查 GoalVerifier 配置'],
      };
    }
  }

  /** 执行 CompletionGate（隔离异常，失败返回"未通过"结果） */
  private async runCompletionGate(
    params: DualLoopParams,
    goal: DualLoopParams['goal'],
    modifiedFiles: string[],
  ): Promise<GateResult> {
    try {
      return await params.completionGate.verify({
        modifiedFiles,
        projectPath: goal.projectPath,
        planDescription: goal.description,
      });
    } catch (error) {
      logger.error('DualLoopOrchestrator: CompletionGate failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        passed: false,
        checks: [{
          name: 'completion-gate',
          ok: false,
          output: `CompletionGate 执行异常: ${error instanceof Error ? error.message : String(error)}`,
          duration: 0,
        }],
      };
    }
  }

  /** 执行跨模型审查（陷阱 #142：失败时由 CrossModelReviewer 内部回退，不抛错） */
  private async runCrossModelReview(
    params: DualLoopParams,
    innerResult: InnerLoopResult,
    goal: DualLoopParams['goal'],
  ): Promise<CodeReviewResult | undefined> {
    if (!params.crossModelReviewer) return undefined;
    try {
      return await params.crossModelReviewer.review({
        modifiedFiles: innerResult.modifiedFiles,
        executionSummary: innerResult.content,
        goalDescription: goal.description,
      });
    } catch (error) {
      logger.error('DualLoopOrchestrator: CrossModelReviewer failed (unexpected)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** 合并 Token 使用量 */
  private mergeUsage(a: TokenUsageInfo, b: TokenUsageInfo): TokenUsageInfo {
    return {
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  /**
   * 从工具调用参数中提取文件路径
   * 用于在内循环执行过程中收集 modifiedFiles
   */
  private extractFilePath(toolName: string, args: Record<string, unknown>): string | null {
    // 常见的文件编辑类工具
    const fileEditTools = ['file-edit', 'file_write', 'file-write', 'write_file', 'edit_file', 'file-edit-tool'];
    if (!fileEditTools.some(t => t === toolName || toolName.startsWith(t))) {
      return null;
    }
    // 尝试常见的参数名
    const candidates = ['file_path', 'filePath', 'path', 'file'];
    for (const key of candidates) {
      const v = args[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }
}


