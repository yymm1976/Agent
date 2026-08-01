// src/runtime/automation-scheduler.ts
// Phase 97 Part F：轻量自动化调度器——定时触发复用统一 Session 执行
//
// 设计目的（承接 Phase 74 移除的 ScheduleEngine 空窗）：
//   - 每个定时触发都落到统一 Agent Session 执行（复用 Part A 执行上下文），
//     而非独立引擎：保留模型/工作区/权限模式/上下文/运行历史
//   - 权限白名单（allowlist）而非 bypassPermissions：读文件允许、修改指定工作区允许、
//     删除禁止、发布推送二次批准（走 Part C 中断队列）
//   - 配置带 version 与迁移逻辑，发现磁盘版本更新时不覆盖
//
// 实现约束：
//   - 不引入外部 cron 库，自实现标准 5 段 cron 匹配（minute hour dom month dow）
//   - 调度粒度：每分钟 tick 一次（对桌面应用足够）
//   - 执行器由装配层注入（desktop 层注册 → engine.sendChat），本模块只做调度与历史

import { logger } from '../utils/logger.js';
import {
  buildSuggestion,
  EVALUATION_INTERVAL,
  SuggestionApprovalQueue,
  type AutomationFeedback,
  type AutomationSuggestion,
} from './automation-evolution.js';

/** 自动化任务定义（持久化于 config.automations） */
export interface AutomationTask {
  id: string;
  name: string;
  /** 标准 5 段 cron：分 时 日 月 周 */
  cron: string;
  workspaceId?: string;
  permissionMode: 'manual' | 'semi' | 'auto';
  /** 预授权能力白名单（读指定路径/写指定工作区/执行测试等） */
  allowlist: string[];
  prompt: string;
  /** 配置版本（迁移用）：磁盘版本高于内存时不覆盖 */
  version: number;
}

/** 任务运行历史记录 */
export interface AutomationRunRecord {
  taskId: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  error?: string;
  durationMs: number;
}

/** 调度器选项 */
export interface AutomationSchedulerOptions {
  /** tick 间隔（毫秒，默认 60_000；测试注入小值） */
  tickMs?: number;
}

/** 执行器签名（装配层注入） */
export type AutomationExecutor = (task: AutomationTask) => Promise<{ ok: boolean; error?: string }>;

/**
 * 标准 5 段 cron 匹配
 * 字段顺序：minute(0-59) hour(0-23) dayOfMonth(1-31) month(1-12) dayOfWeek(0-6, 0=周日)
 * 支持：星号任意、数字、逗号列表（如 "0,30"）、斜杠 n 步进
 * @returns 给定日期是否匹配该 cron
 */
export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const dowValue = date.getDay(); // 0=周日，与 cron 一致
  return (
    matchField(minute, date.getMinutes()) &&
    matchField(hour, date.getHours()) &&
    matchField(dom, date.getDate()) &&
    matchField(month, date.getMonth() + 1) &&
    matchField(dow, dowValue)
  );
}

/** 单字段匹配：星号 / 数字 / 逗号列表 / 斜杠 n 步进 */
function matchField(field: string, value: number): boolean {
  if (field === '*') return true;
  const lower = value >= 0 ? value % 60 : value;
  for (const part of field.split(',')) {
    if (part === '*') return true;
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (step > 0 && lower % step === 0) return true;
      continue;
    }
    if (/^\d+$/.test(part) && Number(part) === value) return true;
  }
  return false;
}

/**
 * 配置版本迁移：把旧格式自动化配置迁到当前版本
 * @param raw 磁盘读取的原始配置（可能是旧版本）
 * @returns 迁移后的任务数组（保持磁盘优先，内存新字段用默认值补全）
 */
export function migrateAutomationTasks(raw: unknown): AutomationTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      // version 缺失视为 v1 旧配置：补 allowlist/version/permissionMode 默认值
      const version = typeof item.version === 'number' ? item.version : 1;
      return {
        id: typeof item.id === 'string' ? item.id : `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: typeof item.name === 'string' ? item.name : '未命名任务',
        cron: typeof item.cron === 'string' && item.cron.trim().split(/\s+/).length === 5
          ? item.cron
          : '0 9 * * *',
        workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : undefined,
        permissionMode: item.permissionMode === 'manual' || item.permissionMode === 'semi' || item.permissionMode === 'auto'
          ? item.permissionMode
          : 'semi',
        // v1 旧配置：bypassPermissions 存在时收敛为 allowlist（白名单而非跳过权限）
        allowlist: Array.isArray(item.allowlist)
          ? item.allowlist.filter((a): a is string => typeof a === 'string')
          : Array.isArray(item.bypassPermissions) && (item.bypassPermissions as unknown[]).length === 0
            ? []
            : [],
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
        version,
      } as AutomationTask;
    });
}

/**
 * 权限白名单校验：允许能力
 * 语义：allowlist 为空 = 无预授权（仍走正常权限引擎）；非空时仅允许显式列出的能力
 * 预授权能力格式：`read:<path>` / `write:<path>` / `run:<command-prefix>` / `tool:<name>`
 */
export function isAllowedByAllowlist(allowlist: string[], capability: string): boolean {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  for (const entry of allowlist) {
    if (entry === capability) return true;
    // 前缀匹配：read: 对应 read:src/，run: 对应 run:npm
    if (capability.startsWith(entry)) return true;
  }
  return false;
}

/**
 * 自动化调度器
 * 生命周期：构造 → 装配层注入 executor → start() → stop()
 */
export class AutomationScheduler {
  private tasks: AutomationTask[];
  private executor: AutomationExecutor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickMs: number;
  private readonly history: AutomationRunRecord[] = [];
  /** 上次检查的分钟键（防同分钟重复触发） */
  private lastTickedKey = '';
  private readonly maxHistory = 200;
  /** 执行反馈累积（评估窗口；approveSuggestion 批准后重置） */
  private readonly feedbacks: AutomationFeedback[] = [];
  /** 反馈保留上限（长驻进程内存保护；超过后丢弃最旧） */
  private static readonly MAX_FEEDBACKS = 200;
  /** 修订建议审批队列：本调度器生产，装配层消费（人工审批后应用） */
  private readonly suggestionQueue = new SuggestionApprovalQueue();

  constructor(tasks: AutomationTask[], options?: AutomationSchedulerOptions) {
    this.tasks = tasks;
    this.tickMs = options?.tickMs ?? 60_000;
  }

  /** 注入执行器（装配层调用；重复注入覆盖） */
  setExecutor(executor: AutomationExecutor): void {
    this.executor = executor;
  }

  /** 替换任务列表（配置重载时调用） */
  setTasks(tasks: AutomationTask[]): void {
    this.tasks = tasks;
  }

  /** 获取当前任务列表 */
  listTasks(): AutomationTask[] {
    return this.tasks.slice();
  }

  /** 获取运行历史（按时间倒序） */
  getHistory(taskId?: string): AutomationRunRecord[] {
    const filtered = taskId ? this.history.filter((r) => r.taskId === taskId) : this.history;
    return filtered.slice().reverse();
  }

  /** 启动调度（每分钟检查一次；无 executor 时不启动 timer） */
  start(): void {
    if (this.timer || !this.executor) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    logger.info('AutomationScheduler started', { tasks: this.tasks.length, tickMs: this.tickMs });
  }

  /** 停止调度 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('AutomationScheduler stopped');
  }

  /** 立即检查一次当前时间点是否有任务到期（测试/手动触发用） */
  async tick(now: Date = new Date()): Promise<void> {
    if (!this.executor) return;
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === this.lastTickedKey) return; // 同一分钟不重复
    this.lastTickedKey = key;

    for (const task of this.tasks) {
      if (!cronMatches(task.cron, now)) continue;
      await this.runTask(task);
    }
  }

  /** 执行单个任务（记录历史；失败不抛出，不影响其他任务） */
  private async runTask(task: AutomationTask): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.executor!(task);
      const finishedAt = Date.now();
      this.pushHistory({
        taskId: task.id,
        startedAt,
        finishedAt,
        ok: result.ok,
        error: result.error,
        durationMs: finishedAt - startedAt,
      });
      this.pushFeedback(
        {
          taskId: task.id,
          ok: result.ok,
          error: result.error,
          durationMs: finishedAt - startedAt,
          timestamp: finishedAt,
        },
        task.prompt,
      );
      logger.info('AutomationScheduler task executed', {
        taskId: task.id,
        ok: result.ok,
        error: result.error,
      });
    } catch (err) {
      const finishedAt = Date.now();
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.pushHistory({
        taskId: task.id,
        startedAt,
        finishedAt,
        ok: false,
        error: errorMsg,
        durationMs: finishedAt - startedAt,
      });
      this.pushFeedback(
        {
          taskId: task.id,
          ok: false,
          error: errorMsg,
          durationMs: finishedAt - startedAt,
          timestamp: finishedAt,
        },
        task.prompt,
      );
      logger.warn('AutomationScheduler task failed', {
        taskId: task.id,
        error: errorMsg,
      });
    }
  }

  /**
   * 累积一次执行反馈；每 EVALUATION_INTERVAL 次评估一次修订建议。
   * fail-open：评估/入队异常只记日志，不影响调度主流程。
   */
  private pushFeedback(feedback: AutomationFeedback, currentPrompt: string): void {
    this.feedbacks.push(feedback);
    const shouldEvaluate = this.feedbacks.length % EVALUATION_INTERVAL === 0;
    if (shouldEvaluate) {
      try {
        const suggestion = buildSuggestion(feedback.taskId, this.feedbacks, currentPrompt);
        if (suggestion) this.suggestionQueue.submit(suggestion);
      } catch (err) {
        logger.warn('AutomationScheduler suggestion evaluation failed', {
          taskId: feedback.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // 上限保护：只保留最近 MAX_FEEDBACKS 条，防止长驻进程无界累积（先判定后截断，保持评估周期稳定）
    if (this.feedbacks.length > AutomationScheduler.MAX_FEEDBACKS) {
      this.feedbacks.splice(0, this.feedbacks.length - AutomationScheduler.MAX_FEEDBACKS);
    }
  }

  /** 列出待审批的修订建议（装配层展示，等待人工审批） */
  listPendingSuggestions(): AutomationSuggestion[] {
    return this.suggestionQueue.listPending();
  }

  /**
   * 批准建议：返回被批准的建议（装配层据此更新任务 prompt），
   * 不自动修改 task.prompt——人工审批后由装配层应用。
   * 批准成功后重置反馈评估窗口，下一轮执行重新计数。
   */
  approveSuggestion(taskId: string): AutomationSuggestion | null {
    const suggestion = this.suggestionQueue.approve(taskId);
    if (suggestion) this.feedbacks.length = 0;
    return suggestion;
  }

  /** 拒绝建议（不重置反馈窗口；已拒绝的建议不可再批准） */
  rejectSuggestion(taskId: string): boolean {
    return this.suggestionQueue.reject(taskId);
  }

  private pushHistory(record: AutomationRunRecord): void {
    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }
}
