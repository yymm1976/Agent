// src/agent/goal-persistence.ts
// Phase 40 Task 8：目标持久化与续跑
//
// 职责：
//   - save/load：把 PersistedGoal 写入 .routedev/goals/<id>.json
//   - listResumable：列出可续跑的目标（status=executing 或 paused）
//   - archive：把 goal 移到 .routedev/goals/archived/
//   - cleanupOldGoals：清理超过 maxAge 的归档 goal
//   - shouldSoftStop：Token 预算软停止（>=90% 预算）
//   - generateProgressReport：生成进度报告
//
// 文件布局：
//   .routedev/goals/
//     ├── <goal-id-1>.json
//     ├── <goal-id-2>.json
//     └── archived/
//         ├── <goal-id-3>.json
//         └── <goal-id-4>.json

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { FivePartGoalSpec } from './goal-prompt-builder.js';
import type { ArchivedPlanVersion, PlanAttestation } from './goal-types.js';

// ============================================================
// 类型定义
// ============================================================

/** 目标计划状态 */
export type GoalPlanStatus = 'planning' | 'executing' | 'paused' | 'completed' | 'failed';

/** 持久化的目标 */
export interface PersistedGoal {
  /** 唯一 ID */
  id: string;
  /** 五段式规范 */
  spec: FivePartGoalSpec;
  /** 执行计划 */
  plan: {
    steps: Array<{
      id: string;
      description: string;
      status: string;
      dependencies: string[];
    }>;
    attestation?: PlanAttestation;
    archivedVersions?: ArchivedPlanVersion[];
  };
  /** 状态 */
  status: GoalPlanStatus;
  /** 检查点 ID 列表 */
  checkpointIds: string[];
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
  /** 已用 Token */
  tokenUsed: number;
  /** Token 预算 */
  tokenBudget: number;
  /** 进度报告（可选） */
  progressReport?: string;
}

/** 默认归档保留时长：30 天 */
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================
// GoalPersistence
// ============================================================

export class GoalPersistence {
  /** goals 目录：.routedev/goals/ */
  private goalsDir: string;
  /** 归档目录：.routedev/goals/archived/ */
  private archivedDir: string;

  constructor(rootDir: string) {
    this.goalsDir = path.join(rootDir, '.routedev', 'goals');
    this.archivedDir = path.join(this.goalsDir, 'archived');
  }

  /**
   * 保存目标到 .routedev/goals/<id>.json
   */
  async save(goal: PersistedGoal): Promise<void> {
    await fs.mkdir(this.goalsDir, { recursive: true });
    const filePath = this.goalFilePath(goal.id);
    const data = JSON.stringify(goal, null, 2);
    await fs.writeFile(filePath, data, 'utf-8');
    logger.debug('GoalPersistence.save', { id: goal.id, path: filePath });
  }

  /**
   * 加载目标
   *
   * @returns 不存在时返回 null
   */
  async load(goalId: string): Promise<PersistedGoal | null> {
    const filePath = this.goalFilePath(goalId);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as PersistedGoal;
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return null;
      }
      logger.warn('GoalPersistence.load: failed to read', {
        id: goalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * 列出可续跑的目标（status === executing 或 paused）
   *
   * 只扫描 goalsDir 下的 .json 文件，不扫描 archived/
   */
  async listResumable(): Promise<PersistedGoal[]> {
    const files = await this.listGoalFiles(this.goalsDir);
    const goals: PersistedGoal[] = [];
    for (const file of files) {
      const goal = await this.tryReadGoalFile(file);
      if (goal && (goal.status === 'executing' || goal.status === 'paused')) {
        goals.push(goal);
      }
    }
    return goals;
  }

  /**
   * 删除目标
   */
  async delete(goalId: string): Promise<void> {
    const filePath = this.goalFilePath(goalId);
    try {
      await fs.unlink(filePath);
      logger.debug('GoalPersistence.delete', { id: goalId });
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  /**
   * 归档目标：移动到 .routedev/goals/archived/
   */
  async archive(goalId: string): Promise<void> {
    await fs.mkdir(this.archivedDir, { recursive: true });
    const src = this.goalFilePath(goalId);
    const dst = path.join(this.archivedDir, `${goalId}.json`);
    try {
      await fs.rename(src, dst);
      logger.debug('GoalPersistence.archive', { id: goalId, from: src, to: dst });
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        logger.warn('GoalPersistence.archive: source not found', { id: goalId });
        return;
      }
      throw err;
    }
  }

  /**
   * 清理超过 maxAge 的归档 goal
   *
   * @param maxAge 最大年龄（毫秒），默认 30 天
   * @returns 清理的文件数
   */
  async cleanupOldGoals(maxAge: number = DEFAULT_MAX_AGE_MS): Promise<number> {
    const files = await this.listGoalFiles(this.archivedDir);
    const now = Date.now();
    let cleaned = 0;
    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs > maxAge) {
          await fs.unlink(file);
          cleaned++;
        }
      } catch {
        // 文件可能在扫描中被删，忽略
      }
    }
    if (cleaned > 0) {
      logger.info('GoalPersistence.cleanupOldGoals', { cleaned, maxAge });
    }
    return cleaned;
  }

  /**
   * Token 预算软停止：已用 >= 90% 预算时返回 true
   */
  static shouldSoftStop(goal: PersistedGoal): boolean {
    return goal.tokenUsed >= goal.tokenBudget * 0.9;
  }

  /**
   * 生成进度报告
   */
  static generateProgressReport(goal: PersistedGoal): string {
    const steps = goal.plan.steps;
    const total = steps.length;
    const completed = steps.filter((s) => s.status === 'completed').length;
    const failed = steps.filter((s) => s.status === 'failed').length;
    const inProgress = steps.filter((s) => s.status === 'in_progress').length;
    const pending = steps.filter((s) => s.status === 'pending').length;

    const tokenPct = goal.tokenBudget > 0
      ? ((goal.tokenUsed / goal.tokenBudget) * 100).toFixed(1)
      : '0.0';

    const lines: string[] = [
      `# Progress Report for Goal ${goal.id}`,
      '',
      `## Overview`,
      `- Status: ${goal.status}`,
      `- Steps: ${completed}/${total} completed, ${inProgress} in-progress, ${pending} pending, ${failed} failed`,
      `- Token: ${goal.tokenUsed}/${goal.tokenBudget} (${tokenPct}%)`,
      `- Soft stop: ${GoalPersistence.shouldSoftStop(goal) ? 'YES' : 'no'}`,
      '',
      `## Step Details`,
      ...steps.map((s) => `- [${s.status}] ${s.id}: ${s.description}`),
      '',
    ];

    return lines.join('\n');
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  /** goal 文件路径：goalsDir/<id>.json */
  private goalFilePath(goalId: string): string {
    return path.join(this.goalsDir, `${goalId}.json`);
  }

  /** 列出目录下的 .json 文件（不递归） */
  private async listGoalFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => path.join(dir, e.name));
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /** 尝试读取 goal 文件，失败返回 null */
  private async tryReadGoalFile(filePath: string): Promise<PersistedGoal | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as PersistedGoal;
    } catch {
      return null;
    }
  }
}

// 暴露 fsSync 供外部测试需要时使用（避免未使用告警）
void fsSync;
