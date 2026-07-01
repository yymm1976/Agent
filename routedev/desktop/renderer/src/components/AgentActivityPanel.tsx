// desktop/renderer/src/components/AgentActivityPanel.tsx
// Phase 51 Task 5：Agent 活动面板——specialist 活动实时追踪
//
// 借鉴 ohmypi TUI Activity Widget 的字段设计：
//   - title: `${lineage} · d${depth}`
//   - detail: 任务预览（截断 72 字符）
//   - meta: tools 调用数 + last 工具名 + 模型标签
//   - status: running/success/error
//
// 通过 useEffect+useState 订阅 AgentActivityStore，
// 事件推送（非轮询）。显示 active[] 和 recent[] 两个列表。

import { useEffect, useState } from 'react';
import { Activity, Bot, Wrench, ChevronRight } from 'lucide-react';
import type { AgentActivityRecord, AgentActivityStore } from '../../../../src/agents/activity-store.js';
import ModelLabel from './ModelLabel.js';

interface AgentActivityPanelProps {
  /** 活动存储实例 */
  store: AgentActivityStore;
}

/** 状态图标与颜色配置 */
function getStatusDisplay(status: AgentActivityRecord['status']): {
  icon: string;
  colorClass: string;
  label: string;
} {
  switch (status) {
    case 'running':
      return { icon: '●', colorClass: 'text-rd-primary', label: '运行中' };
    case 'success':
      return { icon: '✓', colorClass: 'text-rd-success', label: '完成' };
    case 'error':
      return { icon: '✕', colorClass: 'text-rd-danger', label: '失败' };
  }
}

/** 角色 badge 配色 */
function getRoleBadgeClass(role: string): string {
  switch (role) {
    case 'researcher':
      return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    case 'executor':
      return 'bg-green-500/15 text-green-400 border-green-500/30';
    case 'reviewer':
      return 'bg-purple-500/15 text-purple-400 border-purple-500/30';
    default:
      return 'bg-rd-surfaceHighlight text-rd-textMuted border-rd-border';
  }
}

/** 计算耗时 */
function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 单条活动记录 */
function ActivityItem({ record }: { record: AgentActivityRecord }) {
  const statusDisp = getStatusDisplay(record.status);
  const durationMs = record.finishedAt
    ? record.finishedAt - record.startedAt
    : Date.now() - record.startedAt;

  return (
    <div className="rounded-lg border border-rd-border bg-rd-surface p-2 transition hover:border-rd-borderHover">
      {/* 上行：状态图标 + lineage + role badge */}
      <div className="flex items-center gap-1.5">
        <span className={`shrink-0 text-xs ${statusDisp.colorClass}`} title={statusDisp.label}>
          {statusDisp.icon}
        </span>
        <span className="truncate font-mono text-xs text-rd-text">
          {record.lineage}
          <span className="text-rd-textSubtle"> · d{record.depth}</span>
        </span>
        <span
          className={`ml-auto inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium leading-tight ${getRoleBadgeClass(record.role)}`}
        >
          {record.role}
        </span>
      </div>

      {/* 中行：任务预览 */}
      <div className="mt-1 truncate text-xs text-rd-textMuted" title={record.taskPreview}>
        {record.taskPreview || '（无任务描述）'}
      </div>

      {/* 底行：工具调用数 + 最近工具名 + 模型标签 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-rd-textSubtle">
        <span className="inline-flex items-center gap-0.5" title="工具调用次数">
          <Wrench size={10} />
          <span>{record.toolCallCount}</span>
        </span>
        {record.lastToolName && (
          <span className="inline-flex items-center gap-0.5" title={record.lastToolDescription ?? record.lastToolName}>
            <ChevronRight size={10} />
            <span className="max-w-[80px] truncate">{record.lastToolName}</span>
          </span>
        )}
        {record.modelId && (
          <span className="ml-auto">
            <ModelLabel modelString={record.modelId} />
          </span>
        )}
        {record.finishedAt && (
          <span className="text-rd-textSubtle">{formatDuration(durationMs)}</span>
        )}
      </div>

      {/* 错误信息 */}
      {record.status === 'error' && record.error && (
        <div className="mt-1 rounded bg-rd-danger/10 px-1.5 py-0.5 text-[11px] text-rd-danger" title={record.error}>
          <span className="line-clamp-2">{record.error}</span>
        </div>
      )}
    </div>
  );
}

export default function AgentActivityPanel({ store }: AgentActivityPanelProps) {
  const [active, setActive] = useState<AgentActivityRecord[]>(() => store.getActive());
  const [recent, setRecent] = useState<AgentActivityRecord[]>(() => store.getRecent());

  // 订阅 store：事件推送（非轮询）
  useEffect(() => {
    // 先同步一次，避免错过订阅前已发生的更新
    setActive(store.getActive());
    setRecent(store.getRecent());

    const unsubscribe = store.subscribe((nextActive, nextRecent) => {
      setActive(nextActive);
      setRecent(nextRecent);
    });
    return unsubscribe;
  }, [store]);

  const hasAny = active.length > 0 || recent.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* header：标题 + 活跃/历史计数 */}
      <div className="flex shrink-0 items-center gap-1.5 px-1 pb-2 text-xs font-semibold text-rd-text">
        <Activity size={13} className="text-rd-primary" />
        <span>Agent 活动</span>
        <span className="ml-auto flex items-center gap-1.5 font-normal text-rd-textSubtle">
          <span title="活跃数">
            <span className="text-rd-primary">{active.length}</span>
            <span className="ml-0.5">活跃</span>
          </span>
          <span className="text-rd-border">·</span>
          <span title="历史数">
            <span className="text-rd-textMuted">{recent.length}</span>
            <span className="ml-0.5">历史</span>
          </span>
        </span>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto pr-1">
        {!hasAny && (
          <div className="flex flex-col items-center justify-center py-8 text-center text-xs text-rd-textSubtle">
            <Bot size={24} className="mb-1.5 opacity-50" />
            <span>暂无 Agent 活动</span>
            <span className="mt-0.5 text-[11px]">子 Agent 启动后将在此实时显示</span>
          </div>
        )}

        {/* active 列表 */}
        {active.length > 0 && (
          <div className="mb-2">
            <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-rd-textSubtle">
              进行中 · {active.length}
            </div>
            <div className="space-y-1.5">
              {active.map((record) => (
                <ActivityItem key={record.id} record={record} />
              ))}
            </div>
          </div>
        )}

        {/* recent 列表 */}
        {recent.length > 0 && (
          <div>
            <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-rd-textSubtle">
              最近完成 · {recent.length}
            </div>
            <div className="space-y-1.5">
              {recent.map((record) => (
                <ActivityItem key={record.id} record={record} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
