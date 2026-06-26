// src/agent/patterns/prompt-chain.ts
// Phase 49 Task 6.3：提示链模式（Prompt Chain）
//
// 知识库原文：
//   "将复杂任务拆解为串行子问题，每一步输出作为下一步输入。
//    优势：每一步可调试、可干预、可中断恢复。"
//
// 与 SkillFlow 的关系：
//   - SkillFlow 是 Skill 内部编排（节点间串行执行 + checkpoint + user-gate）
//   - PromptChain 是跨 Skill 的串行编排（更轻量，不做节点级检查）
//   - SkillFlow 用于"单个 Skill 内部固化流水线"（Task 1）
//   - PromptChain 用于"多个独立步骤的临时串接"（如分析→总结→翻译）
//   - 两者不互斥：PromptChain 的某个 step 内部可以触发一个带 SkillFlow 的 Skill

import { logger } from '../../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 提示链步骤定义 */
export interface ChainStep {
  /** 步骤 ID（唯一，用于审计/日志） */
  id: string;
  /** 该步骤的输入提示词（不含上下文，由 executeStep 自行拼接） */
  input: string;
  /**
   * 是否把前一步的输出追加到本步输入
   * - true：本步输入 = step.input + 前一步输出
   * - false：本步输入 = step.input（独立步骤，不依赖前一步）
   */
  appendContext: boolean;
}

/** 单步执行结果 */
export interface ChainStepResult {
  /** 步骤 ID */
  stepId: string;
  /** 该步骤的输出（用作下一步的 context） */
  output: string;
  /** 该步骤实际收到的输入（含上下文，便于审计） */
  actualInput: string;
  /** 执行耗时毫秒 */
  durationMs: number;
}

/** 提示链事件（AsyncGenerator 流式输出） */
export type ChainEvent =
  | {
      type: 'chain-step-complete';
      stepId: string;
      result: ChainStepResult;
      /** 当前已完成的步骤序号（从 1 开始） */
      index: number;
      /** 总步骤数 */
      total: number;
    }
  | {
      type: 'chain-complete';
      /** 整条链的最终输出（最后一步的输出） */
      finalOutput: string;
      /** 所有步骤的结果（按执行顺序） */
      results: ChainStepResult[];
      /** 总耗时毫秒 */
      totalDurationMs: number;
    };

/** 单步执行回调（依赖注入，便于测试 mock） */
export type ExecuteStepCallback = (
  step: ChainStep,
  actualInput: string,
) => Promise<string>;

// ============================================================
// PromptChain
// ============================================================

/**
 * 提示链模式——复杂问题拆为串行子问题
 *
 * 流程：
 *   1. 每步输入 = step.input + （若 appendContext）前一步输出
 *   2. 调用 executeStep 回调执行该步（实际由依赖注入的 LLM/Agent 完成）
 *   3. yield 'chain-step-complete' 事件
 *   4. 全部完成后 yield 'chain-complete' 事件
 *
 * 设计要点：
 *   - 不直接调用 LLM——通过 executeStep 回调解耦，便于测试和替换执行器
 *   - 每步的 actualInput 记录在 ChainStepResult 中，便于审计和调试
 *   - 空步骤列表直接完成（finalOutput=''）
 *   - 步骤执行失败时抛出异常，由调用方决定是否重试或终止
 */
export class PromptChain {
  /** 单步执行回调（依赖注入） */
  private readonly executeStep: ExecuteStepCallback;

  constructor(executeStep: ExecuteStepCallback) {
    this.executeStep = executeStep;
  }

  /**
   * 执行提示链
   *
   * @param steps 有序步骤列表
   * @returns AsyncGenerator<ChainEvent> 流式输出事件
   */
  async *execute(steps: ChainStep[]): AsyncGenerator<ChainEvent> {
    const results: ChainStepResult[] = [];
    const chainStart = Date.now();
    let context = '';

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // 拼接本步输入：appendContext=true 时把前一步输出追加到 step.input
      const actualInput = step.appendContext && context
        ? `${step.input}\n\n前一步结果：${context}`
        : step.input;

      logger.debug('PromptChain: 执行步骤', {
        stepId: step.id,
        index: i + 1,
        total: steps.length,
        appendContext: step.appendContext,
      });

      const stepStart = Date.now();
      const output = await this.executeStep(step, actualInput);
      const durationMs = Date.now() - stepStart;

      // 更新 context 为本步输出，供下一步使用
      context = output;

      const result: ChainStepResult = {
        stepId: step.id,
        output,
        actualInput,
        durationMs,
      };
      results.push(result);

      yield {
        type: 'chain-step-complete',
        stepId: step.id,
        result,
        index: i + 1,
        total: steps.length,
      };
    }

    yield {
      type: 'chain-complete',
      finalOutput: context,
      results,
      totalDurationMs: Date.now() - chainStart,
    };
  }
}
