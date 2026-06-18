// src/agent/multi/worker-executor.ts
// WorkerExecutor：执行单个步骤，注入角色 system prompt + Blackboard 上下文
//
// Phase 21 Task 3：用 executeWorkerIsolated 包装核心执行逻辑
//   - Worker 崩溃不上溯，异常转结构化 WorkerOutcome
//   - 可重试错误（timeout/llm_error/tool_failure）自动重试
//   - 不可重试错误（permission_denied/unknown）立即返回失败

import type {
  ILLMClient,
  LLMMessage,
  RoutingResult,
} from '../../router/types.js';
import type { ReActAgentLoop } from '../loop.js';
import type {
  ConfirmToolCallback,
} from '../loop-config.js';
import type { WorkerTask, WorkerResult } from './types.js';
import { WORKER_ROLE_PROMPTS, executeWorkerIsolated, type WorkerFunction } from './orchestrator.js';
import { logger } from '../../utils/logger.js';

export interface WorkerExecutorOptions {
  agentLoop: ReActAgentLoop;
}

export class WorkerExecutor {
  private agentLoop: ReActAgentLoop;

  constructor(agentLoop: ReActAgentLoop) {
    this.agentLoop = agentLoop;
  }

  /**
   * 执行一个 Worker 任务
   *
   * Phase 21 Task 3：内部用 executeWorkerIsolated 包装实际执行逻辑，
   * 实现异常隔离 + 自动重试。公共签名保持不变（向后兼容）。
   */
  async execute(
    task: WorkerTask,
    llmClient: ILLMClient,
    routeDecision: RoutingResult,
    conversationHistory: LLMMessage[],
    baseSystemPrompt: string,
    signal?: AbortSignal,
    onConfirmTool?: ConfirmToolCallback,
  ): Promise<WorkerResult> {
    const rolePrompt = task.rolePrompt || WORKER_ROLE_PROMPTS[task.role];
    const blackboardContext = this.formatBlackboard(task.blackboardSnapshot);

    const enhancedPrompt = [
      baseSystemPrompt,
      '',
      `## 你的角色: ${task.role}`,
      rolePrompt,
      '',
      '## 当前协作上下文',
      blackboardContext,
    ].join('\n');

    // 闭包变量：捕获每次执行尝试的中间状态（重试时会重置）
    let capturedModifiedFiles: string[] = [];
    let capturedInputTokens = 0;
    let capturedOutputTokens = 0;

    // 核心执行函数：返回 conclusion 字符串，失败时抛出（由 executeWorkerIsolated 捕获）
    const workerFn: WorkerFunction = async (_workerId, _t) => {
      let responseText = '';
      // 每次尝试前重置闭包变量
      capturedModifiedFiles = [];
      capturedInputTokens = 0;
      capturedOutputTokens = 0;

      for await (const event of this.agentLoop.run({
        userMessage: task.description,
        llmClient,
        routeDecision,
        conversationHistory,
        systemPrompt: enhancedPrompt,
        signal,
        onConfirmTool,
      })) {
        switch (event.type) {
          case 'text_delta':
            responseText += event.text;
            break;
          case 'tool_call_result':
            if (event.toolName.includes('file_') || event.toolName.includes('git_')) {
              const fileMatch = event.result.match(/[\w/.\-]+\.\w{1,5}/);
              if (fileMatch && !capturedModifiedFiles.includes(fileMatch[0])) {
                capturedModifiedFiles.push(fileMatch[0]);
              }
            }
            break;
          case 'done':
            if (event.content) responseText = event.content;
            if (event.usage) {
              capturedInputTokens = event.usage.inputTokens;
              capturedOutputTokens = event.usage.outputTokens;
            }
            break;
        }
      }

      return responseText.length > 200
        ? responseText.slice(0, 200) + '...'
        : responseText;
    };

    // 用 executeWorkerIsolated 包装：异常隔离 + 自动重试
    const workerId = `worker-${task.stepId}-${task.role}`;
    const outcome = await executeWorkerIsolated(workerId, task, workerFn);

    if (outcome.success) {
      return {
        stepId: task.stepId,
        role: task.role,
        success: true,
        conclusion: outcome.result,
        modifiedFiles: capturedModifiedFiles,
        tokenUsage: { inputTokens: capturedInputTokens, outputTokens: capturedOutputTokens },
      };
    }

    // 失败：异常已被隔离为结构化 WorkerError
    logger.error('Worker execution failed (isolated)', {
      stepId: task.stepId,
      workerId,
      errorType: outcome.error.type,
      error: outcome.error.message,
      retryCount: outcome.error.retryCount,
    });
    return {
      stepId: task.stepId,
      role: task.role,
      success: false,
      conclusion: `执行失败: ${outcome.error.message}`,
      modifiedFiles: [],
      tokenUsage: { inputTokens: capturedInputTokens, outputTokens: capturedOutputTokens },
    };
  }

  private formatBlackboard(snapshot: WorkerTask['blackboardSnapshot']): string {
    const parts: string[] = [];

    if (snapshot.currentGoal) {
      parts.push(`目标: ${snapshot.currentGoal.description}`);
    }

    if (snapshot.completedSteps.length > 0) {
      parts.push('已完成:');
      for (const step of snapshot.completedSteps) {
        parts.push(`  - [${step.source.role}] ${step.value}`);
      }
    }

    if (snapshot.projectFacts.length > 0) {
      parts.push('已知信息:');
      for (const fact of snapshot.projectFacts) {
        parts.push(`  - ${fact.key}: ${fact.value}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : '（无上下文）';
  }
}