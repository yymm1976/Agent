// tests/agent/phase27-trace.test.ts
// Phase-27 Task 8 测试：Compose + HookRunner TracePanel 可视化
// 验证 Compose 阶段切换和 HookRunner 钩子执行的 Trace span 记录与显示

import { describe, it, expect, beforeEach } from 'vitest';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import { ComposePipeline, createComposePipeline } from '../../src/agent/compose-pipeline.js';
import { WorkModeController } from '../../src/agent/work-modes.js';
import { HookRunner, createHookRunner, type HookContext } from '../../src/agent/hooks.js';
import {
  parseTimelineEntries,
  renderTraceTimelineText,
} from '../../src/cli/components/TracePanel.js';
import type { ToolResult } from '../../src/tools/types.js';
import type { TraceSpan } from '../../src/harness/trace-types.js';

describe('Phase-27 Task 8: Compose + HookRunner Trace 可视化', () => {
  // ============================================================
  // Compose 阶段时间线
  // ============================================================
  describe('Compose 阶段 Trace span', () => {
    let controller: WorkModeController;
    let pipeline: ComposePipeline;
    let trace: TraceCollector;

    beforeEach(() => {
      controller = new WorkModeController();
      controller.setMode('compose');
      pipeline = createComposePipeline(controller);
      trace = new TraceCollector({ enabled: true, maxSpansPerSession: 500 });
      trace.startSession('test-compose');
      pipeline.setTraceCollector(trace);
    });

    it('设置 TraceCollector 后立即记录当前阶段 span', () => {
      const spans = trace.getSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].type).toBe('compose_phase');
      const payload = spans[0].payload as { type: string; phase: string; name: string };
      expect(payload.phase).toBe('requirements');
      expect(payload.name).toBe('compose:requirements');
    });

    it('advance 推进阶段时结束旧 span 并开始新 span', () => {
      // 初始有 1 个 span（requirements）
      expect(trace.getSpans().length).toBe(1);
      const initialSpan = trace.getSpans()[0];
      expect(initialSpan.status).toBe('running');

      // 推进到 coding
      pipeline.advance();

      const spans = trace.getSpans();
      expect(spans.length).toBe(2);
      // 旧 span 应已结束
      expect(spans[0].status).toBe('completed');
      expect(spans[0].endTime).toBeDefined();
      expect(spans[0].durationMs).toBeDefined();
      // 新 span 应处于 running 状态
      expect(spans[1].status).toBe('running');
      const newPayload = spans[1].payload as { type: string; phase: string };
      expect(newPayload.phase).toBe('coding');
    });

    it('evaluateAdvance 自动推进时记录新阶段 span', () => {
      const makeResult = (output: string): ToolResult => ({ success: true, output, durationMs: 10 });

      // 初始 requirements span
      expect(trace.getSpans().length).toBe(1);

      // 触发自动推进
      const advanced = pipeline.evaluateAdvance(makeResult('需求分析完成'));
      expect(advanced).toBe(true);

      const spans = trace.getSpans();
      expect(spans.length).toBe(2);
      expect(spans[0].status).toBe('completed');
      const newPayload = spans[1].payload as { type: string; phase: string };
      expect(newPayload.phase).toBe('coding');
    });

    it('连续推进产生连续的阶段 span 序列', () => {
      pipeline.advance(); // coding
      pipeline.advance(); // testing
      pipeline.advance(); // review

      const spans = trace.getSpans();
      // 4 个 span：requirements → coding → testing → review
      expect(spans.length).toBe(4);
      const phases = spans.map(s => (s.payload as { phase: string }).phase);
      expect(phases).toEqual(['requirements', 'coding', 'testing', 'review']);

      // 前 3 个应已结束，最后一个 running
      expect(spans[0].status).toBe('completed');
      expect(spans[1].status).toBe('completed');
      expect(spans[2].status).toBe('completed');
      expect(spans[3].status).toBe('running');
    });

    it('未设置 TraceCollector 时不影响管线功能', () => {
      const controller2 = new WorkModeController();
      controller2.setMode('compose');
      const pipeline2 = createComposePipeline(controller2);
      // 不调用 setTraceCollector
      const phase = pipeline2.advance();
      expect(phase).toBe('coding');
    });
  });

  // ============================================================
  // HookRunner 钩子时间线
  // ============================================================
  describe('HookRunner 钩子 Trace span', () => {
    let runner: HookRunner;
    let trace: TraceCollector;

    beforeEach(() => {
      runner = createHookRunner();
      trace = new TraceCollector({ enabled: true, maxSpansPerSession: 500 });
      trace.startSession('test-hooks');
      runner.setTraceCollector(trace);
    });

    function makeContext(overrides?: Partial<HookContext>): HookContext {
      return {
        stepId: 'step-1',
        agentId: 'agent-1',
        projectPath: '/test',
        ...overrides,
      };
    }

    it('每个钩子执行产生对应的 hook span', async () => {
      runner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'continue' }),
        name: 'hookA',
      });
      runner.register({
        event: 'pre-step',
        handler: async () => ({ action: 'continue' }),
        name: 'hookB',
      });

      await runner.fire('pre-step', makeContext());

      const spans = trace.getSpans();
      expect(spans.length).toBe(2);
      expect(spans[0].type).toBe('hook');
      expect(spans[1].type).toBe('hook');

      const payload0 = spans[0].payload as { event: string; hookName: string };
      const payload1 = spans[1].payload as { event: string; hookName: string };
      expect(payload0.event).toBe('pre-step');
      expect(payload0.hookName).toBe('hookA');
      expect(payload1.event).toBe('pre-step');
      expect(payload1.hookName).toBe('hookB');
    });

    it('钩子 span 在执行完成后结束', async () => {
      runner.register({
        event: 'post-step',
        handler: async () => ({ action: 'continue' }),
        name: 'myHook',
      });

      await runner.fire('post-step', makeContext());

      const spans = trace.getSpans();
      expect(spans.length).toBe(1);
      expect(spans[0].status).toBe('completed');
      expect(spans[0].endTime).toBeDefined();
      expect(spans[0].durationMs).toBeDefined();
    });

    it('钩子崩溃时 span 仍然正确结束', async () => {
      runner.register({
        event: 'on-error',
        handler: async () => { throw new Error('boom'); },
        name: 'crashHook',
      });
      runner.register({
        event: 'on-error',
        handler: async () => ({ action: 'continue' }),
        name: 'okHook',
      });

      await runner.fire('on-error', makeContext({ error: { message: 'test' } }));

      const spans = trace.getSpans();
      expect(spans.length).toBe(2);
      // 两个 span 都应已结束（崩溃的也结束）
      expect(spans[0].status).toBe('completed');
      expect(spans[1].status).toBe('completed');
    });

    it('未设置 TraceCollector 时钩子正常执行', async () => {
      const runner2 = createHookRunner();
      runner2.register({
        event: 'pre-step',
        handler: async () => ({ action: 'continue', message: 'ok' }),
        name: 'h1',
      });

      const result = await runner2.fire('pre-step', makeContext());
      expect(result.action).toBe('continue');
      expect(result.message).toBe('ok');
    });
  });

  // ============================================================
  // TracePanel 显示
  // ============================================================
  describe('TracePanel 显示 Compose 和 Hook', () => {
    function makeComposeSpan(phase: string, durationMs: number, startTime: number): TraceSpan {
      return {
        id: Math.random(),
        sessionId: 'test',
        type: 'compose_phase',
        startTime,
        endTime: startTime + durationMs,
        durationMs,
        status: 'completed',
        payload: {
          type: 'compose_phase',
          name: `compose:${phase}`,
          phase,
        },
      } as TraceSpan;
    }

    function makeHookSpan(
      event: string,
      hookName: string,
      durationMs: number,
      startTime: number,
    ): TraceSpan {
      return {
        id: Math.random(),
        sessionId: 'test',
        type: 'hook',
        startTime,
        endTime: startTime + durationMs,
        durationMs,
        status: 'completed',
        payload: {
          type: 'hook',
          name: `hook:${event}:${hookName}`,
          event,
          hookName,
        },
      } as TraceSpan;
    }

    it('compose_phase span 转换为 compose 类别条目', () => {
      const spans = [makeComposeSpan('requirements', 500, 1000)];
      const entries = parseTimelineEntries(spans);
      expect(entries).toHaveLength(1);
      expect(entries[0].category).toBe('compose');
      expect(entries[0].label).toContain('Compose Phase');
      expect(entries[0].label).toContain('requirements');
      expect(entries[0].metadata.phase).toBe('requirements');
    });

    it('hook span 转换为 hook 类别条目', () => {
      const spans = [makeHookSpan('pre-step', 'myHook', 200, 1000)];
      const entries = parseTimelineEntries(spans);
      expect(entries).toHaveLength(1);
      expect(entries[0].category).toBe('hook');
      expect(entries[0].label).toContain('Hook');
      expect(entries[0].label).toContain('pre-step');
      expect(entries[0].label).toContain('myHook');
      expect(entries[0].metadata.hookEvent).toBe('pre-step');
      expect(entries[0].metadata.hookName).toBe('myHook');
    });

    it('L3 文本渲染显示 Compose 阶段和钩子元数据', () => {
      const spans = [
        makeComposeSpan('coding', 1000, 1000),
        makeHookSpan('post-step', 'verifyHook', 300, 2000),
      ];
      const entries = parseTimelineEntries(spans);
      const text = renderTraceTimelineText(entries, 'sess-1', 3);

      // 应包含 Compose 阶段信息
      expect(text).toContain('Compose Phase');
      expect(text).toContain('coding');
      expect(text).toContain('phase=coding');

      // 应包含 Hook 信息
      expect(text).toContain('Hook');
      expect(text).toContain('post-step');
      expect(text).toContain('verifyHook');
      expect(text).toContain('event=post-step');
      expect(text).toContain('hook=verifyHook');
    });

    it('L2 文本渲染不显示 phase/hook 元数据', () => {
      const spans = [makeComposeSpan('coding', 1000, 1000)];
      const entries = parseTimelineEntries(spans);
      const text = renderTraceTimelineText(entries, 'sess-1', 2);

      // L2 显示标签但不显示元数据
      expect(text).toContain('Compose Phase');
      expect(text).not.toContain('phase=coding');
    });

    it('混合 span 类型正确排序显示', () => {
      const spans = [
        makeHookSpan('pre-step', 'h1', 100, 3000),
        makeComposeSpan('requirements', 500, 1000),
        makeHookSpan('post-step', 'h2', 200, 2000),
      ];
      const entries = parseTimelineEntries(spans);
      // 按 startTime 排序：1000, 2000, 3000
      expect(entries[0].category).toBe('compose');
      expect(entries[1].category).toBe('hook');
      expect(entries[1].metadata.hookName).toBe('h2');
      expect(entries[2].category).toBe('hook');
      expect(entries[2].metadata.hookName).toBe('h1');
    });
  });

  // ============================================================
  // TraceCollector 公共 startSpan/endSpan API
  // ============================================================
  describe('TraceCollector 公共 span API', () => {
    it('startSpan 返回有效 span ID', () => {
      const tc = new TraceCollector();
      tc.startSession('test');
      const id = tc.startSpan({ name: 'compose:requirements', type: 'compose-phase' });
      expect(id).toBeGreaterThan(0);
    });

    it('endSpan(spanId) 结束指定 span', () => {
      const tc = new TraceCollector();
      tc.startSession('test');
      const id = tc.startSpan({ name: 'hook:pre-step:h1', type: 'hook' });
      tc.endSpan(id);
      const spans = tc.getSpans();
      expect(spans[0].status).toBe('completed');
      expect(spans[0].endTime).toBeDefined();
    });

    it('endSpan() 无参数时结束最近的 running span', () => {
      const tc = new TraceCollector();
      tc.startSession('test');
      tc.startSpan({ name: 'compose:coding', type: 'compose-phase' });
      tc.endSpan();
      const spans = tc.getSpans();
      expect(spans[0].status).toBe('completed');
    });

    it('未启动 session 时 startSpan 返回 -1', () => {
      const tc = new TraceCollector();
      const id = tc.startSpan({ name: 'compose:requirements', type: 'compose-phase' });
      expect(id).toBe(-1);
    });
  });
});
