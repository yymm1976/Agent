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
  CheckpointLLMClient,
  CheckpointManagerConfig,
  CreateCheckpointOptions,
  GoalPlan,
} from './types.js';
import { logger } from '../utils/logger.js';
import { safeWriteJSON } from '../utils/safe-write.js';
import { parseGoalPlan, GOAL_PLAN_SCHEMA_VERSION } from '../config/schemas/checkpoint.js';
import { migrate, withSchemaVersion } from '../utils/migration.js';

/** Git commit 消息前缀（用于区分自动检查点和用户提交） */
const CHECKPOINT_PREFIX = '[routedev-checkpoint]';

/** 摘要生成超时时间（陷阱 #138：必须设超时，避免 LLM 卡住阻塞检查点流程） */
const SUMMARY_TIMEOUT_MS = 3000;

export class CheckpointManager {
  private git: SimpleGit;
  private config: CheckpointManagerConfig;
  private checkpoints: Checkpoint[] = [];
  private isRepo: boolean = false;
  /** 元数据文件路径 */
  private metadataPath: string;
  /** GoalPlan 持久化路径 */
  private goalPlanPath: string;
  /** 可选：自定义存储目录（默认使用 APPDATA） */
  private storageDirOverride?: string;
  /** 可选：摘要生成用的 LLM 客户端（未注入时降级为原始 description） */
  private llmClient?: CheckpointLLMClient;
  /** 摘要生成使用的模型 ID */
  private llmModel?: string;

  constructor(config: CheckpointManagerConfig, storageDirOverride?: string) {
    this.config = config;
    this.git = simpleGit(config.workingDirectory);
    this.storageDirOverride = storageDirOverride;
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

      if (!hasChanges) {
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
        stats: {
          filesChanged: filesSnapshot.length,
          tokensUsed: options.tokensUsed ?? 0,
        },
      };

      // 先持久化 checkpoint（安全网优先——Checkpoint 创建不能被摘要生成阻塞）
      // 即使后续摘要生成失败/超时，checkpoint 本身已保存到磁盘
      this.checkpoints.push(checkpoint);
      await this.saveMetadata();

      // 自动清理：保留最近 N 个
      await this.prune();

      // 然后生成语义化摘要（3 秒超时，失败/超时降级为原始 description）
      // 注意：摘要生成在 checkpoint 持久化之后，即使失败也不影响 checkpoint 本身
      try {
        const summary = await this.generateSummary(description);
        if (summary && summary !== description) {
          checkpoint.summary = summary;
          // 摘要更新后重新持久化（失败不影响 checkpoint 本身）
          await this.saveMetadata();
        }
      } catch (error) {
        logger.warn('Checkpoint summary generation failed, using description as fallback', {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      logger.info('Checkpoint created', {
        id,
        commit: commitResult.commit.slice(0, 7),
        files: filesSnapshot.length,
        auto: checkpoint.isAutoCreated,
        hasSummary: !!checkpoint.summary,
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

  /**
   * 注入 LLM 客户端用于语义化摘要生成（可选）
   * 不注入时 generateSummary() 会降级为返回原始 description
   */
  setLLMClient(client: CheckpointLLMClient | undefined, model: string): void {
    this.llmClient = client;
    this.llmModel = model;
    logger.debug('CheckpointManager LLM client set', {
      hasClient: !!client,
      model,
    });
  }

  /**
   * 生成语义化摘要
   * - LLM 可用时：调用 LLM 生成不超过 30 字的中文摘要
   * - LLM 不可用 / 超时 / 失败时：降级为原始 description（陷阱 #138）
   *
   * 注意：本方法不会抛出异常，调用方无需 try/catch
   * @param description 原始检查点描述
   * @returns 语义化摘要（失败时返回原始 description）
   */
  async generateSummary(description: string): Promise<string> {
    // 无 LLM 客户端或模型 ID 时，降级为原始 description
    if (!this.llmClient || !this.llmModel) {
      return description;
    }

    try {
      // 陷阱 #138：必须设超时，避免 LLM 卡住阻塞检查点流程
      // 使用 Promise.race 实现 3 秒超时，超时后降级为原始 description
      const result = await Promise.race([
        this.llmClient!.complete({
          model: this.llmModel!,
          messages: [
            { role: 'user', content: `请为以下检查点生成简洁的中文摘要（不超过30字）：\n${description}` },
          ],
          systemPrompt: '你是一个检查点摘要生成器。根据检查点描述生成简洁的中文摘要，不超过30字。直接返回摘要文本，不要任何额外说明、引号或标点符号前缀。',
          maxTokens: 50,
          temperature: 0,
          timeoutMs: SUMMARY_TIMEOUT_MS,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Summary generation timeout after ${SUMMARY_TIMEOUT_MS}ms`)), SUMMARY_TIMEOUT_MS),
        ),
      ]);

      const summary = result.content.trim();
      // 空摘要或与原始描述相同则视为降级
      if (!summary) return description;
      return summary;
    } catch (error) {
      // 陷阱 #138：超时或失败时降级为原始 description，不抛出异常
      logger.warn('Checkpoint summary generation failed, falling back to description', {
        error: error instanceof Error ? error.message : String(error),
      });
      return description;
    }
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
   *  Phase 29 Task 4：添加工作区前置检查，防止丢失未提交的更改
   *
   *  V2-T01：回滚前备份当前 metadata 文件，失败时从备份恢复
   *  V2-T18：splice（内存变更）→ saveMetadata（落盘）顺序已确认正确；
   *          失败时用备份恢复内存中的 checkpoints 数组
   */
  async rollback(checkpointId: string): Promise<boolean> {
    if (!this.isRepo) return false;

    const checkpoint = this.checkpoints.find(c => c.id === checkpointId);
    if (!checkpoint) {
      logger.error('Checkpoint not found', { id: checkpointId });
      return false;
    }

    // 前置检查：工作区是否干净
    // 如果有未提交的更改，git reset --hard 会丢失这些更改，因此中止回滚
    try {
      const status = await this.git.status();
      // 修复：扩展检查覆盖所有 simple-git StatusResult 字段，避免漏判 staged/renamed/created/conflicted 等状态
      const hasUncommitted = status.modified.length > 0
        || status.not_added.length > 0
        || status.deleted.length > 0
        || status.staged.length > 0
        || status.renamed.length > 0
        || status.created.length > 0
        || status.conflicted.length > 0;

      if (hasUncommitted) {
        logger.error('回滚中止：工作区有未提交的更改。请先 stash 或 commit 后再回滚。', {
          modified: status.modified.length,
          not_added: status.not_added.length,
          deleted: status.deleted.length,
          staged: status.staged.length,
          renamed: status.renamed.length,
          created: status.created.length,
          conflicted: status.conflicted.length,
        });
        return false;
      }
    } catch (error) {
      // 安全修复：状态检查失败时 fail-closed，中止回滚
      // 原行为仅 warn 后继续执行 git reset --hard，可能丢失用户未提交的更改
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('回滚中止：工作区状态检查失败，拒绝执行 reset --hard（防止丢失未提交更改）', { error: msg });
      return false;
    }

    // V2-T01：备份当前 metadata 文件，失败时用于恢复
    // 备份内存中的 checkpoints 数组，用于 splice 后 saveMetadata 失败时回滚
    const backupPath = this.metadataPath + '.backup';
    let metadataBackedUp = false;
    try {
      const raw = await fs.readFile(this.metadataPath, 'utf-8');
      await safeWriteJSON(backupPath, JSON.parse(raw), { spaces: 2 });
      metadataBackedUp = true;
      logger.debug('Checkpoint metadata backed up before rollback', { backupPath });
    } catch (e) {
      // metadata 文件不存在（首次回滚）或读取失败——继续回滚但不具备恢复能力
      logger.warn('Failed to backup metadata before rollback, continuing without backup', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // 备份内存中的 checkpoints 快照（用于 splice 后失败时恢复）
    const checkpointsSnapshot = [...this.checkpoints];

    try {
      // git reset --hard 到检查点的 commit
      await this.git.reset(['--hard', checkpoint.gitCommitHash]);

      // V2-T18：先 splice 内存数组，再 saveMetadata 落盘
      // splice 返回被删除的元素，同时改变原数组
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

      // V2-T01：回滚失败时恢复内存状态
      this.checkpoints = checkpointsSnapshot;

      // 尝试从备份恢复 metadata 文件
      if (metadataBackedUp) {
        try {
          const raw = await fs.readFile(backupPath, 'utf-8');
          await safeWriteJSON(this.metadataPath, JSON.parse(raw), { spaces: 2 });
          logger.info('Checkpoint metadata restored from backup after rollback failure');
        } catch (restoreErr) {
          logger.error('Failed to restore metadata from backup', {
            error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          });
        }
      }

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

  /** 保存当前目标计划
   *
   *  V2-T11：使用原子写入（tmp + rename），防止写入过程中崩溃导致文件损坏
   *
   *  Phase 93 Task 8：写入 __schemaVersion 字段，供未来 migration 框架识别版本。
   */
  async saveGoalPlan(plan: GoalPlan): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.goalPlanPath), { recursive: true });
      // 标记当前 schema 版本，便于未来 load 时 migrate
      const data = withSchemaVersion(plan, GOAL_PLAN_SCHEMA_VERSION);
      await safeWriteJSON(this.goalPlanPath, data, { spaces: 2 });
      logger.debug('GoalPlan saved', { path: this.goalPlanPath });
    } catch (error) {
      logger.warn('Failed to save goal plan', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 加载上一次的目标计划
   *
   * Phase 93 Task 8：load 时先 migrate 升级到当前 schema 版本，再 parse 校验。
   * 当前版本 1，无迁移函数；未来版本升级时在此处追加 migrations 数组。
   */
  async loadGoalPlan(): Promise<GoalPlan | null> {
    try {
      const content = await fs.readFile(this.goalPlanPath, 'utf-8');
      const migrated = migrate(JSON.parse(content), {
        currentVersion: GOAL_PLAN_SCHEMA_VERSION,
        migrations: [], // 当前版本 1，无历史版本需要迁移
        fallback: null,
        caller: 'CheckpointManager.loadGoalPlan',
      });
      return parseGoalPlan(migrated);
    } catch (e) {
      // 目标计划文件不存在或损坏，降级返回 null（可能是首次启动）
      logger.warn('[checkpoint-manager] 加载目标计划失败', {
        goalPlanPath: this.goalPlanPath,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /** 清除已保存的目标计划 */
  async clearGoalPlan(): Promise<void> {
    try {
      await fs.unlink(this.goalPlanPath);
    } catch (e) {
      // 文件不存在视为正常；其他错误（权限不足）需记录日志
      logger.warn('[checkpoint-manager] 清除目标计划失败', {
        goalPlanPath: this.goalPlanPath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ===== 元数据持久化 =====

  /**
   * 修复：按项目隔离检查点元数据，避免多项目共用导致串项目污染
   * 用 workingDirectory 的简单 hash 作为 projectId
   */
  private getProjectId(): string {
    return crypto.createHash('md5').update(this.config.workingDirectory).digest('hex').slice(0, 12);
  }

  /** 解析元数据文件路径（可被测试覆盖） */
  protected resolveStoragePaths(): { metadataPath: string; goalPlanPath: string } {
    const dir = this.getStorageDir();
    return {
      // 修复：元数据文件名加入 projectId，按项目隔离
      metadataPath: path.join(dir, `metadata-${this.getProjectId()}.json`),
      goalPlanPath: path.join(dir, 'current-goal.json'),
    };
  }

  /** 获取存储目录（可被测试覆盖） */
  protected getStorageDir(): string {
    if (this.storageDirOverride) return this.storageDirOverride;
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
    } catch (e) {
      // 文件不存在或损坏：检查点元数据丢失，从空列表开始（可能影响回滚能力）
      logger.error('[checkpoint-manager] 加载检查点元数据失败，从空列表开始', {
        metadataPath: this.metadataPath,
        error: e instanceof Error ? e.message : String(e),
      });
      this.checkpoints = [];
    }
  }

  /**
   * V2-T05：使用原子写入（tmp + rename），防止写入过程中崩溃导致 metadata 文件损坏
   */
  private async saveMetadata(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });
      await safeWriteJSON(this.metadataPath, this.checkpoints, { spaces: 2 });
    } catch (error) {
      logger.warn('Failed to save checkpoint metadata', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
