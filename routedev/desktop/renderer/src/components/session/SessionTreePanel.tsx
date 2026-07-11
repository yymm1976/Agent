// desktop/renderer/src/components/session/SessionTreePanel.tsx
// Phase 84 Task 3：会话树视图面板
//
// 展示会话分支结构，支持折叠/展开、节点跳转、角色筛选、分支切换。
// 由父组件（ChatPage 集成时）传入序列化后的 SessionTreeData。
// 暗色主题优先，使用项目 rd-* Tailwind 自定义颜色。

import { useMemo, useState } from 'react';
import { GitBranch, Search, Inbox } from 'lucide-react';
import type { SessionTreeData } from '../../../../../src/session/session-tree.js';
import type { SessionNode } from '../../../../../src/session/session-node.js';
import { SessionTreeNode } from './SessionTreeNode.js';

export interface SessionTreePanelProps {
  /** 序列化后的会话树数据；为 null 时显示空状态 */
  tree: SessionTreeData | null;
  /** 点击节点回调（跳转到该位置继续对话） */
  onNodeClick?: (nodeId: string) => void;
  /** fork 按钮回调（从指定节点创建新分支） */
  onFork?: (nodeId: string) => void;
  /** 自定义容器类名 */
  className?: string;
}

/** 筛选选项：全部 / 用户消息 / 助手消息 / 工具调用 */
type FilterOption = 'all' | 'user' | 'assistant' | 'toolResult';

const FILTER_LABELS: Record<FilterOption, string> = {
  all: '全部',
  user: '用户消息',
  assistant: '助手消息',
  toolResult: '工具调用',
};

export function SessionTreePanel({
  tree,
  onNodeClick,
  onFork,
  className,
}: SessionTreePanelProps) {
  const [filter, setFilter] = useState<FilterOption>('all');

  // 将 nodes 数组转为 Map，便于 O(1) 查找子节点
  const nodesMap = useMemo(() => {
    const map = new Map<string, SessionNode>();
    if (tree?.nodes) {
      for (const node of tree.nodes) {
        map.set(node.id, node);
      }
    }
    return map;
  }, [tree]);

  // 筛选的角色集合；filter === 'all' 时不筛选
  const filteredRoles = useMemo(() => {
    if (filter === 'all') return undefined;
    return new Set<SessionNode['role']>([filter]);
  }, [filter]);

  // 空状态：tree 为 null 或无节点
  if (!tree || !tree.nodes || tree.nodes.length === 0) {
    return (
      <div className={['flex h-full flex-col bg-rd-surface', className].join(' ')}>
        <div className="flex items-center gap-2 border-b border-rd-border px-3 py-2">
          <GitBranch size={14} className="text-rd-primary" />
          <span className="text-sm font-medium text-rd-text">会话分支</span>
        </div>
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="flex flex-col items-center gap-2 text-rd-textMuted">
            <Inbox size={32} strokeWidth={1} />
            <span className="text-xs">暂无会话分支</span>
          </div>
        </div>
      </div>
    );
  }

  const root = nodesMap.get(tree.rootId);
  if (!root) return null;

  // 分支信息（多分支时显示分支切换栏）
  const branches = tree.branches ?? [];
  const showBranchBar = branches.length > 1;

  return (
    <div className={['flex h-full flex-col bg-rd-surface', className].join(' ')}>
      {/* 标题栏 */}
      <div className="flex items-center gap-2 border-b border-rd-border px-3 py-2">
        <GitBranch size={14} className="text-rd-primary" />
        <span className="text-sm font-medium text-rd-text">会话分支</span>
        <span className="ml-auto text-xs text-rd-textMuted">
          {tree.nodes.length} 节点
        </span>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-1.5 border-b border-rd-border px-3 py-2">
        <Search size={12} className="shrink-0 text-rd-textSubtle" />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterOption)}
          className="min-w-0 flex-1 rounded-md border border-rd-border bg-rd-surface px-2 py-1 text-xs text-rd-text focus:outline-none focus:border-rd-primary"
        >
          {Object.entries(FILTER_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* 分支切换栏（仅多分支时显示） */}
      {showBranchBar && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-rd-border px-3 py-1.5">
          {branches.map((branch) => {
            const isActive = branch.id === tree.activeBranchKey;
            return (
              <button
                key={branch.id}
                type="button"
                onClick={() => onNodeClick?.(branch.leafId)}
                title={branch.label || '未命名分支'}
                className={[
                  'shrink-0 rounded-full px-2 py-0.5 text-[11px] transition',
                  isActive
                    ? 'bg-rd-primary text-rd-primaryForeground'
                    : 'bg-rd-surfaceHover text-rd-textSubtle hover:text-rd-text',
                ].join(' ')}
              >
                {branch.label || '未命名'}
              </button>
            );
          })}
        </div>
      )}

      {/* 树视图（可滚动） */}
      <div className="flex-1 overflow-y-auto py-1">
        <SessionTreeNode
          node={root}
          nodes={nodesMap}
          activeNodeId={tree.activeBranchId}
          filteredRoles={filteredRoles}
          depth={0}
          onNodeClick={onNodeClick}
          onFork={onFork}
        />
      </div>
    </div>
  );
}
