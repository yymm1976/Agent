// @experimental 未接入生产路径
// @experimental 未接入生产路径 — 以下功能已实现并有测试覆盖，
// 但 goal-runner.ts 未 import 此模块。如需接入，请在 goal-runner 的
// executeSingleStep 成功后调用 appendProgress，在 resumeGoalPlan 中调用 getNextTaskToRun。
// 在接入前请补充集成测试。
// src/agent/progress-ledger.ts
// Phase 75-B2：Durable Progress Ledger
// 借鉴 Superpowers v6：append-only 进度日志，compaction 后从 ledger + git log 恢复
//
// 关键引述：
//   "Conversation memory does not survive compaction. In real sessions, controllers
//    that lost their place have re-dispatched entire completed task sequences —
//    the single most expensive failure observed."
//
// 机制：
//   1. task review clean 后 append 一行到 ledger（JSONL）
//   2. skill start 时读取 ledger 检查已完成 task
//   3. compaction 后从 ledger + git log 恢复执行位置
//   4. trust the ledger and git log over your own recollection
//
// 文件格式：JSONL（每行一个 JSON 对象），永不覆盖、永不删除条目。

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Ledger 条目：一个已完成 task 的记录 */
export interface ProgressEntry {
  /** task 标识（如 "task-1" / "75-A1"） */
  taskId: string;
  /** task 状态：complete / failed / blocked */
  status: 'complete' | 'failed' | 'blocked';
  /** task 完成时的 commit SHA（clean review 后） */
  commitSha?: string;
  /** review package 的 commit range（base..head） */
  commitRange?: { base: string; head: string };
  /** review 裁决：clean / fix-applied / cannot-verify */
  reviewVerdict?: 'clean' | 'fix-applied' | 'cannot-verify';
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 可选备注 */
  notes?: string;
}

/** 默认 ledger 文件路径（相对项目根，已被 .gitignore 排除） */
const DEFAULT_LEDGER_PATH = '.routedev/progress.jsonl';

/** 环境变量名：用于覆盖 ledger 路径（主要供测试使用） */
const LEDGER_PATH_ENV = 'ROUTEDEV_LEDGER_PATH';

/**
 * 获取 ledger 文件路径
 *
 * 优先级：
 *   1. 环境变量 ROUTEDEV_LEDGER_PATH（绝对路径）
 *   2. cwd 下的 .routedev/progress.jsonl
 *
 * @param cwd 工作目录（默认 process.cwd()）
 */
export function getLedgerPath(cwd: string = process.cwd()): string {
  const fromEnv = process.env[LEDGER_PATH_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return path.resolve(cwd, DEFAULT_LEDGER_PATH);
}

/**
 * 追加一条进度记录（append-only，永不覆盖）
 *
 * 语义保证：
 *   - 仅调用 fs.appendFile，不读取-修改-写回，天然无覆盖风险
 *   - 文件不存在时自动创建（含父目录 mkdir -p）
 *   - 并发安全：appendFile 在 POSIX 上对同一 fd 的 O_APPEND 写入是原子的
 *
 * @param entry 进度条目
 * @param cwd 工作目录（默认 process.cwd()）
 */
export async function appendProgress(entry: ProgressEntry, cwd?: string): Promise<void> {
  const ledgerPath = getLedgerPath(cwd);
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(ledgerPath, line, 'utf-8');
}

/**
 * 读取所有进度记录（按时间顺序：文件中的追加顺序）
 *
 * 错误处理：
 *   - 文件不存在（ENOENT）时返回空数组，非抛错
 *   - 其他 IO 错误向上抛出
 *   - 单行 JSON 解析失败跳过该行（不污染整批结果）
 *
 * @param cwd 工作目录（默认 process.cwd()）
 */
export async function readProgress(cwd?: string): Promise<ProgressEntry[]> {
  const ledgerPath = getLedgerPath(cwd);
  let content: string;
  try {
    content = await fs.readFile(ledgerPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const result: ProgressEntry[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      result.push(JSON.parse(trimmed) as ProgressEntry);
    } catch (e) {
      // 单行损坏跳过，保持 ledger 其余部分可用（resilience）
      // eslint-disable-next-line no-console
      console.warn(`[progress-ledger] 跳过损坏的行: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

/**
 * 查询指定 task 的最新状态
 *
 * 同一 task 可能有多条记录（重试、状态流转），取最后一条。
 *
 * @param taskId task 标识
 * @param cwd 工作目录（默认 process.cwd()）
 */
export async function getTaskStatus(
  taskId: string,
  cwd?: string,
): Promise<ProgressEntry | null> {
  const entries = await readProgress(cwd);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].taskId === taskId) return entries[i];
  }
  return null;
}

/**
 * 列出所有已完成的 task ID
 *
 * 去重 + 保留首次完成的顺序。
 * 仅收集 status === 'complete' 的条目。
 *
 * @param cwd 工作目录（默认 process.cwd()）
 */
export async function listCompletedTasks(cwd?: string): Promise<string[]> {
  const entries = await readProgress(cwd);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.status === 'complete' && !seen.has(entry.taskId)) {
      seen.add(entry.taskId);
      result.push(entry.taskId);
    }
  }
  return result;
}

/**
 * 恢复检查点：返回下一个应执行的 task
 *
 * 基于 ledger 中已完成的 task 集合，从 allTaskIds 中找出第一个未完成的。
 * 用于 compaction 后的恢复：trust the ledger over your own recollection。
 *
 * @param allTaskIds 完整的 task 执行计划（按顺序）
 * @param cwd 工作目录（默认 process.cwd()）
 * @returns 第一个未完成的 task ID；若全部完成则返回 null
 */
export async function getNextTaskToRun(
  allTaskIds: string[],
  cwd?: string,
): Promise<string | null> {
  const completed = new Set(await listCompletedTasks(cwd));
  for (const taskId of allTaskIds) {
    if (!completed.has(taskId)) return taskId;
  }
  return null;
}

/**
 * 诊断：统计 ledger 状态（用于调试和可观测性）
 *
 * @param cwd 工作目录（默认 process.cwd()）
 */
export async function diagnoseLedger(
  cwd?: string,
): Promise<{
  totalEntries: number;
  completedTasks: number;
  failedTasks: number;
  blockedTasks: number;
  lastEntry?: ProgressEntry;
}> {
  const entries = await readProgress(cwd);
  const completed = entries.filter((e) => e.status === 'complete');
  const failed = entries.filter((e) => e.status === 'failed');
  const blocked = entries.filter((e) => e.status === 'blocked');
  return {
    totalEntries: entries.length,
    completedTasks: completed.length,
    failedTasks: failed.length,
    blockedTasks: blocked.length,
    lastEntry: entries[entries.length - 1],
  };
}
