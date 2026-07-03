// src/agent/multi/parallel-executor.ts
// Phase 69 Task 2: 并行执行引擎

import { logger } from '../../utils/logger.js';

export interface ParallelExecutorConfig {
  enabled: boolean;
  maxConcurrency: number;
  workerTimeoutMs: number;
}

export const DEFAULT_PARALLEL_CONFIG: ParallelExecutorConfig = {
  enabled: false,
  maxConcurrency: 3,
  workerTimeoutMs: 10 * 60 * 1000,
};

export interface WorkerTaskInput {
  workerId: string;
  task: { description: string; [key: string]: any };
}

export interface ParallelOutcome {
  success: boolean;
  workerId: string;
  result?: string;
  error?: string;
}

type WorkerFn = (workerId: string, task: any, cwd: string) => Promise<string>;

export class ParallelExecutor {
  constructor(
    private config: ParallelExecutorConfig,
    private cwd: string = process.cwd(),
  ) {}

  async executeParallel(
    tasks: WorkerTaskInput[],
    workerFn: WorkerFn,
  ): Promise<ParallelOutcome[]> {
    if (!this.config.enabled || tasks.length <= 1) {
      return this.executeSerial(tasks, workerFn);
    }

    const chunks = this.chunk(tasks, this.config.maxConcurrency);
    const allResults: ParallelOutcome[] = [];

    for (const chunk of chunks) {
      const chunkResults = await Promise.allSettled(
        chunk.map(async ({ workerId, task }) => {
          try {
            const result = await this.withTimeout(
              workerFn(workerId, task, this.cwd),
              this.config.workerTimeoutMs,
            );
            return { success: true as const, workerId, result };
          } catch (err) {
            return {
              success: false as const,
              workerId,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          allResults.push({
            success: false,
            workerId: 'unknown',
            error: result.reason?.message ?? 'Unknown error',
          });
        }
      }
    }

    return allResults;
  }

  private async executeSerial(
    tasks: WorkerTaskInput[],
    workerFn: WorkerFn,
  ): Promise<ParallelOutcome[]> {
    const results: ParallelOutcome[] = [];
    for (const { workerId, task } of tasks) {
      try {
        const result = await workerFn(workerId, task, this.cwd);
        results.push({ success: true, workerId, result });
      } catch (err) {
        results.push({
          success: false,
          workerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker timeout (${ms}ms)`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}