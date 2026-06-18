// src/agent/multi/worker-executor.ts
// WorkerExecutor：执行单个步骤，注入角色 system prompt + Blackboard 上下文

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
import { WORKER_ROLE_PROMPTS } from './orchestrator.js';
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

    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const modifiedFiles: string[] = [];

    try {
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
              if (fileMatch && !modifiedFiles.includes(fileMatch[0])) {
                modifiedFiles.push(fileMatch[0]);
              }
            }
            break;
          case 'done':
            if (event.content) responseText = event.content;
            if (event.usage) {
              inputTokens = event.usage.inputTokens;
              outputTokens = event.usage.outputTokens;
            }
            break;
        }
      }

      const conclusion = responseText.length > 200
        ? responseText.slice(0, 200) + '...'
        : responseText;

      return {
        stepId: task.stepId,
        role: task.role,
        success: true,
        conclusion,
        modifiedFiles,
        tokenUsage: { inputTokens, outputTokens },
      };
    } catch (error) {
      logger.error('Worker execution failed', {
        stepId: task.stepId,
        error: String(error),
      });
      return {
        stepId: task.stepId,
        role: task.role,
        success: false,
        conclusion: `执行失败: ${error instanceof Error ? error.message : String(error)}`,
        modifiedFiles: [],
        tokenUsage: { inputTokens, outputTokens },
      };
    }
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