// tests/agent/middleware.test.ts
// AgentMiddlewarePipeline 单元测试

import { describe, it, expect, vi } from 'vitest';
import {
  AgentMiddlewarePipeline,
  type MiddlewareContext,
  type MiddlewarePhase,
} from '../../src/agent/middleware.js';

function makeCtx(phase: MiddlewarePhase): MiddlewareContext {
  return { phase, metadata: {} };
}

describe('AgentMiddlewarePipeline', () => {
  it('按注册顺序执行中间件', async () => {
    const pipeline = new AgentMiddlewarePipeline();
    const order: string[] = [];

    pipeline.register('onAgent', async (_ctx, next) => {
      order.push('first');
      await next();
    });
    pipeline.register('onAgent', async (_ctx, next) => {
      order.push('second');
      await next();
    });
    pipeline.register('onAgent', async (_ctx, next) => {
      order.push('third');
      await next();
    });

    await pipeline.execute('onAgent', makeCtx('onAgent'));
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('next() 不调用时管线中止', async () => {
    const pipeline = new AgentMiddlewarePipeline();
    const order: string[] = [];

    pipeline.register('onReasoning', async (_ctx, _next) => {
      // 故意不调用 next()
      order.push('stop-here');
    });
    pipeline.register('onReasoning', async (_ctx, next) => {
      order.push('should-not-run');
      await next();
    });

    await pipeline.execute('onReasoning', makeCtx('onReasoning'));
    expect(order).toEqual(['stop-here']);
  });

  it('五个阶段都能正确触发', async () => {
    const pipeline = new AgentMiddlewarePipeline();
    const phasesHit: MiddlewarePhase[] = [];

    const allPhases: MiddlewarePhase[] = [
      'onAgent',
      'onReasoning',
      'onActing',
      'onModelCall',
      'onSystemPrompt',
    ];
    for (const phase of allPhases) {
      pipeline.register(phase, async (ctx, next) => {
        phasesHit.push(ctx.phase);
        await next();
      });
    }

    for (const phase of allPhases) {
      await pipeline.execute(phase, makeCtx(phase));
    }

    expect(phasesHit).toEqual(allPhases);
  });

  it('无中间件时 execute 不报错', async () => {
    const pipeline = new AgentMiddlewarePipeline();
    await expect(pipeline.execute('onActing', makeCtx('onActing'))).resolves.toBeUndefined();
  });

  it('中间件可以修改上下文', async () => {
    const pipeline = new AgentMiddlewarePipeline();
    pipeline.register('onSystemPrompt', async (ctx, next) => {
      ctx.metadata.touched = true;
      await next();
    });
    pipeline.register('onSystemPrompt', async (ctx, next) => {
      ctx.metadata.second = true;
      await next();
    });

    const ctx = makeCtx('onSystemPrompt');
    await pipeline.execute('onSystemPrompt', ctx);
    expect(ctx.metadata.touched).toBe(true);
    expect(ctx.metadata.second).toBe(true);
  });

  it('不同阶段的中间件互不干扰', async () => {
    const pipeline = new AgentMiddlewarePipeline();
    const agentCalls: string[] = [];
    const reasoningCalls: string[] = [];

    pipeline.register('onAgent', async (_ctx, next) => {
      agentCalls.push('a1');
      await next();
    });
    pipeline.register('onReasoning', async (_ctx, next) => {
      reasoningCalls.push('r1');
      await next();
    });

    await pipeline.execute('onAgent', makeCtx('onAgent'));
    await pipeline.execute('onReasoning', makeCtx('onReasoning'));

    expect(agentCalls).toEqual(['a1']);
    expect(reasoningCalls).toEqual(['r1']);
  });

  it('handler 被调用时收到正确的 ctx', async () => {
    const pipeline = new AgentMiddlewarePipeline();
    const handler = vi.fn().mockImplementation(async (_ctx: MiddlewareContext, next: () => Promise<void>) => {
      await next();
    });
    pipeline.register('onActing', handler);

    const ctx: MiddlewareContext = {
      phase: 'onActing',
      toolName: 'file_read',
      toolArgs: { path: '/tmp/x' },
      metadata: { requestId: 1 },
    };
    await pipeline.execute('onActing', ctx);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(ctx);
  });
});
