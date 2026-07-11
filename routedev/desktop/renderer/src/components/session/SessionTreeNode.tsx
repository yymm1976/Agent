// desktop/renderer/src/components/session/SessionTreeNode.tsx
// Phase 84 Task 3：会话树单个节点组件
//
// 渲染单个 SessionNode：角色图标 + 消息摘要 + 折叠/展开 + fork 按钮。
// 通过递归自身渲染子节点，形成树形结构。
// 根节点（parentId 为 null 的 system 节点）不显示内容，仅作为树根渲染子节点。

import { useState, memo } from 'react';
import {
  ChevronRight, ChevronDown, User, Sparkles, Wrench, Info, GitFork,
} from 'lucide-react';
import type { SessionNode } from '../../../../../src/session/session-node.js';

/** 从 content（unknown 类型）中安全提取文本摘要 */
function extractSummary(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    // 数组：尝试拼接字符串元素
    const texts = content
      .map((item) => (typeof item === 'string' ? item : ''))
      .filter(Boolean);
    if (texts.length > 0) return texts.join(' ');
    return '';
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    // 尝试常见文本字段
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.message === 'string') return obj.message;
    // 回退到 JSON 字符串
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return '';
}

/** 角色配置：图标 + 颜色 + 中文标签 */
const ROLE_CONFIG: Record<
  SessionNode['role'],
  { icon: typeof User; color: string; label: string }
> = {
  user: { icon: User, color: 'text-rd-primary', label: '用户' },
  assistant: { icon: Sparkles, color: 'text-rd-success', label: '助手' },
  toolResult: { icon: Wrench, color: 'text-rd-warning', label: '工具' },
  system: { icon: Info, color: 'text-rd-textMuted', label: '系统' },
};

export interface SessionTreeNodeProps {
  /** 当前节点 */
  node: SessionNode;
  /** 全部节点 Map（用于查找子节点） */
  nodes: Map<string, SessionNode>;
  /** 当前活跃节点 ID（高亮标记） */
  activeNodeId?: string;
  /** 筛选的角色集合；为空或 undefined 表示不筛选 */
  filteredRoles?: Set<SessionNode['role']>;
  /** 当前缩进深度（根节点为 0） */
  depth: number;
  /** 点击节点回调 */
  onNodeClick?: (nodeId: string) => void;
  /** fork 按钮回调 */
  onFork?: (nodeId: string) => void;
}

function SessionTreeNodeImpl({
  node,
  nodes,
  activeNodeId,
  filteredRoles,
  depth,
  onNodeClick,
  onFork,
}: SessionTreeNodeProps) {
  const [collapsed, setCollapsed] = useState(false);

  // 查找子节点（过滤掉不存在的 ID，防御性编程）
  const children = node.children
    .map((cid) => nodes.get(cid))
    .filter((n): n is SessionNode => n !== undefined);

  const isActive = node.id === activeNodeId;
  const roleConfig = ROLE_CONFIG[node.role] ?? ROLE_CONFIG.system;
  const Icon = roleConfig.icon;

  // 筛选时：当前节点角色不在筛选集合中，降低对比度（保留树结构可见性）
  const isFilteredOut =
    !!filteredRoles && filteredRoles.size > 0 && !filteredRoles.has(node.role);

  // 根节点（parentId 为 null）不显示自身内容，仅渲染子节点
  const isRoot = node.parentId === null;
  if (isRoot) {
    return (
      <>
        {children.map((child) => (
          <SessionTreeNodeImpl
            key={child.id}
            node={child}
            nodes={nodes}
            activeNodeId={activeNodeId}
            filteredRoles={filteredRoles}
            depth={depth}
            onNodeClick={onNodeClick}
            onFork={onFork}
          />
        ))}
      </>
    );
  }

  // 摘要文本（截断前 50 字符）
  const rawSummary = extractSummary(node.content);
  const truncated =
    rawSummary.length > 50 ? rawSummary.slice(0, 50) + '…' : rawSummary;
  const displayText = truncated || `<${roleConfig.label}>`;

  return (
    <div>
      <div
        className={[
          'group flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 transition',
          isActive ? 'bg-rd-primary/10' : 'hover:bg-rd-surfaceHover',
          isFilteredOut ? 'opacity-40' : '',
        ].join(' ')}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={() => onNodeClick?.(node.id)}
      >
        {/* 折叠/展开按钮（无子节点时占位） */}
        {children.length > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed(!collapsed);
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-rd-textSubtle hover:text-rd-text"
            aria-label={collapsed ? '展开' : '折叠'}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}

        {/* 角色图标 */}
        <Icon size={14} className={`shrink-0 ${roleConfig.color}`} />

        {/* 摘要文本 */}
        <span
          className={[
            'min-w-0 flex-1 truncate text-xs',
            isActive ? 'font-medium text-rd-primary' : 'text-rd-text',
          ].join(' ')}
          title={rawSummary || roleConfig.label}
        >
          {displayText}
        </span>

        {/* fork 按钮（hover 时显示） */}
        {onFork && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onFork(node.id);
            }}
            title="从此处分叉新分支"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-rd-textSubtle opacity-0 transition hover:bg-rd-surfaceHighlight hover:text-rd-text group-hover:opacity-100"
          >
            <GitFork size={12} />
          </button>
        )}
      </div>

      {/* 子节点（折叠时不渲染） */}
      {!collapsed && children.length > 0 && (
        <div>
          {children.map((child) => (
            <SessionTreeNodeImpl
              key={child.id}
              node={child}
              nodes={nodes}
              activeNodeId={activeNodeId}
              filteredRoles={filteredRoles}
              depth={depth + 1}
              onNodeClick={onNodeClick}
              onFork={onFork}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 用 React.memo 包装，避免父组件（SessionTreePanel）重渲染时触发无变更节点的重渲染
export const SessionTreeNode = memo(SessionTreeNodeImpl);
