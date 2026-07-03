import { describe, it, expect, vi } from 'vitest';
import { LoopUntilDoneGate } from '../../src/agent/loop-until-done-gate.js';
import type { LoopUntilDoneConfig, LoopCheckSnapshot } from '../../src/agent/loop-until-done-gate.js';
import type { GateResult } from '../../src/agent/completion-gate.js';

function makeGateResult(passed: boolean, checks: Array<{ name: string; ok: boolean; output?: string }>): GateResult {
  return {
    passed,
    checks: checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      output: c.output ?? (c.ok ? '' : `${c.name} failed`),
      duration: 100,
    })),
  };
}

function makeGate(results: GateResult[]) {
  let callIndex = 0;
  return {
    verify: vi.fn().mockImplementation(async () => {
      const result = results[Math.min(callIndex, results.length - 1)];
      callIndex++;
      return result;
    }),
  };
}

const BASE_CONFIG: LoopUntilDoneConfig = {
  maxRounds: 5,
  stableRoundsRequired: 2,
  minCompletionRatio: 0.85,
  gateTimeoutMs: 180000,
};

describe('LoopUntilDoneGate', () => {
  describe('stable 停止', () => {
    it('连续两轮无新发现 → stable 停止', async () => {
      const failedResult = makeGateResult(false, [
        { name: 'typecheck', ok: false, output: 'error: type mismatch' },
        { name: 'lint', ok: true },
      ]);
      const gate = makeGate([failedResult, failedResult, failedResult]);
      const loopGate = new LoopUntilDoneGate(gate as never, { ...BASE_CONFIG, stableRoundsRequired: 2 });
      const result = await loopGate.run({ projectPath: '/fake', modifiedFiles: [] });
      expect(result.stopReason).toBe('stable');
      expect(result.canStop).toBe(true);
      expect(result.roundsExecuted).toBe(3);
    });
  });

  describe('max-rounds 停止', () => {
    it('达到 maxRounds 仍不稳定 → max-rounds 停止', async () => {
      let counter = 0;
      const gate = {
        verify: vi.fn().mockImplementation(async () => {
          counter++;
          return makeGateResult(false, [
            { name: 'typecheck', ok: false, output: `error-${counter}` },
          ]);
        }),
      };
      const loopGate = new LoopUntilDoneGate(gate as never, {
        ...BASE_CONFIG,
        maxRounds: 3,
        stableRoundsRequired: 2,
      });
      const result = await loopGate.run({ projectPath: '/fake', modifiedFiles: [] });
      expect(result.stopReason).toBe('max-rounds');
      expect(result.canStop).toBe(false);
      expect(result.roundsExecuted).toBe(3);
    });
  });

  describe('completion-threshold-met 停止', () => {
    it('所有检查通过且完成度 ≥ 阈值 → completion-threshold-met', async () => {
      const passedResult = makeGateResult(true, [
        { name: 'typecheck', ok: true },
        { name: 'lint', ok: true },
        { name: 'tests', ok: true },
      ]);
      const gate = makeGate([passedResult]);
      const loopGate = new LoopUntilDoneGate(gate as never, BASE_CONFIG);
      const result = await loopGate.run({ projectPath: '/fake', modifiedFiles: [] });
      expect(result.stopReason).toBe('completion-threshold-met');
      expect(result.canStop).toBe(true);
    });

    it('完成度不足拒绝停止（进入下一轮）', async () => {
      const partialResult = makeGateResult(false, [
        { name: 'typecheck', ok: false, output: 'error' },
        { name: 'lint', ok: true },
        { name: 'tests', ok: false, output: 'fail' },
      ]);
      const gate = makeGate([partialResult, partialResult, partialResult]);
      const loopGate = new LoopUntilDoneGate(gate as never, {
        ...BASE_CONFIG,
        maxRounds: 3,
        minCompletionRatio: 0.85,
      });
      const result = await loopGate.run({ projectPath: '/fake', modifiedFiles: [] });
      expect(result.stopReason).not.toBe('completion-threshold-met');
    });
  });

  describe('diffSnapshots', () => {
    const makeSnapshot = (
      round: number,
      failed: string[],
      fingerprints: Record<string, string> = {},
    ): LoopCheckSnapshot => ({
      round,
      checkNames: new Set(['typecheck', 'lint']),
      failedChecks: new Set(failed),
      failureFingerprints: new Map(Object.entries(fingerprints)),
      completionRatio: (2 - failed.length) / 2,
    });

    it('新增失败 check 被检测到', () => {
      const gate = new LoopUntilDoneGate({ verify: vi.fn() } as never, BASE_CONFIG);
      const prev = makeSnapshot(0, []);
      const curr = makeSnapshot(1, ['typecheck'], { typecheck: 'hash1' });
      const diff = gate.diffSnapshots(prev, curr);
      expect(diff.newFailedChecks).toContain('typecheck');
    });

    it('失败内容变化被检测到', () => {
      const gate = new LoopUntilDoneGate({ verify: vi.fn() } as never, BASE_CONFIG);
      const prev = makeSnapshot(0, ['typecheck'], { typecheck: 'hash1' });
      const curr = makeSnapshot(1, ['typecheck'], { typecheck: 'hash2' });
      const diff = gate.diffSnapshots(prev, curr);
      expect(diff.changedFailureContents).toContain('typecheck');
    });

    it('连续两轮完全相同 → diff 为空', () => {
      const gate = new LoopUntilDoneGate({ verify: vi.fn() } as never, BASE_CONFIG);
      const snap = makeSnapshot(0, ['lint'], { lint: 'same-hash' });
      const snap2 = makeSnapshot(1, ['lint'], { lint: 'same-hash' });
      const diff = gate.diffSnapshots(snap, snap2);
      expect(diff.newFailedChecks).toHaveLength(0);
      expect(diff.changedFailureContents).toHaveLength(0);
    });
  });

  describe('estimateCompletion', () => {
    it('所有检查通过 → 1.0', () => {
      const gate = new LoopUntilDoneGate({ verify: vi.fn() } as never, BASE_CONFIG);
      const result = makeGateResult(true, [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ]);
      expect(gate.estimateCompletion(result)).toBe(1);
    });

    it('skipped 检查不计入分母', () => {
      const gate = new LoopUntilDoneGate({ verify: vi.fn() } as never, BASE_CONFIG);
      const result = {
        passed: false,
        checks: [
          { name: 'a', ok: true, output: '', duration: 0 },
          { name: 'b', ok: false, skipped: true, output: '', duration: 0 },
        ],
      };
      const ratio = gate.estimateCompletion(result);
      expect(ratio).toBe(1);
    });
  });
});
