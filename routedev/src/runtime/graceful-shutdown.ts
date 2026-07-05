// src/runtime/graceful-shutdown.ts
// P0-14：graceful shutdown 注册式清理链
//
// 借鉴 Claude Code 的 shutdown 编排模式 + 用户硬约束：
//   "应用关闭时必须自动终止所有后台线程（不能有残留进程）"
//
// 现状问题（app-init.ts 散点）：
//   - 各模块直接 process.on('SIGINT', handleClose) 注册各自的清理逻辑
//   - 无统一调度，hook 之间无顺序保证
//   - 单个 hook 卡死会导致进程无法退出
//   - 重复触发 SIGINT 时会重复执行 hook
//
// 改造：
//   1. 提供 registerShutdownHook(priority, name, fn) 集中注册
//   2. 统一监听 SIGINT/SIGTERM/beforeExit，按 priority 降序执行
//   3. 超时强制退出（默认 5000ms，防止 hook 卡死）
//   4. 一次性触发（重复信号直接 process.exit）
//   5. fail-open：单个 hook 失败不阻塞后续 hook
//
// 使用方式：
//   registerShutdownHook(100, 'session-memory', () => store.close());
//   registerShutdownHook(50, 'codemap-watcher', () => watcher.close());
//   registerShutdownHook(10, 'analytics-flush', () => forceFlushNow());

import { logger } from '../utils/logger.js';

/** Shutdown hook 优先级（数值越高越先执行） */
export type ShutdownPriority = number;

/** Shutdown hook 函数签名（同步或异步） */
export type ShutdownHookFn = () => void | Promise<void>;

/** Shutdown hook 注册项 */
interface ShutdownHook {
  priority: ShutdownPriority;
  name: string;
  fn: ShutdownHookFn;
  /** 注册时间戳（用于调试） */
  registeredAt: number;
}

/** Shutdown 触发原因 */
export type ShutdownReason = 'SIGINT' | 'SIGTERM' | 'beforeExit' | 'manual';

/** 模块级状态 */
const state: {
  /** 已注册的 hook 列表 */
  hooks: ShutdownHook[];
  /** 是否已安装信号监听器 */
  listenersInstalled: boolean;
  /** 是否已开始 shutdown（防止重复执行） */
  shuttingDown: boolean;
  /** 超时强制退出的毫秒数 */
  timeoutMs: number;
  /** shutdown 完成后的退出码 */
  exitCode: number;
} = {
  hooks: [],
  listenersInstalled: false,
  shuttingDown: false,
  timeoutMs: 5000,
  exitCode: 0,
};

/**
 * 注册 shutdown hook
 *
 * @param priority 优先级（数值越大越先执行；同优先级按注册顺序执行）
 * @param name hook 名称（用于日志/调试，必须唯一）
 * @param fn hook 函数（同步或异步；fail-open：抛异常不阻塞后续 hook）
 *
 * @example
 * registerShutdownHook(100, 'session-memory', () => store.close());
 * registerShutdownHook(50, 'codemap-watcher', () => watcher.close());
 */
export function registerShutdownHook(
  priority: ShutdownPriority,
  name: string,
  fn: ShutdownHookFn,
): void {
  // 名称唯一性检查（防止重复注册）
  if (state.hooks.some(h => h.name === name)) {
    logger.warn(`graceful-shutdown: hook "${name}" 已注册，跳过重复注册`);
    return;
  }

  state.hooks.push({
    priority,
    name,
    fn,
    registeredAt: Date.now(),
  });

  // 按 priority 降序排序（同 priority 按注册时间升序）
  state.hooks.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.registeredAt - b.registeredAt;
  });

  // 惰性安装信号监听器（首次注册 hook 时才安装）
  if (!state.listenersInstalled) {
    installSignalListeners();
  }
}

/**
 * P0-14：取消已注册的 shutdown hook（用于动态卸载模块）
 *
 * @param name hook 名称
 * @returns 是否成功取消（不存在时返回 false）
 */
export function unregisterShutdownHook(name: string): boolean {
  const idx = state.hooks.findIndex(h => h.name === name);
  if (idx === -1) return false;
  state.hooks.splice(idx, 1);
  return true;
}

/**
 * P0-14：安装信号监听器（惰性调用，仅首次注册 hook 时触发）
 *
 * 监听：
 *   - SIGINT（Ctrl+C）
 *   - SIGTERM（kill 命令）
 *   - beforeExit（Node 事件循环空了，正常退出）
 */
function installSignalListeners(): void {
  if (state.listenersInstalled) return;
  state.listenersInstalled = true;

  // SIGINT（Ctrl+C）
  process.on('SIGINT', () => {
    void triggerShutdown('SIGINT');
  });

  // SIGTERM（kill 命令）
  process.on('SIGTERM', () => {
    void triggerShutdown('SIGTERM');
  });

  // beforeExit（事件循环空闲，正常退出）
  // 注意：beforeExit 中可以执行异步操作，但进程可能在 hook 完成前退出
  //       所以这里也调用 triggerShutdown，但超时强制退出兜底
  process.on('beforeExit', () => {
    void triggerShutdown('beforeExit');
  });

  logger.debug('graceful-shutdown: 信号监听器已安装', {
    signals: ['SIGINT', 'SIGTERM', 'beforeExit'],
    timeoutMs: state.timeoutMs,
  });
}

/**
 * P0-14：触发 shutdown（一次性）
 *
 * 行为：
 *   1. 标记 shuttingDown=true，重复调用直接 return
 *   2. 按优先级降序执行所有 hook
 *   3. 每个 hook 用 try/catch 包裹（fail-open）
 *   4. 设置超时定时器：超时后强制 process.exit
 *   5. 所有 hook 完成后 process.exit(exitCode)
 *
 * @param reason 触发原因
 */
export async function triggerShutdown(reason: ShutdownReason): Promise<void> {
  // 一次性触发：重复信号直接退出
  if (state.shuttingDown) {
    logger.debug(`graceful-shutdown: 已在 shutdown 中，重复信号 (${reason}) 直接退出`);
    process.exit(state.exitCode);
    return;
  }
  state.shuttingDown = true;

  logger.info(`graceful-shutdown: 开始 (${reason})`, {
    hookCount: state.hooks.length,
    timeoutMs: state.timeoutMs,
  });

  // 超时强制退出定时器
  const timeoutHandle = setTimeout(() => {
    logger.error(`graceful-shutdown: 超时 ${state.timeoutMs}ms，强制退出`, {
      completedHooks: state.hooks.filter(h => h.fn).length,
      totalHooks: state.hooks.length,
    });
    process.exit(state.exitCode + 1); // 超时退出码 +1 表示异常
  }, state.timeoutMs);

  // 防止 timeoutHandle 阻止进程退出
  timeoutHandle.unref?.();

  // 按优先级执行所有 hook
  let successCount = 0;
  let failureCount = 0;
  for (const hook of state.hooks) {
    try {
      await hook.fn();
      successCount++;
      logger.debug(`graceful-shutdown: hook "${hook.name}" 完成`, {
        priority: hook.priority,
      });
    } catch (err) {
      failureCount++;
      logger.error(`graceful-shutdown: hook "${hook.name}" 失败（fail-open，继续后续 hook）`, {
        priority: hook.priority,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  clearTimeout(timeoutHandle);

  logger.info(`graceful-shutdown: 完成 (${reason})`, {
    successCount,
    failureCount,
    totalHooks: state.hooks.length,
  });

  // beforeExit 时不主动 exit（让事件循环自然结束）
  // SIGINT/SIGTERM/manual 时主动 exit
  if (reason !== 'beforeExit') {
    process.exit(state.exitCode);
  }
}

/**
 * P0-14：手动触发 shutdown（用于 /quit 命令或 UI 关闭按钮）
 */
export async function shutdown(reason: ShutdownReason = 'manual'): Promise<void> {
  await triggerShutdown(reason);
}

/**
 * P0-14：配置 shutdown 超时时间
 *
 * @param ms 超时毫秒数（默认 5000）
 */
export function setShutdownTimeoutMs(ms: number): void {
  if (typeof ms !== 'number' || ms < 100) {
    logger.warn(`graceful-shutdown: 超时时间 ${ms} 无效，保持默认 ${state.timeoutMs}`);
    return;
  }
  state.timeoutMs = ms;
}

/**
 * P0-14：设置 shutdown 退出码
 *
 * @param code 退出码（默认 0）
 */
export function setShutdownExitCode(code: number): void {
  state.exitCode = code;
}

/**
 * P0-14：获取已注册的 shutdown hook 列表（用于调试/UI 显示）
 */
export function listShutdownHooks(): Array<{
  priority: ShutdownPriority;
  name: string;
  registeredAt: number;
}> {
  return state.hooks.map(h => ({
    priority: h.priority,
    name: h.name,
    registeredAt: h.registeredAt,
  }));
}

/**
 * P0-14：检查是否正在 shutdown（用于阻止 shutdown 期间的新任务）
 */
export function isShuttingDown(): boolean {
  return state.shuttingDown;
}
