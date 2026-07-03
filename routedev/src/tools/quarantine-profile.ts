import { logger } from '../utils/logger.js';

export const QUARANTINE_DEFAULT_DENIED_TOOLS = new Set([
  'file_write',
  'file_edit',
  'shell_exec',
  'git_op',
]);

export interface QuarantineProfile {
  agentId: string;
  trusted: boolean;
  deniedTools: Set<string>;
  allowIntentForwarding: boolean;
  contaminationTrace: string[];
  createdAt: number;
}

export interface ContaminationEvent {
  sourceAgentId: string;
  targetAgentId: string;
  reason: string;
  timestamp: number;
}

export class QuarantineManager {
  private readonly profiles: Map<string, QuarantineProfile> = new Map();
  private readonly contaminationLog: ContaminationEvent[] = [];
  private readonly maxTraceDepth: number;

  constructor(
    private readonly deniedTools: Set<string> = QUARANTINE_DEFAULT_DENIED_TOOLS,
    maxTraceDepth = 10,
  ) {
    this.maxTraceDepth = maxTraceDepth;
  }

  registerUntrusted(agentId: string): QuarantineProfile {
    const profile: QuarantineProfile = {
      agentId,
      trusted: false,
      deniedTools: new Set(this.deniedTools),
      allowIntentForwarding: true,
      contaminationTrace: [],
      createdAt: Date.now(),
    };
    this.profiles.set(agentId, profile);
    logger.info('QuarantineManager: registered untrusted agent', { agentId });
    return profile;
  }

  registerTrusted(agentId: string): QuarantineProfile {
    const profile: QuarantineProfile = {
      agentId,
      trusted: true,
      deniedTools: new Set(),
      allowIntentForwarding: true,
      contaminationTrace: [],
      createdAt: Date.now(),
    };
    this.profiles.set(agentId, profile);
    return profile;
  }

  get(agentId: string): QuarantineProfile | undefined {
    return this.profiles.get(agentId);
  }

  isToolAllowed(agentId: string, toolName: string): boolean {
    const profile = this.profiles.get(agentId);
    if (!profile) return true;
    if (profile.trusted) return true;
    return !profile.deniedTools.has(toolName);
  }

  propagateContamination(
    sourceAgentId: string,
    targetAgentId: string,
    reason: string,
  ): void {
    const sourceProfile = this.profiles.get(sourceAgentId);
    const targetProfile = this.profiles.get(targetAgentId);
    if (!targetProfile) return;
    if (!sourceProfile?.trusted) {
      targetProfile.trusted = false;
      for (const tool of this.deniedTools) {
        targetProfile.deniedTools.add(tool);
      }
      const traceEntry = `contaminated-by:${sourceAgentId}@${Date.now()}`;
      if (targetProfile.contaminationTrace.length < this.maxTraceDepth) {
        targetProfile.contaminationTrace.push(traceEntry);
      }
      const event: ContaminationEvent = {
        sourceAgentId,
        targetAgentId,
        reason,
        timestamp: Date.now(),
      };
      this.contaminationLog.push(event);
      logger.warn('QuarantineManager: contamination propagated', {
        sourceAgentId,
        targetAgentId,
        reason,
      });
    }
  }

  getContaminationLog(): ContaminationEvent[] {
    return [...this.contaminationLog];
  }
}
