// desktop/renderer/src/components/goal/RecoveryPrompt.tsx
// Phase 77 借鉴点 7：冷启动恢复提示条
//
// 设计：
//   - 应用启动时若有可恢复 goal，在主界面顶部显示提示条
//   - 每个可恢复 goal 显示：标题 + 进度（completed/total 步）+ token 使用 + "恢复"/"放弃"按钮
//   - 用户点"恢复"→ 调 window.routedev.goal.resume(goalId) → 触发 goal 执行
//   - 用户点"放弃"→ 调 window.routedev.goal.discard(goalId) → 提示条消失
//   - 用项目内 shadcn/ui 风格组件（Alert/Button/Card），无 antd 依赖
//
// 数据流：
//   启动时：app-init.ts detectResumableGoalsOnStartup → deps.resumableGoals
//           （此字段仅作日志输出，UI 实际查询走 IPC goal:list-resumable）
//   运行时：本组件 mount 时调 window.routedev.goal.listResumable()
//           用户操作后重新调用 listResumable 刷新列表

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, RefreshCw, Trash2, Loader2, X } from 'lucide-react';
import type { ResumableGoalIpcInfo } from '../../../../shared/ipc-types.js';
import { Button } from '../ui/button.js';

/** 格式化更新时间：超过 24 小时显示"陈旧"标签 */
function formatUpdatedAt(updatedAt: number): string {
  const diffMs = Date.now() - updatedAt;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}

/** 格式化 token 使用率 */
function formatTokenUsage(used: number, budget: number): string {
  if (budget <= 0) return `${used.toLocaleString()} tokens`;
  const pct = ((used / budget) * 100).toFixed(0);
  return `${used.toLocaleString()}/${budget.toLocaleString()} (${pct}%)`;
}

interface RecoveryPromptProps {
  /** 用户点击"恢复"后的回调（可选，用于父组件切换 UI 状态） */
  onResume?: (goalId: string) => void;
  /** 用户点击"放弃"后的回调（可选） */
  onDiscard?: (goalId: string) => void;
  /** 提示条关闭回调（用户点击右上角 X） */
  onClose?: () => void;
}

/**
 * 冷启动恢复提示条
 *
 * 行为：
 *   - mount 时调用 window.routedev.goal.listResumable() 拉取可恢复 goal
 *   - 列表为空时返回 null（不渲染）
 *   - 用户点"恢复"→ 调用 IPC goal:resume → 等待返回 → 通知父组件 onResume
 *   - 用户点"放弃"→ 调用 IPC goal:discard → 从列表中移除该条目
 *   - 用户点右上角 X → 通知父组件 onClose（隐藏提示条，不放弃 goal）
 */
export function RecoveryPrompt({ onResume, onDiscard, onClose }: RecoveryPromptProps) {
  const [goals, setGoals] = useState<ResumableGoalIpcInfo[]>([]);
  const [loading, setLoading] = useState<Record<string, 'resuming' | 'discarding' | undefined>>({});
  const [error, setError] = useState<string | null>(null);

  // 拉取可恢复 goal 列表
  const refresh = useCallback(async () => {
    try {
      const list = await window.routedev.goal.listResumable();
      setGoals(list);
      setError(null);
    } catch (err) {
      // fail-open：拉取失败不阻塞 UI，显示空列表
      setError(err instanceof Error ? err.message : String(err));
      setGoals([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleResume = useCallback(async (goalId: string) => {
    setLoading(prev => ({ ...prev, [goalId]: 'resuming' }));
    try {
      const result = await window.routedev.goal.resume(goalId);
      if (result.success) {
        // 从列表中移除该 goal（已开始执行）
        setGoals(prev => prev.filter(g => g.id !== goalId));
        onResume?.(goalId);
      } else {
        setError(result.error ?? '恢复失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(prev => {
        const next = { ...prev };
        delete next[goalId];
        return next;
      });
    }
  }, [onResume]);

  const handleDiscard = useCallback(async (goalId: string) => {
    setLoading(prev => ({ ...prev, [goalId]: 'discarding' }));
    try {
      const result = await window.routedev.goal.discard(goalId);
      if (result.success) {
        setGoals(prev => prev.filter(g => g.id !== goalId));
        onDiscard?.(goalId);
      } else {
        setError(result.error ?? '放弃失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(prev => {
        const next = { ...prev };
        delete next[goalId];
        return next;
      });
    }
  }, [onDiscard]);

  // 无可恢复 goal 时不渲染
  if (goals.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-rd-border bg-rd-surfaceHighlight/40 px-5 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-rd-text">
          <AlertTriangle size={14} className="text-rd-warning" />
          <span>检测到未完成的目标</span>
          <span className="rounded-full bg-rd-warning/10 px-1.5 text-[10px] font-semibold text-rd-warning">
            {goals.length}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="关闭提示"
            className="flex h-6 w-6 items-center justify-center rounded text-rd-textSubtle hover:bg-rd-surfaceHover hover:text-rd-text"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {error && (
        <div className="mb-2 rounded border border-rd-danger/30 bg-rd-danger/10 px-2 py-1 text-xs text-rd-danger">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {goals.map(goal => {
          const isLoading = loading[goal.id];
          const title = goal.spec?.goal ?? '(未命名目标)';
          return (
            <div
              key={goal.id}
              className="flex items-center gap-3 rounded-lg border border-rd-border bg-rd-surface px-3 py-2"
            >
              {/* 标题 + 进度信息 */}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-rd-text" title={title}>
                  {title}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-rd-textSubtle">
                  <span>进度 {goal.completedSteps}/{goal.totalSteps} 步</span>
                  <span>·</span>
                  <span>{formatTokenUsage(goal.tokenUsed, goal.tokenBudget)}</span>
                  <span>·</span>
                  <span>{formatUpdatedAt(goal.updatedAt)}</span>
                  {goal.isStale && (
                    <span className="rounded bg-rd-warning/10 px-1 text-[10px] font-semibold text-rd-warning">
                      陈旧
                    </span>
                  )}
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => handleResume(goal.id)}
                  disabled={isLoading !== undefined}
                  className="gap-1.5"
                >
                  {isLoading === 'resuming' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  恢复
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDiscard(goal.id)}
                  disabled={isLoading !== undefined}
                  className="gap-1.5"
                >
                  {isLoading === 'discarding' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  放弃
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
