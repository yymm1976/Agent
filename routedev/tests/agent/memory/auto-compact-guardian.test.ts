import { describe, it, expect } from 'vitest';
import { AutoCompactGuardian, AutoCompactConfig, DEFAULT_GUARDIAN_CONFIG } from '../../../src/agent/memory/auto-compact-guardian.js';

/** 固定阈值 fixture：与生产默认解耦，避免默认 buffer 调整打断语义断言 */
const FIXTURE_THRESHOLDS: Partial<AutoCompactConfig> = {
  contextWindow: 200000,
  reservedTokensForSummary: 20000, // effective = 180000
  autoCompactBuffer: 13000, // compact @ 167000
  warningBuffer: 20000, // warn @ 160000
  errorBuffer: 20000,
  maxConsecutiveFailures: 3,
};

const createGuardian = (overrides?: Partial<AutoCompactConfig>) => {
  const config: AutoCompactConfig = {
    ...DEFAULT_GUARDIAN_CONFIG,
    ...FIXTURE_THRESHOLDS,
    enabled: true,
    ...overrides,
  };
  return new AutoCompactGuardian(config);
};

describe('AutoCompactGuardian', () => {
  describe('calculateTokenState', () => {
    it('should return none when below all thresholds', () => {
      const guardian = createGuardian();
      const state = guardian.calculateTokenState(100000);

      expect(state.suggestedAction).toBe('none');
      expect(state.isAboveWarning).toBe(false);
      expect(state.isAboveError).toBe(false);
      expect(state.isAboveAutoCompact).toBe(false);
      expect(state.isAtBlockingLimit).toBe(false);
    });

    it('should return warn when above warning threshold', () => {
      const guardian = createGuardian();
      const state = guardian.calculateTokenState(165000);

      expect(state.suggestedAction).toBe('warn');
      expect(state.isAboveWarning).toBe(true);
      expect(state.isAboveAutoCompact).toBe(false);
    });

    it('should return compact when above auto-compact threshold', () => {
      const guardian = createGuardian();
      const state = guardian.calculateTokenState(170000);

      expect(state.suggestedAction).toBe('compact');
      expect(state.isAboveAutoCompact).toBe(true);
      expect(state.isAtBlockingLimit).toBe(false);
    });

    it('should return force when at blocking limit', () => {
      const guardian = createGuardian();
      const state = guardian.calculateTokenState(178000);

      expect(state.suggestedAction).toBe('force');
      expect(state.isAtBlockingLimit).toBe(true);
    });

    it('should return blocked after max consecutive failures', () => {
      const guardian = createGuardian({ maxConsecutiveFailures: 3 });
      guardian.recordFailure();
      guardian.recordFailure();
      guardian.recordFailure();

      const state = guardian.calculateTokenState(170000);

      expect(state.suggestedAction).toBe('blocked');
    });

    it('should always return none when config disabled', () => {
      const guardian = createGuardian({ enabled: false });
      const state = guardian.calculateTokenState(178000);

      expect(state.suggestedAction).toBe('none');
      expect(state.effectiveWindow).toBe(0);
      expect(state.percentLeft).toBe(100);
    });
  });

  describe('recordSuccess', () => {
    it('should reset circuit breaker on success', () => {
      const guardian = createGuardian({ maxConsecutiveFailures: 3 });
      guardian.recordFailure();
      guardian.recordFailure();
      guardian.recordFailure();

      expect(guardian.isCircuitBroken()).toBe(true);

      guardian.recordSuccess();

      expect(guardian.isCircuitBroken()).toBe(false);
      expect(guardian.getFailureCount()).toBe(0);
    });
  });

  describe('resetCircuit', () => {
    it('should manually reset circuit breaker', () => {
      const guardian = createGuardian({ maxConsecutiveFailures: 3 });
      guardian.recordFailure();
      guardian.recordFailure();
      guardian.recordFailure();

      expect(guardian.isCircuitBroken()).toBe(true);

      guardian.resetCircuit();

      expect(guardian.isCircuitBroken()).toBe(false);
      expect(guardian.getFailureCount()).toBe(0);
    });
  });

  describe('getFailureCount', () => {
    it('should track failure count accurately', () => {
      const guardian = createGuardian();

      expect(guardian.getFailureCount()).toBe(0);

      guardian.recordFailure();
      expect(guardian.getFailureCount()).toBe(1);

      guardian.recordFailure();
      expect(guardian.getFailureCount()).toBe(2);

      guardian.recordSuccess();
      expect(guardian.getFailureCount()).toBe(0);
    });
  });
});
