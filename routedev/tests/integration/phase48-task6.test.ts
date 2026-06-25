// tests/integration/phase48-task6.test.ts
// Phase 48 Task 6 集成测试：TrajectoryAggregator 接入 harness
//
// 验证目标：
//   1. TraceCollector 实例有 getTrajectoryAggregator 方法，返回同一实例（共享）
//   2. 记录 step 后（endSession），TrajectoryAggregator 能聚合到当前会话的数据
//   3. /trace summary 命令使用 TraceCollector 的 aggregator 实例（验证共享）
//   4. 向后兼容：TrajectoryAggregator.aggregate(bundles) 显式传参仍工作

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import { TrajectoryAggregator } from '../../src/observability/trajectory-aggregator.js';
import { traceCommand } from '../../src/cli/commands/trace.js';
import type { AuditLogger } from '../../src/harness/audit-logger.js';
import type { TokenTracker } from '../../src/router/tracker.js';
import type { ServiceContext } from '../../src/cli/service-context.js';

// ============================================================
// 测试辅助
// ============================================================

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase48-task6-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** 创建 mock AuditLogger：listToday 返回空数组（无审计记录） */
function makeMockAudit(): AuditLogger {
  return {
    listToday: vi.fn(async () => []),
    listByAction: vi.fn(async () => []),
  } as unknown as AuditLogger;
}

/** 创建 mock TokenTracker：getStats 返回 null（无 token 数据） */
function makeMockTracker(): TokenTracker {
  return {
    getStats: vi.fn(() => null),
  } as unknown as TokenTracker;
}

/** 构造最小 ServiceContext，仅满足 /trace summary 命令的依赖 */
function makeMockServiceContext(
  trace: TraceCollector,
  audit: AuditLogger,
  tracker: TokenTracker,
): ServiceContext {
  return {
    trace,
    audit,
    tracker,
    config: { ui: { outputStyle: 'normal' } },
  } as unknown as ServiceContext;
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 48 Task 6 - TrajectoryAggregator 接入 harness', () => {
  describe('TraceCollector.getTrajectoryAggregator()', () => {
    it('返回 TrajectoryAggregator 实例，且多次调用返回同一实例（共享）', () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const agg1 = tc.getTrajectoryAggregator();
      const agg2 = tc.getTrajectoryAggregator();

      // 类型正确
      expect(agg1).toBeInstanceOf(TrajectoryAggregator);
      // 引用相等——证明 harness 与 /trace 命令共享同一实例
      expect(agg2).toBe(agg1);
    });

    it('不同 TraceCollector 实例持有独立的 aggregator', () => {
      const tc1 = new TraceCollector({ storageDir: tempDir });
      const tc2 = new TraceCollector({ storageDir: tempDir });

      expect(tc1.getTrajectoryAggregator()).not.toBe(tc2.getTrajectoryAggregator());
    });
  });

  describe('harness 在 endSession 时同步数据到 aggregator', () => {
    it('记录 tool_call 后 endSession，aggregator 能聚合到工具使用 Top 5', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('test goal');

      // 记录两次 file_write 和一次 shell_exec
      tc.recordToolCall('file_write', { path: '/a' }, 'c1', false);
      tc.recordToolResult('file_write', 'c1', 'ok', false);
      tc.recordToolCall('file_write', { path: '/b' }, 'c2', false);
      tc.recordToolResult('file_write', 'c2', 'ok', false);
      tc.recordToolCall('shell_exec', { cmd: 'ls' }, 'c3', false);
      tc.recordToolResult('shell_exec', 'c3', 'done', false);

      await tc.endSession();

      // 共享的 aggregator 已累积当前会话的 bundle
      const agg = tc.getTrajectoryAggregator();
      const accumulated = agg.getAccumulatedBundles();
      expect(accumulated.length).toBe(1);
      expect(accumulated[0].sessionId).toHaveLength(8);

      // 不传参数聚合——使用累积的 bundles
      const metrics = agg.aggregate();

      // 至少聚合到 1 个会话
      expect(metrics.totalSessions).toBe(1);

      // 工具使用 Top 5：file_write 2 次，shell_exec 1 次
      expect(metrics.topToolsByUsage.length).toBe(2);
      const fileWrite = metrics.topToolsByUsage.find(t => t.toolName === 'file_write');
      const shellExec = metrics.topToolsByUsage.find(t => t.toolName === 'shell_exec');
      expect(fileWrite?.callCount).toBe(2);
      expect(shellExec?.callCount).toBe(1);
    });

    it('endSession 时若有 totalUsage，bundle.tokenSummary 不为 null', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      tc.startSession('token test');
      tc.recordToolCall('file_read', {}, 'c1', false);
      tc.recordToolResult('file_read', 'c1', 'content', false);

      // 传入 totalUsage
      await tc.endSession({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });

      const agg = tc.getTrajectoryAggregator();
      const accumulated = agg.getAccumulatedBundles();
      expect(accumulated.length).toBe(1);
      expect(accumulated[0].tokenSummary).not.toBeNull();
      expect(accumulated[0].tokenSummary?.total?.totalTokens).toBe(150);

      // 聚合后平均 token/会话 = 150
      const metrics = agg.aggregate();
      expect(metrics.avgTokensPerSession).toBe(150);
    });

    it('多次会话累积，aggregator 跨会话聚合', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });

      // 会话 1
      tc.startSession('goal 1');
      tc.recordToolCall('file_write', {}, 'c1', false);
      tc.recordToolResult('file_write', 'c1', 'ok', false);
      await tc.endSession();

      // 会话 2
      tc.startSession('goal 2');
      tc.recordToolCall('shell_exec', {}, 'c2', false);
      tc.recordToolResult('shell_exec', 'c2', 'done', false);
      await tc.endSession();

      const agg = tc.getTrajectoryAggregator();
      const metrics = agg.aggregate();

      // 2 个会话都被累积
      expect(metrics.totalSessions).toBe(2);
      // 两个工具各 1 次
      expect(metrics.topToolsByUsage.length).toBe(2);
    });
  });

  describe('/trace summary 命令使用 TraceCollector 的 aggregator 实例', () => {
    it('命令调用 trace.getTrajectoryAggregator()，结果包含累积的会话数据', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const audit = makeMockAudit();
      const tracker = makeMockTracker();
      const ctx = makeMockServiceContext(tc, audit, tracker);

      // 准备：harness 累积一个会话
      tc.startSession('trace cmd test');
      tc.recordToolCall('file_write', {}, 'c1', false);
      tc.recordToolResult('file_write', 'c1', 'ok', false);
      await tc.endSession();

      // 监听 getTrajectoryAggregator 调用
      const spy = vi.spyOn(tc, 'getTrajectoryAggregator');

      // 执行 /trace summary
      const result = await traceCommand.handler('summary', ctx);

      // 验证命令确实调用了 TraceCollector.getTrajectoryAggregator()
      expect(spy).toHaveBeenCalled();

      // 验证返回成功，且聚合结果包含 file_write 工具
      expect(result.type).toBe('handled');
      const message = Array.isArray(result.messages) ? result.messages[0] : '';
      expect(message).toContain('轨迹聚合分析');
      expect(message).toContain('会话总数: 1');
      expect(message).toContain('file_write');
    });

    it('无会话且磁盘无记录时，命令返回「无可用会话记录」', async () => {
      const tc = new TraceCollector({ storageDir: tempDir });
      const audit = makeMockAudit();
      const tracker = makeMockTracker();
      const ctx = makeMockServiceContext(tc, audit, tracker);

      // 不累积任何会话，listSessions 也返回空（新实例）
      const result = await traceCommand.handler('summary', ctx);

      expect(result.type).toBe('handled');
      const message = Array.isArray(result.messages) ? result.messages[0] : '';
      expect(message).toContain('无可用会话记录');
    });
  });

  describe('向后兼容：TrajectoryAggregator.aggregate(bundles) 显式传参仍工作', () => {
    it('显式传入 bundles 时不使用累积的 bundles', () => {
      const aggregator = new TrajectoryAggregator();

      // 累积一个空 bundle
      aggregator.addBundle({
        sessionId: 'accumulated-1',
        exportedAt: new Date().toISOString(),
        auditRecords: [],
        traceRecords: [],
        tokenSummary: null,
      });

      // 显式传入另一个 bundle
      const explicitBundle = {
        sessionId: 'explicit-1',
        exportedAt: new Date().toISOString(),
        auditRecords: [],
        traceRecords: [],
        tokenSummary: null,
        goalSummary: { goal: 'explicit', status: 'completed' as const, durationMs: 100, stepCount: 1 },
      };

      const metrics = aggregator.aggregate([explicitBundle]);

      // 应该用显式传入的（1 个），而不是累积的（1 个）
      expect(metrics.totalSessions).toBe(1);
      expect(metrics.completedGoals).toBe(1);
    });

    it('不传参数且无累积时返回零值', () => {
      const aggregator = new TrajectoryAggregator();
      const metrics = aggregator.aggregate();

      expect(metrics.totalSessions).toBe(0);
      expect(metrics.successRate).toBe(0);
      expect(metrics.topToolsByUsage).toEqual([]);
    });
  });
});
