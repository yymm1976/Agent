// tests/evaluation/architecture-aware-metrics.test.ts
// Phase 52 Task 6：架构感知评估指标单元测试
//
// 覆盖蓝图测试要求：
//   1. 6 个组件的指标正确提取（每个组件都有 metrics 数组）
//   2. 异常组件正确识别（超出预期范围的指标 isAnomaly=true）
//   3. 诊断报告包含组件级信息（中文，含组件名和异常标记）
//   4. anomalySensitivity=high 时检测更多异常（同一轨迹 high 比 low 检测出更多）
//   5. anomalySensitivity=low 时只检测严重异常

import { describe, it, expect } from 'vitest';
import {
  ArchitectureAwareMetricsCollector,
  type TrajectoryInput,
  type ComponentMetrics,
  type MetricEntry,
  type ArchComponent,
} from '../../src/evaluation/architecture-aware-metrics.js';

// ============================================================
// 辅助函数
// ============================================================

/** 构造一份全部正常的执行轨迹 */
function makeNormalTrajectory(): TrajectoryInput {
  return {
    routerDecisions: Array.from({ length: 10 }, (_, i) => ({
      modelId: `model-${i}`,
      tier: 'simple',
      latencyMs: 100,
      degraded: false,
    })),
    plannerSteps: Array.from({ length: 10 }, (_, i) => ({
      stepId: `step-${i}`,
      planningMs: 100,
      stepCount: 5,
    })),
    memoryAccesses: Array.from({ length: 10 }, () => ({
      hit: true,
      age: 1,
      size: 100,
    })),
    toolCalls: Array.from({ length: 10 }, (_, i) => ({
      toolName: `tool-${i}`,
      success: true,
      latencyMs: 100,
      isError: false,
    })),
    skillFlowEvents: Array.from({ length: 10 }, () => ({
      nodeType: 'action',
      skipped: false,
      userIntervened: false,
      loopCount: 0,
    })),
    dualLoopEvents: Array.from({ length: 10 }, () => ({
      rerun: false,
      appealed: false,
      blocked: false,
    })),
  };
}

/** 统计所有指标中 isAnomaly=true 的数量 */
function countAnomalies(metrics: ComponentMetrics[]): number {
  return metrics.reduce((acc, c) => acc + c.metrics.filter(m => m.isAnomaly).length, 0);
}

/** 收集所有异常指标的名称 */
function collectAnomalyNames(metrics: ComponentMetrics[]): string[] {
  const names: string[] = [];
  for (const c of metrics) {
    for (const m of c.metrics) {
      if (m.isAnomaly) names.push(m.name);
    }
  }
  return names;
}

/** 按组件名查找指标集合 */
function findComponent(metrics: ComponentMetrics[], component: ArchComponent): ComponentMetrics {
  const found = metrics.find(c => c.component === component);
  expect(found, `应包含组件 ${component}`).toBeDefined();
  return found as ComponentMetrics;
}

/** 按指标名查找指标项 */
function findMetric(metrics: MetricEntry[], name: string): MetricEntry {
  const found = metrics.find(m => m.name === name);
  expect(found, `应包含指标 ${name}`).toBeDefined();
  return found as MetricEntry;
}

// ============================================================
// 测试套件
// ============================================================

describe('ArchitectureAwareMetricsCollector (Phase 52 Task 6)', () => {
  // ============================================================
  // 测试 1：6 个组件的指标正确提取
  // ============================================================
  it('1. extractFromTrajectory 返回 6 个组件，每个组件都有 metrics 数组', () => {
    const collector = new ArchitectureAwareMetricsCollector('medium');
    const metrics = collector.extractFromTrajectory(makeNormalTrajectory());

    // 返回 6 个组件
    expect(metrics).toHaveLength(6);

    // 组件名与顺序符合预期
    const expectedComponents: ArchComponent[] = [
      'router', 'planner', 'memory', 'tool_executor', 'skill_flow', 'dual_loop',
    ];
    expect(metrics.map(c => c.component)).toEqual(expectedComponents);

    // 每个组件都有非空 metrics 数组（各 3 项）
    for (const cm of metrics) {
      expect(cm.metrics.length).toBeGreaterThan(0);
      expect(cm.metrics.length).toBe(3);
      // 每条指标字段完整
      for (const m of cm.metrics) {
        expect(typeof m.name).toBe('string');
        expect(typeof m.value).toBe('number');
        expect(typeof m.unit).toBe('string');
        expect(m.expectedRange).toHaveProperty('min');
        expect(m.expectedRange).toHaveProperty('max');
        expect(typeof m.isAnomaly).toBe('boolean');
      }
    }

    // 正常轨迹在 medium 敏感度下不应有异常
    expect(countAnomalies(metrics)).toBe(0);
  });

  // ============================================================
  // 测试 2：异常组件正确识别
  // ============================================================
  it('2. 超出预期范围的指标 isAnomaly=true，identifyAnomalies 正确返回异常组件', () => {
    const collector = new ArchitectureAwareMetricsCollector('medium');

    const traj = makeNormalTrajectory();
    // 工具执行：5 成功 5 失败，5 次 isError → 成功率 0.5、误用率 0.5
    traj.toolCalls = Array.from({ length: 10 }, (_, i) => ({
      toolName: `tool-${i}`,
      success: i < 5,
      latencyMs: 100,
      isError: i >= 5,
    }));
    // 路由：5 次 degraded → 准确率 0.5
    traj.routerDecisions = Array.from({ length: 10 }, (_, i) => ({
      modelId: `model-${i}`,
      tier: 'simple',
      latencyMs: 100,
      degraded: i >= 5,
    }));

    const metrics = collector.extractFromTrajectory(traj);

    // 工具成功率（0.5 < 0.9）应为异常
    const toolMetrics = findComponent(metrics, 'tool_executor').metrics;
    const successRate = findMetric(toolMetrics, '工具成功率');
    expect(successRate.value).toBeCloseTo(0.5, 4);
    expect(successRate.isAnomaly).toBe(true);

    // 工具误用率（0.5 > 0.05）应为异常
    const misuseRate = findMetric(toolMetrics, '工具误用率');
    expect(misuseRate.value).toBeCloseTo(0.5, 4);
    expect(misuseRate.isAnomaly).toBe(true);

    // 路由准确率（0.5 < 0.85）应为异常
    const routerMetrics = findComponent(metrics, 'router').metrics;
    const accuracy = findMetric(routerMetrics, '路由准确率');
    expect(accuracy.value).toBeCloseTo(0.5, 4);
    expect(accuracy.isAnomaly).toBe(true);

    // identifyAnomalies 返回包含 tool_executor 与 router 的异常组件
    const anomalies = collector.identifyAnomalies(metrics);
    const anomalyComponents = anomalies.map(c => c.component);
    expect(anomalyComponents).toContain('tool_executor');
    expect(anomalyComponents).toContain('router');

    // 正常组件（planner）不应出现在异常列表中
    expect(anomalyComponents).not.toContain('planner');
  });

  // ============================================================
  // 测试 3：诊断报告包含组件级信息（中文 + 异常标记）
  // ============================================================
  it('3. generateDiagnosticReport 生成中文报告，含组件名与异常标记', () => {
    const collector = new ArchitectureAwareMetricsCollector('medium');

    const traj = makeNormalTrajectory();
    // 制造一个异常：工具延迟严重超标（4000ms > 2000ms）
    traj.toolCalls = Array.from({ length: 10 }, (_, i) => ({
      toolName: `tool-${i}`,
      success: true,
      latencyMs: 4000,
      isError: false,
    }));

    const metrics = collector.extractFromTrajectory(traj);
    const report = collector.generateDiagnosticReport(metrics);

    // 报告标题
    expect(report).toContain('架构感知评估诊断报告');
    expect(report).toContain('异常敏感度: medium');

    // 包含全部 6 个组件名（英文标识）
    for (const comp of ['router', 'planner', 'memory', 'tool_executor', 'skill_flow', 'dual_loop']) {
      expect(report).toContain(`[${comp}]`);
    }

    // 包含组件中文标签
    expect(report).toContain('路由组件');
    expect(report).toContain('工具执行组件');

    // 包含异常标记与正常标记
    expect(report).toContain('[异常]');
    expect(report).toContain('[正常]');

    // 工具延迟指标应被标记为异常，且报告包含其名称
    expect(report).toContain('工具延迟');
    // 汇总段
    expect(report).toContain('异常组件');
    expect(report).toContain('异常指标');
  });

  // ============================================================
  // 测试 4：anomalySensitivity=high 时检测更多异常
  // ============================================================
  it('4. 同一轨迹 high 比 low 检测出更多异常', () => {
    // 构造一份"接近边界但未越界"的轨迹：
    //   - 工具延迟 1900ms（range [0,2000]，high 在 1800 即触发，low 需 >3000）
    //   - 记忆命中率 0.62（range [0.6,1.0]，high 在 <=0.64 触发，low 需 <0.4）
    //   - 节点跳过率 0.19（range [0,0.2]，high 在 >=0.18 触发，low 需 >0.3）
    const traj = makeNormalTrajectory();
    traj.toolCalls = Array.from({ length: 10 }, (_, i) => ({
      toolName: `tool-${i}`,
      success: true,
      latencyMs: 1900,
      isError: false,
    }));
    // 100 条记忆访问，62 命中 → 命中率 0.62
    traj.memoryAccesses = Array.from({ length: 100 }, (_, i) => ({
      hit: i < 62,
      age: 1,
      size: 100,
    }));
    // 100 个技能流事件，19 跳过 → 跳过率 0.19
    traj.skillFlowEvents = Array.from({ length: 100 }, (_, i) => ({
      nodeType: 'action',
      skipped: i < 19,
      userIntervened: false,
      loopCount: 0,
    }));

    const lowCollector = new ArchitectureAwareMetricsCollector('low');
    const highCollector = new ArchitectureAwareMetricsCollector('high');

    const lowMetrics = lowCollector.extractFromTrajectory(traj);
    const highMetrics = highCollector.extractFromTrajectory(traj);

    const lowCount = countAnomalies(lowMetrics);
    const highCount = countAnomalies(highMetrics);

    // high 检测出更多异常
    expect(highCount).toBeGreaterThan(lowCount);

    // low 在此轨迹下不应检测到任何异常（所有值都在范围内，未严重越界）
    expect(lowCount).toBe(0);

    // high 至少检测到 3 项接近边界的异常
    expect(highCount).toBeGreaterThanOrEqual(3);

    const highAnomalyNames = collectAnomalyNames(highMetrics);
    expect(highAnomalyNames).toContain('工具延迟');
    expect(highAnomalyNames).toContain('记忆命中率');
    expect(highAnomalyNames).toContain('节点跳过率');
  });

  // ============================================================
  // 测试 5：anomalySensitivity=low 时只检测严重异常
  // ============================================================
  it('5. low 敏感度只检测严重超出 50% 的异常，轻微越界不标记', () => {
    // 构造一份包含"严重异常"与"轻微异常"的轨迹：
    //   - 工具延迟 4000ms（range [0,2000]）：low 阈值 = 2000 + 0.5*2000 = 3000 → 4000 严重异常
    //   - 记忆膨胀率 1100（range [0,1000]）：low 阈值 = 1000 + 0.5*1000 = 1500 → 1100 未达严重
    const traj = makeNormalTrajectory();
    traj.toolCalls = Array.from({ length: 10 }, (_, i) => ({
      toolName: `tool-${i}`,
      success: true,
      latencyMs: 4000,
      isError: false,
    }));
    traj.memoryAccesses = Array.from({ length: 10 }, () => ({
      hit: true,
      age: 1,
      size: 1100,
    }));

    const lowCollector = new ArchitectureAwareMetricsCollector('low');
    const mediumCollector = new ArchitectureAwareMetricsCollector('medium');

    const lowMetrics = lowCollector.extractFromTrajectory(traj);
    const mediumMetrics = mediumCollector.extractFromTrajectory(traj);

    const lowAnomalyNames = collectAnomalyNames(lowMetrics);
    const mediumAnomalyNames = collectAnomalyNames(mediumMetrics);

    // low 只检测到"工具延迟"这一项严重异常
    expect(lowAnomalyNames).toContain('工具延迟');
    expect(lowAnomalyNames).toHaveLength(1);

    // low 不应检测到"记忆膨胀率"（轻微越界）
    expect(lowAnomalyNames).not.toContain('记忆膨胀率');

    // medium 能同时检测到两项
    expect(mediumAnomalyNames).toContain('工具延迟');
    expect(mediumAnomalyNames).toContain('记忆膨胀率');
    expect(mediumAnomalyNames.length).toBeGreaterThan(lowAnomalyNames.length);
  });
});
