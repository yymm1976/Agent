// tests/agent/multi/parallel-executor.test.ts
// Phase 69 Task 2: 并行执行引擎测试

import { describe, it, expect, vi } from 'vitest';
import { ParallelExecutor, DEFAULT_PARALLEL_CONFIG } from '../../../src/agent/multi/parallel-executor.js';

describe('ParallelExecutor', () => {
  it('should execute serially when config disabled', async () => {
    const config = { ...DEFAULT_PARALLEL_CONFIG, enabled: false };
    const executor = new ParallelExecutor(config, '/test');
    const executionOrder: string[] = [];
    
    const workerFn = vi.fn(async (workerId: string) => {
      executionOrder.push(workerId);
      return `result-${workerId}`;
    });
    
    const tasks = [
      { workerId: 'w1', task: { description: 'task1' } },
      { workerId: 'w2', task: { description: 'task2' } },
      { workerId: 'w3', task: { description: 'task3' } },
    ];
    
    const results = await executor.executeParallel(tasks, workerFn);
    
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ success: true, workerId: 'w1', result: 'result-w1' });
    expect(results[1]).toEqual({ success: true, workerId: 'w2', result: 'result-w2' });
    expect(results[2]).toEqual({ success: true, workerId: 'w3', result: 'result-w3' });
    expect(executionOrder).toEqual(['w1', 'w2', 'w3']);
    expect(workerFn).toHaveBeenCalledTimes(3);
  });

  it('should execute parallel when config enabled', async () => {
    const config = { ...DEFAULT_PARALLEL_CONFIG, enabled: true, maxConcurrency: 2 };
    const executor = new ParallelExecutor(config, '/test');
    
    const workerFn = vi.fn(async (workerId: string) => {
      return `result-${workerId}`;
    });
    
    const tasks = [
      { workerId: 'w1', task: { description: 'task1' } },
      { workerId: 'w2', task: { description: 'task2' } },
    ];
    
    const results = await executor.executeParallel(tasks, workerFn);
    
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ success: true, workerId: 'w1', result: 'result-w1' });
    expect(results[1]).toEqual({ success: true, workerId: 'w2', result: 'result-w2' });
    expect(workerFn).toHaveBeenCalledTimes(2);
  });

  it('should respect maxConcurrency limit (chunking)', async () => {
    const config = { ...DEFAULT_PARALLEL_CONFIG, enabled: true, maxConcurrency: 2 };
    const executor = new ParallelExecutor(config, '/test');
    
    const concurrentCalls = { current: 0, max: 0 };
    
    const workerFn = vi.fn(async (workerId: string) => {
      concurrentCalls.current++;
      concurrentCalls.max = Math.max(concurrentCalls.max, concurrentCalls.current);
      await new Promise(resolve => setTimeout(resolve, 10));
      concurrentCalls.current--;
      return `result-${workerId}`;
    });
    
    const tasks = [
      { workerId: 'w1', task: { description: 'task1' } },
      { workerId: 'w2', task: { description: 'task2' } },
      { workerId: 'w3', task: { description: 'task3' } },
      { workerId: 'w4', task: { description: 'task4' } },
    ];
    
    const results = await executor.executeParallel(tasks, workerFn);
    
    expect(results).toHaveLength(4);
    expect(concurrentCalls.max).toBeLessThanOrEqual(2);
    expect(workerFn).toHaveBeenCalledTimes(4);
  });

  it('should handle worker timeout', async () => {
    const config = { ...DEFAULT_PARALLEL_CONFIG, enabled: true, workerTimeoutMs: 50 };
    const executor = new ParallelExecutor(config, '/test');
    
    const workerFn = vi.fn(async (workerId: string) => {
      if (workerId === 'slow') {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return `result-${workerId}`;
    });
    
    const tasks = [
      { workerId: 'fast', task: { description: 'task1' } },
      { workerId: 'slow', task: { description: 'task2' } },
    ];
    
    const results = await executor.executeParallel(tasks, workerFn);
    
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ success: true, workerId: 'fast', result: 'result-fast' });
    expect(results[1]).toEqual({ success: false, workerId: 'slow', error: 'Worker timeout (50ms)' });
  });

  it('should continue with other workers when one fails', async () => {
    const config = { ...DEFAULT_PARALLEL_CONFIG, enabled: true, maxConcurrency: 3 };
    const executor = new ParallelExecutor(config, '/test');
    
    const workerFn = vi.fn(async (workerId: string) => {
      if (workerId === 'fail') {
        throw new Error('Worker failed');
      }
      return `result-${workerId}`;
    });
    
    const tasks = [
      { workerId: 'w1', task: { description: 'task1' } },
      { workerId: 'fail', task: { description: 'task2' } },
      { workerId: 'w3', task: { description: 'task3' } },
    ];
    
    const results = await executor.executeParallel(tasks, workerFn);
    
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ success: true, workerId: 'w1', result: 'result-w1' });
    expect(results[1]).toEqual({ success: false, workerId: 'fail', error: 'Worker failed' });
    expect(results[2]).toEqual({ success: true, workerId: 'w3', result: 'result-w3' });
  });

  it('should handle empty tasks array', async () => {
    const config = { ...DEFAULT_PARALLEL_CONFIG, enabled: true };
    const executor = new ParallelExecutor(config, '/test');
    
    const workerFn = vi.fn(async () => 'result');
    
    const results = await executor.executeParallel([], workerFn);
    
    expect(results).toHaveLength(0);
    expect(workerFn).not.toHaveBeenCalled();
  });
});