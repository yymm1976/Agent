// tests/observability/otel-exporter.test.ts
// OtelExporter 单元测试：验证缓冲、flush、OTLP JSON 格式、fail-open、状态读取

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OtelExporter, type OtelSpan } from '../../src/observability/otel-exporter.js';

/** 构造一个简单的测试 span */
function makeSpan(overrides: Partial<OtelSpan> = {}): OtelSpan {
  return {
    name: 'agent.loop',
    startTime: 1700000000000,
    endTime: 1700000001000,
    attributes: { goal: 'test-goal', iteration: 1, success: true },
    status: 'ok',
    ...overrides,
  };
}

describe('OtelExporter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('构造与默认值', () => {
    it('未提供 endpoint/serviceName/exportIntervalMs 时使用默认值', () => {
      const exporter = new OtelExporter({ enabled: false, serviceName: '' });
      const st = exporter.getStatus();
      expect(st.endpoint).toBe('http://localhost:4318/v1/traces');
      expect(st.serviceName).toBe('routedev');
      expect(st.enabled).toBe(false);
    });

    it('enabled=false 时不启动定时器，recordSpan 不入缓冲区', () => {
      const exporter = new OtelExporter({ enabled: false, serviceName: 'test' });
      exporter.recordSpan(makeSpan());
      expect(exporter.getStatus().bufferedSpans).toBe(0);
    });
  });

  describe('recordSpan + 缓冲区', () => {
    it('enabled=true 时 recordSpan 累积到缓冲区', () => {
      const exporter = new OtelExporter({ enabled: true, serviceName: 'test', exportIntervalMs: 60000 });
      try {
        exporter.recordSpan(makeSpan({ name: 'a' }));
        exporter.recordSpan(makeSpan({ name: 'b' }));
        expect(exporter.getStatus().bufferedSpans).toBe(2);
      } finally {
        exporter.shutdown();
      }
    });

    it('shutdown 后 recordSpan 不再入缓冲区', async () => {
      const exporter = new OtelExporter({ enabled: true, serviceName: 'test', exportIntervalMs: 60000 });
      await exporter.shutdown();
      exporter.recordSpan(makeSpan());
      expect(exporter.getStatus().bufferedSpans).toBe(0);
    });
  });

  describe('flush', () => {
    it('空缓冲区时 flush 不发送请求', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      const exporter = new OtelExporter({ enabled: true, serviceName: 'test', exportIntervalMs: 60000 });
      try {
        await exporter.flush();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await exporter.shutdown();
      }
    });

    it('flush 发送 OTLP JSON 到 endpoint 并清空缓冲区', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('{}', { status: 200 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'my-service',
        endpoint: 'http://collector:4318/v1/traces',
        exportIntervalMs: 60000,
      });
      try {
        exporter.recordSpan(makeSpan({ name: 'span-1' }));
        exporter.recordSpan(makeSpan({ name: 'span-2' }));
        await exporter.flush();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://collector:4318/v1/traces');
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');

        // 解析 body 验证 OTLP JSON 结构
        const body = JSON.parse(init?.body as string);
        expect(body.resourceSpans).toHaveLength(1);
        const rs = body.resourceSpans[0];
        expect(rs.resource.attributes[0]).toEqual({
          key: 'service.name',
          value: { stringValue: 'my-service' },
        });
        expect(rs.scopeSpans).toHaveLength(1);
        expect(rs.scopeSpans[0].scope.name).toBe('routedev-agent');
        expect(rs.scopeSpans[0].spans).toHaveLength(2);
        expect(rs.scopeSpans[0].spans[0].name).toBe('span-1');
        expect(rs.scopeSpans[0].spans[1].name).toBe('span-2');

        // 缓冲区已清空，状态已更新
        const st = exporter.getStatus();
        expect(st.bufferedSpans).toBe(0);
        expect(st.totalExportedSpans).toBe(2);
        expect(st.totalExportCount).toBe(1);
        expect(st.totalErrorCount).toBe(0);
        expect(st.lastFlushAt).not.toBeNull();
        expect(st.lastError).toBeNull();
      } finally {
        await exporter.shutdown();
      }
    });

    it('flush 发送自定义 headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        headers: { Authorization: 'Bearer token-xyz' },
        exportIntervalMs: 60000,
      });
      try {
        exporter.recordSpan(makeSpan());
        await exporter.flush();
        const init = fetchMock.mock.calls[0][1];
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer token-xyz');
        expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      } finally {
        await exporter.shutdown();
      }
    });

    it('endpoint 返回非 2xx 时 fail-open：不抛异常，记录错误', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('bad request', { status: 400 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        exportIntervalMs: 60000,
      });
      try {
        exporter.recordSpan(makeSpan());
        // fail-open：不抛异常
        await expect(exporter.flush()).resolves.toBeUndefined();
        const st = exporter.getStatus();
        expect(st.totalErrorCount).toBe(1);
        expect(st.totalExportedSpans).toBe(0);
        expect(st.lastError).toContain('400');
        expect(st.bufferedSpans).toBe(0); // 失败的 span 也从缓冲区移除（丢弃）
      } finally {
        await exporter.shutdown();
      }
    });

    it('fetch 抛异常时 fail-open：不抛异常，记录错误', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        exportIntervalMs: 60000,
      });
      try {
        exporter.recordSpan(makeSpan());
        await expect(exporter.flush()).resolves.toBeUndefined();
        const st = exporter.getStatus();
        expect(st.totalErrorCount).toBe(1);
        expect(st.lastError).toBe('ECONNREFUSED');
      } finally {
        await exporter.shutdown();
      }
    });
  });

  describe('OTLP JSON 格式', () => {
    it('span 时间戳转换为纳秒字符串', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        exportIntervalMs: 60000,
      });
      try {
        exporter.recordSpan({
          name: 'test',
          startTime: 1700000000000,
          endTime: 1700000000123,
        });
        await exporter.flush();
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        // 1700000000000 ms = 1700000000000000000 ns
        expect(span.startTimeUnixNano).toBe('1700000000000000000');
        expect(span.endTimeUnixNano).toBe('1700000000123000000');
      } finally {
        await exporter.shutdown();
      }
    });

    it('attributes 按类型包装为 stringValue/intValue/doubleValue/boolValue', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        exportIntervalMs: 60000,
      });
      try {
        exporter.recordSpan({
          name: 'test',
          startTime: 1700000000000,
          endTime: 1700000000001,
          attributes: {
            strVal: 'hello',
            intVal: 42,
            doubleVal: 3.14,
            boolVal: true,
          },
        });
        await exporter.flush();
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const attrs: Array<{ key: string; value: Record<string, unknown> }> =
          body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
        const attrMap = Object.fromEntries(attrs.map(a => [a.key, a.value]));
        expect(attrMap.strVal).toEqual({ stringValue: 'hello' });
        expect(attrMap.intVal).toEqual({ intValue: '42' });
        expect(attrMap.doubleVal).toEqual({ doubleValue: 3.14 });
        expect(attrMap.boolVal).toEqual({ boolValue: true });
      } finally {
        await exporter.shutdown();
      }
    });

    it('status=error 时 status.code=2，否则 status.code=1', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        exportIntervalMs: 60000,
      });
      try {
        exporter.recordSpan({
          name: 'ok-span',
          startTime: 1700000000000,
          endTime: 1700000000001,
          status: 'ok',
        });
        exporter.recordSpan({
          name: 'err-span',
          startTime: 1700000000000,
          endTime: 1700000000001,
          status: 'error',
        });
        await exporter.flush();
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const spans = body.resourceSpans[0].scopeSpans[0].spans;
        expect(spans[0].status.code).toBe(1);
        expect(spans[1].status.code).toBe(2);
      } finally {
        await exporter.shutdown();
      }
    });

    it('events 转换为 OTLP events 数组', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        exportIntervalMs: 60000,
      });
      try {
        exporter.recordSpan({
          name: 'test',
          startTime: 1700000000000,
          endTime: 1700000000001,
          events: [
            {
              name: 'checkpoint',
              timestamp: 1700000000005,
              attributes: { reason: 'timeout' },
            },
          ],
        });
        await exporter.flush();
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.events).toHaveLength(1);
        expect(span.events[0].name).toBe('checkpoint');
        expect(span.events[0].timeUnixNano).toBe('1700000000005000000');
        expect(span.events[0].attributes[0]).toEqual({
          key: 'reason',
          value: { stringValue: 'timeout' },
        });
      } finally {
        await exporter.shutdown();
      }
    });

    it('traceId/spanId 为合法的 hex 字符串', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        exportIntervalMs: 60000,
      });
      try {
        exporter.recordSpan(makeSpan());
        await exporter.flush();
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        // traceId: 32 hex chars (16 bytes), spanId: 16 hex chars (8 bytes)
        expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      } finally {
        await exporter.shutdown();
      }
    });
  });

  describe('shutdown', () => {
    it('shutdown 停止定时器并 flush 剩余 span', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        exportIntervalMs: 60000,
      });
      exporter.recordSpan(makeSpan());
      await exporter.shutdown();

      // shutdown 触发了 flush
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const st = exporter.getStatus();
      expect(st.totalExportedSpans).toBe(1);
      expect(st.bufferedSpans).toBe(0);
    });

    it('shutdown 后再 shutdown 不重复 flush', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const exporter = new OtelExporter({
        enabled: true,
        serviceName: 'test',
        exportIntervalMs: 60000,
      });
      exporter.recordSpan(makeSpan());
      await exporter.shutdown();
      await exporter.shutdown(); // 第二次：缓冲区已空，不应再调用 fetch
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
