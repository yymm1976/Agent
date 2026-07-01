// tests/phase32/agent-eval.test.ts
// Phase 32 Task 3：Agent 行为 Eval 最小版本
// 覆盖：分类器黄金集 + 降级链正确性 + ConflictDetector 盲区记录

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScenarioClassifier } from '../../src/router/classifier.js';
import { ModelRouter } from '../../src/router/router.js';
import { TokenTracker } from '../../src/router/tracker.js';
import { ConflictDetector } from '../../src/agent/multi/conflict.js';
import type { StepDependency } from '../../src/agent/multi/types.js';
import type { RouterConfig } from '../../src/router/types.js';
import type { ProviderConfig } from '../../src/config/schema.js';
import type { ScenarioTier } from '../../src/router/types.js';

// ============================================================
// Task 3.1：分类器黄金测试集
// ============================================================

// 加载黄金数据集
const goldenDataset = JSON.parse(
  readFileSync(resolve(__dirname, '../eval/classifier-golden.json'), 'utf-8'),
) as Array<{ input: string; expected: ScenarioTier; note: string }>;

describe('Phase 32 Task 3.1: Classifier Golden Dataset Eval', () => {
  // 无 LLM 客户端的分类器——仅使用规则引擎 + 关键词 + 长度启发式
  const classifier = new ScenarioClassifier({
    classifierModel: 'gpt-4o-mini',
    // llmClient 不设置——强制走规则路径，保证测试确定性
  });

  // 统计准确率
  let correctCount = 0;

  for (const testCase of goldenDataset) {
    it(`分类: ${testCase.note} → ${testCase.expected}`, async () => {
      const result = await classifier.classify({ query: testCase.input });
      if (result.tier === testCase.expected) correctCount++;
      expect(result.tier).toBe(testCase.expected);
    });
  }

  // 汇总测试：验证整体准确率 ≥ 80%
  it('黄金集整体准确率 ≥ 80%', () => {
    const accuracy = correctCount / goldenDataset.length;
    // 由于每个 case 都是独立 it，correctCount 在所有 it 执行完后才完整
    // 这里验证的是数据集本身的质量：所有 case 都应通过（100%）
    expect(accuracy).toBeGreaterThanOrEqual(0.8);
  });
});

// ============================================================
// Task 3.2：降级链正确性 Eval
// ============================================================

function createRouterConfig(): RouterConfig {
  return {
    rules: [
      { tier: 'simple', modelId: 'gpt-4o-mini', fallbackModelId: 'gpt-4o' },
      { tier: 'medium', modelId: 'gpt-4o', fallbackModelId: 'gpt-4o-mini' },
      { tier: 'complex', modelId: 'claude-sonnet-4-20250514', fallbackModelId: 'gpt-4o' },
      { tier: 'reasoning', modelId: 'o3', fallbackModelId: 'claude-sonnet-4-20250514' },
    ],
    budget: { dailyLimitTokens: 1000000, warningThreshold: 0.8 },
    fallback: { enabled: true, modelId: 'gpt-4o-mini' },
  } as any;
}

function createProviders(apiKey: string, models: Array<{ id: string; name: string }>): ProviderConfig[] {
  return [
    {
      id: 'openai',
      name: 'OpenAI',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey,
      models: models.map(m => ({ id: m.id, name: m.name, contextWindow: 128000, maxOutputTokens: 16384 })),
    },
  ] as any;
}

/** 创建多 provider 配置（用于降级链测试：不同 provider 不同 apiKey 状态） */
function createMultiProviders(
  providerSpecs: Array<{ id: string; apiKey: string; models: Array<{ id: string; name: string }> }>,
): ProviderConfig[] {
  return providerSpecs.map(spec => ({
    id: spec.id,
    name: spec.id,
    protocol: 'openai',
    baseUrl: `https://api.${spec.id}.com/v1`,
    apiKey: spec.apiKey,
    models: spec.models.map(m => ({ id: m.id, name: m.name, contextWindow: 128000, maxOutputTokens: 16384 })),
  })) as any;
}

function createTracker(): TokenTracker {
  return new TokenTracker({
    dailyLimit: 1000000,
    degradationThreshold: 0.8,
    warningThreshold: 0.7,
    mode: 'track_only',
  } as any);
}

describe('Phase 32 Task 3.2: Degradation Chain Eval', () => {
  const classification = {
    tier: 'reasoning' as ScenarioTier,
    confidence: 0.9,
    reasoning: 'test',
    source: 'rule' as const,
  };

  it('reasoning tier → 主模型可用时直接使用（无降级）', async () => {
    const tracker = createTracker();
    const providers = createProviders('sk-real-key', [
      { id: 'o3', name: 'o3' },
      { id: 'gpt-4o', name: 'gpt-4o' },
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
    ]);
    const router = new ModelRouter(createRouterConfig(), tracker, providers);

    const result = await router.route(classification);
    expect(result.degraded).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(result.model.id).toBe('o3');
  });

  it('reasoning tier → 主模型不可用 → fallback 模型', async () => {
    const tracker = createTracker();
    // o3 → provider openai（启发式推断），apiKey 为空 → 不可用
    // claude-sonnet-4-20250514 → provider anthropic（启发式推断），apiKey 有效 → 可用
    const providers = createMultiProviders([
      { id: 'openai', apiKey: '', models: [{ id: 'o3', name: 'o3' }, { id: 'gpt-4o', name: 'gpt-4o' }, { id: 'gpt-4o-mini', name: 'gpt-4o-mini' }] },
      { id: 'anthropic', apiKey: 'sk-real-anthropic-key', models: [{ id: 'claude-sonnet-4-20250514', name: 'claude-sonnet-4-20250514' }] },
    ]);
    const router = new ModelRouter(createRouterConfig(), tracker, providers);

    const result = await router.route(classification);
    expect(result.degraded).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.model.id).toBe('claude-sonnet-4-20250514');
  });

  it('reasoning tier → 主+fallback 不可用 → 仍返回一个可用模型', async () => {
    const tracker = createTracker();
    const providers = createMultiProviders([
      { id: 'openai', apiKey: '', models: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }] },
      { id: 'anthropic', apiKey: '', models: [{ id: 'claude-sonnet-4-20250514', name: 'claude-sonnet-4-20250514' }] },
    ]);
    const router = new ModelRouter(createRouterConfig(), tracker, providers);

    const result = await router.route(classification);
    expect(result.degraded).toBe(true);
    expect(result.model).toBeDefined();
  });

  it('所有 provider 不可用（apiKey 为空）→ 路由仍给出降级结果', async () => {
    const tracker = createTracker();
    const providers = createProviders('', [
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
    ]);
    const router = new ModelRouter(createRouterConfig(), tracker, providers);

    const result = await router.route(classification);
    expect(result.degraded).toBe(true);
    expect(result.model).toBeDefined();
  });

  it('apiKey 为 placeholder → 模型不可用并降级返回结果', async () => {
    const tracker = createTracker();
    const providers = createProviders('placeholder', [
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
    ]);
    const router = new ModelRouter(createRouterConfig(), tracker, providers);

    const result = await router.route({
      tier: 'simple',
      confidence: 0.9,
      reasoning: 'test',
      source: 'rule',
    });
    expect(result.degraded).toBe(true);
    expect(result.model).toBeDefined();
  });
});

// ============================================================
// Task 3.3：ConflictDetector 已知盲区记录
// ============================================================

describe('Phase 32 Task 3.3: ConflictDetector Known Blind Spots', () => {
  it('不同文件但语义冲突 → 当前检测不到（已知限制）', () => {
    // 场景：步骤 A 修改 getUser 签名，步骤 B 调用 getUser
    // 两者操作不同文件，但存在语义依赖
    // ConflictDetector 只检查文件路径重叠，不检查语义冲突
    const cd = new ConflictDetector();
    const deps: StepDependency[] = [
      { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: ['utils.ts'] },
      { stepId: 2, dependsOn: [], assignedRole: 'coder', likelyFiles: ['service.ts'] },
    ];

    const result = cd.detect([1, 2], deps);

    // 已知盲区：不同文件不报冲突，即使存在语义依赖
    expect(result.hasConflict).toBe(false);
  });

  it('相同文件 → 正确检测冲突（基线验证）', () => {
    // 基线：相同文件应被检测为冲突
    const cd = new ConflictDetector();
    const deps: StepDependency[] = [
      { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: ['config.ts'] },
      { stepId: 2, dependsOn: [], assignedRole: 'coder', likelyFiles: ['config.ts'] },
    ];

    const result = cd.detect([1, 2], deps);

    expect(result.hasConflict).toBe(true);
    expect(result.conflictingFiles).toContain('config.ts');
  });

  it('likelyFiles 为空时无法检测冲突（已知限制）', () => {
    // 场景：步骤描述中未提及文件路径
    // ConflictDetector 无法检测冲突
    const cd = new ConflictDetector();
    const deps: StepDependency[] = [
      { stepId: 1, dependsOn: [], assignedRole: 'coder', likelyFiles: [] },
      { stepId: 2, dependsOn: [], assignedRole: 'coder', likelyFiles: [] },
    ];

    const result = cd.detect([1, 2], deps);

    // 已知盲区：无文件路径信息时不报冲突
    expect(result.hasConflict).toBe(false);
  });
});
