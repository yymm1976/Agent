// desktop/renderer/src/components/agent/AgentIsland.tsx
// Phase 97 Part H：常驻 Agent Island 状态条
//
// 借鉴 Proma Agent Island：常驻顶部，集中显示 Agent 运行状态，
// 等待交互时高亮并可直接处理；页面切换不丢状态。
//
// 数据流（唯一权威源）：
//   主进程 agent-status-service → IPC agent:get-status → 本组件
//   渲染层不做二次推导（Step 3），仅轮询快照 + 本地时钟显示时长。

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Timer, XCircle } from 'lucide-react';
import type { AgentStatusRecord, AgentStatusSnapshot } from '../../../../main/agent-status-service.js';

// ============================================================
// 常量
// ============================================================

/** 轮询间隔（ms）：状态变化频率低，2s 足够；本地时钟负责秒级时长刷新 */
const POLL_INTERVAL_MS = 2000;
/** 时长刷新间隔（ms）：秒级刷新 spinner 旁耗时 */
const TICK_INTERVAL_MS = 1000;

/** 单条状态文本颜色（与主进程状态枚举一一对应） */
const STATUS_STYLE: Record<AgentStatusRecord['status'], { color: string; bg: string; label: string }> = {
  queued: { color: 'var(--rd-muted, #8b8fa3)', bg: 'rgba(139,143,163,0.10)', label: '排队中' },
  running: { color: 'var(--rd-primary, #7c6cf0)', bg: 'rgba(124,108,240,0.10)', label: '运行中' },
  waiting_interruption: { color: 'var(--rd-warning, #e8a13c)', bg: 'rgba(232,161,60,0.14)', label: '等待处理' },
  completed: { color: 'var(--rd-success, #34a853)', bg: 'rgba(52,168,83,0.10)', label: '已完成' },
  error: { color: 'var(--rd-danger, #e5484d)', bg: 'rgba(229,72,77,0.10)', label: '出错' },
};

/** 格式化耗时（mm:ss 或 h:mm:ss） */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * AgentIsland：常驻顶部状态条
 *
 * 行为：
 *   - 轮询主进程 agent:get-status 快照（Step 3：数据全部来自 agent-status-service）
 *   - 运行中显示 spinner + 时长；等待中断高亮并显示中断计数
 *   - 点击任意状态条：dispatch 全局事件让 ChatPage 聚焦输入框（Step 2：进入对应会话交互）
 *   - 组件卸载清理轮询，页面切换不丢状态（状态在 main 进程，天然跨页面）
 */
export function AgentIsland() {
  const [snapshot, setSnapshot] = useState<AgentStatusSnapshot | null>(null);
  const [now, setNow] = useState(Date.now());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 轮询主进程状态快照（fail-open：引擎未就绪时保持空态）
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const api = window.routedev?.agent;
        if (!api?.getStatus) return;
        const result = await api.getStatus();
        if (!cancelled) setSnapshot(result);
      } catch {
        // fail-open：主进程未就绪或引擎未启动时保持上一帧快照
      }
    };
    void refresh();
    pollTimerRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // 秒级本地时钟：驱动 spinner 旁耗时刷新（不重新拉快照）
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const sessions = snapshot?.sessions ?? [];

  // 全部空闲：渲染轻量占位（不显示大块，避免视觉噪音）
  if (sessions.length === 0) {
    return null;
  }

  const handleClick = () => {
    // Step 2：点击状态条切换到对应会话交互——聚焦输入框，等待中断可直接处理
    window.dispatchEvent(new CustomEvent('routedev:focus-chat-input'));
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9998,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 999,
        background: 'var(--rd-surface, #ffffff)',
        border: '1px solid var(--rd-border, rgba(0,0,0,0.08))',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        maxWidth: 'min(560px, 80vw)',
        overflow: 'hidden',
      }}
    >
      {sessions.map((session) => {
        const style = STATUS_STYLE[session.status];
        const durationMs = now - session.startedAt;
        const isActive = session.status === 'running' || session.status === 'waiting_interruption';
        return (
          <button
            key={session.sessionId}
            onClick={handleClick}
            title={`${session.title}（${style.label}）· 点击进入会话`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 999,
              border: 'none',
              cursor: 'pointer',
              background: isActive ? style.bg : 'transparent',
              color: style.color,
              fontSize: 12,
              fontWeight: 500,
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {session.status === 'running' && <Loader2 size={13} className="animate-spin" />}
            {session.status === 'waiting_interruption' && <AlertCircle size={13} />}
            {session.status === 'completed' && <CheckCircle2 size={13} />}
            {session.status === 'error' && <XCircle size={13} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.title || session.sessionId}
            </span>
            {isActive && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 3, opacity: 0.85 }}>
                <Timer size={11} />
                {formatDuration(durationMs)}
              </span>
            )}
            {session.status === 'waiting_interruption' && session.interruptionCount > 1 && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 16,
                height: 16,
                padding: '0 4px',
                borderRadius: 999,
                background: style.color,
                color: '#fff',
                fontSize: 10,
              }}>
                {session.interruptionCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
