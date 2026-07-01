// src/evaluation/saturation-monitor.ts
// Phase 52 Task 7：评估集饱和监测
//
// 知识库原文（Benchmark Saturation 论文）：
//   "评估集的区分度会随模型升级而下降——当模型在评估集上的得分接近天花板时，
//    评估集就不再具备区分能力，需要及时更新或替换。"
//
// 核心信号：
//   1. 通过率（passRate）：过高说明评估集对当前模型已无挑战性
//   2. 得分方差（scoreVariance）：过低说明用例间无差异，区分度差
//   3. 区分度（discrimination）：综合通过率与方差计算的指标，越低越饱和
//
// 三档状态：
//   - healthy：评估集区分度良好，可继续使用
//   - aging：开始老化，建议新增困难用例或淘汰过简用例
//   - saturated：完全饱和，必须替换评估集
//
// 四档建议：
//   - none：无需操作
//   - add_difficult_cases：新增困难用例（多步推理/工具组合/长上下文/错误恢复等）
//   - retire_easy_cases：淘汰过简用例（单工具调用/短上下文/无分支等）
//   - replace_evaluation：整体替换评估集

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/** 评估集饱和状态 */
export type SaturationStatus = 'healthy' | 'aging' | 'saturated';

/** 饱和后的建议操作 */
export type SaturationRecommendation =
  | 'none'
  | 'add_difficult_cases'
  | 'retire_easy_cases'
  | 'replace_evaluation';

/** 单次评估运行的聚合结果 */
export interface EvaluationRunResult {
  /** 运行 ID（唯一） */
  runId: string;
  /** 运行时间戳（ms） */
  timestamp: number;
  /** 被评估模型 ID */
  modelId: string;
  /** 总用例数 */
  totalCases: number;
  /** 通过数 */
  passedCases: number;
  /** 失败数 */
  failedCases: number;
  /** 各用例的得分（0-1） */
  caseScores: number[];
  /** 总耗时 ms */
  durationMs: number;
}

/** 饱和度分析报告 */
export interface SaturationReport {
  /** 饱和状态 */
  status: SaturationStatus;
  /** 区分度（0-1，越高越好） */
  discrimination: number;
  /** 通过率（0-1） */
  passRate: number;
  /** 得分方差 */
  scoreVariance: number;
  /** 建议操作 */
  recommendation: SaturationRecommendation;
  /** 导致饱和的因素列表（人类可读） */
  saturationFactors: string[];
  /** 分析所用的运行次数 */
  analyzedRuns: number;
}

/** evaluate 方法的配置参数 */
export interface SaturationMonitorConfig {
  /** 通过率阈值（高于此值视为高通过率，默认 0.95） */
  passRateThreshold: number;
  /** 方差阈值（低于此值视为低方差，默认 0.05） */
  varianceThreshold: number;
  /** 检查间隔：至少积累多少次运行结果才开始评估（默认 10） */
  checkInterval: number;
}

// ============================================================
// 建议的困难/过简用例类型（常量池）
// ============================================================

/** 建议新增的困难用例类型 */
const DIFFICULT_CASE_TYPES: readonly string[] = [
  '多步推理（需要 3 步以上链式推理）',
  '工具组合（多个工具按顺序协作完成）',
  '长上下文（需要跨多个文件/会话整合信息）',
  '错误恢复（工具调用失败后能自动重试或降级）',
  '边界条件（极端输入、空数据、超大文件）',
  '对抗性输入（注入尝试、误导性指令）',
  '模糊需求（需要澄清才能继续的场景）',
  '多语言混合（中英文混杂的代码或文档）',
];

/** 建议淘汰的过简用例类型 */
const EASY_CASE_TYPES: readonly string[] = [
  '单工具调用（仅调用一个工具即可完成）',
  '短上下文（输入不超过 100 token）',
  '无分支（执行路径线性，无 if/else 判断）',
  '确定性输出（输出唯一，无 LLM 创作空间）',
  '低复杂度任务（simple tier，应交给 fast 模型）',
  '已 100% 通过超过 5 次的用例',
];

// ============================================================
// SaturationMonitor
// ============================================================

/**
 * 评估集饱和监测器
 *
 * 持续监测评估集的区分度，饱和时及时更新。
 *
 * 使用方式：
 *   const monitor = new SaturationMonitor();
 *   const report = monitor.evaluate(runResults, {
 *     passRateThreshold: 0.95,
 *     varianceThreshold: 0.05,
 *     checkInterval: 10,
 *   });
 *   if (report.status === 'saturated') {
 *     const newCases = monitor.suggestDifficultCases(report);
 *     // ...新增困难用例
 *   }
 */
export class SaturationMonitor {
  /**
   * 评估饱和度
   *
   * 算法：
   *   1. 结果数 < checkInterval → healthy, none
   *   2. 计算 passRate = avg(passedCases/totalCases)
   *   3. 计算 scoreVariance = var(allCaseScores)
   *   4. 计算 discrimination = clamp(1 - passRate + scoreVariance * 10, 0, 1)
   *   5. 饱和判定（见下方注释）
   *   6. 推荐操作（见下方注释）
   *   7. 收集 saturationFactors
   *
   * @param results 历史评估运行结果列表
   * @param config 监测配置
   */
  evaluate(
    results: EvaluationRunResult[],
    config: SaturationMonitorConfig,
  ): SaturationReport {
    const { passRateThreshold, varianceThreshold, checkInterval } = config;

    // 1. 结果数不足，直接返回 healthy
    if (results.length < checkInterval) {
      logger.info('SaturationMonitor: 运行结果不足，跳过评估', {
        actual: results.length,
        required: checkInterval,
      });
      return {
        status: 'healthy',
        discrimination: 1,
        passRate: 0,
        scoreVariance: 0,
        recommendation: 'none',
        saturationFactors: [],
        analyzedRuns: results.length,
      };
    }

    // 2. 计算平均通过率
    const passRate = this.calculatePassRate(results);

    // 3. 计算得分方差（所有 run 的所有 caseScores 合并后求方差）
    const allScores = results.flatMap(r => r.caseScores);
    const scoreVariance = this.calculateVariance(allScores);

    // 4. 计算区分度
    // 通过率越低区分度越高（1 - passRate），方差越大区分度越高（variance * 10）
    // clamp 到 [0, 1]
    const discrimination = this.clamp01(1 - passRate + scoreVariance * 10);

    // 5. 饱和判定
    let status: SaturationStatus;
    if (passRate > passRateThreshold && scoreVariance < varianceThreshold) {
      status = 'saturated';
    } else if (passRate > 0.8 && scoreVariance < 0.1) {
      status = 'aging';
    } else {
      status = 'healthy';
    }

    // 6. 推荐操作
    let recommendation: SaturationRecommendation;
    if (status === 'saturated') {
      recommendation = 'replace_evaluation';
    } else if (status === 'aging') {
      if (passRate > 0.9) {
        recommendation = 'add_difficult_cases';
      } else if (scoreVariance < 0.05) {
        recommendation = 'retire_easy_cases';
      } else {
        recommendation = 'none';
      }
    } else {
      recommendation = 'none';
    }

    // 7. 收集饱和因素
    const saturationFactors = this.collectFactors({
      passRate,
      scoreVariance,
      passRateThreshold,
      varianceThreshold,
      status,
    });

    logger.info('SaturationMonitor: 评估完成', {
      status,
      recommendation,
      passRate,
      scoreVariance,
      discrimination,
      analyzedRuns: results.length,
      factors: saturationFactors.length,
    });

    return {
      status,
      discrimination,
      passRate,
      scoreVariance,
      recommendation,
      saturationFactors,
      analyzedRuns: results.length,
    };
  }

  /**
   * 建议新增的困难用例类型
   *
   * 仅在饱和或老化状态下返回建议，healthy 状态返回空数组。
   *
   * @param report 饱和度报告
   * @returns 建议的困难用例类型描述列表
   */
  suggestDifficultCases(report: SaturationReport): string[] {
    if (report.status === 'healthy') {
      return [];
    }
    // saturated 与 aging 都返回困难用例建议
    return [...DIFFICULT_CASE_TYPES];
  }

  /**
   * 建议淘汰的过简用例类型
   *
   * 仅在老化且低方差状态下返回建议，其他状态返回空数组。
   *
   * @param report 饱和度报告
   * @returns 建议淘汰的过简用例类型描述列表
   */
  suggestRetireEasyCases(report: SaturationReport): string[] {
    // 仅 aging + 低方差时返回
    if (report.status !== 'aging') {
      return [];
    }
    if (report.scoreVariance >= 0.05) {
      return [];
    }
    return [...EASY_CASE_TYPES];
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /**
   * 计算平均通过率
   *
   * passRate = avg(passedCases / totalCases)
   * 跳过 totalCases = 0 的运行（避免除零）
   */
  private calculatePassRate(results: EvaluationRunResult[]): number {
    const valid = results.filter(r => r.totalCases > 0);
    if (valid.length === 0) return 0;
    const sum = valid.reduce((acc, r) => acc + r.passedCases / r.totalCases, 0);
    return sum / valid.length;
  }

  /**
   * 计算方差（总体方差，除以 N）
   *
   * var(X) = E[(X - μ)²] = sum((x_i - μ)²) / N
   * 空数组返回 0
   */
  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sumSq = values.reduce((acc, x) => acc + (x - mean) ** 2, 0);
    return sumSq / values.length;
  }

  /**
   * 将数值限制在 [0, 1] 范围内
   */
  private clamp01(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  /**
   * 收集饱和因素（人类可读的描述）
   *
   * 列出导致饱和判定的具体因素，便于运维人员定位问题
   */
  private collectFactors(params: {
    passRate: number;
    scoreVariance: number;
    passRateThreshold: number;
    varianceThreshold: number;
    status: SaturationStatus;
  }): string[] {
    const factors: string[] = [];
    const { passRate, scoreVariance, passRateThreshold, varianceThreshold, status } = params;

    // 通过率因素
    if (passRate > passRateThreshold) {
      factors.push(`通过率 ${(passRate * 100).toFixed(1)}% > 阈值 ${(passRateThreshold * 100).toFixed(1)}%`);
    } else if (passRate > 0.8) {
      factors.push(`通过率 ${(passRate * 100).toFixed(1)}% > 80%（老化区间）`);
    }

    // 方差因素
    if (scoreVariance < varianceThreshold) {
      factors.push(`得分方差 ${scoreVariance.toFixed(4)} < 阈值 ${varianceThreshold}`);
    } else if (scoreVariance < 0.1) {
      factors.push(`得分方差 ${scoreVariance.toFixed(4)} < 0.1（老化区间）`);
    }

    // 状态因素
    if (status === 'saturated') {
      factors.push('综合判定：评估集已饱和，区分度不足以继续使用');
    } else if (status === 'aging') {
      factors.push('综合判定：评估集开始老化，建议调整用例构成');
    }

    return factors;
  }
}
