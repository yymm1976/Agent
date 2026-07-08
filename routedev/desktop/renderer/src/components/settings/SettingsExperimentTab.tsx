// desktop/renderer/src/components/settings/SettingsExperimentTab.tsx
// Phase 44：并行实验设置
// Phase 71：新增实验分支管理 UI（list / adopt / discard / getDiff）

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, FileDiff, Check, X } from 'lucide-react';
import type { AppConfig } from '../../../../../src/config/schema.js';
import type { ExperimentInfo } from '../../../../shared/ipc-types.js';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { Input } from '../ui/input.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/badge.js';

interface SettingsExperimentTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
}

export function SettingsExperimentTab({ draft, updateDraft }: SettingsExperimentTabProps) {
  const experiment = draft.experiment;

  const updateExperiment = (patch: Partial<typeof experiment>) => {
    updateDraft({ experiment: { ...experiment, ...patch } });
  };

  // ===== Phase 71：实验分支管理状态 =====
  const [experiments, setExperiments] = useState<ExperimentInfo[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [diffForId, setDiffForId] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string>('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadExperiments = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const list = await window.routedev.experiment.list();
      setExperiments(list);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    loadExperiments();
  }, [loadExperiments]);

  const handleGetDiff = useCallback(async (id: string) => {
    setDiffLoading(true);
    setActionError(null);
    try {
      const res = await window.routedev.experiment.getDiff(id);
      if (res.error) {
        setActionError(res.error);
      } else {
        setDiffForId(id);
        setDiffContent(res.diff || '（无差异内容）');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiffLoading(false);
    }
  }, []);

  const handleAdopt = useCallback(async (id: string) => {
    setActionError(null);
    try {
      const res = await window.routedev.experiment.adopt(id);
      if (!res.success) {
        setActionError(res.error || '采纳失败');
        return;
      }
      await loadExperiments();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [loadExperiments]);

  const handleDiscard = useCallback(async (id: string) => {
    setActionError(null);
    try {
      const res = await window.routedev.experiment.discard(id);
      if (!res.success) {
        setActionError(res.error || '丢弃失败');
        return;
      }
      if (diffForId === id) {
        setDiffForId(null);
        setDiffContent('');
      }
      await loadExperiments();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [loadExperiments, diffForId]);

  return (
    <div className="absolute inset-0 space-y-6 overflow-y-auto pr-2">
      <Card>
        <CardHeader>
          <CardTitle>并行实验</CardTitle>
          <CardDescription>控制多分支并行实验的并发与冲突检测</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="experiment-parallel-enabled">启用并行实验</Label>
              <p className="text-xs text-rd-textMuted">允许同时运行多个实验分支并自动对比结果。</p>
            </div>
            <Switch
              id="experiment-parallel-enabled"
              checked={experiment.parallelEnabled}
              onCheckedChange={(checked) => updateExperiment({ parallelEnabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="experiment-conflict-detection">启用冲突检测</Label>
              <p className="text-xs text-rd-textMuted">并行前检测分支间的文件写冲突。</p>
            </div>
            <Switch
              id="experiment-conflict-detection"
              checked={experiment.conflictDetection}
              onCheckedChange={(checked) => updateExperiment({ conflictDetection: checked })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="experiment-max-parallel">最大并行实验数</Label>
            <Input
              id="experiment-max-parallel"
              type="number"
              min={2}
              max={5}
              value={experiment.maxParallel}
              onChange={(e) => updateExperiment({ maxParallel: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">同时运行的最大实验分支数（2-5）。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="experiment-auto-cleanup">自动清理天数</Label>
            <Input
              id="experiment-auto-cleanup"
              type="number"
              min={0}
              value={experiment.autoCleanupDays}
              onChange={(e) => updateExperiment({ autoCleanupDays: Number(e.target.value) })}
            />
            <p className="text-xs text-rd-textMuted">0 表示不自动清理。</p>
          </div>
        </CardContent>
      </Card>

      {/* ===== Phase 71：实验分支管理 ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>实验分支管理</span>
            <Button
              variant="outline"
              size="sm"
              onClick={loadExperiments}
              disabled={loadingList}
              title="刷新实验列表"
            >
              <RefreshCw size={14} className={loadingList ? 'animate-spin' : ''} />
              刷新
            </Button>
          </CardTitle>
          <CardDescription>查看、采纳或丢弃并行实验分支</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {listError && (
            <div className="text-xs text-rd-danger">加载失败：{listError}</div>
          )}
          {actionError && (
            <div className="text-xs text-rd-danger">操作失败：{actionError}</div>
          )}
          {!loadingList && experiments.length === 0 && !listError && (
            <div className="py-4 text-center text-sm text-rd-textMuted">暂无实验分支</div>
          )}
          {experiments.map((exp) => (
            <div
              key={exp.id}
              className="rounded-md border border-rd-border p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-rd-text">{exp.name}</span>
                    <Badge variant="outline" className="text-[10px]">{exp.status}</Badge>
                  </div>
                  <div className="text-xs text-rd-textMuted">
                    ID: <span className="font-mono">{exp.id}</span>
                    {exp.duration !== undefined && (
                      <span className="ml-3">耗时: {(exp.duration / 1000).toFixed(1)}秒</span>
                    )}
                    {exp.tokenUsage !== undefined && exp.tokenUsage > 0 && (
                      <span className="ml-3">Token: {exp.tokenUsage}</span>
                    )}
                  </div>
                  <div className="text-xs text-rd-textSubtle truncate" title={exp.task}>
                    {exp.task}
                  </div>
                  {exp.modifiedFiles.length > 0 && (
                    <div className="text-xs text-rd-textMuted">
                      修改文件: {exp.modifiedFiles.length} 个
                    </div>
                  )}
                  {exp.error && (
                    <div className="text-xs text-rd-danger">{exp.error}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleGetDiff(exp.id)}
                    disabled={diffLoading && diffForId === null}
                    title="查看 Diff"
                  >
                    <FileDiff size={14} />
                    Diff
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleAdopt(exp.id)}
                    title="采纳此实验分支"
                  >
                    <Check size={14} />
                    采纳
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-rd-danger hover:bg-rd-danger/10"
                    onClick={() => handleDiscard(exp.id)}
                    title="丢弃此实验分支"
                  >
                    <X size={14} />
                    丢弃
                  </Button>
                </div>
              </div>
              {/* Diff 展示区（展开式） */}
              {diffForId === exp.id && (
                <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-rd-background border border-rd-border/50 p-2 text-xs text-rd-textSubtle whitespace-pre-wrap break-all">
                  {diffContent}
                </pre>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
