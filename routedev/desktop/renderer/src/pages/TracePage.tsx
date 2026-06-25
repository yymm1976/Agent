// desktop/renderer/src/pages/TracePage.tsx
// Trace 可视化页面：柱状图展示 span 耗时 + 过滤器 + 展开详情

import { useState, useMemo } from 'react';
import { Activity, ChevronDown, ChevronRight, Search } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import type { TraceSpan, TraceSpanType } from '../../../../src/harness/trace-types.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Badge } from '../components/ui/badge.js';
import { Input } from '../components/ui/input.js';
import { Separator } from '../components/ui/separator.js';

interface TracePageProps {
  traceEvents: TraceSpan[];
}

const ALL_TYPES: TraceSpanType[] = [
  'react_iteration',
  'tool_call',
  'llm_call',
  'worker_task',
  'goal_step',
  'compose_phase',
  'hook',
];

const TYPE_COLORS: Record<TraceSpanType, string> = {
  react_iteration: '#4f46e5',
  tool_call: '#f59e0b',
  llm_call: '#16a34a',
  worker_task: '#dc2626',
  goal_step: '#475569',
  compose_phase: '#a78bfa',
  hook: '#6b7280',
};

const TYPE_DOT_CLASS: Record<TraceSpanType, string> = {
  react_iteration: 'bg-rd-primary',
  tool_call: 'bg-rd-warning',
  llm_call: 'bg-rd-success',
  worker_task: 'bg-rd-danger',
  goal_step: 'bg-rd-textMuted',
  compose_phase: 'bg-purple-400',
  hook: 'bg-gray-500',
};

const TYPE_LABELS: Record<TraceSpanType, string> = {
  react_iteration: 'ReAct 迭代',
  tool_call: '工具调用',
  llm_call: 'LLM 调用',
  worker_task: 'Worker 任务',
  goal_step: 'Goal 步骤',
  compose_phase: 'Compose 阶段',
  hook: 'Hook 钩子',
};

const STATUS_LABELS: Record<TraceSpan['status'], string> = {
  running: '运行中',
  completed: '已完成',
  error: '错误',
  aborted: '已中止',
};

const TOOLTIP_STYLE = {
  backgroundColor: '#0f172a',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  color: '#f8fafc',
  fontSize: '12px',
};

function statusBadge(status: TraceSpan['status']) {
  switch (status) {
    case 'completed':
      return <Badge variant="success">{STATUS_LABELS[status]}</Badge>;
    case 'error':
    case 'aborted':
      return <Badge variant="destructive">{STATUS_LABELS[status]}</Badge>;
    default:
      return (
        <Badge className="border-rd-warning/20 bg-rd-warning/10 text-rd-warning">
          {STATUS_LABELS[status]}
        </Badge>
      );
  }
}

function formatPayloadSummary(payload: TraceSpan['payload']): string {
  if (!payload) return '';
  switch (payload.type) {
    case 'tool_call':
      return payload.result
        ? `${payload.toolName} → ${payload.result.slice(0, 80)}`
        : payload.toolName;
    case 'llm_call':
      return `${payload.modelId} (${payload.inputTokens}/${payload.outputTokens} tokens)`;
    case 'react_iteration':
      if (payload.thought) return payload.thought.slice(0, 100);
      if (payload.action)
        return `${payload.action.toolName}(${Object.keys(payload.action.args).join(', ')})`;
      return `迭代 #${payload.iteration}`;
    case 'worker_task':
      return `${payload.role}: ${payload.description.slice(0, 80)}`;
    case 'goal_step':
      return `步骤 ${payload.stepId}/${payload.totalSteps}: ${payload.description.slice(0, 80)}`;
    case 'compose_phase':
      return `${payload.phase} - ${payload.name}`;
    case 'hook':
      return `${payload.event}: ${payload.hookName}`;
    default:
      return JSON.stringify(payload).slice(0, 120);
  }
}

export function TracePage({ traceEvents }: TracePageProps) {
  const [selectedTypes, setSelectedTypes] = useState<Set<TraceSpanType>>(new Set(ALL_TYPES));
  const [statusFilter, setStatusFilter] = useState<TraceSpan['status'] | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const filteredSpans = useMemo(() => {
    return traceEvents.filter((span) => {
      if (!selectedTypes.has(span.type)) return false;
      if (statusFilter !== 'all' && span.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const summary = formatPayloadSummary(span.payload).toLowerCase();
        const typeLabel = TYPE_LABELS[span.type].toLowerCase();
        if (!summary.includes(q) && !typeLabel.includes(q) && !span.type.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [traceEvents, selectedTypes, statusFilter, searchQuery]);

  const chartData = useMemo(() => {
    return filteredSpans.map((span, idx) => ({
      index: idx + 1,
      duration: span.durationMs ?? 0,
      type: span.type,
      typeLabel: TYPE_LABELS[span.type],
      color: TYPE_COLORS[span.type],
    }));
  }, [filteredSpans]);

  const toggleType = (type: TraceSpanType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  if (traceEvents.length === 0) {
    return (
      <Card className="flex h-full flex-col items-center justify-center text-rd-textMuted">
        <Activity size={48} className="mb-4 text-rd-primary/50" />
        <p className="text-lg font-medium text-rd-text">暂无 Trace 数据</p>
        <p className="mt-1 text-sm">执行 Agent 任务后，这里会展示完整的执行轨迹</p>
      </Card>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      {/* 过滤器栏 */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* 类型过滤：Badge 切换 */}
          <div className="flex flex-wrap items-center gap-2">
            {ALL_TYPES.map((type) => {
              const selected = selectedTypes.has(type);
              return (
                <Badge
                  key={type}
                  variant={selected ? 'primary' : 'default'}
                  className="cursor-pointer gap-1.5"
                  onClick={() => toggleType(type)}
                >
                  <span className={`h-2 w-2 rounded-sm ${TYPE_DOT_CLASS[type]}`} />
                  {TYPE_LABELS[type]}
                </Badge>
              );
            })}
          </div>

          <Separator orientation="vertical" className="hidden h-6 md:block" />

          {/* 状态过滤：原生 Select */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as TraceSpan['status'] | 'all')}
            className="h-10 rounded-md border border-rd-input bg-rd-background px-3 py-2 text-sm text-rd-text shadow-sm focus-visible:border-rd-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rd-primary/40"
          >
            <option value="all">全部状态</option>
            <option value="running">运行中</option>
            <option value="completed">已完成</option>
            <option value="error">错误</option>
            <option value="aborted">已中止</option>
          </select>

          {/* 搜索框 */}
          <div className="relative min-w-[200px] flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-rd-textMuted" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索 span 内容..."
              className="pl-9 text-sm"
            />
          </div>

          <span className="text-xs text-rd-textMuted">
            {filteredSpans.length}/{traceEvents.length} 个 Span
          </span>
        </div>
      </Card>

      {/* 柱状图：各 span 耗时分布 */}
      <Card className="shrink-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Span 耗时分布</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <XAxis dataKey="index" stroke="#94a3b8" fontSize={11} />
                <YAxis stroke="#94a3b8" fontSize={11} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: '#e2e8f0', opacity: 0.5 }}
                  formatter={(value, _name, item) => {
                    const payload = item?.payload as { typeLabel: string } | undefined;
                    return [`${value} ms`, payload?.typeLabel ?? '耗时'];
                  }}
                  labelFormatter={(label) => `Span #${label}`}
                />
                <Bar dataKey="duration" radius={[3, 3, 0, 0]}>
                  {chartData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* 时间线列表（点击展开详情） */}
      <Card className="flex flex-1 flex-col overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">执行轨迹</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-auto">
          <div className="space-y-3">
            {filteredSpans.length === 0 ? (
              <div className="py-8 text-center text-sm text-rd-textMuted">没有匹配的 Span</div>
            ) : (
              filteredSpans.map((span) => {
                const isExpanded = expandedId === span.id;
                return (
                  <Card key={span.id} className="overflow-hidden">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpandedId(isExpanded ? null : span.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setExpandedId(isExpanded ? null : span.id);
                        }
                      }}
                      className="flex w-full cursor-pointer items-center justify-between p-3 text-left transition-colors hover:bg-rd-surfaceHover"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {isExpanded ? (
                          <ChevronDown size={14} className="shrink-0 text-rd-textMuted" />
                        ) : (
                          <ChevronRight size={14} className="shrink-0 text-rd-textMuted" />
                        )}
                        <Badge
                          variant="default"
                          className="shrink-0 gap-1.5 border-rd-border bg-rd-surface"
                        >
                          <span className={`h-2 w-2 rounded-sm ${TYPE_DOT_CLASS[span.type]}`} />
                          {TYPE_LABELS[span.type]}
                        </Badge>
                        <span className="truncate text-xs text-rd-textMuted">
                          {formatPayloadSummary(span.payload)}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        {statusBadge(span.status)}
                        <span className="text-xs text-rd-textMuted">
                          {span.durationMs != null ? `${span.durationMs}ms` : 'running'}
                        </span>
                      </div>
                    </div>

                    {isExpanded && (
                      <>
                        <Separator />
                        <div className="space-y-3 bg-rd-surface/50 p-3 text-xs">
                          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                            <div>
                              <div className="text-rd-textMuted">开始时间</div>
                              <div className="text-rd-text">{new Date(span.startTime).toLocaleString()}</div>
                            </div>
                            <div>
                              <div className="text-rd-textMuted">结束时间</div>
                              <div className="text-rd-text">
                                {span.endTime ? new Date(span.endTime).toLocaleString() : '-'}
                              </div>
                            </div>
                            <div>
                              <div className="text-rd-textMuted">耗时</div>
                              <div className="text-rd-text">
                                {span.durationMs != null ? `${span.durationMs} ms` : '-'}
                              </div>
                            </div>
                            <div>
                              <div className="text-rd-textMuted">状态</div>
                              <div className="text-rd-text">{STATUS_LABELS[span.status]}</div>
                            </div>
                          </div>

                          {span.error && (
                            <div className="rounded border border-rd-danger/30 bg-rd-danger/10 p-2">
                              <div className="mb-1 font-medium text-rd-danger">错误信息</div>
                              <div className="text-rd-text">{span.error}</div>
                            </div>
                          )}

                          <div>
                            <div className="mb-1 text-rd-textMuted">Payload</div>
                            <pre className="max-h-60 overflow-auto rounded bg-rd-surface p-3 font-mono text-xs text-rd-text">
                              {JSON.stringify(span.payload, null, 2)}
                            </pre>
                          </div>
                        </div>
                      </>
                    )}
                  </Card>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
