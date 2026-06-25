// src/utils/stall-detector.ts
// 子进程活性检测器（借鉴 architect-loop 的 liveness monitoring）

import { logger } from './logger.js';

export interface StallDetectorConfig {
  /** 静默超时（毫秒），超过此时间无输出视为卡死 */
  stallTimeoutMs: number;
  /** 检测间隔（毫秒） */
  checkIntervalMs: number;
  /** 卡死时的回调 */
  onStall: (pid: number) => void;
}

export class StallDetector {
  private lastActivity = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: StallDetectorConfig;

  constructor(config: StallDetectorConfig) {
    this.config = config;
  }

  /** 注册一个需要监控的进程 */
  register(pid: number): void {
    this.lastActivity.set(pid, Date.now());
  }

  /** 报告进程有活动（收到 stdout/stderr） */
  reportActivity(pid: number): void {
    this.lastActivity.set(pid, Date.now());
  }

  /** 注销进程 */
  unregister(pid: number): void {
    this.lastActivity.delete(pid);
  }

  /** 启动定期检测 */
  start(): void {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [pid, lastTime] of this.lastActivity.entries()) {
        if (now - lastTime > this.config.stallTimeoutMs) {
          logger.warn(`Process ${pid} stalled (no activity for ${this.config.stallTimeoutMs}ms)`);
          this.config.onStall(pid);
          this.lastActivity.delete(pid);
        }
      }
    }, this.config.checkIntervalMs);
    // M5 修复：调用 .unref() 让定时器不阻止 Node.js 进程退出
    // 原实现未调用 .unref()，导致所有任务完成后进程仍无法自然退出
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
