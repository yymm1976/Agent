// tests/agent/multi/worker-isolation.test.ts
// Worker 异常隔离单元测试（Phase 21 Task 3）
// 验证：Worker 抛异常不崩溃 Orchestrator；可重试错误重试 2 次；
//       不可重试立即 skip；permission_denied 不重试；timeout 触发重试后成功

import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../../src/agent/multi/orchestrator.js';
import type {
  WorkerOutcome,
  WorkerErrorType,
  WorkerFunction,
} from '../../../src/agent/multi/orchestrator.js';
import type { WorkerTask } from '../../../src/agent/multi/types.js';
import type { ILLMClient, LLMRequestOptions, LLMResponse } from '../../../src/router/types.js';

function makeMockClient(): ILLMClient {
  return {
    isReady: () => true,
    complete: vi.fn(async (_req: LLMRequestOptions): Promise<LLMResponse> => ({
      content: '[]',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    })),
    stream: vi.fn(async function* () { /* */ }),
  };
}

function makeTask(): WorkerTask {
  return {
    stepId: 1,
    description: '测试任务',
    role: 'coder',
    rolePrompt: '',
    blackboardSnapshot: {
      currentGoal: null,
      completedSteps: [],
      projectFacts: [],
    },
  };
}

describe('Worker 异常隔离（executeWorkerIsolated）', () => {
  describe('基础行为', () => {
    it('Worker 成功执行 → 返回 success outcome', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => '执行结果');
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn);
      expect(outcome.success).toBe(true);
      if (outcome.success) {
        expect(outcome.result).toBe('执行结果');
        expect(outcome.workerId).toBe('w-1');
      }
      expect(workerFn).toHaveBeenCalledTimes(1);
    });

    it('Worker 抛异常不崩溃 Orchestrator（返回 failure outcome）', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw new Error('未知错误');
      });
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn);
      // 不抛异常，返回结构化错误
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.workerId).toBe('w-1');
        expect(outcome.error.message).toBe('未知错误');
        expect(outcome.error.type).toBe('unknown');
        expect(outcome.error.suggestedAction).toBe('abort');
      }
    });
  });

  describe('可重试错误', () => {
    it('timeout 错误重试 2 次后仍失败 → 返回 failure', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw new Error('Request timeout');
      });
      // maxRetries=2 → 总共尝试 3 次（初始 + 2 次重试）
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn, 2);
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.type).toBe('timeout');
        expect(outcome.error.retryCount).toBe(2); // 重试了 2 次
        expect(outcome.error.suggestedAction).toBe('skip'); // 重试耗尽 → skip
      }
      expect(workerFn).toHaveBeenCalledTimes(3); // 1 + 2 = 3 次调用
    });

    it('timeout 触发重试后成功 → 返回 success', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      let callCount = 0;
      const workerFn: WorkerFunction = vi.fn(async () => {
        callCount++;
        if (callCount < 3) throw new Error('timeout');
        return '成功结果';
      });
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn, 2);
      expect(outcome.success).toBe(true);
      if (outcome.success) {
        expect(outcome.result).toBe('成功结果');
      }
      expect(workerFn).toHaveBeenCalledTimes(3); // 失败2次 + 成功1次
    });

    it('llm_error 错误可重试', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw new Error('LLM rate_limit exceeded');
      });
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn, 2);
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.type).toBe('llm_error');
        expect(outcome.error.retryCount).toBe(2);
      }
      expect(workerFn).toHaveBeenCalledTimes(3);
    });

    it('tool_failure 错误可重试', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw new Error('tool execution failed');
      });
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn, 1);
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.type).toBe('tool_failure');
        expect(outcome.error.retryCount).toBe(1);
      }
      expect(workerFn).toHaveBeenCalledTimes(2); // 1 + 1 = 2 次
    });
  });

  describe('不可重试错误', () => {
    it('permission_denied 不重试，立即返回 skip', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw new Error('Permission denied by guardrail');
      });
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn, 2);
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.type).toBe('permission_denied');
        expect(outcome.error.suggestedAction).toBe('skip');
        expect(outcome.error.retryCount).toBe(0); // 没有重试
      }
      // 只调用 1 次（不重试）
      expect(workerFn).toHaveBeenCalledTimes(1);
    });

    it('unknown 错误不重试，立即返回 abort', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw new Error('something completely weird');
      });
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn, 2);
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.type).toBe('unknown');
        expect(outcome.error.suggestedAction).toBe('abort');
        expect(outcome.error.retryCount).toBe(0);
      }
      expect(workerFn).toHaveBeenCalledTimes(1);
    });

    it('非 Error 对象也能被分类', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw 'string error'; // 非 Error 对象
      });
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn, 2);
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.type).toBe('unknown');
        expect(outcome.error.message).toBe('string error');
      }
    });
  });

  describe('classifyWorkerError 错误分类', () => {
    const orch = new Orchestrator(makeMockClient(), 'test-model');

    it('正确分类 timeout', () => {
      expect(orch.classifyWorkerError(new Error('Request timeout'))).toBe('timeout');
      expect(orch.classifyWorkerError(new Error('ETIMEDOUT'))).toBe('timeout');
      expect(orch.classifyWorkerError(new Error('操作超时'))).toBe('timeout');
    });

    it('正确分类 permission_denied', () => {
      expect(orch.classifyWorkerError(new Error('Permission denied'))).toBe('permission_denied');
      expect(orch.classifyWorkerError(new Error('权限被拒绝'))).toBe('permission_denied');
    });

    it('正确分类 llm_error', () => {
      expect(orch.classifyWorkerError(new Error('LLM api error'))).toBe('llm_error');
      expect(orch.classifyWorkerError(new Error('rate_limit exceeded'))).toBe('llm_error');
      expect(orch.classifyWorkerError(new Error('auth failed'))).toBe('llm_error');
    });

    it('正确分类 tool_failure', () => {
      expect(orch.classifyWorkerError(new Error('tool execution failed'))).toBe('tool_failure');
      expect(orch.classifyWorkerError(new Error('工具执行失败'))).toBe('tool_failure');
    });

    it('无法分类 → unknown', () => {
      expect(orch.classifyWorkerError(new Error('something weird'))).toBe('unknown');
      expect(orch.classifyWorkerError('string')).toBe('unknown');
      expect(orch.classifyWorkerError({})).toBe('unknown');
      expect(orch.classifyWorkerError(null)).toBe('unknown');
    });

    it('支持 error.type 字段', () => {
      const err = new Error('msg');
      (err as { type?: string }).type = 'permission_denied';
      expect(orch.classifyWorkerError(err)).toBe('permission_denied');
    });
  });

  describe('isRetryable', () => {
    const orch = new Orchestrator(makeMockClient(), 'test-model');

    it('timeout 可重试', () => {
      expect(orch.isRetryable('timeout')).toBe(true);
    });

    it('llm_error 可重试', () => {
      expect(orch.isRetryable('llm_error')).toBe(true);
    });

    it('tool_failure 可重试', () => {
      expect(orch.isRetryable('tool_failure')).toBe(true);
    });

    it('permission_denied 不可重试', () => {
      expect(orch.isRetryable('permission_denied')).toBe(false);
    });

    it('unknown 不可重试', () => {
      expect(orch.isRetryable('unknown')).toBe(false);
    });
  });

  describe('maxRetries 边界', () => {
    it('maxRetries=0 → 不重试，失败立即返回', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw new Error('timeout');
      });
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn, 0);
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.retryCount).toBe(0);
      }
      expect(workerFn).toHaveBeenCalledTimes(1);
    });

    it('maxRetries=5 → 最多尝试 6 次', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw new Error('timeout');
      });
      const outcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn, 5);
      expect(outcome.success).toBe(false);
      expect(workerFn).toHaveBeenCalledTimes(6);
    }, 30000); // 线性退避 1+2+3+4+5=15s，给足超时余量
  });

  describe('WorkerOutcome 类型守卫', () => {
    it('success outcome 有 result 字段', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => 'ok');
      const outcome: WorkerOutcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn);
      if (outcome.success) {
        expect(typeof outcome.result).toBe('string');
        expect(outcome.workerId).toBe('w-1');
      } else {
        expect.fail('应该成功');
      }
    });

    it('failure outcome 有 error 字段', async () => {
      const orch = new Orchestrator(makeMockClient(), 'test-model');
      const workerFn: WorkerFunction = vi.fn(async () => {
        throw new Error('permission denied');
      });
      const outcome: WorkerOutcome = await orch.executeWorkerIsolated('w-1', makeTask(), workerFn);
      if (!outcome.success) {
        expect(outcome.error).toBeDefined();
        expect(outcome.error.type).toBe('permission_denied');
        expect(outcome.error.workerId).toBe('w-1');
      } else {
        expect.fail('应该失败');
      }
    });
  });
});
