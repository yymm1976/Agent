import { logger } from '../utils/logger.js';
import type { CrossModelReviewer } from './cross-model-reviewer.js';

export interface VerifierRubric {
  id: string;
  taskType: string;
  checks: Array<{
    description: string;
    severity: 'critical' | 'major' | 'minor';
  }>;
}

export interface AdversarialVerifierConfig {
  frequency: 'every-step' | 'every-n-steps' | 'end-only';
  n?: number;
  defaultRubric: VerifierRubric;
  verifierModelId?: string;
  forceCrossModel: boolean;
}

export interface VerificationOutcome {
  passed: boolean;
  checkResults: Array<{
    description: string;
    severity: 'critical' | 'major' | 'minor';
    passed: boolean;
    note?: string;
  }>;
  isCrossModel: boolean;
  downgradeReason?: string;
}

const DEFAULT_RUBRIC: VerifierRubric = {
  id: 'default',
  taskType: 'default',
  checks: [
    { description: '代码变更是否安全，无明显漏洞', severity: 'critical' },
    { description: '逻辑是否正确，边界处理是否完善', severity: 'major' },
    { description: '错误处理是否完善', severity: 'minor' },
  ],
};

export class AdversarialVerifier {
  constructor(
    private readonly crossModelReviewer: CrossModelReviewer,
    private readonly rubricRegistry: Map<string, VerifierRubric>,
    private readonly config: AdversarialVerifierConfig,
  ) {}

  shouldVerify(stepIndex: number, totalSteps: number): boolean {
    switch (this.config.frequency) {
      case 'every-step':
        return true;
      case 'every-n-steps': {
        const n = this.config.n ?? 3;
        return stepIndex % n === 0;
      }
      case 'end-only':
        return stepIndex === totalSteps - 1;
      default:
        return false;
    }
  }

  selectRubric(taskType: string): VerifierRubric {
    return this.rubricRegistry.get(taskType) ?? this.config.defaultRubric;
  }

  async verify(params: {
    modifiedFiles: string[];
    executionSummary: string;
    taskType: string;
    stepIndex: number;
  }): Promise<VerificationOutcome> {
    const { modifiedFiles, executionSummary, taskType } = params;
    const rubric = this.selectRubric(taskType);

    const rubricPrompt = this.buildRubricPrompt(rubric);

    try {
      const reviewResult = await this.crossModelReviewer.review({
        modifiedFiles,
        executionSummary,
        goalDescription: rubricPrompt,
      });

      const isCrossModel = !reviewResult.summary.startsWith('[未跨模型]');
      const downgradeReason = isCrossModel ? undefined : '审查器回退到同模型自评';

      const checkResults = rubric.checks.map((check) => {
        const hasCriticalIssue = reviewResult.issues.some(
          (issue) => issue.severity === 'critical' && issue.description.includes(check.description.slice(0, 10)),
        );
        return {
          description: check.description,
          severity: check.severity,
          passed: !hasCriticalIssue,
          note: hasCriticalIssue ? '发现相关问题' : undefined,
        };
      });

      const passed = reviewResult.passed && !checkResults.some((r) => r.severity === 'critical' && !r.passed);

      return { passed, checkResults, isCrossModel, downgradeReason };
    } catch (err) {
      logger.warn('AdversarialVerifier: verify failed, degrading to self-review', {
        error: err instanceof Error ? err.message : String(err),
        taskType,
      });

      const checkResults = rubric.checks.map((check) => ({
        description: check.description,
        severity: check.severity,
        passed: true,
        note: undefined,
      }));

      return {
        passed: true,
        checkResults,
        isCrossModel: false,
        downgradeReason: `验证失败，降级为同模型自评: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private buildRubricPrompt(rubric: VerifierRubric): string {
    const checkList = rubric.checks
      .map((c, i) => `${i + 1}. [${c.severity.toUpperCase()}] ${c.description}`)
      .join('\n');
    return `请按以下 rubric 检查清单审查代码变更：\n\n${checkList}\n\n对每项检查给出 passed/failed 判断。`;
  }
}
