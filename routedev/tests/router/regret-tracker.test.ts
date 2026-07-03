// tests/router/regret-tracker.test.ts
// RoutingRegretTracker 累积遗憾自评指标测试

import { describe, it, expect } from 'vitest';
import { RoutingRegretTracker } from '../../src/router/regret-tracker.js';
import { RoutingHistory } from '../../src/router/routing-history.js';
import type { RoutingRecord } from '../../src/router/routing-history.js';

function makeRecord(overrides: Partial<RoutingRecord> = {}): RoutingRecord {
  return {
    taskSignature: 'default-task',
    modelId: 'gpt-4o',
    qualityScore: 0.8,
    tokenCost: 1200,
    latencyMs: 350,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('RoutingRegretTracker', () => {
  it('should return zero regret for single record with no oracle comparison', () => {
    const history = new RoutingHistory();
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm1', qualityScore: 0.8, timestamp: 1000 }));

    const tracker = new RoutingRegretTracker(history);
    const result = tracker.computeCumulativeRegret();

    expect(result.regret).toBe(0);
    expect(result.perModelRegret.size).toBe(1);
    expect(result.perModelRegret.get('m1')).toBe(0);
  });

  it('should accumulate regret when oracle exceeds model quality', () => {
    const history = new RoutingHistory();
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm1', qualityScore: 0.6, timestamp: 1000 }));
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm2', qualityScore: 0.9, timestamp: 2000 }));

    const tracker = new RoutingRegretTracker(history);
    const result = tracker.computeCumulativeRegret();

    expect(result.regret).toBeCloseTo(0.3, 5);
    expect(result.perModelRegret.get('m1')).toBeCloseTo(0.3, 5);
    expect(result.perModelRegret.get('m2')).toBeCloseTo(0, 5);
  });

  it('should compute moving average regret over specified window', () => {
    const history = new RoutingHistory();
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm2', qualityScore: 0.9, timestamp: 1000 }));
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm2', qualityScore: 0.9, timestamp: 2000 }));
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm1', qualityScore: 0.5, timestamp: 3000 }));
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm1', qualityScore: 0.5, timestamp: 4000 }));
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm1', qualityScore: 0.5, timestamp: 5000 }));

    const tracker = new RoutingRegretTracker(history);

    const fullWindow = tracker.computeMovingAverageRegret(5);
    expect(fullWindow).toBeCloseTo(0.24, 2);

    const smallWindow = tracker.computeMovingAverageRegret(2);
    expect(smallWindow).toBeCloseTo(0.4, 2);

    const oneRecord = tracker.computeMovingAverageRegret(1);
    expect(oneRecord).toBeCloseTo(0.4, 2);
  });

  it('should aggregate per-model regret correctly', () => {
    const history = new RoutingHistory();
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm1', qualityScore: 0.5, timestamp: 1000 }));
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm1', qualityScore: 0.5, timestamp: 2000 }));
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm2', qualityScore: 0.9, timestamp: 3000 }));

    const tracker = new RoutingRegretTracker(history);
    const result = tracker.computeCumulativeRegret();

    expect(result.perModelRegret.size).toBe(2);
    expect(result.perModelRegret.get('m1')).toBeCloseTo(0.8, 5);
    expect(result.perModelRegret.get('m2')).toBeCloseTo(0, 5);
    expect(result.regret).toBeCloseTo(0.8, 5);
  });

  it('should return zeros and empty structures for empty history', () => {
    const history = new RoutingHistory();
    const tracker = new RoutingRegretTracker(history);

    const result = tracker.computeCumulativeRegret();
    expect(result.regret).toBe(0);
    expect(result.regretCurve).toEqual([]);
    expect(result.perModelRegret.size).toBe(0);

    expect(tracker.computeMovingAverageRegret()).toBe(0);
    expect(tracker.getRegretByTier().size).toBe(0);
    expect(tracker.getNeighborHitRate()).toBe(0);
  });

  it('should produce one curve point per qualifying record', () => {
    const history = new RoutingHistory();
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm1', qualityScore: 0.5, timestamp: 1000 }));
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm2', qualityScore: 0.7, timestamp: 2000 }));
    history.append(makeRecord({ taskSignature: 'task-1', modelId: 'm3', qualityScore: 0.9, timestamp: 3000 }));

    const tracker = new RoutingRegretTracker(history);
    const result = tracker.computeCumulativeRegret();

    expect(result.regretCurve.length).toBe(3);
    expect(result.regretCurve[0]!.timestamp).toBe(1000);
    expect(result.regretCurve[0]!.cumulativeRegret).toBeCloseTo(0.4, 5);
    expect(result.regretCurve[1]!.timestamp).toBe(2000);
    expect(result.regretCurve[1]!.cumulativeRegret).toBeCloseTo(0.6, 5);
    expect(result.regretCurve[2]!.timestamp).toBe(3000);
    expect(result.regretCurve[2]!.cumulativeRegret).toBeCloseTo(0.6, 5);
  });

  it('should group regret by task tier inferred from signature', () => {
    const history = new RoutingHistory();
    history.append(makeRecord({ taskSignature: 'simple-task', modelId: 'm1', qualityScore: 0.6, timestamp: 1000 }));
    history.append(makeRecord({ taskSignature: 'simple-task', modelId: 'm2', qualityScore: 0.9, timestamp: 2000 }));
    history.append(makeRecord({ taskSignature: 'complex-task', modelId: 'm1', qualityScore: 0.7, timestamp: 3000 }));
    history.append(makeRecord({ taskSignature: 'complex-task', modelId: 'm2', qualityScore: 0.95, timestamp: 4000 }));

    const tracker = new RoutingRegretTracker(history);
    const tierMap = tracker.getRegretByTier();

    expect(tierMap.has('simple')).toBe(true);
    expect(tierMap.has('complex')).toBe(true);
    expect(tierMap.get('simple')).toBeCloseTo(0.15, 2);
    expect(tierMap.get('complex')).toBeCloseTo(0.125, 2);
  });

  it('should compute neighbor hit rate based on embedding presence', () => {
    const history = new RoutingHistory();
    history.append(makeRecord({ taskSignature: 't1', taskEmbedding: [0.1, 0.2, 0.3], timestamp: 1000 }));
    history.append(makeRecord({ taskSignature: 't2', taskEmbedding: [0.4, 0.5, 0.6], timestamp: 2000 }));
    history.append(makeRecord({ taskSignature: 't3', timestamp: 3000 }));
    history.append(makeRecord({ taskSignature: 't4', timestamp: 4000 }));

    const tracker = new RoutingRegretTracker(history);
    expect(tracker.getNeighborHitRate()).toBeCloseTo(0.5, 5);
  });
});
