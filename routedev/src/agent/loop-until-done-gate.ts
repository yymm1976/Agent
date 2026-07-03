import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { CompletionGate, GateResult, GateCheck } from './completion-gate.js';

export interface LoopUntilDoneConfig {
  maxRounds: number;
  stableRoundsRequired: number;
  minCompletionRatio: number;
  gateTimeoutMs: number;
}

export interface LoopCheckSnapshot {
  round: number;
  checkNames: Set<string>;
  failedChecks: Set<string>;
  failureFingerprints: Map<string, string>;
  completionRatio: number;
}

export interface LoopUntilDoneResult {
  canStop: boolean;
  roundsExecuted: number;
  stopReason: 'stable' | 'max-rounds' | 'completion-threshold-met' | 'manual-abort';
  snapshots: LoopCheckSnapshot[];
  finalCompletionRatio: number;
}

const DEFAULT_CONFIG: LoopUntilDoneConfig = {
  maxRounds: 5,
  stableRoundsRequired: 2,
  minCompletionRatio: 0.85,
  gateTimeoutMs: 180000,
};

export class LoopUntilDoneGate {
  constructor(
    private readonly completionGate: CompletionGate,
    private readonly config: LoopUntilDoneConfig = DEFAULT_CONFIG,
  ) {}

  async run(params: {
    projectPath: string;
    modifiedFiles: string[];
  }): Promise<LoopUntilDoneResult> {
    const snapshots: LoopCheckSnapshot[] = [];
    let stableCount = 0;

    for (let round = 0; round < this.config.maxRounds; round++) {
      logger.info('LoopUntilDoneGate: running round', { round, maxRounds: this.config.maxRounds });

      const gateResult = await this.completionGate.verify({
        projectPath: params.projectPath,
        modifiedFiles: params.modifiedFiles,
      });

      const snapshot = this.buildSnapshot(round, gateResult);
      snapshots.push(snapshot);

      const completionRatio = snapshot.completionRatio;

      if (completionRatio >= this.config.minCompletionRatio && snapshot.failedChecks.size === 0) {
        logger.info('LoopUntilDoneGate: completion threshold met', { round, completionRatio });
        return {
          canStop: true,
          roundsExecuted: round + 1,
          stopReason: 'completion-threshold-met',
          snapshots,
          finalCompletionRatio: completionRatio,
        };
      }

      if (snapshots.length >= 2) {
        const prev = snapshots[snapshots.length - 2];
        const curr = snapshots[snapshots.length - 1];
        const diff = this.diffSnapshots(prev, curr);
        if (diff.newFailedChecks.length === 0 && diff.changedFailureContents.length === 0) {
          stableCount++;
        } else {
          stableCount = 0;
        }
        if (stableCount >= this.config.stableRoundsRequired) {
          logger.info('LoopUntilDoneGate: stable rounds reached', {
            round,
            stableCount: stableCount + 1,
            required: this.config.stableRoundsRequired,
          });
          return {
            canStop: true,
            roundsExecuted: round + 1,
            stopReason: 'stable',
            snapshots,
            finalCompletionRatio: completionRatio,
          };
        }
      }
    }

    const lastSnapshot = snapshots[snapshots.length - 1];
    logger.warn('LoopUntilDoneGate: max rounds reached', {
      maxRounds: this.config.maxRounds,
      finalCompletionRatio: lastSnapshot?.completionRatio ?? 0,
    });
    return {
      canStop: false,
      roundsExecuted: this.config.maxRounds,
      stopReason: 'max-rounds',
      snapshots,
      finalCompletionRatio: lastSnapshot?.completionRatio ?? 0,
    };
  }

  diffSnapshots(
    prev: LoopCheckSnapshot,
    curr: LoopCheckSnapshot,
  ): { newFailedChecks: string[]; changedFailureContents: string[] } {
    const newFailedChecks: string[] = [];
    for (const check of curr.failedChecks) {
      if (!prev.failedChecks.has(check)) {
        newFailedChecks.push(check);
      }
    }

    const changedFailureContents: string[] = [];
    for (const [checkName, currHash] of curr.failureFingerprints) {
      const prevHash = prev.failureFingerprints.get(checkName);
      if (prevHash !== undefined && prevHash !== currHash) {
        changedFailureContents.push(checkName);
      }
    }

    return { newFailedChecks, changedFailureContents };
  }

  private buildSnapshot(round: number, gateResult: GateResult): LoopCheckSnapshot {
    const checkNames = new Set<string>(gateResult.checks.map((c: GateCheck) => c.name));
    const failedChecks = new Set<string>(
      gateResult.checks.filter((c: GateCheck) => !c.ok && !c.skipped).map((c: GateCheck) => c.name),
    );
    const failureFingerprints = new Map<string, string>();
    for (const check of gateResult.checks) {
      if (!check.ok && !check.skipped && check.output) {
        failureFingerprints.set(
          check.name,
          createHash('sha256').update(check.output).digest('hex'),
        );
      }
    }
    const completionRatio = this.estimateCompletion(gateResult);
    return { round, checkNames, failedChecks, failureFingerprints, completionRatio };
  }

  estimateCompletion(gateResult: GateResult): number {
    const active = gateResult.checks.filter((c: GateCheck) => !c.skipped);
    if (active.length === 0) return 1;
    const passed = active.filter((c: GateCheck) => c.ok).length;
    return passed / active.length;
  }
}
