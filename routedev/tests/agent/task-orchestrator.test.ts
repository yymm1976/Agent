// tests/agent/task-orchestrator.test.ts
// Phase 31 Task 1：TaskOrchestrator 单元测试
// 覆盖：intent 判定、stage 状态机、quick_answer 短路、fallback 配置、Steering Queue

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskOrchestrator, MAX_STEERING_QUEUE_SIZE, PLANNING_KEYWORDS } from '../../src/agent/task-orchestrator.js';
import type { ClassificationResult, RoutingResult } from '../../src/router/types.js';
import type { AppConfig } from '../../src/config/schema.js';

// --- Mock 工厂 ---

function makeClassificationResult(tier: 'simple' | 'medium' | 'complex' | 'reasoning', confidence = 0.8): ClassificationResult {
  return { tier, confidence, reasoning: 'mock', source: 'rule' };
}

function makeRoutingResult(): RoutingResult {
  return {
    model: {
      id: 'test-model',
      name: 'Test Model',
      provider: 'test-provider',
      tier: 'medium',
      contextWindow: 128000,
      capabilities: [],
      latencyMs: 0,
      available: true,
    },
    providerId: 'test-provider',
    fallbackUsed: false,
    originalTier: 'medium',
    degraded: false,
  };
}

function makeConfig(overrides?: Partial<AppConfig['optimization']>): AppConfig {
  return {
    version: 1,
    general: {
      language: 'zh-CN',
      theme: 'dark',
      startupBehavior: 'restore',
      setupSkipped: false,
      appearanceTheme: 'black',
      fontSize: 14,
    },
    providers: [],
    router: {
      rules: [],
      budget: { mode: 'track_only', dailyLimit: 500000, degradationThreshold: 0.8 },
      classifierModel: 'test',
      userPreference: 'balanced',
    },
    checkpoint: { enabled: true, triggers: [], modelId: 'test', maxTokensPerCheckpoint: 500 },
    goalVerifier: { enabled: true, modelId: 'test', maxTokensPerVerification: 1000, autoVerify: true },
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
    ui: { disclosureLevel: 2, bell: true, idleHintSeconds: 30 },
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
      ...overrides,
    },
  } as AppConfig;
}

function makeOrchestrator(classifyResult: ClassificationResult, configOverrides?: Partial<AppConfig['optimization']>) {
  const classifier = {
    classify: vi.fn().mockResolvedValue(classifyResult),
  };
  const modelRouter = {
    route: vi.fn().mockResolvedValue(makeRoutingResult()),
  };
  const clientManager = {};
  const config = makeConfig(configOverrides);
  const orchestrator = new TaskOrchestrator(
    classifier as never,
    modelRouter as never,
    clientManager as never,
    config,
  );
  return { orchestrator, classifier, modelRouter, config };
}

// --- 测试 ---

describe('TaskOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('intent 判定', () => {
    it('quick_answer: simple 且 confidence ≥ 0.7 → direct_chat', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('simple', 0.8));
      const action = await orchestrator.handle('读取 config.yaml');
      expect(action.type).toBe('direct_chat');
      expect(action.runner).toBe('chat');
      // quick_answer 不占用状态机
      expect(orchestrator.getStage()).toBe('idle');
    });

    it('quick_answer: confidence < 0.7 时不短路，进入 development', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('simple', 0.5));
      const action = await orchestrator.handle('读取配置');
      expect(action.type).toBe('pipeline_start');
      expect(action.intent).toBe('development');
    });

    it('development: medium 复杂度 → pipeline_start', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium', 0.9));
      const action = await orchestrator.handle('修改登录逻辑');
      expect(action.type).toBe('pipeline_start');
      expect(action.intent).toBe('development');
    });

    it('development: complex 复杂度 → pipeline_start', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('complex', 0.9));
      const action = await orchestrator.handle('重构整个认证模块');
      expect(action.type).toBe('pipeline_start');
      expect(action.intent).toBe('development');
    });

    it('planning: /plan 开头 → planning intent', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('reasoning', 0.9));
      const action = await orchestrator.handle('/plan 设计新的微服务架构');
      expect(action.type).toBe('pipeline_start');
      expect(action.intent).toBe('planning');
      expect(orchestrator.getStage()).toBe('planning');
    });

    it('planning: reasoning + 规划关键词 → planning intent', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('reasoning', 0.9));
      const action = await orchestrator.handle('帮我做一个系统架构规划');
      expect(action.type).toBe('pipeline_start');
      expect(action.intent).toBe('planning');
    });

    it('planning: reasoning 但无规划关键词 → development', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('reasoning', 0.9));
      const action = await orchestrator.handle('分析这个复杂 bug 的根因');
      expect(action.intent).toBe('development');
    });

    it('explicit_goal: /goal 开头 → explicit_goal intent', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('complex', 0.9));
      const action = await orchestrator.handle('/goal "完成用户认证模块"');
      expect(action.type).toBe('pipeline_start');
      expect(action.intent).toBe('explicit_goal');
    });
  });

  describe('classifier 传入 context', () => {
    it('handle 调用 classifier.classify 传入 query（context 字段已移除为死代码）', async () => {
      const { orchestrator, classifier } = makeOrchestrator(makeClassificationResult('medium', 0.9));
      await orchestrator.handle('修改代码', {
        projectType: 'node',
        recentTools: ['file_read'],
        hasGitChanges: true,
      });
      // context 字段已移除：classifier 实现从不读取这些字段
      expect(classifier.classify).toHaveBeenCalledWith({
        query: '修改代码',
      });
    });
  });

  describe('状态机', () => {
    it('初始 stage 为 idle', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      expect(orchestrator.getStage()).toBe('idle');
    });

    it('setStage 可切换阶段', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      orchestrator.setStage('executing');
      expect(orchestrator.getStage()).toBe('executing');
    });

    it('abort 重置 stage 为 idle 并清空任务', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      await orchestrator.handle('修改代码');
      expect(orchestrator.getCurrentTask()).not.toBeNull();
      await orchestrator.abort();
      expect(orchestrator.getStage()).toBe('idle');
      expect(orchestrator.getCurrentTask()).toBeNull();
    });

    it('reset 清空所有状态', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      await orchestrator.handle('修改代码');
      orchestrator.enqueueSteering('补充信息', 'immediate');
      orchestrator.reset();
      expect(orchestrator.getStage()).toBe('idle');
      expect(orchestrator.getCurrentTask()).toBeNull();
      expect(orchestrator.hasSteering()).toBe(false);
    });
  });

  describe('shouldSkipRequirements', () => {
    it('autoRequirements=false 时跳过', () => {
      const { orchestrator } = makeOrchestrator(
        makeClassificationResult('medium'),
        { workflow: { unifiedPipeline: true, autoRequirements: false, reviewOnComplete: true, reviewMode: 'builtin', reviewModel: 'auto', reviewStrictness: 'medium' } },
      );
      expect(orchestrator.shouldSkipRequirements('修改登录逻辑', makeClassificationResult('medium'))).toBe(true);
    });

    it('! 开头强制直达时跳过', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      expect(orchestrator.shouldSkipRequirements('!rm -rf node_modules', makeClassificationResult('medium'))).toBe(true);
    });

    it('短消息 + simple 时跳过', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('simple'));
      expect(orchestrator.shouldSkipRequirements('读一下配置', makeClassificationResult('simple'))).toBe(true);
    });

    it('长消息 + medium 时不跳过', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      expect(orchestrator.shouldSkipRequirements('请帮我重构用户认证模块，需要支持 OAuth 和 JWT', makeClassificationResult('medium'))).toBe(false);
    });
  });

  describe('Steering Queue', () => {
    it('enqueueSteering 接受消息', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      const ok = orchestrator.enqueueSteering('补充信息1', 'immediate');
      expect(ok).toBe(true);
      expect(orchestrator.hasSteering()).toBe(true);
      expect(orchestrator.getSteeringQueueSize()).toBe(1);
    });

    it('drainSteering 取出并清空队列', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      orchestrator.enqueueSteering('msg1', 'immediate');
      orchestrator.enqueueSteering('msg2', 'next_iteration');
      const drained = orchestrator.drainSteering();
      expect(drained.length).toBe(2);
      expect(drained[0].content).toBe('msg1');
      expect(drained[1].content).toBe('msg2');
      expect(orchestrator.hasSteering()).toBe(false);
    });

    it('drainSteering 支持 modeFilter', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      orchestrator.enqueueSteering('msg1', 'immediate');
      orchestrator.enqueueSteering('msg2', 'next_iteration');
      orchestrator.enqueueSteering('msg3', 'immediate');
      const immediate = orchestrator.drainSteering('immediate');
      expect(immediate.length).toBe(2);
      expect(immediate.every((m) => m.mode === 'immediate')).toBe(true);
      expect(orchestrator.hasSteering()).toBe(true); // next_iteration 还在
      expect(orchestrator.getSteeringQueueSize()).toBe(1);
    });

    it(`队列超过 ${MAX_STEERING_QUEUE_SIZE} 条时丢弃最早消息`, () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      // 填满队列
      for (let i = 0; i < MAX_STEERING_QUEUE_SIZE; i++) {
        orchestrator.enqueueSteering(`msg${i}`, 'immediate');
      }
      expect(orchestrator.getSteeringQueueSize()).toBe(MAX_STEERING_QUEUE_SIZE);
      // 再加一条，应丢弃 msg0
      const ok = orchestrator.enqueueSteering('overflow', 'immediate');
      expect(ok).toBe(false); // 发生了丢弃
      expect(orchestrator.getSteeringQueueSize()).toBe(MAX_STEERING_QUEUE_SIZE);
      const drained = orchestrator.drainSteering();
      expect(drained[0].content).not.toBe('msg0'); // msg0 已被丢弃
      expect(drained[drained.length - 1].content).toBe('overflow');
    });

    it('队列溢出时生成通知', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      for (let i = 0; i < MAX_STEERING_QUEUE_SIZE; i++) {
        orchestrator.enqueueSteering(`msg${i}`, 'immediate');
      }
      orchestrator.enqueueSteering('overflow', 'immediate');
      const notice = orchestrator.consumeOverflowNotice();
      expect(notice).not.toBeNull();
      expect(notice).toContain('丢弃');
      // 二次消费返回 null
      expect(orchestrator.consumeOverflowNotice()).toBeNull();
    });

    it('abort 清空转向队列', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      orchestrator.enqueueSteering('msg1', 'immediate');
      await orchestrator.abort();
      expect(orchestrator.hasSteering()).toBe(false);
    });
  });

  describe('getSummary', () => {
    it('无任务时返回 null', () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium'));
      expect(orchestrator.getSummary()).toBeNull();
    });

    it('有任务时返回摘要', async () => {
      const { orchestrator } = makeOrchestrator(makeClassificationResult('medium', 0.9));
      await orchestrator.handle('修改登录逻辑');
      const summary = orchestrator.getSummary();
      expect(summary).not.toBeNull();
      expect(summary!.intent).toBe('development');
      expect(summary!.goal).toBe('修改登录逻辑');
      expect(summary!.stepsCompleted).toBe(0);
      expect(summary!.stepsTotal).toBe(0);
    });
  });

  describe('常量', () => {
    it('MAX_STEERING_QUEUE_SIZE 为 5', () => {
      expect(MAX_STEERING_QUEUE_SIZE).toBe(5);
    });

    it('PLANNING_KEYWORDS 包含规划相关词', () => {
      expect(PLANNING_KEYWORDS).toContain('规划');
      expect(PLANNING_KEYWORDS).toContain('计划');
      expect(PLANNING_KEYWORDS).toContain('方案');
      expect(PLANNING_KEYWORDS.length).toBeGreaterThan(0);
    });
  });
});
