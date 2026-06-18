// tests/integration/performance-benchmark.test.ts
// 性能基准测试（Phase 23 Task 6 / Phase 28 Task 2 升级为强制门）
// 验证关键链路在合理时间内完成
// Phase 28：从"记录结果"升级为"构建失败门"——任何性能退化都阻止发布

import { describe, it, expect } from 'vitest';
import { ScenarioClassifier } from '../../src/router/classifier.js';
import { ModelRouter } from '../../src/router/router.js';
import { TokenTracker } from '../../src/router/tracker.js';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import type { ILLMClient, LLMResponse, LLMStreamEvent, LLMRequestOptions, RoutingResult } from '../../src/router/types.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import type { TokenBudget, RouterConfig } from '../../src/router/types.js';

// ============================================================
// Mock 工具（最小延迟）
// ============================================================

/** 快速 Mock LLM 客户端（无网络延迟） */
class FastMockLLMClient implements ILLMClient {
  readonly protocol = 'openai' as const;
  readonly providerId = 'mock';

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    return {
      content: '快速回复',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
      model: options.model,
    };
  }

  async *stream(options: LLMRequestOptions): AsyncGenerator<LLMStreamEvent, void, unknown> {
    const response = await this.complete(options);
    yield { type: 'text_delta', text: response.content };
    yield { type: 'usage', usage: response.usage };
    yield { type: 'done', finishReason: response.finishReason };
  }

  isReady(): boolean { return true; }
}

/** 快速 Mock 工具执行器 */
class FastMockToolExecutor implements ToolExecutorAdapter {
  getToolDefinitions() { return []; }
  async executeTool(_name: string, _id: string, _args: Record<string, unknown>): Promise<string> {
    return 'done';
  }
  hasTool(_name: string): boolean { return false; }
}

// ============================================================
// 测试辅助
// ============================================================

function makeBudget(): TokenBudget {
  return { mode: 'track_only', dailyLimit: 500000, degradationThreshold: 0.8 };
}

function makeRouterConfig(): RouterConfig {
  return {
    rules: [
      { tier: 'simple', modelId: 'fast-simple' },
      { tier: 'medium', modelId: 'fast-medium' },
      { tier: 'complex', modelId: 'fast-complex' },
      { tier: 'reasoning', modelId: 'fast-reasoning' },
    ],
    budget: makeBudget(),
    classifierModel: 'fast-simple',
    userPreference: 'balanced',
  };
}

function makeRouteResult(): RoutingResult {
  return {
    model: {
      id: 'fast-simple', name: 'Fast', provider: 'mock', tier: 'simple',
      contextWindow: 128000, capabilities: [], latencyMs: 0, available: true,
    },
    providerId: 'mock',
    fallbackUsed: false,
    originalTier: 'simple',
    degraded: false,
  };
}

// ============================================================
// 性能基线强制门（Phase 28 Task 2）
// ============================================================

describe('性能基线强制门 @benchmark', () => {
  // P1: 场景分类延迟 < 1000ms
  it('P1: classify 应在 1 秒内完成', async () => {
    const mockClient = new FastMockLLMClient();
    const classifier = new ScenarioClassifier({ llmClient: mockClient, classifierModel: 'fast-simple' });

    const start = performance.now();
    await classifier.classify({ query: '帮我读一下 index.ts' });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });

  // P2: 路由选择延迟 < 100ms
  it('P2: route 应在 100ms 内完成', async () => {
    const tracker = new TokenTracker(makeBudget());
    const router = new ModelRouter(makeRouterConfig(), tracker);

    const start = performance.now();
    await router.route({ tier: 'simple', confidence: 0.9, reasoning: 'test', source: 'rule' });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  // P3: 端到端简单任务 < 5000ms
  it('P3: 端到端简单任务应在 5 秒内完成', async () => {
    const mockClient = new FastMockLLMClient();
    const toolExecutor = new FastMockToolExecutor();
    const loop = new ReActAgentLoop(toolExecutor, { maxIterations: 3, toolsEnabled: false });
    const routeResult = makeRouteResult();

    const start = performance.now();
    for await (const _event of loop.run({
      userMessage: 'hello',
      llmClient: mockClient,
      routeDecision: routeResult,
      conversationHistory: [],
    })) {
      // 消费所有事件
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(5000);
  });

  // P4: 分类 + 路由 + 执行全链路 < 5000ms
  it('P4: 分类 + 路由 + 执行全链路应在 5 秒内完成', async () => {
    const mockClient = new FastMockLLMClient();
    const classifier = new ScenarioClassifier({ llmClient: mockClient, classifierModel: 'fast-simple' });
    const tracker = new TokenTracker(makeBudget());
    const router = new ModelRouter(makeRouterConfig(), tracker);
    const toolExecutor = new FastMockToolExecutor();
    const loop = new ReActAgentLoop(toolExecutor, { maxIterations: 3, toolsEnabled: false });

    const start = performance.now();

    // 1. 分类
    const classification = await classifier.classify({ query: '简单问题' });
    // 2. 路由
    const routeResult = await router.route(classification);
    // 3. 执行
    for await (const _event of loop.run({
      userMessage: '简单问题',
      llmClient: mockClient,
      routeDecision: routeResult,
      conversationHistory: [],
    })) {
      // 消费所有事件
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  // P5: 连续 10 次分类性能稳定（无 OOM / 崩溃）
  it('P5: 连续 10 次分类性能稳定', async () => {
    const mockClient = new FastMockLLMClient();
    const classifier = new ScenarioClassifier({ llmClient: mockClient, classifierModel: 'fast-simple' });
    const inputs = ['你好', '读取文件', '运行测试', 'git 提交', '搜索代码', '帮我写代码', '分析问题', '重构函数', '修复 bug', '部署应用'];

    const start = performance.now();
    for (const input of inputs) {
      await classifier.classify({ query: input });
    }
    const elapsed = performance.now() - start;

    // 10 次分类应在 5 秒内
    expect(elapsed).toBeLessThan(5000);
    // 平均每次应小于 500ms
    expect(elapsed / inputs.length).toBeLessThan(500);
  });

  // P6: 内存占用 < 256MB（Phase 28 新增）
  it('P6: 内存占用应在 256MB 以下', async () => {
    // 执行一批操作后检查堆内存
    const mockClient = new FastMockLLMClient();
    const classifier = new ScenarioClassifier({ llmClient: mockClient, classifierModel: 'fast-simple' });
    const tracker = new TokenTracker(makeBudget());
    const router = new ModelRouter(makeRouterConfig(), tracker);
    const toolExecutor = new FastMockToolExecutor();
    const loop = new ReActAgentLoop(toolExecutor, { maxIterations: 3, toolsEnabled: false });

    // 执行 5 次完整链路
    for (let i = 0; i < 5; i++) {
      const classification = await classifier.classify({ query: `测试输入 ${i}` });
      const routeResult = await router.route(classification);
      for await (const _event of loop.run({
        userMessage: `测试 ${i}`,
        llmClient: mockClient,
        routeDecision: routeResult,
        conversationHistory: [],
      })) {
        // 消费
      }
    }

    // 强制 GC（如果可用）后检查堆使用
    if (global.gc) global.gc();
    const heapUsed = process.memoryUsage().heapUsed;
    const heapMB = heapUsed / (1024 * 1024);

    // 堆内存应小于 256MB
    expect(heapMB).toBeLessThan(256);
  });

  // P7: 启动时间 < 3000ms（Phase 28 新增）
  it('P7: 模块初始化应在 3 秒内完成', async () => {
    const start = performance.now();

    // 模拟启动时需要初始化的核心模块
    const tracker = new TokenTracker(makeBudget());
    const router = new ModelRouter(makeRouterConfig(), tracker);
    const toolExecutor = new FastMockToolExecutor();
    const loop = new ReActAgentLoop(toolExecutor, { maxIterations: 3, toolsEnabled: false });

    // 触发首次路由（懒加载初始化）
    await router.route({ tier: 'simple', confidence: 0.9, reasoning: 'init', source: 'rule' });

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(3000);
    expect(router).toBeDefined();
    expect(loop).toBeDefined();
    expect(tracker).toBeDefined();
  });

  // P8: 连续稳定性——10x 完整链路无崩溃（Phase 28 新增）
  it('P8: 10x 连续完整链路调用稳定性', async () => {
    const mockClient = new FastMockLLMClient();
    const classifier = new ScenarioClassifier({ llmClient: mockClient, classifierModel: 'fast-simple' });
    const tracker = new TokenTracker(makeBudget());
    const router = new ModelRouter(makeRouterConfig(), tracker);
    const toolExecutor = new FastMockToolExecutor();
    const loop = new ReActAgentLoop(toolExecutor, { maxIterations: 2, toolsEnabled: false });

    const start = performance.now();
    let successCount = 0;

    for (let i = 0; i < 10; i++) {
      try {
        const classification = await classifier.classify({ query: `稳定性测试 ${i}` });
        const routeResult = await router.route(classification);
        for await (const _event of loop.run({
          userMessage: `测试 ${i}`,
          llmClient: mockClient,
          routeDecision: routeResult,
          conversationHistory: [],
        })) {
          // 消费
        }
        successCount++;
      } catch (err) {
        // 不应发生错误
        expect(err).toBeUndefined();
      }
    }

    const elapsed = performance.now() - start;

    // 全部成功
    expect(successCount).toBe(10);
    // 10 次完整链路应在 30 秒内（宽松阈值）
    expect(elapsed).toBeLessThan(30000);
  });
});
