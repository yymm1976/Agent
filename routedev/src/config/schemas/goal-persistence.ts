// src/config/schemas/goal-persistence.ts
// Phase 93 Task 6：PersistedGoal 持久化结构的运行时校验
//
// PersistedGoal 嵌套 spec/plan/attestation 等复杂结构，全量校验成本高且容易随业务演进失效。
// 采用宽松策略：仅校验顶层关键字段存在性与类型，passthrough 保留其余字段，
// 让业务层在读取时按需做更细的字段校验。
//
// Phase 93 Task 8：__schemaVersion 字段由 migration 框架在 save 时写入，
// 由于 passthrough 策略，load 时该字段会被保留，无需在 schema 中显式声明。

import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import type { PersistedGoal } from '../../agent/goal-persistence.js';

/** 当前 schema 版本号（migration 框架使用） */
export const PERSISTED_GOAL_SCHEMA_VERSION = 1;

/**
 * 持久化目标的宽松 schema
 *
 * 仅校验顶层关键字段：id / spec / plan / status / checkpointIds /
 * createdAt / updatedAt / tokenUsed / tokenBudget。
 * spec 与 plan 用 z.unknown() 兜底（结构由业务层读取时再校验），其余字段 passthrough 保留。
 */
export const PersistedGoalSchema = z.object({
  id: z.string(),
  spec: z.unknown(),
  plan: z.unknown(),
  status: z.string(),
  checkpointIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  tokenUsed: z.number(),
  tokenBudget: z.number(),
  progressReport: z.string().optional(),
}).passthrough();

/**
 * 解析持久化的 goal 数据
 *
 * fail-open 策略：校验失败返回 null，与 GoalPersistence.load/tryReadGoalFile
 * 在文件损坏时返回 null 的行为保持一致，避免阻塞续跑流程。
 */
export function parsePersistedGoal(raw: unknown): PersistedGoal | null {
  try {
    return PersistedGoalSchema.parse(raw) as PersistedGoal;
  } catch (err) {
    logger.warn('[schema] parsePersistedGoal: 校验失败，返回 null', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
