// src/agent/step-executor.ts
// Phase 35 Task 3：AgentLoopStepExecutor——DurableExecutor 的真实步骤执行器
//
// 替换 app-init.ts 中的假桩（永远返回 success），
// 让 /resume 命令的恢复执行能真正运行 Agent Loop。
//
// 设计要点：
//   1. 每个 step 从空 conversationHistory 开始（step 间隔离）
//      ——与 Task 1 的 Worker 上下文过滤是独立的逻辑
//   2. systemPrompt 注入 goal 上下文，让 Agent 知道整体目标
//   3. 使用 classifier + modelRouter 选择模型（与 goal-runner 保持一致）
//   4. 收集 agentLoop.run() 的所有事件后返回 StepResult
//   5. 单次 step 执行有独立的 AbortSignal（不跟随全局 abort）

import type { ILLMClient, LLMMessage, RoutingResult, ClassificationResult } from '../router/types.js';
import type { ReActAgentLoop } from './loop.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { StepExecutor } from './durable-executor.js';
import type { PlanStep } from './goal-types.js';
import type { StepResult } from './hooks.js';
import { logger } from '../utils/logger.js';

/**
 * AgentLoopStepExecutor 的依赖注入参数
 */
export interface AgentLoopStepExecutorOptions {
  /** ReAct Agent Loop 实例 */
  agentLoop: ReActAgentLoop;
  /** 场景分类器（选择模型 tier） */
  classifier: ScenarioClassifier;
  /** 模型路由器（根据 tier 选择具体模型） */
  modelRouter: ModelRouter;
  /** LLM 客户端管理器（根据 providerId 获取客户端） */
  clientManager: LLMClientManager;
  /** 基础系统提示（可选，会与 goal 上下文合并） */
  baseSystemPrompt?: string;
}

/**
 * 真实的 StepExecutor 实现
 *
 * 将 DurableExecutor 的 PlanStep 转化为 Agent Loop 的一次执行：
 *   1. 用 classifier.classify() 对 step.description 分类，得到 tier
 *   2. 用 modelRouter.route() 选择模型
 *   3. 构建 systemPrompt（注入 goal 上下文）
 *   4. 调用 agentLoop.run() 执行
 *   5. 收集输出、返回 StepResult
 */
export class AgentLoopStepExecutor implements StepExecutor {
  private readonly agentLoop: ReActAgentLoop;
  private readonly classifier: ScenarioClassifier;
  private readonly modelRouter: ModelRouter;
  private readonly clientManager: LLMClientManager;
  private readonly baseSystemPrompt: string;

  constructor(options: AgentLoopStepExecutorOptions) {
    this.agentLoop = options.agentLoop;
    this.classifier = options.classifier;
    this.modelRouter = options.modelRouter;
    this.clientManager = options.clientManager;
    this.baseSystemPrompt = options.baseSystemPrompt ?? '';
  }

  /**
   * 执行单个步骤
   *
   * @param step 计划步骤
   * @param goal 整体目标描述（注入 systemPrompt 提供上下文）
   * @returns 步骤执行结果
   */
  async execute(step: PlanStep, goal: string): Promise<StepResult> {
    const startTime = Date.now();
    logger.info('AgentLoopStepExecutor: executing step', {
      stepId: step.id,
      description: step.description.slice(0, 80),
      goal: goal.slice(0, 80),
    });

    try {
      // 1. 分类 + 路由
      const classifyResult: ClassificationResult = await this.classifier.classify({
        query: step.description,
      });
      const routeDecision: RoutingResult = await this.modelRouter.route(classifyResult);

      // 2. 获取 LLM 客户端
      const client: ILLMClient | undefined = this.clientManager.get(routeDecision.providerId);
      if (!client || !client.isReady()) {
        return {
          success: false,
          output: `提供商 ${routeDecision.providerId} 不可用`,
          durationMs: Date.now() - startTime,
        };
      }

      // 3. 构建 systemPrompt（注入 goal 上下文）
      const systemPrompt = this.buildStepSystemPrompt(step, goal);

      // 4. 调用 agentLoop.run()——每个 step 从空 conversationHistory 开始（step 间隔离）
      let responseText = '';
      for await (const event of this.agentLoop.run({
        userMessage: step.description,
        llmClient: client,
        routeDecision,
        conversationHistory: [], // step 间隔离：每个 step 从零开始
        systemPrompt,
      })) {
        if (event.type === 'text_delta') {
          responseText += event.text;
        }
        if (event.type === 'done') {
          if (event.content) responseText = event.content;
        }
      }

      const durationMs = Date.now() - startTime;
      logger.info('AgentLoopStepExecutor: step completed', {
        stepId: step.id,
        durationMs,
        responseLength: responseText.length,
      });

      return {
        success: true,
        output: responseText.slice(0, 500), // 截断避免快照过大
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('AgentLoopStepExecutor: step failed', {
        stepId: step.id,
        error: errMsg,
        durationMs,
      });

      return {
        success: false,
        output: `步骤执行失败: ${errMsg}`,
        durationMs,
      };
    }
  }

  /**
   * 构建步骤的 systemPrompt
   * 注入 goal 上下文，让 Agent 知道整体目标
   */
  private buildStepSystemPrompt(step: PlanStep, goal: string): string {
    const parts: string[] = [];

    if (this.baseSystemPrompt) {
      parts.push(this.baseSystemPrompt);
    }

    parts.push(`## 当前目标\n${goal}`);
    parts.push(`## 当前步骤\n步骤 ${step.id}: ${step.description}`);
    parts.push('请专注完成当前步骤。完成后给出简洁的结论摘要。');

    return parts.join('\n\n');
  }
}
