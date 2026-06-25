// desktop/renderer/src/components/CheckpointTimeline.tsx
// Phase 47 Task 6：检查点时间轴组件
// 左侧竖线 + 圆点节点布局，点击检查点高亮并显示回滚按钮
// 回滚前弹出确认对话框（破坏性操作：git reset --hard）

import { useState, useEffect, useCallback } from 'react';
import { History, RotateCcw, AlertCircle, Loader2, Clock, FileText, X } from 'lucide-react';
import type { CheckpointInfo } from '../../../shared/ipc-types.js';
import { Button } from './ui/button.js';
import { Badge } from './ui/badge.js';

interface CheckpointTimelineProps {
  /** 当前项目 ID（用于获取检查点列表） */
  projectId?: string;
  /** 是否显示标题栏（嵌入面板时可隐藏） */
  showHeader?: boolean;
}

/** 格式化时间戳为可读字符串 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  // 超过 7 天显示完整日期
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${min}`;
}

export function CheckpointTimeline({ projectId, showHeader = true }: CheckpointTimelineProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 回滚确认对话框
  const [confirmCheckpoint, setConfirmCheckpoint] = useState<CheckpointInfo | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackResult, setRollbackResult] = useState<{ success: boolean; message: string } | null>(null);

  /** 加载检查点列表 */
  const loadCheckpoints = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await window.routedev.checkpoint.list(projectId);
      // 按时间倒序排列（最新在上）
      setCheckpoints([...list].sort((a, b) => b.timestamp - a.timestamp));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载检查点失败');
      setCheckpoints([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadCheckpoints();
  }, [loadCheckpoints]);

  /** 执行回滚 */
  const handleRollback = async () => {
    if (!confirmCheckpoint) return;
    try {
      setRollingBack(true);
      setRollbackResult(null);
      const result = await window.routedev.checkpoint.rollback(confirmCheckpoint.id);
      if (result.success) {
        setRollbackResult({ success: true, message: '回滚成功' });
        setConfirmCheckpoint(null);
        // 重新加载检查点列表（回滚后该检查点之后的检查点会被清理）
        await loadCheckpoints();
        setSelectedId(null);
      } else {
        setRollbackResult({ success: false, message: result.error || '回滚失败' });
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

  /** 渲染单个检查点节点 */
  const renderCheckpoint = (cp: CheckpointInfo, isLast: boolean) => {
    const isSelected = selectedId === cp.id;
    const displayText = cp.summary || cp.description;
    const filesChanged = cp.stats?.filesChanged ?? 0;
    const tokensUsed = cp.stats?.tokensUsed ?? 0;

    return (
      <div key={cp.id} className="relative flex gap-3 pb-4">
        {/* 时间轴竖线 + 圆点 */}
        <div className="flex flex-col items-center">
          {/* 圆点 */}
          <button
            type="button"
            onClick={() => setSelectedId(isSelected ? null : cp.id)}
            className={[
              'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition',
              isSelected
                ? 'border-rd-primary bg-rd-primary'
                : 'border-rd-border bg-rd-surface hover:border-rd-primary/50',
            ].join(' ')}
            title={cp.isAutoCreated ? '自动检查点' : '手动检查点'}
          >
            {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-rd-primaryForeground" />}
          </button>
          {/* 竖线（最后一个节点不画） */}
          {!isLast && <div className="mt-1 w-0.5 flex-1 bg-rd-border" />}
        </div>

        {/* 内容区 */}
        <div className="min-w-0 flex-1 pb-1">
          <button
            type="button"
            onClick={() => setSelectedId(isSelected ? null : cp.id)}
            className={[
              'w-full rounded-lg px-3 py-2 text-left transition',
              isSelected ? 'bg-rd-primary/10' : 'hover:bg-rd-surfaceHover',
            ].join(' ')}
          >
            {/* 时间行 */}
            <div className="flex items-center gap-2 text-xs text-rd-textSubtle">
              <Clock size={11} />
              <span>{formatTime(cp.timestamp)}</span>
              {cp.isAutoCreated && (
                <Badge variant="default" className="px-1.5 py-0 text-[10px]">自动</Badge>
              )}
            </div>
            {/* 摘要/描述 */}
            <div className="mt-1 text-sm leading-snug text-rd-text">
              {displayText}
            </div>
            {/* 统计信息 */}
            <div className="mt-1.5 flex items-center gap-1.5">
              {filesChanged > 0 && (
                <Badge variant="primary" className="gap-1 px-1.5 py-0 text-[10px]">
                  <FileText size={10} />
                  {filesChanged} 文件
                </Badge>
              )}
              {tokensUsed > 0 && (
                <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                  {tokensUsed.toLocaleString()} tokens
                </Badge>
              )}
            </div>
          </button>

          {/* 选中时显示回滚按钮 */}
          {isSelected && (
            <div className="mt-2 flex items-center gap-2 px-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmCheckpoint(cp)}
                className="h-7 gap-1.5 text-xs"
              >
                <RotateCcw size={12} />
                回滚到此点
              </Button>
              <span className="text-[11px] text-rd-textSubtle">
                回滚将丢弃此检查点之后的所有更改
              </span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* 标题栏 */}
      {showHeader && (
        <div className="flex items-center justify-between border-b border-rd-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-rd-text">
            <History size={15} className="text-rd-primary" />
            <span>检查点时间轴</span>
            {checkpoints.length > 0 && (
              <Badge variant="default" className="ml-1">{checkpoints.length}</Badge>
            )}
          </div>
          <button
            type="button"
            onClick={loadCheckpoints}
            disabled={loading}
            title="刷新"
            className="flex h-7 w-7 items-center justify-center rounded-md text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
          >
            {loading
              ? <Loader2 size={14} className="animate-spin" />
              : <RotateCcw size={14} />}
          </button>
        </div>
      )}

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && checkpoints.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={20} className="animate-spin text-rd-textSubtle" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <AlertCircle size={24} className="text-rd-danger" />
            <p className="text-sm text-rd-textMuted">{error}</p>
            <Button variant="outline" size="sm" onClick={loadCheckpoints} className="mt-2">
              重试
            </Button>
          </div>
        ) : checkpoints.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <History size={24} className="text-rd-textSubtle" />
            <p className="text-sm text-rd-textMuted">暂无检查点</p>
            <p className="text-xs text-rd-textSubtle">
              对话过程中产生的代码变更会自动创建检查点
            </p>
          </div>
        ) : (
          <div>
            {checkpoints.map((cp, idx) => renderCheckpoint(cp, idx === checkpoints.length - 1))}
          </div>
        )}
      </div>

      {/* 回滚确认对话框 */}
      {confirmCheckpoint && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-rd-border bg-rd-surface shadow-rdLg">
            {/* 标题栏 */}
            <div className="flex items-center justify-between border-b border-rd-border px-4 py-3">
              <div className="flex items-center gap-2 text-rd-danger">
                <AlertCircle size={16} />
                <span className="text-sm font-semibold">确认回滚</span>
              </div>
              <button
                type="button"
                onClick={() => !rollingBack && setConfirmCheckpoint(null)}
                disabled={rollingBack}
                className="flex h-7 w-7 items-center justify-center rounded-md text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
              >
                <X size={14} />
              </button>
            </div>
            {/* 内容 */}
            <div className="space-y-3 px-4 py-4">
              <p className="text-sm text-rd-text">
                确定要回滚到以下检查点吗？
              </p>
              <div className="rounded-lg bg-rd-surfaceHover px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-rd-textSubtle">
                  <Clock size={11} />
                  <span>{formatTime(confirmCheckpoint.timestamp)}</span>
                </div>
                <div className="mt-1 text-sm text-rd-text">
                  {confirmCheckpoint.summary || confirmCheckpoint.description}
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-lg bg-rd-danger/10 px-3 py-2 text-xs text-rd-danger">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">警告：这是一个破坏性操作</p>
                  <p className="mt-0.5 opacity-90">
                    回滚将执行 git reset --hard，此检查点之后的所有代码更改将被丢弃，且无法恢复。
                  </p>
                </div>
              </div>
              {rollbackResult && !rollbackResult.success && (
                <div className="flex items-center gap-2 rounded-lg bg-rd-danger/10 px-3 py-2 text-xs text-rd-danger">
                  <AlertCircle size={14} className="shrink-0" />
                  <span>{rollbackResult.message}</span>
                </div>
              )}
            </div>
            {/* 按钮区 */}
            <div className="flex justify-end gap-2 border-t border-rd-border px-4 py-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmCheckpoint(null)}
                disabled={rollingBack}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleRollback}
                disabled={rollingBack}
              >
                {rollingBack ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    回滚中...
                  </>
                ) : (
                  <>
                    <RotateCcw size={14} />
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
