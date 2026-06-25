// tests/phase35/trajectory.test.ts
// Phase 35 Task 4：执行轨迹导出与聚合分析测试
// 验证：TrajectoryExporter 导出完整性、TrajectoryAggregator 计算正确性

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TrajectoryExporter, type TrajectoryBundle } from '../../src/observability/trajectory-exporter.js';
import { TrajectoryAggregator } from '../../src/observability/trajectory-aggregator.js';
import type { AuditLogger } from '../../src/harness/audit-logger.js';
import type { TraceCollector } from '../../src/harness/trace-collector.js';
import type { TokenTracker } from '../../src/router/tracker.js';
import type { AuditRecord, TraceRecord } from '../../src/harness/trace-types.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建 mock AuditLogger */
function makeMockAudit(records: AuditRecord[]): AuditLogger {
  return {
    listToday: vi.fn(async () => records),
    listByAction: vi.fn(async (action: string) => records.filter(r => r.action === action)),
  } as unknown as AuditLogger;
}

/** 创建 mock TraceCollector */
function makeMockTrace(sessionId: string, records: TraceRecord[]): TraceCollector {
  return {
    getSessionId: vi.fn(() => sessionId),
    readSessionRecords: vi.fn(async () => records),
    listSessions: vi.fn(async () => []),
  } as unknown as TraceCollector;
}

/** 创建 mock TokenTracker */
function makeMockTracker(totalTokens: number = 1000): TokenTracker {
  return {
    getStats: vi.fn(() => ({
      total: { inputTokens: 400, outputTokens: 600, totalTokens },
      byModel: { 'test-model': { inputTokens: 400, outputTokens: 600, totalTokens } },
      byAgent: { 'main': { inputTokens: 400, outputTokens: 600, totalTokens } },
      byStep: { 'step-1': { inputTokens: 400, outputTokens: 600, totalTokens } },
    })),
  } as unknown as TokenTracker;
}

/** 创建测试用 AuditRecord */
function makeAuditRecord(
  action: string,
  sessionId: string,
  details: Record<string, unknown> = {},
  timestamp?: string,
): AuditRecord {
  return {
    timestamp: timestamp ?? new Date().toISOString(),
    sessionId,
    action: action as AuditRecord['action'],
    agentId: 'main',
    target: 'test',
    details,
    result: 'success',
  };
}

/** 创建测试用 TraceRecord */
function makeTraceRecord(event: string, data: Record<string, unknown>): TraceRecord {
  return {
    timestamp: new Date().toISOString(),
    sessionId: 'test-session',
    event,
    data,
  };
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 35 Task 4: 执行轨迹导出与聚合分析', () => {
  describe('TrajectoryExporter', () => {
    it('exportSession() 组装完整的轨迹快照（审计 + trace + token）', async () => {
      const sessionId = 'test-session-001';
      const auditRecords: AuditRecord[] = [
        makeAuditRecord('goal_start', sessionId, { description: '测试目标', stepCount: 3 }),
        makeAuditRecord('file_write', sessionId, { operation: 'write' }),
        makeAuditRecord('goal_complete', sessionId, {}),
      ];
      const traceRecords: TraceRecord[] = [
        makeTraceRecord('tool_call', { toolName: 'file_write' }),
        makeTraceRecord('llm_call', { modelId: 'test-model' }),
      ];

      const exporter = new TrajectoryExporter(
        makeMockAudit(auditRecords),
        makeMockTrace(sessionId, traceRecords),
        makeMockTracker(1500),
      );

      const bundle = await exporter.exportSession(sessionId);

      expect(bundle.sessionId).toBe(sessionId);
      expect(bundle.auditRecords.length).toBe(3);
      expect(bundle.traceRecords.length).toBe(2);
      expect(bundle.tokenSummary).not.toBeNull();
      expect(bundle.tokenSummary!.total.totalTokens).toBe(1500);
      expect(bundle.goalSummary).toBeDefined();
      expect(bundle.goalSummary!.goal).toBe('测试目标');
      expect(bundle.goalSummary!.status).toBe('completed');
      expect(bundle.goalSummary!.stepCount).toBe(3);
    });

    it('exportAsJson() 返回可解析的 JSON 字符串', async () => {
      const sessionId = 'test-session-002';
      const auditRecords: AuditRecord[] = [
        makeAuditRecord('goal_start', sessionId, { description: '目标' }),
      ];

      const exporter = new TrajectoryExporter(
        makeMockAudit(auditRecords),
        makeMockTrace(sessionId, []),
        null, // 无 tracker
      );

      const json = await exporter.exportAsJson(sessionId);
      expect(typeof json).toBe('string');

      // 验证 JSON 可解析
      const parsed = JSON.parse(json);
      expect(parsed.sessionId).toBe(sessionId);
      expect(parsed.auditRecords).toBeInstanceOf(Array);
      expect(parsed.tokenSummary).toBeNull();
    });

    it('goal 失败时 goalSummary.status 为 failed', async () => {
      const sessionId = 'test-session-003';
      const auditRecords: AuditRecord[] = [
        makeAuditRecord('goal_start', sessionId, { description: '会失败的目标' }),
        makeAuditRecord('goal_fail', sessionId, {}, 'failure' as any),
      ];

      const exporter = new TrajectoryExporter(
        makeMockAudit(auditRecords),
        makeMockTrace(sessionId, []),
        null,
      );

      const bundle = await exporter.exportSession(sessionId);
      expect(bundle.goalSummary).toBeDefined();
      expect(bundle.goalSummary!.status).toBe('failed');
    });
  });

  describe('TrajectoryAggregator', () => {
    it('aggregate() 计算跨会话聚合指标', () => {
      const bundles: TrajectoryBundle[] = [
        {
          sessionId: 's1',
          exportedAt: new Date().toISOString(),
          auditRecords: [],
          traceRecords: [
            makeTraceRecord('tool_call', { toolName: 'file_write' }),
            makeTraceRecord('tool_call', { toolName: 'file_write' }),
            makeTraceRecord('tool_call', { toolName: 'shell_exec' }),
          ],
          tokenSummary: {
            total: { inputTokens: 400, outputTokens: 600, totalTokens: 1000 },
            byModel: { 'model-a': { inputTokens: 400, outputTokens: 600, totalTokens: 1000 } },
            byAgent: {},
            byStep: {},
          },
          goalSummary: { goal: '目标1', status: 'completed', durationMs: 5000, stepCount: 3 },
        },
        {
          sessionId: 's2',
          exportedAt: new Date().toISOString(),
          auditRecords: [],
          traceRecords: [
            makeTraceRecord('tool_call', { toolName: 'file_write' }),
            makeTraceRecord('tool_call', { toolName: 'file_edit' }),
          ],
          tokenSummary: {
            total: { inputTokens: 300, outputTokens: 700, totalTokens: 1000 },
            byModel: { 'model-b': { inputTokens: 300, outputTokens: 700, totalTokens: 1000 } },
            byAgent: {},
            byStep: {},
          },
          goalSummary: { goal: '目标2', status: 'failed', durationMs: 3000, stepCount: 2 },
        },
      ];

      const aggregator = new TrajectoryAggregator();
      const metrics = aggregator.aggregate(bundles);

      expect(metrics.totalSessions).toBe(2);
      expect(metrics.completedGoals).toBe(1);
      expect(metrics.failedGoals).toBe(1);
      expect(metrics.successRate).toBe(0.5);
      expect(metrics.avgTokensPerSession).toBe(1000);
      expect(metrics.avgDurationPerGoal).toBe(4000); // (5000 + 3000) / 2

      // 工具使用 Top 5：file_write 3 次，shell_exec 1 次，file_edit 1 次
      expect(metrics.topToolsByUsage.length).toBe(3);
      expect(metrics.topToolsByUsage[0].toolName).toBe('file_write');
      expect(metrics.topToolsByUsage[0].callCount).toBe(3);

      // 模型 token 分布
      expect(metrics.modelUsageBreakdown['model-a']).toBe(1000);
      expect(metrics.modelUsageBreakdown['model-b']).toBe(1000);
    });

    it('空数组返回零值指标', () => {
      const aggregator = new TrajectoryAggregator();
      const metrics = aggregator.aggregate([]);

      expect(metrics.totalSessions).toBe(0);
      expect(metrics.avgTokensPerSession).toBe(0);
      expect(metrics.successRate).toBe(0);
      expect(metrics.topToolsByUsage).toEqual([]);
    });

    it('formatAsText() 输出可读文本', () => {
      const bundles: TrajectoryBundle[] = [
        {
          sessionId: 's1',
          exportedAt: new Date().toISOString(),
          auditRecords: [],
          traceRecords: [
            makeTraceRecord('tool_call', { toolName: 'file_write' }),
          ],
          tokenSummary: {
            total: { inputTokens: 400, outputTokens: 600, totalTokens: 1000 },
            byModel: { 'model-a': { inputTokens: 400, outputTokens: 600, totalTokens: 1000 } },
            byAgent: {},
            byStep: {},
          },
          goalSummary: { goal: '目标1', status: 'completed', durationMs: 5000, stepCount: 3 },
        },
      ];

      const aggregator = new TrajectoryAggregator();
      const metrics = aggregator.aggregate(bundles);
      const text = aggregator.formatAsText(metrics);

      expect(text).toContain('轨迹聚合分析');
      expect(text).toContain('会话总数: 1');
      expect(text).toContain('file_write');
      expect(text).toContain('model-a');
    });
  });
});
