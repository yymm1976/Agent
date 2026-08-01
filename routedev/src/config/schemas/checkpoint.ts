// src/config/schemas/checkpoint.ts
// Phase 93 Task 6：GoalPlan 持久化结构的运行时校验
//
// 与 goal-persistence.ts 同思路：GoalPlan 嵌套 steps/verificationResult/attestation
// 等复杂结构，仅校验顶层关键字段，passthrough 保留其余字段。
//
// Phase 93 Task 8：__schemaVersion 字段由 migration 框架在 save 时写入，
// 由于 passthrough 策略，load 时该字段会被保留，无需在 schema 中显式声明。

import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import type { GoalPlan } from '../../agent/goal-types.js';

/** 当前 schema 版本号（migration 框架使用） */
export const GOAL_PLAN_SCHEMA_VERSION = 1;

/**
 * 目标计划的宽松 schema
 *
 * 仅校验顶层关键字段：id / description / steps / status / createdAt。
 * steps 用 z.array(z.unknown()) 兜底（结构由业务层读取时再校验），
 * verificationResult/attestation/archivedVersions 等可选字段不在关键路径上，passthrough 保留。
 */
export const GoalPlanSchema = z.object({
  id: z.string(),
  description: z.string(),
  steps: z.array(z.unknown()),
  status: z.string(),
  createdAt: z.number(),
}).passthrough();

/**
 * 解析目标计划数据
 *
 * fail-open 策略：校验失败返回 null，与 CheckpointManager.loadGoalPlan
 * 在文件损坏时返回 null 的行为保持一致，避免阻塞 checkpoint 续跑。
 */
export function parseGoalPlan(raw: unknown): GoalPlan | null {
  try {
    return GoalPlanSchema.parse(raw) as GoalPlan;
  } catch (err) {
    logger.warn('[schema] parseGoalPlan: 校验失败，返回 null', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
