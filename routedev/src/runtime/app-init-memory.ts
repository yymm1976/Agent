// src/runtime/app-init-memory.ts
// 记忆子系统装配：CheckpointManager、ContextManager、ContextCompactor、MemoryStore、KnowledgeGraph
// 从 app-init.ts 拆分（TD-02），保持功能完全等价
//
// 职责：
//   1. CheckpointManager + CheckpointWriter + ContextManager
//   2. MemoryRecallInjector（接通 KnowledgeGraph.recall()）
//   3. ContextCompactor（含 Phase 70 上下文压缩模块 + CCR 可逆压缩）
//   4. PrefixAwareCache 动态 import（fail-open）
//   5. VisionAssistant（辅助 Agent，按 config.vision.enabled 守护）
//   6. Phase 65 记忆系统重构（MemoryStore / HybridRetriever / LocalMaintenance）
//   7. Phase 68 检索/搜索/发现三分与知识图谱（ProvenanceGraph / KanObstacleChecker / QuantitativeGate）

import type { ILLMClient } from '../router/types.js';
import { CheckpointManager } from '../harness/checkpoint-manager.js';
import { CheckpointWriter } from '../agent/memory/checkpoint-writer.js';
import { ContextManager } from '../agent/memory/context-manager.js';
import { MemoryRecallInjector } from '../agent/memory/recall-injector.js';
import { ContextCompactor } from '../agent/context-compaction.js';
import { BranchManager } from '../agent/branch.js';
import { estimateTokens } from '../utils/token-estimate.js';
import { VisionAssistant } from '../agent/vision.js';
import { CCRCache } from '../agent/ccr-cache.js';
import { registerShutdownHook } from './graceful-shutdown.js';
// Phase 70：上下文压缩技术深度优化
import { ToolOutputBudgetManager, DEFAULT_BUDGET_CONFIG } from '../agent/memory/tool-output-budget.js';
import { MessageGrouper } from '../agent/memory/message-grouper.js';
import { ActionChainDetector } from '../agent/memory/action-chain-detector.js';
import { AutoCompactGuardian, DEFAULT_GUARDIAN_CONFIG } from '../agent/memory/auto-compact-guardian.js';
import { CompactPromptEngine } from '../agent/memory/compact-prompt-engine.js';
import { SessionMemoryStore } from '../agent/memory/session-memory-store.js';
// Phase 65：记忆系统重构
import { MemoryStore } from '../memory/memory-store.js';
import { HybridRetriever } from '../memory/hybrid-retriever.js';
import { LocalMaintenancePolicy } from '../memory/local-maintenance.js';
// Phase 68：检索/搜索/发现三分与知识图谱
import { ProvenanceGraph } from '../memory/provenance-graph.js';
import { KanObstacleChecker } from '../skills/kan-obstacle-checker.js';
import { QuantitativeGate } from '../agent/quantitative-gate.js';
import { classifyOperation, type OperationSignal } from '../skills/operation-classifier.js';
import { logger } from '../utils/logger.js';
import * as path from 'node:path';
import type { InitContext, AppDependencies } from './app-init.js';

// ============================================================
// 魔法数字常量（F-016 提取，避免散点字面量）
// ============================================================
/** ContextManager 压缩触发阈值（占 contextWindow 比例） */
const COMPRESSION_THRESHOLD = 0.8;
/** ContextCompactor 目标 token 数（占 contextWindow 比例） */
const TARGET_TOKEN_RATIO = 0.6;
/** L5 摘要输入截断长度（字符数） */
const SUMMARY_INPUT_MAX_CHARS = 8000;
/** MemoryRecallInjector 单次召回最大记忆条数（config.memory 无此字段） */
const MAX_RECALL_MEMORIES = 5;

/**
 * 创建记忆子系统
 * 包含：CheckpointManager、ContextManager、ContextCompactor、Phase 65/68 记忆模块
 *
 * @param ctx 共享装配上下文（读取 config/cwd/checkpointClient/clientManager/currentModel，写入 contextManager/recallInjector/ccrCache/branchManager/visionAssistant/p70*）
 * @returns 记忆子系统依赖片段
 */
export function createMemorySubsystem(ctx: InitContext): Partial<AppDependencies> {
  const { config, cwd, checkpointClient, clientManager, currentModel } = ctx;

  // Phase 81 Task 3：KG 高级算法（社区检测，freeze 层 F-03）条件装配
  // 默认 false → 仅保留基础存储/查询 + 精确路径召回；enabled:true 恢复社区检测
  if (config.packs?.kgAdvanced?.enabled) {
    const graphModulePath = '../agent/memory/graph.js';
    import(graphModulePath)
      .then(({ initKnowledgeGraphAdvanced }: { initKnowledgeGraphAdvanced: () => void }) => {
        initKnowledgeGraphAdvanced();
        logger.info('KG advanced algorithms enabled (community detection)');
      })
      .catch((err) => { logger.warn('KG advanced init fail-open', { error: err instanceof Error ? err.message : String(err) }); });
  }

  // ===== 记忆与上下文 =====
  const checkpointManager = new CheckpointManager({
    enabled: config.checkpoint.enabled,
    maxCheckpoints: 10,
    workingDirectory: cwd,
  });
  // router 子系统已写入 checkpointClient，此处非空
  const checkpointWriter = new CheckpointWriter(checkpointClient!, config.checkpoint.modelId, config.checkpoint.maxTokensPerCheckpoint);
  const currentModelConfig = config.providers.flatMap(p => p.models).find(m => m.id === currentModel);
  const contextManager = new ContextManager(
    {
      contextWindow: currentModelConfig?.contextWindow ?? 128000,
      compressionThreshold: COMPRESSION_THRESHOLD,
      keepRecentMessages: 6,
      checkpointEnabled: config.checkpoint.enabled,
      cwd,
      // Phase 45：将记忆配置注入 ContextManager，控制推理/自动学习/注入阈值
      memory: config.memory,
    },
    checkpointWriter,
  );

  // Phase 71 Task B3：装配记忆召回注入器
  // - contextManager 持有 KnowledgeGraph，recallInjector 通过 graph.recall() 唤醒死数据
  // - 同时注入到 contextManager（统一入口）和 agentLoop（run() 中消费）
  // - injectThreshold 来自 config.memory.injectThreshold（默认 0.7）
  // - maxMemories 用常量 MAX_RECALL_MEMORIES（config.memory 无此字段）
  const recallInjector = new MemoryRecallInjector(
    contextManager.getKnowledgeGraph(),
    config.memory?.injectThreshold ?? 0.7,
    MAX_RECALL_MEMORIES,
  );
  contextManager.setRecallInjector(recallInjector);

  // A3：激活 ContextCompactor——消除双引擎不统一，让上下文压缩在生产路径生效
  // L5 summarize 回调使用 checkpointClient（已配置的辅助模型），失败时由 B12 的 try/catch 降级
  // Phase 55 Task 9：CCR 可逆压缩——compact 前缓存原始消息，LLM 可通过 ccr_retrieve 工具取回
  // G-F016 修复：受 config.packs.ccrCompression.enabled 门控
  const ccrCache = (config.ccrCompression?.enabled && config.packs?.ccrCompression?.enabled)
    ? new CCRCache(config.ccrCompression?.maxCacheSize ?? 50)
    : undefined;

  // Phase 70：提前创建上下文压缩模块实例（供 ContextCompactor 和 AppDependencies 共享）
  const p70Cfg = config.phase70Integration;
  const p70ToolOutputBudgetManager = p70Cfg?.toolOutputBudget?.enabled
    ? new ToolOutputBudgetManager({
        ...DEFAULT_BUDGET_CONFIG,
        enabled: p70Cfg.toolOutputBudget.enabled,
        maxCharsPerOutput: p70Cfg.toolOutputBudget.maxCharsPerOutput,
        previewHeadChars: p70Cfg.toolOutputBudget.previewHeadChars,
        previewTailChars: p70Cfg.toolOutputBudget.previewTailChars,
        offloadDir: p70Cfg.toolOutputBudget.offloadDir,
      })
    : undefined;
  const p70MessageGrouper = p70Cfg?.microCompact?.enabled
    ? new MessageGrouper({
        cleanBeforeRounds: p70Cfg.microCompact.cleanBeforeRounds,
        keepRecentRounds: p70Cfg.microCompact.keepRecentRounds,
      })
    : undefined;
  const p70ActionChainDetector = p70Cfg?.contextCollapse?.enabled
    ? new ActionChainDetector(p70Cfg.contextCollapse.minToolCallsForChain)
    : undefined;
  const p70AutoCompactGuardian = p70Cfg?.autoCompactGuardian?.enabled
    ? new AutoCompactGuardian({
        ...DEFAULT_GUARDIAN_CONFIG,
        enabled: p70Cfg.autoCompactGuardian.enabled,
        contextWindow: p70Cfg.autoCompactGuardian.contextWindow,
        reservedTokensForSummary: p70Cfg.autoCompactGuardian.reservedTokensForSummary,
        autoCompactBuffer: p70Cfg.autoCompactGuardian.autoCompactBuffer,
        warningBuffer: p70Cfg.autoCompactGuardian.warningBuffer,
        errorBuffer: p70Cfg.autoCompactGuardian.errorBuffer,
        maxConsecutiveFailures: p70Cfg.autoCompactGuardian.maxConsecutiveFailures,
      })
    : undefined;
  const p70CompactPromptEngine = p70Cfg?.compactPrompt?.enabled
    ? new CompactPromptEngine(p70Cfg.compactPrompt.defaultDirection)
    : undefined;
  // 跨会话持久化记忆：优先读 config.memory（Phase 45 记忆配置段）
  // 兼容 phase70Integration.sessionMemory.enabled 作为 fallback 开关
  // persistentPath 由 config.memory.sessionMemoryPath 解析得到，不写死
  // 同时返回 persistentPath 供后续日志输出实际持久化路径
  const { store: p70SessionMemoryStore, persistentPath: p70SessionMemoryPersistentPath } = (() => {
    const memCfg = config.memory;
    const persistentEnabled = memCfg?.sessionMemoryPersistent ?? true;
    const p70Enabled = p70Cfg?.sessionMemory?.enabled ?? false;
    if (!p70Enabled && !persistentEnabled) return { store: undefined, persistentPath: undefined };

    const maxMemories = p70Cfg?.sessionMemory?.maxMemories ?? 100;
    const persistentPath = persistentEnabled
      ? path.resolve(cwd, memCfg?.sessionMemoryPath ?? '.routedev/session-memory.jsonl')
      : undefined;
    const store = new SessionMemoryStore(maxMemories, persistentPath);

    // P0-14：注册服务关闭钩子（集中式），进程退出前 flush 最终状态，避免 debounce 中的待写数据丢失
    // 优先级 100：session-memory 属于关键持久化，需先于 watcher/analytics 执行
    if (persistentPath) {
      const handleClose = () => { store.close().catch((err) => logger.warn('session-memory close failed', { error: String(err) })); };
      registerShutdownHook(100, 'session-memory', handleClose);
    }
    return { store, persistentPath };
  })();

  // Phase 75：codebase-memory.ts 源文件已删除（Phase 59 删除实例化后沦为死代码，无外部消费方）
  // - UnifiedMemoryStoreImpl 已移除 codebaseMemory 参数（构造函数签名简化）

  // Phase 73 Part D 修复：创建 BranchManager 实例，供 onCompaction 回调追加 CompactionNode
  // 此前 BranchManager 仅在测试中实例化，生产路径从未创建——导致 appendCompactionNode 沦为死代码
  const branchManager = new BranchManager();

  const contextCompactor = new ContextCompactor({
    targetTokens: Math.floor((currentModelConfig?.contextWindow ?? 128000) * TARGET_TOKEN_RATIO),
    estimateTokens,
    summarize: checkpointClient
      ? async (messages: import('../router/types.js').LLMMessage[]) => {
          // L5 摘要：用辅助模型生成对话摘要
          const conversationText = messages
            .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
            .join('\n');
          const summaryPrompt = `请将以下对话历史压缩为简洁摘要，保留关键决策、工具调用结果和未完成任务（< 500 字）：\n\n${conversationText.slice(0, SUMMARY_INPUT_MAX_CHARS)}`;
          const result = await checkpointClient.complete({
            model: config.router.classifierModel,
            messages: [{ role: 'user', content: summaryPrompt }],
            temperature: 0.3,
          });
          return result.content;
        }
      : undefined,
    contextWindow: currentModelConfig?.contextWindow ?? 128000,
    ccrCache: (config.ccrCompression?.enabled && config.packs?.ccrCompression?.enabled) ? ccrCache : undefined,
    // Phase 70：上下文压缩技术深度优化
    toolOutputBudgetManager: p70ToolOutputBudgetManager,
    messageGrouper: p70MessageGrouper,
    actionChainDetector: p70ActionChainDetector,
    autoCompactGuardian: p70AutoCompactGuardian,
    compactPromptEngine: p70CompactPromptEngine,
    sessionMemoryStore: p70SessionMemoryStore,
    // Phase 63：状态外部化配置 wiring——defaults.ts 已定义默认值，但此前未透传到 CompactionConfig
    // 不传则 context-compaction.ts initStateExternalizationModules 在 `!se` 处直接 return，三个子模块永不激活
    stateExternalization: config.stateExternalization,
    // Phase 73 Part D 修复：onCompaction 回调——压缩成功后向 BranchManager 追加 CompactionNode
    // 此前回调未传，导致 CompactionNode 永不追加，getPath() 中处理 CompactionNode 的优化分支永远不触发
    // firstKeptEntryId 近似取当前 tip 节点 ID：压缩后新消息会追加到 tip 之后，语义上等价
    // 若 BranchManager 尚未 initFromHistory（activeBranchId 为 null），跳过本次追加（避免误挂到根）
    onCompaction: ({ summary, tokensBefore }) => {
      const tipNodeId = branchManager.getActiveBranchId();
      if (!tipNodeId) return;
      branchManager.appendCompactionNode(summary, tipNodeId, tokensBefore);
    },
  });
  contextManager.setCompactor(contextCompactor);

  // Phase 53 Task 8：前缀感知缓存（受 config.phase53Integration.prefixCache.enabled 守护，fail-open）
  // 使用变量路径让 TypeScript 无法静态解析，避免模块尚未生成时 typecheck 失败
  const phase53PrefixCacheCfg = config.phase53Integration?.prefixCache;
  if (phase53PrefixCacheCfg?.enabled) {
    const prefixCacheModulePath = '../agent/memory/prefix-cache.js';
    import(prefixCacheModulePath)
      .then((mod: { PrefixAwareCache: new (opts?: { blockSize?: number; l1MaxSize?: number }) => import('../agent/memory/prefix-cache.js').PrefixAwareCache }) => {
        const cache = new mod.PrefixAwareCache({
          blockSize: phase53PrefixCacheCfg.blockSize,
          l1MaxSize: phase53PrefixCacheCfg.l1MaxSize,
        });
        // setPrefixCache 已在 ContextManager 声明；保留 typeof 守卫兼容装配顺序
        if (typeof contextManager.setPrefixCache === 'function') {
          contextManager.setPrefixCache(cache);
          logger.debug('PrefixAwareCache injected', { via: 'setPrefixCache' });
        }
      })
      .catch((err) => { logger.warn('PrefixAwareCache fail-open', { error: err instanceof Error ? err.message : String(err) }); });
  }

  // ===== 辅助 Agent =====
  // Phase 57：vision 默认关闭，仅在 config.vision.enabled 时装配
  const visionAssistant = config.vision?.enabled
    ? new VisionAssistant(config.providers, (id: string) => clientManager.get(id))
    : undefined;
  // Phase 59：branchManager/initAnalyzer 实例化已删除（僵尸字段，源文件均已清理）

  // 写回共享上下文，供其他子系统消费
  ctx.checkpointManager = checkpointManager;
  ctx.contextManager = contextManager;
  ctx.recallInjector = recallInjector;
  ctx.ccrCache = ccrCache;
  ctx.branchManager = branchManager;
  ctx.visionAssistant = visionAssistant;
  ctx.p70Cfg = p70Cfg;
  ctx.p70ToolOutputBudgetManager = p70ToolOutputBudgetManager;
  ctx.p70SessionMemoryStore = p70SessionMemoryStore;
  ctx.p70SessionMemoryPersistentPath = p70SessionMemoryPersistentPath;

  // Phase 70：日志观测哪些子模块已激活（接口字段已删除，仅作可观测性输出）
  if (p70Cfg && (
    p70ToolOutputBudgetManager || p70MessageGrouper || p70ActionChainDetector ||
    p70AutoCompactGuardian || p70CompactPromptEngine || p70SessionMemoryStore
  )) {
    logger.info('Phase 70: Context compaction modules enabled', {
      toolOutputBudgetManager: !!p70ToolOutputBudgetManager,
      messageGrouper: !!p70MessageGrouper,
      actionChainDetector: !!p70ActionChainDetector,
      autoCompactGuardian: !!p70AutoCompactGuardian,
      compactPromptEngine: !!p70CompactPromptEngine,
      compactPromptDirection: p70Cfg?.compactPrompt?.defaultDirection,
      sessionMemoryStore: !!p70SessionMemoryStore,
      sessionMemoryPersistPath: p70SessionMemoryPersistentPath,
      sessionMemoryMaxMemories: p70Cfg?.sessionMemory?.maxMemories,
    });
  }

  // ===== Phase 65：记忆系统重构（可选，由 memorySystem.enabled 时注入） =====
  // 原为返回语句中的 IIFE，现迁移到记忆子系统
  let memoryStore: MemoryStore | undefined;
  let hybridRetriever: HybridRetriever | undefined;
  let localMaintenance: LocalMaintenancePolicy | undefined;

  const msCfg = config.memorySystem;
  if (msCfg?.enabled && config.packs?.kgAdvanced?.enabled) {
    memoryStore = new MemoryStore({
      enabled: msCfg.store.enabled,
      dbPath: msCfg.store.dbPath,
      backend: msCfg.store.backend,
      embeddingProvider: msCfg.store.embeddingProvider,
    });
    hybridRetriever = new HybridRetriever(memoryStore, null, {
      enabled: msCfg.hybridRetriever.enabled,
      bm25Weight: msCfg.hybridRetriever.bm25Weight,
      embeddingWeight: msCfg.hybridRetriever.embeddingWeight,
      timeDecayHalfLifeDays: msCfg.hybridRetriever.timeDecayHalfLifeDays,
      topK: msCfg.hybridRetriever.topK,
    });
    localMaintenance = new LocalMaintenancePolicy(memoryStore, {
      enabled: msCfg.localMaintenance.enabled,
      triggerThreshold: msCfg.localMaintenance.triggerThreshold,
      reorganizeRatio: msCfg.localMaintenance.reorganizeRatio,
      minAccessCount: msCfg.localMaintenance.minAccessCount,
    });
    // F-020 删除死代码：UnifiedMemoryStoreImpl 创建块已移除（Phase 59 后无外部消费方）
    logger.info('Phase 65: Memory system refactor enabled', {
      store: msCfg.store.enabled,
      hybridRetriever: msCfg.hybridRetriever.enabled,
      localMaintenance: msCfg.localMaintenance.enabled,
    });
  }

  // ===== Phase 68：检索/搜索/发现三分与知识图谱（可选，由 phase68Integration.enabled 时注入） =====
  // 原为返回语句中的 IIFE，现迁移到记忆子系统
  let provenanceGraph: ProvenanceGraph | undefined;
  let kanObstacleChecker: KanObstacleChecker | undefined;
  let quantitativeGate: QuantitativeGate | undefined;
  let classifyOperationFn: ((signal: OperationSignal, sessionId: string) => ReturnType<typeof classifyOperation>) | undefined;

  const p68Cfg = config.phase68Integration;
  if (p68Cfg) {
    if (p68Cfg.provenanceGraph?.enabled) {
      provenanceGraph = new ProvenanceGraph(p68Cfg.provenanceGraph.maxArtifacts);
      if (p68Cfg.provenanceGraph.persistPath) {
        provenanceGraph.loadFromFile(p68Cfg.provenanceGraph.persistPath).catch((err) => logger.warn('provenance-graph load failed', { error: String(err) }));
      }
    }

    if (p68Cfg.kanObstacleChecker?.enabled && provenanceGraph) {
      kanObstacleChecker = new KanObstacleChecker(
        provenanceGraph,
        {
          enabled: p68Cfg.kanObstacleChecker.enabled,
          blockOnObstacle: p68Cfg.kanObstacleChecker.blockOnObstacle,
        },
      );
    }

    if (p68Cfg.quantitativeGate?.enabled) {
      quantitativeGate = new QuantitativeGate({
        enabled: p68Cfg.quantitativeGate.enabled,
        mdlWeight: p68Cfg.quantitativeGate.mdlWeight,
        aicWeight: p68Cfg.quantitativeGate.aicWeight,
        acceptThreshold: p68Cfg.quantitativeGate.acceptThreshold,
        rejectThreshold: p68Cfg.quantitativeGate.rejectThreshold,
        complexityPenalty: p68Cfg.quantitativeGate.complexityPenalty,
      });
    }

    if (p68Cfg.operationClassification?.enabled) {
      classifyOperationFn = classifyOperation;
    }

    if (provenanceGraph || kanObstacleChecker || quantitativeGate || classifyOperationFn) {
      logger.info('Phase 68: Knowledge graph modules enabled', {
        provenanceGraph: !!provenanceGraph,
        provenanceGraphPersistPath: p68Cfg.provenanceGraph?.persistPath,
        kanObstacleChecker: !!kanObstacleChecker,
        quantitativeGate: !!quantitativeGate,
        operationClassification: !!classifyOperationFn,
        logRegimeTransition: p68Cfg.operationClassification?.logRegimeTransition,
      });
    }
  }

  // F-033：注册知识图谱落盘 shutdown hook，进程退出前 flush 内存图到磁盘
  // 优先级 95：晚于 session-memory（100），确保 session-memory 先落盘
  registerShutdownHook(95, 'knowledge-graph-flush', () => {
    contextManager.flushGraphToDisk();
  });

  return {
    checkpointManager,
    contextManager,
    visionAssistant,
    memoryStore,
    hybridRetriever,
    localMaintenance,
    provenanceGraph,
    kanObstacleChecker,
    quantitativeGate,
    classifyOperation: classifyOperationFn,
  };
}
