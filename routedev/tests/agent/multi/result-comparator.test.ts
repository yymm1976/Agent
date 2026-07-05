// tests/agent/multi/result-comparator.test.ts
// Phase 69 Task 3: 结果比较器测试

import { describe, it, expect, vi } from 'vitest';
import { ResultComparator, DEFAULT_COMPARATOR_CONFIG } from '../../../src/agent/multi/result-comparator.js';
import type { ParallelOutcome } from '../../../src/agent/multi/types.js';

vi.mock('../../../src/utils/token-estimate.js', () => ({
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn() },
}));

describe('ResultComparator', () => {
  it('should select single successful result directly', async () => {
    const config = { ...DEFAULT_COMPARATOR_CONFIG };
    const comparator = new ResultComparator(config);
    
    const outcomes: ParallelOutcome[] = [
      { success: true, workerId: 'w1', result: 'result1' },
      { success: false, workerId: 'w2', error: 'failed' },
    ];
    
    const result = comparator.compare(outcomes);
    
    expect(result.winnerId).toBe('w1');
    expect(result.reason).toBe('only successful worker');
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]).toEqual({ workerId: 'w1', score: 1, summary: 'only success' });
    expect(result.needsHumanReview).toBe(false);
  });

  it('should rank multiple successful results by score', async () => {
    const config = { ...DEFAULT_COMPARATOR_CONFIG, autoSelect: true };
    const comparator = new ResultComparator(config);
    
    const outcomes: ParallelOutcome[] = [
      { success: true, workerId: 'w1', result: 'short' },
      { success: true, workerId: 'w2', result: 'a much longer result that should have lower score' },
    ];
    
    const result = comparator.compare(outcomes);
    
    expect(result.winnerId).toBe('w1');
    expect(result.reason).toContain('highest score');
    expect(result.scores).toHaveLength(2);
    expect(result.scores[0].workerId).toBe('w1');
    expect(result.scores[1].workerId).toBe('w2');
    expect(result.scores[0].score).toBeGreaterThan(result.scores[1].score);
    expect(result.needsHumanReview).toBe(false);
  });

  it('should handle all failed outcomes', async () => {
    const config = { ...DEFAULT_COMPARATOR_CONFIG };
    const comparator = new ResultComparator(config);
    
    const outcomes: ParallelOutcome[] = [
      { success: false, workerId: 'w1', error: 'failed1' },
      { success: false, workerId: 'w2', error: 'failed2' },
    ];
    
    const result = comparator.compare(outcomes);
    
    expect(result.winnerId).toBe('');
    expect(result.reason).toBe('all workers failed');
    expect(result.scores).toHaveLength(0);
    expect(result.needsHumanReview).toBe(true);
  });

  it('should set needsHumanReview=true when autoSelect=false', async () => {
    const config = { ...DEFAULT_COMPARATOR_CONFIG, autoSelect: false };
    const comparator = new ResultComparator(config);
    
    const outcomes: ParallelOutcome[] = [
      { success: true, workerId: 'w1', result: 'result1' },
      { success: true, workerId: 'w2', result: 'result2' },
    ];
    
    const result = comparator.compare(outcomes);
    
    expect(result.winnerId).toBe('w1');
    expect(result.needsHumanReview).toBe(true);
  });

  it('should call mergeWinner correctly', async () => {
    const config = { ...DEFAULT_COMPARATOR_CONFIG };
    const comparator = new ResultComparator(config);
    
    await comparator.mergeWinner('w1', '/winner/path', '/main/path');
    
    const { logger } = await import('../../../src/utils/logger.js');
    expect(logger.info).toHaveBeenCalledWith(
      'ResultComparator: merging winner',
      { winnerId: 'w1', from: '/winner/path', to: '/main/path' }
    );
  });
});