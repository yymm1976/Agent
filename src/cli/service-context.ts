// src/cli/service-context.ts
// App 所需服务对象的容器，避免 App.tsx 继续膨胀
// 蓝图 17.1：集中管理 config / clientManager / router / tracker / agents / trace / audit / prompts / projectMemory

import type { AppConfig } from '../config/schema.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import type { ReActAgentLoop } from '../agent/loop.js';
import type { CheckpointWriter } from '../agent/memory/checkpoint-writer.js';
import type { ContextManager } from '../agent/memory/context-manager.js';
import type { BranchManager } from '../agent/branch.js';
import type { VisionAssistant } from '../agent/vision.js';
import type { InitAnalyzer } from '../agent/init-analyzer.js';
import type { DreamConsolidator } from '../agent/dream-consolidator.js';
import type { GoalParser } from '../agent/goal-parser.js';
import type { GoalVerifier } from '../agent/goal-verifier.js';
import type { Blackboard } from '../agent/multi/blackboard.js';
import type { Orchestrator } from '../agent/multi/orchestrator.js';
import type { WorkerExecutor } from '../agent/multi/worker-executor.js';
import type { TraceCollector } from '../harness/trace-collector.js';
import type { AuditLogger } from '../harness/audit-logger.js';
import type { PromptTemplateManager } from '../prompts/manager.js';
import type { ProjectMemoryManager } from '../memory/project-memory.js';
import type { ToolExecutorAdapter } from '../agent/loop-config.js';

export interface ServiceContext {
  config: AppConfig;
  clientManager: LLMClientManager;
  router: ModelRouter;
  tracker: TokenTracker;
  agentLoop: ReActAgentLoop;
  checkpointWriter: CheckpointWriter;
  contextManager: ContextManager;
  branchManager: BranchManager;
  vision: VisionAssistant;
  initAnalyzer: InitAnalyzer;
  dream: DreamConsolidator;
  goalParser: GoalParser;
  goalVerifier: GoalVerifier;
  blackboard: Blackboard;
  orchestrator: Orchestrator;
  workerExecutor: WorkerExecutor;
  trace: TraceCollector;
  audit: AuditLogger;
  prompts: PromptTemplateManager;
  projectMemory: ProjectMemoryManager;
  toolExecutor: ToolExecutorAdapter;
  setToolExecutor: (executor: ToolExecutorAdapter) => void;
  sessionId: string;
  cwd: string;
}

export function createServiceContext(
  config: AppConfig,
  clientManager: LLMClientManager,
  router: ModelRouter,
  tracker: TokenTracker,
  agentLoop: ReActAgentLoop,
  checkpointWriter: CheckpointWriter,
  contextManager: ContextManager,
  branchManager: BranchManager,
  vision: VisionAssistant,
  initAnalyzer: InitAnalyzer,
  dream: DreamConsolidator,
  goalParser: GoalParser,
  goalVerifier: GoalVerifier,
  blackboard: Blackboard,
  orchestrator: Orchestrator,
  workerExecutor: WorkerExecutor,
  trace: TraceCollector,
  audit: AuditLogger,
  prompts: PromptTemplateManager,
  projectMemory: ProjectMemoryManager,
  toolExecutor: ToolExecutorAdapter,
  cwd: string,
): ServiceContext {
  const sessionId = trace.getSessionId() ?? `cli-${Date.now()}`;
  const ctx: ServiceContext = {
    config,
    clientManager,
    router,
    tracker,
    agentLoop,
    checkpointWriter,
    contextManager,
    branchManager,
    vision,
    initAnalyzer,
    dream,
    goalParser,
    goalVerifier,
    blackboard,
    orchestrator,
    workerExecutor,
    trace,
    audit,
    prompts,
    projectMemory,
    toolExecutor,
    setToolExecutor: (executor: ToolExecutorAdapter) => {
      ctx.toolExecutor = executor;
      agentLoop.updateToolExecutor(executor);
    },
    sessionId,
    cwd,
  };
  return ctx;
}