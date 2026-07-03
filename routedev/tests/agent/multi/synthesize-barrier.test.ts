import { describe, it, expect, vi } from 'vitest';
import { SynthesizeBarrier } from '../../../src/agent/multi/synthesize-barrier.js';
import type { FanOutResult } from '../../../src/agent/multi/synthesize-barrier.js';

describe('SynthesizeBarrier', () => {
  describe('merge-fields strategy', () => {
    it('同名字段取首个非空值', async () => {
      const barrier = new SynthesizeBarrier();
      const results: FanOutResult<Record<string, unknown>>[] = [
        { workerId: 'w1', success: true, data: { name: 'Alice', age: null }, durationMs: 100 },
        { workerId: 'w2', success: true, data: { name: 'Bob', age: 30 }, durationMs: 120 },
      ];
      const output = await barrier.synthesize(results, { strategy: 'merge-fields' });
      const merged = output.merged as Record<string, unknown>;
      expect(merged.name).toBe('Alice');
      expect(merged.age).toBe(30);
    });

    it('失败 worker 的 failedReason 被记录在 _failedWorkers 字段', async () => {
      const barrier = new SynthesizeBarrier();
      const results: FanOutResult<Record<string, unknown>>[] = [
        { workerId: 'w1', success: true, data: { key: 'value' }, durationMs: 100 },
        { workerId: 'w2', success: false, failedReason: 'timeout', durationMs: 200 },
      ];
      const output = await barrier.synthesize(results, { strategy: 'merge-fields' });
      const merged = output.merged as Record<string, unknown>;
      expect(Array.isArray(merged['_failedWorkers'])).toBe(true);
      const failed = merged['_failedWorkers'] as Array<{ workerId: string; reason: string }>;
      expect(failed[0].workerId).toBe('w2');
      expect(failed[0].reason).toBe('timeout');
    });
  });

  describe('concat-dedup strategy', () => {
    it('按 hash 去重相同内容', async () => {
      const barrier = new SynthesizeBarrier();
      const results: FanOutResult<string>[] = [
        { workerId: 'w1', success: true, data: 'hello', durationMs: 100 },
        { workerId: 'w2', success: true, data: 'hello', durationMs: 120 },
        { workerId: 'w3', success: true, data: 'world', durationMs: 130 },
      ];
      const output = await barrier.synthesize(results, { strategy: 'concat-dedup' });
      const merged = output.merged as unknown[];
      expect(merged).toHaveLength(2);
    });

    it('不同内容不被去重', async () => {
      const barrier = new SynthesizeBarrier();
      const results: FanOutResult<string>[] = [
        { workerId: 'w1', success: true, data: 'a', durationMs: 100 },
        { workerId: 'w2', success: true, data: 'b', durationMs: 100 },
        { workerId: 'w3', success: true, data: 'c', durationMs: 100 },
      ];
      const output = await barrier.synthesize(results, { strategy: 'concat-dedup' });
      const merged = output.merged as unknown[];
      expect(merged).toHaveLength(3);
    });
  });

  describe('judging strategy', () => {
    it('LLM 调用成功时返回合并结果', async () => {
      const mockLLMClient = {
        complete: vi.fn().mockResolvedValue({
          content: '{"result": "merged"}',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }),
      };
      const barrier = new SynthesizeBarrier(mockLLMClient as never);
      const results: FanOutResult<Record<string, unknown>>[] = [
        { workerId: 'w1', success: true, data: { a: 1 }, durationMs: 100 },
        { workerId: 'w2', success: true, data: { b: 2 }, durationMs: 100 },
      ];
      const output = await barrier.synthesize(results, { strategy: 'judging' });
      expect(output.merged).toEqual({ result: 'merged' });
      expect(mockLLMClient.complete).toHaveBeenCalledOnce();
    });

    it('LLM 调用失败时 fail-open 降级为 concat-dedup', async () => {
      const mockLLMClient = {
        complete: vi.fn().mockRejectedValue(new Error('LLM error')),
      };
      const barrier = new SynthesizeBarrier(mockLLMClient as never);
      const results: FanOutResult<string>[] = [
        { workerId: 'w1', success: true, data: 'result-a', durationMs: 100 },
        { workerId: 'w2', success: true, data: 'result-b', durationMs: 100 },
      ];
      const output = await barrier.synthesize(results, { strategy: 'judging' });
      expect(Array.isArray(output.merged)).toBe(true);
    });

    it('无 llmClient 时自动降级为 concat-dedup', async () => {
      const barrier = new SynthesizeBarrier();
      const results: FanOutResult<string>[] = [
        { workerId: 'w1', success: true, data: 'x', durationMs: 100 },
      ];
      const output = await barrier.synthesize(results, { strategy: 'judging' });
      expect(Array.isArray(output.merged)).toBe(true);
    });
  });

  describe('barrier timeout', () => {
    it('超时时 barrierTimedOut=true 并返回部分结果', async () => {
      const neverResolvingClient = {
        complete: vi.fn().mockImplementation(() => new Promise<never>(() => {})),
      };
      const barrier = new SynthesizeBarrier(neverResolvingClient as never);
      const results: FanOutResult<Record<string, unknown>>[] = [
        { workerId: 'w1', success: true, data: { a: 1 }, durationMs: 100 },
      ];
      const output = await barrier.synthesize(results, {
        strategy: 'judging',
        barrierTimeoutMs: 20,
      });
      expect(output.barrierTimedOut).toBe(true);
    }, 1000);

    it('未超时时 barrierTimedOut=false', async () => {
      const barrier = new SynthesizeBarrier();
      const results: FanOutResult<string>[] = [
        { workerId: 'w1', success: true, data: 'fast', durationMs: 10 },
      ];
      const output = await barrier.synthesize(results, {
        strategy: 'concat-dedup',
        barrierTimeoutMs: 60000,
      });
      expect(output.barrierTimedOut).toBe(false);
    });
  });

  describe('失败 worker 占位', () => {
    it('includeFailed=true 时失败 worker failedReason 会进入 merged', async () => {
      const barrier = new SynthesizeBarrier();
      const results: FanOutResult<string>[] = [
        { workerId: 'w1', success: false, failedReason: 'error', durationMs: 100 },
        { workerId: 'w2', success: true, data: 'ok', durationMs: 100 },
      ];
      const output = await barrier.synthesize(results, {
        strategy: 'concat-dedup',
        includeFailed: true,
      });
      const merged = output.merged as unknown[];
      const hasFailedEntry = merged.some(
        (item) => typeof item === 'object' && item !== null && '_failed' in (item as object),
      );
      expect(hasFailedEntry).toBe(true);
    });

    it('includeFailed=false 时失败 worker 不进入 merged', async () => {
      const barrier = new SynthesizeBarrier();
      const results: FanOutResult<string>[] = [
        { workerId: 'w1', success: false, failedReason: 'error', durationMs: 100 },
        { workerId: 'w2', success: true, data: 'ok', durationMs: 100 },
      ];
      const output = await barrier.synthesize(results, {
        strategy: 'concat-dedup',
        includeFailed: false,
      });
      const merged = output.merged as unknown[];
      const hasFailedEntry = merged.some(
        (item) => typeof item === 'object' && item !== null && '_failed' in (item as object),
      );
      expect(hasFailedEntry).toBe(false);
    });
  });

  describe('participants 字段', () => {
    it('始终包含所有原始 fanOutResults（用于审计，不论 includeFailed）', async () => {
      const barrier = new SynthesizeBarrier();
      const results: FanOutResult<string>[] = [
        { workerId: 'w1', success: false, failedReason: 'err', durationMs: 100 },
        { workerId: 'w2', success: true, data: 'ok', durationMs: 100 },
      ];
      const output = await barrier.synthesize(results, {
        strategy: 'concat-dedup',
        includeFailed: false,
      });
      expect(output.participants).toHaveLength(2);
    });
  });
});
