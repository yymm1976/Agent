// src/agent/context/offload-cleaner.ts
// Phase 71 Task D7：Budget Offload 文件清理机制
//
// 提供 offload 文件的生命周期清理：
//   1. 会话结束：清理该 session 的所有 offload 文件（beforeExit / SIGINT / SIGTERM）
//   2. 启动时：清理超过 7 天的孤儿文件（防止异常退出遗留的累积）
//
// 设计要点：
//   - fail-open：所有清理操作捕获异常，不阻塞 Agent 主流程、不导致进程崩溃
//   - 跨平台路径：用 path.join 拼接，不硬编码分隔符
//   - 钩子可反注册：返回 disposer 便于测试隔离
import * as path from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { readdir, stat, rm } from 'node:fs/promises';
import { logger } from '../../utils/logger.js';

/** 孤儿文件最大保留时长：7 天（毫秒） */
const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 清理指定 sessionId 的 offload 文件（会话结束时调用）
 * fail-open：清理失败不抛错，仅记录 warn 日志
 *
 * @param offloadDir offload 根目录（如 '.routedev/offload'）
 * @param sessionId 会话 ID
 */
function cleanSessionOffload(offloadDir: string, sessionId: string): void {
  try {
    const sessionDir = path.join(offloadDir, sessionId);
    if (!existsSync(sessionDir)) return;
    rmSync(sessionDir, { recursive: true, force: true });
    logger.debug('Offload 文件已清理', { sessionId, dir: sessionDir });
  } catch (err) {
    // 清理失败不阻断进程退出
    logger.warn('Offload session 清理失败（fail-open）', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 清理超过 maxAgeMs 的孤儿 offload 目录（启动时调用）
 * 扫描 offloadDir 下的 session 子目录，按 mtime 判断是否过期
 * fail-open：整体扫描失败仅 warn，单个目录失败不影响其他目录
 *
 * GPT F-018：异步文件操作，避免阻塞事件循环
 *
 * @param offloadDir offload 根目录
 * @param maxAgeMs 最大保留时长，默认 7 天
 */
async function cleanOrphanOffload(
  offloadDir: string,
  maxAgeMs: number = ORPHAN_MAX_AGE_MS,
): Promise<void> {
  try {
    if (!existsSync(offloadDir)) return;
    const now = Date.now();
    let entries: string[];
    try {
      entries = await readdir(offloadDir);
    } catch (err) {
      logger.warn('Offload 目录读取失败（fail-open）', {
        offloadDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const name of entries) {
      const sessionDir = path.join(offloadDir, name);
      try {
        const fileStat = await stat(sessionDir);
        if (!fileStat.isDirectory()) continue;
        const ageMs = now - fileStat.mtimeMs;
        if (ageMs > maxAgeMs) {
          await rm(sessionDir, { recursive: true, force: true });
          logger.debug('孤儿 offload 目录已清理', { dir: sessionDir, ageMs });
        }
      } catch (e) {
        // 单个目录失败不影响其他目录清理
        logger.debug('[offload-cleaner] 清理单个会话目录失败', {
          sessionDir,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (err) {
    logger.warn('孤儿 offload 清理失败（fail-open）', {
      offloadDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 注册 offload 清理钩子（在 app-init.ts 调用）
 *
 * 行为：
 *   1. 立即清理 7 天前的孤儿文件
 *   2. 注册 beforeExit / SIGINT / SIGTERM 钩子，进程退出时清理当前 session
 *
 * 进程安全：钩子内部已包裹 try/catch，清理失败不会导致进程崩溃
 *
 * @param sessionId 当前会话 ID
 * @param offloadDir offload 根目录
 * @returns disposer 函数，调用后反注册所有钩子（仅用于测试隔离）
 */
export function registerOffloadCleaner(
  sessionId: string,
  offloadDir: string,
): () => void {
  // 启动时清理孤儿文件（异步 fire-and-forget，fail-open）
  void cleanOrphanOffload(offloadDir);

  // 退出时清理当前 session
  const handleClose = () => {
    cleanSessionOffload(offloadDir, sessionId);
  };

  process.on('beforeExit', handleClose);
  process.on('SIGINT', handleClose);
  process.on('SIGTERM', handleClose);

  return () => {
    process.off('beforeExit', handleClose);
    process.off('SIGINT', handleClose);
    process.off('SIGTERM', handleClose);
  };
}
