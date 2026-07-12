// src/observability/otel-exporter.ts
// OpenTelemetry exporter：把 Agent 执行 span 批量导出到 OTLP HTTP/JSON endpoint
//
// 设计目标：
//   - 不引入 @opentelemetry/* npm 包（避免依赖膨胀），手写 OTLP JSON
//   - fail-open：导出失败只 log 不抛异常，绝不影响 Agent 主流程
//   - span 累积到内存缓冲区，定时或手动 flush
//
// OTLP HTTP/JSON 协议参考：
//   https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding

import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

/**
 * OTel exporter 配置
 */
export interface OtelConfig {
  /** OTLP endpoint，默认 http://localhost:4318/v1/traces */
  endpoint?: string;
  /** 服务名，默认 'routedev' */
  serviceName: string;
  /** 是否启用 */
  enabled: boolean;
  /** 自定义 headers（如认证 token） */
  headers?: Record<string, string>;
  /** 批量导出间隔（毫秒），默认 5000 */
  exportIntervalMs?: number;
}

/** 单个 span 的可记录形态 */
export interface OtelSpan {
  name: string;
  startTime: number;
  endTime: number;
  attributes?: Record<string, string | number | boolean>;
  status?: 'ok' | 'error';
  events?: Array<{
    name: string;
    timestamp: number;
    attributes?: Record<string, unknown>;
  }>;
}

/** OTel exporter 运行时状态（供 /trace otel 读取） */
export interface OtelExporterStatus {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  /** 缓冲区中尚未导出的 span 数 */
  bufferedSpans: number;
  /** 累计已成功导出的 span 数 */
  totalExportedSpans: number;
  /** 累计成功导出次数（flush 调用次数中成功的） */
  totalExportCount: number;
  /** 累计失败次数 */
  totalErrorCount: number;
  /** 最后一次成功导出时间（ms 时间戳），null 表示从未成功导出 */
  lastFlushAt: number | null;
  /** 最后一次错误信息，null 表示无错误 */
  lastError: string | null;
}

const DEFAULT_ENDPOINT = 'http://localhost:4318/v1/traces';
const DEFAULT_SERVICE_NAME = 'routedev';
const DEFAULT_EXPORT_INTERVAL_MS = 5000;

/**
 * V3-027 修复：span 缓冲区大小上限
 * 防止 OTLP endpoint 不可达时 span 无限累积导致内存泄漏
 * 达到上限时丢弃最早的 span（FIFO）
 */
const MAX_SPAN_BUFFER_SIZE = 1000;

/**
 * V3-030 修复：fetch 请求超时时间（毫秒）
 * 防止 flush() 因网络问题长时间挂起，阻塞定时器或 shutdown
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * OpenTelemetry exporter
 *
 * 用法：
 *   const exporter = new OtelExporter({ enabled: true, serviceName: 'routedev' });
 *   exporter.recordSpan({ name: 'agent.loop', startTime: Date.now(), endTime: Date.now() });
 *   await exporter.flush();
 *   await exporter.shutdown();
 */
export class OtelExporter {
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly enabled: boolean;
  private readonly headers: Record<string, string>;
  private readonly exportIntervalMs: number;

  private buffer: OtelSpan[] = [];
  private timer: NodeJS.Timeout | null = null;
  private shutdownCalled = false;

  private totalExportedSpans = 0;
  private totalExportCount = 0;
  private totalErrorCount = 0;
  private lastFlushAt: number | null = null;
  private lastError: string | null = null;

  constructor(config: OtelConfig) {
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.serviceName = config.serviceName || DEFAULT_SERVICE_NAME;
    this.enabled = config.enabled;
    this.headers = config.headers ?? {};
    this.exportIntervalMs = config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS;

    if (this.enabled) {
      this.startTimer();
    }
  }

  /** 记录一次 span，累积到内存缓冲区 */
  recordSpan(span: OtelSpan): void {
    if (!this.enabled || this.shutdownCalled) return;
    // V3-027 修复：缓冲区达到上限时丢弃最早的 span（FIFO），防止内存泄漏
    if (this.buffer.length >= MAX_SPAN_BUFFER_SIZE) {
      this.buffer.shift();
      logger.warn('OTel span buffer overflow, dropping oldest span', {
        bufferSize: this.buffer.length,
        maxSize: MAX_SPAN_BUFFER_SIZE,
      });
    }
    this.buffer.push(span);
  }

  /** 批量导出到 OTLP endpoint（fail-open：失败只 log 不抛异常） */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const spans = this.buffer.splice(0);
    const payload = this.buildOtlpPayload(spans);

    // V3-030 修复：为 fetch 添加超时控制，防止网络问题导致 flush 长时间挂起
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`OTLP endpoint returned ${res.status}: ${bodyText.slice(0, 200)}`);
      }
      this.totalExportedSpans += spans.length;
      this.totalExportCount++;
      this.lastFlushAt = Date.now();
      this.lastError = null;
      logger.debug('OtelExporter: flush succeeded', {
        spanCount: spans.length,
        totalExported: this.totalExportedSpans,
      });
    } catch (err) {
      this.totalErrorCount++;
      // V3-030：区分超时和其他错误
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      this.lastError = isTimeout
        ? `OTLP flush timeout after ${FETCH_TIMEOUT_MS}ms`
        : (err instanceof Error ? err.message : String(err));
      // fail-open：只 log 不抛
      logger.warn('OtelExporter: flush failed (fail-open, spans discarded)', {
        error: this.lastError,
        spanCount: spans.length,
        endpoint: this.endpoint,
        isTimeout,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 关闭：停止定时器并 flush 剩余 span */
  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
    this.stopTimer();
    await this.flush();
  }

  /** 读取 exporter 运行时状态（供 /trace otel 显示） */
  getStatus(): OtelExporterStatus {
    return {
      enabled: this.enabled,
      endpoint: this.endpoint,
      serviceName: this.serviceName,
      bufferedSpans: this.buffer.length,
      totalExportedSpans: this.totalExportedSpans,
      totalExportCount: this.totalExportCount,
      totalErrorCount: this.totalErrorCount,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
    };
  }

  // ===== 内部方法 =====

  private startTimer(): void {
    if (this.exportIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      // 异步 flush，错误在 flush 内部已处理
      this.flush().catch(() => {
        // 二次兜底（理论上 flush 内部已 catch）
      });
    }, this.exportIntervalMs);
    // unref：定时器不阻止进程退出
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 构造 OTLP HTTP/JSON payload */
  private buildOtlpPayload(spans: OtelSpan[]): unknown {
    return {
      resourceSpans: [{
        resource: {
          attributes: [{
            key: 'service.name',
            value: { stringValue: this.serviceName },
          }],
        },
        scopeSpans: [{
          scope: { name: 'routedev-agent' },
          spans: spans.map(s => this.convertSpan(s)),
        }],
      }],
    };
  }

  /** 单个 span 转换为 OTLP JSON 格式 */
  private convertSpan(span: OtelSpan): Record<string, unknown> {
    const traceId = crypto.randomBytes(16).toString('hex');
    const spanId = crypto.randomBytes(8).toString('hex');

    const result: Record<string, unknown> = {
      traceId,
      spanId,
      name: span.name,
      kind: 0, // SPAN_KIND_INTERNAL
      startTimeUnixNano: msToNanoString(span.startTime),
      endTimeUnixNano: msToNanoString(span.endTime),
      attributes: convertAttributes(span.attributes),
    };

    if (span.status === 'error') {
      result.status = { code: 2 }; // STATUS_CODE_ERROR
    } else {
      result.status = { code: 1 }; // STATUS_CODE_OK
    }

    if (span.events && span.events.length > 0) {
      result.events = span.events.map(e => ({
        timeUnixNano: msToNanoString(e.timestamp),
        name: e.name,
        attributes: convertAttributes(
          e.attributes as Record<string, string | number | boolean> | undefined,
        ),
      }));
    }

    return result;
  }
}

/**
 * 毫秒时间戳 → 纳秒字符串（OTLP 要求字符串形式，避免 JS Number 精度丢失）
 */
function msToNanoString(ms: number): string {
  // 用 BigInt 避免大数精度丢失：ms * 1_000_000 = ns
  return String(BigInt(Math.floor(ms)) * 1_000_000n);
}

/**
 * 把 attributes 对象转换为 OTLP attributes 数组
 * OTLP attribute value 必须用类型包装：{ stringValue } / { intValue } / { doubleValue } / { boolValue }
 */
function convertAttributes(
  attrs?: Record<string, string | number | boolean>,
): Array<{ key: string; value: Record<string, unknown> }> {
  if (!attrs) return [];
  const result: Array<{ key: string; value: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'string') {
      result.push({ key, value: { stringValue: value } });
    } else if (typeof value === 'number') {
      // 整数用 intValue（OTLP 要求 intValue 为 string 形式），浮点用 doubleValue
      if (Number.isInteger(value)) {
        result.push({ key, value: { intValue: String(value) } });
      } else {
        result.push({ key, value: { doubleValue: value } });
      }
    } else if (typeof value === 'boolean') {
      result.push({ key, value: { boolValue: value } });
    }
  }
  return result;
}
