// src/observability/index.ts
// 可观测性模块统一导出
//
// 仅导出 OTel 新模块——trajectory-aggregator / trajectory-exporter 已有调用方直接 import，
// 此处不重新导出避免引入潜在的循环依赖。

export { OtelExporter, type OtelConfig, type OtelSpan, type OtelExporterStatus } from './otel-exporter.js';
export {
  TrajectoryOtelBridge,
  type TrajectoryEvent,
  setActiveOtelExporter,
  getActiveOtelExporter,
  getActiveOtelBridge,
} from './integration.js';
