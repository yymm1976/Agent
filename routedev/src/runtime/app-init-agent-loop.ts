// src/runtime/app-init-agent-loop.ts
// Agent 循环子系统装配：SubAgent + ReActAgentLoop + DualLoop + CompletionGate + Goal/Task 编排
// 从 app-init-agent.ts 拆分（Phase 92 / TD-08），保持功能完全等价
//
// 职责：
//   1. Spawn Agent（createSpawnAgentFn + 并行上限 + 委托体系包装 + SpawnAgentTool）
//   2. SkillLifecycleManager + AgentActivityStore + AgentProfileManager
//   3. CodeMap 引擎预热 + CodeMapEngine + CodeMapWatcher + CodeMapFallback
//   4. Goal 流程（PathRouter + DagEngine + GoalAuditor + GoalPersistence + 冷启动恢复 + shutdown 持久化）
//   5. TaskOrchestrator + UnifiedReviewer + CompletionGate + Steering Queue
//   6. ExperimentManager
//   7. Phase 48 模块（IntegrityManifest / Cite / Import / Macros / MCPBridge）
//   8. Phase 49 DualLoopOrchestrator + Phase 52 SkillSecurityGate + Phase 53 CircuitBreaker
//
// 依赖：tools 子系统（registry/agentLoop/toolExecutor/...）、memory 子系统（contextManager）、
//       observability 子系统（trace/audit）、router 子系统（primaryClient/clientManager/classifier/modelRouter/tracker）、
//       middleware 子系统（pluginSystem）

import type { ClassificationResult, RoutingResult, ScenarioTier } from '../router/types.js';
import type { DualLoopOrchestrator } from '../agent/dual-loop-orchestrator.js';
import type { DagEngine } from '../agent/workflow/dag-engine.js';
import type {
  SpawnAgentFunction,
  SpawnAgentParams,
  SubagentType,
  DelegationIntegrationDeps,
} from '../tools/builtin/spawn-agent.js';

import { PathRouter } from '../agent/path-router.js';
import { GoalAuditor } from '../agent/goal-audit.js';
import { GoalPersistence } from '../agent/goal-persistence.js';
import { detectResumableGoalsOnStartup } from './goal-recovery.js';
import { ExperimentManager } from '../harness/experiment-manager.js';
import { IntegrityManifest } from '../security/integrity-manifest.js';
import { AgentProfileManager } from '../agents/profiles/manager.js';
import { AgentActivityStore } from '../agents/activity-store.js';
import { SubAgentLifecycle } from '../agents/sub-agent-lifecycle.js';
import { SubAgentScoreCardCollector } from '../agents/sub-agent-score-card.js';
import { SubagentRegistry } from '../agents/subagent-registry.js';
import { ContextPacker } from '../agents/context-packer.js';
import { DelegationGate } from '../agents/delegation-gate.js';
import {
  SpawnAgentTool,
  createChildRegistry,
  createConcurrencyLimitedSpawnFn,
  resolveProfileForSubagent,
  wrapSpawnAgentWithDelegation,
} from '../tools/builtin/spawn-agent.js';
import { SkillLifecycleManager } from '../skills/skill-lifecycle.js';
import { createTaskOrchestrator } from '../agent/task-orchestrator.js';
import { createUnifiedReviewer } from '../agent/unified-reviewer.js';
import { createCompletionGate } from '../agent/completion-gate.js';
import { ReActAgentLoop } from '../agent/loop.js';
// Phase 97 Part A Task A4：统一执行上下文（子 Agent 委派触发来源）
import { createDefaultExecutionContext } from '../agent/execution-context.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistryAdapter } from '../tools/adapter.js';
import { GuardedToolExecutorAdapter } from '../agent/work-modes.js';
import { registerShutdownHook } from './graceful-shutdown.js';
import { logger } from '../utils/logger.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { InitContext, AppDependencies } from './app-init.js';
import type { createPluginSystem } from './plugin-init.js';
// F-075：常量提取到 utils/constants.ts
import { TOOL_EXECUTION_TIMEOUT_MS } from '../utils/constants.js';
// V2-003：统一环境变量白名单过滤，防止 process.env 敏感信息透传到子 Agent 工具子进程
import { filterProcessEnvByWhitelist } from '../security/env-filter.js';

/**
 * 装配 Agent 循环子系统
 * 包含：Spawn Agent、Goal 流程、TaskOrchestrator、UnifiedReviewer、CompletionGate、
 *       CodeMap 引擎、Phase 48/49/52/53/77 全部接线
 *
 * @param ctx 共享装配上下文（读取大量字段，写入 taskOrchestrator/unifiedReviewer/completionGate 等）
 * @param pluginSystem 插件系统（由 setupAgentMiddleware 创建，供 createSpawnAgentFn 中子 Agent Loop 复用中间件管线）
 * @returns Agent 循环子系统依赖片段
 */
export function setupAgentLoop(
  ctx: InitContext,
  pluginSystem: ReturnType<typeof createPluginSystem>,
): Partial<AppDependencies> {
  const {
    config,
    cwd,
    trace,
    clientManager,
    primaryClient,
    primaryProviderId,
    classifier,
    modelRouter,
    tracker,
    registry,
    securityChecker,
    guardedAdapter,
    workModeController,
    readTracker,
    readBeforeWriteEnabled,
    webSearchEnv,
  } = ctx;

  // ===== Phase 94 Task 3：agentLoop 基础注入（从 tools 子系统迁移至此） =====
  // Phase 94 Task 4 修复：agentLoop 实例由 createAgentSubsystem 入口创建并写入 ctx，
  //   此处直接从 ctx 读取，避免与 setupAgentMiddleware 抢占创建权
  // 依赖：guardedAdapter/workModeController 由 tools 子系统写入 ctx
  // 依赖：trace/recallInjector/contextManager 由 observability/memory 子系统写入 ctx
  // 依赖：virtualFS/planState/resultSanitizer/policyEngine/toolOutputPipeline 由 tools 子系统写入 ctx
  // 依赖：profiler 由 tools 子系统写入 ctx
  const agentLoop = ctx.agentLoop!;

  // Phase 97 Part E：子会话注册表（子 Agent 可见性——登记/查询/停止）
  // 无论多 Agent 开关是否启用都装配：UI 侧子会话列表需要稳定的查询入口
  const subagentRegistry = new SubagentRegistry();
  ctx.subagentRegistry = subagentRegistry;

  // Phase 34：注入 TraceCollector，记录 LLM 调用与循环事件
  // setTraceCollector 接受 null 不接受 undefined，用 ?? null 转换
  agentLoop.setTraceCollector(ctx.trace ?? null);

  // Phase 71 Task B3：注入记忆召回注入器到 agentLoop
  // run() 在 systemPrompt 处理完后调用 recallInjector.recallToPrompt(userMessage)
  // 把 KnowledgeGraph 中相关记忆格式化为【相关记忆】片段追加到 systemPrompt
  // setRecallInjector 接受 null 不接受 undefined，用 ?? null 转换
  agentLoop.setRecallInjector(ctx.recallInjector ?? null);

  // 注入压缩器到 agentLoop：ReAct 循环每轮迭代前检查 messages 的 token 数，
  // 超过阈值时调用 compressEnhanced 压缩，防止工具调用/结果持续累积导致超出模型窗口
  // ContextManager 结构化兼容 CompactorLike（shouldCompressEnhanced + compressEnhanced）
  agentLoop.setCompactor(ctx.contextManager ?? null);

  // Phase 71 Task E1：注入 VirtualFS 到 agentLoop
  // loop 持有同一 VFS 实例（与上方注册的 4 个 VFS 工具共享），保证工具层与 loop 状态一致
  agentLoop.setVirtualFS(ctx.virtualFS as import('../agent/context/virtual-fs.js').VirtualFS);

  // Phase 71 Task E2：注入 PlanState 到 agentLoop
  // loop 持有同一 PlanState 实例（内部复用 virtualFS），保证工具层与 loop 状态一致
  agentLoop.setPlanState(ctx.planState!);

  // 任务1：注入 ComposePipeline，让 Compose 模式具备阶段提示词注入和自动流转能力
  // Phase 81 Task 4：packs.compose.enabled 门控（standard-pack，默认 false 退出装配）
  //   未启用时注入 null，loop 走原始行为（无 compose 阶段流转）；enabled:true 恢复装配
  agentLoop.setComposePipeline(
    ctx.enabledPacks.compose ? ctx.workModeController!.getComposePipeline() : null,
  );
  // 任务3：注入简洁思考约束开关（来自 optimization.conciseThinking.enabled，默认 false）
  agentLoop.setConciseThinking(config.optimization?.conciseThinking?.enabled === true);

  // Phase 30 Task 1：Token Profiler（可观测性）
  // Phase 94 Task 3：profiler 由 tools 子系统创建并写入 ctx.profiler，此处注入到 agentLoop
  if (ctx.profiler) {
    agentLoop.setProfiler(ctx.profiler);
  }

  // Phase 53 Task 9：预算监控（受 config.phase53Integration.budgetMonitor.enabled 守护，fail-open）
  // tokenLimit 取自 config.router.budget.dailyLimit（默认 500000），避免在 BudgetMonitorConfigSchema 重复定义
  const phase53BudgetCfg = config.phase53Integration?.budgetMonitor;
  if (phase53BudgetCfg?.enabled) {
    const budgetMonitorModulePath = '../agent/budget-monitor.js';
    import(budgetMonitorModulePath)
      .then((mod: { BudgetMonitor: new (opts: { tokenLimit: number; costLimit?: number; tokenWarnRatio?: number; toolLoopThreshold?: number }) => import('../agent/budget-monitor.js').BudgetMonitor }) => {
        const monitor = new mod.BudgetMonitor({
          tokenLimit: config.router.budget.dailyLimit,
          costLimit: phase53BudgetCfg.costLimitPerSession,
          tokenWarnRatio: phase53BudgetCfg.tokenWarnRatio,
          toolLoopThreshold: phase53BudgetCfg.toolLoopThreshold,
        });
        // setBudgetMonitor 已在 ReActAgentLoop 声明；保留 typeof 守卫兼容装配顺序
        if (typeof agentLoop.setBudgetMonitor === 'function') {
          agentLoop.setBudgetMonitor(monitor);
          logger.debug('BudgetMonitor injected', {
            via: 'setBudgetMonitor',
            tokenLimit: config.router.budget.dailyLimit,
          });
        }
      })
      .catch((err) => { logger.warn('BudgetMonitor fail-open', { error: err instanceof Error ? err.message : String(err) }); });
  }

  // ===== Phase 42：PolicyEngine 接线（由 tools 子系统创建，此处注入到 agentLoop） =====
  if (ctx.policyEngine && typeof agentLoop.setPolicyEngine === 'function') {
    agentLoop.setPolicyEngine(ctx.policyEngine);
  }

  // Phase 32 Task 1.2：将 sanitizer 注入 agentLoop，所有工具结果在注入 LLM 上下文前都会经过净化
  agentLoop.setSanitizer(ctx.resultSanitizer!);

  // Phase 71 Task D3/D7：注入 ToolOutputPipeline（统一 Sanitizer / Concise Thinking / Budget Offload 三阶段）
  // pipeline 未注入时 loop 走原 sanitizeToolResult 逻辑（零回归）；注入后收拢到一处编排
  if (ctx.toolOutputPipeline) {
    agentLoop.setToolOutputPipeline(ctx.toolOutputPipeline);
  }

  // ===== P1-6：子 Agent 生成工具（需注入 spawnAgent 函数，依赖 agentLoop 和 primaryClient） =====
  // Phase 50 Task 3：声明外层作用域变量，delegationIntegration 开启时由 wrapSpawnAgentWithDelegation 块填充
  let delegationLifecycle: SubAgentLifecycle | null = null;
  let delegationScoreCardCollector: SubAgentScoreCardCollector | null = null;

  // CR-4b：活动面板存储（config.activityPanel.enabled 守护）
  const activityPanelCfg = config.activityPanel;
  const activityStore = activityPanelCfg?.enabled
    ? new AgentActivityStore(activityPanelCfg.maxActiveDisplay, activityPanelCfg.maxRecentDisplay)
    : undefined;
  if (activityStore) {
    logger.info('app-init: AgentActivityStore 已启用', {
      maxActive: activityPanelCfg!.maxActiveDisplay,
      maxRecent: activityPanelCfg!.maxRecentDisplay,
    });
  }

  // Phase 55 Task 8：提前创建 workerProfileManager（供 delegationDeps.detachedSession 和 WorkerExecutor 共享）
  const workerProfileManager = new AgentProfileManager(cwd);
  workerProfileManager.loadAll().catch(err => {
    logger.warn('AgentProfileManager.loadAll 失败，WorkerExecutor 将回退到 WORKER_ROLE_PROMPTS', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Phase 52 Task 1：SkillLifecycleManager 提前创建（需在 delegationDeps 装配前就绪）
  let skillLifecycleManager: SkillLifecycleManager | undefined;
  if (config.phase52Integration?.skillLifecycle?.enabled && config.packs?.skillLifecycle?.enabled) {
    skillLifecycleManager = new SkillLifecycleManager(config.phase52Integration.skillLifecycle);
    logger.info('app-init: SkillLifecycleManager 已启用');

    // 技术债 2 修复：定期清理过期 Skill 记忆（陷阱 #171：memoryRetentionDays 必须严格执行）
    const memoryRetentionDays = config.phase52Integration.skillLifecycle.memoryRetentionDays;
    const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟
    const cleanupTimer = setInterval(() => {
      try {
        const cleaned = skillLifecycleManager!.cleanupExpiredMemory(memoryRetentionDays);
        if (cleaned > 0) {
          logger.info('SkillLifecycleManager: 清理过期记忆', { cleanedCount: cleaned, memoryRetentionDays });
        }
      } catch (err) {
        logger.warn('SkillLifecycleManager.cleanupExpiredMemory failed (non-blocking)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, CLEANUP_INTERVAL_MS);
    // 清理定时器不阻止进程退出
    cleanupTimer.unref?.();
    // P0-14：注册 shutdown 钩子，进程退出前清除定时器
    registerShutdownHook(60, 'skill-lifecycle-cleanup-timer', () => {
      clearInterval(cleanupTimer);
    });
  }

  /**
   * 创建子 Agent 的 spawn 函数
   * Phase 38 Task 2：使用 childRegistry 隔离工具集，不再修改共享 registry
   */
  const createSpawnAgentFn = (): SpawnAgentFunction => {
    // Phase 48 Task 4：闭包级 AgentProfileManager 实例，所有 spawn 调用共享
    const profileManager = new AgentProfileManager(cwd);
    let profileManagerLoaded = false;

    return async (params, options) => {
      // 向后兼容：字符串参数转换为对象（model 强制必填，旧字符串调用方默认 inherit）
      const normalizedParams: SpawnAgentParams = typeof params === 'string'
        ? { description: params, prompt: params, model: 'inherit' }
        : params;
      const subagentType: SubagentType = normalizedParams.subagentType ?? 'general';
      // Phase 97 Part E：生成子会话 ID 并登记（UI 可检查/停止）
      const childSessionId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const abortController = subagentRegistry.register({
        childSessionId,
        parentSessionId: ctx.offloadSessionId ?? 'desktop-local',
        description: normalizedParams.description.slice(0, 100),
        subagentType,
        status: 'running',
      });

      if (!primaryClient) {
        return { success: false, result: '', error: 'LLM 客户端不可用' };
      }
      try {
        // Phase 48 Task 4：首次调用时加载 AgentProfileManager（fail-open）
        if (!profileManagerLoaded) {
          try {
            await profileManager.loadAll();
          } catch (err) {
            logger.warn('AgentProfileManager.loadAll 失败，回退到硬编码白名单', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          profileManagerLoaded = true;
        }

        const profile = resolveProfileForSubagent(profileManager, subagentType);

        const defaultModel = config.providers[0]?.models[0];
        if (!defaultModel) {
          return { success: false, result: '', error: '未配置可用模型' };
        }
        const explicitModelId = normalizedParams.model && normalizedParams.model !== 'inherit'
          ? normalizedParams.model
          : undefined;
        let childClient = primaryClient;
        let routeDecision: RoutingResult;
        if (explicitModelId) {
          const provider = config.providers.find(p => p.models.some(m => m.id === explicitModelId));
          const model = provider?.models.find(m => m.id === explicitModelId);
          if (!provider || !model) {
            return { success: false, result: '', error: `子 Agent params.model 指定的模型不存在: ${explicitModelId}` };
          }
          const modelClient = clientManager.get(provider.id);
          if (!modelClient || !modelClient.isReady()) {
            return { success: false, result: '', error: `子 Agent params.model 指定的提供商不可用: ${provider.id}` };
          }
          childClient = modelClient;
          routeDecision = {
            model,
            providerId: provider.id,
            fallbackUsed: false,
            originalTier: (model.tier ?? 'medium') as ScenarioTier,
            degraded: false,
          };
        } else if (profile?.modelId && profile.modelId !== 'default') {
          const provider = config.providers.find(p => p.models.some(m => m.id === profile.modelId));
          const model = provider?.models.find(m => m.id === profile.modelId);
          if (!provider || !model) {
            return { success: false, result: '', error: `子 Agent Profile 指定的模型不存在: ${profile.modelId}` };
          }
          const modelClient = clientManager.get(provider.id);
          if (!modelClient || !modelClient.isReady()) {
            return { success: false, result: '', error: `子 Agent Profile 指定的提供商不可用: ${provider.id}` };
          }
          childClient = modelClient;
          routeDecision = {
            model,
            providerId: provider.id,
            fallbackUsed: false,
            originalTier: (model.tier ?? 'medium') as ScenarioTier,
            degraded: false,
          };
        } else if (classifier && modelRouter) {
          const classifyResult: ClassificationResult = await classifier.classify({ query: normalizedParams.description });
          routeDecision = await modelRouter.route(classifyResult);
          const routedClient = clientManager.get(routeDecision.providerId);
          if (!routedClient || !routedClient.isReady()) {
            return { success: false, result: '', error: `子 Agent 路由提供商不可用: ${routeDecision.providerId}` };
          }
          childClient = routedClient;
        } else {
          routeDecision = {
            model: defaultModel,
            // router 子系统已写入 primaryProviderId，此处非空
            providerId: primaryProviderId!,
            fallbackUsed: false,
            originalTier: (defaultModel.tier ?? 'medium') as ScenarioTier,
            degraded: false,
          };
        }
        let responseText = '';
        let inputTokens = 0;
        let outputTokens = 0;

        // Phase 38 Task 2：创建子 Agent 专用 registry（防递归 + 角色白名单过滤）
        const childRegistry = createChildRegistry(registry!, subagentType, profileManager);

        // 为子 Agent 创建专用 adapter
        const childToolExecutor = new ToolExecutor(childRegistry);
        childToolExecutor.setSecurityChecker(securityChecker!);
        const childAdapter = new ToolRegistryAdapter(childRegistry, childToolExecutor, {
          workingDirectory: cwd,
          allowedDirectories: [cwd],
          // V2-003：先用白名单过滤 process.env，再合并 webSearchEnv（已过白名单的 web search 相关 env）
          environment: {
            ...filterProcessEnvByWhitelist(process.env),
            ...webSearchEnv!,
          },
          timeoutMs: TOOL_EXECUTION_TIMEOUT_MS,
        });
        childAdapter.setTraceCollector(trace!);
        const childGuardedAdapter = new GuardedToolExecutorAdapter(
          childAdapter, workModeController!, readTracker!, readBeforeWriteEnabled!,
        );

        // 创建临时 Agent Loop 实例
        const profileMaxSteps = profile?.maxSteps && profile.maxSteps > 0
          ? profile.maxSteps
          : undefined;
        const requestedMaxIterations = normalizedParams.maxIterations
          ?? options?.maxIterations
          ?? profileMaxSteps
          ?? 20;
        const effectiveMaxIterations = profileMaxSteps
          ? Math.min(requestedMaxIterations, profileMaxSteps)
          : requestedMaxIterations;
        const childLoop = new ReActAgentLoop(childGuardedAdapter, {
          maxIterations: effectiveMaxIterations,
          toolsEnabled: true,
          parallelToolExecution: true,
          autoApprovePatterns: config.autonomy?.autoApprovePatterns ?? [],
        });
        childLoop.setMiddlewarePipeline(pluginSystem.middlewarePipeline);
        // 子 Agent 共享父会话的压缩器，防止子 Agent 的 messages 膨胀超出模型窗口
        childLoop.setCompactor(ctx.contextManager ?? null);

        const childSystemPrompt = profile?.systemPrompt
          ?? options?.systemPrompt
          ?? '你是一个专注的子 Agent，负责完成分配给你的独立子任务。';

        // P0-4：renderedSystemPrompt 优先级最高
        const effectiveSystemPrompt = options?.renderedSystemPrompt ?? childSystemPrompt;
        const effectiveHistory = options?.forkedConversationHistory ?? [];

        // 从父 Loop 获取当前 run() 期间的确认回调，传给子 Loop
        // 子 Agent 需要确认的工具调用将通过此回调委托给父会话处理（而非 fail-closed 拒绝）
        const parentConfirmTool = agentLoop!.getCurrentConfirmTool();

        for await (const event of childLoop.run({
          userMessage: normalizedParams.prompt,
          llmClient: childClient,
          routeDecision,
          conversationHistory: effectiveHistory,
          systemPrompt: effectiveSystemPrompt,
          // Task 5：委托父会话确认通道（无父会话确认通道时为 undefined，子 Loop 内部 fail-closed）
          onConfirmTool: parentConfirmTool ?? undefined,
          // Phase 97 Part E：绑定子会话中断信号，UI 停止时 abort
          signal: abortController.signal,
          // Phase 97 Part A Task A4：透传执行上下文——子 Agent 委派触发来源 delegation
          context: createDefaultExecutionContext(childSessionId, { triggerSource: 'delegation' }),
        })) {
          switch (event.type) {
            case 'text_delta':
              responseText += event.text;
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
        // Phase 97 Part E：更新子会话可见状态（完成/失败/中止）
        const wasAborted = abortController.signal.aborted;
        subagentRegistry.update(childSessionId, {
          status: wasAborted ? 'aborted' : responseText ? 'completed' : 'failed',
          result: responseText,
          tokenUsage: { inputTokens, outputTokens },
        });
        return {
          success: !wasAborted,
          result: responseText,
          tokenUsage: { inputTokens, outputTokens },
          // Phase 97 Part E：子会话 ID 透传（UI 可追踪）
          childSessionId,
        };
      } catch (err) {
        subagentRegistry.update(childSessionId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          success: false,
          result: '',
          error: err instanceof Error ? err.message : String(err),
          childSessionId,
        };
      }
    };
  };

  // Phase 81 Task 4：packs.multiAgent.enabled 门控（extended-pack，默认 false 退出装配）
  //   注：工具注册逻辑（registry.register）属于装配层，非 app-init-tools.ts 的静态注册段
  const subAgentsCfg = config.subAgents;
  const subAgentsEnabled = subAgentsCfg?.enabled !== false && ctx.enabledPacks.multiAgent;
  const MAX_CONCURRENT_SUB_AGENTS = subAgentsEnabled ? (subAgentsCfg?.maxParallel ?? config.agent?.maxConcurrentSubAgents ?? 3) : 0;

  if (subAgentsEnabled && MAX_CONCURRENT_SUB_AGENTS > 0) {
    let spawnAgentFn: SpawnAgentFunction = createConcurrencyLimitedSpawnFn(
      createSpawnAgentFn(),
      MAX_CONCURRENT_SUB_AGENTS,
    );
    const delegationCfg = config.delegationIntegration;
    const delegationPolicyCfg = config.delegationPolicy;
    const resultSchemaCfg = config.resultSchema;
    const anyDelegationEnabled = !!(
      delegationCfg?.contextPackerEnabled ||
      delegationCfg?.delegationGateEnabled ||
      delegationCfg?.delegationEnforcerEnabled ||
      delegationCfg?.lifecycleEnabled ||
      delegationCfg?.scoreCardEnabled ||
      delegationPolicyCfg?.boundedDelegationEnabled ||
      resultSchemaCfg?.enabled ||
      !!activityStore
    );
    if (anyDelegationEnabled) {
      const contextPacker = delegationCfg?.contextPackerEnabled ? new ContextPacker() : undefined;
      const delegationGate = delegationCfg?.delegationGateEnabled ? new DelegationGate() : undefined;
      const subAgentLifecycle = delegationCfg?.lifecycleEnabled ? new SubAgentLifecycle() : null;
      const scoreCardCollector = delegationCfg?.scoreCardEnabled ? new SubAgentScoreCardCollector() : null;
      const delegationPolicyEnabled = !!delegationPolicyCfg?.boundedDelegationEnabled;
      const delegationPolicy = delegationPolicyEnabled
        ? {
            hardDelegationTypes: (delegationPolicyCfg!.hardDelegationTypes ?? []).filter(
              (t): t is 'frontend' | 'research' | 'review' =>
                t === 'frontend' || t === 'research' || t === 'review',
            ),
            refuseIfSpecialistUnavailable: delegationPolicyCfg!.refuseIfSpecialistUnavailable ?? false,
            specialistAvailability: delegationPolicyCfg!.specialistAvailabilityOverride ?? {},
          }
        : undefined;
      const delegationDeps: DelegationIntegrationDeps = {
        contextPackerEnabled: delegationCfg?.contextPackerEnabled,
        contextPacker,
        delegationGateEnabled: delegationCfg?.delegationGateEnabled,
        delegationGate,
        delegationEnforcerEnabled: delegationCfg?.delegationEnforcerEnabled,
        parentAgent: { id: 'parent-root', activeSubAgents: [] },
        lifecycleEnabled: delegationCfg?.lifecycleEnabled,
        lifecycle: subAgentLifecycle ?? undefined,
        scoreCardEnabled: delegationCfg?.scoreCardEnabled,
        scoreCardCollector: scoreCardCollector ?? undefined,
        delegationPolicyEnabled,
        delegationPolicy,
        resultSchemaEnabled: !!resultSchemaCfg?.enabled,
        resultSchemaStrict: resultSchemaCfg?.strictValidation,
        resultSchemaFallbackToText: resultSchemaCfg?.fallbackToText,
        activityStoreEnabled: !!activityStore,
        activityStore,
        detachedSessionEnabled: !!delegationPolicyCfg?.detachedSessionEnabled,
        profileManager: workerProfileManager,
        skillLifecycleManager,
        // Phase 97 Part I Task I3：注入 trace（提取 tool 序列生成流程沉淀建议；未就绪时 undefined 跳过）
        trace: ctx.trace,
      };
      spawnAgentFn = wrapSpawnAgentWithDelegation(spawnAgentFn, delegationDeps);
      logger.info('Phase 50: spawn_agent wrapped with delegation modules', {
        contextPacker: !!contextPacker,
        gate: !!delegationGate,
        enforcer: delegationCfg?.delegationEnforcerEnabled,
        lifecycle: !!subAgentLifecycle,
        scoreCard: !!scoreCardCollector,
        delegationPolicy: delegationPolicyEnabled,
        resultSchema: !!resultSchemaCfg?.enabled,
        activityStore: !!activityStore,
      });
      delegationLifecycle = subAgentLifecycle;
      delegationScoreCardCollector = scoreCardCollector;
    }
    registry!.register(new SpawnAgentTool(spawnAgentFn));
  }

  // ===== Phase 41/42：tree-sitter 代码地图引擎预热（fail-open） =====
  // Phase 81 Task 4：packs.codeMap.enabled 门控（standard-pack，默认 false 退出装配）
  if (ctx.enabledPacks.codeMap) {
    import('../code-map/indexer.js')
    .then(async (mod: { loadOrBuildIndex: (rootDir: string, opts?: { maxFiles?: number }) => Promise<{ stats: unknown; db: unknown }> }) => {
      try {
        await mod.loadOrBuildIndex(cwd, { maxFiles: 5000 });
        logger.info('CodeMap loadOrBuildIndex prewarmed', { rootDir: cwd });
      } catch (err) {
        logger.warn('CodeMap loadOrBuildIndex prewarm failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
    .catch((err: unknown) => {
      logger.warn('CodeMap indexer module not available', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  const experimentsCfg = config.experiments;
  if (experimentsCfg) {
    logger.info('Experiments config loaded', {
      maxActiveWorktrees: experimentsCfg.maxActiveWorktrees,
      autoCleanup: experimentsCfg.autoCleanup,
    });
  }

  // ===== Phase 41：CodeMapEngine 接线（fail-open 动态 import） =====
  // Phase 81 Task 4：packs.codeMap.enabled 门控（standard-pack，默认 false 退出装配）
  const codeMapCfg = config.codeMap;
  if (codeMapCfg && codeMapCfg.engine !== 'disabled' && ctx.enabledPacks.codeMap) {
    const codeMapModulePath = '../code-map/index.js';
    import(codeMapModulePath)
      .then(async (mod: { CodeMapEngine: new (cwd: string, opts?: unknown) => { init: () => Promise<void> } }) => {
        const engine = new mod.CodeMapEngine(cwd, {
          engine: codeMapCfg.engine,
          budgetTokens: codeMapCfg.budgetTokens,
          enableHCGS: codeMapCfg.enableHCGS,
          enableSemanticEdges: codeMapCfg.enableSemanticEdges,
          indexExclude: codeMapCfg.indexExclude,
          maxContextSymbols: codeMapCfg.maxContextSymbols,
          autoIndex: codeMapCfg.autoIndex,
        });
        await engine.init();
        logger.info('CodeMapEngine registered', {
          engine: codeMapCfg.engine,
          budgetTokens: codeMapCfg.budgetTokens,
          autoIndex: codeMapCfg.autoIndex,
        });
      })
      .catch((err: unknown) => {
        logger.debug('CodeMapEngine not available yet, falling back to regex repo-map', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 71 Task A5：CodeMap Watcher 接线（fail-open 动态 import） =====
  // Phase 81 Task 4：packs.codeMap.enabled 门控（standard-pack，默认 false 退出装配）
  if (config.codeMap?.watchMode === true && ctx.enabledPacks.codeMap) {
    const watcherModulePath = '../code-map/watcher.js';
    import(watcherModulePath)
      .then((mod: { CodeMapWatcher: new (rootDir: string, dbPath: string) => { start: () => void; close: () => void } }) => {
        const dbPath = path.join(cwd, '.routedev', 'code-map', 'code-map.db');
        const watcher = new mod.CodeMapWatcher(cwd, dbPath);
        watcher.start();
        logger.info('CodeMapWatcher started', { rootDir: cwd, watchMode: true });

        // P0-14：注册进程退出钩子（集中式），释放 fs.watch 句柄避免泄漏
        registerShutdownHook(50, 'codemap-watcher', () => {
          try {
            watcher.close();
          } catch (e) {
            // fail-open：关闭失败不影响退出
            logger.debug('[app-init-agent] codemap-watcher close 失败', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        });
      })
      .catch((err: unknown) => {
        logger.warn('CodeMapWatcher not available, skip watch mode', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // G-F013 删除死代码：orchestrationIntegration 变量声明已移除（声明后从未被消费）
  // F-021 删除死代码：workerContextPacker 创建和 void 行已移除（WorkerExecutor 实例化已注释，无消费方）

  // Phase 53 Task 11：熔断器（fail-open 动态 import）
  const phase53BreakerCfg = config.phase53Integration?.circuitBreaker;
  if (phase53BreakerCfg?.enabled && config.packs?.multiAgent?.enabled) {
    const breakerModulePath = '../agent/circuit-breaker.js';
    import(breakerModulePath)
      .then((mod: { CircuitBreaker: new (config?: { failureThreshold?: number; resetTimeout?: number; halfOpenMaxAttempts?: number }) => import('../agent/circuit-breaker.js').CircuitBreaker }) => {
        const breaker = new mod.CircuitBreaker({
          failureThreshold: phase53BreakerCfg.failureThreshold,
          resetTimeout: phase53BreakerCfg.resetTimeout,
          halfOpenMaxAttempts: phase53BreakerCfg.halfOpenMaxAttempts,
        });
        // setCircuitBreaker 已在 SubAgentLifecycle 声明；保留 typeof 守卫兼容装配顺序
        if (delegationLifecycle && typeof delegationLifecycle.setCircuitBreaker === 'function') {
          delegationLifecycle.setCircuitBreaker(breaker);
        }
        logger.debug('CircuitBreaker injected', {
          via: 'setCircuitBreaker',
          failureThreshold: phase53BreakerCfg.failureThreshold,
          targets: {
            workerExecutor: false,
            delegationLifecycle: !!delegationLifecycle && typeof delegationLifecycle.setCircuitBreaker === 'function',
          },
        });
      })
      .catch((err) => { logger.warn('CircuitBreaker fail-open', { error: err instanceof Error ? err.message : String(err) }); });
  }

  // ===== 目标解析与验证（无状态） =====
  // Phase 58：实例化 PathRouter（统一路径路由器，App.tsx 传给 createGoalRunner）
  const pathRouter = new PathRouter();
  // Phase 53 Task 10：DAG 引擎（fail-open 动态 import）
  const dagEngineRef: { current: DagEngine | null } = { current: null };
  const phase53DagCfg = config.phase53Integration?.dagEngine;
  if (phase53DagCfg?.enabled && ctx.enabledPacks.goalAdvanced) {
    const dagEngineModulePath = '../agent/workflow/dag-engine.js';
    import(dagEngineModulePath)
      .then((mod: { DagEngine: new (opts?: { maxParallel?: number; retryLimit?: number; humanEscalationThreshold?: number }) => DagEngine }) => {
        const engine = new mod.DagEngine({
          maxParallel: phase53DagCfg.maxParallel,
          retryLimit: phase53DagCfg.retryLimit,
          humanEscalationThreshold: phase53DagCfg.humanEscalationThreshold,
        });
        dagEngineRef.current = engine;
      })
      .catch((err) => { logger.warn('DagEngine fail-open', { error: err instanceof Error ? err.message : String(err) }); });
  }

  // ===== Phase 50 Task 1：Goal 流程核心模块（按 config.goalIntegration 渐进接入） =====
  const goalIntegrationCfg = config.goalIntegration;
  const goalAuditor = goalIntegrationCfg?.auditEnabled ? new GoalAuditor() : null;
  const goalPersistence = goalIntegrationCfg?.persistenceEnabled ? new GoalPersistence(cwd) : null;
  if (goalIntegrationCfg && (goalAuditor || goalPersistence)) {
    logger.info('Phase 50: goalIntegration modules wired', {
      auditor: !!goalAuditor,
      persistence: !!goalPersistence,
    });
  }

  // 3. CompletionGate——独立代码验证门（typecheck/lint/tests）
  const safetyCfg = config.optimization?.safety;
  const completionGate = createCompletionGate({
    gateTimeout: safetyCfg?.gateTimeout ?? 180000,
    gateRetry: safetyCfg?.gateRetry ?? 1,
  });

  // 5. TaskOrchestrator——统一工作流编排器
  // F-053 类型安全：入口非空校验，避免 as 强制断言掩盖依赖缺失
  if (!classifier || !modelRouter || !tracker) {
    throw new Error('classifier/modelRouter/tracker 未注入，无法创建 Agent 子系统');
  }
  // G-F035 修复：受 config.packs.goalAdvanced.enabled 门控
  const taskOrchestrator = ctx.enabledPacks.goalAdvanced
    ? createTaskOrchestrator(
        classifier,
        modelRouter,
        config,
      )
    : undefined;

  // C5 修复：接线 Steering Queue 消费者（taskOrchestrator 可能为 undefined，需空值守卫）
  agentLoop!.setSteeringConsumer(() => {
    if (!taskOrchestrator || !taskOrchestrator.hasSteering()) return null;
    const drained = taskOrchestrator.drainSteering();
    if (drained.length === 0) return null;
    return drained.map((m) => ({ content: m.content, mode: m.mode }));
  });

  // 6. UnifiedReviewer——依赖 agentLoop + tracker
  const sharedSystemPromptRef = { current: '' };
  const unifiedReviewer = createUnifiedReviewer({
    agentLoop: agentLoop!,
    tracker: tracker,
    config,
    systemPromptRef: sharedSystemPromptRef,
    addSystemMessage: () => {},
  });

  // ===== Phase 43：CodeMapFallback 检测（fail-open 动态 import） =====
  // Phase 81 Task 4：packs.codeMap.enabled 门控（standard-pack，默认 false 退出装配）
  if (ctx.enabledPacks.codeMap) {
    import('../code-map/fallback.js')
    .then(async (mod) => {
      const preferred = config.codeMap?.engine ?? 'tree-sitter';
      const resolved = await mod.CodeMapFallback.resolveEngine(preferred);
      if (resolved !== preferred) {
        logger.warn(mod.CodeMapFallback.getFallbackMessage(`configured=${preferred}, resolved=${resolved}`));
      }
      logger.info('CodeMapFallback resolved', { preferred, resolved });
    })
    .catch((err: unknown) => {
      logger.debug('CodeMapFallback not available', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ===== Phase 44：消息节点持久化 / 分支联动 接线（fail-open 动态 import） =====
  // Phase 96 P0-1 修复：删除 BranchPersistence 假消费链
  // 原代码调用 persistence.init()，但 BranchPersistence 类无 init() 方法，且实例未传递给任何消费方
  // BranchPersistence 数据模型（BranchNode 树）与 conversationHistory（线性 LLMMessage[]）不匹配
  // 线性对话历史的重启恢复改由 ConversationPersistence 承担（在 chat-bridge 接入）
  // BranchPersistence 留待未来 BranchManager 接入时再启用
  // F-019 删除死代码：BranchLinkageManager 创建块已移除（无消费方）
  // 3. ExperimentManager 单例：在同步作用域创建，确保 /experiment 命令与 engine-bridge 复用同一实例
  const experimentManager = new ExperimentManager(cwd);


 // ===== Phase 50 Task 5：Phase 48 模块接入确认（全部 fail-open 动态 import） =====
  // Phase 81 Task 4：packs.integrity.enabled 门控（standard-pack，默认 false 退出装配）
  //   覆盖：IntegrityManifest / Cite / Import / Macros / MCPBridge
  const phase48Cfg = config.phase48Integration;
  const integrityPackEnabled = ctx.enabledPacks.integrity;

  // 依赖完整性校验清单实例化（受 config.security.integrityCheck 守护）
  let integrityManifest: IntegrityManifest | undefined;
  let integrityManifestLoadPromise: Promise<void> | undefined;
  if (config.security?.integrityCheck && integrityPackEnabled) {
    const manifestPath = path.resolve(cwd, config.security.integrityManifestPath);
    integrityManifest = new IntegrityManifest(manifestPath);
    integrityManifestLoadPromise = integrityManifest.load().catch((err: unknown) => {
      logger.warn('IntegrityManifest load failed', {
        path: manifestPath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  if (phase48Cfg?.citeEnabled && config.cite?.enabled && integrityPackEnabled) {
    // CiteManager + CiteResolver 接入
    Promise.all([
      import('../cite/manager.js'),
      import('../cite/resolver.js'),
    ])
      .then(([managerMod, resolverMod]) => {
        const maxTags = config.cite?.maxTags ?? 10;
        const citeManager = new managerMod.CiteManager(maxTags);
        agentLoop!.setCiteManager(citeManager);
        const citeResolver = new resolverMod.CiteResolver({
          config: config.cite,
          deps: {
            readSkillOrMacro: async (name: string, kind?: 'skill' | 'macro') => {
              try {
                const dir = kind === 'macro' ? 'macros' : 'skills';
                const file = path.join(cwd, '.routedev', dir, `${name}.md`);
                return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
              } catch (e) {
                // 读取失败（ENOENT 或权限问题），返回 null
                logger.debug('[app-init-agent] citeResolver readSkillOrMacro 失败', {
                  name,
                  kind,
                  error: e instanceof Error ? e.message : String(e),
                });
                return null;
              }
            },
          },
        });
        agentLoop!.setCiteResolver(citeResolver);
        logger.info('Phase 48 cite manager + resolver integrated', { enabled: true, maxTags });
      })
      .catch((err: unknown) => {
        logger.debug('CiteManager/Resolver not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (phase48Cfg?.importEnabled && config.import && integrityPackEnabled) {
    // 外部生态导入接入：ClaudePluginImporter / CodexInstructionImporter / AnthropicSkillsLoader
    Promise.all([
      import('../import/claude-plugin-importer.js'),
      import('../import/codex-importer.js'),
      import('../import/anthropic-skills-loader.js'),
    ])
      .then(async ([pluginMod, codexMod, anthropicMod]) => {
        if (integrityManifestLoadPromise) await integrityManifestLoadPromise;

        // ClaudePluginImporter：扫描 .claude-plugin/ 目录
        const pluginImporter = new pluginMod.ClaudePluginImporter(integrityManifest);
        const claudePluginDir = path.join(cwd, '.claude-plugin');
        const existsSync = fs.existsSync;
        if (existsSync(claudePluginDir)) {
          try {
            const result = await pluginImporter.importFromPath(cwd, {
              autoEnable: true,
              outputRoot: path.join(cwd, '.routedev'),
            });
            logger.info('Claude plugin imported', {
              skills: result.skills.length,
              agents: result.agents.length,
              hooks: result.hooks.length,
              warnings: result.warnings.length,
            });
          } catch (e: unknown) {
            logger.warn('ClaudePluginImporter import failed', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        // CodexInstructionImporter：扫描 .codex/ 目录
        const codexImporter = new codexMod.CodexInstructionImporter();
        try {
          const scanResult = await codexImporter.scan(cwd);
          if (scanResult.found) {
            const importResult = await codexImporter.import({
              projectRoot: cwd,
              mode: 'system_prompt',
            });
            if (importResult.systemPromptContent) {
              sharedSystemPromptRef.current = `${sharedSystemPromptRef.current}\n\n--- Codex Instructions ---\n${importResult.systemPromptContent}`.trim();
              logger.info('Codex instructions integrated into system prompt', {
                files: importResult.importedFiles.length,
                bytes: importResult.totalBytes,
              });
            }
          }
        } catch (e: unknown) {
          logger.debug('CodexInstructionImporter import failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        // AnthropicSkillsLoader：扫描 anthropic_skills/ 目录
        const anthropicSkillsDir = path.join(cwd, anthropicMod.AnthropicSkillsLoader.SKILLS_DIR_NAME);
        if (existsSync(anthropicSkillsDir)) {
          try {
            const anthropicLoader = new anthropicMod.AnthropicSkillsLoader(integrityManifest);
            const autoEnable = config.import?.anthropicSkillsAutoEnable ?? false;
            const loadResult = await anthropicLoader.load(cwd, { autoEnable });
            logger.info('Anthropic skills loaded', {
              loaded: loadResult.loaded.length,
              errors: loadResult.errors.length,
            });
          } catch (e: unknown) {
            logger.warn('AnthropicSkillsLoader load failed', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        logger.info('Phase 48 import module integrated', { enabled: true });
      })
      .catch((err: unknown) => {
        logger.debug('Import module not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (phase48Cfg?.macrosEnabled && config.macros?.enabled && integrityPackEnabled) {
    // MacroManager 接入：`!` 触发器宏系统
    import('../macros/manager.js')
      .then((mod) => {
        const macroManager = new mod.MacroManager(config.macros, cwd);
        macroManager.loadAll().catch((e: unknown) => {
          logger.debug('MacroManager loadAll failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        // setMacroManager 已在 ReActAgentLoop 声明；保留 typeof 守卫兼容装配顺序
        // agentLoop 在本装配阶段已由 createToolSubsystem 创建（类型可选以兼容装配顺序）
        if (typeof agentLoop!.setMacroManager === 'function') {
          agentLoop!.setMacroManager(macroManager);
        }
        logger.info('Phase 48 macros module integrated', { enabled: true });
      })
      .catch((err: unknown) => {
        logger.debug('MacroManager not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (phase48Cfg?.mcpBridgeEnabled && integrityPackEnabled) {
    // ClaudeMCPBridge 接入：导入 Claude Code .mcp.json 配置
    import('../mcp/claude-bridge.js')
      .then((mod) => {
        const bridge = new mod.ClaudeMCPBridge();
        const claudeConfigPath = path.join(cwd, '.mcp.json');
        bridge.importFromClaudeConfig(claudeConfigPath).then((result) => {
          if (result.servers.length > 0) {
            logger.info('ClaudeMCPBridge imported servers', { count: result.servers.length });
          }
        }).catch((e: unknown) => {
          logger.debug('ClaudeMCPBridge import failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        logger.info('Phase 48 mcp bridge module integrated', { enabled: true });
      })
      .catch((err: unknown) => {
        logger.debug('ClaudeMCPBridge not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  const phase49Cfg = config.phase49Integration;
  // Phase 55 Task 9：DualLoopOrchestrator ref（异步创建，供 goal-runner 通过 ref 延迟读取）
  const dualLoopOrchestratorRef: { current: DualLoopOrchestrator | null } = { current: null };
  if (phase49Cfg?.dualLoopEnabled && ctx.enabledPacks.goalAdvanced) {
    // 双循环编排器接入：/goal 执行时可被调用
    import('../agent/dual-loop-orchestrator.js')
      .then((mod) => {
        const orchestrator = new mod.DualLoopOrchestrator();
        dualLoopOrchestratorRef.current = orchestrator;
        // CR-1 修复：在 orchestrator 创建后立即注入 reviewerPolicy 和 boundedRecovery
        if (config.reviewerPolicy?.tieredReviewEnabled && ctx.enabledPacks.adversarial) {
          orchestrator.setReviewerPolicy(config.reviewerPolicy);
          logger.info('app-init: reviewerPolicy 已注入 DualLoopOrchestrator', {
            tieredReviewEnabled: true,
          });
        }
        if (config.phase52Integration?.boundedRecovery?.enabled && ctx.enabledPacks.goalAdvanced) {
          orchestrator.setBoundedRecovery(config.phase52Integration.boundedRecovery);
          logger.info('app-init: boundedRecovery 已注入 DualLoopOrchestrator', {
            maxBacktrack: config.phase52Integration.boundedRecovery.maxBacktrack,
          });
        }
        // Phase 55 Task 8：注入 innerAgent（独立 ReActAgentLoop 实例，避免无限递归）
        const innerAgentLoop = new ReActAgentLoop(guardedAdapter!, {
          maxIterations: 50,
          toolsEnabled: true,
          autoApprovePatterns: config.autonomy?.autoApprovePatterns ?? [],
        });
        innerAgentLoop.setTraceCollector(trace!);
        // DualLoop 内部 Agent 共享压缩器，防止内部循环 messages 膨胀
        innerAgentLoop.setCompactor(ctx.contextManager ?? null);
        orchestrator.setInnerAgent(innerAgentLoop);
        agentLoop!.setDualLoopOrchestrator(orchestrator);
        logger.info('Phase 49 DualLoopOrchestrator integrated', { enabled: true, innerAgent: true });
      })
      .catch((err: unknown) => {
        logger.debug('DualLoopOrchestrator not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 52 模块接入（全部由 config.phase52Integration 开关守护） =====

  // Task 1：Skill 生命周期管理——已提前至 delegationDeps 装配前创建

  // Phase 53 Task 6：SkillSecurityGate 注入（fail-open 动态 import）
  // G-F018 修复：受 config.packs.skillLifecycle.enabled 门控
  const phase53SkillGateCfg = config.phase53Integration?.skillSecurityGate;
  if (phase53SkillGateCfg?.enabled && config.packs?.skillLifecycle?.enabled) {
    import('../skills/security-gate.js')
      .then((mod) => {
        const gate = new mod.SkillSecurityGate({
          autoInstallThreshold: phase53SkillGateCfg.autoInstallThreshold,
        });
        if (skillLifecycleManager) {
          skillLifecycleManager.setSecurityGate(gate);
          logger.debug('SkillSecurityGate injected', { via: 'setSecurityGate' });
        } else {
          logger.info('SkillSecurityGate instantiated but no consumer wired (skillLifecycleManager disabled)');
        }
      })
      .catch((err: unknown) => {
        logger.debug('SkillSecurityGate not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // Task 3：有界局部恢复——已在 Phase 49 块中通过 DualLoopOrchestrator.setBoundedRecovery 接入
  if (config.phase52Integration?.boundedRecovery?.enabled && ctx.enabledPacks.goalAdvanced) {
    logger.info('app-init: boundedRecovery 配置已确认，将在 Phase 49 DualLoopOrchestrator 创建时注入');
  }

  // Phase 51 Task 1/7：Reviewer 分级策略——已在 Phase 49 块中通过 DualLoopOrchestrator.setReviewerPolicy 接入

  const p70Cfg = ctx.p70Cfg;
  if (p70Cfg && (
    ctx.p70ToolOutputBudgetManager || ctx.p70MessageGrouper || ctx.p70ActionChainDetector ||
    ctx.p70AutoCompactGuardian || ctx.p70CompactPromptEngine || ctx.p70SessionMemoryStore
  )) {
    logger.info('Phase 70: Context compaction modules enabled', {
      toolOutputBudgetManager: !!ctx.p70ToolOutputBudgetManager,
      messageGrouper: !!ctx.p70MessageGrouper,
      actionChainDetector: !!ctx.p70ActionChainDetector,
      autoCompactGuardian: !!ctx.p70AutoCompactGuardian,
      compactPromptEngine: !!ctx.p70CompactPromptEngine,
      compactPromptDirection: p70Cfg?.compactPrompt?.defaultDirection,
      sessionMemoryStore: !!ctx.p70SessionMemoryStore,
      sessionMemoryPersistPath: ctx.p70SessionMemoryPersistentPath,
      sessionMemoryMaxMemories: p70Cfg?.sessionMemory?.maxMemories,
    });
  }

  // ===== Phase 77：冷启动恢复检测（fail-open，不阻塞应用启动） =====
  if (goalPersistence) {
    detectResumableGoalsOnStartup(goalPersistence)
      .then(detected => {
        if (detected.length > 0) {
          logger.info('Phase77: detected resumable goals', { count: detected.length });
        }
      })
      .catch((err: unknown) => {
        logger.warn('Phase77: goal recovery detection failed (fail-open)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 优先级 80：高于 codemap-watcher(50)/analytics-flush(10)，低于 session-memory(100)
  if (goalPersistence) {
    registerShutdownHook(80, 'goal-state-persist', async () => {
      try {
        const resumable = await goalPersistence.listResumable();
        for (const goal of resumable) {
          if (goal.status === 'executing') {
            goal.updatedAt = Date.now();
            await goalPersistence.save(goal);
          }
        }
      } catch (err) {
        logger.warn('Phase77: goal state persist on shutdown failed (fail-open)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  // 写回共享上下文，供门面模块或其他子系统消费
  ctx.sharedSystemPromptRef = sharedSystemPromptRef;
  ctx.taskOrchestrator = taskOrchestrator;
  ctx.unifiedReviewer = unifiedReviewer;
  ctx.completionGate = completionGate;
  ctx.pathRouter = pathRouter;
  ctx.dualLoopOrchestratorRef = dualLoopOrchestratorRef;
  ctx.dagEngineRef = dagEngineRef;
  ctx.experimentManager = experimentManager;
  ctx.goalAuditor = goalAuditor;
  ctx.goalPersistence = goalPersistence;
  ctx.skillLifecycleManager = skillLifecycleManager;
  ctx.activityStore = activityStore;

  return {
    // Phase 94 Task 3：agentLoop 创建迁移至 agent 子系统，此处作为依赖片段返回
    agentLoop,
    unifiedReviewer,
    completionGate,
    sharedSystemPromptRef,
    goalAuditor,
    goalPersistence,
    skillLifecycleManager,
    activityStore,
    pathRouter,
    dualLoopOrchestratorRef,
    dagEngineRef,
    experimentManager,
    // Phase 97 Part E：子会话注册表（供 desktop IPC 查询/停止子 Agent）
    subagentRegistry,
  };
}
