// desktop/renderer/src/components/Phase50Components.tsx
// Phase 50 Task 7：桌面端 wrapper 组件
// 引用 CLI 端组件的文本渲染函数，在 Electron renderer 中以样式化卡片形式展示
// 设计原则：桌面端与 CLI 端可以不同步，优先 CLI 端；此处仅提供基础可视化接入

import { useMemo, useState } from 'react';
import { GitBranch, RotateCcw, Activity, FileDiff, Bell, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Button } from './ui/button.js';
import { Badge } from './ui/badge.js';
// 引用 CLI 端纯文本渲染函数
import { renderBranchTreeText } from '../../../../src/cli/components/BranchSwitcher.js';
import { renderSnapshotListText, formatSnapshotLine } from '../../../../src/cli/components/ResumePicker.js';
import { renderProgressBar } from '../../../../src/cli/components/ProgressBar.js';
import { renderTraceTimelineText, type TraceTimelineEntry } from '../../../../src/cli/components/TracePanel.js';
import { renderDiffText, parseUnifiedDiff } from '../../../../src/cli/components/DiffView.js';
import type { BranchInfo } from '../../../../src/agent/branch.js';
import type { ExecutionSnapshot } from '../../../../src/agent/durable-executor.js';
import type { ConfigChange } from '../../../../src/cli/components/ConfigReloadUI.js';

// ============================================================
// 1. BranchSwitcherCard：分支树可视化卡片
// ============================================================
interface BranchSwitcherCardProps {
  branches: BranchInfo[];
  activeBranchId: string | null;
  /** 配置开关（false 时不渲染） */
  enabled?: boolean;
}

export function BranchSwitcherCard({ branches, activeBranchId, enabled = true }: BranchSwitcherCardProps) {
  if (!enabled || branches.length === 0) return null;
  const text = renderBranchTreeText(branches, activeBranchId);
  return (
    <Card className="border-rd-border">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <GitBranch size={14} className="text-rd-primary" />
          对话分支
          <Badge variant="default" className="ml-auto">{branches.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="whitespace-pre-wrap font-mono text-xs text-rd-textMuted">{text}</pre>
      </CardContent>
    </Card>
  );
}

// ============================================================
// 2. ResumePickerCard：恢复执行选择器卡片
// ============================================================
interface ResumePickerCardProps {
  snapshots: ExecutionSnapshot[];
  onResume?: (planId: string) => void;
  enabled?: boolean;
}

export function ResumePickerCard({ snapshots, onResume, enabled = true }: ResumePickerCardProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  if (!enabled || snapshots.length === 0) return null;

  return (
    <Card className="border-rd-border">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <RotateCcw size={14} className="text-rd-primary" />
          可恢复的执行
          <Badge variant="default" className="ml-auto">{snapshots.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {snapshots.map((snapshot, idx) => {
            const isSelected = idx === selectedIdx;
            return (
              <button
                key={snapshot.planId}
                onClick={() => setSelectedIdx(idx)}
                className={[
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition',
                  isSelected ? 'bg-rd-primary/10 text-rd-primary' : 'text-rd-textMuted hover:bg-rd-surfaceHover',
                ].join(' ')}
              >
                <span className="font-mono">{isSelected ? '▶' : ' '}</span>
                <span className="truncate">{formatSnapshotLine(snapshot, idx)}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button
            size="sm"
            disabled={!snapshots[selectedIdx]}
            onClick={() => snapshots[selectedIdx] && onResume?.(snapshots[selectedIdx].planId)}
          >
            恢复执行
          </Button>
        </div>
        <p className="mt-2 text-[10px] text-rd-textSubtle">
          {renderSnapshotListText(snapshots).split('\n').slice(-2)[0]}
        </p>
      </CardContent>
    </Card>
  );
}

// ============================================================
// 3. ProgressBarCard：通用进度条卡片
// ============================================================
interface ProgressBarCardProps {
  current: number;
  total: number;
  label?: string;
  enabled?: boolean;
}

export function ProgressBarCard({ current, total, label = '进度', enabled = true }: ProgressBarCardProps) {
  if (!enabled) return null;
  const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const percent = Math.round(ratio * 100);
  const bar = renderProgressBar(current, total, 30);

  return (
    <Card className="border-rd-border">
      <CardContent className="py-3">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="text-rd-textSubtle">{label}</span>
          <span className="font-mono text-rd-primary">{current}/{total} · {percent}%</span>
        </div>
        <pre className="font-mono text-sm text-rd-primary">{bar}</pre>
      </CardContent>
    </Card>
  );
}

// ============================================================
// 4. TracePanelCard：Trace 时间线卡片
// ============================================================
interface TracePanelCardProps {
  entries: TraceTimelineEntry[];
  sessionId?: string;
  enabled?: boolean;
}

export function TracePanelCard({ entries, sessionId, enabled = true }: TracePanelCardProps) {
  const [expanded, setExpanded] = useState(false);
  if (!enabled || entries.length === 0) return null;

  const text = useMemo(() => renderTraceTimelineText(entries, sessionId, expanded ? 3 : 2), [entries, sessionId, expanded]);

  return (
    <Card className="border-rd-border">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity size={14} className="text-rd-primary" />
          Trace 时间线
          <Badge variant="default" className="ml-auto">{entries.length} 步</Badge>
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-rd-textSubtle hover:text-rd-text"
            title={expanded ? '折叠' : '展开'}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-rd-textMuted">{text}</pre>
      </CardContent>
    </Card>
  );
}

// ============================================================
// 5. DiffViewCard：diff 可视化卡片
// ============================================================
interface DiffViewCardProps {
  diff: string;
  fileName?: string;
  enabled?: boolean;
}

export function DiffViewCard({ diff, fileName, enabled = true }: DiffViewCardProps) {
  if (!enabled || !diff.trim()) return null;
  const parsed = parseUnifiedDiff(diff);
  const displayName = fileName || parsed.fileName || '未知文件';
  const text = renderDiffText(parsed, 0);

  return (
    <Card className="border-rd-border">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileDiff size={14} className="text-rd-primary" />
          <span className="truncate">{displayName}</span>
          <Badge variant="success" className="ml-auto">+{parsed.additions}</Badge>
          <Badge variant="destructive">-{parsed.deletions}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-rd-textMuted">{text}</pre>
      </CardContent>
    </Card>
  );
}

// ============================================================
// 6. ConfigReloadNoticeCard：配置变更通知卡片
// ============================================================
interface ConfigReloadNoticeCardProps {
  changes: ConfigChange[];
  timestamp?: Date;
  enabled?: boolean;
  onClose?: () => void;
}

export function ConfigReloadNoticeCard({ changes, timestamp, enabled = true, onClose }: ConfigReloadNoticeCardProps) {
  if (!enabled || changes.length === 0) return null;
  const timeStr = timestamp ? timestamp.toLocaleTimeString('zh-CN', { hour12: false }) : '';

  return (
    <Card className="border-rd-primary/30 bg-rd-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bell size={14} className="text-rd-primary" />
          配置已变更
          {onClose && (
            <button
              onClick={onClose}
              className="ml-auto text-rd-textSubtle hover:text-rd-text"
              title="关闭"
            >
              ×
            </button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {changes.map((change, idx) => (
            <div key={`${change.path}-${idx}`} className="flex items-center gap-2 text-xs">
              <span
                className={[
                  'inline-block h-1.5 w-1.5 rounded-full',
                  change.hot ? 'bg-rd-success' : 'bg-rd-warning',
                ].join(' ')}
              />
              <span className="text-rd-text">{change.message}</span>
              {change.hot && (
                <Badge variant="success" className="text-[10px]">已立即生效</Badge>
              )}
            </div>
          ))}
        </div>
        {timeStr && <p className="mt-2 text-[10px] text-rd-textSubtle">└ {timeStr}</p>}
      </CardContent>
    </Card>
  );
}
