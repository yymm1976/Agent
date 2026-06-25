// tests/agent/hooks-extended.test.ts
// Phase 31 Task 6.7：扩展钩子（pre-tool-call / post-tool-call / on-session-start / on-session-end）测试

import { describe, it, expect, beforeEach } from 'vitest';
import {
  HookRunner,
  createHookRunner,
  type HookContext,
  type HookResult,
} from '../../src/agent/hooks.js';

describe('HookRunner 扩展钩子 (Phase 31 Task 6.7)', () => {
  let runner: HookRunner;

  beforeEach(() => {
    runner = createHookRunner();
  });

  function makeToolContext(overrides?: Partial<HookContext>): HookContext {
    return {
      stepId: 'step-1',
      agentId: 'agent-1',
      projectPath: '/test',
      toolName: 'file_read',
      toolArgs: { path: '/test/a.ts' },
      ...overrides,
    };
  }

  // ============================================================
  // pre-tool-call
  // ============================================================
  describe('pre-tool-call', () => {
    it('注册并触发 pre-tool-call 钩子', async () => {
      let called = false;
      runner.register({
        event: 'pre-tool-call',
        handler: async () => {
          called = true;
          return { action: 'continue' };
        },
        name: 'pre-tool-1',
      });

      await runner.fire('pre-tool-call', makeToolContext());
      expect(called).toBe(true);
    });

    it('pre-tool-call 返回 skip 跳过工具调用', async () => {
      runner.register({
        event: 'pre-tool-call',
        handler: async () => ({
          action: 'skip',
          modifiedToolResult: '工具被跳过，返回预设结果',
        }),
        name: 'skip-hook',
      });

      const result = await runner.fire('pre-tool-call', makeToolContext());
      expect(result.action).toBe('skip');
      expect(result.modifiedToolResult).toBe('工具被跳过，返回预设结果');
    });

    it('pre-tool-call 返回 abort 中止整个任务', async () => {
      runner.register({
        event: 'pre-tool-call',
        handler: async () => ({
          action: 'abort',
          message: '检测到危险操作，中止任务',
        }),
        name: 'abort-hook',
      });

      const result = await runner.fire('pre-tool-call', makeToolContext());
      expect(result.action).toBe('abort');
      expect(result.message).toContain('危险操作');
    });

    it('pre-tool-call 上下文包含 toolName 和 toolArgs', async () => {
      let capturedCtx: HookContext | null = null;
      runner.register({
        event: 'pre-tool-call',
        handler: async (ctx) => {
          capturedCtx = ctx;
          return { action: 'continue' };
        },
        name: 'capture-hook',
      });

      await runner.fire('pre-tool-call', makeToolContext({
        toolName: 'file_write',
        toolArgs: { path: '/test/b.ts', content: 'hello' },
      }));

      expect(capturedCtx!.toolName).toBe('file_write');
      expect(capturedCtx!.toolArgs).toEqual({ path: '/test/b.ts', content: 'hello' });
    });

    it('多个 pre-tool-call 钩子按 priority 排序', async () => {
      const order: string[] = [];
      runner.register({
        event: 'pre-tool-call',
        handler: async () => {
          order.push('second');
          return { action: 'continue' };
        },
        name: 'second',
        priority: 200,
      });
      runner.register({
        event: 'pre-tool-call',
        handler: async () => {
          order.push('first');
          return { action: 'continue' };
        },
        name: 'first',
        priority: 50,
      });

      await runner.fire('pre-tool-call', makeToolContext());
      expect(order).toEqual(['first', 'second']);
    });

    it('abort 短路后续钩子', async () => {
      let secondCalled = false;
      runner.register({
        event: 'pre-tool-call',
        handler: async () => ({ action: 'abort', message: 'abort' }),
        name: 'first',
        priority: 1,
      });
      runner.register({
        event: 'pre-tool-call',
        handler: async () => {
          secondCalled = true;
          return { action: 'continue' };
        },
        name: 'second',
        priority: 2,
      });

      await runner.fire('pre-tool-call', makeToolContext());
      expect(secondCalled).toBe(false);
    });
  });

  // ============================================================
  // post-tool-call
  // ============================================================
  describe('post-tool-call', () => {
    it('注册并触发 post-tool-call 钩子', async () => {
      let called = false;
      runner.register({
        event: 'post-tool-call',
        handler: async () => {
          called = true;
          return { action: 'continue' };
        },
        name: 'post-tool-1',
      });

      await runner.fire('post-tool-call', makeToolContext({
        toolResult: 'file content here',
        toolDuration: 150,
      }));
      expect(called).toBe(true);
    });

    it('post-tool-call 返回 retry 重新执行工具', async () => {
      runner.register({
        event: 'post-tool-call',
        handler: async () => ({
          action: 'retry',
          message: '结果异常，重试',
        }),
        name: 'retry-hook',
      });

      const result = await runner.fire('post-tool-call', makeToolContext());
      expect(result.action).toBe('retry');
    });

    it('post-tool-call 返回 modifiedResult 替换工具结果', async () => {
      runner.register({
        event: 'post-tool-call',
        handler: async () => ({
          action: 'continue',
          modifiedToolResult: '脱敏后的结果',
        }),
        name: 'sanitize-hook',
      });

      const result = await runner.fire('post-tool-call', makeToolContext());
      expect(result.modifiedToolResult).toBe('脱敏后的结果');
    });

    it('post-tool-call 上下文包含 toolResult 和 toolDuration', async () => {
      let capturedCtx: HookContext | null = null;
      runner.register({
        event: 'post-tool-call',
        handler: async (ctx) => {
          capturedCtx = ctx;
          return { action: 'continue' };
        },
        name: 'capture',
      });

      await runner.fire('post-tool-call', makeToolContext({
        toolResult: 'success output',
        toolDuration: 250,
      }));

      expect(capturedCtx!.toolResult).toBe('success output');
      expect(capturedCtx!.toolDuration).toBe(250);
    });

    it('多个 post-tool-call 钩子的 modifiedToolResult 被保留', async () => {
      runner.register({
        event: 'post-tool-call',
        handler: async () => ({
          action: 'continue',
          modifiedToolResult: 'first modification',
        }),
        name: 'first',
        priority: 1,
      });
      runner.register({
        event: 'post-tool-call',
        handler: async () => ({
          action: 'continue',
          modifiedToolResult: 'second modification',
        }),
        name: 'second',
        priority: 2,
      });

      const result = await runner.fire('post-tool-call', makeToolContext());
      // 最后一个 modifiedToolResult 被保留
      expect(result.modifiedToolResult).toBe('second modification');
    });
  });

  // ============================================================
  // on-session-start / on-session-end
  // ============================================================
  describe('on-session-start', () => {
    it('注册并触发 on-session-start 钩子', async () => {
      let called = false;
      runner.register({
        event: 'on-session-start',
        handler: async () => {
          called = true;
          return { action: 'continue' };
        },
        name: 'session-start',
      });

      await runner.fire('on-session-start', makeToolContext());
      expect(called).toBe(true);
    });

    it('on-session-start 可用于初始化资源', async () => {
      let initialized = false;
      runner.register({
        event: 'on-session-start',
        handler: async () => {
          initialized = true;
          return { action: 'continue' };
        },
        name: 'init',
      });

      await runner.fire('on-session-start', makeToolContext());
      expect(initialized).toBe(true);
    });
  });

  describe('on-session-end', () => {
    it('注册并触发 on-session-end 钩子', async () => {
      let called = false;
      runner.register({
        event: 'on-session-end',
        handler: async () => {
          called = true;
          return { action: 'continue' };
        },
        name: 'session-end',
      });

      await runner.fire('on-session-end', makeToolContext());
      expect(called).toBe(true);
    });

    it('on-session-end 可用于清理资源', async () => {
      let cleaned = false;
      runner.register({
        event: 'on-session-end',
        handler: async () => {
          cleaned = true;
          return { action: 'continue' };
        },
        name: 'cleanup',
      });

      await runner.fire('on-session-end', makeToolContext());
      expect(cleaned).toBe(true);
    });
  });

  // ============================================================
  // 动作合并
  // ============================================================
  describe('动作严格度合并', () => {
    it('continue + abort = abort', async () => {
      runner.register({
        event: 'pre-tool-call',
        handler: async () => ({ action: 'continue' }),
        name: 'c',
        priority: 1,
      });
      runner.register({
        event: 'pre-tool-call',
        handler: async () => ({ action: 'abort' }),
        name: 'a',
        priority: 2,
      });

      const result = await runner.fire('pre-tool-call', makeToolContext());
      expect(result.action).toBe('abort');
    });

    it('continue + skip = skip', async () => {
      runner.register({
        event: 'pre-tool-call',
        handler: async () => ({ action: 'continue' }),
        name: 'c',
        priority: 1,
      });
      runner.register({
        event: 'pre-tool-call',
        handler: async () => ({ action: 'skip' }),
        name: 's',
        priority: 2,
      });

      const result = await runner.fire('pre-tool-call', makeToolContext());
      expect(result.action).toBe('skip');
    });

    it('skip + retry = retry', async () => {
      runner.register({
        event: 'post-tool-call',
        handler: async () => ({ action: 'skip' }),
        name: 's',
        priority: 1,
      });
      runner.register({
        event: 'post-tool-call',
        handler: async () => ({ action: 'retry' }),
        name: 'r',
        priority: 2,
      });

      const result = await runner.fire('post-tool-call', makeToolContext());
      expect(result.action).toBe('retry');
    });

    it('retry + abort = abort', async () => {
      runner.register({
        event: 'post-tool-call',
        handler: async () => ({ action: 'retry' }),
        name: 'r',
        priority: 1,
      });
      runner.register({
        event: 'post-tool-call',
        handler: async () => ({ action: 'abort' }),
        name: 'a',
        priority: 2,
      });

      const result = await runner.fire('post-tool-call', makeToolContext());
      expect(result.action).toBe('abort');
    });
  });

  // ============================================================
  // 错误隔离
  // ============================================================
  describe('钩子错误隔离', () => {
    it('一个钩子崩溃不影响其他钩子', async () => {
      let secondCalled = false;
      runner.register({
        event: 'pre-tool-call',
        handler: async () => {
          throw new Error('hook crashed');
        },
        name: 'crash',
        priority: 1,
      });
      runner.register({
        event: 'pre-tool-call',
        handler: async () => {
          secondCalled = true;
          return { action: 'continue' };
        },
        name: 'ok',
        priority: 2,
      });

      const result = await runner.fire('pre-tool-call', makeToolContext());
      expect(secondCalled).toBe(true);
      expect(result.action).toBe('continue');
    });
  });

  // ============================================================
  // 注销
  // ============================================================
  describe('注销扩展钩子', () => {
    it('按 name 注销 pre-tool-call 钩子', () => {
      runner.register({
        event: 'pre-tool-call',
        handler: async () => ({ action: 'continue' }),
        name: 'to-remove',
      });
      expect(runner.count('pre-tool-call')).toBe(1);

      const removed = runner.unregister('to-remove');
      expect(removed).toBe(1);
      expect(runner.count('pre-tool-call')).toBe(0);
    });

    it('按 name 注销 post-tool-call 钩子', () => {
      runner.register({
        event: 'post-tool-call',
        handler: async () => ({ action: 'continue' }),
        name: 'post-hook',
      });
      const removed = runner.unregister('post-hook');
      expect(removed).toBe(1);
      expect(runner.count('post-tool-call')).toBe(0);
    });
  });
});
