// src/tools/read-tracker.ts
// Phase 31 Task 6.1：先读后写强制（Read-Before-Write）
// 追踪文件读取历史，阻止未读文件的写入（新建文件例外）
// 通过 fs.access 检查文件存在性——不存在则允许直接写入

import { access } from 'node:fs/promises';
import { resolve, normalize } from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * ReadTracker——文件读取历史追踪
 *
 * 接入点：
 *   - file_read / file_search 返回结果时调用 markRead(path)
 *   - file_write / file_edit 执行前调用 checkWriteAllowed(path)
 *   - 新会话或新任务时调用 reset()
 *
 * 例外：新建文件（路径不存在）不受此限制
 */
export class ReadTracker {
  private readFiles = new Set<string>();
  /** 已检查过存在性的文件缓存（避免重复 fs.access） */
  private existenceCache = new Map<string, boolean>();

  /**
   * 标记文件为已读
   * file_read / file_search 返回结果时调用
   */
  markRead(filePath: string): void {
    const normalized = this.normalize(filePath);
    this.readFiles.add(normalized);
    logger.debug('ReadTracker: marked as read', { path: normalized });
  }

  /**
   * 检查文件是否已被读取
   */
  hasRead(filePath: string): boolean {
    return this.readFiles.has(this.normalize(filePath));
  }

  /**
   * 检查文件是否允许写入
   * file_write / file_edit 执行前调用
   *
   * 规则：
   *   - 已读过 → 允许
   *   - 未读过但文件不存在（新建文件）→ 允许
   *   - 未读过且文件存在 → 拒绝
   *
   * @returns allowed: 是否允许；reason: 拒绝原因
   */
  async checkWriteAllowed(filePath: string): Promise<{ allowed: boolean; reason?: string }> {
    const normalized = this.normalize(filePath);

    // 已读过 → 允许
    if (this.readFiles.has(normalized)) {
      return { allowed: true };
    }

    // 检查文件是否存在（带缓存）
    const exists = await this.existsFile(normalized);
    if (!exists) {
      // 新建文件 → 允许
      logger.debug('ReadTracker: write allowed for new file', { path: normalized });
      return { allowed: true };
    }

    // 未读过且文件存在 → 拒绝
    return {
      allowed: false,
      reason: `[安全] 文件 ${filePath} 尚未被读取。请先用 file_read 读取文件内容，再进行修改。`,
    };
  }

  /**
   * 同步检查（不检查文件存在性，仅检查读历史）
   * 用于无法 await 的场景——结果保守：未读过则拒绝
   */
  checkWriteAllowedSync(filePath: string): { allowed: boolean; reason?: string } {
    const normalized = this.normalize(filePath);
    if (this.readFiles.has(normalized)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `[安全] 文件 ${filePath} 尚未被读取（同步检查未通过）。`,
    };
  }

  /**
   * 重置（新会话或新任务时调用）
   */
  reset(): void {
    this.readFiles.clear();
    this.existenceCache.clear();
  }

  /**
   * 获取已读文件列表（调试用）
   */
  getReadFiles(): string[] {
    return Array.from(this.readFiles);
  }

  /**
   * 规范化路径——绝对路径 + normalize
   * file_read 和 file_write 传入的路径必须 normalize 后比对
   */
  private normalize(filePath: string): string {
    return normalize(resolve(filePath));
  }

  /**
   * 检查文件是否存在（带缓存）
   * I6 修复：只缓存"存在"结果，"不存在"每次重新探测
   * 缓存 false 后文件被创建，下次仍返回 false，未读就允许覆盖
   */
  private async existsFile(normalizedPath: string): Promise<boolean> {
    if (this.existenceCache.get(normalizedPath) === true) {
      return true; // 已确认存在，可缓存
    }
    try {
      await access(normalizedPath);
      this.existenceCache.set(normalizedPath, true);
      return true;
    } catch {
      // 不缓存 false：文件可能随后被创建
      return false;
    }
  }
}

/**
 * 创建 ReadTracker 的工厂函数
 */
export function createReadTracker(): ReadTracker {
  return new ReadTracker();
}
