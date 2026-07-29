// src/utils/safe-write.ts
// 原子写入工具：写入临时文件 → rename → 可选 fsync
// 防止写入过程中崩溃导致文件损坏
//
// 设计：
//   - 临时文件名包含 pid + 时间戳 + 随机数，防止多进程并发写同一目标文件时 EEXIST 冲突
//   - 使用 'wx' 模式打开临时文件，避免覆盖已存在的临时文件
//   - 向后兼容：仍尝试清理旧版固定名 `.tmp` 残留（旧版本崩溃可能留下）
//   - rename 失败时清理临时文件，避免污染目录
//   - rename 在同一文件系统内是原子操作

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

export interface SafeWriteOptions {
  /** JSON 缩进空格数，默认 2 */
  spaces?: number;
  /** 是否在写入后 fsync 强制刷盘，默认 false */
  fsync?: boolean;
}

/**
 * 清理可能残留的临时文件（上次崩溃可能留下）
 * 失败不抛错（ENOENT 视为正常）
 */
function cleanupStaleTmp(tmpPath: string): void {
  try {
    fs.unlinkSync(tmpPath);
  } catch (e) {
    // 文件不存在视为正常；其他错误（权限不足）忽略——后续 openSync('wx') 会再次抛错
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      // 静默忽略，让上层 openSync 抛出真实错误
    }
  }
}

/**
 * 生成唯一的临时文件路径
 * 格式：`<filePath>.<pid>.<timestamp>.<random>.tmp`
 * 防止多个进程同时写同一目标文件时 EEXIST 冲突
 */
function makeTmpPath(filePath: string): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(6).toString('hex');
  return `${filePath}.${process.pid}.${ts}.${rand}.tmp`;
}

/**
 * 底层原子写入：写入临时文件 → 可选 fsync → rename
 * 临时文件名唯一，并发安全；同时清理旧版固定名 `.tmp` 残留
 */
function atomicWrite(
  filePath: string,
  buf: Buffer,
  options: SafeWriteOptions,
): void {
  const { fsync = false } = options;
  // 向后兼容：清理旧版本可能残留的固定名 `.tmp` 文件
  cleanupStaleTmp(filePath + '.tmp');

  // 唯一临时文件名：pid + 时间戳 + 随机数
  const tmpPath = makeTmpPath(filePath);

  // 使用 'wx' 模式打开临时文件，名字唯一，不会冲突
  const fd = fs.openSync(tmpPath, 'wx');
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    if (fsync) {
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }

  // rename 是原子操作（同一文件系统内）
  // rename 失败时清理临时文件，避免污染目录
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (renameErr) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* 忽略清理失败 */
    }
    throw renameErr;
  }
}

/**
 * 原子写入 JSON 文件：写入临时文件 → rename → 可选 fsync
 * 防止写入过程中崩溃导致文件损坏
 *
 * @param filePath 目标文件路径
 * @param data 要序列化的数据
 * @param options 写入选项
 */
export async function safeWriteJSON(
  filePath: string,
  data: unknown,
  options: SafeWriteOptions = {},
): Promise<void> {
  const { spaces = 2 } = options;
  const content = JSON.stringify(data, null, spaces);
  const buf = Buffer.from(content, 'utf8');
  atomicWrite(filePath, buf, options);
}

/**
 * 同步原子写入 JSON 文件
 *
 * @param filePath 目标文件路径
 * @param data 要序列化的数据
 * @param options 写入选项
 */
export function safeWriteJSONSync(
  filePath: string,
  data: unknown,
  options: SafeWriteOptions = {},
): void {
  const { spaces = 2 } = options;
  const content = JSON.stringify(data, null, spaces);
  const buf = Buffer.from(content, 'utf8');
  atomicWrite(filePath, buf, options);
}

/**
 * 原子写入文本文件（非 JSON）
 *
 * @param filePath 目标文件路径
 * @param content 文本内容
 * @param options 写入选项
 */
export async function safeWriteText(
  filePath: string,
  content: string,
  options: SafeWriteOptions = {},
): Promise<void> {
  const buf = Buffer.from(content, 'utf8');
  atomicWrite(filePath, buf, options);
}


