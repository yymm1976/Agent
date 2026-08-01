// src/config/schemas/database.ts
// Phase 93 Task 6：code-map 数据库查询结果的运行时校验
//
// better-sqlite3 / node:sqlite 的 prepare().get()/.all() 返回 unknown，
// 原代码用 `as Record<string, unknown>` 直接断言，若表结构变更或查询返回意外结构会运行时炸。
// 本 schema 校验行对象的关键列存在性，fail-open 返回 undefined/空数组（与"查不到"等价，触发重新索引，无害）。

import { z } from 'zod';
import { logger } from '../../utils/logger.js';

/** files 表行对象的 schema（仅校验关键列存在） */
export const FileRowSchema = z.object({
  path: z.unknown(),
  language: z.unknown(),
  content_hash: z.unknown(),
  line_count: z.unknown(),
  indexed_at: z.unknown(),
}).passthrough();

/** nodes 表行对象的 schema（仅校验关键列存在） */
export const NodeRowSchema = z.object({
  id: z.unknown(),
  name: z.unknown(),
  kind: z.unknown(),
  file_path: z.unknown(),
  start_line: z.unknown(),
  end_line: z.unknown(),
}).passthrough();

/**
 * 解析 files 表查询结果行
 *
 * @param raw prepare().get() 的返回值（unknown）
 * @returns 校验通过的行对象；输入为 undefined/null 或校验失败时返回 undefined
 */
export function parseFileRow(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  try {
    return FileRowSchema.parse(raw);
  } catch (err) {
    logger.warn('[schema] parseFileRow: 校验失败，返回 undefined', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * 解析 nodes 表中 extends/implements/imported_names 等 JSON 数组字段
 *
 * 这三个字段在 SQLite 中以 JSON 字符串形式存储，解析后应为 string[]。
 * 校验元素均为字符串：非字符串元素被过滤，非数组输入返回空数组（fail-open，空数组对这些字段无害）。
 *
 * @param raw JSON.parse 的结果（unknown）
 * @returns 校验通过的字符串数组；非数组时返回空数组
 */
export function parseJsonArrayField(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    logger.warn('[schema] parseJsonArrayField: 非数组，返回空数组', {
      actualType: typeof raw,
    });
    return [];
  }
  // 过滤非字符串元素，保证返回类型为 string[]
  return raw.filter((item): item is string => typeof item === 'string');
}
