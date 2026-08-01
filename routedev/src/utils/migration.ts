// src/utils/migration.ts
// Phase 93 Task 7：schema migration 工具函数
//
// 用途：为持久化 JSON 文件提供版本化迁移能力，防止版本升级后格式不兼容导致数据丢失。
// 协同 Zod schema：load 时先 migrate() 升级到当前版本，再 parseXxx() 校验结构。
//
// 设计要点：
//   1. 通过 __schemaVersion 字段识别数据版本（缺失视为 0，触发全部迁移）
//   2. migrations 数组按版本顺序排列，索引 v 对应 v → v+1 的迁移函数
//   3. fail-open：迁移函数抛异常时返回 fallback，避免阻塞主流程（调用方需提供合理 fallback）
//   4. 不修改原始数据（浅拷贝顶层），避免副作用

import { logger } from './logger.js';

/**
 * 选项参数
 */
export interface MigrateOptions<T> {
  /** 当前 schema 版本号（从 1 开始） */
  currentVersion: number;
  /** 迁移函数数组，索引 v 对应 v → v+1 的迁移 */
  migrations: Array<(data: unknown) => unknown>;
  /** 迁移失败时的 fallback 值（默认 undefined） */
  fallback?: T;
  /** 调用方标识，用于日志定位 */
  caller?: string;
}

/**
 * 将原始数据迁移到当前 schema 版本
 *
 * @param raw 原始数据（通常来自 JSON.parse）
 * @param options 迁移选项
 * @returns 迁移后的数据（类型由调用方断言或 Zod 校验）
 *
 * @example
 * ```typescript
 * const raw = JSON.parse(content);
 * const migrated = migrate(raw, {
 *   currentVersion: 2,
 *   migrations: [
 *     (v0) => ({ ...v0, __schemaVersion: 1, newField: 'default' }), // 0 → 1
 *     (v1) => ({ ...v1, __schemaVersion: 2, renamedField: v1.oldField }), // 1 → 2
 *   ],
 *   caller: 'GoalPersistence',
 * });
 * const parsed = parsePersistedGoal(migrated);
 * ```
 */
export function migrate<T>(
  raw: unknown,
  options: MigrateOptions<T>,
): T {
  const { currentVersion, migrations, fallback, caller = 'migrate' } = options;

  // 读取数据版本（缺失视为 0，触发全部迁移）
  const version = readSchemaVersion(raw);

  // 版本已是当前或更高：直接返回（不强制降级，向前兼容）
  if (version >= currentVersion) {
    return raw as T;
  }

  // 逐版本迁移
  let data = raw;
  for (let v = version; v < currentVersion; v++) {
    const migrator = migrations[v];
    if (!migrator) {
      // 缺少迁移函数：无法继续，返回 fallback
      logger.warn('[migration] 缺少迁移函数，返回 fallback', {
        caller,
        fromVersion: v,
        currentVersion,
      });
      return fallback as T;
    }
    try {
      data = migrator(data);
      // 迁移函数应更新 __schemaVersion，但这里也强制写入确保一致性
      if (data && typeof data === 'object') {
        (data as { __schemaVersion?: number }).__schemaVersion = v + 1;
      }
    } catch (err) {
      logger.warn('[migration] 迁移函数抛异常，返回 fallback', {
        caller,
        fromVersion: v,
        toVersion: v + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      return fallback as T;
    }
  }

  return data as T;
}

/**
 * 读取数据的 __schemaVersion 字段
 *
 * @param raw 原始数据
 * @returns 版本号（缺失或非数字返回 0）
 */
export function readSchemaVersion(raw: unknown): number {
  if (!raw || typeof raw !== 'object') {
    return 0;
  }
  const version = (raw as { __schemaVersion?: unknown }).__schemaVersion;
  if (typeof version === 'number' && Number.isInteger(version) && version >= 0) {
    return version;
  }
  return 0;
}

/**
 * 标记数据为当前 schema 版本（save 时调用）
 *
 * @param data 待持久化的数据
 * @param currentVersion 当前版本号
 * @returns 带版本号的新对象（不修改原对象）
 */
export function withSchemaVersion<T extends object>(
  data: T,
  currentVersion: number,
): T & { __schemaVersion: number } {
  return { ...data, __schemaVersion: currentVersion };
}
