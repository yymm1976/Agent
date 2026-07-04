// src/observability/integration.ts
// OTel 与 trajectory 集成：把 Agent 执行的关键节点映射为 OTel span
//
// 设计：
//   - TrajectoryOtelBridge：配对 start/end 事件，转换为 OTel span 后转发到 OtelExporter
//   - 模块级 registry：app-init.ts 创建 OtelExporter 后调用 setActiveOtelExporter 注册，
//     /trace otel 命令通过 getActiveOtelExporter 读取状态
//
// 支持的事件类型（由调用方在 trajectory 记录点之后调用 bridge.recordEvent）：
//   - agent.loop.start / agent.loop.end       → Agent 循环 span
//   - tool.execute.start / tool.execute.end   → 工具执行 span
//   - model.call.start / model.call.end       → 模型调用 span
//
// 从 trajectory 事件 attributes 中提取的关键字段：
//   - model.call：model 名、inputTokens、outputTokens、totalTokens
//   - tool.execute：toolName、isError
//   - 通用：durationMs（end 事件可携带，否则用 endTime - startTime 计算）

import type { OtelExporter, OtelSpan } from './otel-exporter.js';
import { logger } from '../utils/logger.js';

/** trajectory 事件（由调用方从 TraceCollector/AuditLogger 等记录点转换而来） */
export interface TrajectoryEvent {
  /** 事件类型，如 'agent.loop.start' / 'tool.execute.end' */
  type: string;
  /** 事件时间戳（ms） */
  timestamp: number;
  /** 事件属性（模型名、token 数、工具名等） */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Trajectory → OTel 桥接器
 *
 * 配对 start/end 事件，组装为 OTel span 后调用 exporter.recordSpan
 *
 * 用法：
 *   const bridge = new TrajectoryOtelBridge(exporter);
 *   bridge.recordEvent({ type: 'agent.loop.start', timestamp: start, attributes: { goal: '...' } });
 *   bridge.recordEvent({ type: 'agent.loop.end', timestamp: end, attributes: { status: 'ok' } });
 *   // → exporter.recordSpan({ name: 'agent.loop', startTime: start, endTime: end, ... })
 */
export class TrajectoryOtelBridge {
  /** 待配对的 open spans：key 为 baseName（去掉 .start/.end 后缀） */
  private openSpans = new Map<
    string,
    { name: string; startTime: number; attributes: Record<string, string | number | boolean> }
  >();

  constructor(private readonly exporter: OtelExporter) {}

  /** 处理一个 trajectory 事件，若是 start 则记录，若是 end 则配对发出 span */
  recordEvent(event: TrajectoryEvent): void {
    if (!this.exporter) return;

    if (event.type.endsWith('.start')) {
      const baseName = event.type.slice(0, -'.start'.length);
      const spanName = this.mapSpanName(baseName);
      this.openSpans.set(baseName, {
        name: spanName,
        startTime: event.timestamp,
        attributes: { ...(event.attributes ?? {}) },
      });
      return;
    }

    if (event.type.endsWith('.end')) {
      const baseName = event.type.slice(0, -'.end'.length);
      const open = this.openSpans.get(baseName);
      if (!open) {
        // 没有 matching start，跳过（不报错——可能是中途接入的事件）
        logger.debug('TrajectoryOtelBridge: end event without matching start', {
          type: event.type,
        });
        return;
      }
      this.openSpans.delete(baseName);

      // 合并 start/end 的 attributes（end 覆盖 start 同名字段）
      const endAttrs = event.attributes ?? {};
      const mergedAttrs: Record<string, string | number | boolean> = {
        ...open.attributes,
        ...endAttrs,
      };

      // 状态映射：end 事件可携带 status='error' 或 isError=true
      const statusAttr = mergedAttrs.status;
      const isErrorAttr = mergedAttrs.isError;
      const isError = statusAttr === 'error' || isErrorAttr === true;
      // status 字段不属于 OTel span attributes，删除后单独传
      delete mergedAttrs.status;

      const span: OtelSpan = {
        name: open.name,
        startTime: open.startTime,
        endTime: event.timestamp,
        attributes: mergedAttrs,
        status: isError ? 'error' : 'ok',
      };

      this.exporter.recordSpan(span);
      return;
    }

    // 非 start/end 事件：忽略（不在映射范围内的 trajectory 事件不转发）
  }

  /** 手动 flush exporter */
  async flush(): Promise<void> {
    await this.exporter.flush();
  }

  /** 读取底层 exporter（供 /trace otel 复用） */
  getExporter(): OtelExporter {
    return this.exporter;
  }

  /** baseName → OTel span name 映射（当前 1:1，预留扩展点） */
  private mapSpanName(baseName: string): string {
    switch (baseName) {
      case 'agent.loop':
      case 'tool.execute':
      case 'model.call':
        return baseName;
      default:
        // 未识别的 baseName 仍按原名发出，便于扩展
        return baseName;
    }
  }
}

// ===== 模块级 registry =====
//
// app-init.ts 创建 OtelExporter 后调用 setActiveOtelExporter 注册；
// /trace otel 命令通过 getActiveOtelExporter 读取状态；
// /trace otel flush 调用 getActiveOtelBridge().flush()。
//
// 用模块级单例而非 ServiceContext 字段，避免修改 ServiceContext 类型签名
// （ServiceContext 不在本任务的允许修改范围内）。

let activeExporter: OtelExporter | null = null;
let activeBridge: TrajectoryOtelBridge | null = null;

/** 注册当前进程的 active OtelExporter（同时构造 bridge） */
export function setActiveOtelExporter(exporter: OtelExporter | null): void {
  // 切换前先关闭旧 exporter（flush 剩余 span）
  if (activeExporter) {
    activeExporter.shutdown().catch(err => {
      logger.warn('integration: failed to shutdown previous OtelExporter', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  activeExporter = exporter;
  activeBridge = exporter ? new TrajectoryOtelBridge(exporter) : null;
}

/** 读取 active OtelExporter（/trace otel 用） */
export function getActiveOtelExporter(): OtelExporter | null {
  return activeExporter;
}

/** 读取 active TrajectoryOtelBridge（供 app-init.ts 在 trajectory 记录点调用） */
export function getActiveOtelBridge(): TrajectoryOtelBridge | null {
  return activeBridge;
}
