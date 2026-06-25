// src/scheduler/types.ts
// Phase 37 Task 2：调度器类型定义
// 定义定时任务、执行状态、执行记录等核心数据结构

/**
 * 定时任务定义
 * 描述一个可被调度引擎周期性触发的任务
 */
export interface ScheduledTask {
  /** 任务唯一标识 */
  id: string;
  /** 任务名称（人类可读） */
  name: string;
  /** 任务目标描述（触发后交给 Agent 执行） */
  goal: string;
  /** cron 表达式（5 字段：分 时 日 月 周） */
  cron: string;
  /** 时区名称（如 Asia/Shanghai） */
  timezone: string;
  /** 是否启用 */
  enabled: boolean;
  /** 上次执行时间戳（毫秒） */
  lastRun?: number;
  /** 下次执行时间戳（毫秒） */
  nextRun?: number;
  /** 已执行次数 */
  runCount: number;
  /** 最大执行次数（达到后自动禁用，可选） */
  maxRuns?: number;
  /** 完成后是否通知用户 */
  notifyOnComplete: boolean;
  /** 创建时间戳（毫秒） */
  createdAt: number;
}

/** 任务执行状态 */
export type TaskStatus = 'idle' | 'running' | 'completed' | 'failed';

/**
 * 任务执行记录
 * 每次触发执行时生成一条
 */
export interface TaskExecutionRecord {
  /** 关联的任务 ID */
  taskId: string;
  /** 开始时间戳 */
  startedAt: number;
  /** 结束时间戳（未结束时为 undefined） */
  finishedAt?: number;
  /** 执行状态 */
  status: TaskStatus;
  /** 执行结果摘要（成功时） */
  result?: string;
  /** 错误信息（失败时） */
  error?: string;
}
