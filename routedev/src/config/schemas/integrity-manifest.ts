// src/config/schemas/integrity-manifest.ts
// Phase 93 Task 6：完整性 manifest 持久化结构的运行时校验
//
// 仅校验关键字段（path / sha256 / recordedAt / source?），避免为每条记录重复定义类型。
// fail-open：校验失败时返回空 manifest，与 IntegrityManifest.load 原有行为一致。
//
// Phase 93 Task 8：新增 __schemaVersion 字段用于 migration 框架识别版本。
//   - version: 业务版本（manifest 格式，固定为 1）
//   - __schemaVersion: schema 版本（migration 框架使用，当前为 1）
// 两者职责不同，共存不冲突。

import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import type { IntegrityManifestFile } from '../../security/integrity-manifest.js';

/** 当前 schema 版本号（migration 框架使用） */
export const INTEGRITY_MANIFEST_SCHEMA_VERSION = 1;

/** 单条完整性记录的 schema */
const IntegrityRecordSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  recordedAt: z.number(),
  source: z.string().optional(),
});

/** manifest 持久化结构 schema（version 固定为 1，__schemaVersion 可选兼容旧文件） */
export const IntegrityManifestFileSchema = z.object({
  version: z.literal(1),
  records: z.record(z.string(), IntegrityRecordSchema),
  __schemaVersion: z.number().optional(),
});

/**
 * 解析 manifest 文件内容
 *
 * fail-open 策略：解析失败返回空 manifest（version: 1, records: {}），
 * 与 IntegrityManifest.load 在文件损坏时的行为保持一致，避免阻塞启动。
 */
export function parseIntegrityManifestFile(raw: unknown): IntegrityManifestFile {
  try {
    return IntegrityManifestFileSchema.parse(raw);
  } catch (err) {
    logger.warn('[schema] parseIntegrityManifestFile: 校验失败，返回空 manifest', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { version: 1, records: {} };
  }
}
