// src/code-map/watcher.ts
// Phase 71 Task A5：文件监听 + 去抖动 + 增量索引触发
//
// TD-18：使用 Node.js 原生 fs.watch（recursive: true，Node 22+ 稳定支持）
// + 自动重连机制（watch error 后延迟重试，最多 5 次）
// 不再依赖 chokidar——Node 22 的 fs.watch 在 Windows 使用 ReadDirectoryChangesW
// 已足够稳定，chokidar v4 内部也是 fs.watch 封装，无需额外依赖
// fail-open 原则：启动失败 / 增量索引失败均不阻塞主流程，只记日志

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { incrementalIndex } from './indexer.js';

/** 监听的文件扩展名（.ts/.js/.tsx/.jsx） */
const WATCHED_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx']);

/** 排除的目录名（与 indexer.ts EXCLUDED_DIRS 对齐，避免监听无关变更） */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.routedev',
  '.routedev-wts',
  'coverage',
  '__pycache__',
  '.next',
  'release-v',
]);

/** 去抖动延迟（毫秒），避免连续保存触发多次索引 */
const DEBOUNCE_MS = 300;

/** watch error 后重连延迟（毫秒） */
const RECONNECT_DELAY_MS = 3_000;

/** 最大重连次数（超过后停止重试，避免无限循环） */
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * 代码地图文件监听器
 *
 * 监听项目目录下的源码文件变更，触发增量索引（去抖动 300ms）。
 * 启动失败、索引失败均 fail-open，不影响主流程。
 * watch error 时自动重连（最多 5 次，每次延迟 3 秒）。
 * 进程退出时必须调用 close() 释放 fs.watch 句柄。
 */
export class CodeMapWatcher {
  private rootDir: string;
  private dbPath: string;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingFiles = new Set<string>();
  private active = false;
  private reconnectAttempts = 0;

  constructor(rootDir: string, dbPath: string) {
    this.rootDir = rootDir;
    this.dbPath = dbPath;
  }

  /** 启动文件监听 */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.reconnectAttempts = 0;
    this.startWatching();
  }

  /** 实际创建 fs.watch 句柄的内部方法 */
  private startWatching(): void {
    try {
      // recursive: true 在 Node 22+ 的 macOS/Windows 上原生支持
      this.watcher = fs.watch(
        this.rootDir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          // 按扩展名过滤
          const ext = path.extname(filename).toLowerCase();
          if (!WATCHED_EXTENSIONS.has(ext)) return;
          // 按排除目录过滤
          const parts = filename.split(/[\\/]/);
          if (parts.some(p => EXCLUDED_DIRS.has(p) || p.startsWith('release-v'))) return;

          const fullPath = path.resolve(this.rootDir, filename);
          this.pendingFiles.add(fullPath);
          this.scheduleIncrementalIndex();
        },
      );

      this.watcher.on('error', (err: unknown) => {
        // watch 内部错误（如句柄失效）——尝试重连而非仅记日志
        logger.warn('CodeMapWatcher: watch error, attempting reconnect', {
          error: err instanceof Error ? err.message : String(err),
          attempt: this.reconnectAttempts + 1,
        });
        this.scheduleReconnect();
      });

      // 重连成功后重置计数
      this.reconnectAttempts = 0;
      logger.info('CodeMapWatcher: started', { rootDir: this.rootDir });
    } catch (error) {
      // fail-open：启动失败不阻塞主流程，但尝试重连
      logger.warn('CodeMapWatcher: failed to start, attempting reconnect', {
        error: error instanceof Error ? error.message : String(error),
        attempt: this.reconnectAttempts + 1,
      });
      this.scheduleReconnect();
    }
  }

  /** 调度重连（延迟 3 秒，最多 5 次） */
  private scheduleReconnect(): void {
    // 先清理旧句柄
    if (this.watcher) {
      try { this.watcher.close(); } catch (e) { logger.debug('watcher close failed', { error: e instanceof Error ? e.message : String(e) }); }
      this.watcher = null;
    }

    if (!this.active) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error('CodeMapWatcher: max reconnect attempts reached, giving up', {
        attempts: this.reconnectAttempts,
      });
      this.active = false;
      return;
    }

    this.reconnectAttempts++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) {
        logger.info('CodeMapWatcher: reconnecting', { attempt: this.reconnectAttempts });
        this.startWatching();
      }
    }, RECONNECT_DELAY_MS);
  }

  /** 去抖动调度增量索引 */
  private scheduleIncrementalIndex(): void {
    if (!this.active) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.triggerIncrementalIndex();
    }, DEBOUNCE_MS);
  }

  /** 触发增量索引（fail-open：失败只记日志） */
  private async triggerIncrementalIndex(): Promise<void> {
    if (!this.active) return;
    const files = Array.from(this.pendingFiles);
    this.pendingFiles.clear();
    if (files.length === 0) return;

    try {
      await incrementalIndex(this.rootDir, files, { dbPath: this.dbPath });
      logger.info('CodeMapWatcher: incremental index completed', {
        fileCount: files.length,
      });
    } catch (error) {
      // fail-open：增量索引失败只记日志，不影响后续监听
      logger.warn('CodeMapWatcher: incremental index failed', {
        error: error instanceof Error ? error.message : String(error),
        fileCount: files.length,
      });
    }
  }

  /** 关闭监听器，释放 fs.watch 句柄（进程退出时必须调用） */
  close(): void {
    this.active = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pendingFiles.clear();
  }
}
