// desktop/renderer/src/components/TaskMonitorPanel.tsx
// 右侧任务监控面板：从消息流中实时提取待办项、产物、上下文
// 数据来源：当前对话的 ChatMessage[]

import { useEffect, useMemo, useState, memo } from 'react';
import {
  PanelRightClose, CheckSquare, Database, Check, Loader2,
  ChevronDown, ChevronRight, Archive, AlertCircle,
} from 'lucide-react';
import { useRouteDevStore, type ChatMessage } from '../store/useRouteDevStore.js';

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
export function rebuildTodosFromToolCalls(messages: ChatMessage[]): { id?: string; text: string; done: boolean; status?: string; priority?: string }[] {
  const items: Map<string, { id: string; text: string; done: boolean; status: string; priority: string }> = new Map();

  for (const msg of messages) {
    if (msg.role !== 'system' || msg.toolName !== 'todo_write' || !msg.toolArgs) continue;
    // 失败调用只用于错误展示，不能改变右栏状态，更不能用请求参数制造幽灵待办。
    if (msg.toolStatus === 'error') continue;
    const args = msg.toolArgs;
    const action = args.action as string;
    const result = msg.toolResult as Record<string, unknown> | undefined;

    const arrayTodos = args.todos as Array<Record<string, unknown>> | undefined;
    const replaceItems = (result?.metadata as Record<string, unknown> | undefined)?.items as Array<Record<string, unknown>> | undefined;
    const snapshotItems = action === 'replace' && Array.isArray(replaceItems) ? replaceItems : arrayTodos;
    if (Array.isArray(snapshotItems)) {
      if (action === 'replace') items.clear();
      for (const item of snapshotItems) {
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
        const metadata = result?.metadata as Record<string, unknown> | undefined;
        const item = metadata?.item as Record<string, unknown> | undefined;
        if (item) {
          const id = String(item.id);
          const requestedId = String(args.id ?? '');
          const existing = items.get(id) ?? items.get(requestedId);
          if (requestedId && requestedId !== id) items.delete(requestedId);
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
        }
        break;
      }
      case 'delete': {
        const metadata = result?.metadata as Record<string, unknown> | undefined;
        const id = String(metadata?.deletedId ?? args.id ?? '');
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

export const TaskMonitorPanel = memo(function TaskMonitorPanel({ messages, onCollapse, maxTokens = 128000 }: TaskMonitorPanelProps) {
  const [completedExpanded, setCompletedExpanded] = useState(false);

  const data = useMemo(() => {
    const todos = extractTodos(messages);
    const context = computeContextTokens(messages);
    return { todos, context };
  }, [messages]);

  const activeTodos = data.todos
    .filter((todo) => !todo.done)
    .sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'));
  const completedTodos = data.todos.filter((todo) => todo.done);

  const renderTodo = (
    todo: { id?: string; text: string; done: boolean; status?: string },
    idx: number,
  ) => {
    const isInProgress = todo.status === 'in_progress';
    return (
      <li
        key={todo.id ?? idx}
        className={[
          'flex min-h-9 items-start gap-2.5 rounded-md px-1.5 py-2 text-sm leading-5',
          isInProgress ? 'bg-rd-primary/5 text-rd-text' : 'text-rd-textMuted',
        ].join(' ')}
      >
        <span
          className={[
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-all',
            todo.done
              ? 'border-rd-success text-rd-success'
              : isInProgress
                ? 'border-rd-primary text-rd-primary'
                : 'border-rd-textSubtle',
          ].join(' ')}
        >
          {todo.done && <Check size={11} strokeWidth={2.5} />}
          {isInProgress && !todo.done && <Loader2 size={10} className="animate-spin" />}
        </span>
        <span className={todo.done ? 'flex-1 text-rd-textSubtle line-through' : 'flex-1'}>
          {todo.text}
        </span>
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col bg-rd-surface">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <CheckSquare size={15} className="text-rd-textMuted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-rd-text">任务摘要</span>
            {data.todos.length > 0 && (
              <span className="text-xs tabular-nums text-rd-textSubtle">
                {completedTodos.length}/{data.todos.length}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          title="收起任务摘要"
          aria-label="收起任务摘要"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-rd-textMuted transition hover:bg-rd-surfaceHover hover:text-rd-text"
        >
          <PanelRightClose size={16} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
        <section className="min-h-0 flex-1 overflow-y-auto px-1 pt-2" aria-label="当前对话待办">
          <div className="mb-2 flex items-center justify-between px-1.5 text-xs text-rd-textSubtle">
            <span>待办</span>
            {activeTodos.length > 0 && <span>{activeTodos.length} 项进行中</span>}
          </div>
          {data.todos.length === 0 ? (
            <p className="px-1.5 py-2 text-xs leading-5 text-rd-textSubtle">
              本轮尚未生成待办，模型开始规划后会在这里更新。
            </p>
          ) : (
            <>
              {activeTodos.length > 0 && <ul>{activeTodos.map(renderTodo)}</ul>}
              {completedTodos.length > 0 && (
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setCompletedExpanded((value) => !value)}
                    className="flex h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
                  >
                    {completedExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span>已完成 {completedTodos.length} 项</span>
                  </button>
                  {completedExpanded && <ul>{completedTodos.map(renderTodo)}</ul>}
                </div>
              )}
            </>
          )}
        </section>

        <ContextSection
          breakdown={data.context}
          maxTokens={maxTokens}
          messageCount={messages.length}
        />
      </div>
    </div>
  );
});

interface CompactCommandResult {
  ok?: boolean;
  message?: string;
  compaction?: {
    tokensBefore: number;
    tokensAfter: number;
    messagesCompressed: number;
    offloadedOutputs: number;
  };
}

function ContextSection({ breakdown, maxTokens, messageCount }: {
  breakdown: ContextTokenBreakdown;
  maxTokens: number;
  messageCount: number;
}) {
  const { system, user, assistant, toolCalls, toolResults, total } = breakdown;
  const isProcessing = useRouteDevStore((s) => s.isProcessing);
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [feedback, setFeedback] = useState('');
  const [effectiveTotal, setEffectiveTotal] = useState<number | null>(null);

  useEffect(() => {
    setEffectiveTotal(null);
    setStatus('idle');
    setFeedback('');
  }, [total, messageCount]);

  const segments = [
    { label: '系统', tokens: system, color: 'bg-blue-400' },
    { label: '用户', tokens: user, color: 'bg-emerald-400' },
    { label: '模型', tokens: assistant, color: 'bg-violet-400' },
    { label: '工具', tokens: toolCalls + toolResults, color: 'bg-amber-400' },
  ].filter((segment) => segment.tokens > 0);

  const displayedTotal = effectiveTotal ?? total;
  const totalPercent = maxTokens > 0 ? Math.min((displayedTotal / maxTokens) * 100, 100) : 0;
  const formatNum = (n: number) => n.toLocaleString();
  const tooShort = messageCount <= 4;
  const disabled = isProcessing || status === 'running' || tooShort;

  const handleCompact = async () => {
    setStatus('running');
    setFeedback('正在压缩上下文…');
    try {
      const result = await window.routedev.command.execute({ text: '/compact' }) as CompactCommandResult;
      if (!result?.ok) throw new Error(result?.message || '上下文压缩失败');
      if (result.compaction) setEffectiveTotal(result.compaction.tokensAfter);
      setStatus('success');
      setFeedback(result.message || '上下文压缩完成');
    } catch (error) {
      setStatus('error');
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="mt-3 shrink-0 rounded-lg bg-rd-background/45 p-3" aria-label="上下文占用">
      <div className="flex items-center gap-2">
        <Database size={14} className="text-rd-textMuted" />
        <span className="flex-1 text-xs font-semibold text-rd-text">上下文</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void handleCompact()}
          title={tooShort ? '至少需要 5 条对话消息才能压缩' : '立即压缩当前模型上下文'}
          className={[
            'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition',
            disabled
              ? 'cursor-not-allowed text-rd-textSubtle'
              : 'bg-rd-surfaceHover text-rd-text hover:bg-rd-surfaceHighlight',
          ].join(' ')}
        >
          {status === 'running' ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
          <span>{status === 'running' ? '压缩中' : '压缩'}</span>
        </button>
      </div>

      {total === 0 ? (
        <p className="mt-3 text-xs text-rd-textSubtle">对话开始后显示上下文占用。</p>
      ) : (
        <>
          <div className="mt-3 flex items-end justify-between">
            <span className="text-xl font-semibold tabular-nums text-rd-text">{Math.round(totalPercent)}%</span>
            <span className="text-xs tabular-nums text-rd-textSubtle">
              {formatNum(displayedTotal)} / {formatNum(maxTokens)}
            </span>
          </div>
          <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-rd-surfaceHover">
            {segments.map((segment) => {
              const share = total > 0 ? segment.tokens / total : 0;
              const width = maxTokens > 0 ? Math.min((share * displayedTotal / maxTokens) * 100, 100) : 0;
              return <span key={segment.label} className={segment.color} style={{ width: `${width}%` }} />;
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {segments.map((segment) => (
              <div key={segment.label} className="flex min-w-0 items-center gap-1.5 text-[11px] text-rd-textSubtle">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${segment.color}`} />
                <span className="truncate">{segment.label}</span>
                <span className="ml-auto tabular-nums">{formatNum(segment.tokens)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {feedback && (
        <div
          className={[
            'mt-2 flex items-start gap-1.5 text-[11px] leading-4',
            status === 'error' ? 'text-rd-danger' : 'text-rd-textSubtle',
          ].join(' ')}
          role={status === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {status === 'error' && <AlertCircle size={12} className="mt-0.5 shrink-0" />}
          <span>{feedback}</span>
        </div>
      )}
    </section>
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
