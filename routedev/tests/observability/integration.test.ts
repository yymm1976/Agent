// tests/observability/integration.test.ts
// TrajectoryOtelBridge + 模块级 registry 测试
// 验证：start/end 事件配对、attributes 合并、status 映射、registry 单例

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TrajectoryOtelBridge,
  setActiveOtelExporter,
  getActiveOtelExporter,
  getActiveOtelBridge,
  type TrajectoryEvent,
} from '../../src/observability/integration.js';
import { OtelExporter, type OtelSpan } from '../../src/observability/otel-exporter.js';

describe('TrajectoryOtelBridge', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // 每个 case 前清空 registry，避免互相影响
    setActiveOtelExporter(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setActiveOtelExporter(null);
    vi.restoreAllMocks();
  });

  /** 创建带 mock fetch 的 exporter（用于验证 span 是否被记录） */
  function makeExporter(): { exporter: OtelExporter; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const exporter = new OtelExporter({
      enabled: true,
      serviceName: 'test',
      exportIntervalMs: 60000,
    });
    return { exporter, fetchMock };
  }

  describe('start/end 事件配对', () => {
    it('agent.loop.start + agent.loop.end 配对一个 span', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'agent.loop.start',
          timestamp: 1700000000000,
          attributes: { goal: '实现登录', iteration: 0 },
        });
        bridge.recordEvent({
          type: 'agent.loop.end',
          timestamp: 1700000005000,
          attributes: { status: 'ok', iteration: 3 },
        });
        await bridge.flush();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.name).toBe('agent.loop');
        expect(span.startTimeUnixNano).toBe('1700000000000000000');
        expect(span.endTimeUnixNano).toBe('1700000005000000000');
        expect(span.status.code).toBe(1); // ok
      } finally {
        await exporter.shutdown();
      }
    });

    it('tool.execute.start + tool.execute.end 配对为工具执行 span', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'tool.execute.start',
          timestamp: 1700000000000,
          attributes: { toolName: 'file_edit' },
        });
        bridge.recordEvent({
          type: 'tool.execute.end',
          timestamp: 1700000000100,
          attributes: { toolName: 'file_edit', isError: false },
        });
        await bridge.flush();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.name).toBe('tool.execute');
        // 合并后的 attributes 同时包含 start 和 end 的字段
        const attrMap = Object.fromEntries(
          span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
        );
        expect(attrMap.toolName).toEqual({ stringValue: 'file_edit' });
        expect(attrMap.isError).toEqual({ boolValue: false });
        expect(span.status.code).toBe(1);
      } finally {
        await exporter.shutdown();
      }
    });

    it('model.call.start + model.call.end 配对为模型调用 span，提取模型名/token 数', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'model.call.start',
          timestamp: 1700000000000,
          attributes: { model: 'deepseek-v4' },
        });
        bridge.recordEvent({
          type: 'model.call.end',
          timestamp: 1700000002000,
          attributes: {
            model: 'deepseek-v4',
            inputTokens: 500,
            outputTokens: 200,
            totalTokens: 700,
          },
        });
        await bridge.flush();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.name).toBe('model.call');
        const attrMap = Object.fromEntries(
          span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
        );
        expect(attrMap.model).toEqual({ stringValue: 'deepseek-v4' });
        expect(attrMap.inputTokens).toEqual({ intValue: '500' });
        expect(attrMap.outputTokens).toEqual({ intValue: '200' });
        expect(attrMap.totalTokens).toEqual({ intValue: '700' });
      } finally {
        await exporter.shutdown();
      }
    });
  });

  describe('status 映射', () => {
    it('end 事件 status=error 时 span.status.code=2', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'agent.loop.start',
          timestamp: 1700000000000,
        });
        bridge.recordEvent({
          type: 'agent.loop.end',
          timestamp: 1700000001000,
          attributes: { status: 'error' },
        });
        await bridge.flush();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.status.code).toBe(2); // error
        // status 字段不应出现在 attributes 中
        const attrMap = Object.fromEntries(
          span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
        );
        expect(attrMap.status).toBeUndefined();
      } finally {
        await exporter.shutdown();
      }
    });

    it('end 事件 isError=true 时 span.status.code=2', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'tool.execute.start',
          timestamp: 1700000000000,
          attributes: { toolName: 'shell_exec' },
        });
        bridge.recordEvent({
          type: 'tool.execute.end',
          timestamp: 1700000000100,
          attributes: { toolName: 'shell_exec', isError: true },
        });
        await bridge.flush();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.status.code).toBe(2);
      } finally {
        await exporter.shutdown();
      }
    });

    it('end 事件无错误字段时 span.status.code=1', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'agent.loop.start',
          timestamp: 1700000000000,
        });
        bridge.recordEvent({
          type: 'agent.loop.end',
          timestamp: 1700000001000,
        });
        await bridge.flush();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.status.code).toBe(1);
      } finally {
        await exporter.shutdown();
      }
    });
  });

  describe('attributes 合并', () => {
    it('end 事件的同名字段覆盖 start 事件', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'agent.loop.start',
          timestamp: 1700000000000,
          attributes: { iteration: 0, goal: 'test' },
        });
        bridge.recordEvent({
          type: 'agent.loop.end',
          timestamp: 1700000001000,
          attributes: { iteration: 5 }, // 覆盖 start 的 iteration
        });
        await bridge.flush();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        const attrMap = Object.fromEntries(
          span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
        );
        expect(attrMap.iteration).toEqual({ intValue: '5' });
        expect(attrMap.goal).toEqual({ stringValue: 'test' });
      } finally {
        await exporter.shutdown();
      }
    });
  });

  describe('异常场景', () => {
    it('end 事件无 matching start 时静默跳过', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'tool.execute.end',
          timestamp: 1700000000000,
        });
        await bridge.flush();
        // 没有 span 被记录，flush 不调用 fetch
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await exporter.shutdown();
      }
    });

    it('非 start/end 事件被忽略', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'some.other.event',
          timestamp: 1700000000000,
        } as TrajectoryEvent);
        await bridge.flush();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await exporter.shutdown();
      }
    });

    it('同一 baseName 多次 start：后者覆盖前者', async () => {
      const { exporter, fetchMock } = makeExporter();
      const bridge = new TrajectoryOtelBridge(exporter);
      try {
        bridge.recordEvent({
          type: 'agent.loop.start',
          timestamp: 1700000000000,
          attributes: { goal: 'first' },
        });
        bridge.recordEvent({
          type: 'agent.loop.start',
          timestamp: 1700000001000,
          attributes: { goal: 'second' },
        });
        bridge.recordEvent({
          type: 'agent.loop.end',
          timestamp: 1700000002000,
        });
        await bridge.flush();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        // 使用第二次 start 的 startTime 和 attributes
        expect(span.startTimeUnixNano).toBe('1700000001000000000');
        const attrMap = Object.fromEntries(
          span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
        );
        expect(attrMap.goal).toEqual({ stringValue: 'second' });
      } finally {
        await exporter.shutdown();
      }
    });
  });

  describe('模块级 registry', () => {
    it('setActiveOtelExporter(null) 后 getActive* 返回 null', () => {
      setActiveOtelExporter(null);
      expect(getActiveOtelExporter()).toBeNull();
      expect(getActiveOtelBridge()).toBeNull();
    });

    it('setActiveOtelExporter(exporter) 后可通过 getter 取回', () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'registry-test',
        exportIntervalMs: 60000,
      });
      try {
        setActiveOtelExporter(exporter);
        expect(getActiveOtelExporter()).toBe(exporter);
        expect(getActiveOtelBridge()).not.toBeNull();
        expect(getActiveOtelBridge()?.getExporter()).toBe(exporter);
      } finally {
        setActiveOtelExporter(null);
        // setActiveOtelExporter(null) 会 shutdown 旧 exporter
      }
    });

    it('registry 切换时旧 exporter 被 shutdown', async () => {
      // 用单个 fetch mock（shutdown 是异步触发的，若中途换 mock 会指向新 mock）
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter1 = new OtelExporter({
        enabled: true,
        serviceName: 'first',
        exportIntervalMs: 60000,
      });
      exporter1.recordSpan({
        name: 'pending',
        startTime: 1700000000000,
        endTime: 1700000000001,
      });
      setActiveOtelExporter(exporter1);

      // 切换到新 exporter，触发旧 exporter 的 shutdown（异步 flush pending span）
      const exporter2 = new OtelExporter({
        enabled: true,
        serviceName: 'second',
        exportIntervalMs: 60000,
      });
      try {
        setActiveOtelExporter(exporter2);
        // 等待 shutdown 异步完成
        await new Promise(resolve => setTimeout(resolve, 100));

        // 旧 exporter 的 pending span 已被 flush（fetch 被调用，body 中 serviceName='first'）
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.resourceSpans[0].resource.attributes[0]).toEqual({
          key: 'service.name',
          value: { stringValue: 'first' },
        });
        expect(getActiveOtelExporter()).toBe(exporter2);
      } finally {
        setActiveOtelExporter(null);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
  });
});
