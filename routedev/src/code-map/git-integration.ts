// src/code-map/git-integration.ts
// Phase 71 Task A3：git diff 种子提取
// 为 Personalized PageRank 提供种子节点（最近提交变更文件对应的符号）

import simpleGit from 'simple-git';
import type { DB } from './database.js';
import { logger } from '../utils/logger.js';

/**
 * 内存级种子缓存：按 DB 实例隔离
 *
 * 选用 WeakMap 而非 metadata 表的原因：
 *   1. database.ts 现有 schema 无 metadata 表，新增表需迁移已有 DB
 *   2. 种子是短期上下文信号（随 git 变更频繁失效），无需持久化
 *   3. WeakMap 随 DB 实例回收自动清理，无内存泄漏风险
 *
 * 写入点：refreshGitSeedCache（middleware 在 ensureIndex 后异步调用）
 * 读取点：getSeedNodeIdsFromCache（querier.explore 同步调用）
 */
const gitSeedCache = new WeakMap<DB, Set<string>>();

/**
 * 获取最近 N 次提交涉及的文件，返回符号节点 id 集合作为 PPR 种子
 *
 * @param db 代码地图数据库
 * @param cwd 工作目录（git 仓库根）
 * @param recentCommits 回溯的提交数（默认 5）
 * @returns 种子节点 ID 集合；非 git 仓库或失败时返回空集合（fail-open）
 */
export async function getSeedNodeIdsFromGit(
  db: DB,
  cwd: string,
  recentCommits = 5,
): Promise<Set<string>> {
  try {
    const git = simpleGit(cwd);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return new Set();

    // HEAD~N..HEAD 的文件列表；N 大于提交数时会失败，需 catch
    let diff: string;
    try {
      diff = await git.diff(['--name-only', `HEAD~${recentCommits}..HEAD`]);
    } catch {
      // 提交数不足时回退到工作区未提交差异
      diff = await git.diff(['--name-only']);
    }
    const changedFiles = diff.split('\n').filter(Boolean);

    const seeds = new Set<string>();
    const stmt = db.prepare('SELECT id FROM nodes WHERE file_path = ?');
    for (const file of changedFiles) {
      const rows = stmt.all(file) as Array<{ id: string }>;
      for (const row of rows) seeds.add(row.id);
    }
    return seeds;
  } catch {
    return new Set(); // fail-open
  }
}

/**
 * 同步版本：从内存缓存读取已预填充的种子节点 ID 集合
 * 供 explore 同步函数使用；缓存未命中时返回空集合（fail-open，回退到原 rankScore 排序）
 */
export function getSeedNodeIdsFromCache(db: DB): Set<string> {
  try {
    return gitSeedCache.get(db) ?? new Set();
  } catch (e) {
    // 缓存读取失败（WeakMap 异常极少见），返回空集合
    logger.warn('[git-integration] getSeedNodeIdsFromCache: 读取缓存失败', { error: e instanceof Error ? e.message : String(e) });
    return new Set();
  }
}

/** 异步刷新 git seeds 缓存（供 middleware 在 ensureIndex 后定期调用） */
export async function refreshGitSeedCache(
  db: DB,
  cwd: string,
  recentCommits = 5,
): Promise<void> {
  try {
    const seeds = await getSeedNodeIdsFromGit(db, cwd, recentCommits);
    gitSeedCache.set(db, seeds);
  } catch (e) {
    // fail-open：缓存更新失败时保留旧值或空集合，不抛错
    logger.warn('[git-integration] refreshGitSeedCache: 缓存更新失败', { error: e instanceof Error ? e.message : String(e) });
  }
}
