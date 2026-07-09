// desktop/renderer/src/components/StatusBanner.tsx
// 状态提示组件：监听 IPC 事件并显示横幅 / toast / 状态栏提示
// 提示类型：路由降级、SSRF 拦截、检查点保存、Worker 重试、配置热重载、
//           MCP 断开、模型熔断、并行执行、调度器异常、图谱保存

import { useEffect, useRef, useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { useRouteDevStore } from '../store/useRouteDevStore.js';

// --- 提示类型 ---
type NotificationKind =
  | 'route-degraded'      // 顶部黄色横幅，10s 自动消失
  | 'ssrf-blocked'        // 红色警告条，手动关闭
  | 'checkpoint-saved'    // 底部 toast，2s 自动消失
  | 'worker-retry'        // 底部 toast，持续显示直到完成
  | 'config-reloaded'     // 右下角 toast，2s 自动消失
  | 'mcp-disconnected'    // 状态栏区域，持续显示
  | 'circuit-breaker'     // 顶部红色横幅，倒计时
  | 'parallel-progress'   // 底部 toast，持续显示
  | 'scheduler-error'     // 状态栏区域，持续显示
  | 'graph-saved';        // 状态栏区域，0.5s 闪烁

interface NotificationItem {
  id: string;
  kind: NotificationKind;
  text: string;
  detail?: string;
  /** 倒计时剩余秒数（仅 circuit-breaker 使用） */
  remainingSeconds?: number;
}

// --- IPC 通道类型 ---
// 注意：status:* 通道尚未加入 MainToRendererEvent 联合类型，
// 这里用 string 类型绕过类型检查，避免修改 ipc-types.ts
type StatusApi = {
  on: (channel: string, callback: (payload: unknown) => void) => void;
  off: (channel: string, callback: (payload: unknown) => void) => void;
};

// --- 颜色常量 ---
const COLOR_YELLOW_BG = '#FEF3C7';
const COLOR_RED_BG = '#FEE2E2';
const COLOR_TOAST_BG = '#F3F4F6';
const COLOR_TEXT = '#1f2937';
const COLOR_TEXT_MUTED = '#6b7280';
const COLOR_RED_TEXT = '#991b1b';

let idCounter = 0;
const nextId = () => `sn-${++idCounter}`;

/**
 * StatusBanner：监听 IPC status:* 事件并显示对应 UI 提示
 *
 * 提示分四个区域：
 * 1. 顶部横幅（route-degraded / ssrf-blocked / circuit-breaker）
 * 2. 底部 toast（checkpoint-saved / worker-retry / parallel-progress）
 * 3. 右下角 toast（config-reloaded）
 * 4. 状态栏（mcp-disconnected / scheduler-error / graph-saved）
 */
export function StatusBanner() {
  const config = useRouteDevStore((s) => s.config);
  // 用 ref 保存最新的配置标志，避免 IPC handler 频繁重订阅
  const flagsRef = useRef({
    checkpointNotify: config?.execution?.checkpointNotify ?? true,
    hotReloadNotify: config?.ui?.hotReloadNotify ?? true,
  });
  flagsRef.current = {
    checkpointNotify: config?.execution?.checkpointNotify ?? true,
    hotReloadNotify: config?.ui?.hotReloadNotify ?? true,
  };

  const [items, setItems] = useState<NotificationItem[]>([]);

  // --- 工具函数 ---
  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const addOrUpdate = useCallback((kind: NotificationKind, builder: (id: string) => NotificationItem, updatable = false) => {
    setItems((prev) => {
      if (updatable) {
        const existing = prev.find((it) => it.kind === kind);
        if (existing) {
          const updated = builder(existing.id);
          return prev.map((it) => (it.id === existing.id ? updated : it));
        }
      }
      // 移除同 kind 的旧项（避免堆叠），再追加新项
      const filtered = prev.filter((it) => it.kind !== kind);
      return [...filtered, builder(nextId())];
    });
  }, []);

  // --- 自动消失定时器 ---
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const scheduleDismiss = useCallback((id: string, ms: number) => {
    // 清理已有定时器
    if (timersRef.current[id]) {
      clearTimeout(timersRef.current[id]);
    }
    timersRef.current[id] = setTimeout(() => {
      dismiss(id);
      delete timersRef.current[id];
    }, ms);
  }, [dismiss]);

  // --- IPC 事件监听 ---
  // Grok F-003 修复：status:* 事件在 main 进程无发送方
  // （核验：desktop/main 中无 webContents.send('status:...')，所有 status:* 通道均为死监听）。
  // 订阅代码已移除；组件框架（types / 工具函数 / render）保留，待 main 端接入 status:* 发送后可恢复订阅。
  useEffect(() => {
    const api = window.routedev as unknown as StatusApi | undefined;
    if (!api) return;
    // no-op：status:* 事件无发送方，订阅已移除（Grok F-003）
  }, []);

  // --- 熔断倒计时 ---
  useEffect(() => {
    const cbItem = items.find((it) => it.kind === 'circuit-breaker');
    if (!cbItem || cbItem.remainingSeconds === undefined || cbItem.remainingSeconds <= 0) return;

    const timer = setTimeout(() => {
      setItems((prev) => prev.map((it) => {
        if (it.id !== cbItem.id) return it;
        const next = (it.remainingSeconds ?? 0) - 1;
        if (next <= 0) {
          // 倒计时结束，移除
          return { ...it, remainingSeconds: 0 };
        }
        return { ...it, remainingSeconds: next, text: `🔴 模型熔断，${next}秒后重试` };
      }));
      // 倒计时归零后清理
      if ((cbItem.remainingSeconds ?? 0) - 1 <= 0) {
        dismiss(cbItem.id);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [items, dismiss]);

  // --- 清理所有定时器（组件卸载时） ---
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  // --- 分组渲染 ---
  const topBanners = items.filter((it) =>
    it.kind === 'route-degraded' || it.kind === 'ssrf-blocked' || it.kind === 'circuit-breaker'
  );
  const bottomToasts = items.filter((it) =>
    it.kind === 'checkpoint-saved' || it.kind === 'worker-retry' || it.kind === 'parallel-progress'
  );
  const bottomRightToasts = items.filter((it) => it.kind === 'config-reloaded');
  const statusBarItems = items.filter((it) =>
    it.kind === 'mcp-disconnected' || it.kind === 'scheduler-error' || it.kind === 'graph-saved'
  );

  return (
    <>
      {/* 动画样式 */}
      <style>{`
        @keyframes rd-slide-down { from { opacity: 0; transform: translateY(-100%); } to { opacity: 1; transform: translateY(0); } }
        @keyframes rd-slide-up { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: translateY(0); } }
        @keyframes rd-slide-left { from { opacity: 0; transform: translateX(100%); } to { opacity: 1; transform: translateX(0); } }
        @keyframes rd-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes rd-flash { 0% { opacity: 0; } 50% { opacity: 1; } 100% { opacity: 0; } }
        @keyframes rd-pulse-red { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
      `}</style>

      {/* 顶部横幅 */}
      {topBanners.length > 0 && (
        <div style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
          pointerEvents: 'none',
        }}>
          {topBanners.map((it) => {
            const isRed = it.kind === 'ssrf-blocked' || it.kind === 'circuit-breaker';
            return (
              <div key={it.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 16px', borderRadius: 8,
                backgroundColor: isRed ? COLOR_RED_BG : COLOR_YELLOW_BG,
                color: isRed ? COLOR_RED_TEXT : COLOR_TEXT,
                fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                animation: 'rd-slide-down 0.3s ease-out',
                pointerEvents: 'auto',
                maxWidth: 520,
              }}>
                <span>{it.text}</span>
                {it.detail && <span style={{ fontSize: 12, opacity: 0.8 }}>{it.detail}</span>}
                {it.kind === 'ssrf-blocked' && (
                  <button
                    onClick={() => dismiss(it.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: 'inherit' }}
                    title="关闭"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 底部 toast */}
      {bottomToasts.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
          pointerEvents: 'none',
        }}>
          {bottomToasts.map((it) => (
            <div key={it.id} style={{
              padding: '8px 14px', borderRadius: 8,
              backgroundColor: COLOR_TOAST_BG, color: COLOR_TEXT,
              fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              animation: 'rd-slide-up 0.3s ease-out',
              pointerEvents: 'auto',
            }}>
              {it.text}
            </div>
          ))}
        </div>
      )}

      {/* 右下角 toast */}
      {bottomRightToasts.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24,
          zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end',
          pointerEvents: 'none',
        }}>
          {bottomRightToasts.map((it) => (
            <div key={it.id} style={{
              padding: '8px 14px', borderRadius: 8,
              backgroundColor: COLOR_TOAST_BG, color: COLOR_TEXT,
              fontSize: 13, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              animation: 'rd-slide-left 0.3s ease-out',
              pointerEvents: 'auto',
            }}>
              {it.text}
            </div>
          ))}
        </div>
      )}

      {/* 状态栏区域（左下角） */}
      {statusBarItems.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 8, left: 12,
          zIndex: 9999, display: 'flex', alignItems: 'center', gap: 12,
          pointerEvents: 'auto',
        }}>
          {statusBarItems.map((it) => {
            const isGraphSaved = it.kind === 'graph-saved';
            return (
              <div
                key={it.id}
                title={it.detail || it.text}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: 8,
                  backgroundColor: it.kind === 'mcp-disconnected' || it.kind === 'scheduler-error'
                    ? COLOR_RED_BG
                    : COLOR_TOAST_BG,
                  color: it.kind === 'mcp-disconnected' || it.kind === 'scheduler-error'
                    ? COLOR_RED_TEXT
                    : COLOR_TEXT,
                  fontSize: 12,
                  cursor: 'help',
                  animation: isGraphSaved
                    ? 'rd-flash 0.5s ease-in-out forwards'
                    : 'rd-fade-in 0.3s ease-out',
                }}
              >
                <span>{it.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
