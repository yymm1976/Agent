// desktop/renderer/src/components/session/SessionStatusCard.tsx
// Phase 77 借鉴点 4：Voice Memo 式会话状态卡
//
// 设计参考：HomeRail Voice Memo 卡片模式（标题 + 状态徽章 + 摘要 + 事实标签 + 待办列表 + 下一步）
// 与 GoalExecutionCard 互补：状态卡提供"会话全局视角"（含 facts / open questions / token 预算），
// 执行卡提供"步骤时序视角"（实时步骤状态 + Agent 活动日志）。
//
// UI 库：复用项目内 shadcn/ui 风格组件（Card / Badge / Alert / Separator）+ lucide-react 图标
// 不使用 antd（项目未安装 antd）

import { useState, memo } from 'react';
import {
  CheckCircle2,
  MinusCircle,
  Circle,
  Loader2,
  PauseCircle,
  XCircle,
  Target,
  Lightbulb,
  HelpCircle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { SessionStatus, SessionStatusTodo } from '../../../../shared/ipc-types.js';
import { Card } from '../ui/card.js';
import { Badge } from '../ui/badge.js';
import { Alert, AlertTitle, AlertDescription } from '../ui/alert.js';
import { Separator } from '../ui/separator.js';

// ============================================================
// 子组件
// ============================================================

/** 状态徽章变体映射（executing=蓝/paused=黄/completed=绿/failed=红/idle=灰） */
function StatusBadge({ status }: { status: SessionStatus['status'] }) {
  const config: Record<
    SessionStatus['status'],
    { variant: 'primary' | 'success' | 'destructive' | 'default'; icon: typeof Circle; label: string; spin?: boolean }
  > = {
    executing: { variant: 'primary', icon: Loader2, label: '执行中', spin: true },
    paused: { variant: 'default', icon: PauseCircle, label: '已暂停' },
    completed: { variant: 'success', icon: CheckCircle2, label: '已完成' },
    failed: { variant: 'destructive', icon: XCircle, label: '失败' },
    idle: { variant: 'default', icon: Circle, label: '空闲' },
  };
  const c = config[status];
  const Icon = c.icon;
  return (
    <Badge variant={c.variant} className="gap-1.5">
      <Icon size={12} strokeWidth={1.5} className={c.spin ? 'animate-spin' : ''} aria-hidden />
      {c.label}
    </Badge>
  );
}

/** 已知事实区：标签列表 */
function KnownFactsBlock({ facts }: { facts: string[] }) {
  if (facts.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-rd-textSubtle">
        <Lightbulb size={12} strokeWidth={1.5} className="shrink-0" />
        <span>已知事实</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {facts.map((fact, i) => (
          <Badge key={i} variant="outline" className="text-[11px] font-normal max-w-full">
            <span className="truncate">{fact}</span>
          </Badge>
        ))}
      </div>
    </div>
  );
}

/** 未决问题区：列表 */
function OpenQuestionsBlock({ questions }: { questions: string[] }) {
  if (questions.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-rd-textSubtle">
        <HelpCircle size={12} strokeWidth={1.5} className="shrink-0" />
        <span>未决问题</span>
      </div>
      <ul className="space-y-1">
        {questions.map((q, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs text-rd-text">
            <span className="shrink-0 text-rd-textMuted mt-0.5">{i + 1}.</span>
            <span className="break-all">{q}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 单个待办条目：勾选状态图标 + 文本 */
function TodoItem({ todo, index }: { todo: SessionStatusTodo; index: number }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      {todo.done ? (
        <CheckCircle2 size={14} strokeWidth={1.5} className="shrink-0 text-rd-success mt-0.5" />
      ) : (
        <MinusCircle size={14} strokeWidth={1.5} className="shrink-0 text-rd-textMuted mt-0.5" />
      )}
      <span className="text-xs text-rd-textSubtle shrink-0 mt-0.5">
        {String(index + 1).padStart(2, '0')}.
      </span>
      <span
        className={[
          'text-xs break-all',
          todo.done ? 'text-rd-textMuted line-through' : 'text-rd-text',
        ].join(' ')}
      >
        {todo.text}
      </span>
    </div>
  );
}

/** 待办列表区 */
function TodosBlock({ todos }: { todos: SessionStatusTodo[] }) {
  if (todos.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-rd-textSubtle">
        <Circle size={12} strokeWidth={1.5} className="shrink-0" />
        <span>待办列表</span>
      </div>
      <div className="space-y-0.5">
        {todos.map((todo, i) => (
          <TodoItem key={i} todo={todo} index={i} />
        ))}
      </div>
    </div>
  );
}

/** Token 预算条 */
function TokenBudgetBar({ used, budget }: { used: number; budget: number }) {
  if (budget <= 0) return null;
  const pct = Math.min(100, (used / budget) * 100);
  const isWarning = pct >= 90;
  const isCaution = pct >= 70 && pct < 90;
  const barColor = isWarning
    ? 'bg-rd-danger'
    : isCaution
      ? 'bg-rd-warning'
      : 'bg-rd-primary';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-rd-textSubtle">
        <span>Token 预算</span>
        <span className={isWarning ? 'text-rd-danger' : isCaution ? 'text-rd-warning' : ''}>
          {used.toLocaleString()} / {budget.toLocaleString()} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-rd-surfaceHighlight">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

// ============================================================
// 主组件
// ============================================================

export interface SessionStatusCardProps {
  /** 会话状态快照（由 ChatPage 通过 window.routedev.session.getStatus() 拉取） */
  status: SessionStatus;
}

/**
 * 会话状态卡——Voice Memo 风格的会话全局视角
 *
 * 布局：
 *   1. 标题行：Target 图标 + title + 状态徽章
 *   2. 摘要行：summary 文本
 *   3. nextAction 高亮（Alert 组件，仅 nextAction 非空时显示）
 *   4. knownFacts 标签列表（Badge 组件）
 *   5. openQuestions 列表
 *   6. todos 带勾选框的列表（CheckCircle2/MinusCircle 图标）
 *   7. token 预算条（自定义进度条，警示色 70%/90%）
 *
 * idle 状态：不渲染（ChatPage 在 status.status === 'idle' 时不挂载本卡）
 */
export const SessionStatusCard = memo(function SessionStatusCard({ status }: SessionStatusCardProps) {
  const [showDetails, setShowDetails] = useState(true);
  const hasDetails =
    status.knownFacts.length > 0 ||
    status.openQuestions.length > 0 ||
    status.todos.length > 0;

  return (
    <Card className="mx-5 my-2 p-3 shadow-sm">
      {/* 标题行 */}
      <div className="flex items-start gap-2">
        <Target size={14} strokeWidth={1.5} className="shrink-0 text-rd-primary mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-rd-text truncate">
              {status.title || '（无目标）'}
            </span>
            <StatusBadge status={status.status} />
          </div>
          <p className="text-xs text-rd-textSubtle mt-1 break-words">{status.summary}</p>
        </div>
        {hasDetails && (
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="shrink-0 text-rd-textSubtle hover:text-rd-text transition p-1 rounded"
            aria-label={showDetails ? '折叠详情' : '展开详情'}
            aria-expanded={showDetails}
          >
            {showDetails
              ? <ChevronDown size={14} strokeWidth={1.5} />
              : <ChevronRight size={14} strokeWidth={1.5} />}
          </button>
        )}
      </div>

      {/* 下一步动作高亮 */}
      {status.nextAction && (
        <Alert className="mt-2 p-2.5 border-rd-primary/20 bg-rd-primary/5">
          <div className="flex items-center gap-2">
            <ArrowRight size={14} strokeWidth={1.5} className="shrink-0 text-rd-primary" />
            <AlertTitle className="text-xs text-rd-primary">下一步</AlertTitle>
          </div>
          <AlertDescription className="text-xs text-rd-text mt-1 break-words">
            {status.nextAction}
          </AlertDescription>
        </Alert>
      )}

      {/* 详情区（可折叠） */}
      {showDetails && hasDetails && (
        <>
          <Separator className="my-2" />
          <div className="space-y-2.5">
            <KnownFactsBlock facts={status.knownFacts} />
            <OpenQuestionsBlock questions={status.openQuestions} />
            <TodosBlock todos={status.todos} />
          </div>
        </>
      )}

      {/* Token 预算条 */}
      {status.tokenBudget > 0 && (
        <>
          <Separator className="my-2" />
          <TokenBudgetBar used={status.tokenUsed} budget={status.tokenBudget} />
        </>
      )}

      {/* 更新时间 */}
      <div className="mt-2 text-[10px] text-rd-textMuted text-right">
        更新于 {new Date(status.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
      </div>
    </Card>
  );
});
