import { logger } from '../../utils/logger.js';

export interface AutoCompactConfig {
  enabled: boolean;
  contextWindow: number;
  reservedTokensForSummary: number;
  autoCompactBuffer: number;
  warningBuffer: number;
  errorBuffer: number;
  maxConsecutiveFailures: number;
}

export const DEFAULT_GUARDIAN_CONFIG: AutoCompactConfig = {
  enabled: false,
  contextWindow: 200000,
  reservedTokensForSummary: 20000,
  autoCompactBuffer: 13000,
  warningBuffer: 20000,
  errorBuffer: 20000,
  maxConsecutiveFailures: 3,
};

export type CompactAction = 'none' | 'warn' | 'compact' | 'force' | 'blocked';

export interface TokenState {
  currentTokens: number;
  effectiveWindow: number;
  percentLeft: number;
  isAboveWarning: boolean;
  isAboveError: boolean;
  isAboveAutoCompact: boolean;
  isAtBlockingLimit: boolean;
  suggestedAction: CompactAction;
}

export class AutoCompactGuardian {
  private consecutiveFailures = 0;

  constructor(private config: AutoCompactConfig) {}

  calculateTokenState(currentTokens: number): TokenState {
    if (!this.config.enabled) {
      return {
        currentTokens,
        effectiveWindow: 0,
        percentLeft: 100,
        isAboveWarning: false,
        isAboveError: false,
        isAboveAutoCompact: false,
        isAtBlockingLimit: false,
        suggestedAction: 'none',
      };
    }

    const effectiveWindow = this.config.contextWindow - this.config.reservedTokensForSummary;
    const percentLeft = Math.max(0, Math.round(((effectiveWindow - currentTokens) / effectiveWindow) * 100));

    const autoCompactThreshold = effectiveWindow - this.config.autoCompactBuffer;
    const warningThreshold = effectiveWindow - this.config.warningBuffer;
    const errorThreshold = effectiveWindow - this.config.errorBuffer;
    const blockingLimit = effectiveWindow - 3000;

    const isAboveWarning = currentTokens >= warningThreshold;
    const isAboveError = currentTokens >= errorThreshold;
    const isAboveAutoCompact = currentTokens >= autoCompactThreshold;
    const isAtBlockingLimit = currentTokens >= blockingLimit;

    let suggestedAction: CompactAction = 'none';
    if (isAtBlockingLimit) suggestedAction = 'force';
    else if (isAboveAutoCompact) suggestedAction = 'compact';
    else if (isAboveError || isAboveWarning) suggestedAction = 'warn';

    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      if (suggestedAction === 'compact' || suggestedAction === 'force') {
        logger.warn('AutoCompactGuardian: circuit broken', { failures: this.consecutiveFailures });
        suggestedAction = 'blocked';
      }
    }

    return {
      currentTokens,
      effectiveWindow,
      percentLeft,
      isAboveWarning,
      isAboveError,
      isAboveAutoCompact,
      isAtBlockingLimit,
      suggestedAction,
    };
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    logger.warn('AutoCompactGuardian: compact failed', { failures: this.consecutiveFailures });
  }

  isCircuitBroken(): boolean {
    return this.consecutiveFailures >= this.config.maxConsecutiveFailures;
  }

  resetCircuit(): void {
    this.consecutiveFailures = 0;
  }

  getFailureCount(): number {
    return this.consecutiveFailures;
  }
}
