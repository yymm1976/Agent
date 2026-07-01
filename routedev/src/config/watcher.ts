// src/config/watcher.ts
// 配置文件热重载（最终一致：不阻塞当前请求，下次请求使用新配置）

import fs from 'node:fs';
import EventEmitter from 'node:events';
import { logger } from '../utils/logger.js';

export interface ConfigWatcherOptions {
  debounceMs?: number;
}

export class ConfigWatcher extends EventEmitter {
  private filePath: string;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private debounceMs: number;
  private active = false;

  constructor(filePath: string, options: ConfigWatcherOptions = {}) {
    super();
    this.filePath = filePath;
    this.debounceMs = options.debounceMs ?? 500;
  }

  start(): void {
    if (this.active) return;

    this.active = true;

    this.startWatching();

    logger.info('ConfigWatcher: started', { filePath: this.filePath });
  }

  /**
   * I10 修复：启动 fs.watch，同时监听 'change' 和 'rename' 事件。
   * rename 事件在配置文件被替换（如编辑器保存、原子写入）时触发，
   * 此时原 watcher 失效，需要重新 watch 新文件。
   */
  private startWatching(): void {
    if (!this.active) return;

    try {
      this.watcher = fs.watch(this.filePath, (eventType) => {
        // 同时处理 change 和 rename 事件
        // rename：文件被替换（编辑器保存、原子写入 rename），原 watcher 可能已失效
        if (eventType === 'rename') {
          // 关闭旧 watcher，重新监听新文件
          if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
          }
          // 延迟重新 watch，避免文件还未完全创建
          if (this.restartTimer) {
            clearTimeout(this.restartTimer);
          }
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.active) return;
            this.startWatching();
            this.scheduleReload();
          }, 100);
          return;
        }
        // change 事件：文件内容被修改
        this.scheduleReload();
      });
    } catch (error) {
      logger.warn('ConfigWatcher: failed to start', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  stop(): void {
    this.active = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleReload(): void {
    if (!this.active) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.emit('reload');
    }, this.debounceMs);
  }
}
