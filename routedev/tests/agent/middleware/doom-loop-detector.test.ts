// tests/agent/middleware/doom-loop-detector.test.ts
// Phase 96+ B1：Doom Loop 检测中间件单元测试
// 覆盖：阈值触发、严重级别、窗口滑动、非写工具重置、路径提取兼容性

import { describe, it, expect, beforeEach } from 'vitest';
import { DoomLoopDetectorMiddleware } from '../../../src/agent/middleware/doom-loop-detector.js';
import type { MiddlewareContext } from '../../../src/agent/middleware.js';

/** 构造 onActing 上下文的辅助函数 */
function makeCtx(toolName: string, args: Record<string, unknown>): MiddlewareContext {
  return {
    phase: 'onActing',
    toolName,
    toolArgs: args,
    metadata: {},
  };
}

/** 调用中间件并返回更新后的 metadata */
async function run(mw: DoomLoopDetectorMiddleware, ctx: MiddlewareContext): Promise<void> {
  const handler = mw.getHandler();
  await handler(ctx, async () => {});
}

describe('DoomLoopDetectorMiddleware', () => {
  let mw: DoomLoopDetectorMiddleware;

  beforeEach(() => {
    // 缩小阈值方便测试
    mw = new DoomLoopDetectorMiddleware({
      windowSize: 10,
      warnThreshold: 3,
      criticalThreshold: 5,
    });
  });

  it('非写操作工具不触发检测且重置窗口', async () => {
    // 先注入一些写操作记录
    for (let i = 0; i < 4; i++) {
      await run(mw, makeCtx('file_edit', { path: '/app/file.ts' }));
    }
    expect(mw.getSnapshot().length).toBe(4);

    // 调用读操作 → 重置窗口
    const ctx = makeCtx('file_read', { path: '/app/file.ts' });
    await run(mw, ctx);
    expect(ctx.metadata.doomLoopDetected).toBeUndefined();
    expect(mw.getSnapshot().length).toBe(0);
  });

  it('写操作未到阈值时不触发提示', async () => {
    const ctx1 = makeCtx('file_edit', { path: '/app/file.ts' });
    await run(mw, ctx1);
    expect(ctx1.metadata.doomLoopDetected).toBeUndefined();

    const ctx2 = makeCtx('file_edit', { path: '/app/file.ts' });
    await run(mw, ctx2);
    expect(ctx2.metadata.doomLoopDetected).toBeUndefined();
  });

  it('达到警告阈值时注入 warn 级别提示', async () => {
    let lastCtx: MiddlewareContext | null = null;
    for (let i = 0; i < 3; i++) {
      lastCtx = makeCtx('file_edit', { path: '/app/file.ts' });
      await run(mw, lastCtx);
    }
    expect(lastCtx!.metadata.doomLoopDetected).toBe(true);
    expect(lastCtx!.metadata.doomLoopSeverity).toBe('warn');
    expect(lastCtx!.metadata.doomLoopFile).toBe('/app/file.ts');
    expect(lastCtx!.metadata.doomLoopCount).toBe(3);
    expect(lastCtx!.metadata.explorationSuggestion).toContain('Doom Loop 提示');
    expect(lastCtx!.metadata.explorationSuggestion).toContain('/app/file.ts');
  });

  it('达到严重阈值时注入 critical 级别提示', async () => {
    let lastCtx: MiddlewareContext | null = null;
    for (let i = 0; i < 5; i++) {
      lastCtx = makeCtx('file_edit', { path: '/app/file.ts' });
      await run(mw, lastCtx);
    }
    expect(lastCtx!.metadata.doomLoopDetected).toBe(true);
    expect(lastCtx!.metadata.doomLoopSeverity).toBe('critical');
    expect(lastCtx!.metadata.doomLoopCount).toBe(5);
    expect(lastCtx!.metadata.explorationSuggestion).toContain('严重 Doom Loop 警告');
    expect(lastCtx!.metadata.explorationSuggestion).toContain('换方法');
  });

  it('严重触发后清空窗口避免重复告警', async () => {
    // 触发 critical（5 次）
    for (let i = 0; i < 5; i++) {
      await run(mw, makeCtx('file_edit', { path: '/app/file.ts' }));
    }
    expect(mw.getSnapshot().length).toBe(0);

    // 下一次同文件编辑应该重新计数（不会立刻再次触发 critical）
    const ctx = makeCtx('file_edit', { path: '/app/file.ts' });
    await run(mw, ctx);
    expect(ctx.metadata.doomLoopSeverity).toBeUndefined();
  });

  it('不同文件不互相累加', async () => {
    await run(mw, makeCtx('file_edit', { path: '/app/a.ts' }));
    await run(mw, makeCtx('file_edit', { path: '/app/b.ts' }));
    await run(mw, makeCtx('file_edit', { path: '/app/a.ts' }));

    // a.ts 才 2 次，未到 warn 阈值 3
    const ctx = makeCtx('file_edit', { path: '/app/a.ts' });
    await run(mw, ctx);
    expect(ctx.metadata.doomLoopCount).toBe(3);
    expect(ctx.metadata.doomLoopSeverity).toBe('warn');
  });

  it('窗口滑动后旧记录被丢弃', async () => {
    // windowSize=10，写入 10 个不同文件后再写 a.ts，旧 a.ts 应被丢弃
    for (let i = 0; i < 10; i++) {
      await run(mw, makeCtx('file_edit', { path: `/app/f${i}.ts` }));
    }
    // 此时窗口已满（10 个不同文件），再写 a.ts
    const ctx = makeCtx('file_edit', { path: '/app/a.ts' });
    await run(mw, ctx);
    // a.ts 仅 1 次，未触发
    expect(ctx.metadata.doomLoopDetected).toBeUndefined();
  });

  it('兼容 path / filePath / file_path 三种字段名', async () => {
    // path 字段
    const ctx1 = makeCtx('file_edit', { path: '/app/x.ts' });
    await run(mw, ctx1);
    expect(ctx1.metadata.doomLoopDetected).toBeUndefined();

    // filePath 字段
    const ctx2 = makeCtx('file_write', { filePath: '/app/x.ts' });
    await run(mw, ctx2);
    expect(ctx2.metadata.doomLoopDetected).toBeUndefined();

    // file_path 字段
    const ctx3 = makeCtx('file_write', { file_path: '/app/x.ts' });
    await run(mw, ctx3);
    // 累计 3 次，应触发 warn
    expect(ctx3.metadata.doomLoopSeverity).toBe('warn');
    expect(ctx3.metadata.doomLoopCount).toBe(3);
  });

  it('路径大小写不敏感（跨平台一致）', async () => {
    await run(mw, makeCtx('file_edit', { path: '/App/File.TS' }));
    await run(mw, makeCtx('file_edit', { path: '/app/file.ts' }));
    const ctx = makeCtx('file_edit', { path: '/APP/FILE.ts' });
    await run(mw, ctx);
    // 3 次同文件（大小写归一化后），应触发 warn
    expect(ctx.metadata.doomLoopSeverity).toBe('warn');
    expect(ctx.metadata.doomLoopCount).toBe(3);
  });

  it('路径带引号时正确提取', async () => {
    await run(mw, makeCtx('file_edit', { path: '"/app/quoted.ts"' }));
    await run(mw, makeCtx('file_edit', { path: "'/app/quoted.ts'" }));
    const ctx = makeCtx('file_edit', { path: '/app/quoted.ts' });
    await run(mw, ctx);
    expect(ctx.metadata.doomLoopSeverity).toBe('warn');
    expect(ctx.metadata.doomLoopCount).toBe(3);
  });

  it('写操作但无路径参数时跳过检测（不阻断）', async () => {
    const ctx = makeCtx('file_edit', {});
    await expect(run(mw, ctx)).resolves.toBeUndefined();
    expect(ctx.metadata.doomLoopDetected).toBeUndefined();
    expect(mw.getSnapshot().length).toBe(0);
  });

  it('file_write 与 file_edit 都被追踪', async () => {
    await run(mw, makeCtx('file_edit', { path: '/app/mixed.ts' }));
    await run(mw, makeCtx('file_write', { path: '/app/mixed.ts' }));
    const ctx = makeCtx('file_edit', { path: '/app/mixed.ts' });
    await run(mw, ctx);
    expect(ctx.metadata.doomLoopSeverity).toBe('warn');
    expect(ctx.metadata.doomLoopCount).toBe(3);
  });

  it('reset() 清空窗口状态', async () => {
    // 4 次写入未触发 critical（阈值 5），窗口仍有记录
    for (let i = 0; i < 4; i++) {
      await run(mw, makeCtx('file_edit', { path: '/app/r.ts' }));
    }
    expect(mw.getSnapshot().length).toBe(4);

    // reset 清空
    mw.reset();
    expect(mw.getSnapshot().length).toBe(0);

    // 重新累积不会受旧记录影响
    for (let i = 0; i < 2; i++) {
      await run(mw, makeCtx('file_edit', { path: '/app/r.ts' }));
    }
    expect(mw.getSnapshot().length).toBe(2);

    // 再次 reset
    mw.reset();
    expect(mw.getSnapshot().length).toBe(0);
  });

  it('提示信息中包含文件路径与计数', async () => {
    for (let i = 0; i < 3; i++) {
      const ctx = makeCtx('file_edit', { path: '/app/info.ts' });
      await run(mw, ctx);
      if (ctx.metadata.explorationSuggestion) {
        expect(ctx.metadata.explorationSuggestion).toContain('/app/info.ts');
        expect(ctx.metadata.explorationSuggestion).toContain('3');
      }
    }
  });

  it('使用默认阈值（6/12）时不误触发', async () => {
    const defaultMw = new DoomLoopDetectorMiddleware();
    for (let i = 0; i < 5; i++) {
      const ctx = makeCtx('file_edit', { path: '/app/default.ts' });
      await run(defaultMw, ctx);
      expect(ctx.metadata.doomLoopDetected).toBeUndefined();
    }
    // 第 6 次触发 warn
    const ctx = makeCtx('file_edit', { path: '/app/default.ts' });
    await run(defaultMw, ctx);
    expect(ctx.metadata.doomLoopSeverity).toBe('warn');
    expect(ctx.metadata.doomLoopCount).toBe(6);
  });
});
