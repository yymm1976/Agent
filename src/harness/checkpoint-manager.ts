// src/harness/checkpoint-manager.ts
// 检查点管理器：基于 Git 的代码快照与回滚
// 使用 simple-git（已在 dependencies 中）
//
// 检查点 = git commit + JSON 元数据
// 创建：git add -A && git commit -m "[routedev-checkpoint] ..."
// 列出：从 JSON 元数据文件读取
// 回滚：git reset --hard <hash>
// 清理：删除最旧的 git commit + JSON 元数据

import simpleGit, { type SimpleGit } from 'simple-git';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type {
  Checkpoint,
  CheckpointDiff,
  CheckpointManagerConfig,
  CreateCheckpointOptions,
  GoalPlan,
} from './types.js';
import { logger } from '../utils/logger.js';

/** Git commit 消息前缀（用于区分自动检查点和用户提交） */
const CHECKPOINT_PREFIX = '[routedev-checkpoint]';

export class CheckpointManager {
  private git: SimpleGit;
  private config: CheckpointManagerConfig;
  private checkpoints: Checkpoint[] = [];
  private isRepo: boolean = false;
  /** 元数据文件路径 */
  private metadataPath: string;
  /** GoalPlan 持久化路径 */
  private goalPlanPath: string;

  constructor(config: CheckpointManagerConfig) {
    this.config = config;
    this.git = simpleGit(config.workingDirectory);
    const { metadataPath, goalPlanPath } = this.resolveStoragePaths();
    this.metadataPath = metadataPath;
    this.goalPlanPath = goalPlanPath;
  }

  /** 初始化：检查是否为 Git 仓库 + 加载元数据 */
  async init(): Promise<void> {
    try {
      this.isRepo = await this.git.checkIsRepo();
      if (!this.isRepo) {
        logger.warn('CheckpointManager: not a git repository, checkpoints disabled', {
          workingDirectory: this.config.workingDirectory,
        });
        return;
      }

      await this.loadMetadata();
      logger.info('CheckpointManager initialized', {
        checkpointCount: this.checkpoints.length,
        workingDirectory: this.config.workingDirectory,
      });
    } catch (error) {
      logger.warn('CheckpointManager init failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 创建检查点（Git 快照） */
  async create(options: CreateCheckpointOptions = {}): Promise<Checkpoint | null> {
    if (!this.config.enabled) return null;
    if (!this.isRepo) return null;

    try {
      // 检查是否有未提交的变更
      const status = await this.git.status();
      const hasChanges = status.files.length > 0;

      if (!hasChanges && this.checkpoints.length > 0) {
        logger.debug('No changes since last checkpoint, skipping');
        return null;
      }

      // 生成检查点 ID
      const id = crypto.randomUUID().slice(0, 8);

      // 获取变更文件列表
      const filesSnapshot = status.files.map(f => f.path);

      // 暂存所有变更
      await this.git.add('-A');

      // 创建 Git commit
      const description = options.description
        ?? `步骤 ${options.stepId ?? '?'} 前快照`;
      const commitMessage = `${CHECKPOINT_PREFIX} ${description} (cp-${id})`;
      const commitResult = await this.git.commit(commitMessage);

      const checkpoint: Checkpoint = {
        id,
        stepId: options.stepId,
        goalId: options.goalId,
        gitCommitHash: commitResult.commit,
        timestamp: Date.now(),
        description,
        filesSnapshot,
        isAutoCreated: options.isAutoCreated ?? true,
      };

      this.checkpoints.push(checkpoint);
      await this.saveMetadata();

      // 自动清理：保留最近 N 个
      await this.prune();

      logger.info('Checkpoint created', {
        id,
        commit: commitResult.commit.slice(0, 7),
        files: filesSnapshot.length,
        auto: checkpoint.isAutoCreated,
      });

      return checkpoint;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to create checkpoint', { error: msg });
      return null;
    }
  }

  /** 列出所有检查点 */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** 获取检查点之间的差异 */
  async diff(fromId: string, toId?: string): Promise<CheckpointDiff | null> {
    if (!this.isRepo) return null;

    const from = this.checkpoints.find(c => c.id === fromId);
    if (!from) return null;

    const toHash = toId
      ? this.checkpoints.find(c => c.id === toId)?.gitCommitHash
      : 'HEAD';

    if (!toHash) return null;

    try {
      // 获取 diff 统计
      const diffStat = await this.git.diffSummary([from.gitCommitHash, toHash]);
      const patch = await this.git.diff([from.gitCommitHash, toHash]);

      const result: CheckpointDiff = {
        filesAdded: [],
        filesModified: [],
        filesDeleted: [],
        patch,
      };

      for (const file of diffStat.files) {
        const isBinary = 'binary' in file && file.binary;
        if (isBinary) {
          result.filesModified.push(file.file);
          continue;
        }
        const deletions = 'deletions' in file ? file.deletions : 0;
        const insertions = 'insertions' in file ? file.insertions : 0;
        if (deletions === 0 && insertions > 0) {
          result.filesAdded.push(file.file);
        } else if (deletions > 0 && insertions === 0) {
          result.filesDeleted.push(file.file);
        } else {
          result.filesModified.push(file.file);
        }
      }

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get checkpoint diff', { error: msg });
      return null;
    }
  }

  /** 回滚到指定检查点
   *  注意：这是一个破坏性操作（git reset --hard）
   *  调用方必须在执行前获得用户确认
   */
  async rollback(checkpointId: string): Promise<boolean> {
    if (!this.isRepo) return false;

    const checkpoint = this.checkpoints.find(c => c.id === checkpointId);
    if (!checkpoint) {
      logger.error('Checkpoint not found', { id: checkpointId });
      return false;
    }

    try {
      // git reset --hard 到检查点的 commit
      await this.git.reset(['--hard', checkpoint.gitCommitHash]);

      // 清理该检查点之后创建的所有检查点
      const idx = this.checkpoints.indexOf(checkpoint);
      const removed = this.checkpoints.splice(idx + 1);

      await this.saveMetadata();

      logger.info('Rolled back to checkpoint', {
        id: checkpointId,
        commit: checkpoint.gitCommitHash.slice(0, 7),
        removedCheckpoints: removed.length,
      });

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to rollback', { error: msg });
      return false;
    }
  }

  /** 清理超出限制的最旧检查点 */
  private async prune(): Promise<void> {
    while (this.checkpoints.length > this.config.maxCheckpoints) {
      const oldest = this.checkpoints.shift();
      if (!oldest) break;

      logger.debug('Pruning old checkpoint', { id: oldest.id });
      // Git commit 不主动删除（通过 gc 自然回收）
    }
    await this.saveMetadata();
  }

  /** 获取检查点总数 */
  get count(): number {
    return this.checkpoints.length;
  }

  /** 检查点是否启用（即当前在 Git 仓库内） */
  get isEnabled(): boolean {
    return this.config.enabled && this.isRepo;
  }

  // ===== GoalPlan 持久化 =====

  /** 保存当前目标计划 */
  async saveGoalPlan(plan: GoalPlan): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.goalPlanPath), { recursive: true });
      await fs.writeFile(
        this.goalPlanPath,
        JSON.stringify(plan, null, 2),
        'utf-8',
      );
      logger.debug('GoalPlan saved', { path: this.goalPlanPath });
    } catch (error) {
      logger.warn('Failed to save goal plan', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 加载上一次的目标计划 */
  async loadGoalPlan(): Promise<GoalPlan | null> {
    try {
      const content = await fs.readFile(this.goalPlanPath, 'utf-8');
      return JSON.parse(content) as GoalPlan;
    } catch {
      return null;
    }
  }

  /** 清除已保存的目标计划 */
  async clearGoalPlan(): Promise<void> {
    try {
      await fs.unlink(this.goalPlanPath);
    } catch {
      // 文件不存在，忽略
    }
  }

  // ===== 元数据持久化 =====

  /** 解析元数据文件路径（可被测试覆盖） */
  protected resolveStoragePaths(): { metadataPath: string; goalPlanPath: string } {
    const dir = this.getStorageDir();
    return {
      metadataPath: path.join(dir, 'metadata.json'),
      goalPlanPath: path.join(dir, 'current-goal.json'),
    };
  }

  /** 获取存储目录 */
  private getStorageDir(): string {
    const appData = process.env.APPDATA
      ?? (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : path.join(os.homedir(), '.local', 'share'));
    return path.join(appData, 'RouteDev', 'checkpoints');
  }

  private async loadMetadata(): Promise<void> {
    try {
      const content = await fs.readFile(this.metadataPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        this.checkpoints = parsed;
      }
    } catch {
      // 文件不存在或损坏，从空列表开始
      this.checkpoints = [];
    }
  }

  private async saveMetadata(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });
      await fs.writeFile(
        this.metadataPath,
        JSON.stringify(this.checkpoints, null, 2),
        'utf-8',
      );
    } catch (error) {
      logger.warn('Failed to save checkpoint metadata', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
