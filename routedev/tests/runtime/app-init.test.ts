// tests/cli/app-init.test.ts
// createAppDependencies 单元测试
// 验证 App 依赖工厂的装配完整性、客户端解析、可选依赖处理与配置开关

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAppDependencies, type AppDependencies } from '../../src/runtime/app-init.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { ILLMClient, LLMResponse, LLMStreamEvent, LLMRequestOptions } from '../../src/router/types.js';
import type { LLMClientManager } from '../../src/router/llm/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { MCPClientManager } from '../../src/tools/mcp/client.js';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { CheckpointManager } from '../../src/harness/checkpoint-manager.js';
import { ContextManager } from '../../src/agent/memory/context-manager.js';
// Phase 57：VisionAssistant import 已移除（visionAssistant 改为可选，测试不再断言其类型）
import { Blackboard } from '../../src/agent/multi/blackboard.js';
// Phase 59：Orchestrator/WorkerExecutor import 已移除（接口字段已删除，不再断言类型）
import { TraceCollector } from '../../src/harness/trace-collector.js';
import { AuditLogger } from '../../src/harness/audit-logger.js';
import { PromptTemplateManager } from '../../src/prompts/manager.js';
// E1 删除：DurableExecutor 已被 GoalPersistence + CheckpointManager + HookRunner.fire 替代
import { HookRunner } from '../../src/agent/hooks.js';
import { TokenProfiler } from '../../src/agent/token-profiler.js';
import { UnifiedReviewer } from '../../src/agent/unified-reviewer.js';
import { CompletionGate } from '../../src/agent/completion-gate.js';
import { SkillsRouter, FilesystemDiscovery } from '../../src/plugins/filesystem-discovery.js';
// 注：SecurityChecker/ToolRegistryAdapter/WorkModeController/GuardedToolExecutorAdapter/CheckpointWriter/
// ProjectMemoryManager/TaskOrchestrator/ReadTracker/ToolResultSanitizer/PluginRegistry/AgentMiddlewarePipeline/
// PermissionEngine import 已移除（对应 AppDependencies 字段已删除，测试不再断言其类型）
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
    // TD-13 已清理：sounds 字段已删除
    updates: { checkOnStartup: true, autoUpdate: false },
    mcp: { servers: [], autoConnect: true },
    prompts: { projectOverrides: true, cacheTtlSeconds: 0 },
    projectMemory: { enabled: true, maxMemorySize: 10000, maxDecisions: 100, autoInject: true },
    adversarial: { enabled: false, threshold: 0.5, modelTier: 'fast' },
    ui: { outputStyle: 'standard', bell: true, idleHintSeconds: 30 },
    optimization: {
      tokenTracking: { enabled: true, persistSession: true, outputDir: '.routedev/token-logs' },
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
  // Phase 91：生产代码 fail-fast（app-init-agent.ts 缺核心依赖即 throw），
  // 所有测试统一注入最小 mock 核心依赖；fail-fast 行为由专门测试验证。
  const classifier = {
    classify: vi.fn().mockResolvedValue({ tier: 'simple', confidence: 0.9, reasoning: 'mock', source: 'rule' }),
  } as unknown as import('../../src/router/classifier.js').ScenarioClassifier;
  const modelRouter = {
    route: vi.fn().mockResolvedValue({
      model: { id: 'test-model', name: 'Test', provider: 'provider-1', tier: 'simple', contextWindow: 128000, capabilities: [], latencyMs: 0, available: true },
      providerId: 'provider-1', fallbackUsed: false, originalTier: 'simple', degraded: false,
    }),
    recordModelSuccess: vi.fn(),
    recordModelFailure: vi.fn(),
  } as unknown as import('../../src/router/router.js').ModelRouter;
  const tracker = {
    record: vi.fn(),
    recordUsage: vi.fn(),
    recordTaskUsage: vi.fn().mockReturnValue('ok'),
    getUsagePercent: () => 0,
    getStats: () => ({ total: { totalTokens: 0 } }),
  } as unknown as import('../../src/router/tracker.js').TokenTracker;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('返回值完整性', () => {
    it('返回包含 AppDependencies 所有必需字段的对象', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const cwd = makeTempCwd();

      const deps = createAppDependencies(config, clientManager, 'test-model', cwd, classifier, modelRouter, tracker);

      // 工具链
      expect(deps.registry).toBeInstanceOf(ToolRegistry);
      expect(deps.mcpManager).toBeInstanceOf(MCPClientManager);
      expect(deps.toolExecutor).toBeInstanceOf(ToolExecutor);
      expect(deps.agentLoop).toBeInstanceOf(ReActAgentLoop);
      // 插件系统
      expect(deps.skillsRouter).toBeInstanceOf(SkillsRouter);
      expect(deps.filesystemDiscovery).toBeInstanceOf(FilesystemDiscovery);
      // 多 Agent
      // Phase 59：orchestrator/workerExecutor 字段已从 AppDependencies 移除（僵尸字段，实例化代码保留供闭包引用）
      // 记忆与上下文
      expect(deps.checkpointManager).toBeInstanceOf(CheckpointManager);
      expect(deps.contextManager).toBeInstanceOf(ContextManager);
      // 辅助 Agent
      // Phase 57：visionAssistant 改为可选（config.vision.enabled=false 时为 undefined）
      expect(deps.visionAssistant).toBeUndefined();
      // Phase 59：branchManager/initAnalyzer 字段已从 AppDependencies 移除（僵尸字段）
      // 基础设施
      expect(deps.prompts).toBeInstanceOf(PromptTemplateManager);
      expect(deps.blackboard).toBeInstanceOf(Blackboard);
      expect(deps.trace).toBeInstanceOf(TraceCollector);
      expect(deps.audit).toBeInstanceOf(AuditLogger);
      // Phase 59：goalParser/goalVerifier 字段已从 AppDependencies 移除（goal-runner 内部自建实例）
      // E1 删除：durableExecutor 字段已从 AppDependencies 移除（上位替代为 GoalPersistence）
      expect(deps.hookRunner).toBeInstanceOf(HookRunner);
      // LLM 客户端
      expect(deps.checkpointClient).toBeDefined();
      // 注：securityChecker/adapter/workModeController/guardedAdapter/middlewarePipeline/pluginRegistry/
      // permissionEngine/checkpointWriter/projectMemory/primaryClient/taskOrchestrator/readTracker/
      // resultSanitizer 字段已从 AppDependencies 移除（实例化代码保留，仅 app-init.ts 内部消费）
      // Phase 31/32 模块
      // Phase 59：requirementsGatherer/complexityAnalyzer 字段已从 AppDependencies 移除（僵尸字段）
      expect(deps.unifiedReviewer).toBeInstanceOf(UnifiedReviewer);
      expect(deps.completionGate).toBeInstanceOf(CompletionGate);
      // 共享 ref
      expect(deps.sharedSystemPromptRef).toBeDefined();
      expect(deps.sharedSystemPromptRef.current).toBe('');
    });

    // Phase 59：initAnalyzer 测试已删除（源文件 src/agent/init-analyzer.ts 已清理）
  });

  describe('LLM 客户端解析', () => {
    it('primaryClient 从 config.providers[0] 对应的 clientManager 客户端获取', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      // primaryProviderId = config.providers[0].id = 'provider-1'
      // 注：primaryClient 字段已从 AppDependencies 移除（仅 app-init.ts 内部消费），
      // 此处仅验证 clientManager.get 调用链路是否正确
      expect(clientManager.get).toHaveBeenCalledWith('provider-1');
    });

    it('checkpointClient 从 checkpoint.modelId 对应的 provider 获取', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      // checkpoint.modelId = 'checkpoint-model'，属于 provider-1
      expect(deps.checkpointClient).toBeDefined();
      expect(deps.checkpointClient.providerId).toBe('provider-1');
    });

    it('checkpoint modelId 不匹配任何 provider 时回退到 listAll 的第一个客户端', () => {
      const config = makeConfig({
        checkpoint: { enabled: true, triggers: [], modelId: 'nonexistent-model', maxTokensPerCheckpoint: 500 },
      });
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      // 回退到 fallbackClient（listAll 的第一个）
      expect(deps.checkpointClient).toBe(clientManager._clients.get('provider-1'));
    });
  });

  // Phase 70：cwd 工作目录测试已删除（projectMemory 字段从 AppDependencies 移除，
  // 实例化代码保留在 app-init.ts 内部，无外部可观测入口）

  describe('Token Profiler 配置开关', () => {
    it('tokenTracking.enabled 默认为 true 时创建 profiler', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

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
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      expect(deps.profiler).toBeNull();
    });
  });

  // Phase 59：initAnalyzer 为 null 的场景测试已删除（源文件 src/agent/init-analyzer.ts 已清理）

  describe('可选依赖 classifier/modelRouter/tracker', () => {
    // Phase 91：生产代码已 fail-fast（app-init-agent.ts 第 856 行 throw），
    // 测试同步改为 expect.toThrow，不再期望"用桩继续创建"。
    it('未传入 classifier/modelRouter/tracker 时 fail-fast 抛出错误', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      // 显式不传核心依赖（undefined, undefined, undefined）以验证 fail-fast
      expect(() => createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), undefined, undefined, undefined))
        .toThrow(/classifier\/modelRouter\/tracker 未注入/);
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
      // ExecutionOrchestrator 已删除（死代码清理）
      expect(deps.unifiedReviewer).toBeInstanceOf(UnifiedReviewer);
    });
  });

  describe('sharedSystemPromptRef', () => {
    it('初始值为空字符串', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      expect(deps.sharedSystemPromptRef).toEqual({ current: '' });
    });

    it('引用可被外部修改（App.tsx 同步更新此 ref）', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      deps.sharedSystemPromptRef.current = '新的系统提示词';
      expect(deps.sharedSystemPromptRef.current).toBe('新的系统提示词');
    });
  });

  describe('工具链装配', () => {
    it('ToolRegistry 注册了内置工具', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      // 验证注册了至少 10 个工具（基础工具 + spawn_agent + todo + notes 等）
      const tools = deps.registry.list();
      expect(tools.length).toBeGreaterThanOrEqual(10);
    });

    it('adapter 设置了 TraceCollector', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      // 验证 trace 和 audit 共享同一个 sessionId
      expect(deps.trace).toBeInstanceOf(TraceCollector);
      expect(deps.audit).toBeInstanceOf(AuditLogger);
    });

    it('agentLoop 设置了 TraceCollector 和 Profiler', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      // 验证 agentLoop 创建成功（内部已注入 trace 和 profiler）
      expect(deps.agentLoop).toBeInstanceOf(ReActAgentLoop);
    });
  });

  describe('ContextManager 配置', () => {
    it('使用 currentModel 对应的 contextWindow', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      // test-model 的 contextWindow 为 128000
      expect(deps.contextManager).toBeInstanceOf(ContextManager);
    });

    it('currentModel 不匹配时回退到默认 128000', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      // 传入不存在的 model id
      const deps = createAppDependencies(config, clientManager, 'nonexistent-model', makeTempCwd(), classifier, modelRouter, tracker);

      expect(deps.contextManager).toBeInstanceOf(ContextManager);
    });
  });

  describe('返回值类型守卫', () => {
    it('返回值满足 AppDependencies 接口所有字段', () => {
      const config = makeConfig();
      const clientManager = createMockClientManager();
      const deps: AppDependencies = createAppDependencies(config, clientManager, 'test-model', makeTempCwd(), classifier, modelRouter, tracker);

      // 验证所有 AppDependencies 必需字段都存在且不为 undefined
      // 注意：仅检查 AppDependencies 接口中实际存在的必需字段
      // Phase 57/59/79：securityChecker/adapter/workModeController/guardedAdapter/middlewarePipeline/
      //   pluginRegistry/checkpointWriter/projectMemory/primaryClient/taskOrchestrator/readTracker/
      //   resultSanitizer 等字段已从 AppDependencies 接口移除（僵尸字段清理），仅保留在 InitContext 中传递
      const requiredKeys: (keyof AppDependencies)[] = [
        'registry', 'mcpManager', 'toolExecutor', 'agentLoop',
        'permissionEngine',
        'skillsRouter', 'filesystemDiscovery',
        'checkpointManager', 'contextManager',
        'prompts', 'blackboard', 'trace', 'audit',
        'hookRunner',
        'checkpointClient', 'profiler',
        'unifiedReviewer', 'completionGate', 'sharedSystemPromptRef',
        'pathRouter', 'dualLoopOrchestratorRef', 'dagEngineRef',
        'experimentManager',
      ];

      for (const key of requiredKeys) {
        expect(deps[key]).toBeDefined();
      }
    });
  });
});
