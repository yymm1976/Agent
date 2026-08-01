// desktop/renderer/src/components/agent/SubagentPanel.tsx
// Phase 97 Part E：子会话面板（列表 / 详情 / 停止）
//
// 数据流（唯一权威源）：
//   主进程 AgentBridge → IPC agent:list-subagents / agent:get-subagent / agent:stop-subagent
//   → window.routedev.agent.* → 本组件
// 渲染层不做二次推导，仅轮询快照 + 本地时钟显示耗时（与 AgentIsland 同模式，fail-open）。
//
// 行为：
//   - 固定右下角常驻折叠面板，仅在有子会话时渲染（避免视觉噪音）
//   - 2s 轮询列表；标题栏提供手动刷新
//   - 点击列表项拉取详情（描述 / 类型 / 结果 / 错误 / token 用量）
//   - running 状态显示「停止」按钮（agent:stop-subagent）
//   - 组件卸载清理轮询

import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  StopCircle,
  Timer,
  XCircle,
} from 'lucide-react';
import type { SubagentView } from '../../../../main/bridges/agent-bridge.js';

// ============================================================
// 常量
// ============================================================

/** 轮询间隔（ms）：子会话状态变化频率低，2s 足够（与 AgentIsland 一致） */
const POLL_INTERVAL_MS = 2000;
/** 详情内容截断长度 */
const RESULT_PREVIEW_MAX = 400;

/** 状态徽标样式（与主进程 SubagentView.status 枚举一一对应） */
const STATUS_STYLE: Record<SubagentView['status'], { color: string; bg: string; label: string }> = {
  running: { color: 'var(--rd-primary, #7c6cf0)', bg: 'rgba(124,108,240,0.10)', label: '运行中' },
  completed: { color: 'var(--rd-success, #34a853)', bg: 'rgba(52,168,83,0.10)', label: '已完成' },
  failed: { color: 'var(--rd-danger, #e5484d)', bg: 'rgba(229,72,77,0.10)', label: '失败' },
  aborted: { color: 'var(--rd-warning, #e8a13c)', bg: 'rgba(232,161,60,0.14)', label: '已中止' },
};

/** 状态图标（与 AgentIsland 一致：spinner / alert / check / x） */
function StatusIcon({ status }: { status: SubagentView['status'] }) {
  if (status === 'running') return <Loader2 size={12} className="animate-spin" />;
  if (status === 'completed') return <CheckCircle2 size={12} />;
  if (status === 'failed') return <XCircle size={12} />;
  return <AlertCircle size={12} />;
}

/** childSessionId 短显：sub-<ts>-<rand> → …<rand 尾 8 位> */
function shortId(id: string): string {
  return id.length > 14 ? `…${id.slice(-8)}` : id;
}

/** 格式化绝对时间（MM-DD HH:mm） */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 格式化耗时（mm:ss，参照 AgentIsland） */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * SubagentPanel：固定右下角子会话折叠面板
 *
 * 无子会话时不渲染（与 AgentIsland 空态一致）；有子会话时渲染标题栏 + 列表，
 * 点击条目拉取详情，running 条目可一键停止。
 */
export function SubagentPanel() {
  const [items, setItems] = useState<SubagentView[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SubagentView | null>(null);
  const [now, setNow] = useState(Date.now());
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = async () => {
    try {
      const api = window.routedev?.agent;
      if (!api?.listSubagents) return;
      const list = await api.listSubagents();
      setItems(list);
    } catch {
      // fail-open：主进程未就绪或引擎未启动时保持上一帧列表
    }
  };

  // 轮询列表快照（与 AgentIsland 同模式）
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const api = window.routedev?.agent;
        if (!api?.listSubagents) return;
        const list = await api.listSubagents();
        if (!cancelled) setItems(list);
      } catch {
        // fail-open
      }
    };
    void tick();
    pollTimerRef.current = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // 秒级本地时钟：刷新运行中耗时显示
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 点击条目：拉取详情（仅展开态；折叠时先展开）
  const handleToggleItem = async (id: string) => {
    if (detailId === id) {
      setDetailId(null);
      setDetail(null);
      return;
    }
    setDetailId(id);
    setDetail(null);
    try {
      const api = window.routedev?.agent;
      if (!api?.getSubagent) return;
      const record = await api.getSubagent(id);
      setDetail(record);
    } catch {
      // fail-open：详情保持 null（条目上仍显示列表快照信息）
    }
  };

  // 停止子会话：成功后立即刷新列表
  const handleStop = async (id: string) => {
    if (stoppingId) return;
    setStoppingId(id);
    try {
      const api = window.routedev?.agent;
      if (api?.stopSubagent) {
        await api.stopSubagent(id);
      }
      await refresh();
      if (detailId === id) {
        setDetail(null);
        const api2 = window.routedev?.agent;
        const record = api2?.getSubagent ? await api2.getSubagent(id) : null;
        setDetail(record);
      }
    } catch {
      // fail-open：停止失败时保持原状，轮询会继续纠正状态
    } finally {
      setStoppingId(null);
    }
  };

  // 无子会话：不渲染（避免视觉噪音，与 AgentIsland 空态一致）
  if (items.length === 0) {
    return null;
  }

  const runningCount = items.filter((i) => i.status === 'running').length;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 8,
        right: 8,
        zIndex: 9999,
        width: 300,
        maxHeight: 'min(420px, 60vh)',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        background: 'var(--rd-surface, #ffffff)',
        border: '1px solid var(--rd-border, rgba(0,0,0,0.08))',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        overflow: 'hidden',
      }}
    >
      {/* 标题栏：折叠 / 展开 + 子会话计数 + 手动刷新 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px',
          borderBottom: expanded ? '1px solid var(--rd-border, rgba(0,0,0,0.08))' : 'none',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--rd-text, #333)' }}>子会话</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 999,
            background: 'var(--rd-primary, #7c6cf0)',
            color: '#fff',
            fontSize: 10,
            lineHeight: 1,
          }}
        >
          {items.length}
        </span>
        {runningCount > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--rd-primary, #7c6cf0)', marginLeft: 2 }}>
            <Loader2 size={10} className="animate-spin" />
            {runningCount} 运行中
          </span>
        )}
        <button
          title="刷新"
          onClick={(e) => {
            e.stopPropagation();
            void refresh();
          }}
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            color: 'var(--rd-textMuted, #888)',
            cursor: 'pointer',
          }}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* 列表（仅展开态） */}
      {expanded && (
        <div style={{ overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map((item) => {
            const style = STATUS_STYLE[item.status];
            const isActive = item.status === 'running';
            const isOpen = detailId === item.childSessionId;
            const durationMs = item.completedAt
              ? item.completedAt - item.createdAt
              : now - item.createdAt;
            return (
              <div
                key={item.childSessionId}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '6px 8px',
                  borderRadius: 8,
                  background: isOpen ? 'var(--rd-surface-highlight, rgba(0,0,0,0.04))' : 'transparent',
                  border: '1px solid var(--rd-border, rgba(0,0,0,0.08))',
                }}
              >
                {/* 条目头：短 ID + 状态徽标 + 时间 + 停止 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    onClick={() => void handleToggleItem(item.childSessionId)}
                    title={item.childSessionId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flex: 1,
                      minWidth: 0,
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ color: style.color, display: 'flex' }}>
                      <StatusIcon status={item.status} />
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: 'var(--rd-text, #333)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {shortId(item.childSessionId)}
                    </span>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '1px 6px',
                        borderRadius: 999,
                        fontSize: 10,
                        color: style.color,
                        background: style.bg,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {style.label}
                    </span>
                  </button>
                  {isActive && (
                    <button
                      title="停止子会话"
                      disabled={stoppingId === item.childSessionId}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleStop(item.childSessionId);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 3,
                        padding: '2px 6px',
                        borderRadius: 6,
                        border: '1px solid var(--rd-danger, #e5484d)',
                        background: 'transparent',
                        color: 'var(--rd-danger, #e5484d)',
                        fontSize: 10,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {stoppingId === item.childSessionId ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <StopCircle size={10} />
                      )}
                      停止
                    </button>
                  )}
                </div>

                {/* 条目副行：创建时间 + 运行耗时 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--rd-textMuted, #888)' }}>
                  <span>{formatTime(item.createdAt)} 创建</span>
                  {isActive && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Timer size={10} />
                      {formatDuration(durationMs)}
                    </span>
                  )}
                </div>

                {/* 展开详情 */}
                {isOpen && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4, borderTop: '1px solid var(--rd-border, rgba(0,0,0,0.08))', fontSize: 11, color: 'var(--rd-text, #333)' }}>
                    {item.description && (
                      <div style={{ opacity: 0.9 }}>
                        <span style={{ opacity: 0.6 }}>描述：</span>
                        {item.description}
                      </div>
                    )}
                    <div style={{ opacity: 0.9 }}>
                      <span style={{ opacity: 0.6 }}>类型：</span>
                      {item.subagentType || '—'}
                    </div>
                    {item.completedAt != null && (
                      <div style={{ opacity: 0.9 }}>
                        <span style={{ opacity: 0.6 }}>完成于：</span>
                        {formatTime(item.completedAt)}
                      </div>
                    )}
                    {item.tokenUsage && (
                      <div style={{ opacity: 0.9 }}>
                        <span style={{ opacity: 0.6 }}>Token：</span>
                        {item.tokenUsage.inputTokens ?? 0} in / {item.tokenUsage.outputTokens ?? 0} out
                      </div>
                    )}
                    {((detail ?? item).result != null) && (
                      <div style={{ opacity: 0.9, wordBreak: 'break-word' }}>
                        <span style={{ opacity: 0.6 }}>结果：</span>
                        {(detail ?? item).result!.length > RESULT_PREVIEW_MAX
                          ? `${(detail ?? item).result!.slice(0, RESULT_PREVIEW_MAX)}…`
                          : (detail ?? item).result}
                      </div>
                    )}
                    {((detail ?? item).error != null) && (
                      <div style={{ opacity: 0.9, color: 'var(--rd-danger, #e5484d)', wordBreak: 'break-word' }}>
                        <span style={{ opacity: 0.7 }}>错误：</span>
                        {(detail ?? item).error!.length > RESULT_PREVIEW_MAX
                          ? `${(detail ?? item).error!.slice(0, RESULT_PREVIEW_MAX)}…`
                          : (detail ?? item).error}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
