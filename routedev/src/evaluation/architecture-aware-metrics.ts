// src/evaluation/architecture-aware-metrics.ts
// Phase 52 Task 6：架构感知评估指标
//
// 知识库来源：Architecture-Aware Evaluation Metrics 论文。
// 核心思想：评估指标不应是全局扁平的，而要绑定到系统的具体架构组件，
//           按组件维度提取指标、识别异常、生成诊断报告。
//
// RouteDev 的 6 个架构组件：
//   1. router         —— 路由层（模型选择 / 降级 / 延迟）
//   2. planner        —— 规划层（步骤数合理性 / 耗时 / 覆盖率）
//   3. memory         —— 记忆层（命中率 / 膨胀率 / 过期比例）
//   4. tool_executor  —— 工具执行层（成功率 / 误用率 / 延迟）
//   5. skill_flow     —— 技能流（节点跳过 / 循环 / 用户介入）
//   6. dual_loop      —— 双循环（重跑 / 申诉 / 审查阻断）
//
// 异常敏感度三档：
//   - low    只标记严重超出 expectedRange 50% 的指标
//   - medium 标记任何超出 expectedRange 的指标
//   - high   标记接近 expectedRange 边界（90%）的指标（最敏感）

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 架构组件枚举（绑定到 RouteDev 的 6 个核心组件） */
export type ArchComponent = 'router' | 'planner' | 'memory' | 'tool_executor' | 'skill_flow' | 'dual_loop';

/** 单条指标项 */
export interface MetricEntry {
  /** 指标名称（中文） */
  name: string;
  /** 指标值 */
  value: number;
  /** 单位（如 'ratio' / 'ms' / 'count' / 'score' / 'entries'） */
  unit: string;
  /** 期望范围（用于异常判定） */
  expectedRange: { min: number; max: number };
  /** 是否为异常 */
  isAnomaly: boolean;
}

/** 组件级指标集合 */
export interface ComponentMetrics {
  /** 所属架构组件 */
  component: ArchComponent;
  /** 该组件的指标列表 */
  metrics: MetricEntry[];
}

/** 执行轨迹输入（从一次 Agent 运行中采集的原始事件） */
export interface TrajectoryInput {
  /** 路由决策事件 */
  routerDecisions: Array<{ modelId: string; tier: string; latencyMs: number; degraded: boolean }>;
  /** 规划步骤事件 */
  plannerSteps: Array<{ stepId: string; planningMs: number; stepCount: number }>;
  /** 记忆访问事件 */
  memoryAccesses: Array<{ hit: boolean; age: number; size: number }>;
  /** 工具调用事件 */
  toolCalls: Array<{ toolName: string; success: boolean; latencyMs: number; isError: boolean }>;
  /** 技能流事件 */
  skillFlowEvents: Array<{ nodeType: string; skipped: boolean; userIntervened: boolean; loopCount: number }>;
  /** 双循环事件 */
  dualLoopEvents: Array<{ rerun: boolean; appealed: boolean; blocked: boolean }>;
}

/** 异常敏感度 */
export type AnomalySensitivity = 'low' | 'medium' | 'high';

// ============================================================
// 组件中文标签（用于诊断报告）
// ============================================================

const COMPONENT_LABELS: Record<ArchComponent, string> = {
  router: '路由组件',
  planner: '规划组件',
  memory: '记忆组件',
  tool_executor: '工具执行组件',
  skill_flow: '技能流组件',
  dual_loop: '双循环组件',
};

/**
 * “值越低越坏”的指标集合（命中率/成功率/准确率/质量/覆盖率类）
 * 这类指标异常方向是下边界（值过低才算异常）
 */
const LOW_BAD_METRICS = new Set([
  '路由准确率',
  '规划质量',
  '步骤覆盖率',
  '记忆命中率',
  '工具成功率',
]);

// ============================================================
// ArchitectureAwareMetricsCollector
// ============================================================

/**
 * 架构感知评估指标采集器
 *
 * 用法：
 *   const collector = new ArchitectureAwareMetricsCollector('medium');
 *   const metrics = collector.extractFromTrajectory(trajectory);
 *   const anomalies = collector.identifyAnomalies(metrics);
 *   const report = collector.generateDiagnosticReport(metrics);
 */
export class ArchitectureAwareMetricsCollector {
  /** 异常敏感度（low / medium / high） */
  private readonly anomalySensitivity: AnomalySensitivity;

  /** 记忆过期阈值（age 超过此值视为过期，单位与输入 age 一致） */
  private readonly memoryStaleThreshold: number;

  constructor(
    anomalySensitivity: AnomalySensitivity = 'medium',
    memoryStaleThreshold: number = 7,
  ) {
    this.anomalySensitivity = anomalySensitivity;
    this.memoryStaleThreshold = memoryStaleThreshold;
  }

  /** 获取当前异常敏感度 */
  getAnomalySensitivity(): AnomalySensitivity {
    return this.anomalySensitivity;
  }

  // ============================================================
  // 1. 从执行轨迹提取 6 个组件的指标
  // ============================================================

  /**
   * 从执行轨迹提取 6 个架构组件的指标
   *
   * @param trajectory 执行轨迹输入
   * @returns 6 个组件的指标列表（顺序固定：router → planner → memory → tool_executor → skill_flow → dual_loop）
   */
  extractFromTrajectory(trajectory: TrajectoryInput): ComponentMetrics[] {
    const result: ComponentMetrics[] = [
      this.extractRouterMetrics(trajectory.routerDecisions ?? []),
      this.extractPlannerMetrics(trajectory.plannerSteps ?? []),
      this.extractMemoryMetrics(trajectory.memoryAccesses ?? []),
      this.extractToolExecutorMetrics(trajectory.toolCalls ?? []),
      this.extractSkillFlowMetrics(trajectory.skillFlowEvents ?? []),
      this.extractDualLoopMetrics(trajectory.dualLoopEvents ?? []),
    ];

    logger.info('ArchitectureAwareMetricsCollector: 指标提取完成', {
      sensitivity: this.anomalySensitivity,
      components: result.length,
      anomalies: result.reduce(
        (acc, c) => acc + c.metrics.filter(m => m.isAnomaly).length,
        0,
      ),
    });

    return result;
  }

  // ============================================================
  // 2. 生成组件级诊断报告
  // ============================================================

  /**
   * 生成组件级诊断报告（中文，含异常标记）
   *
   * @param metrics 组件指标列表
   * @returns 多行诊断报告字符串
   */
  generateDiagnosticReport(metrics: ComponentMetrics[]): string {
    const lines: string[] = [];
    lines.push('=== 架构感知评估诊断报告 ===');
    lines.push(`异常敏感度: ${this.anomalySensitivity}`);
    lines.push(`生成时间: ${new Date().toISOString()}`);
    lines.push('');

    let totalMetrics = 0;
    let totalAnomalies = 0;
    let anomalousComponents = 0;

    for (const cm of metrics) {
      const label = COMPONENT_LABELS[cm.component] ?? cm.component;
      const anomalyCount = cm.metrics.filter(m => m.isAnomaly).length;
      if (anomalyCount > 0) anomalousComponents++;

      lines.push(`[${cm.component}] ${label}（${cm.metrics.length} 项指标，${anomalyCount} 项异常）`);

      for (const m of cm.metrics) {
        const rangeStr = `${this.fmt(m.expectedRange.min)}~${this.fmt(m.expectedRange.max)}`;
        const marker = m.isAnomaly ? '[异常]' : '[正常]';
        lines.push(
          `  - ${m.name}: ${this.fmt(m.value)}${m.unit}（期望 ${rangeStr}${m.unit}）${marker}`,
        );
        totalMetrics++;
        if (m.isAnomaly) totalAnomalies++;
      }
      lines.push('');
    }

    lines.push('--- 汇总 ---');
    lines.push(`异常组件: ${anomalousComponents}/${metrics.length}`);
    lines.push(`异常指标: ${totalAnomalies}/${totalMetrics}`);

    return lines.join('\n');
  }

  // ============================================================
  // 3. 识别异常组件
  // ============================================================

  /**
   * 识别异常组件（返回含有 isAnomaly=true 指标的组件）
   *
   * @param metrics 全量组件指标
   * @returns 仅包含有异常指标的组件（保留各组件完整 metrics 数组）
   */
  identifyAnomalies(metrics: ComponentMetrics[]): ComponentMetrics[] {
    return metrics
      .filter(cm => cm.metrics.some(m => m.isAnomaly))
      .map(cm => ({
        component: cm.component,
        metrics: cm.metrics,
      }));
  }

  // ============================================================
  // 私有：各组件指标提取
  // ============================================================

  /** router：路由准确率 / 路由延迟 / 模型选择成本比 */
  private extractRouterMetrics(
    decisions: TrajectoryInput['routerDecisions'],
  ): ComponentMetrics {
    const total = decisions.length;

    // 路由准确率 = 1 - degraded 比例（无数据视为 1.0，不产生异常）
    const degradedRatio = total > 0
      ? decisions.filter(d => d.degraded).length / total
      : 0;
    const accuracy = total > 0 ? 1 - degradedRatio : 1.0;

    // 路由延迟（平均 latencyMs）
    const latency = total > 0
      ? decisions.reduce((s, d) => s + d.latencyMs, 0) / total
      : 0;

    // 模型选择成本比：高成本 tier（complex / reasoning）占比
    const highCostTiers = ['complex', 'reasoning'];
    const costRatio = total > 0
      ? decisions.filter(d => highCostTiers.includes(d.tier)).length / total
      : 0;

    const metrics: MetricEntry[] = [
      {
        name: '路由准确率',
        value: this.round(accuracy),
        unit: 'ratio',
        expectedRange: { min: 0.85, max: 1.0 },
        isAnomaly: false,
      },
      {
        name: '路由延迟',
        value: this.round(latency),
        unit: 'ms',
        expectedRange: { min: 0, max: 500 },
        isAnomaly: false,
      },
      {
        name: '模型选择成本比',
        value: this.round(costRatio),
        unit: 'ratio',
        expectedRange: { min: 0, max: 0.3 },
        isAnomaly: false,
      },
    ];

    return this.markAnomalies('router', metrics);
  }

  /** planner：规划质量 / 规划耗时 / 步骤覆盖率 */
  private extractPlannerMetrics(
    steps: TrajectoryInput['plannerSteps'],
  ): ComponentMetrics {
    const total = steps.length;

    // 规划质量：按 stepCount 合理性打分后取平均
    //   stepCount 在 [1, 8] → 1.0（合理）
    //   stepCount 在 [9, 15] → 0.5（偏多）
    //   stepCount > 15 或 <= 0 → 0.0（不合理）
    const qualities = steps.map(s => {
      if (s.stepCount >= 1 && s.stepCount <= 8) return 1.0;
      if (s.stepCount >= 9 && s.stepCount <= 15) return 0.5;
      return 0.0;
    });
    const quality = total > 0
      ? qualities.reduce((a: number, b: number) => a + b, 0) / total
      : 1.0;

    // 规划耗时（平均 planningMs）
    const planningMs = total > 0
      ? steps.reduce((s, x) => s + x.planningMs, 0) / total
      : 0;

    // 步骤覆盖率：stepCount > 0 的规划占比
    const coverage = total > 0
      ? steps.filter(s => s.stepCount > 0).length / total
      : 1.0;

    const metrics: MetricEntry[] = [
      {
        name: '规划质量',
        value: this.round(quality),
        unit: 'score',
        expectedRange: { min: 0.6, max: 1.0 },
        isAnomaly: false,
      },
      {
        name: '规划耗时',
        value: this.round(planningMs),
        unit: 'ms',
        expectedRange: { min: 0, max: 1000 },
        isAnomaly: false,
      },
      {
        name: '步骤覆盖率',
        value: this.round(coverage),
        unit: 'ratio',
        expectedRange: { min: 0.8, max: 1.0 },
        isAnomaly: false,
      },
    ];

    return this.markAnomalies('planner', metrics);
  }

  /** memory：记忆命中率 / 记忆膨胀率 / 过期记忆比例 */
  private extractMemoryMetrics(
    accesses: TrajectoryInput['memoryAccesses'],
  ): ComponentMetrics {
    const total = accesses.length;

    // 记忆命中率
    const hitRate = total > 0
      ? accesses.filter(a => a.hit).length / total
      : 1.0;

    // 记忆膨胀率（size 平均值）
    const avgSize = total > 0
      ? accesses.reduce((s, a) => s + a.size, 0) / total
      : 0;

    // 过期记忆比例（age 超过阈值）
    const staleRatio = total > 0
      ? accesses.filter(a => a.age > this.memoryStaleThreshold).length / total
      : 0;

    const metrics: MetricEntry[] = [
      {
        name: '记忆命中率',
        value: this.round(hitRate),
        unit: 'ratio',
        expectedRange: { min: 0.6, max: 1.0 },
        isAnomaly: false,
      },
      {
        name: '记忆膨胀率',
        value: this.round(avgSize),
        unit: 'entries',
        expectedRange: { min: 0, max: 1000 },
        isAnomaly: false,
      },
      {
        name: '过期记忆比例',
        value: this.round(staleRatio),
        unit: 'ratio',
        expectedRange: { min: 0, max: 0.2 },
        isAnomaly: false,
      },
    ];

    return this.markAnomalies('memory', metrics);
  }

  /** tool_executor：工具成功率 / 工具误用率 / 工具延迟 */
  private extractToolExecutorMetrics(
    calls: TrajectoryInput['toolCalls'],
  ): ComponentMetrics {
    const total = calls.length;

    // 工具成功率
    const successRate = total > 0
      ? calls.filter(c => c.success).length / total
      : 1.0;

    // 工具误用率（isError 比例）
    const misuseRate = total > 0
      ? calls.filter(c => c.isError).length / total
      : 0;

    // 工具延迟（平均 latencyMs）
    const latency = total > 0
      ? calls.reduce((s, c) => s + c.latencyMs, 0) / total
      : 0;

    const metrics: MetricEntry[] = [
      {
        name: '工具成功率',
        value: this.round(successRate),
        unit: 'ratio',
        expectedRange: { min: 0.9, max: 1.0 },
        isAnomaly: false,
      },
      {
        name: '工具误用率',
        value: this.round(misuseRate),
        unit: 'ratio',
        expectedRange: { min: 0, max: 0.05 },
        isAnomaly: false,
      },
      {
        name: '工具延迟',
        value: this.round(latency),
        unit: 'ms',
        expectedRange: { min: 0, max: 2000 },
        isAnomaly: false,
      },
    ];

    return this.markAnomalies('tool_executor', metrics);
  }

  /** skill_flow：节点跳过率 / 循环节点次数 / 用户介入率 */
  private extractSkillFlowMetrics(
    events: TrajectoryInput['skillFlowEvents'],
  ): ComponentMetrics {
    const total = events.length;

    // 节点跳过率
    const skipRate = total > 0
      ? events.filter(e => e.skipped).length / total
      : 0;

    // 循环节点次数（loopCount 总和）
    const loopCount = events.reduce((s, e) => s + e.loopCount, 0);

    // 用户介入率
    const interventionRate = total > 0
      ? events.filter(e => e.userIntervened).length / total
      : 0;

    const metrics: MetricEntry[] = [
      {
        name: '节点跳过率',
        value: this.round(skipRate),
        unit: 'ratio',
        expectedRange: { min: 0, max: 0.2 },
        isAnomaly: false,
      },
      {
        name: '循环节点次数',
        value: this.round(loopCount),
        unit: 'count',
        expectedRange: { min: 0, max: 5 },
        isAnomaly: false,
      },
      {
        name: '用户介入率',
        value: this.round(interventionRate),
        unit: 'ratio',
        expectedRange: { min: 0, max: 0.1 },
        isAnomaly: false,
      },
    ];

    return this.markAnomalies('skill_flow', metrics);
  }

  /** dual_loop：重跑率 / 申诉率 / 审查阻断率 */
  private extractDualLoopMetrics(
    events: TrajectoryInput['dualLoopEvents'],
  ): ComponentMetrics {
    const total = events.length;

    const rerunRate = total > 0
      ? events.filter(e => e.rerun).length / total
      : 0;
    const appealRate = total > 0
      ? events.filter(e => e.appealed).length / total
      : 0;
    const blockRate = total > 0
      ? events.filter(e => e.blocked).length / total
      : 0;

    const metrics: MetricEntry[] = [
      {
        name: '重跑率',
        value: this.round(rerunRate),
        unit: 'ratio',
        expectedRange: { min: 0, max: 0.2 },
        isAnomaly: false,
      },
      {
        name: '申诉率',
        value: this.round(appealRate),
        unit: 'ratio',
        expectedRange: { min: 0, max: 0.15 },
        isAnomaly: false,
      },
      {
        name: '审查阻断率',
        value: this.round(blockRate),
        unit: 'ratio',
        expectedRange: { min: 0, max: 0.1 },
        isAnomaly: false,
      },
    ];

    return this.markAnomalies('dual_loop', metrics);
  }

  // ============================================================
  // 私有：异常标记与数值工具
  // ============================================================

  /**
   * 根据当前敏感度为指标列表标记 isAnomaly 字段
   *
   * @param component 所属架构组件（由 extract 方法显式传入）
   * @param metrics 待标记的指标列表
   */
  private markAnomalies(component: ArchComponent, metrics: MetricEntry[]): ComponentMetrics {
    const marked: MetricEntry[] = metrics.map(m => ({
      ...m,
      isAnomaly: this.isValueAnomaly(m.name, m.value, m.expectedRange),
    }));
    return { component, metrics: marked };
  }

  /**
   * 判定单个指标值是否为异常
   *
   * 三档敏感度（r = max - min 为期望范围宽度）：
   *   - low    值越界 50% 以上才算异常（最宽松）
   *   - medium 值越界即异常
   *   - high   值接近边界（90%，即距边界 10% 范围内）即异常（最敏感）
   *
   * 异常方向由指标语义决定：
   *   - LOW_BAD_METRICS（成功率/命中率/准确率/质量/覆盖率）：值越低越坏，关注下边界
   *   - 其他指标（延迟/误用率/各类比例）：值越高越坏，关注上边界
   */
  private isValueAnomaly(
    name: string,
    value: number,
    range: { min: number; max: number },
  ): boolean {
    const r = range.max - range.min;
    const lowIsBad = LOW_BAD_METRICS.has(name);

    // 范围宽度为 0 的退化情况：按越界处理
    if (r <= 0) {
      return value > range.max || value < range.min;
    }

    switch (this.anomalySensitivity) {
      case 'low': {
        // 只标记超出 expectedRange 50% 的
        if (lowIsBad) {
          return value < range.min - 0.5 * r;
        }
        return value > range.max + 0.5 * r;
      }
      case 'high': {
        // 标记接近 expectedRange 边界的（90%）
        if (lowIsBad) {
          return value <= range.min + 0.1 * r;
        }
        return value >= range.max - 0.1 * r;
      }
      case 'medium':
      default: {
        // 标记超出 expectedRange 的
        if (lowIsBad) {
          return value < range.min;
        }
        return value > range.max;
      }
    }
  }

  /** 四舍五入到 4 位小数（避免浮点精度问题） */
  private round(v: number): number {
    return Math.round(v * 10000) / 10000;
  }

  /** 数值格式化（用于报告展示） */
  private fmt(v: number): string {
    return this.round(v).toString();
  }
}
