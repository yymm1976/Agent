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
  private debounceMs: number;

  constructor(filePath: string, options: ConfigWatcherOptions = {}) {
    super();
    this.filePath = filePath;
    this.debounceMs = options.debounceMs ?? 500;
  }

  start(): void {
    if (this.watcher) return;

    try {
      this.watcher = fs.watch(this.filePath, (eventType) => {
        if (eventType !== 'change') return;
        this.scheduleReload();
      });
      logger.info('ConfigWatcher: started', { filePath: this.filePath });
    } catch (error) {
      logger.warn('ConfigWatcher: failed to start', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.emit('reload');
    }, this.debounceMs);
  }
}
