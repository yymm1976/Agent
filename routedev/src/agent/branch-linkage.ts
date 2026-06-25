// src/agent/branch-linkage.ts
// 消息分支与 /goal/experiment 联动管理
// 维护消息分支（BranchManager）与目标计划（GoalPlan）和实验（Experiment）之间的绑定关系
// 持久化到 .routedev/conversation/branch-linkage.json

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

/** 消息分支联动信息 */
export interface BranchLinkage {
  /** 消息分支 ID（对应 BranchManager 的 branchId） */
  messageBranchId: string;
  /** 消息分支名称 */
  messageBranchName: string;
  /** 绑定的 /goal ID */
  goalId?: string;
  /** 绑定的 experiment ID 列表 */
  experimentIds: string[];
  /** 联动状态 */
  status: 'planned' | 'running' | 'completed' | 'failed' | 'abandoned';
  /** 创建时间戳 */
  createdAt: number;
  /** 最后更新时间戳 */
  updatedAt: number;
}

/** experiment 结果记录（内部结构，用于摘要显示） */
interface ExperimentResultRecord {
  experimentId: string;
  status: string;
  summary: string;
  modifiedFiles: string[];
  testsPassed?: boolean;
  recordedAt: number;
}

/** 持久化文件结构 */
interface LinkageStore {
  linkages: BranchLinkage[];
  results: Record<string, ExperimentResultRecord[]>;
}

/**
 * BranchLinkageManager：管理消息分支与 goal/experiment 的联动关系
 *
 * 使用场景：
 * - 用户在某个消息分支中执行 /goal → linkGoal
 * - 在该分支中创建 experiment → linkExperiment
 * - experiment 完成后回写结果 → recordExperimentResult
 * - 需求变更时放弃旧 goal → abandonGoal
 * - 删除消息分支时清理关联 experiment → getOrphanedExperiments / confirmDeleteExperiments
 */
export class BranchLinkageManager {
  /** key: messageBranchId */
  private linkages: Map<string, BranchLinkage> = new Map();
  /** key: messageBranchId → 该分支下各 experiment 的结果记录 */
  private results: Map<string, ExperimentResultRecord[]> = new Map();
  /** 持久化文件路径 */
  private filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, '.routedev', 'conversation', 'branch-linkage.json');
  }

  /** 绑定 /goal 到消息分支 */
  linkGoal(messageBranchId: string, messageBranchName: string, goalId: string): BranchLinkage {
    const now = Date.now();
    let linkage = this.linkages.get(messageBranchId);
    if (linkage) {
      linkage.goalId = goalId;
      linkage.messageBranchName = messageBranchName;
      // 如果之前被 abandoned，重新绑定 goal 时重置为 planned
      if (linkage.status === 'abandoned') {
        linkage.status = 'planned';
      }
      linkage.updatedAt = now;
    } else {
      linkage = {
        messageBranchId,
        messageBranchName,
        goalId,
        experimentIds: [],
        status: 'planned',
        createdAt: now,
        updatedAt: now,
      };
      this.linkages.set(messageBranchId, linkage);
    }
    return linkage;
  }

  /** 绑定 experiment 到消息分支 */
  linkExperiment(messageBranchId: string, experimentId: string): BranchLinkage {
    const now = Date.now();
    let linkage = this.linkages.get(messageBranchId);
    if (linkage) {
      if (!linkage.experimentIds.includes(experimentId)) {
        linkage.experimentIds.push(experimentId);
      }
      linkage.updatedAt = now;
    } else {
      linkage = {
        messageBranchId,
        messageBranchName: messageBranchId,
        experimentIds: [experimentId],
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
      this.linkages.set(messageBranchId, linkage);
    }
    return linkage;
  }

  /** 获取消息分支的联动信息 */
  getLinkage(messageBranchId: string): BranchLinkage | undefined {
    return this.linkages.get(messageBranchId);
  }

  /** 获取所有联动 */
  getAllLinkages(): BranchLinkage[] {
    return [...this.linkages.values()];
  }

  /** 获取绑定到某个 goal 的所有联动 */
  getByGoalId(goalId: string): BranchLinkage[] {
    return [...this.linkages.values()].filter(l => l.goalId === goalId);
  }

  /** 获取绑定到某个 experiment 的所有联动 */
  getByExperimentId(experimentId: string): BranchLinkage[] {
    return [...this.linkages.values()].filter(l => l.experimentIds.includes(experimentId));
  }

  /** 更新状态 */
  updateStatus(messageBranchId: string, status: BranchLinkage['status']): void {
    const linkage = this.linkages.get(messageBranchId);
    if (linkage) {
      linkage.status = status;
      linkage.updatedAt = Date.now();
    }
  }

  /** 标记旧 goal 为 abandoned（需求变更后重新规划时） */
  abandonGoal(messageBranchId: string, _reason: string): void {
    const linkage = this.linkages.get(messageBranchId);
    if (linkage) {
      linkage.status = 'abandoned';
      linkage.updatedAt = Date.now();
    }
  }

  /** 删除消息分支时提示是否同步删除 experiment，返回需要确认的 experiment 列表 */
  getOrphanedExperiments(messageBranchId: string): string[] {
    const linkage = this.linkages.get(messageBranchId);
    if (!linkage) return [];
    return [...linkage.experimentIds];
  }

  /** 确认删除关联 experiment，返回被删除的 experiment id 列表 */
  confirmDeleteExperiments(messageBranchId: string): string[] {
    const linkage = this.linkages.get(messageBranchId);
    if (!linkage) return [];
    const deleted = [...linkage.experimentIds];
    linkage.experimentIds = [];
    linkage.updatedAt = Date.now();
    // 同时清理结果记录
    this.results.delete(messageBranchId);
    return deleted;
  }

  /** experiment 结果回写到消息分支 */
  recordExperimentResult(
    messageBranchId: string,
    experimentId: string,
    result: {
      summary: string;
      modifiedFiles: string[];
      testsPassed?: boolean;
    },
  ): void {
    let records = this.results.get(messageBranchId);
    if (!records) {
      records = [];
      this.results.set(messageBranchId, records);
    }
    // 移除同 experiment 的旧记录，追加新记录
    const filtered = records.filter(r => r.experimentId !== experimentId);
    filtered.push({
      experimentId,
      status: 'completed',
      summary: result.summary,
      modifiedFiles: result.modifiedFiles,
      testsPassed: result.testsPassed,
      recordedAt: Date.now(),
    });
    this.results.set(messageBranchId, filtered);

    // 如果该分支下所有 experiment 都有结果，更新状态为 completed
    const linkage = this.linkages.get(messageBranchId);
    if (linkage && linkage.experimentIds.length > 0) {
      const allHaveResults = linkage.experimentIds.every(id =>
        filtered.some(r => r.experimentId === id),
      );
      if (allHaveResults && linkage.status === 'running') {
        linkage.status = 'completed';
        linkage.updatedAt = Date.now();
      }
    }
  }

  /** 获取消息分支的 experiment 摘要（用于 BranchPanel 显示） */
  getExperimentSummaries(messageBranchId: string): Array<{
    experimentId: string;
    status: string;
    summary?: string;
    modifiedFiles?: string[];
  }> {
    const records = this.results.get(messageBranchId);
    if (!records) return [];
    return records.map(r => ({
      experimentId: r.experimentId,
      status: r.status,
      summary: r.summary,
      modifiedFiles: r.modifiedFiles,
    }));
  }

  /** 持久化到磁盘 */
  async save(): Promise<void> {
    try {
      const store: LinkageStore = {
        linkages: [...this.linkages.values()],
        results: Object.fromEntries(this.results.entries()),
      };
      await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsPromises.writeFile(this.filePath, JSON.stringify(store, null, 2), 'utf-8');
    } catch (error) {
      logger.warn('BranchLinkageManager: 保存失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 从磁盘加载 */
  async load(): Promise<void> {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const store = JSON.parse(content) as LinkageStore;
      this.linkages.clear();
      this.results.clear();
      if (Array.isArray(store.linkages)) {
        for (const l of store.linkages) {
          this.linkages.set(l.messageBranchId, l);
        }
      }
      if (store.results && typeof store.results === 'object') {
        for (const [key, val] of Object.entries(store.results)) {
          if (Array.isArray(val)) {
            this.results.set(key, val);
          }
        }
      }
    } catch {
      // 文件不存在或损坏，从空状态开始
      this.linkages.clear();
      this.results.clear();
    }
  }
}
