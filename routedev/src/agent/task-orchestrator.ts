// src/agent/task-orchestrator.ts
// Phase 31 Task 1：TaskOrchestrator 核心状态机
// 所有非命令输入先经过 TaskOrchestrator，由它判定 intent 并分发到对应流程
// 核心哲学："同一件事走同一条路"——简单问题快速出餐，复杂任务走全套流程

import { logger } from '../utils/logger.js';
import type { ClassificationResult, ILLMClient, RoutingResult } from '../router/types.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { AppConfig } from '../config/schema.js';
import type {
  TaskIntent,
  OrchestratorStage,
  TaskContext,
  OrchestratorAction,
  SteeringMessage,
  TaskCompletionSummary,
  ProjectContext,
} from './task-orchestrator-types.js';

// 转向队列最大长度（超过时丢弃最早的并通知用户）
const MAX_STEERING_QUEUE_SIZE = 5;

// 规划模式关键词（classifier 返回 reasoning 且用户消息含这些词时进入 planning）
const PLANNING_KEYWORDS = ['规划', '计划', '方案', '设计', '架构', 'strategy', 'plan', 'design'];

/**
 * TaskOrchestrator——统一工作流的调度中心
 *
 * 状态机流转：
 *   idle → understanding → confirming_requirements → planning → executing → reviewing → completed
 *
 * intent 判定规则：
 *   - explicit_goal: 输入以 /goal 开头（实际由 App.tsx 命令分发处理，此处不重复）
 *   - planning: 输入以 /plan 开头，或 classifier 返回 reasoning 且含规划关键词
 *   - quick_answer: classifier 返回 simple 且 confidence ≥ 0.7
 *   - development: 其余所有情况
 */
export class TaskOrchestrator {
  private stage: OrchestratorStage = 'idle';
  private currentTask: TaskContext | null = null;
  private steeringQueue: SteeringMessage[] = [];
  /** 转向队列溢出时的通知（drainSteering 时一并返回） */
  private steeringOverflowNotice: string | null = null;

  constructor(
    private readonly classifier: ScenarioClassifier,
    private readonly modelRouter: ModelRouter,
    private readonly clientManager: LLMClientManager,
    private readonly config: AppConfig,
  ) {}

  /**
   * 主入口——判定 intent → 分发到对应流程
   *
   * 注意：本方法只做 intent 判定和初始路由，不执行实际流水线阶段。
   * 阶段2-5由 App.tsx 根据 OrchestratorAction.type 逐步驱动。
   */
  async handle(userInput: string, projectContext?: ProjectContext): Promise<OrchestratorAction> {
    // 阶段1：意图理解
    this.stage = 'understanding';

    // 调用 classifier（context 字段已移除：classifier 实现从不读取这些字段，是死代码）
    const classification = await this.classifier.classify({ query: userInput });

    // 判定 intent
    const intent = this.determineIntent(userInput, classification);
    logger.debug('TaskOrchestrator intent determined', { intent, tier: classification.tier, confidence: classification.confidence });

    // quick_answer 短路：不进入流水线，直接调用 ChatRunner
    if (intent === 'quick_answer') {
      this.stage = 'idle'; // quick_answer 不占用状态机
      return { type: 'direct_chat', runner: 'chat', input: userInput };
    }

    // planning 模式：进入 /plan 流程，不经过需求确认
    if (intent === 'planning') {
      this.stage = 'planning';
      this.currentTask = {
        intent,
        userInput,
        classification,
        routing: await this.route(classification),
        startedAt: Date.now(),
      };
      return { type: 'pipeline_start', intent, input: userInput };
    }

    // development：进入完整流水线
    this.stage = 'confirming_requirements';
    const routing = await this.route(classification);
    this.currentTask = {
      intent,
      userInput,
      classification,
      routing,
      startedAt: Date.now(),
    };

    // 检查是否应跳过需求确认
    if (this.shouldSkipRequirements(userInput, classification)) {
      this.stage = 'planning';
      return { type: 'pipeline_start', intent, input: userInput };
    }

    return { type: 'pipeline_start', intent, input: userInput };
  }

  /**
   * 判定任务意图
   * 规则优先级：explicit_goal > planning > quick_answer > development
   */
  private determineIntent(input: string, classification: ClassificationResult): TaskIntent {
    // explicit_goal：/goal 开头（实际由命令分发处理，但保留判定以防直接调用）
    if (input.startsWith('/goal')) {
      return 'explicit_goal';
    }

    // planning：/plan 开头，或 reasoning + 规划关键词
    if (input.startsWith('/plan')) {
      return 'planning';
    }
    if (classification.tier === 'reasoning') {
      const lowerInput = input.toLowerCase();
      if (PLANNING_KEYWORDS.some((kw) => lowerInput.includes(kw.toLowerCase()))) {
        return 'planning';
      }
    }

    // quick_answer：simple 且 confidence ≥ 0.7
    if (classification.tier === 'simple' && classification.confidence >= 0.7) {
      return 'quick_answer';
    }

    // development：其余所有情况（medium、complex、低 confidence simple）
    return 'development';
  }

  /**
   * 路由决策——根据 classification 选择模型
   */
  private async route(classification: ClassificationResult): Promise<RoutingResult> {
    return this.modelRouter.route(classification);
  }

  /**
   * 判断是否应跳过需求确认
   * 跳过条件：
   *   - 用户消息 ≤ 20 字符且 classifier 判定 simple
   *   - 用户消息以 ! 开头（强制直达语法）
   *   - optimization.workflow.autoRequirements 为 false
   */
  shouldSkipRequirements(input: string, classification: ClassificationResult): boolean {
    // 配置开关
    if (!this.config.optimization.workflow.autoRequirements) {
      return true;
    }
    // 强制直达语法
    if (input.startsWith('!')) {
      return true;
    }
    // 短消息 + simple
    if (input.length <= 20 && classification.tier === 'simple') {
      return true;
    }
    return false;
  }

  /**
   * 获取当前阶段（UI 显示用）
   */
  getStage(): OrchestratorStage {
    return this.stage;
  }

  /**
   * 获取当前任务上下文
   */
  getCurrentTask(): TaskContext | null {
    return this.currentTask;
  }

  /**
   * 设置当前任务上下文（阶段间传递状态时调用）
   */
  setCurrentTask(task: TaskContext | null): void {
    this.currentTask = task;
  }

  /**
   * 设置当前阶段
   */
  setStage(stage: OrchestratorStage): void {
    this.stage = stage;
    logger.debug('TaskOrchestrator stage transition', { to: stage });
  }

  /**
   * 中止当前任务
   */
  async abort(): Promise<void> {
    logger.info('TaskOrchestrator aborting current task');
    this.stage = 'idle';
    this.currentTask = null;
    this.steeringQueue = [];
    this.steeringOverflowNotice = null;
  }

  /**
   * 返回当前任务摘要（状态栏显示用）
   */
  getSummary(): TaskCompletionSummary | null {
    if (!this.currentTask) return null;
    const task = this.currentTask;
    const results = task.executionResults ?? [];
    const totalUsage = results.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.tokenUsage.inputTokens,
        outputTokens: acc.outputTokens + r.tokenUsage.outputTokens,
        totalTokens: acc.totalTokens + r.tokenUsage.totalTokens,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
    const modifiedFiles = Array.from(new Set(results.flatMap((r) => r.modifiedFiles)));
    return {
      intent: task.intent,
      goal: task.requirements?.goal ?? task.userInput,
      stepsCompleted: results.filter((r) => r.success).length,
      stepsTotal: task.plan?.steps.length ?? 0,
      reviewPassed: task.reviewResult?.passed ?? false,
      totalDurationMs: task.completedAt ? task.completedAt - task.startedAt : Date.now() - task.startedAt,
      totalTokenUsage: totalUsage,
      modifiedFiles,
      failedStepIds: results.filter((r) => !r.success).map((r) => r.stepId),
      skippedStepIds: [],
    };
  }

  // ===== 转向队列（Steering Queue） =====
  // 学习 pi-mono：用户在 Agent 工作时可以继续输入指令，排队后在合适时机交付

  /**
   * 将用户消息放入转向队列
   * @param mode 交付时机
   *   - immediate: 当前 LLM 调用返回后立即注入
   *   - next_iteration: 下一次 ReAct 迭代开始时注入
   *   - after_current_step: 当前步骤完成后、下一步骤开始前注入
   * @returns 是否被接受（队列满时丢弃最早的并返回 false 表示发生了丢弃）
   */
  enqueueSteering(message: string, mode: SteeringMessage['mode']): boolean {
    const dropped = this.steeringQueue.length >= MAX_STEERING_QUEUE_SIZE;
    if (dropped) {
      // 丢弃最早的
      const droppedMsg = this.steeringQueue.shift();
      this.steeringOverflowNotice = `转向队列已满（最多 ${MAX_STEERING_QUEUE_SIZE} 条），已丢弃最早的消息："${droppedMsg?.content.slice(0, 50) ?? ''}"`;
      logger.warn('Steering queue overflow, dropped oldest message', {
        dropped: droppedMsg?.content.slice(0, 100),
        mode: droppedMsg?.mode,
      });
    }
    this.steeringQueue.push({
      content: message,
      mode,
      enqueuedAt: Date.now(),
    });
    logger.debug('Steering message enqueued', { mode, queueSize: this.steeringQueue.length });
    return !dropped;
  }

  /**
   * 取出排队的消息（在合适的时机调用）
   * 取出后队列清空——不要在 drainSteering 后重复消费同一批消息
   * @param modeFilter 只取出指定交付模式的消息；不传则取出全部
   * @returns 取出的消息列表（可能为空）
   */
  drainSteering(modeFilter?: SteeringMessage['mode']): SteeringMessage[] {
    let result: SteeringMessage[];
    if (modeFilter) {
      result = this.steeringQueue.filter((m) => m.mode === modeFilter);
      this.steeringQueue = this.steeringQueue.filter((m) => m.mode !== modeFilter);
    } else {
      result = this.steeringQueue;
      this.steeringQueue = [];
    }
    return result;
  }

  /**
   * 检查是否有待交付的转向消息
   */
  hasSteering(): boolean {
    return this.steeringQueue.length > 0;
  }

  /**
   * 获取转向队列长度（UI 显示 "📨 已排队 (N 条待交付)"）
   */
  getSteeringQueueSize(): number {
    return this.steeringQueue.length;
  }

  /**
   * 获取并清除溢出通知（drainSteering 时一并返回给调用方）
   */
  consumeOverflowNotice(): string | null {
    const notice = this.steeringOverflowNotice;
    this.steeringOverflowNotice = null;
    return notice;
  }

  /**
   * 重置（新会话或新任务时调用）
   */
  reset(): void {
    this.stage = 'idle';
    this.currentTask = null;
    this.steeringQueue = [];
    this.steeringOverflowNotice = null;
  }
}

/**
 * 创建 TaskOrchestrator 的工厂函数
 */
export function createTaskOrchestrator(
  classifier: ScenarioClassifier,
  modelRouter: ModelRouter,
  clientManager: LLMClientManager,
  config: AppConfig,
): TaskOrchestrator {
  return new TaskOrchestrator(classifier, modelRouter, clientManager, config);
}

// 暴露常量供测试和 UI 使用
export { MAX_STEERING_QUEUE_SIZE, PLANNING_KEYWORDS };
