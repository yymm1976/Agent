import { createHash } from 'node:crypto';
import type { ArchivedPlanVersion, GoalPlan, PlanAttestation } from './goal-types.js';

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computePlanHash(plan: GoalPlan): string {
  const snapshot = {
    id: plan.id,
    description: plan.description,
    verificationCriteria: plan.verificationCriteria,
    steps: plan.steps.map((step) => ({
      id: step.id,
      description: step.description,
      dependencies: step.dependencies,
      acceptanceCriteria: step.acceptanceCriteria,
      suggestedRole: step.suggestedRole,
      domain: step.domain,
    })),
  };
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

export function archiveCurrentPlan(plan: GoalPlan, archiveReason: string): ArchivedPlanVersion | null {
  if (!plan.attestation) {
    return null;
  }
  const archived: ArchivedPlanVersion = {
    attestation: plan.attestation,
    planSnapshot: {
      id: plan.id,
      description: plan.description,
      verificationCriteria: plan.verificationCriteria,
      steps: plan.steps.map((step) => ({ ...step, dependencies: [...step.dependencies] })),
      createdAt: plan.createdAt,
    },
    archiveReason,
    archivedAt: Date.now(),
  };
  plan.archivedVersions = [...(plan.archivedVersions ?? []), archived];
  return archived;
}

export function attestPlan(plan: GoalPlan, attestedBy: string): PlanAttestation {
  const attestation: PlanAttestation = {
    hash: computePlanHash(plan),
    version: (plan.attestation?.version ?? 0) + 1,
    attestedAt: Date.now(),
    attestedBy,
  };
  plan.attestation = attestation;
  return attestation;
}

export function verifyPlanAttestation(plan: GoalPlan): boolean {
  return !!plan.attestation && plan.attestation.hash === computePlanHash(plan);
}
