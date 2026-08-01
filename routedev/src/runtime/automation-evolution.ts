// src/runtime/automation-evolution.ts
// Phase 97 Part F：自动化自我迭代——执行反馈 → 修订建议 → 人工审批后生效
//
// 设计原则（对齐 Proma automation-scheduler）：
//   - 每次执行后收集结果（成功/失败/耗时），写入任务运行历史
//   - 定期（每 N 次执行）把「重复失败的失败原因」聚类，生成 prompt 修订建议
//   - 建议进入审批队列，用户批准后才应用到任务定义（不自动写入）
//
// 与 skill-lifecycle 的 Refinement 审批一致：建议永不自动应用。
//
// 生产/消费（Phase 97 Part F 接入）：本模块由 automation-scheduler.ts 驱动——
// 调度器每次执行后 push 一条 AutomationFeedback，每 EVALUATION_INTERVAL 次
// 调用 buildSuggestion 并把结果 submit 到 SuggestionApprovalQueue；用户通过
// scheduler.approveSuggestion / rejectSuggestion 审批，批准后的建议由装配层
// 应用到任务定义（scheduler 本身不自动改 task.prompt）。

/** 单次执行反馈 */
export interface AutomationFeedback {
  taskId: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  timestamp: number;
}

/** 修订建议 */
export interface AutomationSuggestion {
  taskId: string;
  /** 聚类出的失败原因（去重后的文本） */
  failurePatterns: string[];
  /** 建议的 prompt 修订（追加修订指引） */
  suggestedPrompt: string;
  /** 生成时间 */
  createdAt: number;
}

/** 生成建议的阈值：每 N 次执行后评估一次 */
export const EVALUATION_INTERVAL = 5;

/** 生成建议的最小失败次数（防噪声） */
export const MIN_FAILURES_FOR_SUGGESTION = 3;

/**
 * 基于运行历史生成 prompt 修订建议
 * 规则：最近 N 次执行中失败次数 >= MIN_FAILURES_FOR_SUGGESTION 时，
 * 收集失败原因（去重），生成追加修订指引的 prompt 建议。
 * @returns 建议；不满足阈值时返回 null
 */
export function buildSuggestion(
  taskId: string,
  history: AutomationFeedback[],
  currentPrompt: string,
): AutomationSuggestion | null {
  const recent = history.filter((h) => h.taskId === taskId).slice(-EVALUATION_INTERVAL);
  if (recent.length < EVALUATION_INTERVAL) return null;

  const failures = recent.filter((h) => !h.ok);
  if (failures.length < MIN_FAILURES_FOR_SUGGESTION) return null;

  const patterns = [...new Set(failures.map((f) => f.error ?? '未知错误').filter(Boolean))];
  const revisionGuide = patterns
    .map((p) => `- 最近失败原因：${p}`)
    .join('\n');

  return {
    taskId,
    failurePatterns: patterns,
    suggestedPrompt: [
      currentPrompt,
      '',
      '【修订指引（基于最近执行反馈）】',
      revisionGuide,
      '请针对上述失败原因调整执行方式：优先验证前置条件、补充错误处理、明确输出格式。',
    ].join('\n'),
    createdAt: Date.now(),
  };
}

/**
 * 建议审批队列
 * 状态机：pending → approved（应用到任务定义）/ rejected
 */
export class SuggestionApprovalQueue {
  private suggestions = new Map<string, AutomationSuggestion>();
  private approved = new Set<string>();
  private rejected = new Set<string>();

  /** 入队建议（同一 taskId 的旧建议被覆盖） */
  submit(suggestion: AutomationSuggestion): void {
    this.suggestions.set(suggestion.taskId, suggestion);
    this.approved.delete(suggestion.taskId);
    this.rejected.delete(suggestion.taskId);
  }

  /** 列出待审批建议 */
  listPending(): AutomationSuggestion[] {
    return [...this.suggestions.values()]
      .filter((s) => !this.approved.has(s.taskId) && !this.rejected.has(s.taskId));
  }

  /** 批准建议：返回建议内容（调用方据此更新任务定义）；已拒绝的建议不可批准 */
  approve(taskId: string): AutomationSuggestion | null {
    if (this.rejected.has(taskId)) return null;
    const suggestion = this.suggestions.get(taskId);
    if (!suggestion) return null;
    this.approved.add(taskId);
    return suggestion;
  }

  /** 拒绝建议 */
  reject(taskId: string): boolean {
    if (!this.suggestions.has(taskId)) return false;
    this.rejected.add(taskId);
    return true;
  }

  /** 是否已批准 */
  isApproved(taskId: string): boolean {
    return this.approved.has(taskId);
  }
}
