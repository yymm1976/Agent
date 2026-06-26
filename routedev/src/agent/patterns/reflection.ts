// src/agent/patterns/reflection.ts
// Phase 49 Task 6.3：反思模式（Reflection Pattern）
//
// 知识库原文：
//   "Agent 自我校验输出质量，发现问题后自动修正。
//    生成 → 自我审查 → 发现问题？→ 修正 → 重新审查 → 通过 → 输出。"
//
// 与双循环（DualLoopOrchestrator）的关系：
//   - 双循环是反思模式的工程化实现（外循环=审查，内循环=修正）
//   - 双循环用"跨模型"做审查（不同模型打破自评盲区）
//   - 本 ReflectionPattern 用"依赖注入的 review/revise 回调"
//     ——调用方可注入跨模型审查，也可注入同模型自评（不推荐）
//   - 双循环更重（含 LoopMemory/CompletionGate/GoalVerifier），适合 /goal 这种大任务
//   - ReflectionPattern 更轻，适合单步输出的快速自检+修正
//   - 两者不互斥：双循环的某一轮重跑内部可以用 ReflectionPattern 做细粒度修正

import { logger } from '../../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 反思模式参数 */
export interface ReflectionParams {
  /** 初始输出（待审查的内容） */
  initialOutput: string;
  /** 审查标准（如"必须覆盖所有边界情况""不能有 SQL 注入风险"） */
  criteria: string;
  /** 最大反思迭代次数（防止无限循环） */
  maxReflections: number;
}

/** 审查结果 */
export interface ReviewResult {
  /** 是否通过审查 */
  passed: boolean;
  /** 发现的问题列表（passed=false 时存在） */
  issues: string[];
  /** 审查理由（便于审计） */
  reasoning: string;
}

/** 反思事件（AsyncGenerator 流式输出） */
export type ReflectionEvent =
  | {
      type: 'reflection-passed';
      /** 通过审查的最终输出 */
      output: string;
      /** 经过的反思迭代次数（0 表示初始输出即通过） */
      iteration: number;
    }
  | {
      type: 'reflection-iteration';
      /** 本次修正后的输出 */
      output: string;
      /** 本次审查发现的问题 */
      issues: string[];
      /** 当前迭代序号（从 1 开始） */
      iteration: number;
    }
  | {
      type: 'reflection-exhausted';
      /** 达到 maxReflections 时的最终输出（不一定通过审查） */
      output: string;
      /** 配置的最大迭代次数 */
      maxIterations: number;
    };

/** 审查回调（依赖注入）——传入输出和审查标准，返回审查结果 */
export type ReviewCallback = (output: string, criteria: string) => Promise<ReviewResult>;

/** 修正回调（依赖注入）——传入输出和问题列表，返回修正后的输出 */
export type ReviseCallback = (output: string, issues: string[]) => Promise<string>;

// ============================================================
// ReflectionPattern
// ============================================================

/**
 * 反思模式——Agent 自我校验输出质量，发现后自动修正
 *
 * 流程：
 *   1. 审查 initialOutput
 *   2. 通过 → yield 'reflection-passed'，结束
 *   3. 不通过 → 调用 revise 修正 → yield 'reflection-iteration'
 *   4. 重新审查（回到步骤 2）
 *   5. 达到 maxReflections 仍不通过 → yield 'reflection-exhausted'，结束
 *
 * 设计要点：
 *   - review 和 revise 都通过依赖注入，便于测试 mock
 *   - iteration 从 0 开始计：0=初始即通过，1=第一次修正后通过，…
 *   - maxReflections=0 时只审查一次，不修正（直接 exhausted 或 passed）
 *   - 调用方可通过注入"跨模型 review"实现 DualLoopOrchestrator 的自评盲区规避
 */
export class ReflectionPattern {
  /** 审查回调（依赖注入） */
  private readonly review: ReviewCallback;
  /** 修正回调（依赖注入） */
  private readonly revise: ReviseCallback;

  constructor(review: ReviewCallback, revise: ReviseCallback) {
    this.review = review;
    this.revise = revise;
  }

  /**
   * 运行反思模式
   *
   * @param params 反思参数
   * @returns AsyncGenerator<ReflectionEvent> 流式输出事件
   */
  async *run(params: ReflectionParams): AsyncGenerator<ReflectionEvent> {
    let output = params.initialOutput;
    let iteration = 0;

    logger.debug('ReflectionPattern: 开始反思', {
      maxReflections: params.maxReflections,
      initialOutputLength: params.initialOutput.length,
    });

    while (iteration <= params.maxReflections) {
      // 审查当前输出
      const reviewResult = await this.review(output, params.criteria);

      if (reviewResult.passed) {
        // 审查通过 → 输出最终结果
        logger.info('ReflectionPattern: 审查通过', { iteration });
        yield {
          type: 'reflection-passed',
          output,
          iteration,
        };
        return;
      }

      // 审查不通过：检查是否还有修正机会
      if (iteration >= params.maxReflections) {
        // 达到最大迭代次数，无法再修正
        logger.warn('ReflectionPattern: 达到最大反思次数，终止', {
          maxReflections: params.maxReflections,
          remainingIssues: reviewResult.issues.length,
        });
        yield {
          type: 'reflection-exhausted',
          output,
          maxIterations: params.maxReflections,
        };
        return;
      }

      // 修正
      logger.debug('ReflectionPattern: 审查不通过，执行修正', {
        iteration: iteration + 1,
        issues: reviewResult.issues,
      });
      output = await this.revise(output, reviewResult.issues);
      iteration++;

      yield {
        type: 'reflection-iteration',
        output,
        issues: reviewResult.issues,
        iteration,
      };
      // 循环回到审查步骤
    }

    // 理论上不会走到这里（while 条件已覆盖），但为了类型完整保留
    yield {
      type: 'reflection-exhausted',
      output,
      maxIterations: params.maxReflections,
    };
  }
}
