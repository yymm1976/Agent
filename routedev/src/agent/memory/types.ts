// src/agent/memory/types.ts
// 增量 Checkpoint + 上下文压缩的类型定义（Phase 11）
// 蓝图参考：第十节 10.3（CheckpointWriter）、10.4（上下文压缩策略）

import type { LLMMessage } from '../../router/types.js';

/** Checkpoint 触发级别（对应 config.checkpoint.triggers） */
export type CheckpointLevel = 'initial' | 'incremental' | 'compress';

/** Checkpoint 触发结果 */
interface CheckpointTriggerResult {
  /** 需要执行的动作（null 表示当前不需要触发） */
  action: CheckpointLevel | null;
  /** 当前 token 消耗百分比（0-1） */
  usagePercent: number;
  /** 触发阈值（20/45/70） */
  threshold: number;
}

/**
 * 结构化 Checkpoint 数据（11 字段）
 * 蓝图 10.3：每次 checkpoint 是对前一次的增量更新
 */
export interface CheckpointData {
  /** 1. 当前意图——用户想做什么 */
  currentIntent: string;
  /** 2. 下一步动作——接下来该做什么 */
  nextAction: string;
  /** 3. 工作约束——不能做什么、必须遵守什么 */
  workingConstraints: string[];
  /** 4. 任务树——主任务 + 子任务状态 */
  taskTree: TaskTreeNode;
  /** 5. 当前正在操作的文件 */
  currentWorkingFiles: string[];
  /** 6. 涉及的所有文件（包括历史） */
  involvedFiles: string[];
  /** 7. 跨任务发现——意外发现的关联或模式 */
  crossTaskDiscoveries: string[];
  /** 8. 错误与修复方案 */
  errorsAndFixes: ErrorAndFix[];
  /** 9. 运行时状态（环境变量、工具状态等） */
  runtimeState: Record<string, string>;
  /** 10. 设计决策及理由 */
  designDecisions: DesignDecision[];
  /** 11. 杂项笔记 */
  miscNotes: string[];
}

/** 任务树节点 */
interface TaskTreeNode {
  /** 任务描述 */
  description: string;
  /** 状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** 子任务 */
  children: TaskTreeNode[];
}

/** 错误与修复记录 */
export interface ErrorAndFix {
  /** 错误描述 */
  error: string;
  /** 修复方案 */
  fix: string;
  /** 是否已修复 */
  resolved: boolean;
}

/** 设计决策 */
export interface DesignDecision {
  /** 决策内容 */
  decision: string;
  /** 为什么这样决定 */
  reason: string;
}

/** CheckpointWriter 的输入 */
export interface CheckpointWriterInput {
  /** 触发级别 */
  level: CheckpointLevel;
  /** 当前对话历史（最近 N 条，不是全部） */
  recentMessages: LLMMessage[];
  /** 上一次的 checkpoint 数据（首次时为 null） */
  previousCheckpoint: CheckpointData | null;
  /** notes.md 的内容 */
  notes: string;
  /** 当前 token 消耗百分比 */
  usagePercent: number;
}

/** CheckpointWriter 的输出 */
export interface CheckpointWriterOutput {
  /** 更新后的 checkpoint 数据 */
  checkpoint: CheckpointData;
  /** Writer 自己的备注（调试用） */
  writerNotes: string;
}

/** 上下文压缩配置 */
export interface ContextManagerConfig {
  /** 模型上下文窗口大小（token 数） */
  contextWindow: number;
  /** 压缩触发阈值（默认 0.8 = 80%） */
  compressionThreshold: number;
  /** 压缩后保留的最近消息数 */
  keepRecentMessages: number;
  /** Checkpoint 是否启用 */
  checkpointEnabled: boolean;
  /** Phase 38 Task 4.2：项目工作目录，用于定位知识图谱持久化路径 */
  cwd?: string;
  /** Phase 45：记忆配置（推理/自动学习/注入阈值） */
  memory?: import('../../config/schema.js').MemoryConfig;
}

/** 上下文压缩结果 */
export interface CompressionResult {
  /** 压缩前的消息数 */
  originalCount: number;
  /** 压缩后的消息数 */
  compressedCount: number;
  /** 被压缩的消息摘要（用于调试） */
  summary: string;
  /** 压缩后保留的 checkpoint 快照 */
  checkpointSnapshot: CheckpointData | null;
}
