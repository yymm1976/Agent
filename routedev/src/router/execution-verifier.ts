// src/router/execution-verifier.ts
// ACRouter 闭环模型路由：Verifier 多路信号聚合验证
// 论文借鉴：ACRouter Verifier 用沙盒原生多路信号聚合打分，不依赖 ground-truth
// 安全：Windows 不用 shell:true（复用 Phase 53 C2 修复）

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

export interface VerifierConfig {
  enabled: boolean;
  signals: Array<'compile' | 'test' | 'typecheck' | 'latency'>;
  timeoutMs: number;
  budgetMs: number;
}

export interface VerificationTrace {
  compiled: boolean;
  testsPassed: boolean;
  typeCheckPassed: boolean;
  latencyMs: number;
}

export interface VerificationResult {
  qualityScore: number;
  trace: VerificationTrace;
}

export class ExecutionVerifier {
  private readonly config: VerifierConfig;

  constructor(config?: Partial<VerifierConfig>) {
    this.config = {
      enabled: config?.enabled ?? false,
      signals: config?.signals ?? ['compile', 'typecheck', 'latency'],
      timeoutMs: config?.timeoutMs ?? 30000,
      budgetMs: config?.budgetMs ?? 60000,
    };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async verify(params: {
    modifiedFiles: string[];
    projectPath: string;
    executionMs: number;
  }): Promise<VerificationResult> {
    if (!this.config.enabled) {
      return {
        qualityScore: 0,
        trace: { compiled: false, testsPassed: false, typeCheckPassed: false, latencyMs: params.executionMs },
      };
    }

    const signalResults = new Map<string, { weight: number; passed: boolean }>();
    const compileWeight = 0.3;
    const testWeight = 0.3;
    const typecheckWeight = 0.2;
    const latencyWeight = 0.2;

    const tasks: Array<Promise<void>> = [];

    if (this.config.signals.includes('compile')) {
      tasks.push(this.runCompile(params.projectPath).then(passed => {
        signalResults.set('compile', { weight: compileWeight, passed });
      }));
    }

    if (this.config.signals.includes('test')) {
      tasks.push(this.runTests(params.projectPath).then(passed => {
        signalResults.set('test', { weight: testWeight, passed });
      }));
    }

    if (this.config.signals.includes('typecheck')) {
      tasks.push(this.runTypecheck(params.projectPath).then(passed => {
        signalResults.set('typecheck', { weight: typecheckWeight, passed });
      }));
    }

    if (this.config.signals.includes('latency')) {
      const latencyScore = Math.max(0, 1 - params.executionMs / this.config.budgetMs);
      signalResults.set('latency', { weight: latencyWeight, passed: latencyScore > 0.5 });
    }

    await Promise.allSettled(tasks);

    let totalWeight = 0;
    let earnedWeight = 0;
    for (const { weight, passed } of signalResults.values()) {
      totalWeight += weight;
      if (passed) earnedWeight += weight;
    }

    const qualityScore = totalWeight > 0 ? earnedWeight / totalWeight : 0;

    return {
      qualityScore,
      trace: {
        compiled: signalResults.get('compile')?.passed ?? false,
        testsPassed: signalResults.get('test')?.passed ?? false,
        typeCheckPassed: signalResults.get('typecheck')?.passed ?? false,
        latencyMs: params.executionMs,
      },
    };
  }

  private async runCompile(projectPath: string): Promise<boolean> {
    if (!existsSync(join(projectPath, 'tsconfig.json'))) return true;
    try {
      // F-061：直接使用本地 node_modules/.bin/tsc，避免 npx.cmd 硬编码（跨平台）
      const tscBin = join(projectPath, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
      const result = spawnSync(tscBin, ['--noEmit'], {
        cwd: projectPath,
        timeout: this.config.timeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.status === 0;
    } catch (e) {
      // 编译失败（spawn 异常或超时），返回 false
      logger.warn('[execution-verifier] runCompile: tsc 执行失败', {
        projectPath,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  private async runTypecheck(projectPath: string): Promise<boolean> {
    return this.runCompile(projectPath);
  }

  private async runTests(projectPath: string): Promise<boolean> {
    try {
      // F-061：直接使用本地 node_modules/.bin/vitest，避免 npx.cmd 硬编码（跨平台）
      const vitestBin = join(projectPath, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
      const result = spawnSync(vitestBin, ['run', '--reporter=dot'], {
        cwd: projectPath,
        timeout: this.config.timeoutMs,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.status === 0;
    } catch (e) {
      // 测试执行失败（spawn 异常或超时），返回 false
      logger.warn('[execution-verifier] runTests: vitest 执行失败', {
        projectPath,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }
}
