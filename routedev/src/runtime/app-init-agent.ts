// src/runtime/app-init-agent.ts
// Agent 子系统装配：Spawn Agent、Plugin、Hook、Goal、Experiment、Phase 48/49/52/53/77
// 从 app-init.ts 拆分（TD-02），保持功能完全等价
//
// 职责：
//   1. Spawn Agent（createSpawnAgentFn + 并行上限 + 委托体系包装 + SpawnAgentTool）
//   2. SkillLifecycleManager + AgentActivityStore + AgentProfileManager
//   3. Plugin 系统（createPluginSystem + LoopDetection / MentionResolver / CodeMapContext / QualitySignal / ExpertisePrompt 中间件）
//   4. CodeMap 引擎预热 + CodeMapEngine + CodeMapWatcher + CodeMapFallback
//   5. Hook 系统（HookRunner + registerBuiltinHooks + HookConfigRegistry + HookEnhancementManager）
//   6. Goal 流程（PathRouter + DagEngine + GoalAuditor + GoalPersistence + 冷启动恢复 + shutdown 持久化）
//   7. TaskOrchestrator + UnifiedReviewer + CompletionGate + Steering Queue
//   8. BranchPersistence + BranchLinkageManager
//   9. ExperimentManager + ParallelExperimentManager
//  10. Phase 48 模块（IntegrityManifest / Cite / Import / Macros / MCPBridge）
//  11. Phase 49 DualLoopOrchestrator + reviewerPolicy / boundedRecovery 注入
//  12. Phase 52 SkillSecurityGate + boundedRecovery 配置确认
//  13. Phase 53 CircuitBreaker
//  14. Phase 70 模块激活日志
//  15. Phase 77 goal 恢复 + shutdown hooks
//
// 依赖：tools 子系统（registry/agentLoop/toolExecutor/...）、memory 子系统（contextManager/recallInjector/...）、
//       observability 子系统（trace/audit）、router 子系统（primaryClient/clientManager/classifier/modelRouter/tracker）

import type { ClassificationResult, RoutingResult, ScenarioTier } from '../router/types.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import type { OrchestrationIntegrationOptions } from '../agent/multi/orchestrator.js';
import type { DualLoopOrchestrator } from '../agent/dual-loop-orchestrator.js';
import type { DagEngine } from '../agent/workflow/dag-engine.js';
import type {
  SpawnAgentFunction,
  SpawnAgentParams,
  SubagentType,
  DelegationIntegrationDeps,
} from '../tools/builtin/spawn-agent.js';

import { createPluginSystem } from './plugin-init.js';
import { LoopDetectionMiddleware } from '../agent/middleware/loop-detection.js';
import { MentionResolverMiddleware } from '../agent/middleware/mention-resolver.js';
// TD-04：PermissionEngine 接入 Agent Loop 的 onActing 中间件
import { PermissionMiddleware } from '../agent/middleware/permission-middleware.js';
import { HookRunner } from '../agent/hooks.js';
import { registerBuiltinHooks } from '../hooks/built-in.js';
import { HookEnhancementManager } from '../hooks/hook-enhancement.js';
import { getHookTemplates } from '../hooks/templates.js';
// F-001 修复：Hook 路径越界校验 + 命令安全扫描（共享模块）
import { resolveHookConfigPath, assertHookCommandSafe } from '../hooks/security.js';
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
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistryAdapter } from '../tools/adapter.js';
import { GuardedToolExecutorAdapter } from '../agent/work-modes.js';
import { registerShutdownHook } from './graceful-shutdown.js';
import { logger } from '../utils/logger.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { InitContext, AppDependencies } from './app-init.js';
// F-075：常量提取到 utils/constants.ts
import { TOOL_EXECUTION_TIMEOUT_MS } from '../utils/constants.js';

/**
 * 创建 Agent 子系统
 * 包含：Spawn Agent、Plugin、Hook、Goal、Experiment、Phase 48/49/52/53/77 全部接线
 *
 * @param ctx 共享装配上下文（读取 tools/memory/observability/router 子系统的产出，写入 hookRunner/unifiedReviewer/...）
 * @returns Agent 子系统依赖片段
 */
export function createAgentSubsystem(ctx: InitContext): Partial<AppDependencies> {
  const {
    config,
    cwd,
    trace,
    audit,
    currentModel,
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
    permissionEngine,
    agentLoop,
  } = ctx;

  // ===== P1-6：子 Agent 生成工具（需注入 spawnAgent 函数，依赖 agentLoop 和 primaryClient） =====
  // Phase 38 Task 2：防递归增强 + 并行上限
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
  if (config.phase52Integration?.skillLifecycle?.enabled) {
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
    // P0-14：注册 shutdown 钩子，进程退出前清除定时器
    registerShutdownHook(60, 'skill-lifecycle-cleanup-timer', () => {
      clearInterval(cleanupTimer);
    });
  }

  /**
   * 创建子 Agent 的 spawn 函数
   * Phase 38 Task 2：使用 childRegistry 隔离工具集，不再修改共享 registry
   * Phase 48 Task 4：接入 AgentProfileManager
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
        // Phase 75-A3：model 选择优先级
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
          // F-051 类型安全：过滤 undefined 后再断言，避免 process.env 中 undefined 值混入
          environment: Object.fromEntries(
            Object.entries({ ...process.env, ...webSearchEnv! }).filter(([, v]) => v !== undefined),
          ) as Record<string, string>,
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

        const childSystemPrompt = profile?.systemPrompt
          ?? options?.systemPrompt
          ?? '你是一个专注的子 Agent，负责完成分配给你的独立子任务。';

        // P0-4：renderedSystemPrompt 优先级最高
        const effectiveSystemPrompt = options?.renderedSystemPrompt ?? childSystemPrompt;
        const effectiveHistory = options?.forkedConversationHistory ?? [];

        // Phase 79 Task 5：子 Agent 工具确认委托父会话
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
        return {
          success: true,
          result: responseText,
          tokenUsage: { inputTokens, outputTokens },
        };
      } catch (err) {
        return {
          success: false,
          result: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
  };

  // Phase 38 Task 2 / Phase 50 Task 3：spawn 函数包装 + SpawnAgentTool 注册
  // Phase 81 Task 4：packs.multiAgent.enabled 门控（extended-pack，默认 false 退出装配）
  //   注：工具注册逻辑（registry.register）属于装配层，非 app-init-tools.ts 的静态注册段
  const subAgentsCfg = config.subAgents;
  const subAgentsEnabled = subAgentsCfg?.enabled !== false && config.packs?.multiAgent?.enabled === true;
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

  // ===== 插件系统 =====
  const pluginSystem = createPluginSystem(cwd, registry!);
  // 将插件系统的中间件管线注入 Agent Loop
  agentLoop!.setMiddlewarePipeline(pluginSystem.middlewarePipeline);

  // Phase 38 Task 1：注册 LoopDetectionMiddleware 到 onReasoning 阶段
  const loopDetectionCfg = config.middleware?.loopDetection;
  if (loopDetectionCfg?.enabled !== false) {
    const loopDetection = new LoopDetectionMiddleware({
      windowSize: loopDetectionCfg?.windowSize,
      maxRepeats: loopDetectionCfg?.maxRepeats,
    });
    pluginSystem.middlewarePipeline.register('onReasoning', loopDetection.getHandler());
    logger.info('LoopDetectionMiddleware registered', {
      windowSize: loopDetectionCfg?.windowSize ?? 10,
      maxRepeats: loopDetectionCfg?.maxRepeats ?? 3,
    });
  }

  // Phase 71 Task B2：注册 MentionResolverMiddleware 到 onUserMessage 阶段
  const mentionResolver = new MentionResolverMiddleware(cwd);
  pluginSystem.middlewarePipeline.register('onUserMessage', mentionResolver.getHandler());
  logger.info('MentionResolverMiddleware registered', { cwd });

  // TD-04：注册 PermissionMiddleware 到 onActing 阶段
  // 让 PermissionEngine.check() 在工具执行前被实际调用，把三层决策（deny/confirm/auto）
  // 转换为 ctx.metadata.permissionDenied / requiresConfirmation 标记，
  // loop.ts 已有 fail-closed 分支消费 permissionDenied。
  // 注册顺序：在 QualitySignalMiddleware 之前（同步注册，避免动态 import 导致的延迟挂载），
  // 保证权限拦截优先于质量信号采集。
  if (permissionEngine) {
    const autonomyMode = config.autonomy?.defaultMode ?? 'semi';
    const permissionMiddleware = new PermissionMiddleware(permissionEngine, autonomyMode);
    pluginSystem.middlewarePipeline.register('onActing', permissionMiddleware.getHandler());
    logger.info('PermissionMiddleware registered', {
      autonomyMode,
      sandboxLevel: permissionEngine.getSandboxLevel(),
    });
  } else {
    logger.warn('PermissionMiddleware skipped: permissionEngine not available');
  }

  // ===== Phase 39：CodeMapContextMiddleware 接线（fail-open 动态 import） =====
  // Phase 81 Task 4：packs.codeMap.enabled 门控（standard-pack，默认 false 退出装配）
  const codegraphCfg = config.codegraph;
  if (codegraphCfg && config.packs?.codeMap?.enabled) {
    const codeMapModulePath = '../agent/middleware/code-map-context.js';
    import(codeMapModulePath)
      .then((mod: { CodeMapContextMiddleware: new (cwd: string, budgetTokens?: number) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }) => {
        const budgetTokens = config.codeMap?.budgetTokens ?? 2048;
        const codeMapMiddleware = new mod.CodeMapContextMiddleware(cwd, budgetTokens);
        pluginSystem.middlewarePipeline.register('onSystemPrompt', codeMapMiddleware.getHandler());
        logger.info('CodeMapContextMiddleware registered', {
          budgetTokens,
          enabled: codegraphCfg.enabled,
        });
      })
      .catch((err: unknown) => {
        logger.debug('CodeMapContextMiddleware not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 41/42：tree-sitter 代码地图引擎预热（fail-open） =====
  // Phase 81 Task 4：packs.codeMap.enabled 门控（standard-pack，默认 false 退出装配）
  if (config.packs?.codeMap?.enabled) {
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

  // ===== Phase 39：ExperimentManager 配置传递 =====
  const experimentsCfg = config.experiments;
  if (experimentsCfg) {
    logger.info('Experiments config loaded', {
      maxActiveWorktrees: experimentsCfg.maxActiveWorktrees,
      autoCleanup: experimentsCfg.autoCleanup,
    });
  }

  // ===== Phase 40：渐进式信任 / 质量监测 / 用户经验 接线（全部 fail-open 动态 import） =====
  // Phase 81 Task 3：freeze 层 F-01/F-02/F-06 退出默认装配
  //   三个模块同属 Phase 40 freeze 组，统一由 config.packs.trustGradient.enabled 门控
  //   默认 false → 不装配；用户显式 enabled:true 可恢复全部三个模块的装配

  // 4.1 TrustGradientManager 接线
  // Phase 79: TrustGradient Freeze — 仅静态档位配置 + 用户显式临时授权，不做会话内动态升级
  //   setLevel(baseLevel) 一次设定后不再动态调整；PermissionEngine.check() 已旁路 level-based 动态决策
  // Phase 81 Task 3：packs.trustGradient.enabled 门控（freeze 层 F-01）
  const trustCfg = config.trust;
  if (trustCfg && config.packs?.trustGradient?.enabled) {
    const trustModulePath = '../tools/trust-gradient.js';
    import(trustModulePath)
      .then((mod: { TrustGradientManager: new (sessionId: string, level?: string) => import('../tools/trust-gradient.js').TrustGradientManager }) => {
        const sessionId = trace!.getSessionId() ?? `app-${Date.now()}`;
        const trustManager = new mod.TrustGradientManager(sessionId, trustCfg.baseLevel);
        trustManager.setLevel(trustCfg.baseLevel);
        // setTrustGradientManager 已在 PermissionEngine 声明；保留 typeof 守卫兼容装配顺序
        if (typeof permissionEngine!.setTrustGradientManager === 'function') {
          permissionEngine!.setTrustGradientManager(trustManager);
        }
        logger.info('TrustGradientManager registered', {
          baseLevel: trustCfg.baseLevel,
          enableTemporaryGrants: trustCfg.enableTemporaryGrants,
          grantTTLMinutes: trustCfg.grantTTLMinutes,
        });
      })
      .catch((err: unknown) => {
        logger.debug('TrustGradientManager not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 4.2 QualitySignalMiddleware 接线（Implicit Feedback，freeze 层 F-02）
  // Phase 81 Task 3：packs.trustGradient.enabled 门控 + enableImplicitFeedback 默认 false
  const qualityCfg = config.quality;
  if (qualityCfg?.enableImplicitFeedback !== false && config.packs?.trustGradient?.enabled) {
    const qualityModulePath = '../agent/middleware/quality-signal.js';
    import(qualityModulePath)
      .then((mod: { QualitySignalMiddleware: new (opts?: unknown) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }) => {
        const qualityMiddleware = new mod.QualitySignalMiddleware({
          negativeSignalThreshold: qualityCfg.negativeSignalThreshold,
          signalRetentionDays: qualityCfg.signalRetentionDays,
          autoImproveKnowledgeGraph: qualityCfg.autoImproveKnowledgeGraph,
          debounceMs: qualityCfg.debounceMs,
        });
        pluginSystem.middlewarePipeline.register('onActing', qualityMiddleware.getHandler());
        logger.info('QualitySignalMiddleware registered', {
          negativeSignalThreshold: qualityCfg.negativeSignalThreshold,
          signalRetentionDays: qualityCfg.signalRetentionDays,
        });
      })
      .catch((err: unknown) => {
        logger.debug('QualitySignalMiddleware not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 4.3 ExpertisePromptMiddleware 接线（Experience Adaptation，freeze 层 F-06）
  // Phase 81 Task 3：packs.trustGradient.enabled 门控
  const expertiseCfg = config.expertise;
  if (expertiseCfg && config.packs?.trustGradient?.enabled) {
    const expertiseManagerPath = '../config/expertise-manager.js';
    const expertiseMiddlewarePath = '../agent/middleware/expertise-prompt.js';
    Promise.all([
      import(expertiseManagerPath),
      import(expertiseMiddlewarePath),
    ])
      .then(async ([mgrMod, mwMod]: [unknown, unknown]) => {
        const ManagerCtor = (mgrMod as { ExpertiseManager: new (p: string) => { load: () => Promise<void> } }).ExpertiseManager;
        const MiddlewareCtor = (mwMod as { ExpertisePromptMiddleware: new (m: unknown) => { getHandler: () => import('../agent/middleware.js').MiddlewareHandler } }).ExpertisePromptMiddleware;
        const expertiseManager = new ManagerCtor(path.join(cwd, '.routedev', 'expertise.json'));
        await expertiseManager.load();
        const expertiseMiddleware = new MiddlewareCtor(expertiseManager);
        pluginSystem.middlewarePipeline.register('onSystemPrompt', expertiseMiddleware.getHandler());
        logger.info('ExpertisePromptMiddleware registered', {
          level: expertiseCfg.level,
          enableAutoSuggestion: expertiseCfg.enableAutoSuggestion,
        });
      })
      .catch((err: unknown) => {
        logger.debug('ExpertisePromptMiddleware not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== Phase 41：CodeMapEngine 接线（fail-open 动态 import） =====
  // Phase 81 Task 4：packs.codeMap.enabled 门控（standard-pack，默认 false 退出装配）
  const codeMapCfg = config.codeMap;
  if (codeMapCfg && codeMapCfg.engine !== 'disabled' && config.packs?.codeMap?.enabled) {
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
  if (config.codeMap?.watchMode === true && config.packs?.codeMap?.enabled) {
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

  // ===== 多 Agent：orchestrationIntegration 开关 =====
  // Phase 81 Task 4：packs.multiAgent.enabled 门控（extended-pack，默认 false 退出装配）
  const orchestrationIntegrationCfg = config.orchestrationIntegration;
  const orchestrationIntegration: OrchestrationIntegrationOptions | undefined = (
    config.packs?.multiAgent?.enabled &&
    (orchestrationIntegrationCfg?.strategyEnabled ||
    orchestrationIntegrationCfg?.stateGraphEnabled)
  )
    ? {
        strategyEnabled: orchestrationIntegrationCfg?.strategyEnabled,
        stateGraphEnabled: orchestrationIntegrationCfg?.stateGraphEnabled,
        // Phase 83 Task 2：conflict detector 冻结——默认 false，由 config 显式开启
        conflictDetectionEnabled: orchestrationIntegrationCfg?.conflictDetectionEnabled === true,
      }
    : undefined;
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
  if (phase53DagCfg?.enabled && config.packs?.goalAdvanced?.enabled) {
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

  // ===== Phase 35 Task 2：HookRunner 创建 + 注册内置钩子 =====
  const hookRunner = new HookRunner();
  hookRunner.setTraceCollector(trace!);
  registerBuiltinHooks(hookRunner, audit!, cwd, currentModel);
  // C6 修复：将 HookRunner 注入 agentLoop
  agentLoop!.setHookRunner(hookRunner);

  // ===== Phase 39：HookConfigRegistry → HookRunner 接线（fail-open 动态 import） =====
  const hooksCfg = config.hooks;
  if (hooksCfg?.enabled !== false) {
    const registryModulePath = '../hooks/registry.js';
    import(registryModulePath)
      .then(async (mod: { HookConfigRegistry: new (configPath: string) => { load: () => Promise<void>; list: () => Array<{ id: string; enabled: boolean; [key: string]: unknown }>; get: (id: string) => { id: string; enabled: boolean; [key: string]: unknown } | undefined; add: (config: { id: string; enabled: boolean; [key: string]: unknown }) => void } }) => {
        // F-001 修复：路径越界校验（拒绝绝对路径和穿越 cwd 的相对路径）
        const configPath = resolveHookConfigPath(cwd, hooksCfg.configPath);
        if (!configPath) {
          logger.warn('hooks.configPath 越界，跳过 Hook 加载', { configPath: hooksCfg.configPath });
          return;
        }
        const hookRegistry = new mod.HookConfigRegistry(configPath);
        await hookRegistry.load();

        // 注册内置 Hook 模板到 HookConfigRegistry
        const templates = getHookTemplates();
        let templatesAdded = 0;
        for (const template of templates) {
          if (hookRegistry.get(template.id)) continue;
          hookRegistry.add({
            id: template.id,
            name: template.name,
            event: template.event,
            enabled: false,
            condition: template.condition,
            command: template.code,
            failBehavior: template.failBehavior,
            isTemplate: true,
            priority: template.priority,
          });
          templatesAdded++;
        }
        if (templatesAdded > 0) {
          logger.info('Hook 模板已注册到 Registry', { count: templatesAdded });
        }

        const configs = hookRegistry.list();
        let registered = 0;
        for (const cfg of configs) {
          if (cfg.enabled === false) continue;
          // F-001 修复：注册前对 Hook 命令执行安全扫描，拒绝危险命令
          const cmd = typeof cfg.command === 'string' ? cfg.command : '';
          if (cmd) {
            const safety = assertHookCommandSafe(cmd);
            if (!safety.ok) {
              logger.warn('Hook 命令被安全策略拒绝，跳过注册', {
                hookId: cfg.id,
                reason: safety.reason,
              });
              continue;
            }
          }
          try {
            const adapterModulePath = '../hooks/adapter.js';
            const adapterMod = await import(adapterModulePath) as { configToDefinition: (cfg: unknown) => import('../agent/hooks.js').HookDefinition };
            const def = adapterMod.configToDefinition(cfg);
            hookRunner.register(def);
            registered++;
          } catch (err) {
            logger.warn('Hook 注册失败，跳过', {
              hookId: cfg.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        logger.info('HookConfigRegistry 接线完成', {
          configPath: hooksCfg.configPath,
          total: configs.length,
          registered,
        });
      })
      .catch((err: unknown) => {
        logger.debug('HookConfigRegistry not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // Phase 43：Hook 增强配置接入
 const hookEnhancementCfg = config.hookEnhancement;
 // 注册命令安全审查钩子：对 shell_exec / git_op 的命令参数进行危险模式检测
  hookRunner.register({
    event: 'post-tool-call',
    name: 'builtin:command-safety-review',
    priority: 40,
    handler: async (hookCtx) => {
      const toolName = hookCtx.toolName;
      const command = hookCtx.toolArgs?.command as string | undefined;
      if (!command || (toolName !== 'shell_exec' && toolName !== 'git_op')) {
        return { action: 'continue' };
      }
      const { safe, risks } = HookEnhancementManager.analyzeCommand(command);
      if (!safe) {
        return {
          action: 'warn',
          message: `⚠️ 命令安全警告: ${risks.join('; ')}`,
        };
      }
      return { action: 'continue' };
    },
  });
  logger.info('HookEnhancementManager registered', {
    functionHooks: hookEnhancementCfg?.functionHooks,
    sandbox: hookEnhancementCfg?.sandbox,
    trialDays: hookEnhancementCfg?.trialDays,
    hookGroups: hookEnhancementCfg?.hookGroups,
  });
 // ===== Phase 32 Task 1：Phase 31 模块实例化 =====

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
  const taskOrchestrator = createTaskOrchestrator(
    classifier,
    modelRouter,
    config,
  );

  // C5 修复：接线 Steering Queue 消费者
  agentLoop!.setSteeringConsumer(() => {
    if (!taskOrchestrator.hasSteering()) return null;
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
  if (config.packs?.codeMap?.enabled) {
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

  // 1. BranchPersistence 接线：消息树 JSONL 持久化 + 备份 + 快照
  const conversationCfg = config.conversation;
  if (conversationCfg?.persistTree !== false) {
    const branchPersistencePath = '../agent/branch-persistence.js';
    import(branchPersistencePath)
      .then((mod: { BranchPersistence: new (cwd: string, opts?: unknown) => { init: () => Promise<void> } }) => {
        const persistence = new mod.BranchPersistence(cwd, {
          maxNodes: conversationCfg.maxNodes,
          maxBranches: conversationCfg.maxBranches,
          undoStackSize: conversationCfg.undoStackSize,
        });
        persistence.init().catch((e: unknown) => {
          logger.debug('BranchPersistence init failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        logger.info('BranchPersistence registered', {
          persistTree: conversationCfg.persistTree,
          maxNodes: conversationCfg.maxNodes,
        });
      })
      .catch((err: unknown) => {
        logger.debug('BranchPersistence not available yet', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // 2. F-019 删除死代码：BranchLinkageManager 创建块已移除（无消费方）
  // 3. ExperimentManager 单例：在同步作用域创建，确保 /experiment 命令与 engine-bridge 复用同一实例
  const experimentManager = new ExperimentManager(cwd);


 // ===== Phase 50 Task 5：Phase 48 模块接入确认（全部 fail-open 动态 import） =====
  // Phase 81 Task 4：packs.integrity.enabled 门控（standard-pack，默认 false 退出装配）
  //   覆盖：IntegrityManifest / Cite / Import / Macros / MCPBridge
  const phase48Cfg = config.phase48Integration;
  const integrityPackEnabled = config.packs?.integrity?.enabled === true;

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

  // ===== Phase 50 Task 6：Phase 49 模块接入确认 =====
  const phase49Cfg = config.phase49Integration;
  // Phase 55 Task 9：DualLoopOrchestrator ref（异步创建，供 goal-runner 通过 ref 延迟读取）
  const dualLoopOrchestratorRef: { current: DualLoopOrchestrator | null } = { current: null };
  if (phase49Cfg?.dualLoopEnabled && config.packs?.goalAdvanced?.enabled) {
    // 双循环编排器接入：/goal 执行时可被调用
    import('../agent/dual-loop-orchestrator.js')
      .then((mod) => {
        const orchestrator = new mod.DualLoopOrchestrator();
        // Phase 55 Task 9：立即写入 ref
        dualLoopOrchestratorRef.current = orchestrator;
        // CR-1 修复：在 orchestrator 创建后立即注入 reviewerPolicy 和 boundedRecovery
        if (config.reviewerPolicy?.tieredReviewEnabled && config.packs?.adversarial?.enabled) {
          orchestrator.setReviewerPolicy(config.reviewerPolicy);
          logger.info('app-init: reviewerPolicy 已注入 DualLoopOrchestrator', {
            tieredReviewEnabled: true,
          });
        }
        if (config.phase52Integration?.boundedRecovery?.enabled && config.packs?.goalAdvanced?.enabled) {
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
        orchestrator.setInnerAgent(innerAgentLoop);
        // Phase 55 Task 7：强类型调用 setDualLoopOrchestrator
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
  const phase53SkillGateCfg = config.phase53Integration?.skillSecurityGate;
  if (phase53SkillGateCfg?.enabled) {
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
  if (config.phase52Integration?.boundedRecovery?.enabled && config.packs?.goalAdvanced?.enabled) {
    logger.info('app-init: boundedRecovery 配置已确认，将在 Phase 49 DualLoopOrchestrator 创建时注入');
  }

  // Phase 51 Task 1/7：Reviewer 分级策略——已在 Phase 49 块中通过 DualLoopOrchestrator.setReviewerPolicy 接入

  // ===== Phase 70：日志观测哪些子模块已激活 =====
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

  // ===== Phase 77：注册 shutdown hook 保存 goal 状态 =====
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
  ctx.hookRunner = hookRunner;
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
    hookRunner,
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
  };
}
