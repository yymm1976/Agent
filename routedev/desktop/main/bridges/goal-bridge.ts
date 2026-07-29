// desktop/main/bridges/goal-bridge.ts
// Goal 领域 delegate：负责 /goal 命令执行、goal 恢复/放弃、遗漏点检查
// 原 RouteDevEngine.executeGoalCommand（私有）/ listResumableGoals / resumeGoal / discardGoal /
// checkOmissions 及 isGoalProgressText 辅助函数委托至此。
// executeGoalCommand 在原实现中为 private，此处提升为 public 以便 ChatBridge.executeCommand 跨 bridge 调用。

import type { AppConfig } from '../../shared/config-types.js';
import { createGoalRunner } from '../../../src/runtime/goal-runner.js';
import type { GoalPlan, PlanStep } from '../../../src/agent/goal-types.js';
// Phase 77：冷启动恢复——GoalRecoveryManager + IPC 数据类型
import { GoalRecoveryManager } from '../../../src/runtime/goal-recovery.js';
import type { ResumableGoalIpcInfo, PlanEditRequestPayload } from '../../shared/ipc-types.js';
// F-021/F-015 修复：plan edit 超时清理使用 logger 持久化警告
import { logger } from '../../../src/utils/logger.js';
import type { EngineContext, PendingConfirmEntry } from './engine-context.js';

/**
 * Phase 54：判断是否为 goal-runner 输出的进度文本（已被 GoalExecutionCard 取代）
 * Electron 端 addSystemMessage 过滤这些文本，避免对话流出现"一大坨文字"
 * 保留错误/用法类文本（如 "❌ 错误: 提供商不可用"、"❌ 用法: /goal ..."）
 */
function isGoalProgressText(content: string): boolean {
  // Phase 54 修复：过滤器曾遗漏 14 类前缀（🔬/✅ 代码/⚠️ 代码/❌ 补救/✅ 补救/🧠/⏭/🔄/❌ 迭代/📋 补救/⚠️ 编排/✅ [/📝/⚠️ 模型回退|降级）
  // 并误杀最终完成摘要（┌─ ✅ 目标完成）——收窄 ┌─ 为 ┌─ 目标: 只匹配过程进度框
  const prefixes = [
    '🎯', '📋 计划', '📋 编排', '📋 补救', '✅ 计划', '✅ 步骤', '✅ 迭代', '✅ 验证',
    '✅ 代码', '✅ 补救', '✅ [', '❌ 步骤', '❌ [', '❌ 补救', '❌ 迭代',
    '⚠️ 验证', '⚠️ 迭代', '⚠️ 任务级', '⚠️ 代码', '⚠️ 编排',
    '⚠️ 模型回退', '⚠️ 模型降级',
    '▶', '🔍', '📐', '⚙️', '🎭', '📦', '💾', '⏸', '📊', '⏹', '⏭', '🔄', '🧠', '🔬', '📝',
    // 过程进度框：┌─ 目标: ...（不含最终完成摘要 ┌─ ✅ 目标完成）
    '┌─ 目标:', '│', '└─',
  ];
  return prefixes.some(p => content.startsWith(p));
}

/**
 * Goal 领域桥接器
 *
 * 持有 EngineContext 引用，复用 ctx.classifier/modelRouter/clientManager/tracker/deps 构造 GoalRunner。
 * G-004 修复：GoalRunner 通过适配器 ref 访问 EngineContext 的 pendingConfirms Map（以 goalId 为 requestId），
 * 与 sendChat 共享 abortControllerRef / conversationHistory，确保 stopGeneration 可同时中止 sendChat 与 GoalRunner。
 */
export class GoalBridge {
  constructor(private ctx: EngineContext) {}

  /**
   * G-004 修复：创建 pendingConfirmRef 适配器
   * GoalRunner 期望 { current: PendingConfirmEntry | null } 接口，
   * 此适配器通过 getter/setter 代理到 EngineContext 的 pendingConfirms Map（以 goalId 为 requestId），
   * 使 GoalRunner 的工具确认也能享受 requestId 隔离。
   */
  private createPendingConfirmRef(goalId: string): { current: PendingConfirmEntry | null } {
    const ctx = this.ctx;
    return {
      get current(): PendingConfirmEntry | null {
        return ctx.getPendingConfirm(goalId) ?? null;
      },
      set current(v: PendingConfirmEntry | null) {
        if (v === null) {
          ctx.clearPendingConfirm(goalId);
        } else {
          ctx.setPendingConfirm(goalId, v);
        }
      },
    };
  }

  /**
   * G-004 修复：创建 onToolConfirmRequest 适配器
   * GoalRunner 期望 (toolName, params) 签名，此处包装为 (requestId=goalId, toolName, params)，
   * 使前端 confirm-tool 回传的 requestId 能匹配到 GoalRunner 的 pendingConfirm entry。
   */
  private createOnToolConfirmRequest(
    goalId: string,
    original: (requestId: string, toolName: string, params: Record<string, unknown>) => void,
  ): (toolName: string, params: Record<string, unknown>) => void {
    return (toolName: string, params: Record<string, unknown>) => {
      original(goalId, toolName, params);
    };
  }

  /**
   * Phase 54：执行 /goal 命令
   *
   * 接线说明：
   *   - 懒初始化 GoalRunner（每次 /goal 重新创建，保证 goalId 隔离）
   *   - addSystemMessage 映射到 onStream(text_delta)——把 GoalRunner 的系统消息推送到渲染进程显示
   *   - setIsProcessing 空实现（engine 自己管理 done 事件）
   *   - requestPlanEdit 返回原计划步骤（auto 模式本就跳过；semi/manual 模式后续可通过 IPC 双向通信实现 UI 编辑）
   *   - nextId 用 Date.now()+递增计数保证唯一
   *
   * 注：原实现为 private，拆分为 delegate 后提升为 public，供 ChatBridge.executeCommand 调用。
   */
  async executeGoalCommand(text: string): Promise<{ ok: boolean; message?: string }> {
    const { deps, classifier, modelRouter, tracker, clientManager, options, config } = this.ctx;
    if (!deps || !classifier || !modelRouter || !tracker || !clientManager) {
      return { ok: false, message: '引擎未初始化' };
    }

    // Phase 54：每次 /goal 生成新 goalId 并重新创建 GoalRunner
    // 原因：gid 在 createGoalRunner 顶部固定，复用实例会导致多次 /goal 共用同一 goalId
    // createGoalRunner 仅组装闭包，重建成本极低，且保证 goalId 隔离
    const goalId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Phase 77：记录当前活跃 goalId，供 session:get-status 聚合器读取
    this.ctx.currentGoalId = goalId;
    try {
      this.ctx.goalRunner = createGoalRunner({
        classifier,
        modelRouter,
        clientManager,
        tracker,
        agentLoop: deps.agentLoop,
        checkpointManager: deps.checkpointManager,
        contextManager: deps.contextManager,
        config,
        systemPromptRef: deps.sharedSystemPromptRef,
        conversationHistoryRef: { current: this.ctx.conversationHistory },
        // G-004：用适配器 ref 代理到 pendingConfirms Map（以 goalId 为 requestId）
        pendingConfirmRef: this.createPendingConfirmRef(goalId),
        // Phase 54 修复：用共享 abortControllerRef，stopGeneration 可中止 GoalRunner
        abortControllerRef: this.ctx.abortControllerRef,
        currentPlanRef: { current: null },
        // addSystemMessage：把 GoalRunner 的系统消息通过 IPC 推送到渲染进程
        // Phase 54：过滤进度文本（已被 GoalExecutionCard 取代），保留错误/用法类文本
        addSystemMessage: (content: string) => {
          if (isGoalProgressText(content)) return;
          options.onStream({ type: 'text_delta', chunk: content + '\n' });
        },
        // G-004：包装 onToolConfirmRequest，以 goalId 为 requestId 传给前端
        onToolConfirmRequest: this.createOnToolConfirmRequest(goalId, options.onToolConfirmRequest),
        // Phase 54：计划编辑——发送 IPC 到渲染层 StepEditor，等待用户确认/取消
        // semi/manual 模式触发；auto 模式 goal-runner 已在上层跳过此调用
        requestPlanEdit: this.buildRequestPlanEdit(),
        setIsProcessing: () => { /* engine 自己管理 done 事件，此处空实现 */ },
        nextId: () => `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        // Phase 54 Task 1/4：多 Agent 编排 + 统一审查器
        // Phase 58：orchestrator/workerExecutor 已删除（executeWorkerStep 死方法清理）
        blackboard: deps.blackboard,
        unifiedReviewer: deps.unifiedReviewer,
        // Phase 50/32：Goal 流程核心模块
        goalAuditor: deps.goalAuditor ?? undefined,
        goalPersistence: deps.goalPersistence ?? undefined,
        completionGate: deps.completionGate,
        profiler: deps.profiler ?? undefined,
        // Phase 54：结构化事件回调 + goalId（驱动渲染层 GoalExecutionCard）
        onGoalEvent: options.onGoalEvent,
        goalId,
        // Phase 53 P5：步骤级钩子运行器（与 CLI App.tsx 对齐，触发 pre-step/post-step/on-complete）
        hookRunner: deps.hookRunner,
        // Phase 61：ACRouter 闭环模型路由（可选，未启用 config.closedLoopRouting 时为 undefined）
        // goal-runner 内部以 if 守卫消费：routingOrchestrator.isEnabled/route、routingHistory.append、
        // routingMemory.isEnabled、executionVerifier.verify、routingRegretTracker.computeCumulativeRegret
        routingOrchestrator: deps.routingOrchestrator,
        routingHistory: deps.routingHistory,
        routingMemory: deps.routingMemory,
        executionVerifier: deps.executionVerifier,
        routingRegretTracker: deps.routingRegretTracker,
        // TD-26：Phase 65 记忆系统已退役（memoryStore/hybridRetriever/localMaintenance 移除）
        // Phase 68：知识图谱（可选，未启用 config.phase68Integration 时为 undefined）
        // goal-runner 内部以 if 守卫消费：provenanceGraph.addArtifact、kanObstacleChecker.check、
        // quantitativeGate.evaluate、classifyOperation(signal, gid)
        provenanceGraph: deps.provenanceGraph,
        kanObstacleChecker: deps.kanObstacleChecker,
        quantitativeGate: deps.quantitativeGate,
        classifyOperation: deps.classifyOperation,
        // Phase 55/58：组合式路由 + DAG 引擎 + 双循环编排 + 路径路由（Wiring-Bug 修复）
        // goal-runner.ts 内部消费点：
        //   - compositionalRouter：executePlanWithCompose 跨领域分解（L1869 decompose / L1879 planDAG）
        //   - dagEngine：executePlanWithDag 执行 DAG 工作流（与 compositionalRouter 互斥守卫）
        //   - dualLoopOrchestratorRef：ref 延迟读取异步创建的 orchestrator（L1173/L1176）
        //   - pathRouter：路径路由，缺省时 goal-runner 内部 new PathRouter() 兜底（L1083）
        // 注意：GoalRunnerDeps.dagEngine 期望 DagEngine 实例，AppDependencies 暴露的是 dagEngineRef，
        //       此处解引用 .current（可能为 null，未启用 phase53 时），用 ?? undefined 归一化为可选类型
        compositionalRouter: deps.compositionalRouter,
        dualLoopOrchestratorRef: deps.dualLoopOrchestratorRef,
        dagEngine: deps.dagEngineRef.current ?? undefined,
        pathRouter: deps.pathRouter,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      options.onStream({ type: 'error', error: `GoalRunner 初始化失败: ${errMsg}` });
      return { ok: false, message: errMsg };
    }

    try {
      await this.ctx.goalRunner.handleGoalCommand(text);
      return { ok: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      options.onStream({ type: 'error', error: `/goal 执行失败: ${errMsg}` });
      return { ok: false, message: errMsg };
    }
  }

  // ============================================================
  // Phase 77：冷启动恢复 IPC 入口方法
  // ============================================================

  /**
   * 列出可恢复的 goal（驱动 UI 提示条）
   *
   * 调用 GoalRecoveryManager.detectResumableGoals()，把 ResumableGoalInfo
   * 扁平化为 IPC 友好的对象（剥离嵌套的 goal 对象，仅暴露 UI 所需字段）
   *
   * fail-open：引擎未初始化或 persistence 未启用时返回空数组
   */
  async listResumableGoals(): Promise<ResumableGoalIpcInfo[]> {
    if (!this.ctx.deps?.goalPersistence) return [];
    try {
      const manager = new GoalRecoveryManager(this.ctx.deps.goalPersistence);
      const infos = await manager.detectResumableGoals();
      return infos.map(info => ({
        id: info.goal.id,
        spec: info.goal.spec,
        status: info.goal.status,
        completedSteps: info.completedSteps,
        totalSteps: info.totalSteps,
        tokenUsed: info.goal.tokenUsed,
        tokenBudget: info.goal.tokenBudget,
        updatedAt: info.goal.updatedAt,
        isStale: info.isStale,
      }));
    } catch (err) {
      logger.warn('Phase77 listResumableGoals failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * 恢复指定 goal 的执行
   *
   * 流程：
   *   1. 通过 goalPersistence.load(goalId) 读取持久化数据
   *   2. 重建 GoalRunner（与 executeGoalCommand 一致，确保 goalId 隔离）
   *   3. 调用 goalRunner.resumeGoalPlan(persistedGoal)
   *
   * 注意：与 /goal 命令一样，每次恢复重建 GoalRunner，
   * 避免复用旧实例导致 goalId/emit 串扰
   */
  async resumeGoal(goalId: string): Promise<{ success: boolean; error?: string }> {
    const { deps, classifier, modelRouter, tracker, clientManager, options, config } = this.ctx;
    if (!deps || !classifier || !modelRouter || !tracker || !clientManager) {
      return { success: false, error: '引擎未初始化' };
    }
    if (!deps.goalPersistence) {
      return { success: false, error: 'goal persistence 未启用' };
    }
    const goal = await deps.goalPersistence.load(goalId);
    if (!goal) {
      return { success: false, error: `Goal ${goalId} 不存在` };
    }

    // 重建 GoalRunner（复用 executeGoalCommand 的初始化逻辑）
    // 注意：此处使用原 goal.id 作为 gid，确保事件流与持久化记录一致
    try {
      this.ctx.goalRunner = createGoalRunner({
        classifier,
        modelRouter,
        clientManager,
        tracker,
        agentLoop: deps.agentLoop,
        checkpointManager: deps.checkpointManager,
        contextManager: deps.contextManager,
        config,
        systemPromptRef: deps.sharedSystemPromptRef,
        conversationHistoryRef: { current: this.ctx.conversationHistory },
        // G-004：用适配器 ref 代理到 pendingConfirms Map（以 goalId 为 requestId）
        pendingConfirmRef: this.createPendingConfirmRef(goalId),
        abortControllerRef: this.ctx.abortControllerRef,
        currentPlanRef: { current: null },
        addSystemMessage: (content: string) => {
          if (isGoalProgressText(content)) return;
          options.onStream({ type: 'text_delta', chunk: content + '\n' });
        },
        // G-004：包装 onToolConfirmRequest，以 goalId 为 requestId 传给前端
        onToolConfirmRequest: this.createOnToolConfirmRequest(goalId, options.onToolConfirmRequest),
        requestPlanEdit: async (plan: GoalPlan): Promise<PlanStep[] | null> => {
          if (!options.onPlanEditRequest) return plan.steps;
          // 简化：resume 不再触发 UI 编辑，直接返回原计划
          return plan.steps;
        },
        setIsProcessing: () => { /* engine 自己管理 done 事件 */ },
        nextId: () => `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        blackboard: deps.blackboard,
        unifiedReviewer: deps.unifiedReviewer,
        goalAuditor: deps.goalAuditor ?? undefined,
        goalPersistence: deps.goalPersistence ?? undefined,
        completionGate: deps.completionGate,
        profiler: deps.profiler ?? undefined,
        onGoalEvent: options.onGoalEvent,
        goalId,
        hookRunner: deps.hookRunner,
        routingOrchestrator: deps.routingOrchestrator,
        routingHistory: deps.routingHistory,
        routingMemory: deps.routingMemory,
        executionVerifier: deps.executionVerifier,
        routingRegretTracker: deps.routingRegretTracker,
        provenanceGraph: deps.provenanceGraph,
        kanObstacleChecker: deps.kanObstacleChecker,
        quantitativeGate: deps.quantitativeGate,
        classifyOperation: deps.classifyOperation,
        compositionalRouter: deps.compositionalRouter,
        dualLoopOrchestratorRef: deps.dualLoopOrchestratorRef,
        dagEngine: deps.dagEngineRef.current ?? undefined,
        pathRouter: deps.pathRouter,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      options.onStream({ type: 'error', error: `GoalRunner 初始化失败: ${errMsg}` });
      return { success: false, error: errMsg };
    }

    this.ctx.currentGoalId = goalId;
    try {
      await this.ctx.goalRunner.resumeGoalPlan(goal);
      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      options.onStream({ type: 'error', error: `/goal 恢复失败: ${errMsg}` });
      return { success: false, error: errMsg };
    }
  }

  /**
   * 放弃（归档）指定 goal
   *
   * 调用 goalPersistence.archive(goalId)，把 goal 从 .routedev/goals/ 移到 archived/
   * 归档后不再出现在可恢复列表中
   */
  async discardGoal(goalId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ctx.deps?.goalPersistence) {
      return { success: false, error: 'goal persistence 未启用' };
    }
    try {
      await this.ctx.deps.goalPersistence.archive(goalId);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Phase 71：触发 plan 遗漏点检查
   * 流程：从 plan-revisions/<goalId>.jsonl 读取最后一份 plan → 实例化 OmissionChecker → 调用 LLM 检查
   * fail-open：任何环节失败都返回空 OmissionResult，不抛异常
   * @param goalId 目标 ID
   * @returns 遗漏点检查结果
   */
  async checkOmissions(goalId: string): Promise<{
    omissions: Array<{ category: string; description: string; severity: string; suggestedStep?: string }>;
    summary: string;
  }> {
    const { config, clientManager, options } = this.ctx;
    const EMPTY = { omissions: [], summary: '检查未执行' };
    // 检查配置开关与必需依赖
    const planCfg = (config as AppConfig & { plan?: { omissionCheckEnabled?: boolean; omissionCheckModel?: string; revisionHistoryPath?: string } }).plan;
    if (!planCfg?.omissionCheckEnabled) {
      return { ...EMPTY, summary: '遗漏点检查未启用（config.plan.omissionCheckEnabled=false）' };
    }
    if (!clientManager) {
      return { ...EMPTY, summary: 'LLM 客户端未就绪' };
    }
    try {
      // 读取 plan 修订历史，取最后一条的 after 字段作为当前 plan
      const fs = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const revisionDir = planCfg.revisionHistoryPath
        ? nodePath.resolve(planCfg.revisionHistoryPath)
        : nodePath.join(options.cwd, '.routedev', 'plan-revisions');
      const revisionFile = nodePath.join(revisionDir, `${goalId}.jsonl`);
      const data = await fs.readFile(revisionFile, 'utf-8');
      const lines = data.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        return { ...EMPTY, summary: '无 plan 修订历史' };
      }
      const lastRevision = JSON.parse(lines[lines.length - 1]) as { after?: Array<{ id: number | string; description: string; acceptanceCriteria?: string }> };
      const rawSteps = Array.isArray(lastRevision.after) ? lastRevision.after : [];
      if (rawSteps.length === 0) {
        return { ...EMPTY, summary: 'plan 步骤为空' };
      }
      // 把存储中的 GoalStep（id: number）转换为 OmissionChecker 期望的 PlanStep（id: string）
      const { toDiffPlanStep } = await import('../../../src/agent/plan-diff.js');
      const currentPlan = rawSteps.map(toDiffPlanStep);

      // 取一个 ready 的 LLM client
      const readyClients = clientManager.getReadyClients();
      if (readyClients.length === 0) {
        return { ...EMPTY, summary: '无可用 LLM 客户端' };
      }

      // 动态导入 OmissionChecker，避免主进程启动时加载开销
      const { OmissionChecker } = await import('../../../src/agent/omission-checker.js');
      const checker = new OmissionChecker({
        llmClient: readyClients[0].client,
        modelId: planCfg.omissionCheckModel ?? 'fast',
        enabled: true,
      });
      // goal 描述从 plan-revisions 元数据无法可靠获取，用 goalId 兜底（不影响检查效果）
      return await checker.check(currentPlan, { goal: goalId });
    } catch (err) {
      console.warn('[Engine] checkOmissions fail-open:', err);
      return { ...EMPTY, summary: `检查失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * 构造 requestPlanEdit 闭包（executeGoalCommand 与 resumeGoal 复用）
   *
   * semi/manual 模式触发；auto 模式 goal-runner 已在上层跳过此调用。
   * 发送 IPC 到渲染层 StepEditor，等待用户确认/取消；F-021/F-015 修复：5 分钟超时自动取消。
   */
  private buildRequestPlanEdit(): (plan: GoalPlan) => Promise<PlanStep[] | null> {
    return async (plan: GoalPlan): Promise<PlanStep[] | null> => {
      const { options } = this.ctx;
      // 无 onPlanEditRequest 回调时降级为原计划（兼容旧版 main 进程）
      if (!options.onPlanEditRequest) return plan.steps;
      const requestId = `plan-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // 把 GoalStep 简化为 IPC 传输格式（剥离运行时字段，保留 id/description/acceptanceCriteria/dependencies）
      const planSnapshot: PlanEditRequestPayload['plan'] = {
        description: plan.description,
        verificationCriteria: plan.verificationCriteria,
        steps: plan.steps.map(s => ({
          id: s.id,
          description: s.description,
          acceptanceCriteria: s.acceptanceCriteria,
          dependencies: s.dependencies,
          suggestedRole: s.suggestedRole,
        })),
      };
      // 等待渲染层响应（resolvePlanEdit 在 IPC plan:edit-response 触发时调用 resolver）
      // F-021/F-015 修复：添加 5 分钟超时，避免用户关闭 StepEditor 时 Promise 永久挂起导致 goal-runner 线程泄漏
      const edited = await new Promise<PlanEditRequestPayload['plan']['steps'] | null>((resolve) => {
        const timeoutId = setTimeout(() => {
          if (this.ctx.pendingPlanEditResolvers.has(requestId)) {
            this.ctx.pendingPlanEditResolvers.delete(requestId);
            logger.warn('Plan edit timeout, auto-cancelling', { requestId });
            resolve([]);  // 超时返回空数组（取消编辑，保留原计划）
          }
        }, 5 * 60 * 1000); // 5 分钟超时

        // 包装 resolver：resolvePlanEdit 调用时清理 timeout，避免超时定时器残留
        this.ctx.pendingPlanEditResolvers.set(requestId, (steps) => {
          clearTimeout(timeoutId);
          resolve(steps);
        });
        options.onPlanEditRequest!(requestId, planSnapshot);
      });
      if (edited === null) return null;
      // 把编辑后的简化格式 merge 回完整 PlanStep（保留原 status/startedAt 等运行时字段）
      return plan.steps.map(orig => {
        const editedStep = edited.find(e => e.id === orig.id);
        if (!editedStep) return orig;
        return {
          ...orig,
          description: editedStep.description,
          acceptanceCriteria: editedStep.acceptanceCriteria,
          dependencies: editedStep.dependencies,
          suggestedRole: editedStep.suggestedRole,
        };
      });
    };
  }
}
