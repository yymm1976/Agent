import type { DifficultyLevel } from './difficulty-assessor.js';
import type { GoalPlan, GoalStep } from './goal-types.js';
import type { LevelSwitchSuggestion } from './level-path-router.js';

export interface BlackboardSnapshot {
  facts?: Record<string, unknown>;
  completedSteps?: Record<string, unknown>;
}

export interface StateMigrationInput {
  plan: GoalPlan;
  suggestion: LevelSwitchSuggestion;
  blackboardSnapshot?: BlackboardSnapshot;
}

export interface StateMigrationResult {
  plan: GoalPlan;
  fromLevel: DifficultyLevel;
  toLevel: DifficultyLevel;
  preservedCompletedSteps: GoalStep[];
  pendingSteps: GoalStep[];
  blackboardSnapshot?: BlackboardSnapshot;
  migrationSummary: string;
}

export class StateMigration {
  migrate(input: StateMigrationInput): StateMigrationResult {
    const preservedCompletedSteps = input.plan.steps
      .filter((step) => step.status === 'completed')
      .map((step) => ({ ...step, dependencies: [...step.dependencies] }));
    const pendingSteps = input.plan.steps
      .filter((step) => step.status !== 'completed')
      .map((step) => ({ ...step, status: step.status === 'failed' ? 'pending' : step.status, dependencies: [...step.dependencies] }));
    const migratedPlan: GoalPlan = {
      ...input.plan,
      steps: [...preservedCompletedSteps, ...pendingSteps],
      difficultyAssessment: input.plan.difficultyAssessment
        ? {
            ...input.plan.difficultyAssessment,
            level: input.suggestion.to,
            reasoning: `${input.plan.difficultyAssessment.reasoning}; ${input.suggestion.reason}`,
          }
        : undefined,
      status: 'executing',
    };

    return {
      plan: migratedPlan,
      fromLevel: input.suggestion.from,
      toLevel: input.suggestion.to,
      preservedCompletedSteps,
      pendingSteps,
      blackboardSnapshot: input.blackboardSnapshot,
      migrationSummary: `${input.suggestion.from} → ${input.suggestion.to}: 保留 ${preservedCompletedSteps.length} 个已完成步骤，迁移 ${pendingSteps.length} 个待处理步骤`,
    };
  }
}
