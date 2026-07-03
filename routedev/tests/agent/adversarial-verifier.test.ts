import { describe, it, expect, vi } from 'vitest';
import { AdversarialVerifier } from '../../src/agent/adversarial-verifier.js';
import { RubricRegistry, BUILTIN_RUBRICS } from '../../src/agent/rubric-registry.js';
import type { VerifierRubric, AdversarialVerifierConfig } from '../../src/agent/adversarial-verifier.js';

const DEFAULT_RUBRIC: VerifierRubric = {
  id: 'default',
  taskType: 'default',
  checks: [
    { description: '代码变更是否安全，无明显漏洞', severity: 'critical' },
    { description: '逻辑是否正确，边界处理是否完善', severity: 'major' },
  ],
};

function makeConfig(overrides: Partial<AdversarialVerifierConfig> = {}): AdversarialVerifierConfig {
  return {
    frequency: 'end-only',
    forceCrossModel: false,
    defaultRubric: DEFAULT_RUBRIC,
    ...overrides,
  };
}

function makeReviewer(summary = '审查通过', passed = true) {
  return {
    review: vi.fn().mockResolvedValue({
      passed,
      issues: [],
      summary,
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
  };
}

describe('AdversarialVerifier', () => {
  describe('shouldVerify - 三种频率', () => {
    it('every-step: 每步都触发', () => {
      const verifier = new AdversarialVerifier(
        makeReviewer() as never,
        new Map(),
        makeConfig({ frequency: 'every-step' }),
      );
      expect(verifier.shouldVerify(0, 5)).toBe(true);
      expect(verifier.shouldVerify(2, 5)).toBe(true);
      expect(verifier.shouldVerify(4, 5)).toBe(true);
    });

    it('every-n-steps: stepIndex % n === 0 时触发', () => {
      const verifier = new AdversarialVerifier(
        makeReviewer() as never,
        new Map(),
        makeConfig({ frequency: 'every-n-steps', n: 3 }),
      );
      expect(verifier.shouldVerify(0, 10)).toBe(true);
      expect(verifier.shouldVerify(1, 10)).toBe(false);
      expect(verifier.shouldVerify(3, 10)).toBe(true);
      expect(verifier.shouldVerify(6, 10)).toBe(true);
    });

    it('end-only: 仅最后一步触发', () => {
      const verifier = new AdversarialVerifier(
        makeReviewer() as never,
        new Map(),
        makeConfig({ frequency: 'end-only' }),
      );
      expect(verifier.shouldVerify(0, 5)).toBe(false);
      expect(verifier.shouldVerify(3, 5)).toBe(false);
      expect(verifier.shouldVerify(4, 5)).toBe(true);
    });
  });

  describe('selectRubric - 任务类型匹配', () => {
    it('已知任务类型返回对应 rubric', () => {
      const registry = new Map(BUILTIN_RUBRICS.map((r) => [r.taskType, r]));
      const verifier = new AdversarialVerifier(
        makeReviewer() as never,
        registry,
        makeConfig(),
      );
      const rubric = verifier.selectRubric('security-audit');
      expect(rubric.taskType).toBe('security-audit');
      expect(rubric.checks.length).toBeGreaterThan(0);
    });

    it('未知任务类型返回 defaultRubric', () => {
      const verifier = new AdversarialVerifier(
        makeReviewer() as never,
        new Map(),
        makeConfig(),
      );
      const rubric = verifier.selectRubric('unknown-task');
      expect(rubric.id).toBe('default');
    });
  });

  describe('verify - 跨模型成功', () => {
    it('审查通过时 passed=true 且 isCrossModel=true', async () => {
      const reviewer = makeReviewer('审查通过');
      const verifier = new AdversarialVerifier(
        reviewer as never,
        new Map(),
        makeConfig(),
      );
      const outcome = await verifier.verify({
        modifiedFiles: ['src/foo.ts'],
        executionSummary: '新增功能',
        taskType: 'default',
        stepIndex: 0,
      });
      expect(outcome.passed).toBe(true);
      expect(outcome.isCrossModel).toBe(true);
      expect(reviewer.review).toHaveBeenCalledOnce();
    });
  });

  describe('verify - fail-open 降级', () => {
    it('reviewer 抛出异常时降级为同模型自评，isCrossModel=false', async () => {
      const failingReviewer = {
        review: vi.fn().mockRejectedValue(new Error('network error')),
      };
      const verifier = new AdversarialVerifier(
        failingReviewer as never,
        new Map(),
        makeConfig({ forceCrossModel: true }),
      );
      const outcome = await verifier.verify({
        modifiedFiles: [],
        executionSummary: 'test',
        taskType: 'default',
        stepIndex: 0,
      });
      expect(outcome.isCrossModel).toBe(false);
      expect(outcome.downgradeReason).toBeTruthy();
      expect(outcome.passed).toBe(true);
    });
  });

  describe('verify - rubric 注入', () => {
    it('review 调用时 goalDescription 包含 rubric 检查清单', async () => {
      const reviewer = makeReviewer();
      const verifier = new AdversarialVerifier(
        reviewer as never,
        new Map(),
        makeConfig(),
      );
      await verifier.verify({
        modifiedFiles: [],
        executionSummary: 'summary',
        taskType: 'default',
        stepIndex: 0,
      });
      const callArg = reviewer.review.mock.calls[0][0];
      expect(callArg.goalDescription).toContain('rubric');
    });
  });

  describe('RubricRegistry - 内置 rubric', () => {
    it('包含四类内置 rubric', () => {
      const registry = new RubricRegistry();
      expect(registry.get('security-audit')).toBeDefined();
      expect(registry.get('refactor')).toBeDefined();
      expect(registry.get('new-feature')).toBeDefined();
      expect(registry.get('bug-fix')).toBeDefined();
    });

    it('可注册自定义 rubric', () => {
      const registry = new RubricRegistry();
      const custom: VerifierRubric = {
        id: 'custom',
        taskType: 'custom-task',
        checks: [{ description: 'test', severity: 'minor' }],
      };
      registry.register(custom);
      expect(registry.get('custom-task')).toEqual(custom);
    });
  });
});
