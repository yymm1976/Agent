// desktop/renderer/src/components/GoalExecutionCard.tsx
// Phase 54：Goal 执行结构化卡片——消费 store.goalExecutions，按 goalId 聚合就地刷新
// 设计原则：
//   - 运行态：目标标题 + 步骤列表（三态图标 Circle/Loader2/CheckCircle2/XCircle）
//   - 完成态：折叠为单行摘要，点击展开查看详情
//   - Agent 活动：每个步骤下可折叠的时间线日志
//   - 图标统一用 lucide-react 线性图标（1.5px stroke），不用默认 emoji

import { useState, useEffect } from 'react';
import {
  Circle, Loader2, CheckCircle2, XCircle,
  ChevronRight, ChevronDown, Target, Timer, ShieldCheck, ShieldAlert,
} from 'lucide-react';
import type { GoalExecution, GoalStepState } from '../store/useRouteDevStore.js';

/**
 * Phase 54：运行态实时耗时 Hook——每秒触发组件重渲染，更新"已运行 X 秒"显示
 * 完成态自动停止定时器（避免无意义刷新）
 */
function useRunningTimer(isRunning: boolean, startedAt: number | undefined): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning || !startedAt) return;
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [isRunning, startedAt]);
  return startedAt ? Date.now() - startedAt : 0;
}

/** 格式化耗时（毫秒）为可读字符串 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}秒`;
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}分${sec}秒`;
}

/** 步骤状态图标：pending=Circle灰，running=Loader2旋转，completed=CheckCircle2绿，failed=XCircle红 */
function StepStatusIcon({ status }: { status: GoalStepState['status'] }) {
  if (status === 'running') {
    return <Loader2 size={14} strokeWidth={1.5} className="shrink-0 animate-spin text-rd-primary" />;
  }
  if (status === 'completed') {
    return <CheckCircle2 size={14} strokeWidth={1.5} className="shrink-0 text-rd-success" />;
  }
  if (status === 'failed') {
    return <XCircle size={14} strokeWidth={1.5} className="shrink-0 text-rd-danger" />;
  }
  return <Circle size={14} strokeWidth={1.5} className="shrink-0 text-rd-textMuted" />;
}

/** 单个步骤行：状态图标 + 描述 + 耗时 + 可折叠 Agent 活动 */
function StepRow({ step, index, runningElapsedMs }: { step: GoalStepState; index: number; runningElapsedMs?: number }) {
  const hasActivities = step.activities.length > 0;
  const [showActivities, setShowActivities] = useState(false);

  // 完成态显示 durationMs；运行态显示 runningElapsedMs（由父组件通过定时器提供）
  const timeText = step.durationMs !== undefined
    ? formatDuration(step.durationMs)
    : (step.status === 'running' && runningElapsedMs !== undefined)
      ? formatDuration(runningElapsedMs)
      : '';

  return (
    <div className="relative">
      <span className="absolute -left-3 top-[0.6rem] h-px w-3 bg-rd-tree-line" aria-hidden />
      <div className="flex items-start gap-2 py-1">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StepStatusIcon status={step.status} />
          <span className="text-xs text-rd-textSubtle shrink-0">{String(index + 1).padStart(2, '0')}.</span>
          <span className={[
            'text-xs truncate',
            step.status === 'pending' ? 'text-rd-textMuted' : 'text-rd-text',
          ].join(' ')}>
            {step.description}
          </span>
          {timeText && (
            <span className="text-xs text-rd-textSubtle shrink-0 flex items-center gap-0.5">
              <Timer size={11} strokeWidth={1.5} />
              {timeText}
            </span>
          )}
        </div>
        {hasActivities && (
          <button
            type="button"
            onClick={() => setShowActivities(v => !v)}
            className="shrink-0 text-rd-textSubtle hover:text-rd-text transition"
            aria-label={showActivities ? '折叠 Agent 活动' : '展开 Agent 活动'}
          >
            {showActivities
              ? <ChevronDown size={12} strokeWidth={1.5} />
              : <ChevronRight size={12} strokeWidth={1.5} />}
          </button>
        )}
      </div>
      {step.error && (
        <div className="ml-6 mb-1 text-xs text-rd-danger">{step.error}</div>
      )}
      {hasActivities && showActivities && (
        <div className="ml-6 mb-2 space-y-0.5">
          {step.activities.map((act, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-rd-textMuted">
              <span className="shrink-0 text-rd-primary/70 font-mono text-[10px] mt-0.5">[{act.role}]</span>
              <span className="break-all">{act.activity}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 验证结果区块 */
function VerificationBlock({ verification }: {
  verification: NonNullable<GoalExecution['verification']>;
}) {
  const passed = verification.passed;
  return (
    <div className="relative mt-1">
      <span className="absolute -left-3 top-[0.6rem] h-px w-3 bg-rd-tree-line" aria-hidden />
      <div className="flex items-start gap-2 py-1">
        {passed
          ? <ShieldCheck size={14} strokeWidth={1.5} className="shrink-0 text-rd-success" />
          : <ShieldAlert size={14} strokeWidth={1.5} className="shrink-0 text-rd-warning" />}
        <span className="text-xs font-medium text-rd-text">验证结果</span>
        <span className="text-xs text-rd-textSubtle">
          置信度 {(verification.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div className="ml-6 text-xs text-rd-textMuted break-all">{verification.reasoning}</div>
      {verification.missingItems.length > 0 && (
        <div className="ml-6 text-xs text-rd-warning">
          缺失项: {verification.missingItems.join('; ')}
        </div>
      )}
    </div>
  );
}

interface GoalExecutionCardProps {
  execution: GoalExecution;
}

/** Goal 执行卡片：运行态展示步骤进度，完成态折叠为单行摘要 */
export function GoalExecutionCard({ execution }: GoalExecutionCardProps) {
  const isDone = execution.status === 'completed' || execution.status === 'failed';
  const [expanded, setExpanded] = useState(!isDone);

  const completedCount = execution.steps.filter(s => s.status === 'completed').length;
  const totalCount = execution.steps.length;
  const isRunning = execution.status === 'running';

  // Phase 54：运行态实时总耗时（每秒刷新）
  const runningElapsedMs = useRunningTimer(isRunning, execution.createdAt);
  // 找到当前 running 的步骤，传给它实时耗时
  const runningStep = execution.steps.find(s => s.status === 'running');
  const runningStepElapsedMs = runningStep?.startedAt ? Date.now() - runningStep.startedAt : undefined;

  // 进度百分比（completed + running * 0.5）
  const progressPercent = totalCount > 0
    ? Math.min(100, Math.round((completedCount / totalCount) * 100))
    : 0;

  // 完成态 + 已折叠：单行摘要
  if (isDone && !expanded) {
    const success = execution.done?.success ?? false;
    return (
      <div className="flex items-center gap-2 py-1.5 px-1">
        {success
          ? <CheckCircle2 size={14} strokeWidth={1.5} className="shrink-0 text-rd-success" />
          : <XCircle size={14} strokeWidth={1.5} className="shrink-0 text-rd-danger" />}
        <span className="text-xs text-rd-text truncate flex-1">{execution.done?.summary ?? '目标执行结束'}</span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 flex items-center gap-0.5 text-xs text-rd-textSubtle hover:text-rd-text transition"
        >
          展开
          <ChevronRight size={12} strokeWidth={1.5} />
        </button>
      </div>
    );
  }

  // 运行态 / 展开态：完整卡片
  // Phase 54 修复：rounded-lg → rounded-rd（与消息气泡主题一致），去掉 border（白色弯角割裂），
  // 用 bg-rd-surfaceHover 与背景区分，shadow-rd 提供层次感
  return (
    <div className="rounded-rd bg-rd-surfaceHover px-3 py-2 shadow-rd">
      {/* 标题行：目标 + 进度 + 耗时 + 折叠按钮 */}
      <div className="flex items-center gap-2">
        <Target size={14} strokeWidth={1.5} className="shrink-0 text-rd-primary" />
        <span className="text-xs font-medium text-rd-text truncate flex-1">{execution.description}</span>
        <span className="text-xs text-rd-textSubtle shrink-0">{completedCount}/{totalCount}</span>
        {isRunning && <Loader2 size={12} strokeWidth={1.5} className="shrink-0 animate-spin text-rd-primary" />}
        {/* Phase 54：耗时显示——完成态用 done.totalDurationMs，运行态用 runningElapsedMs（每秒刷新） */}
        {(execution.done || isRunning) && (
          <span className="text-xs text-rd-textSubtle shrink-0 flex items-center gap-0.5">
            <Timer size={11} strokeWidth={1.5} />
            {execution.done
              ? formatDuration(execution.done.totalDurationMs)
              : formatDuration(runningElapsedMs)}
          </span>
        )}
        {isDone && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="shrink-0 flex items-center gap-0.5 text-xs text-rd-textSubtle hover:text-rd-text transition"
          >
            折叠
            <ChevronDown size={12} strokeWidth={1.5} />
          </button>
        )}
      </div>

      {/* Phase 54：整体进度条——基于 completedCount/totalCount，运行态动态增长 */}
      {totalCount > 0 && (
        <div className="mt-1.5 h-1 rounded-full bg-rd-border/40 overflow-hidden" aria-hidden>
          <div
            className="h-full bg-rd-primary transition-all duration-300 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      {/* 步骤列表（用 border-l 提供竖线，子项用 TreeBranch 风格挂接） */}
      <div className="ml-1 mt-1 border-l border-rd-tree-line pl-3">
        {execution.steps.map((step, i) => (
          <StepRow
            key={step.id}
            step={step}
            index={i}
            runningElapsedMs={step.status === 'running' ? runningStepElapsedMs : undefined}
          />
        ))}
        {execution.verification && <VerificationBlock verification={execution.verification} />}
      </div>
    </div>
  );
}
