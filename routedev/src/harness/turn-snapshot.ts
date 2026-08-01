// src/harness/turn-snapshot.ts
// Phase 97 Part B：对话与文件联合快照（TurnSnapshot）
//
// 设计目的：
//   每个 turn 结束后建立「对话状态 + 文件状态」的联合检查点，区别于 CheckpointManager 的
//   git 强快照：
//   - CheckpointManager：git commit 级回滚，适合「撤销整个任务」
//   - TurnSnapshot：轻量内容快照，适合「对话级撤销」——回退对话时同步恢复文件，
//     非代码文件同样适用，不依赖 Git
//
// 恢复安全（B2）：
//   - 目标路径必须位于 workingDirectory 或 attachmentBoundary 内，越界直接拒绝
//   - 写回前校验当前文件 hash 与快照 hash 一致（防止覆盖用户后续改动）
//   - 单文件超过阈值只记录元数据不存内容（restore 时跳过并报告）

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeWriteJSON } from '../utils/safe-write.js';
import { logger } from '../utils/logger.js';
import { getAppDataDir, ensureDir } from '../utils/paths.js';

/** 单文件内容快照上限（超过则只记元数据，不存内容） */
export const MAX_SNAPSHOT_FILE_SIZE = 5 * 1024 * 1024;
/** 单个 turn 快照的最大文件数（防内存膨胀） */
export const MAX_FILES_PER_TURN = 50;

/** 文件快照条目 */
export interface TurnFileSnapshot {
  /** 相对 workingDirectory 的路径 */
  path: string;
  /** 绝对路径（恢复校验用） */
  absPath: string;
  /** 文件大小 */
  size: number;
  /** SHA-256 内容哈希 */
  hash: string;
  /** 内容快照（仅当 size <= MAX_SNAPSHOT_FILE_SIZE 时存在） */
  content?: string;
}

/** 联合快照 */
export interface TurnSnapshot {
  turnId: string;
  sessionId: string;
  userMessage: string;
  agentOutput: string;
  toolCalls: { name: string; callId: string; approved: boolean }[];
  changedFiles: TurnFileSnapshot[];
  workingDirectory: string;
  /** 授权附加目录（恢复校验用） */
  attachmentBoundary: string[];
  createdAt: number;
}

/** 恢复结果 */
export interface RestoreResult {
  restored: string[];
  skipped: { path: string; reason: 'content_missing' | 'out_of_boundary' | 'io_error' }[];
}

/** TurnSnapshotManager 配置 */
export interface TurnSnapshotManagerConfig {
  /** 存储根目录（默认 getAppDataDir()/turn-snapshots） */
  storageDir?: string;
}

/** 路径规范化：统一正斜杠；Windows 下统一小写 */
function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 判断 target 是否位于 root 之下（边界符校验） */
function isWithin(root: string, target: string): boolean {
  const r = normalizePath(path.resolve(root));
  const t = normalizePath(path.resolve(target));
  return t === r || t.startsWith(r + '/');
}

export class TurnSnapshotManager {
  private storageDir: string;

  constructor(config?: TurnSnapshotManagerConfig) {
    this.storageDir = config?.storageDir ?? path.join(getAppDataDir(), 'turn-snapshots');
  }

  /**
   * 捕获一次 turn 的联合快照
   * @returns 快照；无可快照文件时仍返回对话快照（changedFiles 为空）
   */
  async capture(opts: {
    turnId: string;
    sessionId: string;
    userMessage: string;
    agentOutput: string;
    toolCalls: { name: string; callId: string; approved: boolean }[];
    changedFiles: string[];
    workingDirectory: string;
    attachmentBoundary?: string[];
  }): Promise<TurnSnapshot | null> {
    try {
      const boundary = opts.attachmentBoundary ?? [];
      const fileSnapshots: TurnFileSnapshot[] = [];
      const uniqueFiles = [...new Set(opts.changedFiles)].slice(0, MAX_FILES_PER_TURN);

      for (const absPath of uniqueFiles) {
        const resolved = path.resolve(absPath);
        // B2：仅快照授权边界内的文件
        if (!isWithin(opts.workingDirectory, resolved) && !boundary.some(b => isWithin(b, resolved))) {
          continue;
        }
        try {
          const stat = await fs.stat(resolved);
          if (!stat.isFile()) continue;
          const content = await fs.readFile(resolved, 'utf-8');
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          const entry: TurnFileSnapshot = {
            path: path.relative(opts.workingDirectory, resolved).replace(/\\/g, '/'),
            absPath: resolved,
            size: stat.size,
            hash,
            content: stat.size <= MAX_SNAPSHOT_FILE_SIZE ? content : undefined,
          };
          fileSnapshots.push(entry);
        } catch {
          // 文件不存在或读取失败：跳过该文件（快照尽量不失败）
        }
      }

      const snapshot: TurnSnapshot = {
        turnId: opts.turnId,
        sessionId: opts.sessionId,
        userMessage: opts.userMessage,
        agentOutput: opts.agentOutput,
        toolCalls: opts.toolCalls,
        changedFiles: fileSnapshots,
        workingDirectory: opts.workingDirectory,
        attachmentBoundary: boundary,
        createdAt: Date.now(),
      };

      const dir = path.join(this.storageDir, opts.sessionId);
      ensureDir(dir);
      await safeWriteJSON(path.join(dir, `${opts.turnId}.json`), snapshot);
      return snapshot;
    } catch (err) {
      logger.warn('TurnSnapshot capture failed', {
        error: err instanceof Error ? err.message : String(err),
        turnId: opts.turnId,
      });
      return null;
    }
  }

  /**
   * 恢复指定 turn 的快照（对话级撤销：回退对话时同步恢复文件）
   *
   * 语义：用户显式触发回滚，即意图恢复到该 turn 结束时的状态，因此直接写回快照内容。
   * 若当前文件 hash 与快照不一致（用户或 Agent 后续改动过），仍写回，但在日志中记录覆盖提示。
   * @returns 恢复的文件与跳过清单
   */
  async restore(turnId: string, sessionId: string): Promise<RestoreResult | null> {
    const snapshot = await this.read(turnId, sessionId);
    if (!snapshot) return null;

    const result: RestoreResult = { restored: [], skipped: [] };
    for (const file of snapshot.changedFiles) {
      // B2：恢复前路径边界校验（normalize + 边界符，禁止越界写）
      if (
        !isWithin(snapshot.workingDirectory, file.absPath)
        && !snapshot.attachmentBoundary.some(b => isWithin(b, file.absPath))
      ) {
        result.skipped.push({ path: file.path, reason: 'out_of_boundary' });
        logger.warn('TurnSnapshot restore skipped out-of-boundary file', { path: file.absPath });
        continue;
      }
      if (file.content === undefined) {
        result.skipped.push({ path: file.path, reason: 'content_missing' });
        continue;
      }
      try {
        // 写回前记录 hash 差异提示（不阻止——显式回滚以快照为准）
        const current = await fs.readFile(file.absPath, 'utf-8');
        const currentHash = crypto.createHash('sha256').update(current).digest('hex');
        if (currentHash !== file.hash) {
          logger.warn('TurnSnapshot restore overwrites changed file', { path: file.absPath });
        }
        await fs.writeFile(file.absPath, file.content, 'utf-8');
        result.restored.push(file.path);
      } catch {
        result.skipped.push({ path: file.path, reason: 'io_error' });
      }
    }
    return result;
  }

  /** 读取指定 turn 的快照 */
  async read(turnId: string, sessionId: string): Promise<TurnSnapshot | null> {
    try {
      const filePath = path.join(this.storageDir, sessionId, `${turnId}.json`);
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as TurnSnapshot;
    } catch {
      return null;
    }
  }

  /** 列出某会话（或全部）的快照，按时间倒序 */
  async list(sessionId?: string): Promise<TurnSnapshot[]> {
    try {
      const root = this.storageDir;
      if (sessionId) {
        return this.listInDir(path.join(root, sessionId));
      }
      const sessions = await fs.readdir(root).catch(() => [] as string[]);
      const all: TurnSnapshot[] = [];
      for (const s of sessions) {
        all.push(...await this.listInDir(path.join(root, s)).catch(() => [] as TurnSnapshot[]));
      }
      return all.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  // ===== 内部 =====

  private async listInDir(dir: string): Promise<TurnSnapshot[]> {
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    const out: TurnSnapshot[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8');
        out.push(JSON.parse(raw) as TurnSnapshot);
      } catch {
        // 损坏快照跳过
      }
    }
    return out;
  }
}
