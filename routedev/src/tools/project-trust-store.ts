// src/tools/project-trust-store.ts
// P2-8：per-cwd 信任级别持久化 + 父目录继承
//
// 借鉴 Claude Code 项目级权限持久化设计：
//   - 每个工作目录有自己的 .routedev/trust.json，存储该目录的 TrustLevel
//   - 子目录无配置时自动继承最近父目录的配置（递归向上查找）
//   - 临时授权保持现有设计（resume 时不恢复），不持久化
//
// 文件格式（.routedev/trust.json）：
//   {
//     "version": 1,
//     "cwd": "C:/Users/foo/project",
//     "level": "acceptEdits",
//     "updatedAt": 1718928000000
//   }
//
// 与 TrustGradientManager 关系：
//   - ProjectTrustStore 只负责持久化层（load/save/find）
//   - TrustGradientManager 通过此 store 在 setLevel 时自动持久化
//   - 启动时调用 store.findInherited(cwd) 获取生效配置

import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import type { TrustLevel } from './trust-gradient.js';

/** 持久化文件结构 */
interface TrustFile {
  /** 格式版本号 */
  version: 1;
  /** 写入时的工作目录（用于诊断，不参与继承逻辑） */
  cwd: string;
  /** 信任级别 */
  level: TrustLevel;
  /** 最近一次更新时间戳（毫秒） */
  updatedAt: number;
}

/** 查找结果 */
export interface InheritedTrust {
  /** 生效的信任级别 */
  level: TrustLevel;
  /** 配置来源路径（绝对路径）；未找到时为 null */
  sourcePath: string | null;
  /** 是否为当前目录的配置（true）还是继承自父目录（false） */
  isLocal: boolean;
}

/** 合法的信任级别白名单 */
const VALID_LEVELS: readonly TrustLevel[] = [
  'plan', 'default', 'acceptEdits', 'acceptAll',
  'auto', 'bypassPermissions', 'trusted',
];

/** 默认信任级别（无任何配置时使用） */
export const DEFAULT_TRUST_LEVEL: TrustLevel = 'default';

/** trust.json 文件名 */
const TRUST_FILENAME = '.routedev/trust.json';

/**
 * P2-8：项目信任级别持久化仓库
 *
 * 职责：
 *   1. load(cwd) — 读取当前目录的 trust 配置（不继承）
 *   2. save(cwd, level) — 写入当前目录的 trust 配置
 *   3. findInherited(cwd) — 查找生效配置（向上继承）
 *   4. clear(cwd) — 删除当前目录的 trust 配置
 *
 * 不做的事：
 *   - 不持久化临时授权（保持 resume 不恢复设计）
 *   - 不传播写入到父目录（setLevel 只影响当前目录）
 *   - 不缓存（每次 load 都直接读盘，确保最新）
 */
export class ProjectTrustStore {
  /**
   * 读取当前目录的 trust 配置
   *
   * 仅读取 cwd/.routedev/trust.json，不向上查找。
   * 文件不存在或格式错误时返回 null。
   *
   * @param cwd 工作目录绝对路径
   */
  async load(cwd: string): Promise<TrustFile | null> {
    const filePath = this.configPath(cwd);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as TrustFile;
      if (!this.isValidFile(data)) {
        logger.warn('ProjectTrustStore: invalid trust file', { filePath });
        return null;
      }
      return data;
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return null;
      }
      logger.warn('ProjectTrustStore: failed to load', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * 写入当前目录的 trust 配置
   *
   * 自动创建 .routedev/ 目录。
   * 写入采用原子替换（先写临时文件再 rename），避免半写入导致文件损坏。
   *
   * @param cwd 工作目录绝对路径
   * @param level 信任级别
   */
  async save(cwd: string, level: TrustLevel): Promise<void> {
    if (!VALID_LEVELS.includes(level)) {
      throw new Error(`ProjectTrustStore: invalid trust level: ${level}`);
    }

    const filePath = this.configPath(cwd);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const file: TrustFile = {
      version: 1,
      cwd,
      level,
      updatedAt: Date.now(),
    };

    // 原子写入：先写临时文件，再 rename
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
    try {
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // rename 失败时回退到直接写入
      await fs.writeFile(filePath, JSON.stringify(file, null, 2), 'utf-8');
      try { await fs.unlink(tmpPath); } catch { /* 忽略清理失败 */ }
      if (err && !(err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT')) {
        // rename 失败但已 fallback 写入，仅记录日志
        logger.warn('ProjectTrustStore: rename failed, fell back to direct write', {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('ProjectTrustStore: saved', { filePath, level });
  }

  /**
   * 删除当前目录的 trust 配置
   *
   * 文件不存在时静默返回。
   *
   * @param cwd 工作目录绝对路径
   * @returns 是否成功删除
   */
  async clear(cwd: string): Promise<boolean> {
    const filePath = this.configPath(cwd);
    try {
      await fs.unlink(filePath);
      logger.info('ProjectTrustStore: cleared', { filePath });
      return true;
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return false;
      }
      logger.warn('ProjectTrustStore: failed to clear', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * 查找生效配置（向上继承）
   *
   * 从 cwd 开始向上逐级查找 .routedev/trust.json：
   *   - 找到第一个合法配置文件即返回
   *   - 一直查找到磁盘根目录仍未找到时返回 { level: DEFAULT_TRUST_LEVEL, sourcePath: null, isLocal: false }
   *
   * 用例：子目录 workspace/sub-feature 继承父目录 workspace 的 trust 配置，
   * 避免每个子目录都重复设置。
   *
   * @param cwd 工作目录绝对路径
   */
  async findInherited(cwd: string): Promise<InheritedTrust> {
    const normalized = path.resolve(cwd);
    let current: string = normalized;
    let isLocal = true;

    while (true) {
      const file = await this.load(current);
      if (file) {
        return {
          level: file.level,
          sourcePath: this.configPath(current),
          isLocal,
        };
      }

      // 向上一级
      const parent = path.dirname(current);
      // 到达磁盘根目录（parent === current）
      if (parent === current) break;
      current = parent;
      isLocal = false;
    }

    return {
      level: DEFAULT_TRUST_LEVEL,
      sourcePath: null,
      isLocal: false,
    };
  }

  /**
   * 获取 trust.json 的完整路径
   *
   * @param cwd 工作目录绝对路径
   */
  private configPath(cwd: string): string {
    return path.join(cwd, TRUST_FILENAME);
  }

  /**
   * 校验文件对象是否合法
   */
  private isValidFile(data: unknown): data is TrustFile {
    if (typeof data !== 'object' || data === null) return false;
    const f = data as Record<string, unknown>;
    return (
      f.version === 1 &&
      typeof f.cwd === 'string' &&
      typeof f.level === 'string' &&
      VALID_LEVELS.includes(f.level as TrustLevel) &&
      typeof f.updatedAt === 'number'
    );
  }
}

/**
 * 创建 ProjectTrustStore 实例
 *
 * 单例使用建议：全局共享一个实例，避免重复读盘。
 */
export function createProjectTrustStore(): ProjectTrustStore {
  return new ProjectTrustStore();
}
