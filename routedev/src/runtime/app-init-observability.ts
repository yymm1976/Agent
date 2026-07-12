// src/runtime/app-init-observability.ts
// 可观测性子系统装配：TraceCollector、AuditLogger、OTel 导出、Analytics、Doctor
// 从 app-init.ts 拆分（TD-02），保持功能完全等价
//
// 职责：
//   1. 创建 TraceCollector / AuditLogger（基础设施，其他子系统依赖 trace.getSessionId()）
//   2. 创建 PromptTemplateManager / Blackboard
//   3. OTel exporter 动态 import（fail-open）
//   4. AuditChain 哈希链审计（fail-open）
//   5. G-F027：ProjectMemoryManager / loadProjectDoc 已移除（无消费方，待后续重新接入）
//   6. Phase 53 Doctor 启动健康检查（fail-open）
//   7. P0-11 Analytics 队列挂载 sink
//
// 注意：profiler 和 BudgetMonitor 因依赖 agentLoop（由 tools 子系统创建），
// 暂置于 tools 子系统中。后续可通过调整调用顺序迁移到本模块。

import { TraceCollector } from '../harness/trace-collector.js';
import { AuditLogger } from '../harness/audit-logger.js';
import { PromptTemplateManager } from '../prompts/manager.js';
import { Blackboard } from '../agent/multi/blackboard.js';
import { registerOffloadCleaner } from '../agent/context/offload-cleaner.js';
import { registerShutdownHook } from './graceful-shutdown.js';
import {
  attachAnalyticsSink,
  logEvent,
  forceFlushNow,
  type AnalyticsSink,
  type AnalyticsEvent,
} from '../observability/analytics-queue.js';
import { logger } from '../utils/logger.js';
import * as path from 'node:path';
// Phase 80 Task 2：本地使用计数器
import { UsageCounter } from '../observability/usage-counter.js';
import type { InitContext, AppDependencies } from './app-init.js';

/**
 * 创建可观测性子系统
 * 包含：TraceCollector、AuditLogger、OTel、AuditChain、Analytics、Doctor
 *
 * @param ctx 共享装配上下文（读取 config/cwd/clientManager，写入 trace/audit/prompts/blackboard/offload*）
 * @returns 可观测性子系统依赖片段
 */
export function createObservabilitySubsystem(ctx: InitContext): Partial<AppDependencies> {
  const { config, cwd, clientManager } = ctx;

  // [I-4] OpenTelemetry exporter（P2.5）：受 config.observability.enabled 守护，fail-open
  // 使用变量路径让 TypeScript 无法静态解析，避免模块缺失时 typecheck 失败
  if (config.observability?.enabled) {
    const otelExporterModulePath = '../observability/otel-exporter.js';
    import(otelExporterModulePath)
      .then(({ OtelExporter }) => {
        const otelIntegrationModulePath = '../observability/integration.js';
        import(otelIntegrationModulePath)
          .then(({ setActiveOtelExporter }) => {
            const exporter = new OtelExporter({
              enabled: true,
              serviceName: config.observability!.serviceName || 'routedev',
              endpoint: config.observability!.endpoint,
              headers: config.observability!.headers,
              exportIntervalMs: config.observability!.exportIntervalMs,
            });
            setActiveOtelExporter(exporter);
            logger.info('OtelExporter enabled', { endpoint: config.observability!.endpoint });
          })
          .catch((err) => { logger.warn('OtelExporter fail-open', { error: String(err) }); });
      })
      .catch((err) => { logger.warn('OtelExporter fail-open', { error: String(err) }); });
  }

  // ===== 基础设施 =====
  const prompts = new PromptTemplateManager({ projectOverrides: true });
  const blackboard = new Blackboard();
  const trace = new TraceCollector({ storageDir: undefined });
  const audit = new AuditLogger(trace.getSessionId() ?? 'app');

  // Phase 80 Task 2：创建本地使用计数器（仅本地，禁止云上报，fail-open）
  // 供工具执行 / slash 命令 / Pack 加载等关键路径调用 increment 累加计数
  const usageCounter = new UsageCounter();

  // Phase 71 Task D7：注册 offload 清理钩子
  // - 启动时立即清理 7 天前的孤儿文件（防止异常退出累积）
  // - 退出时（beforeExit / SIGINT / SIGTERM）清理当前 session 的 offload 文件
  // - 钩子内部 fail-open，清理失败不会导致进程崩溃
  const offloadSessionId = trace.getSessionId() ?? `app-${Date.now()}`;
  const offloadRootDir = path.resolve(cwd, '.routedev/offload');
  registerOffloadCleaner(offloadSessionId, offloadRootDir);

  // Phase 53 Task 4：哈希链审计接入（受 config.phase53Integration.auditChain.enabled 守护）
  // 启用后所有 audit.log() 写入的记录会附加 previousHash + hash 字段，形成防篡改链
  // Phase 59 Task 2：auditChain 默认 true，加 fail-open 守卫——装配失败不阻塞主流程
  const phase53AuditChainCfg = config.phase53Integration?.auditChain;
  if (phase53AuditChainCfg?.enabled) {
    try {
      audit.setChainConfig({
        enabled: true,
        logFile: phase53AuditChainCfg.logFile,
        overflowSealCount: phase53AuditChainCfg.overflowSealCount,
      });
      logger.debug('AuditLogger hash-chain enabled', { via: 'setChainConfig' });
    } catch (err) {
      logger.warn('Phase 59: auditChain 装配失败，fail-open 跳过', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // G-F027 修复：ProjectMemoryManager 实例化与 loadProjectDoc 已移除（无消费方，数据流断裂）
  // 写回共享上下文，供其他子系统消费
  ctx.trace = trace;
  ctx.audit = audit;
  ctx.prompts = prompts;
  ctx.blackboard = blackboard;
  ctx.offloadSessionId = offloadSessionId;
  ctx.offloadRootDir = offloadRootDir;
  // Phase 80 Task 2：写入 ctx 供 tools 子系统注入 ToolExecutor
  ctx.usageCounter = usageCounter;

  // ===== Phase 53 Task 12：Doctor 健康检查（受 config.phase53Integration.doctor.runOnStartup 守护） =====
  // 启动时异步运行环境探测，结果输出到 logger；不阻塞主流程
  // Doctor 实例不暴露到 AppDependencies（一次性启动检查，UI 无需持有）
  const phase53DoctorCfg = config.phase53Integration?.doctor;
  if (phase53DoctorCfg?.runOnStartup) {
    // 动态 import 避免未启用时引入 spawnSync 噪音
    // app-init.ts 与 doctor.ts 同在 src/runtime/，使用相对路径 ./doctor.js
    const doctorPath = './doctor.js';
    import(doctorPath)
      .then((mod: { Doctor: new (cfg?: Partial<{ probeTimeout: number; runOnStartup: boolean }>, ctx?: { providers?: Array<{ id: string; baseUrl: string }>; mcpServers?: Array<{ id: string; command: string }>; cwd?: string }) => { runAllChecks: () => Promise<unknown[]>; formatReport: (r: unknown[]) => string } }) => {
        const doctor = new mod.Doctor(
          { probeTimeout: phase53DoctorCfg.probeTimeout, runOnStartup: true },
          {
            providers: config.providers.map(p => ({ id: p.id, baseUrl: p.baseUrl })),
            mcpServers: config.mcp.servers.map(s => ({ id: s.id, command: (s as { command?: string }).command ?? '' })),
            cwd,
          },
        );
        return doctor.runAllChecks().then((results: unknown[]) => {
          const report = doctor.formatReport(results);
          logger.info('Phase53 Doctor: startup probe complete', { report });
        });
      })
      .catch((err: unknown) => {
        // fail-open：Doctor 不可用时不阻塞主流程
        logger.debug('Phase53 Doctor not available', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // ===== P0-11：Analytics 队列挂载 sink + 关键路径 logEvent =====
  // 借鉴 Claude Code：模块加载时 sink=null，app 启动时 attachAnalyticsSink
  // 此处挂载一个简单的 logger sink（生产可替换为 OtelExporter）
  try {
    const loggerSink: AnalyticsSink = {
      name: 'logger-sink',
      flush(events: AnalyticsEvent[]) {
        for (const ev of events) {
          logger.debug('analytics event', {
            name: ev.name,
            timestamp: ev.timestamp,
            attrs: ev.attributes,
          });
        }
      },
    };
    attachAnalyticsSink(loggerSink);
    // 记录 app 启动事件（验证 logEvent 被实际调用，消除死代码）
    logEvent('app_init', {
      providerCount: clientManager.listAll().size,
      sessionId: trace.getSessionId(),
      cwd,
    });
    // P0-14：注册 analytics flush shutdown hook
    // 优先级 10：最低优先级，确保持久化/资源释放先完成；退出前强制 flush 队列中的剩余事件
    registerShutdownHook(10, 'analytics-flush', () => forceFlushNow());
  } catch (err) {
    // fail-open：analytics 挂载失败不影响主流程
    logger.warn('P0-11: analytics sink attach failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // G-F022 修复：注册 trace flush shutdown hook，确保退出前写入待刷新记录
  // 优先级 9：在 analytics flush（优先级 10）之前完成 trace 持久化
  registerShutdownHook(9, 'trace-flush', async () => {
    try {
      await trace.flush();
    } catch (err) {
      logger.debug('trace flush on shutdown failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    prompts,
    blackboard,
    trace,
    audit,
    usageCounter,
    // G-F022 修复：提供 dispose 方法，供 AppDependencies.dispose 调用刷新 trace
    dispose: async () => {
      try {
        await trace.flush();
      } catch (err) {
        logger.debug('observability dispose: trace flush failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
