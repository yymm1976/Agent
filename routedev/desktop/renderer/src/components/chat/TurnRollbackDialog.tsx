// desktop/renderer/src/components/chat/TurnRollbackDialog.tsx
// Phase 97 Part B：对话回滚入口——列出 turn 快照，选择后恢复
// （回退对话时同步恢复文件，restore 由 chat-bridge TurnSnapshotManager 完成，含 hash+边界校验）

import { useEffect, useState } from 'react';
import { X, History, FileText } from 'lucide-react';
import { Button } from '../ui/button.js';

// Phase 97 Part B：turn 快照结构（renderer 不直接 import src 类型——desktop tsconfig 不含 src/）
// 与 src/harness/turn-snapshot.ts 的 TurnSnapshot / RestoreResult 结构兼容（子集）
interface TurnSnapshotView {
  turnId: string;
  sessionId: string;
  userMessage: string;
  agentOutput: string;
  toolCalls: unknown[];
  changedFiles: unknown[];
  createdAt: number;
}
interface RestoreResultView {
  restored: string[];
  skipped: Array<{ path: string; reason: string }>;
}

interface TurnRollbackDialogProps {
  open: boolean;
  onClose: () => void;
}

export function TurnRollbackDialog({ open, onClose }: TurnRollbackDialogProps) {
  const [snapshots, setSnapshots] = useState<TurnSnapshotView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<TurnSnapshotView | null>(null);
  const [result, setResult] = useState<RestoreResultView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSnapshots(null);
    setSelected(null);
    setResult(null);
    setError(null);
    setLoading(true);
    window.routedev.chat
      .listTurnSnapshots()
      .then((list) => {
        setSnapshots([...list].sort((a, b) => b.createdAt - a.createdAt));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const handleRestore = async () => {
    if (!selected || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.routedev.chat.restoreTurn(selected.turnId);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const fmtTime = (ts: number): string =>
    new Date(ts).toLocaleString(undefined, { hour12: false });

  const preview = (s: TurnSnapshotView): string =>
    s.userMessage.replace(/\s+/g, ' ').slice(0, 56) || '(空消息)';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-rdLg bg-rd-card p-6 shadow-rdLg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-base font-semibold text-rd-text">
            <History size={16} /> 对话回滚
          </h3>
          <button
            onClick={onClose}
            className="text-rd-textMuted hover:text-rd-text"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {result ? (
          <div className="mb-4 rounded-rdLg bg-rd-surface p-4 text-sm text-rd-text">
            <p className="mb-1 font-medium text-rd-text">
              已恢复 {result.restored.length} 个文件
            </p>
            {result.restored.length > 0 && (
              <ul className="mb-2 max-h-32 list-inside list-disc overflow-auto text-rd-textMuted">
                {result.restored.map((p) => (
                  <li key={p} className="truncate font-mono text-xs">
                    {p}
                  </li>
                ))}
              </ul>
            )}
            {result.skipped.length > 0 && (
              <p className="text-xs text-rd-textMuted">
                跳过 {result.skipped.length} 个文件（
                {result.skipped.map((s) => s.reason).join('、')}）
              </p>
            )}
            <div className="mt-4 flex justify-end">
              <Button variant="outline" size="sm" onClick={onClose}>
                关闭
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-3 text-xs text-rd-textMuted">
              选择一次对话轮次，恢复该轮结束时的对话与文件状态（回退到该轮之后）。
            </p>
            {error && (
              <p className="mb-3 rounded-rdLg bg-rd-danger/10 p-2 text-xs text-rd-danger">
                {error}
              </p>
            )}
            <div className="mb-4 min-h-0 flex-1 overflow-auto rounded-rdLg border border-rd-border">
              {loading && !snapshots ? (
                <p className="p-4 text-center text-sm text-rd-textMuted">加载快照中…</p>
              ) : !snapshots || snapshots.length === 0 ? (
                <p className="p-4 text-center text-sm text-rd-textMuted">
                  {loading ? '加载快照中…' : '暂无可用快照'}
                </p>
              ) : (
                <ul className="divide-y divide-rd-border">
                  {snapshots.map((s) => (
                    <li key={s.turnId}>
                      <button
                        className={`flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-rd-surface ${
                          selected?.turnId === s.turnId ? 'bg-rd-surface' : ''
                        }`}
                        onClick={() => {
                          setSelected(s);
                          setResult(null);
                        }}
                      >
                        <span className="mt-0.5 shrink-0 text-xs text-rd-textMuted">
                          {fmtTime(s.createdAt)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-rd-text">{preview(s)}</span>
                          <span className="mt-0.5 flex items-center gap-2 text-xs text-rd-textMuted">
                            <FileText size={11} />
                            {s.changedFiles.length} 个文件
                            {s.toolCalls.length > 0 && ` · ${s.toolCalls.length} 次工具调用`}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="outline" size="sm" onClick={onClose}>
                取消
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={!selected || loading}
                onClick={handleRestore}
              >
                恢复此轮
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
