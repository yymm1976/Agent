// desktop/renderer/src/components/trace/ScorecardView.tsx
// Phase 77 Task 6：评分卡 UI——verdict 徽章 + 指标卡片网格 + 检查项列表 + 质量信号区
// 借鉴 HomeRail 的 `hr scorecard`：对一次会话轨迹生成结构化质量评估

import { useState, useEffect, useCallback } from 'react';
import { X, Check, X as XIcon, AlertTriangle, Activity } from 'lucide-react';
import type { TraceSession, Scorecard } from '../../../../shared/ipc-types.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Select, SelectItem } from '../ui/select.js';

interface ScorecardViewProps {
  open: boolean;
  onClose: () => void;
  /** 可选：预选会话 ID */
  initialSessionId?: string;
}

const VERDICT_LABEL: Record<Scorecard['verdict'], string> = {
  pass: '通过',
  advisory: '建议关注',
  fail: '不通过',
};

const VERDICT_BADGE: Record<Scorecard['verdict'], 'success' | 'primary' | 'destructive'> = {
  pass: 'success',
  advisory: 'primary',
  fail: 'destructive',
};

function formatDuration(ms: number): string {
  if (ms <= 0) return '-';
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${Math.round(sec % 60)}s`;
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function ScorecardView({ open, onClose, initialSessionId }: ScorecardViewProps) {
  const [sessions, setSessions] = useState<TraceSession[]>([]);
  const [selectedId, setSelectedId] = useState<string>(initialSessionId ?? '');
  const [card, setCard] = useState<Scorecard | null>(null);
  const [loading, setLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const list = await window.routedev.trace.listSessions(50);
      setSessions(list);
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

  // 选中会话变化时加载评分卡
  useEffect(() => {
    if (!open || !selectedId) {
      setCard(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    window.routedev.trace
      .scorecard(selectedId)
      .then((c) => {
        if (!cancelled) setCard(c);
      })
      .catch(() => {
        if (!cancelled) setCard(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedId]);

  if (!open) return null;

  // 质量信号按 severity 分组
  const signalsBySeverity = card
    ? {
        high: card.qualitySignals.filter((s) => s.severity === 'high'),
        medium: card.qualitySignals.filter((s) => s.severity === 'medium'),
        low: card.qualitySignals.filter((s) => s.severity === 'low'),
      }
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex h-[85vh] w-[92vw] max-w-[1000px] flex-col overflow-hidden rounded-2xl bg-rd-surface shadow-rdLg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-rd-border px-5">
          <h2 className="shrink-0 text-base font-semibold text-rd-text">评分卡</h2>
          <div className="min-w-0 flex-1">
            <Select
              value={selectedId}
              onChange={(e) => setSelectedId((e.target as HTMLSelectElement).value)}
            >
              {sessions.length === 0 ? (
                <SelectItem value="">暂无会话</SelectItem>
              ) : (
                sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.id} · {formatTime(s.startTime)} · {s.userInput.slice(0, 30)}
                  </SelectItem>
                ))
              )}
            </Select>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="py-12 text-center text-sm text-rd-textMuted">加载中...</div>
          ) : !card ? (
            <div className="py-12 text-center text-sm text-rd-textMuted">暂无评分卡数据</div>
          ) : (
            <div className="space-y-5">
              {/* verdict 徽章 */}
              <div className="flex items-center gap-3">
                <Badge variant={VERDICT_BADGE[card.verdict]} className="px-3 py-1 text-sm">
                  {VERDICT_LABEL[card.verdict]}
                </Badge>
                <span className="text-sm text-rd-textMuted">
                  生成于 {formatTime(new Date(card.generatedAt).getTime())}
                </span>
                {card.goalId && <Badge variant="outline">goal: {card.goalId}</Badge>}
              </div>

              {/* 指标卡片网格 */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <MetricCard label="总 Token" value={card.summary.totalTokens.toLocaleString()} />
                <MetricCard label="工具调用" value={`${card.summary.toolCallCount} 次`} />
                <MetricCard label="LLM 调用" value={`${card.summary.llmCallCount} 次`} />
                <MetricCard label="重试次数" value={`${card.summary.retryCount} 次`} />
                <MetricCard label="首次成功率" value={formatRate(card.summary.firstAttemptSuccessRate)} />
                <MetricCard label="耗时" value={formatDuration(card.summary.durationMs)} />
              </div>

              {/* 检查项列表 */}
              <Card className="p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-rd-text">
                  <Activity size={14} />
                  检查项
                </div>
                <div className="divide-y divide-rd-border">
                  {card.checks.map((c) => (
                    <div key={c.name} className="flex items-center gap-3 py-2">
                      {c.passed ? (
                        <Check size={16} className="shrink-0 text-rd-success" />
                      ) : (
                        <XIcon size={16} className="shrink-0 text-rd-danger" />
                      )}
                      <span className="flex-1 text-sm text-rd-text">{c.name}</span>
                      <span className="text-xs text-rd-textMuted">{c.detail}</span>
                    </div>
                  ))}
                </div>
              </Card>

              {/* 质量信号区 */}
              <Card className="p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-rd-text">
                  <AlertTriangle size={14} />
                  质量信号
                </div>
                {card.qualitySignals.length === 0 ? (
                  <div className="py-3 text-center text-xs text-rd-textMuted">无质量信号</div>
                ) : (
                  <div className="space-y-2">
                    {(['high', 'medium', 'low'] as const).map((sev) => {
                      const items = signalsBySeverity![sev];
                      if (items.length === 0) return null;
                      return (
                        <div key={sev}>
                          <div className="mb-1 text-xs font-semibold uppercase text-rd-textSubtle">
                            {sev === 'high' ? '高' : sev === 'medium' ? '中' : '低'}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {items.map((sig, i) => (
                              <Badge
                                key={`${sig.type}-${i}`}
                                variant={
                                  sev === 'high'
                                    ? 'destructive'
                                    : sev === 'medium'
                                      ? 'primary'
                                      : 'secondary'
                                }
                              >
                                {sig.type} × {sig.count}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-rd-textMuted">{label}</div>
      <div className="mt-1 text-lg font-semibold text-rd-text">{value}</div>
    </Card>
  );
}
