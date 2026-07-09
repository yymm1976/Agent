// desktop/renderer/src/components/trace/ReplayView.tsx
// Phase 77 Task 5：运行回放 UI——左侧会话列表 + 右侧时间线详情
// 借鉴 HomeRail 的 `hr replay`：按时间顺序回放会话事件，goal_step 作为段落分隔符

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  X, Brain, Wrench, CheckCircle2, AlertCircle, Flag, Target, ChevronRight,
} from 'lucide-react';
import type { TraceSession, TimelineEvent, Scorecard } from '../../../../shared/ipc-types.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';

interface ReplayViewProps {
  open: boolean;
  onClose: () => void;
  /** 可选：预选会话 ID */
  initialSessionId?: string;
}

const EVENT_ICON: Record<TimelineEvent['type'], typeof Brain> = {
  thinking: Brain,
  tool_call: Wrench,
  tool_result: CheckCircle2,
  llm_call: Brain,
  error: AlertCircle,
  done: Flag,
  goal_step: Target,
};

const EVENT_COLOR: Record<TimelineEvent['type'], string> = {
  thinking: 'text-rd-textMuted',
  tool_call: 'text-rd-primary',
  tool_result: 'text-rd-success',
  llm_call: 'text-rd-primary',
  error: 'text-rd-danger',
  done: 'text-rd-success',
  goal_step: 'text-rd-primary',
};

function formatTime(ts: number | string): string {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function ReplayView({ open, onClose, initialSessionId }: ReplayViewProps) {
  const [sessions, setSessions] = useState<TraceSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId ?? null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // 打开时加载会话列表
  const loadSessions = useCallback(async () => {
    try {
      const list = await window.routedev.trace.listSessions(50);
      setSessions(list);
      // 默认选中第一个（或预选）
      if (!selectedId && list.length > 0) {
        setSelectedId(initialSessionId ?? list[0].id);
      }
    } catch {
      setSessions([]);
    }
  }, [initialSessionId, selectedId]);

  useEffect(() => {
    if (open) loadSessions();
  }, [open, loadSessions]);

  // 选中会话变化时加载时间线 + 评分卡
  useEffect(() => {
    if (!open || !selectedId) {
      setEvents([]);
      setScorecard(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setExpanded(null);
    Promise.all([
      window.routedev.trace.replay(selectedId),
      window.routedev.trace.scorecard(selectedId),
    ])
      .then(([evs, card]) => {
        if (cancelled) return;
        setEvents(evs);
        setScorecard(card);
      })
      .catch(() => {
        if (cancelled) return;
        setEvents([]);
        setScorecard(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedId]);

  // 按 goal_step 切分时间线段落
  const segments = useMemo(() => {
    const result: { title: string; events: TimelineEvent[]; startIndex: number }[] = [];
    let current: { title: string; events: TimelineEvent[]; startIndex: number } | null = null;
    events.forEach((ev, idx) => {
      if (ev.type === 'goal_step') {
        if (current) result.push(current);
        current = { title: ev.summary, events: [ev], startIndex: idx };
      } else {
        if (!current) {
          current = { title: '起始', events: [], startIndex: idx };
        }
        current.events.push(ev);
      }
    });
    if (current) result.push(current);
    return result;
  }, [events]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex h-[85vh] w-[92vw] max-w-[1200px] flex-col overflow-hidden rounded-2xl bg-rd-surface shadow-rdLg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-rd-border px-5">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-rd-text">运行回放</h2>
            {selectedId && <Badge variant="primary">会话 {selectedId}</Badge>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左侧：会话列表 */}
          <div className="w-64 shrink-0 overflow-y-auto border-r border-rd-border">
            {sessions.length === 0 ? (
              <div className="p-4 text-sm text-rd-textMuted">暂无会话记录</div>
            ) : (
              sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={[
                    'flex w-full flex-col items-start gap-1 border-b border-rd-border px-4 py-3 text-left transition hover:bg-rd-surfaceHover',
                    s.id === selectedId ? 'bg-rd-primary/10' : '',
                  ].join(' ')}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="font-mono text-xs text-rd-text">{s.id}</span>
                    <Badge variant={s.completed ? 'success' : 'secondary'}>
                      {s.completed ? '完成' : '运行中'}
                    </Badge>
                  </div>
                  <span className="text-xs text-rd-textMuted">{formatTime(s.startTime)}</span>
                  <span className="truncate text-xs text-rd-textSubtle">{s.userInput}</span>
                  <span className="text-xs text-rd-textSubtle">{s.spanCount} 个 span</span>
                </button>
              ))
            )}
          </div>

          {/* 右侧：时间线详情 */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* 评分卡摘要（toolCallCount + success + verdict） */}
            {scorecard && (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-rd-surfaceHover px-4 py-2.5">
                <Badge variant={scorecard.summary.success ? 'success' : 'destructive'}>
                  {scorecard.summary.success ? '成功' : '失败'}
                </Badge>
                <Badge variant="outline">工具调用 {scorecard.summary.toolCallCount}</Badge>
                <Badge variant="outline">LLM 调用 {scorecard.summary.llmCallCount}</Badge>
                <Badge variant="outline">重试 {scorecard.summary.retryCount}</Badge>
                <Badge
                  variant={
                    scorecard.verdict === 'pass'
                      ? 'success'
                      : scorecard.verdict === 'advisory'
                        ? 'primary'
                        : 'destructive'
                  }
                >
                  评级: {scorecard.verdict}
                </Badge>
              </div>
            )}

            {loading ? (
              <div className="py-8 text-center text-sm text-rd-textMuted">加载中...</div>
            ) : events.length === 0 ? (
              <div className="py-8 text-center text-sm text-rd-textMuted">暂无时间线事件</div>
            ) : (
              <div className="space-y-4">
                {segments.map((seg, si) => (
                  <div key={si} className="rounded-lg border border-rd-border">
                    <div className="flex items-center gap-2 border-b border-rd-border bg-rd-surfaceHover px-3 py-1.5">
                      <Target size={14} className="text-rd-primary" />
                      <span className="text-xs font-semibold text-rd-text">{seg.title}</span>
                    </div>
                    <div className="divide-y divide-rd-border">
                      {seg.events.map((ev) => {
                        const globalIdx = seg.startIndex + seg.events.indexOf(ev);
                        const Icon = EVENT_ICON[ev.type] ?? ChevronRight;
                        const isExpanded = expanded === globalIdx;
                        return (
                          <div key={globalIdx}>
                            <button
                              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-rd-surfaceHover"
                              onClick={() => setExpanded(isExpanded ? null : globalIdx)}
                            >
                              <span className="shrink-0 pt-0.5 font-mono text-xs text-rd-textSubtle">
                                {formatClock(ev.timestamp)}
                              </span>
                              <Icon size={14} className={`mt-0.5 shrink-0 ${EVENT_COLOR[ev.type]}`} />
                              <span className="flex-1 text-xs text-rd-text">{ev.summary}</span>
                              <ChevronRight
                                size={12}
                                className={`mt-1 shrink-0 text-rd-textSubtle transition ${
                                  isExpanded ? 'rotate-90' : ''
                                }`}
                              />
                            </button>
                            {isExpanded && ev.detail !== undefined && (
                              <pre className="mx-3 mb-2 max-h-48 overflow-auto rounded bg-rd-background p-2 text-xs text-rd-textMuted">
                                {JSON.stringify(ev.detail, null, 2)}
                              </pre>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
