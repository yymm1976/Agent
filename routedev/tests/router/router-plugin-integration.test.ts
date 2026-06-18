// tests/router/router-plugin-integration.test.ts
// Phase 27 Task 2：RouterPlugin 集成测试
// 验证 ModelRouter.route() 优先询问 RouterPlugin，插件返回 null 时 fallback 到默认路由

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModelRouter } from '../../src/router/router.js';
import { TokenTracker } from '../../src/router/tracker.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { AgentMiddlewarePipeline } from '../../src/agent/middleware.js';
import type { RouterConfig, ClassificationResult, TokenBudget, RouteDecision } from '../../src/router/types.js';
import type { RouterPlugin } from '../../src/plugins/types.js';

/** 构造测试用 RouterConfig */
function makeConfig(): RouterConfig {
  const budget: TokenBudget = {
    mode: 'enforce',
    dailyLimit: 1000000,
    degradationThreshold: 0.8,
  };
  return {
    rules: [
      { tier: 'simple', modelId: 'gpt-4o-mini', fallbackModelId: 'gpt-4o' },
      { tier: 'medium', modelId: 'gpt-4o', fallbackModelId: 'gpt-4o-mini' },
      { tier: 'complex', modelId: 'o3-mini', fallbackModelId: 'gpt-4o' },
      { tier: 'reasoning', modelId: 'o3', fallbackModelId: 'o3-mini' },
    ],
    budget,
    classifierModel: 'gpt-4o-mini',
    userPreference: 'balanced',
  };
}

/** 构造一个 mock RouterPlugin */
function makeRouterPlugin(
  routeFn: (classification: ClassificationResult) => Promise<RouteDecision | null>,
): RouterPlugin {
  return {
    id: 'router-test',
    name: 'test-router',
    version: '1.0.0',
    type: 'router',
    enabled: true,
    async init() {},
    async destroy() {},
    async classify() {
      return null;
    },
    async route(classification) {
      return routeFn(classification);
    },
  };
}

/** 构造一个空 PluginRegistry，并通过反射注入插件 */
function makeRegistryWithPlugin(plugin: RouterPlugin): PluginRegistry {
  const reg = new PluginRegistry({
    globalPluginDirs: [],
    projectPluginDir: '/nonexistent',
    toolRegistry: new ToolRegistry(),
    middlewarePipeline: new AgentMiddlewarePipeline(),
    cwd: '/test',
  });
  // 通过反射注入插件记录（绕过 discover/loadPlugin 流程）
  (reg as unknown as { plugins: Map<string, unknown> }).plugins.set(plugin.id, {
    instance: plugin,
    manifest: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      type: 'router',
      entry: 'index.js',
    },
    pluginDir: '/test',
    loaded: true,
    registeredToolNames: [],
    registeredHookPhases: [],
    registeredHookHandlers: [],
  });
  (reg as unknown as { loadOrder: string[] }).loadOrder.push(plugin.id);
  return reg;
}

describe('Phase 27 Task 2: RouterPlugin 集成', () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker({
      mode: 'enforce',
      dailyLimit: 1000000,
      degradationThreshold: 0.8,
    });
  });

  afterEach(() => {
    tracker.destroy();
  });

  // 测试 1：插件返回决策时，路由器使用插件选中的模型
  it('插件返回决策时，路由器使用插件选中的模型', async () => {
    const config = makeConfig();
    // 插件总是选择 o3（reasoning tier 的模型），不论分类结果
    const plugin = makeRouterPlugin(async () => ({
      modelId: 'o3',
      providerId: 'openai',
      reason: 'plugin override',
    }));
    const registry = makeRegistryWithPlugin(plugin);
    const router = new ModelRouter(config, tracker, [], registry);

    const classification: ClassificationResult = {
      tier: 'simple',
      confidence: 0.9,
      reasoning: 'Simple task',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('o3');
    expect(result.degraded).toBe(false);
    expect(result.fallbackUsed).toBe(false);
  });

  // 测试 2：插件返回 null 时，fallback 到默认路由逻辑
  it('插件返回 null 时，fallback 到默认路由逻辑', async () => {
    const config = makeConfig();
    const plugin = makeRouterPlugin(async () => null);
    const registry = makeRegistryWithPlugin(plugin);
    const router = new ModelRouter(config, tracker, [], registry);

    const classification: ClassificationResult = {
      tier: 'simple',
      confidence: 0.9,
      reasoning: 'Simple task',
      source: 'rule',
    };
    const result = await router.route(classification);
    // 默认路由：simple tier → gpt-4o-mini
    expect(result.model.id).toBe('gpt-4o-mini');
    expect(result.degraded).toBe(false);
  });

  // 测试 3：未传入 pluginRegistry 时，走默认路由（向后兼容）
  it('未传入 pluginRegistry 时走默认路由', async () => {
    const config = makeConfig();
    const router = new ModelRouter(config, tracker);

    const classification: ClassificationResult = {
      tier: 'medium',
      confidence: 0.8,
      reasoning: 'Medium task',
      source: 'rule',
    };
    const result = await router.route(classification);
    expect(result.model.id).toBe('gpt-4o');
  });

  // 测试 4：插件 route() 抛异常时，fallback 到默认路由不崩溃
  it('插件 route() 抛异常时 fallback 到默认路由', async () => {
    const config = makeConfig();
    const plugin = makeRouterPlugin(async () => {
      throw new Error('plugin route error');
    });
    const registry = makeRegistryWithPlugin(plugin);
    const router = new ModelRouter(config, tracker, [], registry);

    const classification: ClassificationResult = {
      tier: 'complex',
      confidence: 0.75,
      reasoning: 'Complex task',
      source: 'rule',
    };
    const result = await router.route(classification);
    // 插件异常后 fallback：complex tier → o3-mini
    expect(result.model.id).toBe('o3-mini');
  });
});
