// tests/agent/quality-signal.test.ts
// Phase 40 Task 3：QualitySignalMiddleware 单元测试

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  QualitySignalMiddleware,
  type QualitySignal,
} from '../../src/agent/middleware/quality-signal.js';
import type { MiddlewareContext, MiddlewarePhase } from '../../src/agent/middleware.js';

function makeCtx(
  phase: MiddlewarePhase,
  overrides: Partial<MiddlewareContext> = {},
): MiddlewareContext {
  return {
    phase,
    metadata: {},
    ...overrides,
  };
}

function makeNext(): () => Promise<void> {
  return async () => {};
}

describe('QualitySignalMiddleware', () => {
  let mw: QualitySignalMiddleware;

  beforeEach(() => {
    mw = new QualitySignalMiddleware();
  });

  describe('工具成功信号采集', () => {
    it('当 ctx.metadata.toolError=false 时应生成 tool_success 信号', async () => {
      const ctx = makeCtx('onActing', {
        toolName: 'file_read',
        metadata: { toolError: false, toolResult: '文件内容', modelId: 'gpt-4' },
      });
      await mw.getHandler()(ctx, makeNext());

      const signals = mw.getSignals();
      const successSignals = signals.filter(s => s.signalType === 'tool_success');
      expect(successSignals.length).toBe(1);
      expect(successSignals[0].toolName).toBe('file_read');
      expect(successSignals[0].modelId).toBe('gpt-4');
      expect(successSignals[0].severity).toBe('low');
      expect(successSignals[0].source).toBe('implicit');
    });

    it('通过 recordToolResult 显式记录成功信号', () => {
      mw.recordToolResult('file_write', true, '写入成功', 'claude-3');
      const signals = mw.getSignals();
      const successSignals = signals.filter(s => s.signalType === 'tool_success');
      expect(successSignals.length).toBe(1);
      expect(successSignals[0].toolName).toBe('file_write');
      expect(successSignals[0].modelId).toBe('claude-3');
    });
  });

  describe('工具失败信号采集', () => {
    it('当 ctx.metadata.toolError=true 时应生成 tool_failure 信号', async () => {
      const ctx = makeCtx('onActing', {
        toolName: 'shell_exec',
        metadata: { toolError: true, toolResult: '命令执行失败', modelId: 'gpt-4' },
      });
      await mw.getHandler()(ctx, makeNext());

      const signals = mw.getSignals();
      const failureSignals = signals.filter(s => s.signalType === 'tool_failure');
      expect(failureSignals.length).toBe(1);
      expect(failureSignals[0].toolName).toBe('shell_exec');
      expect(failureSignals[0].severity).toBe('high');
      expect(failureSignals[0].source).toBe('implicit');
    });

    it('通过 recordToolResult 显式记录失败信号', () => {
      mw.recordToolResult('file_edit', false, '文件不存在', 'gpt-4');
      const signals = mw.getSignals();
      const failureSignals = signals.filter(s => s.signalType === 'tool_failure');
      expect(failureSignals.length).toBe(1);
      expect(failureSignals[0].severity).toBe('high');
    });
  });

  describe('错误模式检测', () => {
    it('应检测 TypeScript 编译错误', async () => {
      const ctx = makeCtx('onActing', {
        toolName: 'shell_exec',
        metadata: {
          toolError: false,
          toolResult: 'src/index.ts(10,5): error TS2304: Cannot find name "foo".',
          modelId: 'gpt-4',
        },
      });
      await mw.getHandler()(ctx, makeNext());

      const signals = mw.getSignals();
      const errorPatternSignals = signals.filter(s => s.signalType === 'error_pattern');
      expect(errorPatternSignals.length).toBe(1);
      expect(errorPatternSignals[0].context?.pattern).toBe('typescript_error');
      expect(errorPatternSignals[0].severity).toBe('high');
    });

    it('应检测编译错误模式', async () => {
      const ctx = makeCtx('onActing', {
        toolName: 'shell_exec',
        metadata: {
          toolError: false,
          toolResult: 'Compilation failed: 2 errors, 0 warnings',
          modelId: 'gpt-4',
        },
      });
      await mw.getHandler()(ctx, makeNext());

      const signals = mw.getSignals();
      const errorPatternSignals = signals.filter(s => s.signalType === 'error_pattern');
      expect(errorPatternSignals.length).toBe(1);
      expect(errorPatternSignals[0].context?.pattern).toBe('compile_error');
    });

    it('应检测运行时异常模式', async () => {
      mw.recordToolResult('shell_exec', true, 'Runtime error: uncaught exception at line 42\nstack trace: ...');
      const signals = mw.getSignals();
      const errorPatternSignals = signals.filter(s => s.signalType === 'error_pattern');
      expect(errorPatternSignals.length).toBe(1);
      expect(errorPatternSignals[0].context?.pattern).toBe('runtime_error');
    });

    it('正常输出不应触发错误模式', async () => {
      const ctx = makeCtx('onActing', {
        toolName: 'file_read',
        metadata: {
          toolError: false,
          toolResult: '文件内容正常，无错误',
          modelId: 'gpt-4',
        },
      });
      await mw.getHandler()(ctx, makeNext());

      const signals = mw.getSignals();
      const errorPatternSignals = signals.filter(s => s.signalType === 'error_pattern');
      expect(errorPatternSignals.length).toBe(0);
    });
  });

  describe('重复调用检测', () => {
    it('5 秒内同一工具被调用 2 次应生成 repeated_call 信号', async () => {
      // 第一次调用
      const ctx1 = makeCtx('onActing', {
        toolName: 'file_read',
        metadata: { modelId: 'gpt-4' },
      });
      await mw.getHandler()(ctx1, makeNext());

      // 第二次调用（5 秒内）
      const ctx2 = makeCtx('onActing', {
        toolName: 'file_read',
        metadata: { modelId: 'gpt-4' },
      });
      await mw.getHandler()(ctx2, makeNext());

      const signals = mw.getSignals();
      const repeatedSignals = signals.filter(s => s.signalType === 'repeated_call');
      expect(repeatedSignals.length).toBe(1);
      expect(repeatedSignals[0].toolName).toBe('file_read');
      expect(repeatedSignals[0].severity).toBe('medium');
      expect(repeatedSignals[0].context?.callCount).toBe(2);
    });

    it('超过 5 秒的重复调用不应生成信号', async () => {
      // 使用 mock 时间
      const now = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

      // 第一次调用
      const ctx1 = makeCtx('onActing', { toolName: 'file_read', metadata: {} });
      await mw.getHandler()(ctx1, makeNext());

      // 模拟 6 秒后
      dateNowSpy.mockReturnValue(now + 6001);

      // 第二次调用（超过 5 秒窗口）
      const ctx2 = makeCtx('onActing', { toolName: 'file_read', metadata: {} });
      await mw.getHandler()(ctx2, makeNext());

      const signals = mw.getSignals();
      const repeatedSignals = signals.filter(s => s.signalType === 'repeated_call');
      expect(repeatedSignals.length).toBe(0);

      dateNowSpy.mockRestore();
    });

    it('不同工具的调用不应触发重复检测', async () => {
      const ctx1 = makeCtx('onActing', { toolName: 'file_read', metadata: {} });
      await mw.getHandler()(ctx1, makeNext());

      const ctx2 = makeCtx('onActing', { toolName: 'file_write', metadata: {} });
      await mw.getHandler()(ctx2, makeNext());

      const signals = mw.getSignals();
      const repeatedSignals = signals.filter(s => s.signalType === 'repeated_call');
      expect(repeatedSignals.length).toBe(0);
    });
  });

  describe('clearSignals', () => {
    it('清空后信号列表应为空', async () => {
      const ctx = makeCtx('onActing', {
        toolName: 'file_read',
        metadata: { toolError: false, toolResult: 'ok' },
      });
      await mw.getHandler()(ctx, makeNext());
      expect(mw.getSignals().length).toBeGreaterThan(0);

      mw.clearSignals();
      expect(mw.getSignals().length).toBe(0);
    });
  });
});
