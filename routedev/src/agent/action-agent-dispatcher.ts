import { logger } from '../utils/logger.js';
import type { QuarantineManager } from '../tools/quarantine-profile.js';

export interface DispatchIntent {
  intentId: string;
  description: string;
  requiredTools: string[];
  originAgentId: string;
  metadata?: Record<string, unknown>;
}

export interface DispatchResult {
  intentId: string;
  success: boolean;
  output?: string;
  deniedTools: string[];
  executedBy: 'trusted' | 'untrusted' | 'forwarded';
  durationMs: number;
}

export type ActionExecutorFn = (intent: DispatchIntent, allowedTools: string[]) => Promise<string>;

export interface ActionAgentDispatcherConfig {
  trustedAgentId: string;
  untrustedAgentId: string;
  intentForwardingEnabled: boolean;
}

export class ActionAgentDispatcher {
  constructor(
    private readonly quarantineManager: QuarantineManager,
    private readonly config: ActionAgentDispatcherConfig,
    private readonly trustedExecutor: ActionExecutorFn,
  ) {}

  async dispatch(intent: DispatchIntent): Promise<DispatchResult> {
    const start = Date.now();
    const originProfile = this.quarantineManager.get(intent.originAgentId);
    const trustedProfile = this.quarantineManager.get(this.config.trustedAgentId);

    const deniedTools: string[] = [];
    const requestedTools = intent.requiredTools;

    for (const tool of requestedTools) {
      if (!this.quarantineManager.isToolAllowed(intent.originAgentId, tool)) {
        deniedTools.push(tool);
      }
    }

    const isTrustedOrigin = originProfile?.trusted ?? false;
    const canForward = this.config.intentForwardingEnabled && (originProfile?.allowIntentForwarding ?? false);

    if (deniedTools.length > 0 && !isTrustedOrigin) {
      if (!canForward) {
        logger.warn('ActionAgentDispatcher: tool denied, forwarding disabled', {
          intentId: intent.intentId,
          deniedTools,
          originAgentId: intent.originAgentId,
        });
        return {
          intentId: intent.intentId,
          success: false,
          output: `工具 [${deniedTools.join(', ')}] 被隔离策略拒绝，且意图转发已禁用`,
          deniedTools,
          executedBy: 'untrusted',
          durationMs: Date.now() - start,
        };
      }

      logger.info('ActionAgentDispatcher: forwarding intent to trusted agent', {
        intentId: intent.intentId,
        deniedTools,
        originAgentId: intent.originAgentId,
        trustedAgentId: this.config.trustedAgentId,
      });

      const allowedTools = intent.requiredTools.filter(
        (t) => trustedProfile?.trusted ?? this.quarantineManager.isToolAllowed(this.config.trustedAgentId, t),
      );

      try {
        const output = await this.trustedExecutor(intent, allowedTools);
        return {
          intentId: intent.intentId,
          success: true,
          output,
          deniedTools,
          executedBy: 'forwarded',
          durationMs: Date.now() - start,
        };
      } catch (err) {
        logger.error('ActionAgentDispatcher: trusted executor failed', {
          intentId: intent.intentId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          intentId: intent.intentId,
          success: false,
          output: `Trusted executor 执行失败: ${err instanceof Error ? err.message : String(err)}`,
          deniedTools,
          executedBy: 'forwarded',
          durationMs: Date.now() - start,
        };
      }
    }

    const allowedTools = intent.requiredTools.filter(
      (t) => this.quarantineManager.isToolAllowed(intent.originAgentId, t),
    );

    try {
      const output = await this.trustedExecutor(intent, allowedTools);
      return {
        intentId: intent.intentId,
        success: true,
        output,
        deniedTools,
        executedBy: isTrustedOrigin ? 'trusted' : 'untrusted',
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        intentId: intent.intentId,
        success: false,
        output: `执行失败: ${err instanceof Error ? err.message : String(err)}`,
        deniedTools,
        executedBy: isTrustedOrigin ? 'trusted' : 'untrusted',
        durationMs: Date.now() - start,
      };
    }
  }
}
