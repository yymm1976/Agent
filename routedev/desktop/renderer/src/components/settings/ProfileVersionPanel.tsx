// desktop/renderer/src/components/settings/ProfileVersionPanel.tsx
// Phase 94：AgentProfile 版本历史面板
// 展示版本时间轴、字段 Diff、一键回滚

import { useCallback, useEffect, useState } from 'react';
import {
  History,
  Clock,
  RotateCcw,
  Loader2,
  AlertCircle,
  X,
  ChevronDown,
  ChevronRight,
  Diff,
} from 'lucide-react';
import type { FieldDiff, VersionMeta } from '../../../../shared/ipc-types.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/badge.js';

// ============================================================
// 工具函数
// ============================================================

/** 格式化时间戳为本地可读字符串 */
function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

/** 版本来源 → 中文标签 */
function sourceLabel(source: string): string {
  switch (source) {
    case 'user_edit':
      return '用户编辑';
    case 'programmatic_write':
      return '程序写入';
    case 'rollback':
      return '回滚';
    default:
      return source || '未知';
  }
}

/** 将任意值序列化为可读摘要（截断过长内容） */
function formatValue(value: unknown, maxLen = 120): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const s = value.trim() === '' ? '""' : value;
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    const s = JSON.stringify(value);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return String(value);
  }
}

// ============================================================
// Props
// ============================================================

export interface ProfileVersionPanelProps {
  /** 目标 Profile ID（自定义 Profile） */
  profileId: string;
  /**
   * 回滚成功后的回调。
   * 父组件应据此重新拉取 Profile 详情并刷新编辑区。
   */
  onRollbackSuccess?: (profileId: string) => void;
  /** 是否显示标题栏（默认 true） */
  showHeader?: boolean;
  /** 外部触发的刷新信号（变化时重新加载版本列表） */
  refreshKey?: number | string;
}

// ============================================================
// 组件
// ============================================================

/**
 * Profile 版本历史面板
 *
 * - 时间轴列出 listVersions 结果
 * - 点击版本后调用 diffCurrentWith 展示字段 Diff
 * - 回滚按钮带确认对话框，成功后回调父组件
 */
export function ProfileVersionPanel({
  profileId,
  onRollbackSuccess,
  showHeader = true,
  refreshKey,
}: ProfileVersionPanelProps) {
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<FieldDiff[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [confirmVersion, setConfirmVersion] = useState<VersionMeta | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackResult, setRollbackResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // ---- 加载版本列表 ----
  const loadVersions = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await window.routedev.profile.listVersions(profileId);
      setVersions(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载版本历史失败');
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    setSelectedId(null);
    setDiffs(null);
    setDiffError(null);
    setConfirmVersion(null);
    setRollbackResult(null);
    void loadVersions();
  }, [profileId, refreshKey, loadVersions]);

  // ---- 选中版本 → 加载 Diff ----
  const handleSelectVersion = async (versionId: string) => {
    if (selectedId === versionId) {
      // 再次点击收起
      setSelectedId(null);
      setDiffs(null);
      setDiffError(null);
      return;
    }
    setSelectedId(versionId);
    setDiffs(null);
    setDiffError(null);
    setDiffLoading(true);
    try {
      const result = await window.routedev.profile.diffCurrentWith(profileId, versionId);
      setDiffs(Array.isArray(result) ? result : []);
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : '加载 Diff 失败');
      setDiffs(null);
    } finally {
      setDiffLoading(false);
    }
  };

  // ---- 执行回滚 ----
  const handleRollback = async () => {
    if (!confirmVersion) return;
    setRollingBack(true);
    setRollbackResult(null);
    try {
      const result = await window.routedev.profile.rollback(
        profileId,
        confirmVersion.versionId,
      );
      if (result.success) {
        setRollbackResult({ success: true, message: '回滚成功' });
        setConfirmVersion(null);
        setSelectedId(null);
        setDiffs(null);
        await loadVersions();
        onRollbackSuccess?.(profileId);
      } else {
        setRollbackResult({
          success: false,
          message: result.error || '回滚失败',
        });
      }
    } catch (err) {
      setRollbackResult({
        success: false,
        message: err instanceof Error ? err.message : '回滚失败',
      });
    } finally {
      setRollingBack(false);
    }
  };

  // ---- 渲染单个版本节点 ----
  const renderVersion = (v: VersionMeta, isLast: boolean) => {
    const isSelected = selectedId === v.versionId;
    const changeCount = v.fieldChanges?.length ?? 0;

    return (
      <div key={v.versionId} className="relative flex gap-3 pb-3" data-testid="version-item">
        {/* 时间轴竖线 + 圆点 */}
        <div className="flex flex-col items-center">
          <button
            type="button"
            onClick={() => void handleSelectVersion(v.versionId)}
            className={[
              'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition',
              isSelected
                ? 'border-rd-primary bg-rd-primary'
                : 'border-rd-border bg-rd-surface hover:border-rd-primary/50',
            ].join(' ')}
            aria-label={`选择版本 ${v.versionId}`}
          >
            {isSelected && (
              <span className="h-1.5 w-1.5 rounded-full bg-rd-primaryForeground" />
            )}
          </button>
          {!isLast && <div className="mt-1 w-0.5 flex-1 bg-rd-border" />}
        </div>

        {/* 内容区 */}
        <div className="min-w-0 flex-1 pb-1">
          <button
            type="button"
            onClick={() => void handleSelectVersion(v.versionId)}
            className={[
              'w-full rounded-lg px-3 py-2 text-left transition',
              isSelected ? 'bg-rd-primary/10' : 'hover:bg-rd-surfaceHover',
            ].join(' ')}
          >
            <div className="flex items-center gap-2 text-xs text-rd-textSubtle">
              <Clock size={11} />
              <span>{formatTime(v.timestamp)}</span>
              <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                {sourceLabel(v.source)}
              </Badge>
              {changeCount > 0 && (
                <Badge variant="primary" className="px-1.5 py-0 text-[10px]">
                  {changeCount} 字段
                </Badge>
              )}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-sm leading-snug text-rd-text">
              {isSelected ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="truncate">
                {v.label || v.changeSummary || v.versionId}
              </span>
            </div>
          </button>

          {/* 选中后：Diff + 回滚 */}
          {isSelected && (
            <div className="mt-2 space-y-2 px-1">
              {/* Diff 区 */}
              <div className="rounded-lg border border-rd-border bg-rd-surfaceHover/40 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-rd-textMuted">
                  <Diff size={12} />
                  <span>与当前版本的差异</span>
                </div>
                {diffLoading ? (
                  <div className="flex items-center gap-2 py-2 text-xs text-rd-textSubtle">
                    <Loader2 size={12} className="animate-spin" />
                    加载 Diff…
                  </div>
                ) : diffError ? (
                  <p className="text-xs text-rd-danger">{diffError}</p>
                ) : diffs === null ? null : diffs.length === 0 ? (
                  <p className="text-xs text-rd-textSubtle">无字段差异（与当前一致）</p>
                ) : (
                  <div className="max-h-48 space-y-2 overflow-y-auto">
                    {diffs.map((d) => (
                      <div
                        key={d.field}
                        className="rounded-md border border-rd-border/60 bg-rd-surface px-2.5 py-2"
                        data-testid="field-diff-row"
                      >
                        <div className="mb-1 text-xs font-medium text-rd-text">
                          {d.field}
                        </div>
                        <div className="grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-2">
                          <div className="rounded bg-rd-danger/10 px-2 py-1 text-rd-danger">
                            <span className="opacity-70">历史：</span>
                            <span className="break-all">{formatValue(d.before)}</span>
                          </div>
                          <div className="rounded bg-emerald-500/10 px-2 py-1 text-emerald-600 dark:text-emerald-400">
                            <span className="opacity-70">当前：</span>
                            <span className="break-all">{formatValue(d.after)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 回滚操作 */}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRollbackResult(null);
                    setConfirmVersion(v);
                  }}
                  className="h-7 gap-1.5 text-xs"
                >
                  <RotateCcw size={12} />
                  回滚到此版本
                </Button>
                <span className="text-[11px] text-rd-textSubtle">
                  回滚会覆盖当前 Profile，并生成一条新的版本记录
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="relative rounded-lg border border-rd-border bg-rd-surface" data-testid="profile-version-panel">
      {/* 标题栏 */}
      {showHeader && (
        <div className="flex items-center justify-between border-b border-rd-border px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium text-rd-text">
            <History size={14} className="text-rd-primary" />
            <span>版本历史</span>
            {versions.length > 0 && (
              <Badge variant="default" className="ml-0.5">
                {versions.length}
              </Badge>
            )}
          </div>
          <button
            type="button"
            onClick={() => void loadVersions()}
            disabled={loading}
            title="刷新"
            className="flex h-7 w-7 items-center justify-center rounded-md text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
            aria-label="刷新版本历史"
          >
            {loading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RotateCcw size={13} />
            )}
          </button>
        </div>
      )}

      {/* 内容 */}
      <div className="max-h-80 overflow-y-auto px-3 py-3">
        {loading && versions.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-rd-textSubtle">
            <Loader2 size={14} className="animate-spin" />
            加载版本历史…
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertCircle size={20} className="text-rd-danger" />
            <p className="text-xs text-rd-textMuted">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadVersions()}
              className="mt-1"
            >
              重试
            </Button>
          </div>
        ) : versions.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-6 text-center">
            <History size={20} className="text-rd-textSubtle" />
            <p className="text-xs text-rd-textMuted">暂无版本历史</p>
            <p className="text-[11px] text-rd-textSubtle">
              保存或修改此 Profile 后将自动生成版本记录
            </p>
          </div>
        ) : (
          <div>
            {versions.map((v, idx) => renderVersion(v, idx === versions.length - 1))}
          </div>
        )}
      </div>

      {/* 回滚结果提示 */}
      {rollbackResult && !confirmVersion && (
        <div
          className={[
            'border-t px-3 py-2 text-xs',
            rollbackResult.success
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'border-rd-danger/30 bg-rd-danger/10 text-rd-danger',
          ].join(' ')}
          data-testid="rollback-result"
        >
          {rollbackResult.message}
        </div>
      )}

      {/* 回滚确认对话框 */}
      {confirmVersion && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-3">
          <div className="w-full max-w-sm rounded-xl border border-rd-border bg-rd-surface shadow-rdLg">
            <div className="flex items-center justify-between border-b border-rd-border px-3 py-2.5">
              <div className="flex items-center gap-2 text-rd-danger">
                <AlertCircle size={15} />
                <span className="text-sm font-semibold">确认回滚</span>
              </div>
              <button
                type="button"
                onClick={() => !rollingBack && setConfirmVersion(null)}
                disabled={rollingBack}
                className="flex h-7 w-7 items-center justify-center rounded-md text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
                aria-label="关闭"
              >
                <X size={13} />
              </button>
            </div>
            <div className="space-y-3 px-3 py-3">
              <p className="text-sm text-rd-text">确定要回滚到以下版本吗？</p>
              <div className="rounded-lg bg-rd-surfaceHover px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-rd-textSubtle">
                  <Clock size={11} />
                  <span>{formatTime(confirmVersion.timestamp)}</span>
                  <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                    {sourceLabel(confirmVersion.source)}
                  </Badge>
                </div>
                <div className="mt-1 text-sm text-rd-text">
                  {confirmVersion.label ||
                    confirmVersion.changeSummary ||
                    confirmVersion.versionId}
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-rd-danger/10 px-3 py-2 text-xs text-rd-danger">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">当前 Profile 内容将被覆盖</p>
                  <p className="mt-0.5 opacity-90">
                    回滚会写入目标版本的快照，并追加一条 source=rollback 的新版本记录。
                  </p>
                </div>
              </div>
              {rollbackResult && !rollbackResult.success && (
                <p className="text-xs text-rd-danger">{rollbackResult.message}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-rd-border px-3 py-2.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmVersion(null)}
                disabled={rollingBack}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleRollback()}
                disabled={rollingBack}
                className="gap-1.5"
                data-testid="confirm-rollback-btn"
              >
                {rollingBack ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    回滚中…
                  </>
                ) : (
                  <>
                    <RotateCcw size={12} />
                    确认回滚
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
