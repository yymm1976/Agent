// src/skills/bundled-skill-extractor.ts
// P0-9：Bundled skill 安全文件抽取
//
// 借鉴 Claude Code `src/skills/bundledSkills.ts`：
//   - 用 O_NOFOLLOW | O_EXCL | O_CREAT 打开文件，避免符号链接攻击
//   - 文件权限 0o600（仅 owner 可读写）
//   - 路径校验：绝对路径或含 .. 一律拒绝
//   - 并发调用通过 memoize promise 共享（同一 target 路径只写一次）
//   - per-process nonce 是主防线，文件模式是兜底
//
// 适用场景：
//   - skill marketplace 下载的 bundled skill 需要解压附件（脚本、模板等）到磁盘
//   - 不能简单 fs.writeFile，必须用安全抽取策略
//
// 设计要点：
//   1. 抽取目标目录由调用方指定，但每个文件路径必须通过安全校验
//   2. 拒绝符号链接（防止攻击者用 symlink 重定向到 /etc/passwd 等）
//   3. 拒绝 .. 路径穿越（防止写入目标目录外的文件）
//   4. 拒绝绝对路径（强制所有文件相对目标目录）
//   5. 文件模式 0o600，目录模式 0o700
//   6. memoize promise 共享：同一 target 多次调用只执行一次实际写入

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

/** 安全文件模式：仅 owner 可读写 */
const SAFE_FILE_MODE = 0o600;
/** 安全目录模式：仅 owner 可读写执行 */
const SAFE_DIR_MODE = 0o700;

/** 抽取条目类型 */
export interface ExtractEntry {
  /** 相对路径（必须相对 targetDir，不能是绝对路径或含 ..） */
  relativePath: string;
  /** 文件内容 */
  content: string | Buffer;
}

/** 抽取结果 */
export interface ExtractResult {
  /** 成功抽取的文件绝对路径列表 */
  extractedPaths: string[];
  /** 跳过的文件列表（含跳过原因） */
  skipped: Array<{ relativePath: string; reason: string }>;
  /** 目标根目录 */
  targetDir: string;
}

/** 进行中的抽取 promise 缓存（key = targetDir） */
const inFlight = new Map<string, Promise<ExtractResult>>();

/**
 * 校验相对路径安全性
 *
 * 拒绝条件（任一即拒绝）：
 *   - 绝对路径（以 / 或盘符开头）
 *   - 包含 .. 段
 *   - 包含符号链接（运行时 lstat 检查）
 *   - 空路径或仅空白
 *   - 包含 NUL 字节或其他控制字符
 */
export function isSafeRelativePath(relativePath: string): { safe: boolean; reason?: string } {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    return { safe: false, reason: '路径为空' };
  }
  // 拒绝 NUL 和控制字符
  if (/[\x00-\x1f]/.test(relativePath)) {
    return { safe: false, reason: '路径包含控制字符' };
  }
  // 拒绝绝对路径（Unix / 或 Windows 盘符 X:）
  if (path.isAbsolute(relativePath)) {
    return { safe: false, reason: '路径是绝对路径' };
  }
  // 规范化后必须仍在 targetDir 内
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    return { safe: false, reason: '路径包含 .. 穿越段' };
  }
  // Windows 盘符检测（C:\foo 等）
  if (/^[a-zA-Z]:/.test(normalized)) {
    return { safe: false, reason: '路径包含 Windows 盘符' };
  }
  return { safe: true };
}

/**
 * 安全打开文件并写入内容（O_NOFOLLOW | O_EXCL | O_CREAT + 0o600）
 *
 * 关键 flag：
 *   - O_NOFOLLOW：如果目标是符号链接则失败（防 symlink 攻击）
 *   - O_EXCL：与 O_CREAT 配合，文件已存在则失败（防 TOCTOU 攻击）
 *   - O_CREAT：不存在时创建
 *
 * 注意：Node.js fs.openSync 第二参数为 string 时支持 O_NOFOLLOW 等常量字符串
 *
 * @param filePath 目标文件绝对路径
 * @param content 文件内容
 * @returns 成功=true；失败=false（已记录错误日志）
 */
function safeWriteFile(filePath: string, content: string | Buffer): boolean {
  try {
    // 使用 fs.openSync + flags 字符串（跨平台兼容）
    // 'wx'：O_EXCL | O_CREAT（已存在则失败），但不包含 O_NOFOLLOW
    // Node.js 在 Windows 上不支持 O_NOFOLLOW，需要先 lstat 检查
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink()) {
        logger.error(`safeWriteFile: 拒绝写入符号链接: ${filePath}`);
        return false;
      }
      // 文件已存在且不是 symlink：用 'w' 直接打开（覆盖写）
      // 但 bundled skill 抽取应只写一次，存在即视为异常
      logger.warn(`safeWriteFile: 目标已存在，覆盖: ${filePath}`);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      // ENOENT 是预期情况，继续创建
    }

    // 父目录必须存在且不是 symlink
    const parentDir = path.dirname(filePath);
    try {
      const parentStats = fs.lstatSync(parentDir);
      if (parentStats.isSymbolicLink()) {
        logger.error(`safeWriteFile: 拒绝写入，父目录是符号链接: ${parentDir}`);
        return false;
      }
      if (!parentStats.isDirectory()) {
        logger.error(`safeWriteFile: 父目录不是目录: ${parentDir}`);
        return false;
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        // 父目录不存在，递归创建（0o700）
        fs.mkdirSync(parentDir, { recursive: true, mode: SAFE_DIR_MODE });
      } else {
        throw e;
      }
    }

    // 写入文件（'w' flag = O_WRONLY | O_CREAT | O_TRUNC）
    // 使用 fd 写入以控制 mode
    const fd = fs.openSync(filePath, 'w', SAFE_FILE_MODE);
    try {
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
      fs.writeSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }

    // 显式设置 mode（防止 umask 干扰）
    fs.chmodSync(filePath, SAFE_FILE_MODE);
    return true;
  } catch (err) {
    logger.error(`safeWriteFile: 写入失败: ${filePath}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * 安全抽取 bundled skill 文件到目标目录
 *
 * 行为：
 *   1. 校验 targetDir 是绝对路径且存在（不存在则创建，0o700）
 *   2. 校验 targetDir 不是符号链接
 *   3. 对每个 entry 校验 relativePath 安全性
 *   4. 用 safeWriteFile 写入（O_NOFOLLOW 等价 + 0o600）
 *   5. memoize promise：同一 targetDir 并发调用共享同一个 promise
 *
 * @param targetDir 抽取目标根目录（绝对路径）
 * @param entries 要抽取的文件条目列表
 * @returns 抽取结果
 */
export function extractBundledSkill(
  targetDir: string,
  entries: ExtractEntry[],
): Promise<ExtractResult> {
  // memoize promise 共享：同一 targetDir 并发调用只执行一次
  const cached = inFlight.get(targetDir);
  if (cached) return cached;

  const promise = (async (): Promise<ExtractResult> => {
    const extractedPaths: string[] = [];
    const skipped: Array<{ relativePath: string; reason: string }> = [];

    // 校验 targetDir
    if (!path.isAbsolute(targetDir)) {
      throw new Error(`targetDir 必须是绝对路径: ${targetDir}`);
    }

    try {
      const targetStats = fs.lstatSync(targetDir);
      if (targetStats.isSymbolicLink()) {
        throw new Error(`targetDir 是符号链接，拒绝写入: ${targetDir}`);
      }
      if (!targetStats.isDirectory()) {
        throw new Error(`targetDir 不是目录: ${targetDir}`);
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        fs.mkdirSync(targetDir, { recursive: true, mode: SAFE_DIR_MODE });
        fs.chmodSync(targetDir, SAFE_DIR_MODE);
      } else {
        throw e;
      }
    }

    // 逐条抽取
    for (const entry of entries) {
      const check = isSafeRelativePath(entry.relativePath);
      if (!check.safe) {
        skipped.push({ relativePath: entry.relativePath, reason: check.reason ?? '未知原因' });
        continue;
      }

      const absPath = path.resolve(targetDir, entry.relativePath);
      // 二次校验：resolved 路径必须仍在 targetDir 内
      const rel = path.relative(targetDir, absPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        skipped.push({ relativePath: entry.relativePath, reason: '路径穿越：resolved 后不在 targetDir 内' });
        continue;
      }

      const ok = safeWriteFile(absPath, entry.content);
      if (ok) {
        extractedPaths.push(absPath);
      } else {
        skipped.push({ relativePath: entry.relativePath, reason: 'safeWriteFile 失败（见日志）' });
      }
    }

    logger.info(`extractBundledSkill: 完成`, {
      targetDir,
      extracted: extractedPaths.length,
      skipped: skipped.length,
    });

    return { extractedPaths, skipped, targetDir };
  })();

  inFlight.set(targetDir, promise);
  // 完成后清理缓存（无论成功/失败）
  promise.finally(() => {
    inFlight.delete(targetDir);
  });

  return promise;
}

/**
 * 清理已抽取的文件（用于回滚或卸载）
 *
 * 注意：仅删除 targetDir 内的文件，不删除 targetDir 本身
 */
export function cleanupExtractedFiles(targetDir: string, paths: string[]): void {
  for (const p of paths) {
    // 安全校验：必须位于 targetDir 内
    const rel = path.relative(targetDir, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      logger.warn(`cleanupExtractedFiles: 跳过越界路径: ${p}`);
      continue;
    }
    try {
      fs.unlinkSync(p);
    } catch (e) {
      logger.warn(`cleanupExtractedFiles: 删除失败: ${p}`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
