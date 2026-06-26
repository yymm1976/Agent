// tests/router/routing-funnel.test.ts
// Phase 49 Task 6.5：意图路由四层漏斗单元测试
//
// 覆盖蓝图 6.5 节测试要求：
//   1. L0 正则路由正确拦截高频意图
//   2. L2 大模型路由处理 L0/L1 未命中的意图
//   3. SafeNet 在低置信度时标记 needsClarification
//   4. SafeNet 连续低置信度时触发熔断
//   5. 熔断冷却期恢复
//   6. L1 向量路由命中场景（额外覆盖）
//   7. 熔断期间回退默认模型（额外覆盖）
//
// 所有依赖通过 mock 注入，不调用真实 LLM/embedding。

import { describe, it, expect, vi } from 'vitest';
import {
  RoutingFunnel,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  type RoutingResult,
  type LLMClassifier,
  type VectorRouter,
  type RoutingFunnelConfig,
} from '../../src/router/routing-funnel.js';

// ============================================================
// mock 工厂
// ============================================================

const FALLBACK_MODEL = { id: 'fallback-model', provider: 'fallback' };

/** 创建 mock LLMClassifier——按预设队列返回结果 */
function makeLLMClassifier(
  results: RoutingResult[],
): LLMClassifier & { classify: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    classify: vi.fn(async () => {
      const r = results[i] ?? results[results.length - 1];
      i++;
      return r;
    }),
  };
}

/** 创建 mock VectorRouter */
function makeVectorRouter(
  result: RoutingResult | null,
): VectorRouter & { route: ReturnType<typeof vi.fn> } {
  return {
    route: vi.fn(async () => result),
  };
}

/** 创建基础配置 */
function makeConfig(
  overrides: Partial<RoutingFunnelConfig> = {},
): RoutingFunnelConfig {
  return {
    llmClassifier: makeLLMClassifier([
      { tier: 'complex', confidence: 0.85, source: 'llm' },
    ]),
    fallbackModel: FALLBACK_MODEL,
    // 使用短冷却期便于测试
    circuitBreakerCooldownMs: 100,
    ...overrides,
  };
}

// ============================================================
// 测试套件
// ============================================================

describe('RoutingFunnel (Phase 49 Task 6.5)', () => {
  // ============================================================
  // 测试 1：L0 正则路由正确拦截高频意图
  // ============================================================
  describe('L0 正则路由', () => {
    it('1. L0 正则命中高频意图时直接返回，不调 LLM', async () => {
      const llmClassifier = makeLLMClassifier([
        { tier: 'complex', confidence: 0.9, source: 'llm' },
      ]);
      const funnel = new RoutingFunnel(makeConfig({ llmClassifier }));

      // /cost 是内置确定性规则
      const result = await funnel.route('/cost');

      expect(result.source).toBe('l0-regex');
      expect(result.confidence).toBe(1.0);
      expect(result.matchedRuleId).toBe('cmd-cost');
      expect(result.tier).toBe('simple');
      // L0 命中后不应调用 LLM
      expect(llmClassifier.classify).not.toHaveBeenCalled();
    });

    it('L0 正则未命中时进入下游层', async () => {
      const llmClassifier = makeLLMClassifier([
        { tier: 'complex', confidence: 0.85, source: 'llm' },
      ]);
      const funnel = new RoutingFunnel(makeConfig({ llmClassifier }));

      const result = await funnel.route('请帮我重构这个模块');

      expect(result.source).not.toBe('l0-regex');
      expect(llmClassifier.classify).toHaveBeenCalled();
    });
  });

  // ============================================================
  // 测试 2：L2 大模型路由处理 L0/L1 未命中的意图
  // ============================================================
  it('2. L2 大模型路由处理 L0/L1 未命中的意图', async () => {
    const llmClassifier = makeLLMClassifier([
      { tier: 'complex', confidence: 0.85, source: 'llm' },
    ]);
    const funnel = new RoutingFunnel(makeConfig({ llmClassifier }));

    const result = await funnel.route('请帮我设计一个分布式锁');

    expect(result.source).toBe('llm');
    expect(result.tier).toBe('complex');
    expect(result.confidence).toBe(0.85);
    expect(llmClassifier.classify).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 测试 3：SafeNet 在低置信度时标记 needsClarification
  // ============================================================
  describe('SafeNet 低置信度', () => {
    it('3. SafeNet 在低置信度时标记 needsClarification', async () => {
      const llmClassifier = makeLLMClassifier([
        { tier: 'simple', confidence: 0.2, source: 'llm' }, // 远低于 safeNet 阈值 0.5
      ]);
      const funnel = new RoutingFunnel(makeConfig({ llmClassifier }));

      const result = await funnel.route('某段含义模糊的输入');

      expect(result.source).toBe('safe-net');
      expect(result.needsClarification).toBe(true);
      expect(result.model).toEqual({ id: 'unknown', provider: 'safe-net' });
      expect(result.confidence).toBe(0);
      expect(result.originalTier).toBe('simple');
    });
  });

  // ============================================================
  // 测试 4：SafeNet 连续低置信度时触发熔断
  // ============================================================
  it('4. SafeNet 连续低置信度 > threshold 次触发熔断', async () => {
    // 每次都返回低置信度
    const llmClassifier = makeLLMClassifier([
      { tier: 'simple', confidence: 0.1, source: 'llm' },
    ]);
    const funnel = new RoutingFunnel(makeConfig({ llmClassifier }));

    // 连续触发 threshold+1 次（严格大于 threshold 才熔断）
    // DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5，需要 6 次低置信度才熔断
    const threshold = DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    for (let i = 0; i < threshold; i++) {
      const r = await funnel.route('模糊输入');
      expect(r.needsClarification).toBe(true);
      expect(funnel.isCircuitBreakerActive()).toBe(false);
    }
    expect(funnel.getConsecutiveLowConfidence()).toBe(threshold);

    // 第 threshold+1 次（> threshold）触发熔断
    const triggerResult = await funnel.route('模糊输入');
    expect(triggerResult.needsClarification).toBe(true);
    // 熔断已触发
    expect(funnel.isCircuitBreakerActive()).toBe(true);
  });

  // ============================================================
  // 测试 5：熔断冷却期恢复
  // ============================================================
  it('5. 熔断冷却期后自动恢复', async () => {
    const llmClassifier = makeLLMClassifier([
      { tier: 'simple', confidence: 0.1, source: 'llm' },
    ]);
    const funnel = new RoutingFunnel(
      makeConfig({
        llmClassifier,
        circuitBreakerCooldownMs: 50, // 50ms 冷却期
      }),
    );

    // 触发熔断
    const threshold = DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    for (let i = 0; i <= threshold; i++) {
      await funnel.route('模糊输入');
    }
    expect(funnel.isCircuitBreakerActive()).toBe(true);

    // 等待冷却期过
    await new Promise(r => setTimeout(r, 80));

    // 熔断应自动恢复
    expect(funnel.isCircuitBreakerActive()).toBe(false);
    expect(funnel.getConsecutiveLowConfidence()).toBe(0);
  });

  // ============================================================
  // 测试 6：熔断期间回退默认模型（陷阱 #146）
  // ============================================================
  it('6. 熔断期间所有请求回退默认模型', async () => {
    const llmClassifier = makeLLMClassifier([
      { tier: 'simple', confidence: 0.1, source: 'llm' },
    ]);
    const funnel = new RoutingFunnel(makeConfig({ llmClassifier }));

    // 触发熔断
    const threshold = DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    for (let i = 0; i <= threshold; i++) {
      await funnel.route('模糊输入');
    }
    expect(funnel.isCircuitBreakerActive()).toBe(true);

    // 重置 classify 调用计数
    llmClassifier.classify.mockClear();

    // 熔断期间发请求——应直接回退默认模型，不调 LLM
    const result = await funnel.route('任何输入');

    expect(result.source).toBe('safe-net');
    expect(result.model).toEqual(FALLBACK_MODEL);
    expect(result.circuitBreakerActive).toBe(true);
    expect(result.confidence).toBe(0);
    // 不应调用 LLM（熔断期间跳过所有层）
    expect(llmClassifier.classify).not.toHaveBeenCalled();
  });

  // ============================================================
  // 测试 7：L1 向量路由命中（额外覆盖）
  // ============================================================
  it('7. L1 向量路由命中时直接返回，不调 LLM', async () => {
    const llmClassifier = makeLLMClassifier([
      { tier: 'complex', confidence: 0.9, source: 'llm' },
    ]);
    const vectorRouter = makeVectorRouter({
      tier: 'medium',
      confidence: 0.9, // 超过 L1 阈值 0.85
      source: 'l1-vector',
    });
    const funnel = new RoutingFunnel(
      makeConfig({ llmClassifier, vectorRouter }),
    );

    // L0 不会命中的输入
    const result = await funnel.route('请帮我设计一个分布式锁');

    expect(result.source).toBe('l1-vector');
    expect(result.tier).toBe('medium');
    expect(result.confidence).toBe(0.9);
    // L1 命中后不应调用 LLM
    expect(llmClassifier.classify).not.toHaveBeenCalled();
    expect(vectorRouter.route).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 测试 8：L1 失败时降级到 L2（额外覆盖）
  // ============================================================
  it('8. L1 向量路由失败时降级到 L2', async () => {
    const llmClassifier = makeLLMClassifier([
      { tier: 'complex', confidence: 0.85, source: 'llm' },
    ]);
    const vectorRouter: VectorRouter = {
      route: vi.fn(async () => {
        throw new Error('vector service unavailable');
      }),
    };
    const funnel = new RoutingFunnel(
      makeConfig({ llmClassifier, vectorRouter }),
    );

    const result = await funnel.route('请帮我设计一个分布式锁');

    // L1 失败应降级到 L2
    expect(result.source).toBe('llm');
    expect(result.tier).toBe('complex');
    expect(vectorRouter.route).toHaveBeenCalledTimes(1);
    expect(llmClassifier.classify).toHaveBeenCalledTimes(1);
  });

  // ============================================================
  // 测试 9：手动重置熔断状态
  // ============================================================
  it('9. resetCircuitBreaker 手动重置熔断状态', async () => {
    const llmClassifier = makeLLMClassifier([
      { tier: 'simple', confidence: 0.1, source: 'llm' },
    ]);
    const funnel = new RoutingFunnel(makeConfig({ llmClassifier }));

    // 触发熔断
    const threshold = DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    for (let i = 0; i <= threshold; i++) {
      await funnel.route('模糊输入');
    }
    expect(funnel.isCircuitBreakerActive()).toBe(true);

    // 手动重置
    funnel.resetCircuitBreaker();
    expect(funnel.isCircuitBreakerActive()).toBe(false);
    expect(funnel.getConsecutiveLowConfidence()).toBe(0);
  });

  // ============================================================
  // 测试 10：高置信度命中后重置连续低置信度计数
  // ============================================================
  it('10. 高置信度命中后重置连续低置信度计数', async () => {
    // 先 2 次低置信度，再 1 次高置信度
    const results: RoutingResult[] = [
      { tier: 'simple', confidence: 0.2, source: 'llm' },
      { tier: 'simple', confidence: 0.2, source: 'llm' },
      { tier: 'complex', confidence: 0.9, source: 'llm' },
    ];
    const llmClassifier = makeLLMClassifier(results);
    const funnel = new RoutingFunnel(makeConfig({ llmClassifier }));

    await funnel.route('模糊1');
    await funnel.route('模糊2');
    expect(funnel.getConsecutiveLowConfidence()).toBe(2);

    // 第三次高置信度命中
    const result = await funnel.route('清晰3');
    expect(result.source).toBe('llm');
    // 计数应被重置
    expect(funnel.getConsecutiveLowConfidence()).toBe(0);
  });
});
