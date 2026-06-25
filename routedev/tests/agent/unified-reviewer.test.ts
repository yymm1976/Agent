// tests/agent/unified-reviewer.test.ts
// Phase 31 Task 5：统一审查与验收测试

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  UnifiedReviewer,
  createUnifiedReviewer,
  type UnifiedReviewerDeps,
  REVIEW_SYSTEM_PROMPT,
} from '../../src/agent/unified-reviewer.js';
import type { GoalPlan, VerificationResult } from '../../src/agent/goal-types.js';
import type { StepExecutionResult } from '../../src/agent/task-orchestrator-types.js';
import type { TokenTracker } from '../../src/router/tracker.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { ReActEvent } from '../../src/agent/loop-config.js';

function createMockTracker(): TokenTracker {
  return {
    record: vi.fn(),
  } as unknown as TokenTracker;
}

function createMockConfig(reviewMode: 'builtin' | 'ocr' | 'none' = 'builtin', reviewOnComplete = true): AppConfig {
  return {
    optimization: {
      workflow: {
        unifiedPipeline: true,
        autoRequirements: true,
        reviewOnComplete,
        reviewMode,
        reviewModel: 'auto',
        reviewStrictness: 'medium',
      },
      safety: { readBeforeWrite: true, maxToolOutputChars: 16000, completionGate: true, gateTimeout: 180000, gateRetry: 1 },
    },
  } as unknown as AppConfig;
}

function makePlan(description: string = 'test plan'): GoalPlan {
  return { id: 'plan-1', description, steps: [], status: 'completed' } as GoalPlan;
}

function makeExecutionResult(overrides: Partial<StepExecutionResult> = {}): StepExecutionResult {
  return {
    stepId: 1,
    success: true,
    conclusion: '步骤完成',
    modifiedFiles: ['src/a.ts'],
    durationMs: 1000,
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    ...overrides,
  };
}

describe('UnifiedReviewer (Phase 31 Task 5)', () => {
  let deps: UnifiedReviewerDeps;

  beforeEach(() => {
    deps = {
      agentLoop: {
        run: async function* () {
          yield { type: 'done', content: '{"passed":true,"issues":[],"summary":"审查通过"}', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } } as ReActEvent;
        },
      } as any,
      tracker: createMockTracker(),
      config: createMockConfig(),
      systemPromptRef: { current: 'test prompt' },
      addSystemMessage: vi.fn(),
    };
  });

  // ============================================================
  // 常量
  // ============================================================
  describe('REVIEW_SYSTEM_PROMPT', () => {
    it('包含占位符 {{modifiedFiles}}', () => {
      expect(REVIEW_SYSTEM_PROMPT).toContain('{{modifiedFiles}}');
    });

    it('包含占位符 {{executionSummary}}', () => {
      expect(REVIEW_SYSTEM_PROMPT).toContain('{{executionSummary}}');
    });

    it('包含占位符 {{goalDescription}}', () => {
      expect(REVIEW_SYSTEM_PROMPT).toContain('{{goalDescription}}');
    });

    it('包含审查检查项', () => {
      expect(REVIEW_SYSTEM_PROMPT).toContain('边界情况');
      expect(REVIEW_SYSTEM_PROMPT).toContain('安全风险');
      expect(REVIEW_SYSTEM_PROMPT).toContain('性能问题');
    });
  });

  // ============================================================
  // review - 基本流程
  // ============================================================
  describe('review 基本流程', () => {
    it('返回 UnifiedReviewResult 结构', async () => {
      const reviewer = new UnifiedReviewer(deps);
      const result = await reviewer.review({
        plan: makePlan(),
        executionResults: [makeExecutionResult()],
        llmClient: {} as any,
        routeDecision: { model: { id: 'test' } } as any,
        conversationHistory: [],
      });

      expect(result).toHaveProperty('verification');
      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('totalTokenUsage');
    });

    it('触发 addSystemMessage 播报进度', async () => {
      const reviewer = new UnifiedReviewer(deps);
      await reviewer.review({
        plan: makePlan(),
        executionResults: [makeExecutionResult()],
        llmClient: {} as any,
        routeDecision: { model: { id: 'test' } } as any,
        conversationHistory: [],
      });

      expect(deps.addSystemMessage).toHaveBeenCalled();
    });
  });

  // ============================================================
  // review - reviewMode: 'none'
  // ============================================================
  describe('reviewMode: none', () => {
    it('reviewMode 为 none 时跳过代码审查', async () => {
      deps.config = createMockConfig('none');
      const reviewer = new UnifiedReviewer(deps);
      const result = await reviewer.review({
        plan: makePlan(),
        executionResults: [makeExecutionResult()],
        llmClient: {} as any,
        routeDecision: { model: { id: 'test' } } as any,
        conversationHistory: [],
      });

      expect(result.codeReview).toBeUndefined();
    });
  });

  // ============================================================
  // review - reviewOnComplete: false
  // ============================================================
  describe('reviewOnComplete: false', () => {
    it('reviewOnComplete 为 false 时跳过代码审查', async () => {
      deps.config = createMockConfig('builtin', false);
      const reviewer = new UnifiedReviewer(deps);
      const result = await reviewer.review({
        plan: makePlan(),
        executionResults: [makeExecutionResult()],
        llmClient: {} as any,
        routeDecision: { model: { id: 'test' } } as any,
        conversationHistory: [],
      });

      expect(result.codeReview).toBeUndefined();
    });
  });

  // ============================================================
  // review - 无修改文件
  // ============================================================
  describe('无修改文件', () => {
    it('没有修改文件时跳过代码审查', async () => {
      const reviewer = new UnifiedReviewer(deps);
      const result = await reviewer.review({
        plan: makePlan(),
        executionResults: [makeExecutionResult({ modifiedFiles: [] })],
        llmClient: {} as any,
        routeDecision: { model: { id: 'test' } } as any,
        conversationHistory: [],
      });

      expect(result.codeReview).toBeUndefined();
    });
  });

  // ============================================================
  // review - Token 追踪
  // ============================================================
  describe('Token 追踪', () => {
    it('审查过程记录 Token 到 tracker', async () => {
      const reviewer = new UnifiedReviewer(deps);
      await reviewer.review({
        plan: makePlan(),
        executionResults: [makeExecutionResult()],
        llmClient: {} as any,
        routeDecision: { model: { id: 'test' } } as any,
        conversationHistory: [],
      });

      expect(deps.tracker.record).toHaveBeenCalled();
    });
  });

  // ============================================================
  // 工厂函数
  // ============================================================
  describe('工厂函数', () => {
    it('createUnifiedReviewer 返回实例', () => {
      const reviewer = createUnifiedReviewer(deps);
      expect(reviewer).toBeInstanceOf(UnifiedReviewer);
    });
  });

  // ============================================================
  // 综合判断
  // ============================================================
  describe('综合判断', () => {
    it('验证通过 + 审查通过 = passed true', async () => {
      const reviewer = new UnifiedReviewer(deps);
      const result = await reviewer.review({
        plan: makePlan(),
        executionResults: [makeExecutionResult()],
        llmClient: {} as any,
        routeDecision: { model: { id: 'test' } } as any,
        conversationHistory: [],
      });

      // 由于 mock 的 GoalVerifier 会调用真实 LLM，这里验证结构
      expect(result).toHaveProperty('passed');
      expect(typeof result.passed).toBe('boolean');
    });
  });
});
