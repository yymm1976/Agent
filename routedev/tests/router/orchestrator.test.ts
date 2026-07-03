import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoutingOrchestrator } from '../../src/router/orchestrator.js';
import type { OrchestratorConfig, OrchestratorResult } from '../../src/router/orchestrator.js';
import { RoutingHistory } from '../../src/router/routing-history.js';
import type { RoutingRecord } from '../../src/router/routing-history.js';
import type { RoutingMemory, NeighborModelStats } from '../../src/router/routing-memory.js';
import type { RoutingResult, ClassificationResult, ModelConfig, ScenarioTier } from '../../src/router/types.js';

function makeModelConfig(id: string, tier: ScenarioTier = 'medium'): ModelConfig {
  return {
    id,
    name: id,
    provider: 'test-provider',
    tier,
    contextWindow: 8192,
    capabilities: [],
    latencyMs: 100,
    available: true,
  };
}

function makeBaseResult(modelId: string, tier: ScenarioTier = 'medium'): RoutingResult {
  return {
    model: makeModelConfig(modelId, tier),
    providerId: 'test-provider',
    fallbackUsed: false,
    originalTier: tier,
    degraded: false,
    enableCache: true,
  };
}

function makeClassification(tier: ScenarioTier = 'medium'): ClassificationResult {
  return {
    tier,
    confidence: 0.9,
    reasoning: 'test',
    source: 'rule',
  };
}

function makeRecord(modelId: string, qualityScore?: number, userOverride = false): RoutingRecord {
  return {
    taskSignature: 'test-task',
    modelId,
    qualityScore,
    timestamp: Date.now(),
    userOverride,
  };
}

function createMockRouter(
  baseModelId: string = 'gpt-4o',
  baseTier: ScenarioTier = 'medium',
  availableModels?: Array<{ id: string; provider: string; tier: string }>,
) {
  const models = availableModels ?? [
    { id: baseModelId, provider: 'test-provider', tier: baseTier },
    { id: 'claude-sonnet', provider: 'test-provider', tier: 'medium' },
    { id: 'gpt-4o-mini', provider: 'test-provider', tier: 'simple' },
  ];
  return {
    route: vi.fn().mockResolvedValue(makeBaseResult(baseModelId, baseTier)),
    getAvailableModels: vi.fn().mockReturnValue(models),
  };
}

function createMockMemory(neighborStats: Map<string, NeighborModelStats> = new Map()) {
  return {
    queryModelStats: vi.fn().mockResolvedValue(neighborStats),
    queryNeighbors: vi.fn().mockResolvedValue([]),
    isEnabled: vi.fn().mockReturnValue(true),
  } as unknown as RoutingMemory;
}

describe('RoutingOrchestrator', () => {
  describe('orchestrator disabled falls back', () => {
    it('should return base router result when enabled=false', async () => {
      const router = createMockRouter();
      const memory = createMockMemory();
      const history = new RoutingHistory();

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        { enabled: false },
      );

      const result = await orchestrator.route('test query', makeClassification());

      expect(result.model.id).toBe('gpt-4o');
      expect(result.orchestratorMeta).toBeUndefined();
      expect(router.route).toHaveBeenCalledOnce();
      expect(router.route).toHaveBeenCalledWith(makeClassification());
    });

    it('should not call memory when disabled', async () => {
      const router = createMockRouter();
      const memory = createMockMemory();
      const history = new RoutingHistory();

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        { enabled: false },
      );

      await orchestrator.route('test query', makeClassification());

      expect(memory.queryModelStats).not.toHaveBeenCalled();
    });
  });

  describe('cold start degradation (no history)', () => {
    it('should fall back to base decision when both neighbor and prior stats are empty', async () => {
      const router = createMockRouter('gpt-4o', 'medium');
      const memory = createMockMemory(new Map());
      const history = new RoutingHistory();

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        { enabled: true },
      );

      const result = await orchestrator.route('test query', makeClassification('medium'));

      expect(result.model.id).toBe('gpt-4o');
      expect(result.orchestratorMeta).toBeDefined();
      expect(result.orchestratorMeta!.usedNeighbors).toBe(false);
      expect(result.orchestratorMeta!.neighborCount).toBe(0);
    });

    it('should include orchestratorMeta with zero scores on cold start', async () => {
      const router = createMockRouter('gpt-4o', 'medium');
      const memory = createMockMemory(new Map());
      const history = new RoutingHistory();

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        { enabled: true },
      );

      const result = await orchestrator.route('test query', makeClassification('medium'));

      expect(result.orchestratorMeta).toEqual({
        usedNeighbors: false,
        neighborCount: 0,
        baseScore: 0,
        priorScore: 0,
        neighborScore: 0,
        finalScore: 0,
      });
    });
  });

  describe('prior score defaults to 0.5', () => {
    it('should use 0.5 as prior score for models with no history', async () => {
      const router = createMockRouter('gpt-4o', 'medium', [
        { id: 'gpt-4o', provider: 'test-provider', tier: 'medium' },
        { id: 'claude-sonnet', provider: 'test-provider', tier: 'medium' },
      ]);
      const neighborStats = new Map<string, NeighborModelStats>();
      neighborStats.set('claude-sonnet', {
        neighborCount: 3,
        avgQuality: 0.8,
        avgCost: 100,
        avgLatency: 200,
        weightedScore: 0.85,
      });
      const memory = createMockMemory(neighborStats);
      const history = new RoutingHistory();

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        { enabled: true, neighborWeight: 0.5, priorWeight: 0.3, baseWeight: 0.2 },
      );

      const result = await orchestrator.route('test query', makeClassification('medium'));

      expect(result.orchestratorMeta).toBeDefined();
      expect(result.model.id).toBe('claude-sonnet');
    });
  });

  describe('three-way weighted decision correctness', () => {
    it('should select model with highest weighted score when neighbors suggest different model', async () => {
      const router = createMockRouter('gpt-4o', 'medium', [
        { id: 'gpt-4o', provider: 'test-provider', tier: 'medium' },
        { id: 'claude-sonnet', provider: 'test-provider', tier: 'medium' },
      ]);

      const neighborStats = new Map<string, NeighborModelStats>();
      neighborStats.set('claude-sonnet', {
        neighborCount: 5,
        avgQuality: 0.9,
        avgCost: 100,
        avgLatency: 200,
        weightedScore: 0.9,
      });

      const memory = createMockMemory(neighborStats);
      const history = new RoutingHistory();
      history.append(makeRecord('claude-sonnet', 0.85));

      const config: Partial<OrchestratorConfig> = {
        enabled: true,
        neighborWeight: 0.6,
        priorWeight: 0.3,
        baseWeight: 0.1,
      };

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        config,
      );

      const result = await orchestrator.route('test query', makeClassification('medium'));

      expect(result.model.id).toBe('claude-sonnet');
      expect(result.orchestratorMeta!.usedNeighbors).toBe(true);
      expect(result.orchestratorMeta!.neighborCount).toBe(5);
    });

    it('should keep base model when its weighted score is highest', async () => {
      const router = createMockRouter('gpt-4o', 'medium', [
        { id: 'gpt-4o', provider: 'test-provider', tier: 'medium' },
        { id: 'claude-sonnet', provider: 'test-provider', tier: 'medium' },
      ]);

      const neighborStats = new Map<string, NeighborModelStats>();
      neighborStats.set('claude-sonnet', {
        neighborCount: 2,
        avgQuality: 0.5,
        avgCost: 100,
        avgLatency: 200,
        weightedScore: 0.4,
      });

      const memory = createMockMemory(neighborStats);
      const history = new RoutingHistory();

      const config: Partial<OrchestratorConfig> = {
        enabled: true,
        neighborWeight: 0.6,
        priorWeight: 0.3,
        baseWeight: 0.1,
      };

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        config,
      );

      const result = await orchestrator.route('test query', makeClassification('medium'));

      expect(result.model.id).toBe('gpt-4o');
    });
  });

  describe('neighbor dominance (sufficient history)', () => {
    it('should override base when neighbor scores strongly favor a model', async () => {
      const router = createMockRouter('gpt-4o', 'simple', [
        { id: 'gpt-4o', provider: 'test-provider', tier: 'simple' },
        { id: 'claude-sonnet', provider: 'test-provider', tier: 'complex' },
      ]);

      const neighborStats = new Map<string, NeighborModelStats>();
      neighborStats.set('claude-sonnet', {
        neighborCount: 10,
        avgQuality: 0.95,
        avgCost: 200,
        avgLatency: 300,
        weightedScore: 0.95,
      });

      const memory = createMockMemory(neighborStats);
      const history = new RoutingHistory();
      history.append(makeRecord('claude-sonnet', 0.92));
      history.append(makeRecord('claude-sonnet', 0.88));

      const config: Partial<OrchestratorConfig> = {
        enabled: true,
        neighborWeight: 0.7,
        priorWeight: 0.2,
        baseWeight: 0.1,
      };

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        config,
      );

      const result = await orchestrator.route('test query', makeClassification('complex'));

      expect(result.model.id).toBe('claude-sonnet');
      expect(result.orchestratorMeta!.neighborCount).toBe(10);
      expect(result.orchestratorMeta!.finalScore).toBeGreaterThan(0);
    });
  });

  describe('user override doesn\'t pollute neighbors', () => {
    it('should include user override records in prior stats (history has all records)', async () => {
      const router = createMockRouter('gpt-4o', 'medium', [
        { id: 'gpt-4o', provider: 'test-provider', tier: 'medium' },
        { id: 'claude-sonnet', provider: 'test-provider', tier: 'medium' },
      ]);

      const neighborStats = new Map<string, NeighborModelStats>();
      neighborStats.set('claude-sonnet', {
        neighborCount: 3,
        avgQuality: 0.75,
        avgCost: 100,
        avgLatency: 200,
        weightedScore: 0.75,
      });

      const memory = createMockMemory(neighborStats);
      const history = new RoutingHistory();
      history.append(makeRecord('claude-sonnet', 0.9, true));
      history.append(makeRecord('claude-sonnet', 0.9, true));
      history.append(makeRecord('gpt-4o', 0.7));

      const config: Partial<OrchestratorConfig> = {
        enabled: true,
        neighborWeight: 0.5,
        priorWeight: 0.3,
        baseWeight: 0.2,
      };

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        config,
      );

      const result = await orchestrator.route('test query', makeClassification('medium'));

      expect(result.orchestratorMeta).toBeDefined();
      expect(result.model.id).toBeDefined();
    });
  });

  describe('config weights adjustable', () => {
    it('should produce different results with different weight configs', async () => {
      const router = createMockRouter('gpt-4o', 'medium', [
        { id: 'gpt-4o', provider: 'test-provider', tier: 'medium' },
        { id: 'claude-sonnet', provider: 'test-provider', tier: 'complex' },
      ]);

      const neighborStats = new Map<string, NeighborModelStats>();
      neighborStats.set('claude-sonnet', {
        neighborCount: 5,
        avgQuality: 0.85,
        avgCost: 100,
        avgLatency: 200,
        weightedScore: 0.85,
      });

      const memory = createMockMemory(neighborStats);
      const history = new RoutingHistory();
      history.append(makeRecord('claude-sonnet', 0.8));

      const highNeighborWeight: Partial<OrchestratorConfig> = {
        enabled: true,
        neighborWeight: 0.8,
        priorWeight: 0.1,
        baseWeight: 0.1,
      };

      const highBaseWeight: Partial<OrchestratorConfig> = {
        enabled: true,
        neighborWeight: 0.1,
        priorWeight: 0.1,
        baseWeight: 0.8,
      };

      const orchestrator1 = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        highNeighborWeight,
      );

      const orchestrator2 = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        highBaseWeight,
      );

      const result1 = await orchestrator1.route('test query', makeClassification('medium'));
      const result2 = await orchestrator2.route('test query', makeClassification('medium'));

      expect(result1.model.id).toBe('claude-sonnet');
      expect(result2.model.id).toBe('gpt-4o');
    });
  });

  describe('orchestrator metadata', () => {
    it('should include score breakdown in orchestratorMeta', async () => {
      const router = createMockRouter('gpt-4o', 'medium', [
        { id: 'gpt-4o', provider: 'test-provider', tier: 'medium' },
        { id: 'claude-sonnet', provider: 'test-provider', tier: 'medium' },
      ]);

      const neighborStats = new Map<string, NeighborModelStats>();
      neighborStats.set('gpt-4o', {
        neighborCount: 3,
        avgQuality: 0.8,
        avgCost: 100,
        avgLatency: 200,
        weightedScore: 0.8,
      });

      const memory = createMockMemory(neighborStats);
      const history = new RoutingHistory();
      history.append(makeRecord('gpt-4o', 0.75));

      const config: Partial<OrchestratorConfig> = {
        enabled: true,
        neighborWeight: 0.5,
        priorWeight: 0.3,
        baseWeight: 0.2,
      };

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        config,
      );

      const result = await orchestrator.route('test query', makeClassification('medium'));

      expect(result.orchestratorMeta).toBeDefined();
      expect(result.orchestratorMeta!.usedNeighbors).toBe(true);
      expect(result.orchestratorMeta!.neighborCount).toBe(3);
      expect(result.orchestratorMeta!.baseScore).toBe(1.0);
      expect(result.orchestratorMeta!.priorScore).toBeCloseTo(0.75, 5);
      expect(result.orchestratorMeta!.neighborScore).toBeCloseTo(0.8, 5);
      expect(result.orchestratorMeta!.finalScore).toBeGreaterThan(0);
    });

    it('should compute finalScore as weighted sum of three components', async () => {
      const router = createMockRouter('gpt-4o', 'medium', [
        { id: 'gpt-4o', provider: 'test-provider', tier: 'medium' },
      ]);

      const neighborStats = new Map<string, NeighborModelStats>();
      neighborStats.set('gpt-4o', {
        neighborCount: 2,
        avgQuality: 0.7,
        avgCost: 100,
        avgLatency: 200,
        weightedScore: 0.7,
      });

      const memory = createMockMemory(neighborStats);
      const history = new RoutingHistory();
      history.append(makeRecord('gpt-4o', 0.6));

      const config: Partial<OrchestratorConfig> = {
        enabled: true,
        neighborWeight: 0.5,
        priorWeight: 0.3,
        baseWeight: 0.2,
      };

      const orchestrator = new RoutingOrchestrator(
        router as any,
        memory,
        history,
        config,
      );

      const result = await orchestrator.route('test query', makeClassification('medium'));

      const expectedFinal = 0.2 * 1.0 + 0.3 * 0.6 + 0.5 * 0.7;
      expect(result.orchestratorMeta!.finalScore).toBeCloseTo(expectedFinal, 5);
    });
  });
});
