// src/evaluation/evaluation-framework.ts
// Phase 49 Task 5.2：评估集框架
//
// 知识库原文：
//   "评估集是生产化的灵魂——没有评估集就不叫工程化。
//    95% 的 AI 工程师能做原型，能上生产的 5% 才拿高薪。"
//   "评估集三层：Smoke set / Regression set / Comprehensive set。"
//   "LLM-as-Judge 五大陷阱：位置偏差/长度偏差/自我偏好/风格偏差/缺少 ground truth。"
//
// RouteDev 缩小规模（非 SaaS 平台）：
//   - Smoke(10)：Skill 安装/更新时运行，2 分钟出结果
//   - Regression(30)：/goal 完成后运行，防退化
//
// LLM-as-Judge 五大陷阱及解法（知识库）：
//   1. 位置偏差（Position Bias）——解法：随机打乱用例顺序 + 双向对照
//   2. 长度偏差（Length Bias）——解法：Rubric 明确"长度不作为评分依据"
//   3. 自我偏好（Self-Preference）——解法：跨模型评审（judge 模型 ≠ 被评估模型）
//   4. 风格偏差（Style Bias）——解法：多维度 Rubric（不单看"写得顺不顺"）
//   5. 缺少 ground truth——解法：标注 expectedBehavior 参考案例
//
// 陷阱 #149：评估集的 LLM-as-Judge 可能因模型升级而失效——
//   评估报告必须记录 modelVersion，模型升级后需重新校准 Rubric。

import { logger } from '../utils/logger.js';
// Phase 52 Task 2/7 深度接入：CalibratedScorecard + SaturationMonitor
import {
  buildCalibratedScorecard,
  type CalibratedScorecard,
  type DefectDetectionConfig,
} from './process-defect-ontology.js';
import {
  SaturationMonitor,
  type EvaluationRunResult,
  type SaturationMonitorConfig,
  type SaturationReport,
} from './saturation-monitor.js';

// ============================================================
// 类型定义
// ============================================================

/** 场景类型 */
export type EvaluationScenario = 'normal' | 'boundary' | 'adversarial';

/** 评估目标类型 */
export type EvaluationTarget = 'skill' | 'goal';

/** Rubric 评分项 */
export interface RubricItem {
  /** 评分维度名称（如"正确性""边界处理""安全性"） */
  criterion: string;
  /** 权重（>0，最终分数按加权平均） */
  weight: number;
}

/** 评估用例（按蓝图 5.2） */
export interface EvaluationCase {
  /** 用例 ID（唯一） */
  id: string;
  /** 测试输入 */
  input: string;
  /** 期望行为描述（不是精确输出，而是行为约束） */
  expectedBehavior: string;
  /** 场景类型 */
  scenario: EvaluationScenario;
  /** Rubric 评分标准 */
  rubric: RubricItem[];
}

/** 单个 Rubric 维度的评分结果 */
export interface RubricScore {
  /** 评分维度名称 */
  criterion: string;
  /** 该维度的权重（来自 RubricItem） */
  weight: number;
  /** 该维度的得分（0-1） */
  score: number;
}

/** 单条用例的评估结果 */
export interface CaseResult {
  /** 用例 ID */
  caseId: string;
  /** 是否通过（综合 Rubric 加权得分 >= passThreshold 视为通过） */
  passed: boolean;
  /** 综合加权得分（0-1） */
  score: number;
  /** LLM-as-Judge 给出的评判理由 */
  reasoning: string;
  /** 被评估目标的实际输出 */
  actualOutput: string;
  /** 各 Rubric 维度的得分明细 */
  rubricScores: RubricScore[];
}

/** 评估报告 */
export interface EvaluationReport {
  /** 评估目标类型（'skill' 或 'goal'） */
  target: EvaluationTarget;
  /** 评估目标 ID（Skill 名或 goal ID） */
  targetId: string;
  /** 总用例数 */
  totalCases: number;
  /** 通过数 */
  passed: number;
  /** 失败数 */
  failed: number;
  /** 各用例的明细结果（按打乱后的执行顺序） */
  results: CaseResult[];
  /** 全局 Rubric 聚合得分（按维度求平均） */
  rubricScores: RubricScore[];
  /** 评估使用的 Judge 模型版本（陷阱 #149：必须记录） */
  modelVersion: string;
  /** 评估时间戳（ISO 字符串） */
  timestamp: string;
  /**
   * Phase 52 Task 2 深度接入：过程级校准评分卡（可选）。
   * 由 setProcessDefectIntegration 注入配置后，runEvaluation 完成后自动产出。
   * 未注入时为 undefined，向后兼容。
   */
  calibratedScorecard?: CalibratedScorecard;
  /**
   * Phase 52 Task 7 深度接入：评估集饱和度报告（可选）。
   * 由 setSaturationMonitor 注入监测器和历史数据后，runEvaluation 完成后自动产出。
   * 未注入时为 undefined，向后兼容。
   */
  saturationReport?: SaturationReport;
}

/** LLM-as-Judge 对单个用例的评判结果（依赖注入返回值） */
export interface JudgeResult {
  /** 是否通过 */
  passed: boolean;
  /** 综合得分（0-1） */
  score: number;
  /** 评判理由 */
  reasoning: string;
  /** 各 Rubric 维度的得分明细 */
  rubricScores: RubricScore[];
}

/** 执行被评估目标的回调（依赖注入） */
export type ExecuteTargetCallback = (
  input: string,
  target: EvaluationTarget,
  targetId: string,
) => Promise<string>;

/** LLM-as-Judge 回调（依赖注入，便于测试 mock） */
export type JudgeCallback = (
  testCase: EvaluationCase,
  actualOutput: string,
) => Promise<JudgeResult>;

// ============================================================
// 评估集规模常量（RouteDev 缩小版，蓝图 5.1）
// ============================================================

/** 单个评估集的配置 */
export interface EvaluationSetConfig {
  /** 用例数 */
  size: number;
  /** 触发时机 */
  trigger: 'skill-install' | 'goal-complete';
  /** 超时（毫秒） */
  timeoutMs: number;
}

/**
 * 评估集规模配置（RouteDev 缩小版）
 *
 * 知识库原版三层：Smoke(30) / Regression(100) / Comprehensive(500)
 * RouteDev 不是 SaaS，缩小为：Smoke(10) / Regression(30)
 */
export const EVALUATION_SETS: Record<'smoke' | 'regression', EvaluationSetConfig> = {
  /** Smoke set：Skill 安装/更新时运行，2 分钟出结果 */
  smoke: {
    size: 10,
    trigger: 'skill-install',
    timeoutMs: 120_000,
  },
  /** Regression set：/goal 完成后运行，防退化 */
  regression: {
    size: 30,
    trigger: 'goal-complete',
    timeoutMs: 600_000,
  },
};

// ============================================================
// EvaluationFramework
// ============================================================

/**
 * 评估集框架
 *
 * 流程（蓝图 5.2）：
 *   1. 随机打乱用例顺序（避免位置偏差——LLM-as-Judge 陷阱 #1）
 *   2. 对每个用例运行目标（Skill 或 /goal）——通过 executeTarget 回调
 *   3. 用 LLM-as-Judge 评分（跨模型，避免自我偏好——陷阱 #3）
 *   4. 按 Rubric 多维度评分（避免风格偏差——陷阱 #4）
 *   5. 生成报告（含 modelVersion——陷阱 #149）
 *
 * 通过依赖注入接收 executeTarget 和 judge 回调：
 *   - 便于单元测试 mock
 *   - 生产环境可注入真实 LLM 客户端
 *   - judge 回调应由"与被评估目标不同的模型"承担（避免自我偏好）
 */
export class EvaluationFramework {
  /** 执行被评估目标的回调（依赖注入） */
  private readonly executeTarget: ExecuteTargetCallback;
  /** LLM-as-Judge 回调（依赖注入） */
  private readonly judge: JudgeCallback;
  /** Judge 模型版本（陷阱 #149：必须记录到报告） */
  private readonly modelVersion: string;
  /** 通过阈值：综合加权得分 >= 此值视为通过 */
  private readonly passThreshold: number;
  /**
   * Phase 52 Task 2 深度接入：过程级缺陷评估配置（可选）。
   * 由 setProcessDefectIntegration 注入；未注入时 runEvaluation 不产出 calibratedScorecard。
   */
  private processDefectConfig?: { enabled: boolean; config: DefectDetectionConfig };
  /**
   * Phase 52 Task 7 深度接入：评估集饱和监测器（可选）。
   * 由 setSaturationMonitor 注入；未注入时 runEvaluation 不产出 saturationReport。
   */
  private saturationMonitor?: SaturationMonitor;
  /**
   * Phase 52 Task 7 深度接入：历史评估运行结果（可选）。
   * 由调用方维护并注入；runEvaluation 完成后会向其追加本次运行结果（mutate）。
   */
  private historicalRunResults?: EvaluationRunResult[];
  /** Phase 52 Task 7 深度接入：饱和监测配置 */
  private saturationMonitorConfig?: SaturationMonitorConfig;

  /**
   * @param executeTarget 执行被评估目标的回调
   * @param judge LLM-as-Judge 回调（应由与被评估目标不同的模型承担）
   * @param modelVersion Judge 模型版本标识（写入报告，便于模型升级后重新校准）
   * @param passThreshold 通过阈值，默认 0.7
   */
  constructor(
    executeTarget: ExecuteTargetCallback,
    judge: JudgeCallback,
    modelVersion: string,
    passThreshold: number = 0.7,
  ) {
    this.executeTarget = executeTarget;
    this.judge = judge;
    this.modelVersion = modelVersion;
    this.passThreshold = passThreshold;
  }

  /**
   * Phase 52 Task 2 深度接入：注入过程级缺陷评估配置
   *
   * 注入后，runEvaluation 完成时会调用 buildCalibratedScorecard 产出过程级评分卡，
   * 挂到 report.calibratedScorecard 字段；未注入时该字段为 undefined（向后兼容）。
   *
   * @param enabled       是否启用（通常由 config.phase52Integration.processEvaluation.enabled 决定）
   * @param defectConfig  缺陷检测配置（灵敏度 + 控制保持度阈值）
   */
  setProcessDefectIntegration(enabled: boolean, defectConfig: DefectDetectionConfig): void {
    this.processDefectConfig = enabled ? { enabled: true, config: defectConfig } : undefined;
  }

  /**
   * Phase 52 Task 7 深度接入：注入饱和监测器与历史结果
   *
   * 注入后，runEvaluation 完成时会：
   *   1. 把本次运行结果（含通过/失败数、用例得分、耗时）追加到 historicalRunResults
   *   2. 调用 saturationMonitor.evaluate(historicalRunResults, config) 产出饱和度报告
   *   3. 把报告挂到 report.saturationReport 字段
   *
   * 未注入时 report.saturationReport 为 undefined（向后兼容）。
   *
   * @param monitor           饱和监测器实例
   * @param historicalResults 历史运行结果数组（由调用方持有，会被 mutate 追加新结果）
   * @param config            饱和监测配置
   */
  setSaturationMonitor(
    monitor: SaturationMonitor,
    historicalResults: EvaluationRunResult[],
    config: SaturationMonitorConfig,
  ): void {
    this.saturationMonitor = monitor;
    this.historicalRunResults = historicalResults;
    this.saturationMonitorConfig = config;
  }

  /**
   * 运行评估集
   *
   * @param cases 评估用例列表
   * @param target 评估目标类型（'skill' 或 'goal'）
   * @param targetId 评估目标 ID
   * @returns 评估报告
   */
  async runEvaluation(
    cases: EvaluationCase[],
    target: EvaluationTarget,
    targetId: string,
  ): Promise<EvaluationReport> {
    // 1. 随机打乱用例顺序（避免位置偏差——LLM-as-Judge 陷阱 #1）
    const shuffled = this.shuffle([...cases]);

    logger.info('EvaluationFramework: 开始评估', {
      target,
      targetId,
      totalCases: shuffled.length,
      modelVersion: this.modelVersion,
    });

    // 2. 逐个用例：运行目标 → LLM-as-Judge 评分
    const results: CaseResult[] = [];
    for (const testCase of shuffled) {
      const actualOutput = await this.executeTarget(testCase.input, target, targetId);
      const judgeResult = await this.judge(testCase, actualOutput);

      results.push({
        caseId: testCase.id,
        passed: judgeResult.passed,
        score: judgeResult.score,
        reasoning: judgeResult.reasoning,
        actualOutput,
        rubricScores: judgeResult.rubricScores,
      });
    }

    // 3. 统计通过/失败
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;

    // 4. 聚合全局 Rubric 得分（按维度求平均）
    const rubricScores = this.aggregateRubricScores(results);

    // 5. 生成报告（含 modelVersion——陷阱 #149）
    const report: EvaluationReport = {
      target,
      targetId,
      totalCases: results.length,
      passed,
      failed,
      results,
      rubricScores,
      modelVersion: this.modelVersion,
      timestamp: new Date().toISOString(),
    };

    logger.info('EvaluationFramework: 评估完成', {
      target,
      targetId,
      passed,
      failed,
      totalCases: results.length,
    });

    // Phase 52 Task 2 深度接入：产出过程级校准评分卡
    // config 守护：未注入 processDefectConfig 时跳过；try/catch 降级：评分卡生成失败不崩溃主流程
    if (this.processDefectConfig?.enabled) {
      try {
        // 把 CaseResult 转换为 buildCalibratedScorecard 所需的 executionLog 格式
        // 失败用例的 reasoning 作为 error 文本（用于关键词匹配缺陷类型）；
        // actualOutput 始终作为 output 文本（成功用例也可能含潜在缺陷线索）
        const executionLog = results.map((r, idx) => ({
          stepIndex: idx,
          error: r.passed ? '' : r.reasoning,
          output: r.actualOutput,
        }));
        const outcomePassed = failed === 0; // 所有用例通过才算整体 outcome passed
        report.calibratedScorecard = buildCalibratedScorecard(
          executionLog,
          outcomePassed,
          this.processDefectConfig.config,
        );
        logger.debug('EvaluationFramework: calibratedScorecard 已生成', {
          processGrade: report.calibratedScorecard.processGrade,
          overallRisk: report.calibratedScorecard.overallRisk,
          defectCount: report.calibratedScorecard.defects.length,
        });
      } catch (err) {
        logger.warn('EvaluationFramework: buildCalibratedScorecard 失败 (non-blocking)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 52 Task 7 深度接入：饱和度监测
    // config 守护：未注入 saturationMonitor 时跳过；try/catch 降级：饱和评估失败不崩溃主流程
    if (
      this.saturationMonitor &&
      this.historicalRunResults &&
      this.saturationMonitorConfig
    ) {
      try {
        // 把本次运行结果追加到历史记录（mutate historicalRunResults）
        const currentRun: EvaluationRunResult = {
          runId: `${targetId}-${Date.now()}`,
          timestamp: Date.now(),
          modelId: this.modelVersion,
          totalCases: results.length,
          passedCases: passed,
          failedCases: failed,
          caseScores: results.map((r) => r.score),
          durationMs: Date.now() - new Date(report.timestamp).getTime(),
        };
        this.historicalRunResults.push(currentRun);
        // I-8 修复：无界集合淘汰，避免历史记录无限增长
        // 保留最近 200 条（远超 saturationMonitorConfig.checkInterval 默认 10）
        if (this.historicalRunResults.length > 200) {
          this.historicalRunResults.shift();
        }
        report.saturationReport = this.saturationMonitor.evaluate(
          this.historicalRunResults,
          this.saturationMonitorConfig,
        );
        logger.debug('EvaluationFramework: saturationReport 已生成', {
          status: report.saturationReport.status,
          discrimination: report.saturationReport.discrimination,
          passRate: report.saturationReport.passRate,
        });
      } catch (err) {
        logger.warn('EvaluationFramework: saturationMonitor.evaluate 失败 (non-blocking)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return report;
  }

  /**
   * 聚合各 Rubric 维度的得分（按维度对所有用例求平均）
   *
   * 用于报告的 rubricScores 字段，反映目标在各个维度上的整体表现
   */
  private aggregateRubricScores(results: CaseResult[]): RubricScore[] {
    if (results.length === 0) return [];

    // 用第一个用例的 rubricScores 作为维度列表（假设所有用例 Rubric 维度一致）
    const dimensions = results[0].rubricScores;
    if (!dimensions || dimensions.length === 0) return [];

    return dimensions.map((dim, idx) => {
      // 对所有用例的第 idx 个维度求平均
      const sum = results.reduce((acc, r) => {
        const score = r.rubricScores[idx]?.score ?? 0;
        return acc + score;
      }, 0);
      return {
        criterion: dim.criterion,
        weight: dim.weight,
        score: sum / results.length,
      };
    });
  }

  /**
   * Fisher-Yates 洗牌——随机打乱数组顺序
   *
   * 用于避免位置偏差（LLM-as-Judge 陷阱 #1）
   * 不修改原数组（已在外部拷贝）
   */
  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** 获取 Judge 模型版本 */
  getModelVersion(): string {
    return this.modelVersion;
  }
}
