// tests/router/execution-verifier.test.ts
// ExecutionVerifier 多路信号聚合验证测试

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

import { ExecutionVerifier } from '../../src/router/execution-verifier.js';

const mockSpawnSync = vi.mocked(spawnSync);
const mockExistsSync = vi.mocked(existsSync);

describe('ExecutionVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' } as any);
  });

  it('should return qualityScore close to 1.0 when all signals pass', async () => {
    const verifier = new ExecutionVerifier({
      enabled: true,
      signals: ['compile', 'test', 'typecheck', 'latency'],
      budgetMs: 10000,
    });

    const result = await verifier.verify({
      modifiedFiles: ['src/foo.ts'],
      projectPath: '/fake/project',
      executionMs: 100,
    });

    expect(result.qualityScore).toBeCloseTo(1.0, 1);
    expect(result.trace.compiled).toBe(true);
    expect(result.trace.testsPassed).toBe(true);
    expect(result.trace.typeCheckPassed).toBe(true);
    expect(result.trace.latencyMs).toBe(100);
  });

  it('should return medium qualityScore when some signals fail', async () => {
    mockSpawnSync.mockImplementation((_cmd: any, args: any) => {
      if (args?.includes('vitest')) {
        return { status: 1, stdout: '', stderr: 'test failed' } as any;
      }
      return { status: 0, stdout: '', stderr: '' } as any;
    });

    const verifier = new ExecutionVerifier({
      enabled: true,
      signals: ['compile', 'test', 'typecheck', 'latency'],
      budgetMs: 10000,
    });

    const result = await verifier.verify({
      modifiedFiles: ['src/foo.ts'],
      projectPath: '/fake/project',
      executionMs: 100,
    });

    expect(result.qualityScore).toBeGreaterThan(0);
    expect(result.qualityScore).toBeLessThan(1);
    expect(result.qualityScore).toBeCloseTo(0.7, 1);
    expect(result.trace.compiled).toBe(true);
    expect(result.trace.testsPassed).toBe(false);
    expect(result.trace.typeCheckPassed).toBe(true);
  });

  it('should still score remaining signals when one signal times out', async () => {
    let callCount = 0;
    mockSpawnSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { status: null, signal: 'SIGTERM' } as any;
      }
      return { status: 0, stdout: '', stderr: '' } as any;
    });

    const verifier = new ExecutionVerifier({
      enabled: true,
      signals: ['compile', 'test', 'typecheck', 'latency'],
      budgetMs: 10000,
    });

    const result = await verifier.verify({
      modifiedFiles: ['src/foo.ts'],
      projectPath: '/fake/project',
      executionMs: 100,
    });

    expect(result.qualityScore).toBeGreaterThan(0);
    expect(result.qualityScore).toBeCloseTo(0.7, 1);
    expect(result.trace.compiled).toBe(false);
    expect(result.trace.testsPassed).toBe(true);
    expect(result.trace.typeCheckPassed).toBe(true);
  });

  it('should call spawnSync without shell:true for Windows safety', async () => {
    const verifier = new ExecutionVerifier({
      enabled: true,
      signals: ['compile', 'test', 'typecheck', 'latency'],
      budgetMs: 10000,
    });

    await verifier.verify({
      modifiedFiles: ['src/foo.ts'],
      projectPath: '/fake/project',
      executionMs: 100,
    });

    expect(mockSpawnSync).toHaveBeenCalled();
    for (const call of mockSpawnSync.mock.calls) {
      const options = call[2] as Record<string, unknown> | undefined;
      expect(options?.shell).toBeUndefined();
    }
  });

  it('should return score 0 with default trace when enabled=false', async () => {
    const verifier = new ExecutionVerifier({ enabled: false });

    const result = await verifier.verify({
      modifiedFiles: ['src/foo.ts'],
      projectPath: '/fake/project',
      executionMs: 5000,
    });

    expect(result.qualityScore).toBe(0);
    expect(result.trace.compiled).toBe(false);
    expect(result.trace.testsPassed).toBe(false);
    expect(result.trace.typeCheckPassed).toBe(false);
    expect(result.trace.latencyMs).toBe(5000);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('should calculate latency score as max(0, 1 - executionMs / budgetMs)', async () => {
    const verifier = new ExecutionVerifier({
      enabled: true,
      signals: ['latency'],
      budgetMs: 1000,
    });

    const r0 = await verifier.verify({ modifiedFiles: [], projectPath: '/fake', executionMs: 0 });
    expect(r0.qualityScore).toBeCloseTo(1.0, 2);

    const r1 = await verifier.verify({ modifiedFiles: [], projectPath: '/fake', executionMs: 200 });
    expect(r1.qualityScore).toBeCloseTo(1.0, 2);

    const r2 = await verifier.verify({ modifiedFiles: [], projectPath: '/fake', executionMs: 500 });
    expect(r2.qualityScore).toBe(0);

    const r3 = await verifier.verify({ modifiedFiles: [], projectPath: '/fake', executionMs: 1000 });
    expect(r3.qualityScore).toBe(0);

    const r4 = await verifier.verify({ modifiedFiles: [], projectPath: '/fake', executionMs: 1500 });
    expect(r4.qualityScore).toBe(0);
  });

  it('should only use latency when signals is ["latency"]', async () => {
    const verifier = new ExecutionVerifier({
      enabled: true,
      signals: ['latency'],
      budgetMs: 10000,
    });

    const result = await verifier.verify({
      modifiedFiles: ['src/foo.ts'],
      projectPath: '/fake/project',
      executionMs: 100,
    });

    expect(result.qualityScore).toBeCloseTo(1.0, 2);
    expect(result.trace.compiled).toBe(false);
    expect(result.trace.testsPassed).toBe(false);
    expect(result.trace.typeCheckPassed).toBe(false);
    expect(result.trace.latencyMs).toBe(100);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('should return score 0 when signals array is empty', async () => {
    const verifier = new ExecutionVerifier({
      enabled: true,
      signals: [],
      budgetMs: 10000,
    });

    const result = await verifier.verify({
      modifiedFiles: ['src/foo.ts'],
      projectPath: '/fake/project',
      executionMs: 100,
    });

    expect(result.qualityScore).toBe(0);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('should default to enabled=false when constructed without config', () => {
    const verifier = new ExecutionVerifier();
    expect(verifier.isEnabled()).toBe(false);
  });
});
