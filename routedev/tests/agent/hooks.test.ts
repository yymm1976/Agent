// tests/agent/hooks.test.ts
// HookRunner 生命周期钩子系统测试（Phase 24 Task 4）

import { describe, it, expect, beforeEach } from 'vitest';
import {
  HookRunner,
  createHookRunner,
  type HookDefinition,
  type HookContext,
  type HookResult,
} from '../../src/agent/hooks.js';

describe('HookRunner 生命周期钩子 (Phase 24 Task 4)', () => {
  let runner: HookRunner;

  beforeEach(() => {
    runner = createHookRunner();
  });

  function makeContext(overrides?: Partial<HookContext>): HookContext {
    return {
      stepId: 'step-1',
      agentId: 'agent-1',
      projectPath: '/test',
      ...overrides,
    };
  }

  // ============================================================
  // 注册与注销
  // ============================================================
  describe('注册与注销', () => {
    it('register 添加钩子', () => {
      runner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'continue' }),
        name: 'hook1',
      });
      expect(runner.count('pre-step')).toBe(1);
    });

    it('register 多个钩子', () => {
      runner.register({ event: 'pre-step', handler: async () => ({ action: 'continue' }), name: 'h1' });
      runner.register({ event: 'post-step', handler: async () => ({ action: 'continue' }), name: 'h2' });
      runner.register({ event: 'on-error', handler: async () => ({ action: 'continue' }), name: 'h3' });
      expect(runner.count('pre-step')).toBe(1);
      expect(runner.count('post-step')).toBe(1);
      expect(runner.count('on-error')).toBe(1);
    });

    it('unregister 按 name 注销', () => {
      runner.register({ event: 'pre-step', handler: async () => ({ action: 'continue' }), name: 'h1' });
      runner.register({ event: 'pre-step', handler: async () => ({ action: 'continue' }), name: 'h2' });
      const removed = runner.unregister('h1');
      expect(removed).toBe(1);
      expect(runner.count('pre-step')).toBe(1);
    });

    it('unregister 不存在的 name 返回 0', () => {
      const removed = runner.unregister('nonexistent');
      expect(removed).toBe(0);
    });

    it('unregister 跨事件注销同名钩子', () => {
      runner.register({ event: 'pre-step', handler: async () => ({ action: 'continue' }), name: 'shared' });
      runner.register({ event: 'post-step', handler: async () => ({ action: 'continue' }), name: 'shared' });
      const removed = runner.unregister('shared');
      expect(removed).toBe(2);
    });
  });

  // ============================================================
  // 优先级排序
  // ============================================================
  describe('优先级排序', () => {
    it('按 priority 升序执行', async () => {
      const order: string[] = [];
      runner.register({
        event: 'pre-step',
        handler: async () => { order.push('low'); return { action: 'continue' }; },
        priority: 200,
        name: 'low',
      });
      runner.register({
        event: 'pre-step',
        handler: async () => { order.push('high'); return { action: 'continue' }; },
        priority: 50,
        name: 'high',
      });
      runner.register({
        event: 'pre-step',
        handler: async () => { order.push('mid'); return { action: 'continue' }; },
        priority: 100,
        name: 'mid',
      });

      await runner.fire('pre-step', makeContext());
      expect(order).toEqual(['high', 'mid', 'low']);
    });

    it('未指定 priority 默认 100', async () => {
      const order: string[] = [];
      runner.register({
        event: 'pre-step',
        handler: async () => { order.push('default'); return { action: 'continue' }; },
        name: 'default',
      });
      runner.register({
        event: 'pre-step',
        handler: async () => { order.push('high'); return { action: 'continue' }; },
        priority: 50,
        name: 'high',
      });

      await runner.fire('pre-step', makeContext());
      expect(order).toEqual(['high', 'default']);
    });
  });

  // ============================================================
  // abort 短路
  // ============================================================
  describe('abort 短路', () => {
    it('pre-step 返回 abort 时后续钩子不执行', async () => {
      const executed: string[] = [];
      runner.register({
        event: 'pre-step',
        handler: async () => { executed.push('first'); return { action: 'abort', message: 'blocked' }; },
        priority: 1,
        name: 'first',
      });
      runner.register({
        event: 'pre-step',
        handler: async () => { executed.push('second'); return { action: 'continue' }; },
        priority: 2,
        name: 'second',
      });

      const result = await runner.fire('pre-step', makeContext());
      expect(result.action).toBe('abort');
      expect(result.message).toBe('blocked');
      expect(executed).toEqual(['first']);
    });
  });

  // ============================================================
  // 钩子崩溃隔离
  // ============================================================
  describe('钩子崩溃隔离', () => {
    it('单个钩子崩溃不影响其他钩子', async () => {
      const executed: string[] = [];
      runner.register({
        event: 'pre-step',
        handler: async () => { executed.push('first'); throw new Error('boom'); },
        priority: 1,
        name: 'crash',
      });
      runner.register({
        event: 'pre-step',
        handler: async () => { executed.push('second'); return { action: 'continue' }; },
        priority: 2,
        name: 'ok',
      });

      const result = await runner.fire('pre-step', makeContext());
      expect(result.action).toBe('continue');
      expect(executed).toEqual(['first', 'second']);
    });

    it('崩溃的钩子不影响最终结果', async () => {
      runner.register({
        event: 'post-step',
        handler: async () => { throw new Error('crash'); },
        name: 'crash',
      });
      runner.register({
        event: 'post-step',
        handler: async () => ({ action: 'continue', message: 'ok' }),
        name: 'ok',
      });

      const result = await runner.fire('post-step', makeContext());
      expect(result.action).toBe('continue');
    });
  });

  // ============================================================
  // retry 语义
  // ============================================================
  describe('retry 语义', () => {
    it('post-step 返回 retry', async () => {
      runner.register({
        event: 'post-step',
        handler: async () => ({ action: 'retry', message: '需要重试' }),
        name: 'retry-hook',
      });

      const result = await runner.fire('post-step', makeContext());
      expect(result.action).toBe('retry');
      expect(result.message).toBe('需要重试');
    });

    it('on-error 返回 retry', async () => {
      runner.register({
        event: 'on-error',
        handler: async () => ({ action: 'retry' }),
        name: 'error-retry',
      });

      const result = await runner.fire('on-error', makeContext({
        error: { message: 'timeout' },
      }));
      expect(result.action).toBe('retry');
    });
  });

  // ============================================================
  // 结果合并（最严格胜出）
  // ============================================================
  describe('结果合并', () => {
    it('abort > retry > skip > continue', async () => {
      runner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'continue' }),
        priority: 1,
        name: 'c',
      });
      runner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'skip' }),
        priority: 2,
        name: 's',
      });
      runner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'retry' }),
        priority: 3,
        name: 'r',
      });

      const result = await runner.fire('pre-step', makeContext());
      // retry 比 skip 严格，但 abort 最严格
      expect(result.action).toBe('retry');
    });

    it('abort 胜过其他', async () => {
      runner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'continue' }),
        priority: 1,
      });
      runner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'abort' }),
        priority: 2,
      });
      runner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'retry' }),
        priority: 3,
      });

      const result = await runner.fire('pre-step', makeContext());
      expect(result.action).toBe('abort');
    });
  });

  // ============================================================
  // modifiedResult
  // ============================================================
  describe('modifiedResult', () => {
    it('post-step 可修改步骤结果', async () => {
      const modified = { success: true, output: 'modified', durationMs: 200 };
      runner.register({
        event: 'post-step',
        handler: async () => ({ action: 'continue', modifiedResult: modified }),
        name: 'modifier',
      });

      const result = await runner.fire('post-step', makeContext());
      expect(result.modifiedResult).toEqual(modified);
    });
  });

  // ============================================================
  // 空事件
  // ============================================================
  describe('空事件', () => {
    it('无钩子时返回 continue', async () => {
      const result = await runner.fire('pre-step', makeContext());
      expect(result.action).toBe('continue');
    });
  });

  // ============================================================
  // list 和 clear
  // ============================================================
  describe('list 和 clear', () => {
    it('list 返回所有钩子', () => {
      runner.register({ event: 'pre-step', handler: async () => ({ action: 'continue' }), name: 'h1', priority: 50 });
      runner.register({ event: 'post-step', handler: async () => ({ action: 'continue' }), name: 'h2' });

      const list = runner.list();
      expect(list.length).toBe(2);
      expect(list.some(h => h.name === 'h1' && h.priority === 50)).toBe(true);
      expect(list.some(h => h.name === 'h2' && h.priority === 100)).toBe(true);
    });

    it('clear 清除所有钩子', () => {
      runner.register({ event: 'pre-step', handler: async () => ({ action: 'continue' }), name: 'h1' });
      runner.clear();
      expect(runner.list().length).toBe(0);
    });
  });

  // ============================================================
  // on-complete 事件
  // ============================================================
  describe('on-complete 事件', () => {
    it('on-complete 触发并返回 continue', async () => {
      const executed: string[] = [];
      runner.register({
        event: 'on-complete',
        handler: async () => { executed.push('done'); return { action: 'continue', message: 'all done' }; },
        name: 'complete-hook',
      });

      const result = await runner.fire('on-complete', makeContext());
      expect(executed).toEqual(['done']);
      expect(result.action).toBe('continue');
      expect(result.message).toBe('all done');
    });
  });
});
