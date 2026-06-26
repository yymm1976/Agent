// src/harness/experiment-manager.ts
// 实验分支管理器：基于 Git Worktree 的实验分支管理
// 使用 child_process.execFile 调用 git（避免 shell 注入）
//
// 实验工作树放在 .routedev/experiments/<id>/ 目录
// experiment-registry.json 持久化在 .routedev/experiment-registry.json
//
// 实验分支基于当前 HEAD（不是检查点）
// 采纳实验用 git merge --no-ff，冲突时中止

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

export interface Experiment {
  /** 实验 ID（exp-001, exp-002, ...） */
  id: string;
  /** 实验名称 */
  name: string;
  /** git 分支名 */
  branch: string;
  /** worktree 路径（.routedev/experiments/exp-001） */
  worktreePath: string;
  /** 基于的分支 */
  baseBranch: string;
  /** 基于的 commit hash */
  baseCommit: string;
  /** 状态：active / adopted / discarded */
  status: 'active' | 'adopted' | 'discarded';
  /** 创建时间戳 */
  createdAt: number;
  /** 运行次数 */
  runCount: number;
  /** 最后运行时间戳 */
  lastRunAt?: number;
  /** 累计 token 用量 */
  tokenUsage?: number;
}

export interface ExperimentDiff {
  /** 实验 A */
  expA: Experiment;
  /** 实验 B */
  expB: Experiment;
  /** 变更文件数 */
  filesChanged: number;
  /** 新增行数 */
  additions: number;
  /** 删除行数 */
  deletions: number;
  /** unified diff 摘要（前 100 行） */
  diffSummary: string;
}

// ============================================================
// Phase 39 Task 3：分支编辑-审查-合并工作流接口
// ============================================================

/** 实验运行结果 */
export interface ExperimentRunResult {
  success: boolean;
  result: string;
  tokenUsage?: number;
  /** 变更文件列表（相对路径） */
  modifiedFiles: string[];
  error?: string;
}

/** 采纳实验结果 */
export interface AdoptResult {
  success: boolean;
  conflict?: boolean;
  message: string;
  /** 实际采纳的文件 */
  adoptedFiles?: string[];
}

/** 任务执行进度（供 UI 渲染） */
export interface TaskProgress {
  phase: 'running' | 'completed' | 'failed' | 'blocked';
  message?: string;
  modifiedFiles?: string[];
  tokenUsage?: number;
  duration?: number;
}

/** runInExperiment 的可选参数 */
export interface RunInExperimentOptions {
  agentType?: 'general' | 'coder';
  maxIterations?: number;
  onProgress?: (progress: TaskProgress) => void;
}

/** adoptExperiment 的可选参数 */
export interface AdoptOptions {
  /** 只合并这些文件（cherry-pick 策略时必需） */
  fileFilter?: string[];
  /** 合并策略：merge（全量合并）/ cherry-pick（选择性合并），默认 merge */
  strategy?: 'merge' | 'cherry-pick';
}

/**
 * ExperimentRunner 的最小接口（供 ExperimentManager 依赖，避免循环导入）
 * Phase 50 Task 8：experiment-runner.ts 已作为死代码移除，此接口保留供未来实现注入
 */
export interface ExperimentRunnerLike {
  runInWorktree(
    worktreePath: string,
    task: string,
    options?: {
      maxIterations?: number;
      onProgress?: (progress: TaskProgress) => void;
      signal?: AbortSignal;
    },
  ): Promise<ExperimentRunResult>;
}

export class ExperimentManager {
  /** 项目根目录 */
  private basePath: string;
  /** 实验列表（内存缓存） */
  private experiments: Experiment[] = [];
  /** 注册表文件路径（.routedev/experiment-registry.json） */
  private registryPath: string;
  /** 实验工作树父目录（.routedev/experiments/） */
  private experimentsDir: string;
  /**
   * Phase 39 Task 3：ExperimentRunner 实例（可选）
   * 注入后 runInExperiment 会在 worktree 中真正执行 Agent 任务
   * 未注入时回退到旧行为（仅记录任务描述），保持向后兼容
   */
  private runner: ExperimentRunnerLike | null = null;

  constructor(basePath: string) {
    this.basePath = basePath;
    this.experimentsDir = path.join(basePath, '.routedev', 'experiments');
    this.registryPath = path.join(basePath, '.routedev', 'experiment-registry.json');
    this.ensureGitignore();
    this.loadRegistry();
  }

  /**
   * Phase 39 Task 3：注入 ExperimentRunner
   * 注入后 runInExperiment 会在 worktree 中真正执行 Agent 任务
   */
  setExperimentRunner(runner: ExperimentRunnerLike | null): void {
    this.runner = runner;
  }

  /** 确保 .routedev/ 在 .gitignore 中（避免注册表/worktree 污染主工作区 git status） */
  private ensureGitignore(): void {
    try {
      const gitignorePath = path.join(this.basePath, '.gitignore');
      let content = '';
      try {
        content = fs.readFileSync(gitignorePath, 'utf-8');
      } catch {
        // .gitignore 不存在，创建新的
        content = '';
      }
      // 检查是否已包含 .routedev/ 规则
      const lines = content.split(/\r?\n/);
      const hasRule = lines.some(line => line.trim() === '.routedev/' || line.trim() === '.routedev');
      if (!hasRule) {
        const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(gitignorePath, `${prefix}.routedev/\n`, 'utf-8');
      }
    } catch (error) {
      // .gitignore 写入失败不阻塞功能，仅记录警告
      logger.warn('无法更新 .gitignore', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 同步加载注册表（构造函数中调用） */
  private loadRegistry(): void {
    try {
      const content = fs.readFileSync(this.registryPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        this.experiments = parsed;
      }
    } catch {
      // 文件不存在或损坏，从空列表开始
      this.experiments = [];
    }
  }

  /** 异步保存注册表到磁盘 */
  private async saveRegistry(): Promise<void> {
    try {
      await fsPromises.mkdir(path.dirname(this.registryPath), { recursive: true });
      await fsPromises.writeFile(
        this.registryPath,
        JSON.stringify(this.experiments, null, 2),
        'utf-8',
      );
    } catch (error) {
      logger.warn('保存实验注册表失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 生成递增 ID（exp-001, exp-002, ...） */
  private nextId(): string {
    let max = 0;
    for (const exp of this.experiments) {
      const match = exp.id.match(/^exp-(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return `exp-${String(max + 1).padStart(3, '0')}`;
  }

  /** 执行 git 命令（使用 execFile 避免 shell 注入） */
  private async execGit(
    args: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync('git', args, {
        cwd: cwd ?? this.basePath,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error: any) {
      // execFile 在非零退出码时 reject，保留 stdout/stderr 供调用方使用
      const err = new Error(
        `git ${args.join(' ')} failed: ${error.message ?? String(error)}`,
      ) as Error & { stdout: string; stderr: string; code?: number | string };
      err.stdout = error.stdout ?? '';
      err.stderr = error.stderr ?? '';
      err.code = error.code;
      throw err;
    }
  }

  /** 创建实验分支和 worktree
   *  1. 生成递增 ID
   *  2. 创建 git 分支：git branch <branch> <baseCommit>
   *  3. 创建 worktree：git worktree add <worktreePath> <branch>
   *  4. 写入 experiment-registry.json
   */
  async createExperiment(name: string, baseBranch?: string): Promise<Experiment> {
    const id = this.nextId();
    const branch = `experiment/${id}`;

    // 确定基础 commit（基于当前 HEAD 或指定分支）
    const base = baseBranch ?? 'HEAD';
    const baseCommitResult = await this.execGit(['rev-parse', base]);
    const baseCommit = baseCommitResult.stdout.trim();

    // 获取基础分支名（用于记录）
    let baseBranchName: string;
    if (baseBranch) {
      baseBranchName = baseBranch;
    } else {
      const branchResult = await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
      baseBranchName = branchResult.stdout.trim();
    }

    // 确保 experiments 目录存在
    const worktreePath = path.join(this.experimentsDir, id);
    await fsPromises.mkdir(this.experimentsDir, { recursive: true });

    // 创建 git 分支：git branch <branch> <baseCommit>
    await this.execGit(['branch', branch, baseCommit]);

    // 创建 worktree：git worktree add <worktreePath> <branch>
    await this.execGit(['worktree', 'add', worktreePath, branch]);

    const experiment: Experiment = {
      id,
      name,
      branch,
      worktreePath,
      baseBranch: baseBranchName,
      baseCommit,
      status: 'active',
      createdAt: Date.now(),
      runCount: 0,
    };

    this.experiments.push(experiment);
    await this.saveRegistry();

    logger.info('实验已创建', { id, name, branch, worktreePath });
    return experiment;
  }

  /** 在实验分支上运行任务
   *  Phase 39 Task 3 增强：
   *    - 注入了 ExperimentRunner 时，在 worktree 中真正执行 Agent 任务
   *    - 未注入时回退到旧行为（仅记录任务描述），保持向后兼容
   *
   *  @param expId 实验 ID
   *  @param task 任务描述
   *  @param options 可选参数（agentType、maxIterations、onProgress）
   *  @returns ExperimentRunResult
   */
  async runInExperiment(
    expId: string,
    task: string,
    options?: RunInExperimentOptions,
  ): Promise<ExperimentRunResult> {
    const exp = this.experiments.find(e => e.id === expId);
    if (!exp) {
      return {
        success: false,
        result: `未找到实验 "${expId}"`,
        modifiedFiles: [],
        error: `未找到实验 "${expId}"`,
      };
    }
    if (exp.status !== 'active') {
      return {
        success: false,
        result: `实验 "${expId}" 状态为 ${exp.status}，无法运行`,
        modifiedFiles: [],
        error: `实验状态为 ${exp.status}`,
      };
    }

    // 更新运行计数和时间戳
    exp.runCount += 1;
    exp.lastRunAt = Date.now();
    await this.saveRegistry();

    // 未注入 runner：回退到旧行为（仅记录）
    if (!this.runner) {
      logger.info('任务已在实验中记录（未注入 runner，跳过实际执行）', {
        expId,
        task: task.slice(0, 80),
      });
      return {
        success: true,
        result: `任务已在实验 ${expId} 中记录（未注入 runner，实际执行由调用方处理）`,
        tokenUsage: 0,
        modifiedFiles: [],
      };
    }

    // 注入了 runner：在 worktree 中真正执行
    const startTime = Date.now();
    try {
      options?.onProgress?.({
        phase: 'running',
        message: `在实验 ${expId} 中执行任务`,
      });

      const runResult = await this.runner.runInWorktree(exp.worktreePath, task, {
        maxIterations: options?.maxIterations,
        onProgress: options?.onProgress,
      });

      // 累计 token 用量
      if (runResult.tokenUsage) {
        exp.tokenUsage = (exp.tokenUsage ?? 0) + runResult.tokenUsage;
        await this.saveRegistry();
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      options?.onProgress?.({
        phase: runResult.success ? 'completed' : 'failed',
        message: runResult.result,
        modifiedFiles: runResult.modifiedFiles,
        tokenUsage: runResult.tokenUsage,
        duration,
      });

      logger.info('实验任务执行完成', {
        expId,
        success: runResult.success,
        modifiedFiles: runResult.modifiedFiles.length,
        duration,
      });

      return runResult;
    } catch (error: any) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      const errorMsg = error instanceof Error ? error.message : String(error);
      options?.onProgress?.({
        phase: 'failed',
        message: errorMsg,
        duration,
      });
      logger.error('实验任务执行失败', { expId, error: errorMsg });
      return {
        success: false,
        result: `执行失败: ${errorMsg}`,
        modifiedFiles: [],
        error: errorMsg,
      };
    }
  }

  /** 对比两个实验分支的差异 */
  async compareExperiments(expA: string, expB: string): Promise<ExperimentDiff> {
    const a = this.experiments.find(e => e.id === expA);
    const b = this.experiments.find(e => e.id === expB);
    if (!a) throw new Error(`未找到实验 "${expA}"`);
    if (!b) throw new Error(`未找到实验 "${expB}"`);

    // 使用 git diff --numstat 获取统计信息
    // 输出格式：<additions>\t<deletions>\t<filename>
    const numstatResult = await this.execGit([
      'diff',
      '--numstat',
      a.branch,
      b.branch,
    ]);
    const numstat = numstatResult.stdout.trim();

    let filesChanged = 0;
    let additions = 0;
    let deletions = 0;
    if (numstat) {
      for (const line of numstat.split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          filesChanged += 1;
          // 二进制文件显示为 "-"
          const add = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
          const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
          if (!isNaN(add)) additions += add;
          if (!isNaN(del)) deletions += del;
        }
      }
    }

    // 获取 unified diff 摘要（前 100 行）
    const diffResult = await this.execGit(['diff', a.branch, b.branch]);
    const diffLines = diffResult.stdout.split('\n').slice(0, 100);
    const diffSummary = diffLines.join('\n');

    return {
      expA: a,
      expB: b,
      filesChanged,
      additions,
      deletions,
      diffSummary,
    };
  }

  /** 采纳实验（合并到当前分支）
   *  Phase 39 Task 3 增强：支持选择性合并
   *    - merge 策略（默认）：git merge --no-ff <branch>（全量合并）
   *    - cherry-pick 策略：对 fileFilter 中每个文件执行 git checkout <branch> -- <file>，
   *      然后 git add + git commit
   *
   *  1. 采纳前检查主工作区脏状态
   *  2. 根据策略执行合并
   *  3. 冲突时中止并返回 conflict
   *  4. 成功后标记 status='adopted'
   */
  async adoptExperiment(
    expId: string,
    options?: AdoptOptions,
  ): Promise<AdoptResult> {
    const exp = this.experiments.find(e => e.id === expId);
    if (!exp) {
      return { success: false, message: `未找到实验 "${expId}"` };
    }
    if (exp.status !== 'active') {
      return {
        success: false,
        message: `实验 "${expId}" 状态为 ${exp.status}，无法采纳`,
      };
    }

    // 采纳前检查主工作区脏状态，避免 merge 失败或污染
    const statusResult = await this.execGit(['status', '--porcelain']);
    const isDirty = statusResult.stdout.trim().length > 0;
    if (isDirty) {
      return {
        success: false,
        message: '主工作区有未提交变更，请先 commit 或 stash 后再采纳实验',
      };
    }

    const strategy = options?.strategy ?? 'merge';

    if (strategy === 'cherry-pick') {
      return this.adoptCherryPick(exp, options?.fileFilter ?? []);
    }

    // merge 策略：git merge --no-ff <branch>（全量合并）
    try {
      await this.execGit([
        'merge',
        '--no-ff',
        exp.branch,
        '-m',
        `采纳实验 ${exp.id}: ${exp.name}`,
      ]);
    } catch {
      // 合并失败（非零退出码），中止合并
      try {
        await this.execGit(['merge', '--abort']);
      } catch {
        // 忽略 abort 错误（可能没有正在进行的合并）
      }
      return {
        success: false,
        conflict: true,
        message: `合并冲突：实验 ${expId} 与当前分支存在冲突，已中止合并`,
      };
    }

    // 成功后标记 status='adopted'
    exp.status = 'adopted';
    await this.saveRegistry();

    logger.info('实验已采纳（merge 策略）', { expId, branch: exp.branch });
    return {
      success: true,
      message: `实验 ${expId} 已采纳（合并到当前分支）`,
    };
  }

  /**
   * cherry-pick 策略：选择性合并指定文件
   * 对 fileFilter 中每个文件执行 git checkout <branch> -- <file>，然后 git add + git commit
   */
  private async adoptCherryPick(
    exp: Experiment,
    fileFilter: string[],
  ): Promise<AdoptResult> {
    if (fileFilter.length === 0) {
      return {
        success: false,
        message: `cherry-pick 策略需要指定 fileFilter（至少一个文件）`,
      };
    }

    const adoptedFiles: string[] = [];
    const missingFiles: string[] = [];

    // 对每个文件执行 git checkout <branch> -- <file>
    for (const file of fileFilter) {
      try {
        await this.execGit(['checkout', exp.branch, '--', file]);
        adoptedFiles.push(file);
      } catch {
        // 文件在实验分支中不存在或 checkout 失败
        missingFiles.push(file);
        logger.warn('cherry-pick: 文件 checkout 失败', {
          expId: exp.id,
          file,
          branch: exp.branch,
        });
      }
    }

    if (adoptedFiles.length === 0) {
      return {
        success: false,
        message: `cherry-pick 失败：所有文件均无法从分支 ${exp.branch} checkout${missingFiles.length > 0 ? `（缺失: ${missingFiles.join(', ')}）` : ''}`,
      };
    }

    // git add 已 checkout 的文件
    try {
      await this.execGit(['add', ...adoptedFiles]);
    } catch (error: any) {
      return {
        success: false,
        message: `git add 失败: ${error.message ?? String(error)}`,
      };
    }

    // git commit
    const fileSummary = adoptedFiles.length === fileFilter.length
      ? `${adoptedFiles.length} 个文件`
      : `${adoptedFiles.length}/${fileFilter.length} 个文件`;
    try {
      await this.execGit([
        'commit',
        '-m',
        `采纳实验 ${exp.id}（cherry-pick）: ${exp.name}（${fileSummary}）`,
      ]);
    } catch (error: any) {
      // commit 失败可能是没有变更（文件内容与当前分支一致）
      // 此时仍视为成功（文件已 checkout 到工作区）
      logger.warn('cherry-pick: commit 失败（可能无变更）', {
        expId: exp.id,
        error: error.message,
      });
    }

    // 标记 status='adopted'
    exp.status = 'adopted';
    await this.saveRegistry();

    logger.info('实验已采纳（cherry-pick 策略）', {
      expId: exp.id,
      adoptedFiles,
      missingFiles,
    });

    const missingNote = missingFiles.length > 0
      ? `，${missingFiles.length} 个文件未找到`
      : '';
    return {
      success: true,
      message: `实验 ${exp.id} 已采纳（cherry-pick: ${fileSummary}${missingNote}）`,
      adoptedFiles,
    };
  }

  /** 丢弃实验（清理 worktree 和分支）
   *  1. git worktree remove <worktreePath> --force
   *  2. git branch -D <branch>
   *  3. 标记 status='discarded'
   */
  async discardExperiment(expId: string): Promise<void> {
    const exp = this.experiments.find(e => e.id === expId);
    if (!exp) {
      throw new Error(`未找到实验 "${expId}"`);
    }

    // git worktree remove <worktreePath> --force
    try {
      await this.execGit(['worktree', 'remove', exp.worktreePath, '--force']);
    } catch (error: any) {
      logger.warn('移除 worktree 失败', {
        worktreePath: exp.worktreePath,
        error: error.message,
      });
    }

    // git branch -D <branch>
    try {
      await this.execGit(['branch', '-D', exp.branch]);
    } catch (error: any) {
      logger.warn('删除分支失败', {
        branch: exp.branch,
        error: error.message,
      });
    }

    // 标记 status='discarded'
    exp.status = 'discarded';
    await this.saveRegistry();

    logger.info('实验已丢弃', { expId, branch: exp.branch });
  }

  /** 列出所有实验 */
  listExperiments(): Experiment[] {
    return [...this.experiments];
  }

  /** 获取指定实验 */
  getExperiment(id: string): Experiment | null {
    return this.experiments.find(e => e.id === id) ?? null;
  }

  /**
   * Phase 39 Task 3：获取 worktree 中的变更文件列表
   * 合并 git diff HEAD（已暂存+未暂存）和 untracked 文件，去重
   *
   * @param worktreePath worktree 路径（可选，默认用主工作区）
   * @returns 变更文件相对路径列表
   */
  async getModifiedFiles(worktreePath?: string): Promise<string[]> {
    const cwd = worktreePath ?? this.basePath;
    const files = new Set<string>();

    // git diff --name-only HEAD（已跟踪文件的变更：已暂存 + 未暂存）
    try {
      const trackedResult = await this.execGit(
        ['diff', '--name-only', 'HEAD'],
        cwd,
      );
      const tracked = trackedResult.stdout.trim();
      if (tracked) {
        for (const line of tracked.split('\n')) {
          const f = line.trim();
          if (f) files.add(f);
        }
      }
    } catch {
      // HEAD 不存在（空仓库）或其他错误，忽略
    }

    // git ls-files --others --exclude-standard（未跟踪文件，排除 .gitignore）
    try {
      const untrackedResult = await this.execGit(
        ['ls-files', '--others', '--exclude-standard'],
        cwd,
      );
      const untracked = untrackedResult.stdout.trim();
      if (untracked) {
        for (const line of untracked.split('\n')) {
          const f = line.trim();
          if (f) files.add(f);
        }
      }
    } catch {
      // 忽略错误
    }

    return Array.from(files).sort();
  }

  /**
   * Phase 39 Task 3：获取实验分支相对于 baseCommit 的变更文件列表
   *
   * @param expId 实验 ID
   * @returns 变更文件相对路径列表
   */
  async getExperimentModifiedFiles(expId: string): Promise<string[]> {
    const exp = this.experiments.find(e => e.id === expId);
    if (!exp) {
      throw new Error(`未找到实验 "${expId}"`);
    }
    try {
      const result = await this.execGit([
        'diff',
        '--name-only',
        `${exp.baseCommit}..${exp.branch}`,
      ]);
      const output = result.stdout.trim();
      if (!output) return [];
      return output.split('\n').map(f => f.trim()).filter(Boolean).sort();
    } catch {
      return [];
    }
  }

  /**
   * Phase 39 Task 3：获取实验分支中指定文件的 diff 内容
   *
   * @param expId 实验 ID
   * @param file 文件相对路径（可选，不传则返回全部 diff）
   * @returns unified diff 文本
   */
  async getExperimentDiff(expId: string, file?: string): Promise<string> {
    const exp = this.experiments.find(e => e.id === expId);
    if (!exp) {
      throw new Error(`未找到实验 "${expId}"`);
    }
    const args = ['diff', `${exp.baseCommit}..${exp.branch}`];
    if (file) {
      args.push('--', file);
    }
    const result = await this.execGit(args);
    return result.stdout;
  }
}
