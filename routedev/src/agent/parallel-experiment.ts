// src/agent/parallel-experiment.ts
// 多分支并行实验管理：文件冲突检测、并行执行、结果对比与采纳计划
//
// 使用场景：
// - 用户在多个消息分支中同时探索不同实现方案
// - 检测文件访问冲突（write_write = blocking, read_write = warning）
// - 并行执行各分支的 experiment worktree
// - 对比结果并推荐最佳分支
// - 生成采纳计划（支持从其他分支 cherry-pick 部分文件）

import type { ExperimentManager, ExperimentRunResult } from '../harness/experiment-manager.js';
import type { ExperimentConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

/** 单个分支的实验意图 */
export interface ExperimentIntent {
  branchId: string;
  branchName: string;
  /** 预计写入的文件 */
  estimatedWriteFiles: string[];
  /** 预计读取的文件 */
  estimatedReadFiles: string[];
  /** 目标描述（作为 experiment 的 task） */
  goalDescription: string;
}

/** 冲突检测结果 */
export interface ConflictDetectionResult {
  hasConflict: boolean;
  conflicts: Array<{
    branchA: string;
    branchB: string;
    type: 'write_write' | 'read_write';
    files: string[];
    severity: 'blocking' | 'warning';
  }>;
  canParallelize: boolean;
}

/** 单个分支的并行实验结果 */
export interface ParallelExperimentResult {
  branchId: string;
  experimentId: string;
  status: 'completed' | 'failed' | 'aborted';
  summary?: string;
  modifiedFiles: string[];
  testsPassed?: boolean;
  tokenUsage?: number;
  durationMs?: number;
}

/** 实验对比结果 */
export interface ExperimentComparison {
  results: ParallelExperimentResult[];
  /** 最佳分支 ID */
  winner?: string;
  comparison: Array<{
    branchId: string;
    branchName: string;
    modifiedFiles: string[];
    testsPassed: boolean;
    tokenUsage: number;
    durationMs: number;
  }>;
}

/**
 * ParallelExperimentManager：多分支并行实验管理器
 *
 * 静态方法用于冲突检测、对比报告生成、推荐选择、采纳计划——纯函数，不依赖实例状态。
 * 实例方法 runParallel 依赖 ExperimentManager 创建 worktree 并执行任务。
 */
export class ParallelExperimentManager {
  constructor(
    private experimentManager: ExperimentManager,
    private config?: ExperimentConfig,
  ) {}

  /**
   * 检测文件访问冲突
   * - 两个分支都要写同一文件 → write_write, blocking
   * - 一个读一个写同一文件 → read_write, warning
   * - 无 blocking 冲突 → canParallelize = true
   * - Phase 44：config.experiment.conflictDetection=false 时跳过检测，直接允许并行
   */
  static detectConflicts(intents: ExperimentIntent[]): ConflictDetectionResult {
    const conflicts: ConflictDetectionResult['conflicts'] = [];

    for (let i = 0; i < intents.length; i++) {
      for (let j = i + 1; j < intents.length; j++) {
        const a = intents[i];
        const b = intents[j];

        // write_write：两个分支都要写同一文件
        const writeWriteFiles = a.estimatedWriteFiles.filter(f =>
          b.estimatedWriteFiles.includes(f),
        );
        if (writeWriteFiles.length > 0) {
          conflicts.push({
            branchA: a.branchId,
            branchB: b.branchId,
            type: 'write_write',
            files: writeWriteFiles,
            severity: 'blocking',
          });
        }

        // read_write：一个读一个写同一文件（双向检查）
        const aReadBWrite = a.estimatedReadFiles.filter(f =>
          b.estimatedWriteFiles.includes(f),
        );
        const bReadAWrite = b.estimatedReadFiles.filter(f =>
          a.estimatedWriteFiles.includes(f),
        );
        const readWriteFiles = [...new Set([...aReadBWrite, ...bReadAWrite])];
        if (readWriteFiles.length > 0) {
          conflicts.push({
            branchA: a.branchId,
            branchB: b.branchId,
            type: 'read_write',
            files: readWriteFiles,
            severity: 'warning',
          });
        }
      }
    }

    const hasBlocking = conflicts.some(c => c.severity === 'blocking');
    return {
      hasConflict: conflicts.length > 0,
      conflicts,
      canParallelize: !hasBlocking,
    };
  }

  /**
   * 执行并行实验
   * 1. 检测冲突，blocking 冲突时拒绝执行
   * 2. 为每个分支创建独立 experiment worktree
   * 3. 并行执行（Promise.allSettled）
   * 4. 收集结果并生成对比视图
   */
  async runParallel(
    intents: ExperimentIntent[],
    options?: { maxConcurrency?: number },
  ): Promise<ExperimentComparison> {
    // Phase 44：config.experiment.conflictDetection=false 时跳过冲突检测
    if (this.config?.conflictDetection !== false) {
      const detection = ParallelExperimentManager.detectConflicts(intents);
      if (!detection.canParallelize) {
        throw new Error(
          `检测到 blocking 冲突，无法并行执行: ${detection.conflicts
            .filter(c => c.severity === 'blocking')
            .map(c => `${c.branchA}↔${c.branchB}: ${c.files.join(', ')}`)
            .join('; ')}`,
        );
      }
    }

    // Phase 44：优先使用 config.experiment.maxParallel，否则使用传入值，默认 intents.length
    const maxConcurrency = options?.maxConcurrency ?? this.config?.maxParallel ?? intents.length;
    const results: ParallelExperimentResult[] = [];

    // 按并发上限分批执行
    for (let i = 0; i < intents.length; i += maxConcurrency) {
      const batch = intents.slice(i, i + maxConcurrency);
      const settled = await Promise.allSettled(
        batch.map(intent => this.runSingleExperiment(intent)),
      );
      for (let k = 0; k < settled.length; k++) {
        const s = settled[k];
        if (s.status === 'fulfilled') {
          results.push(s.value);
        } else {
          // allSettled rejected（runSingleExperiment 内部已 try-catch，此处为兜底）
          results.push({
            branchId: batch[k].branchId,
            experimentId: '',
            status: 'aborted',
            summary: s.reason instanceof Error ? s.reason.message : String(s.reason),
            modifiedFiles: [],
          });
        }
      }
    }

    return ParallelExperimentManager.buildComparison(results, intents);
  }

  /** 执行单个分支的实验 */
  private async runSingleExperiment(intent: ExperimentIntent): Promise<ParallelExperimentResult> {
    const startTime = Date.now();
    try {
      const exp = await this.experimentManager.createExperiment(intent.branchName);
      const runResult: ExperimentRunResult = await this.experimentManager.runInExperiment(
        exp.id,
        intent.goalDescription,
      );
      return {
        branchId: intent.branchId,
        experimentId: exp.id,
        status: runResult.success ? 'completed' : 'failed',
        summary: runResult.result,
        modifiedFiles: runResult.modifiedFiles,
        testsPassed: undefined,
        tokenUsage: runResult.tokenUsage,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      logger.warn('ParallelExperimentManager: 单分支实验失败', {
        branchId: intent.branchId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        branchId: intent.branchId,
        experimentId: '',
        status: 'aborted',
        summary: error instanceof Error ? error.message : String(error),
        modifiedFiles: [],
        durationMs: Date.now() - startTime,
      };
    }
  }

  /** 从结果列表和意图列表构建对比视图 */
  private static buildComparison(
    results: ParallelExperimentResult[],
    intents: ExperimentIntent[],
  ): ExperimentComparison {
    const intentMap = new Map(intents.map(i => [i.branchId, i]));
    const comparison = results.map(r => {
      const intent = intentMap.get(r.branchId);
      return {
        branchId: r.branchId,
        branchName: intent?.branchName ?? r.branchId,
        modifiedFiles: r.modifiedFiles,
        testsPassed: r.testsPassed ?? false,
        tokenUsage: r.tokenUsage ?? 0,
        durationMs: r.durationMs ?? 0,
      };
    });
    const winner = ParallelExperimentManager.recommendWinner({ results, comparison });
    return { results, winner, comparison };
  }

  /** 生成对比报告（Markdown 格式） */
  static formatComparison(comparison: ExperimentComparison): string {
    const lines: string[] = [];
    lines.push('# 并行实验对比报告');
    lines.push('');

    if (comparison.winner) {
      lines.push(`**推荐分支**: ${comparison.winner}`);
      lines.push('');
    }

    lines.push('| 分支 | 修改文件数 | 测试通过 | Token 用量 | 耗时(ms) |');
    lines.push('|------|-----------|---------|-----------|---------|');
    for (const c of comparison.comparison) {
      const testIcon = c.testsPassed ? '✓' : '✗';
      lines.push(
        `| ${c.branchName} | ${c.modifiedFiles.length} | ${testIcon} | ${c.tokenUsage} | ${c.durationMs} |`,
      );
    }
    lines.push('');

    for (const r of comparison.results) {
      lines.push(`## ${r.branchId} (${r.status})`);
      if (r.summary) {
        lines.push(r.summary);
      }
      if (r.modifiedFiles.length > 0) {
        lines.push('修改文件:');
        for (const f of r.modifiedFiles) {
          lines.push(`  - ${f}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 选择最佳分支（自动推荐）
   * 优先选择：testsPassed=true && tokenUsage 最低 && modifiedFiles 最少
   */
  static recommendWinner(comparison: ExperimentComparison): string | undefined {
    const passed = comparison.comparison.filter(c => c.testsPassed);
    if (passed.length === 0) return undefined;
    passed.sort((a, b) => {
      if (a.tokenUsage !== b.tokenUsage) return a.tokenUsage - b.tokenUsage;
      return a.modifiedFiles.length - b.modifiedFiles.length;
    });
    return passed[0].branchId;
  }

  /**
   * 采纳某个分支的代码，返回需要 cherry-pick 的文件列表
   * - adoptFiles: 获胜分支的全部修改文件
   * - cherryPickFrom: 若指定 cherryPickFiles，从其他分支补充部分文件
   */
  static getAdoptionPlan(
    comparison: ExperimentComparison,
    winnerBranchId: string,
    options?: { cherryPickFiles?: string[] },
  ): {
    adoptBranchId: string;
    adoptFiles: string[];
    cherryPickFrom: Array<{ branchId: string; files: string[] }>;
  } {
    const winnerResult = comparison.results.find(r => r.branchId === winnerBranchId);
    const adoptFiles = winnerResult?.modifiedFiles ?? [];

    const cherryPickFrom: Array<{ branchId: string; files: string[] }> = [];
    if (options?.cherryPickFiles && options.cherryPickFiles.length > 0) {
      const branchToFileMap = new Map<string, string[]>();
      for (const file of options.cherryPickFiles) {
        for (const c of comparison.comparison) {
          if (c.branchId === winnerBranchId) continue;
          if (c.modifiedFiles.includes(file)) {
            if (!branchToFileMap.has(c.branchId)) {
              branchToFileMap.set(c.branchId, []);
            }
            branchToFileMap.get(c.branchId)!.push(file);
          }
        }
      }
      for (const [branchId, files] of branchToFileMap) {
        cherryPickFrom.push({ branchId, files });
      }
    }

    return { adoptBranchId: winnerBranchId, adoptFiles, cherryPickFrom };
  }
}
