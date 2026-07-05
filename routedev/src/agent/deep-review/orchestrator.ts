// src/agent/deep-review/orchestrator.ts
// Phase 72：Deep Review 编排器——风险评分 → 串行 spawn reviewer → 聚合 → 仲裁
//
// 设计要点：
//   1. fail-open 原则：单个 reviewer 失败不阻断，标注后继续
//   2. MVP 采用串行执行保证正确性（沙箱切换不能并行）
//   3. P2 将通过 sandboxOverride 参数实现真正并行（当前 config.parallel 字段保留但不使用）
//   4. 风险评分低于阈值或功能关闭时降级（triggered=false），调用方自行 fallback

import type { SandboxLevel } from '../../tools/permission-engine.js';
import type { PermissionEngine } from '../../tools/permission-engine.js';
import type { ToolExecutorAdapter } from '../../agent/loop-config.js';
import type { ILLMClient } from '../../router/types.js';
import { logger } from '../../utils/logger.js';
import { scoreRisk } from './risk-scorer.js';
import { buildReviewerPrompt, pickModel } from './reviewer-factory.js';
import { aggregate, parseIssuesFromReport } from './aggregator.js';
import type {
  DeepReviewConfig,
  DeepReviewResult,
  ReviewFocus,
  ReviewerReport,
} from './types.js';

/**
 * 命令桥最小契约（仅 deep-review 编排器用到的部分）
 * 原 service-context.ts 已随终端 UI 层移除，此处内联最小接口避免依赖被删模块
 */
export interface CommandBridge {
  /** 向 UI 推送一条系统消息 */
  addSystemMessage: (content: string) => void;
}

/** 编排器依赖参数 */
export interface DeepReviewOrchestratorDeps {
  /** 工具执行器（用于调用 spawn_agent） */
  toolExecutor: ToolExecutorAdapter;
  /** 权限引擎（用于沙箱级切换） */
  permissionEngine?: PermissionEngine;
  /** 命令桥（用于向 UI 推送进度消息） */
  commandBridge?: CommandBridge;
  /** 可选 LLM 客户端（llm-summary 聚合模式用） */
  llmClient?: ILLMClient;
  /** Deep Review 配置 */
  config: DeepReviewConfig;
  /** 当前可用模型 id 列表（按能力降序，启发式假设） */
  availableModels?: string[];
  /** 工作目录 */
  cwd: string;
}

/** review 方法的参数 */
export interface ReviewParams {
  /** 当前 git diff 文本 */
  diff: string;
  /** 变更文件列表 */
  changedFiles: string[];
  /** 进度回调（每完成一个 reviewer 调用一次） */
  onProgress?: (completed: number, total: number, current: string) => void;
}

/** 构造空结果（未触发时返回） */
function buildEmptyResult(riskScore: number, durationMs: number): DeepReviewResult {
  return {
    reports: [],
    aggregatedIssues: [],
    arbitration: 'inconclusive',
    summary: '（未触发 Deep Review）',
    riskScore,
    triggered: false,
    durationMs,
  };
}

/**
 * Deep Review 编排器
 *
 * MVP 实现说明：
 *   - 串行执行所有 reviewer（config.parallel 字段保留供 P2 优化）
 *   - 原因：当前沙箱级切换（setSandboxLevel）通过共享 permissionEngine 状态实现，
 *     并行 spawn 会导致沙箱状态在多个 reviewer 间互相污染。
 *   - P2 将通过 sandboxOverride 参数（每个 spawn_agent 携带独立沙箱级）实现真正并行。
 */
export class DeepReviewOrchestrator {
  constructor(private deps: DeepReviewOrchestratorDeps) {}

  /**
   * 执行 Deep Review
   *
   * @param params.diff 当前 diff
   * @param params.changedFiles 变更文件列表
   * @param params.onProgress 进度回调
   */
  async review(params: ReviewParams): Promise<DeepReviewResult> {
    const startTime = Date.now();

    // 1. 风险评分
    const riskScore = scoreRisk(params.diff, params.changedFiles);

    // 2. 未达阈值或功能关闭 → 降级（triggered=false）
    if (!this.deps.config.enabled || riskScore < this.deps.config.riskThreshold) {
      logger.debug('Deep Review skipped (disabled or below threshold)', {
        enabled: this.deps.config.enabled,
        riskScore,
        threshold: this.deps.config.riskThreshold,
      });
      return buildEmptyResult(riskScore, Date.now() - startTime);
    }

    // 3. 构造 reviewer 任务（Phase 72 修复 C3：传入 strictness 消费死字段）
    const focuses = this.deps.config.focuses;
    const tasks = focuses.map(focus => ({
      focus,
      prompt: buildReviewerPrompt(focus, params.diff, params.changedFiles, this.deps.config.reviewStrictness),
    }));

    // 4. 串行 spawn reviewer
    const reports = await this.spawnReviewersSerial(tasks, params.onProgress);

    // 5. 聚合 + 仲裁
    //    汇总用的模型 id：从可用列表中选第一个（pickModel 在非跨模型模式下会返回 reviewModel 或第一个可用模型）
    const summaryModelId = pickModel('security', this.deps.config, this.deps.availableModels ?? []);
    const { issues, arbitration, summary } = await aggregate(
      reports,
      this.deps.config,
      this.deps.llmClient,
      summaryModelId,
    );

    // 6. 返回
    const result: DeepReviewResult = {
      reports,
      aggregatedIssues: issues,
      arbitration,
      summary,
      riskScore,
      triggered: true,
      durationMs: Date.now() - startTime,
    };

    logger.info('Deep Review completed', {
      riskScore,
      reviewerCount: reports.length,
      successCount: reports.filter(r => r.success).length,
      issueCount: issues.length,
      arbitration,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * 串行执行所有 reviewer
   *
   * 沙箱切换说明：
   *   - 每个 reviewer spawn 前临时设为 read-only，spawn 后在 finally 中恢复原级
   *   - 串行执行保证沙箱状态不冲突
   *   - 单个 reviewer 失败不阻断（fail-open），记录 error 后继续下一个
   *   - 注意：每个 runSingleReviewer 内部独立 save+restore，互不影响
   */
  private async spawnReviewersSerial(
    tasks: Array<{ focus: ReviewFocus; prompt: string }>,
    onProgress?: (completed: number, total: number, current: string) => void,
  ): Promise<ReviewerReport[]> {
    const reports: ReviewerReport[] = [];
    const total = tasks.length;

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const report = await this.runSingleReviewer(task.focus, task.prompt);
      reports.push(report);

      // 进度回调
      if (onProgress) {
        onProgress(i + 1, total, task.focus);
      }

      // 向 UI 推送进度
      if (this.deps.commandBridge) {
        const status = report.success
          ? `✅ ${task.focus} 完成（${report.issueCounts.total} 个问题）`
          : `❌ ${task.focus} 失败：${report.error ?? '未知错误'}`;
        this.deps.commandBridge.addSystemMessage(
          `🔍 Deep Review [${i + 1}/${total}] ${status}`,
        );
      }
    }

    return reports;
  }

  /**
   * 执行单个 reviewer
   *
   * 流程：
   *   1. 保存原沙箱级，临时设为 read-only（确定性兜底）
   *   2. 调用 spawn_agent（subagentType: 'reviewer', isolated: true）
   *   3. finally 中恢复原沙箱级
   *   4. 解析结果，统计问题数
   *   5. 失败时记录 error，success=false（fail-open）
   */
  private async runSingleReviewer(
    focus: ReviewFocus,
    prompt: string,
  ): Promise<ReviewerReport> {
    const startMs = Date.now();

    // 保存原沙箱级并临时设为 read-only（确定性兜底，防止 reviewer 工具白名单遗漏）
    let originalSandboxLevel: SandboxLevel | null = null;
    if (this.deps.permissionEngine) {
      originalSandboxLevel = this.deps.permissionEngine.getSandboxLevel();
      this.deps.permissionEngine.setSandboxLevel('read-only');
    }

    try {
      const result = await this.deps.toolExecutor.executeTool(
        'spawn_agent',
        `deep-review-${focus}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        {
          description: `Deep Review: ${focus} 审查`,
          prompt,
          subagentType: 'reviewer',
          isolated: true,
          maxIterations: 15,
        },
      );

      // spawn_agent 失败时返回以 [工具错误] 开头的字符串
      const isSuccess = !result.startsWith('[工具错误]');

      if (!isSuccess) {
        return {
          focus,
          success: false,
          output: result,
          issueCounts: { critical: 0, major: 0, minor: 0, total: 0 },
          error: result,
          durationMs: Date.now() - startMs,
        };
      }

      // 成功：解析问题数（复用 aggregator 的解析逻辑统计）
      const tempReport: ReviewerReport = {
        focus,
        success: true,
        output: result,
        issueCounts: { critical: 0, major: 0, minor: 0, total: 0 },
        durationMs: Date.now() - startMs,
      };
      const issues = parseIssuesFromReport(tempReport);
      const issueCounts = {
        critical: issues.filter(i => i.severity === 'critical').length,
        major: issues.filter(i => i.severity === 'major').length,
        minor: issues.filter(i => i.severity === 'minor').length,
        total: issues.length,
      };

      return { ...tempReport, issueCounts };
    } catch (err) {
      // fail-open：单个 reviewer 异常不阻断整体流程
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('Deep Review: single reviewer failed', { focus, error: errMsg });
      return {
        focus,
        success: false,
        output: '',
        issueCounts: { critical: 0, major: 0, minor: 0, total: 0 },
        error: errMsg,
        durationMs: Date.now() - startMs,
      };
    } finally {
      // 恢复原沙箱级（必须在 finally 中，确保异常时也恢复）
      if (this.deps.permissionEngine && originalSandboxLevel !== null) {
        this.deps.permissionEngine.setSandboxLevel(originalSandboxLevel);
      }
    }
  }
}
