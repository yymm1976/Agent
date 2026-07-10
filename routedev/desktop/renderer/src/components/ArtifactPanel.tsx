// desktop/renderer/src/components/ArtifactPanel.tsx
// Phase 74-F1：右侧固定产物面板（340px）
// 三个 tabs：产物（文件修改列表）/ 检查点（嵌入 CheckpointTimeline）/ 上下文（token 消耗）
// 保留现有弱边框美学：border-l border-rd-border + bg-rd-surface
// 数据来源：从 messages 提取 file_write/file_edit 工具调用，按文件路径聚合统计版本号

import { useState, useMemo } from 'react';
import { FileText, Copy, Package, History, Gauge } from 'lucide-react';
import { useRouteDevStore, type ChatMessage } from '../store/useRouteDevStore.js';
import { CheckpointTimeline } from './CheckpointTimeline.js';

type PanelTab = 'artifacts' | 'checkpoints' | 'context';

export interface ArtifactPanelProps {
  /** 当前对话的所有消息（用于提取产物文件列表） */
  messages: ChatMessage[];
  /** 当前项目 ID（传给 CheckpointTimeline） */
  projectId?: string;
}

/** 单个产物的聚合信息 */
interface ArtifactItem {
  /** 文件路径 */
  path: string;
  /** 文件名（路径最后一段） */
  name: string;
  /** 修改次数（版本号） */
  version: number;
  /** 最后修改时间戳 */
  lastModified: number;
}

/** 从消息列表中提取产物文件（file_write/file_edit 工具调用） */
function extractArtifacts(messages: ChatMessage[]): ArtifactItem[] {
  const map = new Map<string, ArtifactItem>();
  for (const msg of messages) {
    if (msg.toolName !== 'file_write' && msg.toolName !== 'file_edit') continue;
    const path = String(
      msg.toolArgs?.path || msg.toolArgs?.filePath || msg.toolArgs?.file || msg.toolArgs?.filename || '',
    );
    if (!path) continue;
    const existing = map.get(path);
    const ts = msg.timestamp ?? Date.now();
    if (existing) {
      existing.version += 1;
      if (ts > existing.lastModified) existing.lastModified = ts;
    } else {
      map.set(path, {
        path,
        name: path.split(/[\\/]/).pop() || path,
        version: 1,
        lastModified: ts,
      });
    }
  }
  // 按最后修改时间倒序（最新的在前）
  return Array.from(map.values()).sort((a, b) => b.lastModified - a.lastModified);
}

/** 格式化 token 数为 k 单位 */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ArtifactPanel({ messages, projectId }: ArtifactPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('artifacts');
  // F-011：自行订阅 tokenSnapshots（仅本组件需要完整数组做趋势统计，避免父级 App/ChatPage 重渲染）
  const tokenSnapshots = useRouteDevStore((s) => s.tokenSnapshots);

  // 提取产物列表
  const artifacts = useMemo(() => extractArtifacts(messages), [messages]);
  // token 总消耗（所有快照的 totalEstimated 之和）
  const totalTokens = useMemo(
    () => tokenSnapshots.reduce((sum, s) => sum + (s.totalEstimated ?? 0), 0),
    [tokenSnapshots],
  );

  // 复制文件路径到剪贴板
  const handleCopyPath = (path: string) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(path).catch(() => {});
    }
  };

  return (
    <div
      role="region"
      aria-label="产物面板"
      className="relative flex w-[340px] shrink-0 flex-col border-l border-rd-border bg-rd-surface"
    >
      {/* Tabs 栏（74-I：role=tablist + 每个按钮 role=tab + aria-selected） */}
      <div className="flex shrink-0 items-center border-b border-rd-border" role="tablist" aria-label="产物面板标签">
        {([
          { key: 'artifacts' as const, label: '产物', count: artifacts.length, icon: Package },
          { key: 'checkpoints' as const, label: '检查点', count: null, icon: History },
          { key: 'context' as const, label: '上下文', count: totalTokens, icon: Gauge },
        ]).map((tab) => {
          const active = activeTab === tab.key;
          const countLabel = tab.count === null
            ? ''
            : tab.key === 'context'
            ? formatTokens(tab.count)
            : String(tab.count);
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`panel-${tab.key}`}
              id={`tab-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              className={[
                'flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition',
                active
                  ? 'border-b-2 border-rd-primary text-rd-primary'
                  : 'text-rd-textMuted hover:bg-rd-surfaceHover hover:text-rd-text',
              ].join(' ')}
            >
              <tab.icon size={13} />
              <span>{tab.label}</span>
              {countLabel && (
                <span className={[
                  'rounded-full px-1.5 text-[10px] font-semibold',
                  active ? 'bg-rd-primary/10 text-rd-primary' : 'bg-rd-surfaceHover text-rd-textSubtle',
                ].join(' ')}>
                  {countLabel}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab 内容（74-I：role=tabpanel + aria-labelledby） */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === 'artifacts' && (
          <div className="p-2">
            {artifacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                <FileText size={28} className="mb-2 text-rd-textSubtle/50" />
                <p className="text-xs text-rd-textSubtle">暂无产物</p>
                <p className="mt-1 text-[11px] text-rd-textSubtle/70">Agent 写入或编辑的文件将在此显示</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {artifacts.map((item) => (
                  <div
                    key={item.path}
                    className="rounded-md border border-rd-border bg-rd-background px-2.5 py-2 transition hover:border-rd-borderHover"
                  >
                    <div className="flex items-center gap-2">
                      <FileText size={13} className="shrink-0 text-rd-primary" />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-rd-text" title={item.path}>
                        {item.name}
                      </span>
                      <span className="shrink-0 rounded-full bg-rd-primary/10 px-1.5 text-[10px] font-semibold text-rd-primary">
                        v{item.version}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyPath(item.path)}
                        title="复制路径"
                        aria-label={`复制 ${item.name} 的路径`}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
                      >
                        <Copy size={11} />
                      </button>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-rd-textSubtle" title={item.path}>
                      {item.path}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'checkpoints' && (
          <CheckpointTimeline projectId={projectId} showHeader={false} />
        )}

        {activeTab === 'context' && (
          <div className="p-3">
            {tokenSnapshots.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                <Gauge size={28} className="mb-2 text-rd-textSubtle/50" />
                <p className="text-xs text-rd-textSubtle">暂无上下文数据</p>
                <p className="mt-1 text-[11px] text-rd-textSubtle/70">对话开始后将显示 token 消耗</p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="rounded-md border border-rd-border bg-rd-background px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-rd-textMuted">总消耗</span>
                    <span className="text-sm font-semibold text-rd-text tabular-nums">
                      {formatTokens(totalTokens)} tokens
                    </span>
                  </div>
                </div>
                {tokenSnapshots.slice(-10).map((snap, idx) => (
                  <div
                    key={idx}
                    className="rounded-md border border-rd-border bg-rd-background px-3 py-2"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate text-rd-text" title={snap.modelId}>
                        {snap.modelId}
                      </span>
                      <span className="shrink-0 tabular-nums text-rd-textMuted">
                        {formatTokens(snap.totalEstimated ?? 0)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-rd-textSubtle">
                      <span title="系统提示词">sys {formatTokens(snap.systemPrompt ?? 0)}</span>
                      <span title="对话历史">hist {formatTokens(snap.conversationHistory ?? 0)}</span>
                      <span title="工具定义+返回">tool {formatTokens((snap.toolDefinitions ?? 0) + (snap.toolResults ?? 0))}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
