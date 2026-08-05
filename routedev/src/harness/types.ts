// src/harness/types.ts
// 检查点系统类型定义（Phase 10）
// 蓝图参考：第九节 9.2 CheckpointManager

import type { GoalPlan } from '../agent/goal-types.js';

/** 检查点记录 */
export interface Checkpoint {
  /** 唯一 ID（UUID 短格式） */
  id: string;
  /** 关联的步骤 ID（来自 GoalPlan.steps） */
  stepId?: number;
  /** 关联的目标 ID（来自 GoalPlan.id） */
  goalId?: string;
  /** Git commit hash */
  gitCommitHash: string;
  /** 创建时间戳 */
  timestamp: number;
  /** 描述（自动生成或用户指定） */
  description: string;
  /** 快照时的文件变更列表（相对于上一个检查点） */
  filesSnapshot: string[];
  /** 是否自动创建（vs 用户手动 /checkpoint） */
  isAutoCreated: boolean;
  /** 语义化摘要（LLM 生成，可选。不可用时回退到 description） */
  summary?: string;
  /** 统计信息 */
  stats?: { filesChanged: number; tokensUsed: number };
  /**
   * B-13：会话状态快照（创建时显式 captureSession 才写入）。
   * 恢复范围可解释：默认回滚仅触及 Git 文件；显式选择「文件+会话」才恢复此快照。
   * 注意：权限授权与远程 ACL 永不随 checkpoint 创建/回滚，本类型亦不含权限字段。
   */
  sessionSnapshot?: { goalPlan?: GoalPlan };
}

/**
 * 检查点摘要生成用的 LLM 客户端接口（最小化依赖，避免直接耦合 router 模块）
 * 与 ILLMClient.complete() 子集兼容
 */
export interface CheckpointLLMClient {
  complete(options: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  }): Promise<{ content: string }>;
}

/** 检查点差异（两个检查点之间的变更） */
export interface CheckpointDiff {
  /** 新增的文件 */
  filesAdded: string[];
  /** 修改的文件 */
  filesModified: string[];
  /** 删除的文件 */
  filesDeleted: string[];
  /** Git diff 的 patch 文本 */
  patch: string;
}

/** 检查点管理器配置 */
export interface CheckpointManagerConfig {
  /** 是否启用自动检查点 */
  enabled: boolean;
  /** 最大保留检查点数（超出自动清理最旧的） */
  maxCheckpoints: number;
  /** 工作目录（Git 仓库根目录） */
  workingDirectory: string;
}

/** 检查点创建选项 */
export interface CreateCheckpointOptions {
  /** 描述（不传则自动生成） */
  description?: string;
  /** 关联的步骤 ID */
  stepId?: number;
  /** 关联的目标 ID */
  goalId?: string;
  /** 是否自动创建 */
  isAutoCreated?: boolean;
  /** 本次检查点累计的 token 用量（用于 stats.tokensUsed） */
  tokensUsed?: number;
  /**
   * B-13：创建时同时快照会话状态（GoalPlan）。
   * 默认不开启——自动检查点不携带会话快照，「仅文件」回滚语义保持简单。
   */
  captureSession?: boolean;
}

/**
 * B-13：回滚范围。
 * - 'files'（默认）：仅 git reset 文件，绝不触碰会话/权限/ACL
 * - 'files+session'：git reset + 恢复检查点创建时快照的 GoalPlan（无快照时仅文件）
 */
export type RollbackScope = 'files' | 'files+session';

// 重新导出 GoalPlan 类型便于引用
export type { GoalPlan };
