import type { EffectKind } from './effect-model.js';

export interface DeniedIntent {
  policyRuleId: string;
  effectKind: EffectKind;
  canonicalResource?: string;
}

/** Bounded, run-scoped memory of denied semantic intent. */
export class DeniedIntentLedger {
  private readonly byRun = new Map<string, DeniedIntent[]>();

  record(runId: string | undefined, intent: DeniedIntent): void {
    if (!runId) return;
    const intents = this.byRun.get(runId) ?? [];
    if (!intents.some((entry) => entry.policyRuleId === intent.policyRuleId
      && entry.effectKind === intent.effectKind
      && entry.canonicalResource === intent.canonicalResource)) {
      intents.push(intent);
      if (intents.length > 256) intents.shift();
    }
    this.byRun.set(runId, intents);
  }

  get(runId: string | undefined): readonly DeniedIntent[] {
    return runId ? (this.byRun.get(runId) ?? []) : [];
  }

  clear(runId: string | undefined): void {
    if (runId) this.byRun.delete(runId);
  }
}
