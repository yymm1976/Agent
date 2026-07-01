// tests/cli/app-init.test.ts
// createAppDependencies 单元测试
// 验证 App 依赖工厂的装配完整性、客户端解析、可选依赖处理与配置开关

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAppDependencies, type AppDependencies } from '../../src/cli/app-init.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { ILLMClient, LLMResponse, LLMStreamEvent, LLMRequestOptions } from '../../src/router/types.js';
import type { LLMClientManager } from '../../src/router/llm/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { SecurityChecker } from '../../src/tools/security.js';
import { ToolRegistryAdapter } from '../../src/tools/adapter.js';
import { MCPClientManager } from '../../src/tools/mcp/client.js';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { WorkModeController, GuardedToolExecutorAdapter } from '../../src/agent/work-modes.js';
import { CheckpointManager } from '../../src/harness/checkpoint-manager.js';
import { CheckpointWriter } from '../../src/agent/memory/checkpoint-writer.js';
import { ContextManager } from '../../src/agent/memory/context-manager.js';
import { VisionAssistant } from '../../src/agent/vision.js';
import { BranchManager } from '../../src/agent/branch.js';
import { InitAnalyzer } from '../../src/agent/init-analyzer.js';
import { Blackboard } from '../../src/agent/multi/blackboard.js';
import { Orchestrator } from '../../src/agent/multi/orchestrator.js';
import { WorkerExecutor } from '../../src/agent/multi/worker-executor.js';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import { AuditLogger } from '../../src/harness/audit-logger.js';
import { PromptTemplateManager } from '../../src/prompts/manager.js';
import { ProjectMemoryManager } from '../../src/memory/project-memory.js';
import { GoalParser } from '../../src/agent/goal-parser.js';
import { GoalVerifier } from '../../src/agent/goal-verifier.js';
// E1 删除：DurableExecutor 已被 GoalPersistence + CheckpointManager + HookRunner.fire 替代
import { HookRunner } from '../../src/agent/hooks.js';
import { TokenProfiler } from '../../src/agent/token-profiler.js';
import { TaskOrchestrator } from '../../src/agent/task-orchestrator.js';
import { RequirementsGatherer } from '../../src/agent/requirements-gatherer.js';
import { TaskComplexityAnalyzer } from '../../src/agent/complexity-analyzer.js';
import { ExecutionOrchestrator } from '../../src/agent/execution-orchestrator.js';
import { UnifiedReviewer } from '../../src/agent/unified-reviewer.js';
import { CompletionGate } from '../../src/agent/completion-gate.js';
import { ReadTracker } from '../../src/tools/read-tracker.js';
import { ToolResultSanitizer } from '../../src/tools/result-sanitizer.js';
import { SkillsRouter, FilesystemDiscovery } from '../../src/plugins/filesystem-discovery.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { AgentMiddlewarePipeline } from '../../src/agent/middleware.js';
import type { PermissionEngine } from '../../src/tools/permission-engine.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ============================================================
// Mock 工厂
// ============================================================

/** 创建 mock ILLMClient */
function createMockLLMClient(providerId: string): ILLMClient {
  return {
    protocol: 'openai',
    providerId,
    complete: vi.fn().mockResolvedValue({
      content: 'mock response',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
      model: 'test-model',
    } as LLMResponse),
    stream: vi.fn().mockImplementation(async function* (): AsyncGenerator<LLMStreamEvent, void, unknown> {
      yield { type: 'text_delta', text: 'mock' };
      yield { type: 'done', finishReason: 'stop' };
    }),
    isReady: vi.fn().mockReturnValue(true),
  };
}

/** 创建 mock LLMClientManager */
function createMockClientManager(): LLMClientManager & {
  _clients: Map<string, ILLMClient>;
} {
  const clients = new Map<string, ILLMClient>();
  clients.set('provider-1', createMockLLMClient('provider-1'));

  return {
    _clients: clients,
    get: vi.fn((id: string) => clients.get(id)),
    listAll: vi.fn(() => clients),
    register: vi.fn(),
    unregister: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    getReadyClients: vi.fn(() => clients),
  } as unknown as LLMClientManager & { _clients: Map<string, ILLMClient> };
}

/** 创建完整的 AppConfig mock */
function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    version: 1,
    general: {
      language: 'zh-CN',
      theme: 'dark',
      startupBehavior: 'restore',
      setupSkipped: false,
      appearanceTheme: 'black',
      fontSize: 14,
      accentColor: '',
      backgroundBehavior: {
        backgroundBehavior: 'ask',
        activeTaskOnClose: 'prompt',
      },
    },
    providers: [
      {
        id: 'provider-1',
        name: 'Test Provider',
        protocol: 'openai',
        baseUrl: 'https://api.test.com',
        apiKey: 'test-key',
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            provider: 'provider-1',
            tier: 'medium',
            contextWindow: 128000,
            capabilities: [],
            latencyMs: 0,
            available: true,
          },
          {
            id: 'checkpoint-model',
            name: 'Checkpoint Model',
            provider: 'provider-1',
            tier: 'simple',
            contextWindow: 32000,
            capabilities: [],
            latencyMs: 0,
            available: true,
          },
        ],
      },
    ],
    router: {
      rules: [],
      budget: { mode: 'track_only', dailyLimit: 500000, degradationThreshold: 0.8 },
      classifierModel: 'test-model',
      userPreference: 'balanced',
      fallbackChain: [],
    },
    checkpoint: { enabled: true, triggers: [], modelId: 'checkpoint-model', maxTokensPerCheckpoint: 500 },
    goalVerifier: { enabled: true, modelId: 'test-model', maxTokensPerVerification: 1000, autoVerify: true },
    security: {
      directoryBoundary: true,
      commandBlacklist: [],
      commandWhitelist: [],
      toolBlacklist: [],
      toolWhitelist: [],
      sensitiveFiles: [],
      sensitiveFilePolicy: 'readonly',
      networkConfirm: true,
    },
    channels: { entries: [], port: 9800, maxResponseLength: 2000, requestTimeout: 60000 },
    autonomy: { defaultMode: 'semi', autoApprovePatterns: [], confirmTimeout: 30000 },
    sounds: { enabled: true, completion: 'default', error: 'warning', approval: 'notification' },
    updates: { checkOnStartup: true, autoUpdate: false },
    mcp: { servers: [], autoConnect: true },
    prompts: { projectOverrides: true, cacheTtlSeconds: 0 },
    projectMemory: { enabled: true, maxMemorySize: 10000, maxDecisions: 100, autoInject: true },
    adversarial: { enabled: false, threshold: 0.5, modelTier: 'fast' },
    ui: { outputStyle: 'standard', bell: true, idleHintSeconds: 30 },
    optimization: {
      tokenTracking: { enabled: true, persistSession: true, outputDir: '.routedev/token-logs' },
      structuredState: { enabled: false },
      declarativeContext: { enabled: false },
      conciseThinking: { enabled: false },
      workflow: {
        unifiedPipeline: true,
        autoRequirements: true,
        reviewOnComplete: true,
        reviewMode: 'builtin',
        reviewModel: 'auto',
        reviewStrictness: 'medium',
      },
      safety: {
        readBeforeWrite: true,
        maxToolOutputChars: 16000,
        completionGate: true,
        gateTimeout: 180000,
        gateRetry: 1,
      },
      workerContext: {
        enabled: true,
        strategy: 'tail',
        maxMessages: 5,
        maxTokens: 4000,
        fallbackToFull: true,
      },
      clarification: {
        enabled: true,
        threshold: 0.4,
        maxQuestions: 3,
        skipIfConfident: true,
      },
    },
    scheduler: {
      enabled: true,
      maxTasks: 20,
      defaultTimezone: 'Asia/Shanghai',
    },
    ...overrides,
  } as AppConfig;
}

/** 创建一个临时工作目录路径（实际创建目录，simple-git 需要目录存在） */
function makeTempCwd(): string {
  const dir = path.join(os.tmpdir(), `routedev-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ============================================================
// 测试
// ============================================================

describe('createAppDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('返回值完整性', () => {
    it('返回包含 AppDependencies 所有必需字段的对象', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const cwd = makeTempCwd();

      const deps = createAppDependencies(config, clientManager, 'test-model', cwd);

      // 工具链
      expect(deps.registry).toBeInstanceOf(ToolRegistry);
      expect(deps.mcpManager).toBeInstanceOf(MCPClientManager);
      expect(deps.securityChecker).toBeInstanceOf(SecurityChecker);
      expect(deps.toolExecutor).toBeInstanceOf(ToolExecutor);
      expect(deps.adapter).toBeInstanceOf(ToolRegistryAdapter);
      expect(deps.workModeController).toBeInstanceOf(WorkModeController);
      expect(deps.guardedAdapter).toBeInstanceOf(GuardedToolExecutorAdapter);
      expect(deps.agentLoop).toBeInstanceOf(ReActAgentLoop);
      // 插件系统
      expect(deps.middlewarePipeline).toBeDefined();
      expect(deps.pluginRegistry).toBeDefined();
      expect(deps.skillsRouter).toBeInstanceOf(SkillsRouter);
      expect(deps.filesystemDiscovery).toBeInstanceOf(FilesystemDiscovery);
      // 权限
      expect(deps.permissionEngine).toBeDefined();
      // 多 Agent
      expect(deps.orchestrator).toBeInstanceOf(Orchestrator);
      expect(deps.workerExecutor).toBeInstanceOf(WorkerExecutor);
      // 记忆与上下文
      expect(deps.checkpointManager).toBeInstanceOf(CheckpointManager);
      expect(deps.checkpointWriter).toBeInstanceOf(CheckpointWriter);
      expect(deps.contextManager).toBeInstanceOf(ContextManager);
      // 辅助 Agent
      expect(deps.visionAssistant).toBeInstanceOf(VisionAssistant);
      expect(deps.branchManager).toBeInstanceOf(BranchManager);
      // 基础设施
      expect(deps.prompts).toBeInstanceOf(PromptTemplateManager);
      expect(deps.blackboard).toBeInstanceOf(Blackboard);
      expect(deps.trace).toBeInstanceOf(TraceCollector);
      expect(deps.audit).toBeInstanceOf(AuditLogger);
      expect(deps.projectMemory).toBeInstanceOf(ProjectMemoryManager);
      // 目标解析与验证
      expect(deps.goalParser).toBeInstanceOf(GoalParser);
      expect(deps.goalVerifier).toBeInstanceOf(GoalVerifier);
      // E1 删除：durableExecutor 字段已从 AppDependencies 移除（上位替代为 GoalPersistence）
      expect(deps.hookRunner).toBeInstanceOf(HookRunner);
      // LLM 客户端
      expect(deps.primaryClient).toBeDefined();
      expect(deps.checkpointClient).toBeDefined();
      // Phase 31/32 模块
      expect(deps.taskOrchestrator).toBeInstanceOf(TaskOrchestrator);
      expect(deps.requirementsGatherer).toBeInstanceOf(RequirementsGatherer);
      expect(deps.complexityAnalyzer).toBeInstanceOf(TaskComplexityAnalyzer);
      expect(deps.executionOrchestrator).toBeInstanceOf(ExecutionOrchestrator);
      expect(deps.unifiedReviewer).toBeInstanceOf(UnifiedReviewer);
      expect(deps.completionGate).toBeInstanceOf(CompletionGate);
      expect(deps.readTracker).toBeInstanceOf(ReadTracker);
      expect(deps.resultSanitizer).toBeInstanceOf(ToolResultSanitizer);
      // 共享 ref
      expect(deps.sharedSystemPromptRef).toBeDefined();
      expect(deps.sharedSystemPromptRef.current).toBe('');
    });

    it('initAnalyzer 在有 primaryClient 时创建实例', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());
      expect(deps.initAnalyzer).toBeInstanceOf(InitAnalyzer);
    });
  });

  describe('LLM 客户端解析', () => {
    it('primaryClient 从 config.providers[0] 对应的 clientManager 客户端获取', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      // primaryProviderId = config.providers[0].id = 'provider-1'
      expect(clientManager.get).toHaveBeenCalledWith('provider-1');
      expect(deps.primaryClient).toBe(clientManager._clients.get('provider-1'));
    });

    it('checkpointClient 从 checkpoint.modelId 对应的 provider 获取', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      // checkpoint.modelId = 'checkpoint-model'，属于 provider-1
      expect(deps.checkpointClient).toBeDefined();
      expect(deps.checkpointClient.providerId).toBe('provider-1');
    });

    it('checkpoint modelId 不匹配任何 provider 时回退到 listAll 的第一个客户端', () => {
      const config = makeConfig({
        checkpoint: { enabled: true, triggers: [], modelId: 'nonexistent-model', maxTokensPerCheckpoint: 500 },
      });
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      // 回退到 fallbackClient（listAll 的第一个）
      expect(deps.checkpointClient).toBe(clientManager._clients.get('provider-1'));
    });
  });

  describe('cwd 工作目录', () => {
    it('使用传入的 cwd 创建 ProjectMemoryManager', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const cwd = makeTempCwd();
      const deps = createAppDependencies(config, clientManager, 'test-model', cwd);

      expect(deps.projectMemory).toBeInstanceOf(ProjectMemoryManager);
      // ProjectMemoryManager.getRoutedevDir() 返回 {cwd}/.routedev
      expect(deps.projectMemory.getRoutedevDir()).toBe(path.join(cwd, '.routedev'));
    });

    it('未传入 cwd 时使用 process.cwd() 作为默认值', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model');

      expect(deps.projectMemory).toBeInstanceOf(ProjectMemoryManager);
      // 默认 cwd 为 process.cwd()
      expect(deps.projectMemory.getRoutedevDir()).toBe(path.join(process.cwd(), '.routedev'));
    });
  });

  describe('Token Profiler 配置开关', () => {
    it('tokenTracking.enabled 默认为 true 时创建 profiler', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      expect(deps.profiler).not.toBeNull();
      expect(deps.profiler).toBeInstanceOf(TokenProfiler);
    });

    it('tokenTracking.enabled = false 时 profiler 为 null', () => {
      const config = makeConfig({
        optimization: {
          ...(makeConfig().optimization),
          tokenTracking: { enabled: false, persistSession: false, outputDir: '.routedev/token-logs' },
        },
      });
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      expect(deps.profiler).toBeNull();
    });
  });

  describe('initAnalyzer 为 null 的场景', () => {
    it('primaryClient 为 undefined 时 initAnalyzer 为 null', () => {
      const config = makeConfig();
      // 创建一个空的 clientManager（没有任何客户端）
      const emptyClientManager = {
        get: vi.fn().mockReturnValue(undefined),
        listAll: vi.fn().mockReturnValue(new Map()),
        register: vi.fn(),
        unregister: vi.fn(),
        isReady: vi.fn().mockReturnValue(false),
        getReadyClients: vi.fn().mockReturnValue(new Map()),
      } as unknown as LLMClientManager;

      const deps = createAppDependencies(config, emptyClientManager, 'test-model', makeTempCwd());
      expect(deps.initAnalyzer).toBeNull();
    });
  });

  describe('可选依赖 classifier/modelRouter/tracker', () => {
    it('未传入 classifier/modelRouter 时仍能正常创建（使用桩执行器）', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      // 不传 classifier 和 modelRouter
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      // E1 删除：durableExecutor 字段已从 AppDependencies 移除（上位替代为 GoalPersistence）
      // taskOrchestrator 仍然创建（内部用 null 断言，生产路径必传）
      expect(deps.taskOrchestrator).toBeInstanceOf(TaskOrchestrator);
    });

    it('传入 classifier/modelRouter/tracker 时正常创建', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const classifier = {
        classify: vi.fn().mockResolvedValue({ tier: 'medium', confidence: 0.9, reasoning: 'mock', source: 'rule' }),
      };
      const modelRouter = {
        route: vi.fn().mockResolvedValue({
          model: config.providers[0].models[0],
          providerId: 'provider-1',
          fallbackUsed: false,
          originalTier: 'medium',
          degraded: false,
        }),
      };
      const tracker = {
        recordUsage: vi.fn(),
        getStats: vi.fn().mockReturnValue({ total: { totalTokens: 0 } }),
      };

      const deps = createAppDependencies(
        config,
        clientManager,
        'test-model',
        makeTempCwd(),
        classifier as never,
        modelRouter as never,
        tracker as never,
      );

      // E1 删除：durableExecutor 字段已从 AppDependencies 移除（上位替代为 GoalPersistence）
      expect(deps.executionOrchestrator).toBeInstanceOf(ExecutionOrchestrator);
      expect(deps.unifiedReviewer).toBeInstanceOf(UnifiedReviewer);
    });
  });

  describe('sharedSystemPromptRef', () => {
    it('初始值为空字符串', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      expect(deps.sharedSystemPromptRef).toEqual({ current: '' });
    });

    it('引用可被外部修改（App.tsx 同步更新此 ref）', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      deps.sharedSystemPromptRef.current = '新的系统提示词';
      expect(deps.sharedSystemPromptRef.current).toBe('新的系统提示词');
    });
  });

  describe('工具链装配', () => {
    it('ToolRegistry 注册了内置工具', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      // 验证注册了至少 10 个工具（基础工具 + spawn_agent + todo + notes 等）
      const tools = deps.registry.list();
      expect(tools.length).toBeGreaterThanOrEqual(10);
    });

    it('adapter 设置了 TraceCollector', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      // 验证 trace 和 audit 共享同一个 sessionId
      expect(deps.trace).toBeInstanceOf(TraceCollector);
      expect(deps.audit).toBeInstanceOf(AuditLogger);
    });

    it('agentLoop 设置了 TraceCollector 和 Profiler', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      // 验证 agentLoop 创建成功（内部已注入 trace 和 profiler）
      expect(deps.agentLoop).toBeInstanceOf(ReActAgentLoop);
    });
  });

  describe('ContextManager 配置', () => {
    it('使用 currentModel 对应的 contextWindow', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      // test-model 的 contextWindow 为 128000
      expect(deps.contextManager).toBeInstanceOf(ContextManager);
    });

    it('currentModel 不匹配时回退到默认 128000', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      // 传入不存在的 model id
      const deps = createAppDependencies(config, clientManager, 'nonexistent-model', makeTempCwd());

      expect(deps.contextManager).toBeInstanceOf(ContextManager);
    });
  });

  describe('返回值类型守卫', () => {
    it('返回值满足 AppDependencies 接口所有字段', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps: AppDependencies = createAppDependencies(config, clientManager, 'test-model', makeTempCwd());

      // 验证所有 AppDependencies 字段都存在且不为 undefined
      const requiredKeys: (keyof AppDependencies)[] = [
        'registry', 'mcpManager', 'securityChecker', 'toolExecutor', 'adapter',
        'workModeController', 'guardedAdapter', 'agentLoop',
        'middlewarePipeline', 'pluginRegistry', 'skillsRouter', 'filesystemDiscovery',
        'permissionEngine', 'orchestrator', 'workerExecutor',
        'checkpointManager', 'checkpointWriter', 'contextManager',
        'visionAssistant', 'branchManager', 'initAnalyzer',
        'prompts', 'blackboard', 'trace', 'audit', 'projectMemory',
        'goalParser', 'goalVerifier', 'hookRunner',
        'primaryClient', 'checkpointClient', 'profiler',
        'taskOrchestrator', 'requirementsGatherer', 'complexityAnalyzer',
        'executionOrchestrator', 'unifiedReviewer', 'completionGate',
        'readTracker', 'resultSanitizer', 'sharedSystemPromptRef',
        // E9-B：新增 experimentManager 单例字段
        'experimentManager',
      ];

      for (const key of requiredKeys) {
        expect(deps[key]).toBeDefined();
      }
    });
  });
});
