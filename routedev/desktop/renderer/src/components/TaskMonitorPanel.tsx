// desktop/renderer/src/components/TaskMonitorPanel.tsx
// 右侧任务监控面板：从消息流中实时提取待办项、产物、上下文
// 数据来源：当前对话的 ChatMessage[]

import { useMemo, useState } from 'react';
import {
  PanelRightClose, CheckSquare, FileOutput, Database, Check, Loader2,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import type { ChatMessage } from '../store/useRouteDevStore.js';

interface TaskMonitorPanelProps {
  messages: ChatMessage[];
  onCollapse: () => void;
  /** 模型上下文 token 上限，默认 128K */
  maxTokens?: number;
}

// 中文感知的 Token 估算（renderer 进程内联实现，避免跨进程导入 src/）
// - CJK 字符：每字约 1.5 token
// - 其他字符：每 4 字符约 1 token
function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.5 + other / 4);
}

// 从消息流中提取待办项：
// 1. 优先从 todo_write 工具调用的结果中提取（实时准确）
// 2. 回退到从 assistant 消息内容中匹配 - [ ] / - [x] 格式（兼容旧消息）
function extractTodos(messages: ChatMessage[]): { id?: string; text: string; done: boolean; status?: string; priority?: string }[] {
  // 方式1：从 todo_write 工具调用结果中重建待办列表
  const todosFromTool = rebuildTodosFromToolCalls(messages);
  if (todosFromTool.length > 0) return todosFromTool;

  // 方式2：从最后一条包含待办格式的 assistant 消息中提取（覆盖式更新，不累积旧消息）
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.content) continue;
    const lines = msg.content.split('\n');
    const msgTodos: { id?: string; text: string; done: boolean; status?: string; priority?: string }[] = [];
    for (const line of lines) {
      const match = line.match(/^\s*-\s*\[([x ])\]\s*(.+)/i);
      if (match) {
        msgTodos.push({ text: match[2].trim(), done: match[1].toLowerCase() === 'x' });
      }
    }
    if (msgTodos.length > 0) return msgTodos;
  }
  return [];
}

/**
 * 从 todo_write 工具调用历史中重建当前待办列表
 * 按 add/update/delete/clear 操作顺序回放，得到最终状态
 */
function rebuildTodosFromToolCalls(messages: ChatMessage[]): { id?: string; text: string; done: boolean; status?: string; priority?: string }[] {
  const items: Map<string, { id: string; text: string; done: boolean; status: string; priority: string }> = new Map();

  for (const msg of messages) {
    if (msg.role !== 'system' || msg.toolName !== 'todo_write' || !msg.toolArgs) continue;
    const args = msg.toolArgs;
    const action = args.action as string;
    const result = msg.toolResult as Record<string, unknown> | undefined;

    const arrayTodos = args.todos as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(arrayTodos)) {
      for (const item of arrayTodos) {
        const id = String(item.id ?? item.content ?? items.size);
        const content = String(item.content ?? '');
        if (!content) continue;
        const status = String(item.status ?? 'pending');
        const priority = String(item.priority ?? 'medium');
        items.set(id, {
          id,
          text: content,
          done: status === 'completed',
          status,
          priority,
        });
      }
      continue;
    }

    switch (action) {
      case 'add': {
        // 从结果 metadata.item 获取（包含生成的 id）
        const metadata = result?.metadata as Record<string, unknown> | undefined;
        const item = metadata?.item as Record<string, unknown> | undefined;
        if (item) {
          const id = item.id as string;
          const content = item.content as string;
          const status = item.status as string;
          const priority = item.priority as string;
          items.set(id, {
            id,
            text: content,
            done: status === 'completed',
            status,
            priority,
          });
        } else {
          const output = typeof msg.toolResult === 'string'
            ? msg.toolResult
            : typeof (msg.toolResult as Record<string, unknown> | undefined)?.output === 'string'
              ? String((msg.toolResult as Record<string, unknown>).output)
              : '';
          const idMatch = output.match(/\[(todo-[^\]]+)\]/);
          const id = idMatch?.[1] ?? `todo-${items.size + 1}`;
          const content = typeof args.content === 'string' ? args.content : '';
          if (content) {
            const priority = typeof args.priority === 'string' ? args.priority : 'medium';
            items.set(id, {
              id,
              text: content,
              done: false,
              status: 'pending',
              priority,
            });
          }
        }
        break;
      }
      case 'update': {
        const id = args.id as string;
        const metadata = result?.metadata as Record<string, unknown> | undefined;
        const item = metadata?.item as Record<string, unknown> | undefined;
        if (item) {
          const existing = items.get(id);
          const content = (item.content as string) || existing?.text || (args.content as string) || id;
          const status = (item.status as string) || (args.status as string) || existing?.status || 'pending';
          const priority = (item.priority as string) || (args.priority as string) || existing?.priority || 'medium';
          items.set(id, {
            id,
            text: content,
            status,
            priority,
            done: status === 'completed',
          });
        } else if (args.status || args.content || args.priority) {
          const existing = items.get(id);
          const status = (args.status as string) || existing?.status || 'pending';
          items.set(id, {
            id,
            text: (args.content as string) || existing?.text || id,
            status,
            priority: (args.priority as string) || existing?.priority || 'medium',
            done: status === 'completed',
          });
        }
        break;
      }
      case 'delete': {
        const id = args.id as string;
        items.delete(id);
        break;
      }
      case 'clear': {
        items.clear();
        break;
      }
      case 'list': {
        const snapshot = result?.metadata as Record<string, unknown> | undefined;
        const snapshotItems = snapshot?.items as Array<Record<string, unknown>> | undefined;
        if (snapshotItems) {
          items.clear();
          for (const item of snapshotItems) {
            const id = item.id as string;
            const content = item.content as string;
            const status = item.status as string;
            const priority = item.priority as string;
            items.set(id, {
              id,
              text: content,
              done: status === 'completed',
              status,
              priority,
            });
          }
        }
        break;
      }
    }
  }

  return Array.from(items.values());
}

// 从工具调用中提取产物（文件路径）
function extractArtifacts(messages: ChatMessage[]): string[] {
  const artifacts: string[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'system' || !msg.toolName || !msg.toolArgs) continue;
    if (!['file_write', 'file_edit'].includes(msg.toolName)) continue;
    // 从工具参数中提取文件路径
    const args = msg.toolArgs;
    const pathKeys = ['filePath', 'path', 'file', 'filename', 'outputPath'];
    for (const key of pathKeys) {
      const val = args[key];
      if (typeof val === 'string' && val.length > 0 && !seen.has(val)) {
        seen.add(val);
        artifacts.push(val);
        break;
      }
    }
  }
  return artifacts;
}

// 上下文 token 分类统计
interface ContextTokenBreakdown {
  system: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  total: number;
}

// 从消息流计算各类 token 占用
// - 系统提示词：role==='system' 且无 toolName 的消息内容
// - 用户消息：role==='user' 的消息内容
// - 助手消息：role==='assistant' 的消息内容（含 reasoning）
// - 工具调用：system 消息中 toolName 的 toolArgs
// - 工具结果：system 消息中 toolName 的 toolResult
function computeContextTokens(messages: ChatMessage[]): ContextTokenBreakdown {
  let system = 0;
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  let toolResults = 0;

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.toolName) {
        // 工具调用参数
        if (msg.toolArgs) {
          toolCalls += estimateTokens(JSON.stringify(msg.toolArgs));
        }
        // 工具调用结果
        if (msg.toolResult !== undefined && msg.toolResult !== null) {
          const resultText = typeof msg.toolResult === 'string'
            ? msg.toolResult
            : JSON.stringify(msg.toolResult);
          toolResults += estimateTokens(resultText);
        }
      } else {
        // 系统提示词
        system += estimateTokens(msg.content);
      }
    } else if (msg.role === 'user') {
      user += estimateTokens(msg.content);
    } else if (msg.role === 'assistant') {
      assistant += estimateTokens(msg.content);
      if (msg.reasoning) {
        assistant += estimateTokens(msg.reasoning);
      }
    }
  }

  const total = system + user + assistant + toolCalls + toolResults;
  return { system, user, assistant, toolCalls, toolResults, total };
}

type TabKey = 'tasks' | 'context' | 'artifacts';

export function TaskMonitorPanel({ messages, onCollapse, maxTokens = 128000 }: TaskMonitorPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('tasks');

  // 从消息流中提取各类数据
  const data = useMemo(() => {
    const todos = extractTodos(messages);
    const artifacts = extractArtifacts(messages);
    const context = computeContextTokens(messages);
    return { todos, artifacts, context };
  }, [messages]);

  const tabs: { key: TabKey; label: string; icon: React.ReactNode; count: number }[] = [
    { key: 'tasks', label: '任务', icon: <CheckSquare size={14} />, count: data.todos.length + data.artifacts.length },
    { key: 'artifacts', label: '产物', icon: <FileOutput size={14} />, count: data.artifacts.length },
    { key: 'context', label: '上下文', icon: <Database size={14} />, count: 0 },
  ];
  const activeIndex = tabs.findIndex((tab) => tab.key === activeTab);
  const active = tabs[activeIndex] ?? tabs[0];
  const goPrev = () => setActiveTab(tabs[(activeIndex - 1 + tabs.length) % tabs.length].key);
  const goNext = () => setActiveTab(tabs[(activeIndex + 1) % tabs.length].key);

  return (
    <div className="flex h-full flex-col bg-rd-surface">
      {/* 顶部标题栏 */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span className="flex-1 text-sm font-semibold text-rd-text">任务监控</span>
        <button
          onClick={onCollapse}
          title="缩进面板"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-rd-textMuted transition hover:bg-rd-surfaceHover hover:text-rd-primary"
        >
          <PanelRightClose size={16} />
        </button>
      </div>

      {/* 左右切换栏：单页展示，避免右栏拥挤 */}
      <div className="mx-3 mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-rd-border bg-rd-surfaceHover p-1.5">
        <button
          type="button"
          onClick={goPrev}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-rd-textMuted transition hover:bg-rd-surface hover:text-rd-text"
          title="上一页"
        >
          <ChevronLeft size={14} />
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-xs font-medium text-rd-text">
          <span className="text-rd-primary">{active.icon}</span>
          <span>{active.label}</span>
          {active.count > 0 && (
            <span className="rounded-full bg-rd-primary px-1.5 py-0.5 text-[10px] text-white">
              {active.count}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={goNext}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-rd-textMuted transition hover:bg-rd-surface hover:text-rd-text"
          title="下一页"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden px-3 pb-3">
        <div className="h-full overflow-y-auto pr-1">
        {/* 任务 Tab：待办 + 产物 */}
        {activeTab === 'tasks' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-rd-border bg-rd-surfaceHover p-2.5">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-rd-text">
                <CheckSquare size={13} className="text-rd-primary" />
                <span>待办</span>
                {data.todos.length > 0 && (
                  <span className="ml-auto text-rd-textSubtle">
                    {data.todos.filter((t) => t.done).length}/{data.todos.length}
                  </span>
                )}
              </div>
              {data.todos.length === 0 ? (
                <p className="py-1.5 text-xs text-rd-textSubtle">暂无待办项</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.todos.map((todo, idx) => {
                    const isInProgress = todo.status === 'in_progress';
                    return (
                      <li
                        key={todo.id ?? idx}
                        className={[
                          'flex items-center gap-2 rounded-lg p-2 text-xs transition-all',
                          todo.done
                            ? 'bg-rd-surface text-rd-text'
                            : isInProgress
                              ? 'border border-rd-primary bg-rd-surfaceHighlight text-rd-text'
                              : 'bg-rd-surface text-rd-textMuted',
                        ].join(' ')}
                      >
                        <span
                          className={[
                            'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border-[1.5px] transition-all',
                            todo.done
                              ? 'border-rd-success bg-rd-success text-white'
                              : isInProgress
                                ? 'border-rd-warning bg-rd-warning/20 text-rd-warning'
                                : 'border-rd-textSubtle',
                          ].join(' ')}
                        >
                          {todo.done && <Check size={10} strokeWidth={3} />}
                          {isInProgress && !todo.done && (
                            <Loader2 size={10} className="animate-spin" />
                          )}
                        </span>
                        <span className="flex-1 break-words">{todo.text}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {data.artifacts.length > 0 && (
              <div className="rounded-xl border border-rd-border bg-rd-surfaceHover p-2.5">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-rd-text">
                  <FileOutput size={13} className="text-rd-primary" />
                  <span>产物</span>
                </div>
                <ul className="space-y-1">
                  {data.artifacts.map((path, idx) => (
                    <li key={idx}>
                      <button
                        type="button"
                        onClick={() => window.routedev.fs.openFolder(path)}
                        className="w-full truncate rounded-md bg-rd-surface px-2 py-1.5 text-left text-xs font-mono text-rd-textMuted transition hover:bg-rd-surfaceHover hover:text-rd-primary"
                        title={path}
                      >
                        {path}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* 上下文 Tab */}
        {activeTab === 'context' && (
          <ContextTab breakdown={data.context} maxTokens={maxTokens} />
        )}

        {/* 产物 Tab */}
        {activeTab === 'artifacts' && (
          <div>
            {data.artifacts.length === 0 ? (
              <p className="py-2 text-xs text-rd-textSubtle">暂无产物</p>
            ) : (
              <ul className="space-y-1">
                {data.artifacts.map((path, idx) => (
                  <li key={idx} className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => window.routedev.fs.openFolder(path)}
                      className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left font-mono text-rd-textMuted transition hover:bg-rd-surfaceHover hover:text-rd-primary"
                      title={path}
                    >
                      {path}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

// 上下文 Tab：水平堆叠柱状图 + 图例
function ContextTab({ breakdown, maxTokens }: {
  breakdown: ContextTokenBreakdown;
  maxTokens: number;
}) {
  const { system, user, assistant, toolCalls, toolResults, total } = breakdown;

  if (total === 0) {
    return <p className="py-2 text-xs text-rd-textSubtle">暂无上下文数据</p>;
  }

  const segments = [
    { label: '系统提示词', tokens: system, color: 'bg-blue-500' },
    { label: '用户消息', tokens: user, color: 'bg-green-500' },
    { label: '助手消息', tokens: assistant, color: 'bg-purple-500' },
    { label: '工具调用', tokens: toolCalls, color: 'bg-orange-500' },
    { label: '工具结果', tokens: toolResults, color: 'bg-pink-500' },
  ];

  const totalPercent = maxTokens > 0 ? Math.min((total / maxTokens) * 100, 100) : 0;
  const formatNum = (n: number) => n.toLocaleString();

  return (
    <div className="space-y-3">
      {/* 柱状图区 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-rd-text">上下文占用</span>
          <span className="font-medium text-rd-text">{Math.round(totalPercent)}%</span>
        </div>
        {/* 水平堆叠柱状图 */}
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-rd-border/30">
          {segments.map((seg, idx) => {
            const pct = maxTokens > 0 ? (seg.tokens / maxTokens) * 100 : 0;
            if (pct <= 0) return null;
            return (
              <div
                key={idx}
                className={`${seg.color} h-full`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            );
          })}
        </div>
        <div className="text-xs text-rd-textSubtle">
          模型限制: {(maxTokens / 1000).toFixed(0)}K tokens
        </div>
      </div>

      {/* 图例列表 */}
      <div className="space-y-1.5 text-xs">
        {segments.map((seg, idx) => {
          const pct = maxTokens > 0 ? (seg.tokens / maxTokens) * 100 : 0;
          return (
            <div key={idx} className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${seg.color}`} />
              <span className="flex-1 text-rd-textMuted">{seg.label}</span>
              <span className="font-medium text-rd-text">{formatNum(seg.tokens)}</span>
              <span className="w-10 text-right text-rd-textSubtle">{pct.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>

      {/* 总计 */}
      <div className="space-y-1.5 border-t border-rd-border/30 pt-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-rd-textMuted">总计</span>
          <span className="font-medium text-rd-text">{formatNum(total)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-rd-textMuted">模型限制</span>
          <span className="font-medium text-rd-text">{formatNum(maxTokens)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * 判断消息流中是否有任务监控内容（用于决定右侧面板是否自动呼出）
 */
export function hasTaskContent(messages: ChatMessage[]): boolean {
  if (messages.length === 0) return false;
  // 有以下任一情况即认为有任务监控内容：
  // 1. 有待办项（todo_write 工具调用或 assistant 消息中的 - [ ] 格式）
  // 2. 有产物（工具调用中提取到文件路径）
  const todos = extractTodos(messages);
  const artifacts = extractArtifacts(messages);
  return todos.length > 0 || artifacts.length > 0;
}
