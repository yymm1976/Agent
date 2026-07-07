// desktop/renderer/src/components/SearchCommandPalette.tsx
// Phase 74-H2：跨对话搜索命令面板
// ⌘K/Ctrl+K 触发，居中弹窗 + 遮罩
// 搜索范围：所有项目的所有对话（title + messages.content）
// 交互：上下箭头选择 + Enter 跳转 + ESC 关闭 + 点击外部关闭
// 保留现有弱边框美学：border-rd-border + bg-rd-surface + shadow-rdLg

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Search, MessageSquare, FileText, CornerDownLeft } from 'lucide-react';
import { useProjectsStore } from '../store/useProjectsStore.js';

export interface SearchCommandPaletteProps {
  /** 受控开关状态 */
  open: boolean;
  /** 关闭回调（ESC / 点击外部 / 选中后） */
  onClose: () => void;
  /** 选中结果后跳转：切换到对应项目 + 对话 */
  onNavigate: (projectId: string, conversationId: string) => void;
}

/** 单条搜索结果 */
interface SearchResult {
  /** 对话 ID */
  convId: string;
  /** 项目 ID */
  projectId: string;
  /** 项目名 */
  projectName: string;
  /** 对话标题 */
  convTitle: string;
  /** 匹配类型：title 标题匹配 / content 消息内容匹配 */
  matchType: 'title' | 'content';
  /** 匹配的文本片段（消息内容匹配时为消息片段） */
  snippet: string;
  /** 消息总数 */
  messageCount: number;
  /** 最后更新时间 */
  updatedAt: number;
}

export function SearchCommandPalette({ open, onClose, onNavigate }: SearchCommandPaletteProps) {
  const projects = useProjectsStore((s) => s.projects);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // open 时聚焦输入框 + 重置状态
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // 延迟一帧聚焦，确保 DOM 已渲染
      const timer = setTimeout(() => inputRef.current?.focus(), 16);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // 搜索逻辑：遍历所有项目所有对话，匹配 title + messages.content
  const results = useMemo<SearchResult[]>(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const out: SearchResult[] = [];
    for (const project of projects) {
      for (const conv of project.conversations) {
        // 1. 标题匹配
        if (conv.title.toLowerCase().includes(q)) {
          out.push({
            convId: conv.id,
            projectId: project.id,
            projectName: project.name,
            convTitle: conv.title,
            matchType: 'title',
            snippet: '',
            messageCount: conv.messages.length,
            updatedAt: conv.updatedAt,
          });
          continue; // 标题匹配优先，跳过内容匹配
        }
        // 2. 消息内容匹配（找第一条匹配的消息作为 snippet）
        for (const msg of conv.messages) {
          if (msg.content && msg.content.toLowerCase().includes(q)) {
            // 截取匹配点前后 40 字符作为 snippet
            const idx = msg.content.toLowerCase().indexOf(q);
            const start = Math.max(0, idx - 20);
            const end = Math.min(msg.content.length, idx + q.length + 20);
            const snippet = (start > 0 ? '...' : '') + msg.content.slice(start, end) + (end < msg.content.length ? '...' : '');
            out.push({
              convId: conv.id,
              projectId: project.id,
              projectName: project.name,
              convTitle: conv.title,
              matchType: 'content',
              snippet,
              messageCount: conv.messages.length,
              updatedAt: conv.updatedAt,
            });
            break; // 每个对话只取第一条匹配
          }
        }
      }
    }
    // 按更新时间倒序（最近修改的在前）
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20); // 最多 20 条
  }, [query, projects]);

  // activeIndex 越界保护
  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(0);
  }, [results.length, activeIndex]);

  // 选中项滚动到可视区
  useEffect(() => {
    if (!open || !listRef.current) return;
    const active = listRef.current.querySelector('[data-active="true"]');
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  // 键盘导航：↑↓ 选择 / Enter 跳转 / ESC 关闭
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % Math.max(results.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + results.length) % Math.max(results.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[activeIndex];
      if (item) {
        onNavigate(item.projectId, item.convId);
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [results, activeIndex, onNavigate, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center bg-rd-background/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        // 点击遮罩关闭
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="跨对话搜索命令面板"
        className="mt-[15vh] w-[560px] max-w-[90vw] overflow-hidden rounded-rdLg border border-rd-border bg-rd-surface shadow-rdLg"
        onKeyDown={handleKeyDown}
      >
        {/* 搜索输入框 */}
        <div className="flex items-center gap-2.5 border-b border-rd-border/50 px-4 py-3">
          <Search size={16} className="shrink-0 text-rd-textSubtle" />
          <input
            ref={inputRef}
            type="search"
            role="searchbox"
            aria-label="搜索对话"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls="search-results-listbox"
            aria-activedescendant={results.length > 0 ? `search-result-${activeIndex}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder="搜索对话标题或消息内容..."
            className="min-w-0 flex-1 bg-transparent text-sm text-rd-text outline-none placeholder:text-rd-textSubtle"
          />
          <kbd className="shrink-0 rounded border border-rd-border bg-rd-background px-1.5 py-0.5 text-[10px] text-rd-textSubtle">
            ESC
          </kbd>
        </div>

        {/* 搜索结果列表（74-I6：role=listbox + aria-label） */}
        <div
          ref={listRef}
          role="listbox"
          id="search-results-listbox"
          aria-label="搜索结果"
          className="max-h-[50vh] overflow-y-auto p-1.5"
        >
          {query.trim() === '' ? (
            <div className="px-4 py-8 text-center text-xs text-rd-textSubtle">
              输入关键词搜索所有对话
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-rd-textSubtle">
              未找到匹配「{query}」的对话
            </div>
          ) : (
            results.map((item, idx) => {
              const active = idx === activeIndex;
              return (
                <button
                  key={`${item.projectId}-${item.convId}`}
                  type="button"
                  role="option"
                  id={`search-result-${idx}`}
                  aria-selected={active}
                  data-active={active}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => {
                    onNavigate(item.projectId, item.convId);
                    onClose();
                  }}
                  className={[
                    'flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left transition',
                    active ? 'bg-rd-primary/10' : 'hover:bg-rd-surfaceHover',
                  ].join(' ')}
                >
                  {/* 匹配类型图标 */}
                  {item.matchType === 'title' ? (
                    <MessageSquare size={14} className={`mt-0.5 shrink-0 ${active ? 'text-rd-primary' : 'text-rd-textSubtle'}`} />
                  ) : (
                    <FileText size={14} className={`mt-0.5 shrink-0 ${active ? 'text-rd-primary' : 'text-rd-textSubtle'}`} />
                  )}
                  <div className="min-w-0 flex-1">
                    {/* 对话标题 */}
                    <div className={`truncate text-xs font-medium ${active ? 'text-rd-primary' : 'text-rd-text'}`}>
                      {item.convTitle}
                    </div>
                    {/* 匹配片段 / 来源 */}
                    {item.snippet ? (
                      <div className="mt-0.5 truncate text-[11px] text-rd-textSubtle">
                        {item.snippet}
                      </div>
                    ) : null}
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-rd-textSubtle">
                      <span>{item.projectName}</span>
                      <span>·</span>
                      <span>{item.messageCount} 条消息</span>
                    </div>
                  </div>
                  {/* active 时显示 Enter 提示 */}
                  {active && (
                    <CornerDownLeft size={12} className="mt-0.5 shrink-0 text-rd-primary" />
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* 底部快捷键提示 */}
        <div className="flex items-center gap-4 border-t border-rd-border/50 px-4 py-2 text-[10px] text-rd-textSubtle">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-rd-border bg-rd-background px-1">↑</kbd>
            <kbd className="rounded border border-rd-border bg-rd-background px-1">↓</kbd>
            选择
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-rd-border bg-rd-background px-1">Enter</kbd>
            跳转
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-rd-border bg-rd-background px-1">ESC</kbd>
            关闭
          </span>
          <span className="ml-auto">{results.length > 0 && `${results.length} 个结果`}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
