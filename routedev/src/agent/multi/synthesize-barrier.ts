import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { ILLMClient } from '../../router/types.js';
import { ContentDeduplicator } from '../content-deduplicator.js';

export interface FanOutResult<T = unknown> {
  workerId: string;
  success: boolean;
  data?: T;
  failedReason?: string;
  durationMs: number;
}

export interface SynthesizeOptions {
  barrierTimeoutMs: number;
  strategy: 'merge-fields' | 'concat-dedup' | 'judging';
  includeFailed: boolean;
}

export interface SynthesizeOutput<T = unknown> {
  merged: T;
  participants: FanOutResult[];
  barrierTimedOut: boolean;
  synthesizeMs: number;
}

const DEFAULT_OPTIONS: SynthesizeOptions = {
  barrierTimeoutMs: 60000,
  strategy: 'concat-dedup',
  includeFailed: true,
};

export class SynthesizeBarrier<T = unknown> {
  constructor(private readonly llmClient?: ILLMClient) {}

  async synthesize(
    fanOutResults: FanOutResult<T>[],
    options: Partial<SynthesizeOptions> = {},
  ): Promise<SynthesizeOutput<T>> {
    const opts: SynthesizeOptions = { ...DEFAULT_OPTIONS, ...options };
    const start = Date.now();

    const participants = opts.includeFailed
      ? fanOutResults
      : fanOutResults.filter((r) => r.success);

    const mergePromise: Promise<T | null> = this.runMerge(participants, opts);
    const timeoutPromise: Promise<T | null> = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), opts.barrierTimeoutMs),
    );

    let timedOut = false;
    const race = await Promise.race([
      mergePromise,
      timeoutPromise.then((v) => { timedOut = v === null; return v; }),
    ]);

    if (timedOut || race === null) {
      logger.warn('SynthesizeBarrier: barrier timed out', {
        timeoutMs: opts.barrierTimeoutMs,
        strategy: opts.strategy,
        participantCount: participants.length,
      });
      const fallback = this.concatDedup(participants);
      return {
        merged: fallback,
        participants: fanOutResults,
        barrierTimedOut: true,
        synthesizeMs: Date.now() - start,
      };
    }

    return {
      merged: race,
      participants: fanOutResults,
      barrierTimedOut: false,
      synthesizeMs: Date.now() - start,
    };
  }

  private async runMerge(results: FanOutResult<T>[], opts: SynthesizeOptions): Promise<T> {
    switch (opts.strategy) {
      case 'merge-fields':
        return this.mergeByFields(results);
      case 'concat-dedup':
        return this.concatDedup(results);
      case 'judging':
        return await this.judgeMerge(results);
      default:
        return this.concatDedup(results);
    }
  }

  private mergeByFields(results: FanOutResult<T>[]): T {
    const merged: Record<string, unknown> = {};
    for (const r of results) {
      if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) continue;
      const obj = r.data as Record<string, unknown>;
      for (const [key, val] of Object.entries(obj)) {
        if (!(key in merged) && val !== null && val !== undefined && val !== '') {
          merged[key] = val;
        }
      }
    }
    if (results.some((r) => !r.success && r.failedReason)) {
      merged['_failedWorkers'] = results
        .filter((r) => !r.success)
        .map((r) => ({ workerId: r.workerId, reason: r.failedReason }));
    }
    return merged as T;
  }

  private concatDedup(results: FanOutResult<T>[]): T {
    const allItems: unknown[] = [];

    for (const r of results) {
      if (r.data === undefined && !r.failedReason) continue;
      const payload = r.success ? r.data : { _failed: true, workerId: r.workerId, reason: r.failedReason };
      const items = Array.isArray(payload) ? payload : [payload];
      allItems.push(...items);
    }

    // P1 修复：复用 ContentDeduplicator 去重（替代内联 SHA-256）
    const deduplicator = new ContentDeduplicator({
      enabled: true,
      hashAlgorithm: 'sha256',
      minLength: 0, // concatDedup 场景不过滤短内容
      replaceWithReference: false, // concatDedup 场景直接丢弃重复项
    });
    const result = deduplicator.dedup(allItems, (item) => JSON.stringify(item));
    return result.items as T;
  }

  private async judgeMerge(results: FanOutResult<T>[]): Promise<T> {
    if (!this.llmClient) {
      logger.warn('SynthesizeBarrier: judging strategy requires llmClient, falling back to concat-dedup');
      return this.concatDedup(results);
    }

    const successfulResults = results.filter((r) => r.success && r.data !== undefined);
    if (successfulResults.length === 0) {
      return this.concatDedup(results);
    }

    const summaries = successfulResults.map((r, i) =>
      `Worker ${i + 1} (${r.workerId}):\n${JSON.stringify(r.data, null, 2)}`,
    ).join('\n\n---\n\n');

    const prompt = `你是多 Agent 协作的结果合并裁判。以下是多个 Worker 的输出结果，请将其合并为一个最优的综合结果：\n\n${summaries}\n\n请输出合并后的 JSON 结果（不要输出任何其他内容）。`;

    try {
      const response = await this.llmClient.complete({
        model: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2048,
        stream: false,
      });
      const text = response.content.trim();
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as T;
      }
      return JSON.parse(text) as T;
    } catch (err) {
      logger.warn('SynthesizeBarrier: judging LLM call failed, falling back to concat-dedup', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.concatDedup(results);
    }
  }
}
