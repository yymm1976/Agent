// src/runtime/app-init-router.ts
// 路由子系统装配：LLM 客户端解析、组合式路由器、ACRouter 闭环模型路由
// 从 app-init.ts 拆分（TD-02），保持功能完全等价
//
// 职责：
//   1. 解析 checkpoint/primary LLM 客户端
//   2. 装配 CompositionalRouter（按 config.phase52Integration.compositionalRouting 开关）
//   3. 装配 ACRouter 闭环模型路由（按 config.closedLoopRouting 开关）

import type { AppConfig } from '../config/schema.js';
import type { ILLMClient } from '../router/types.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ModelRouter } from '../router/router.js';
import { RoutingHistory } from '../router/routing-history.js';
import { RoutingMemory } from '../router/routing-memory.js';
import { createEmbedder } from '../router/embedder.js';
import { RoutingOrchestrator } from '../router/orchestrator.js';
import { ExecutionVerifier } from '../router/execution-verifier.js';
import { RoutingRegretTracker } from '../router/regret-tracker.js';
import {
  decomposeWithSkillAwareness,
  retrieveSkill,
  composeDAG,
  DEFAULT_ROUTING_CONFIG,
  type SkillMatch,
  type CompositionalRoutingConfig,
} from '../skills/compositional-router.js';
import { logger } from '../utils/logger.js';
import * as path from 'node:path';
import type { InitContext, AppDependencies, CompositionalRouterInstance } from './app-init.js';

/**
 * 创建路由子系统
 * 包含：LLM 客户端解析、CompositionalRouter、ACRouter 闭环模型路由
 *
 * @param ctx 共享装配上下文（读取 config/cwd/clientManager/modelRouter，写入 checkpointClient/primaryClient/primaryProviderId）
 * @returns 路由子系统依赖片段
 */
export function createRouterSubsystem(ctx: InitContext): Partial<AppDependencies> {
  const { config, cwd, clientManager, modelRouter } = ctx;

  // ===== LLM 客户端解析 =====
  const checkpointModelId = config.checkpoint.modelId;
  const checkpointProvider = config.providers.find(p => p.models.some(m => m.id === checkpointModelId));
  const fallbackClient: ILLMClient | undefined = clientManager.listAll().values().next().value;
  const checkpointClient: ILLMClient = (checkpointProvider ? clientManager.get(checkpointProvider.id) ?? fallbackClient : fallbackClient) as ILLMClient;
  const primaryProviderId = config.providers[0]?.id ?? 'default';
  const primaryClient = (clientManager.get(primaryProviderId) ?? fallbackClient) as ILLMClient;

  // 写回共享上下文，供其他子系统消费
  ctx.checkpointClient = checkpointClient;
  ctx.primaryClient = primaryClient;
  ctx.primaryProviderId = primaryProviderId;
  ctx.fallbackClient = fallbackClient;

  // ===== CR-4b：组合式路由器（config.phase52Integration.compositionalRouting.enabled 守护） =====
  // 包装 decomposeWithSkillAwareness / composeDAG，按配置注入路由参数，供上层 planner 调用
  let compositionalRouter: CompositionalRouterInstance | undefined;
  const compositionalRoutingCfg = config.phase52Integration?.compositionalRouting;
  if (compositionalRoutingCfg?.enabled) {
    const routingConfig: CompositionalRoutingConfig = {
      maxDecompositionIterations: compositionalRoutingCfg.maxDecompositionIterations ?? DEFAULT_ROUTING_CONFIG.maxDecompositionIterations,
      semanticRetrieval: compositionalRoutingCfg.semanticRetrieval ?? DEFAULT_ROUTING_CONFIG.semanticRetrieval,
      maxParallelSkills: compositionalRoutingCfg.maxParallelSkills ?? DEFAULT_ROUTING_CONFIG.maxParallelSkills,
    };
    compositionalRouter = {
      config: routingConfig,
      decompose: (task, availableSkills, decomposeFn) =>
        decomposeWithSkillAwareness(task, availableSkills, routingConfig, decomposeFn),
      planDAG: (subTasks, availableSkills) => {
        const matches: SkillMatch[] = [];
        for (const sub of subTasks) {
          const m = retrieveSkill(sub, availableSkills);
          if (m) matches.push(m);
        }
        return composeDAG(matches, subTasks);
      },
    };
    logger.info('app-init: CompositionalRouter 已启用', {
      maxDecompositionIterations: routingConfig.maxDecompositionIterations,
      maxParallelSkills: routingConfig.maxParallelSkills,
    });
  }

  // ===== Phase 61：ACRouter 闭环模型路由（config.closedLoopRouting.enabled 守护） =====
  // 原为返回语句中的 IIFE，现迁移到路由子系统
  const clrCfg = config.closedLoopRouting;
  let routingHistory: RoutingHistory | undefined;
  let routingMemory: RoutingMemory | undefined;
  let routingOrchestrator: RoutingOrchestrator | undefined;
  let executionVerifier: ExecutionVerifier | undefined;
  let routingRegretTracker: RoutingRegretTracker | undefined;

  if (clrCfg?.enabled) {
    routingHistory = new RoutingHistory({
      maxRecords: clrCfg.history.maxRecords,
      persistPath: path.resolve(cwd, clrCfg.history.persistPath),
    });
    routingHistory.load().catch(err => {
      logger.warn('RoutingHistory load failed', { error: err instanceof Error ? err.message : String(err) });
    });
    const embedder = createEmbedder(clrCfg.memory.embeddingProvider);
    routingMemory = new RoutingMemory(routingHistory, embedder, {
      topK: clrCfg.memory.topK,
      minSimilarity: clrCfg.memory.minSimilarity,
      enabled: clrCfg.memory.enabled,
    });
    executionVerifier = new ExecutionVerifier({
      enabled: clrCfg.verifier.enabled,
      signals: clrCfg.verifier.signals,
      timeoutMs: clrCfg.verifier.timeoutMs,
    });
    routingRegretTracker = new RoutingRegretTracker(routingHistory);
    // Phase 61 接线：当 modelRouter 可用且 orchestrator.enabled 时，创建 RoutingOrchestrator
    // RoutingOrchestrator 内部整合 baseRouter + memory + history，做加权投票决策
    if (modelRouter && clrCfg.orchestrator?.enabled) {
      routingOrchestrator = new RoutingOrchestrator(modelRouter, routingMemory, routingHistory, {
        enabled: clrCfg.orchestrator.enabled,
        neighborWeight: clrCfg.orchestrator.neighborWeight,
        priorWeight: clrCfg.orchestrator.priorWeight,
        baseWeight: clrCfg.orchestrator.baseWeight,
      });
    }
    logger.info('Phase 61: ACRouter closed-loop routing enabled', {
      memory: clrCfg.memory.enabled,
      verifier: clrCfg.verifier.enabled,
      orchestrator: clrCfg.orchestrator?.enabled ?? false,
    });
  }

  return {
    checkpointClient,
    compositionalRouter,
    routingHistory,
    routingMemory,
    routingOrchestrator,
    executionVerifier,
    routingRegretTracker,
  };
}
