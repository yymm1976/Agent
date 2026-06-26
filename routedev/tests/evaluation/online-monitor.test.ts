// tests/evaluation/online-monitor.test.ts
// Phase 49 Task 5.4：在线监控信号单元测试
//
// 覆盖蓝图 5.4 节测试要求：
//   1. 延迟超阈值告警
//   2. 成本日环比超 30% 告警
//   3. 错误路由率超 5% 告警
//   4. ScoreCard 数据被正确聚合
//   5. 差评率超 10% 告警
//   6. 漂移 KL 散度超 20% 告警
//   7. 配置 ROI 提示（陷阱 #155）

import { describe, it, expect } from 'vitest';
import { OnlineMonitor, type Alert } from '../../src/evaluation/online-monitor.js';
import type { ScoreCard as RealScoreCard } from '../../src/agent/multi/score-card.js';

// ============================================================
// 辅助函数
// ============================================================

/** 构造一个 ScoreCard */
function makeCard(overrides: Partial<RealScoreCard> = {}): RealScoreCard {
  return {
    stepId: overrides.stepId ?? 'step-1',
    role: overrides.role ?? 'coder',
    modelId: overrides.modelId ?? 'mock-model',
    tokenUsage: overrides.tokenUsage ?? { input: 100, output: 50, total: 150 },
    durationMs: overrides.durationMs ?? 100,
    toolCalls: overrides.toolCalls ?? 1,
    fileEdits: overrides.fileEdits ?? 0,
    testsRun: overrides.testsRun ?? 0,
    testsPassed: overrides.testsPassed ?? 0,
    lintErrors: overrides.lintErrors ?? 0,
    typeErrors: overrides.typeErrors ?? 0,
    userFeedback: overrides.userFeedback ?? 'accepted',
  };
}

/** 断言告警类型 */
function expectAlertType(alerts: Alert[], type: Alert['type']): Alert {
  const found = alerts.find(a => a.type === type);
  expect(found, `应包含 ${type} 告警`).toBeDefined();
  return found as Alert;
}

// ============================================================
// 测试套件
// ============================================================

describe('OnlineMonitor (Phase 49 Task 5.3)', () => {
  // ============================================================
  // 测试 1：延迟超过阈值告警
  // ============================================================
  it('1. P95 延迟 > 300ms 时触发 latency 告警', () => {
    const monitor = new OnlineMonitor();

    // 20 个用例，全部 500ms → P95 = 500ms > 300ms
    const cards = Array.from({ length: 20 }, (_, i) =>
      makeCard({ stepId: `step-${i}`, durationMs: 500 }),
    );
    const alerts = monitor.monitorLatency(cards);

    expect(alerts.length).toBeGreaterThan(0);
    const latencyAlert = expectAlertType(alerts, 'latency');
    expect(latencyAlert.threshold).toBe(300);
    expect(latencyAlert.actual).toBe(500);
    expect(latencyAlert.actual).toBeGreaterThan(latencyAlert.threshold);
  });

  it('1b. P95 延迟低于阈值时不告警', () => {
    const monitor = new OnlineMonitor();
    // 全部 100ms < 300ms → 不告警
    const cards = Array.from({ length: 20 }, (_, i) =>
      makeCard({ stepId: `step-${i}`, durationMs: 100 }),
    );
    const alerts = monitor.monitorLatency(cards);
    expect(alerts).toHaveLength(0);
  });

  // ============================================================
  // 测试 2：成本日环比超 30% 告警
  // ============================================================
  it('2. Token 日环比 > 30% 时触发 cost 告警', () => {
    const monitor = new OnlineMonitor();

    // 昨日 1000 token，今日 2000 token → 环比 +100% > 30%
    const cards = [
      makeCard({ tokenUsage: { input: 500, output: 500, total: 1000 } }),
      makeCard({ tokenUsage: { input: 500, output: 500, total: 1000 } }),
    ];
    const alerts = monitor.monitorCost(cards, 1000);

    expect(alerts.length).toBeGreaterThan(0);
    const costAlert = expectAlertType(alerts, 'cost');
    expect(costAlert.actual).toBeGreaterThan(0.3);
    // 消息中应包含百分比
    expect(costAlert.message).toContain('%');
  });

  it('2b. Token 日环比 ≤ 30% 时不告警', () => {
    const monitor = new OnlineMonitor();
    // 昨日 1000，今日 1100 → +10% < 30%
    const cards = [makeCard({ tokenUsage: { input: 600, output: 500, total: 1100 } })];
    const alerts = monitor.monitorCost(cards, 1000);
    expect(alerts).toHaveLength(0);
  });

  // ============================================================
  // 测试 3：错误路由率超 5% 告警
  // ============================================================
  it('3. 错误路由率 > 5% 时触发 quality 告警', () => {
    const monitor = new OnlineMonitor();

    // 100 个请求，10 个错误路由 → 错误率 10% > 5%
    const alerts = monitor.monitorQuality(10, 100);

    expect(alerts.length).toBeGreaterThan(0);
    const qualityAlert = expectAlertType(alerts, 'quality');
    expect(qualityAlert.actual).toBeCloseTo(0.1, 5);
    expect(qualityAlert.threshold).toBe(0.05);
  });

  it('3b. 错误路由率 ≤ 5% 时不告警', () => {
    const monitor = new OnlineMonitor();
    // 100 个请求，3 个错误 → 3% < 5%
    const alerts = monitor.monitorQuality(3, 100);
    expect(alerts).toHaveLength(0);
  });

  // ============================================================
  // 测试 4：ScoreCard 数据被正确聚合到在线监控
  // ============================================================
  it('4. ScoreCard 数据被正确聚合（延迟/成本/反馈三项同时计算）', () => {
    const monitor = new OnlineMonitor();

    // 构造 10 个 ScoreCard：
    //   - 全部 durationMs=500ms → 触发延迟告警（P95=500 > 300）
    //   - 总 token = 10 * 1000 = 10000，昨日 5000 → 环比 +100% > 30% → 触发成本告警
    //   - 5 个 rejected，5 个 accepted → 差评率 50% > 10% → 触发反馈告警
    const cards: RealScoreCard[] = Array.from({ length: 10 }, (_, i) =>
      makeCard({
        stepId: `step-${i}`,
        durationMs: 500,
        tokenUsage: { input: 500, output: 500, total: 1000 },
        userFeedback: i < 5 ? 'rejected' : 'accepted',
      }),
    );

    const alerts = monitor.runAll({
      scoreCards: cards,
      yesterdayTotalTokens: 5000,
    });

    // 应同时触发三类告警
    const types = new Set(alerts.map(a => a.type));
    expect(types.has('latency')).toBe(true);
    expect(types.has('cost')).toBe(true);
    expect(types.has('feedback')).toBe(true);
  });

  it('4b. 空入参时 runAll 返回空数组', () => {
    const monitor = new OnlineMonitor();
    const alerts = monitor.runAll({});
    expect(alerts).toEqual([]);
  });

  // ============================================================
  // 测试 5：差评率超 10% 告警
  // ============================================================
  it('5. 差评率 > 10% 时触发 feedback 告警', () => {
    const monitor = new OnlineMonitor();

    // 10 个卡片，2 个 rejected → 差评率 20% > 10%
    const cards: RealScoreCard[] = Array.from({ length: 10 }, (_, i) =>
      makeCard({
        stepId: `step-${i}`,
        userFeedback: i < 2 ? 'rejected' : 'accepted',
      }),
    );

    const alerts = monitor.monitorUserFeedback(cards);
    expect(alerts.length).toBeGreaterThan(0);
    const feedbackAlert = expectAlertType(alerts, 'feedback');
    expect(feedbackAlert.actual).toBeCloseTo(0.2, 5);
    expect(feedbackAlert.threshold).toBe(0.1);
  });

  it('5b. edited 不计入差评（差评率 = rejected 占比）', () => {
    const monitor = new OnlineMonitor();

    // 10 个卡片，5 个 edited，0 个 rejected → 差评率 0%
    const cards: RealScoreCard[] = Array.from({ length: 10 }, () =>
      makeCard({ userFeedback: 'edited' }),
    );

    const alerts = monitor.monitorUserFeedback(cards);
    expect(alerts).toHaveLength(0);
  });

  // ============================================================
  // 测试 6：漂移 KL 散度超 20% 告警
  // ============================================================
  it('6. 意图分布 KL 散度 > 0.2 时触发 drift 告警', () => {
    const monitor = new OnlineMonitor();

    // 今日分布：90% 在 intentA，10% 在 intentB
    // 昨日分布：10% 在 intentA，90% 在 intentB
    // → KL 散度应该非常大（远超 0.2）
    const today = { intentA: 90, intentB: 10 };
    const yesterday = { intentA: 10, intentB: 90 };

    const alerts = monitor.monitorDrift(today, yesterday);

    expect(alerts.length).toBeGreaterThan(0);
    const driftAlert = expectAlertType(alerts, 'drift');
    expect(driftAlert.actual).toBeGreaterThan(0.2);
    expect(driftAlert.threshold).toBe(0.2);
  });

  it('6b. 分布未显著变化时不告警', () => {
    const monitor = new OnlineMonitor();

    // 今日与昨日分布几乎一致 → KL ≈ 0
    const today = { intentA: 50, intentB: 50 };
    const yesterday = { intentA: 51, intentB: 49 };

    const alerts = monitor.monitorDrift(today, yesterday);
    expect(alerts).toHaveLength(0);
  });

  it('6c. KL 散度计算符合公式 sum(p_i * log(p_i / q_i))', () => {
    const monitor = new OnlineMonitor();

    // 单一分布（完全相同）→ KL = 0
    const same1 = { a: 50, b: 50 };
    const same2 = { a: 50, b: 50 };
    expect(monitor.monitorDrift(same1, same2)).toHaveLength(0);

    // 极端漂移：昨日全是 A，今日全是 B
    // p_B=1, q_B=0 → KL = 1 * log(1 / epsilon) ≈ 23（远超 0.2）
    const today = { b: 100 };
    const yesterday = { a: 100 };
    const alerts = monitor.monitorDrift(today, yesterday);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].actual).toBeGreaterThan(0.2);
  });

  // ============================================================
  // 测试 7：配置 ROI 提示（陷阱 #155）
  // ============================================================
  it('7. 长期未使用的配置触发 config-roi 归档提示（陷阱 #155）', () => {
    const monitor = new OnlineMonitor();

    // 三个配置：A 用了 5 天，B 用了 35 天，C 用了 60 天
    // 阈值 30 天 → B、C 应触发归档提示，A 不应
    const configLastUsedDays = {
      'skill-a': 5,
      'skill-b': 35,
      'skill-c': 60,
    };

    const alerts = monitor.monitorConfigRoi(configLastUsedDays, 30);

    // 应触发 2 个告警（B、C）
    const roiAlerts = alerts.filter(a => a.type === 'config-roi');
    expect(roiAlerts).toHaveLength(2);

    // 告警应包含对应的配置名
    const messages = roiAlerts.map(a => a.message);
    expect(messages.some(m => m.includes('skill-b'))).toBe(true);
    expect(messages.some(m => m.includes('skill-c'))).toBe(true);
    expect(messages.some(m => m.includes('skill-a'))).toBe(false);

    // 严重度应为 low（归档提示是低严重度建议）
    for (const a of roiAlerts) {
      expect(a.severity).toBe('low');
      expect(a.threshold).toBe(30);
    }
  });

  it('7b. runAll 同时运行配置 ROI 监控', () => {
    const monitor = new OnlineMonitor();

    const alerts = monitor.runAll({
      configLastUsedDays: { 'unused-skill': 60 },
      configArchiveThresholdDays: 30,
    });

    const roiAlert = alerts.find(a => a.type === 'config-roi');
    expect(roiAlert).toBeDefined();
    expect(roiAlert?.message).toContain('unused-skill');
  });
});
