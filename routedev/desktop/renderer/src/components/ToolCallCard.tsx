// desktop/renderer/src/components/ToolCallCard.tsx
// Phase 74-A：工具调用展示——Hybrid 风格（折叠态 Card + 展开态 Terminal）
// 保留现有弱边框美学；增强项：A1 ANSI / A2 头尾保留 / A3 行级 diff / A4 accept-reject /
//   A5 StatusBadge / A6 关键参数预览 / A7 ToolIcon 着色 / A8 shimmer 边框

import { useState, useMemo, memo } from 'react';
import {
  Loader2, CheckCircle, XCircle, Wrench, FileText, FolderSearch, FileEdit, FilePlus,
  Terminal, Search, ListChecks, Bot, ChevronDown, ChevronRight,
} from 'lucide-react';
import { StatusBadge } from './ui/status-badge';
import { ToolIcon, type ToolType } from './ui/tool-icon';
import { ansiToHtml, splitHeadTail } from './tool/ansi-renderer';
import { computeLineDiff, summarizeDiff, type DiffLine } from './tool/line-diff';

export type ToolCallStatus = 'running' | 'completed' | 'error';

/** Phase 34：输出样式，控制工具卡片的默认折叠状态和详情显示 */
export type OutputStyle = 'minimal' | 'standard' | 'verbose';

/** 单个工具调用数据 */
export interface ToolCallItem {
  id: string;
  toolName: string;
  status: ToolCallStatus;
  args?: Record<string, unknown>;
  result?: unknown;
  timestamp?: number;
  /** Phase 96 P1-1：运行态实时增量输出（shell_exec 等长任务的 stdout/stderr） */
  deltaBuffer?: string;
}

/** 工具名中文标签映射 */
const TOOL_LABELS: Record<string, string> = {
  file_read: '查看文件',
  list_directory: '列出目录',
  file_write: '写入文件',
  file_edit: '编辑文件',
  shell_exec: '执行命令',
  code_search: '搜索代码',
  file_search: '搜索文件',
  web_search: '网页搜索',
  web_fetch: '获取网页',
  spawn_agent: '子 Agent',
  todo_write: '更新待办',
  notes: '记录笔记',
  repo_map: '仓库地图',
};

/** 工具名 → ToolType 映射（用于 ToolIcon 着色） */
const TOOL_TYPE_MAP: Record<string, ToolType> = {
  file_read: 'file_read',
  list_directory: 'file_read',
  file_write: 'file_write',
  file_edit: 'file_edit',
  shell_exec: 'shell_exec',
  code_search: 'web_search',
  file_search: 'web_search',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  spawn_agent: 'spawn_agent',
  todo_write: 'unknown',
  notes: 'unknown',
  repo_map: 'unknown',
};

/** 旧版图标映射（保留兼容，新代码用 ToolIcon） */
const TOOL_ICONS: Record<string, React.ReactNode> = {
  file_read: <FileText size={13} />,
  list_directory: <FolderSearch size={13} />,
  file_write: <FilePlus size={13} />,
  file_edit: <FileEdit size={13} />,
  shell_exec: <Terminal size={13} />,
  code_search: <Search size={13} />,
  file_search: <Search size={13} />,
  web_search: <Search size={13} />,
  web_fetch: <Search size={13} />,
  spawn_agent: <Bot size={13} />,
  todo_write: <ListChecks size={13} />,
};

/** 获取工具中文标签 */
export function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

/** 获取工具图标（保留兼容） */
export function getToolIcon(toolName: string): React.ReactNode {
  return TOOL_ICONS[toolName] ?? <Wrench size={13} />;
}

/** 获取工具的 ToolType（用于 ToolIcon 着色） */
function getToolType(toolName: string): ToolType {
  return TOOL_TYPE_MAP[toolName] ?? 'unknown';
}

/** 格式化工具结果为字符串 */
function formatResult(val: unknown): string {
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

export function getPathFromArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  return String(args.path || args.filePath || args.file || args.filename || args.outputPath || '');
}

function getResultText(result: unknown): string {
  if (result === undefined || result === null || result === '') return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    const text = obj.output || obj.stdout || obj.stderr || obj.error || obj.message || obj.summary;
    if (typeof text === 'string') return text;
  }
  return formatResult(result);
}

/**
 * 从工具参数中提取动作摘要（用于折叠态一行预览）
 */
export function getToolActionSummary(toolName: string, args?: Record<string, unknown>): string {
  if (!args) return '';
  switch (toolName) {
    case 'file_read': {
      const p = getPathFromArgs(args);
      return p ? `查看 ${p.split(/[\\/]/).pop()}` : '查看文件';
    }
    case 'list_directory': {
      const p = (args.path as string) || (args.directory as string) || '.';
      return `列出 ${p === '.' ? '当前目录' : p.split(/[\\/]/).pop()}`;
    }
    case 'file_write': {
      const p = getPathFromArgs(args);
      return p ? `写入 ${p.split(/[\\/]/).pop()}` : '写入文件';
    }
    case 'file_edit': {
      const p = getPathFromArgs(args);
      return p ? `编辑 ${p.split(/[\\/]/).pop()}` : '编辑文件';
    }
    case 'shell_exec': {
      const cmd = (args.command as string) || '';
      const firstLine = cmd.split('\n')[0];
      return firstLine.length > 60 ? `执行 ${firstLine.slice(0, 60)}...` : `执行 ${firstLine}`;
    }
    case 'code_search':
    case 'file_search': {
      const q = (args.query as string) || (args.pattern as string) || '';
      return q ? `搜索 ${q}` : '搜索';
    }
    case 'web_search': {
      const q = (args.query as string) || '';
      return q ? `搜索 ${q}` : '网页搜索';
    }
    case 'web_fetch': {
      const u = (args.url as string) || '';
      return u ? `获取 ${u}` : '获取网页';
    }
    case 'spawn_agent': {
      const desc = (args.description as string) || (args.task as string) || '';
      return desc ? `子 Agent: ${desc.slice(0, 40)}` : '子 Agent';
    }
    case 'todo_write':
      return '更新待办';
    case 'notes': {
      const t = (args.title as string) || '';
      return t ? `记录 ${t}` : '记录笔记';
    }
    default:
      return '';
  }
}

/**
 * Phase 74-A6：折叠态关键参数预览（独立于 actionSummary，更短）
 * 返回 { key, value } 结构，UI 渲染为 `<key>: <value>` 等宽字体
 */
function getKeyParamPreview(
  toolName: string,
  args?: Record<string, unknown>
): { key: string; value: string } | null {
  if (!args) return null;
  switch (toolName) {
    case 'file_read':
    case 'file_write':
    case 'file_edit':
    case 'list_directory': {
      const p = getPathFromArgs(args);
      return p ? { key: 'path:', value: p } : null;
    }
    case 'shell_exec': {
      const cmd = (args.command as string) || '';
      if (!cmd) return null;
      const firstLine = cmd.split('\n')[0];
      return { key: 'cmd:', value: firstLine.length > 50 ? `${firstLine.slice(0, 50)}...` : firstLine };
    }
    case 'code_search':
    case 'file_search':
    case 'web_search': {
      const q = (args.query as string) || (args.pattern as string) || '';
      return q ? { key: 'q:', value: q } : null;
    }
    case 'web_fetch': {
      const u = (args.url as string) || '';
      return u ? { key: 'url:', value: u } : null;
    }
    case 'spawn_agent': {
      const desc = (args.description as string) || (args.task as string) || '';
      return desc ? { key: 'task:', value: desc.slice(0, 50) } : null;
    }
    default:
      return null;
  }
}

/** 获取工具状态文案 */
function getToolStatusText(toolName: string, status: ToolCallStatus): string {
  const label = TOOL_LABELS[toolName] ?? toolName;
  switch (status) {
    case 'running':
      return `正在${label}`;
    case 'completed':
      return `已${label}`;
    case 'error':
      return `${label}失败`;
  }
}

/** StatusBadge variant 映射（74-A5：复用 E1 StatusBadge） */
function statusToBadgeVariant(status: ToolCallStatus): 'success' | 'error' | 'running' | 'pending' {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'success';
    case 'error':
      return 'error';
  }
}

/** 状态文案 + 可选计数（用于聚合行） */
function getStatusBadgeText(status: ToolCallStatus, toolName: string, count?: number): string {
  if (count !== undefined) {
    return `${count}`;
  }
  return getToolStatusText(toolName, status);
}

/** 旧版状态配置（保留兼容，新代码用 StatusBadge） */
function getStatusConfig(status: ToolCallStatus): {
  icon: React.ReactNode;
  colorClass: string;
} {
  const configs: Record<ToolCallStatus, { icon: React.ReactNode; colorClass: string }> = {
    running: {
      icon: <Loader2 size={12} className="animate-spin" />,
      colorClass: 'text-rd-primary',
    },
    completed: {
      icon: <CheckCircle size={12} />,
      colorClass: 'text-rd-success',
    },
    error: {
      icon: <XCircle size={12} />,
      colorClass: 'text-rd-danger',
    },
  };
  return configs[status];
}

// ============================================================
// Phase 74-A3：行级 diff 视图（带行号 + accept/reject）
// ============================================================

interface FileEditDiffProps {
  args: Record<string, unknown>;
  /** 74-A4：accept/reject 回调（可选，未提供则不显示按钮） */
  onAccept?: () => void;
  onReject?: () => void;
  /** 已应用/已拒绝状态（按钮置灰） */
  applied?: boolean;
  rejected?: boolean;
}

function FileEditDiff({ args, onAccept, onReject, applied, rejected }: FileEditDiffProps) {
  const oldString = (args.oldString as string) || (args.old_string as string) || '';
  const newString = (args.newString as string) || (args.new_string as string) || '';
  const filePath = getPathFromArgs(args);

  // useMemo 避免每次渲染重算 diff
  const diffLines = useMemo(() => computeLineDiff(oldString, newString), [oldString, newString]);
  const summary = useMemo(() => summarizeDiff(diffLines), [diffLines]);

  return (
    <div className="space-y-2">
      {filePath && (
        <div className="flex items-center gap-2 text-xs text-rd-textSubtle">
          <span>{filePath}</span>
          <span className="text-rd-success">+{summary.added}</span>
          <span className="text-rd-danger">-{summary.removed}</span>
        </div>
      )}
      {diffLines.length > 0 && (
        <div className="overflow-hidden rounded-md border border-rd-border bg-rd-background font-mono text-xs">
          {diffLines.map((line, idx) => (
            <DiffLineView key={idx} line={line} />
          ))}
        </div>
      )}
      {/* 74-A4：accept/reject 按钮 */}
      {(onAccept || onReject) && (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onReject}
            disabled={applied || rejected}
            aria-label="拒绝此修改"
            className={`rounded border px-2 py-1 text-xs transition-colors ${
              rejected
                ? 'border-rd-danger/30 bg-rd-danger/10 text-rd-danger opacity-60'
                : 'border-rd-border text-rd-textMuted hover:border-rd-danger/30 hover:text-rd-danger'
            }`}
          >
            {rejected ? '已拒绝' : '拒绝'}
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={applied || rejected}
            aria-label="采纳此修改"
            className={`rounded border px-2 py-1 text-xs transition-colors ${
              applied
                ? 'border-rd-success/30 bg-rd-success/10 text-rd-success opacity-60'
                : 'border-rd-border text-rd-textMuted hover:border-rd-success/30 hover:text-rd-success'
            }`}
          >
            {applied ? '已采纳' : '采纳'}
          </button>
        </div>
      )}
    </div>
  );
}

/** 单行 diff 视图 */
function DiffLineView({ line }: { line: DiffLine }) {
  const bgClass =
    line.type === 'add'
      ? 'bg-rd-success/8 text-rd-success'
      : line.type === 'del'
      ? 'bg-rd-danger/8 text-rd-danger line-through opacity-80'
      : 'text-rd-textMuted';
  const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  return (
    <div className={`flex px-2 py-px ${bgClass}`}>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-rd-textSubtle">
        {line.oldLn ?? ''}
      </span>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-rd-textSubtle">
        {line.newLn ?? ''}
      </span>
      <span className="shrink-0 pr-2 select-none">{sign}</span>
      <span className="whitespace-pre">{line.text}</span>
    </div>
  );
}

// ============================================================
// Phase 74-A1/A2：命令输出——ANSI 解析 + 头尾保留
// ============================================================

interface CommandOutputProps {
  command: string;
  result: string;
  status: ToolCallStatus;
}

function CommandOutput({ command, result, status }: CommandOutputProps) {
  const [showFull, setShowFull] = useState(false);
  const [showTail, setShowTail] = useState(false);

  // 头尾切分
  const { head, tail, foldedCount } = useMemo(() => splitHeadTail(result, 3, 5), [result]);
  // ANSI 解析（只在需要显示的段做）
  const headHtml = useMemo(() => ansiToHtml(head), [head]);
  const tailHtml = useMemo(() => ansiToHtml(tail), [tail]);
  const fullHtml = useMemo(() => ansiToHtml(result), [result]);

  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 text-xs text-rd-textSubtle">命令</div>
        <pre className="overflow-x-auto rounded-md bg-rd-background p-2 font-mono text-xs text-rd-text">
          {command}
        </pre>
      </div>
      {result && (
        <div>
          <div className="mb-1 text-xs text-rd-textSubtle">输出</div>
          <pre
            className={`max-h-80 overflow-auto rounded-md border border-rd-border p-2 font-mono text-xs ${
              status === 'error' ? 'bg-rd-danger/10 text-rd-danger' : 'bg-rd-background text-rd-textMuted'
            }`}
          >
            {showFull ? (
              // SECURITY: fullHtml 来自 ansiToHtml()，该函数先调用 escapeHtml()
              // 转义 & < > " ' 五个字符，再交给 ansi_up 仅添加 <span style> 标签。
              // 输入已完全 sanitize，无原始用户内容到达 dangerouslySetInnerHTML。
              <span dangerouslySetInnerHTML={{ __html: fullHtml }} />
            ) : (
              <>
                {/* SECURITY: headHtml 同上——ansiToHtml 先 escapeHtml 再 ansi_up，已防注入 */}
                <span dangerouslySetInnerHTML={{ __html: headHtml }} />
                {foldedCount > 0 && (
                  <>
                    {!showTail && (
                      <button
                        type="button"
                        onClick={() => setShowTail(true)}
                        className="my-1 block w-full rounded border border-rd-border bg-rd-surface px-2 py-px text-center text-rd-textSubtle hover:text-rd-primary"
                      >
                        ⋯ 折叠 {foldedCount} 行 · 点击展开尾部
                      </button>
                    )}
                    {showTail && (
                      <>
                        {/* SECURITY: tailHtml 同上——ansiToHtml 先 escapeHtml 再 ansi_up，已防注入 */}
                        <span dangerouslySetInnerHTML={{ __html: tailHtml }} />
                        <button
                          type="button"
                          onClick={() => setShowTail(false)}
                          className="my-1 block w-full text-center text-rd-textSubtle hover:text-rd-primary"
                        >
                          ⋯ 收起尾部
                        </button>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </pre>
          {!showFull && (
            <button
              type="button"
              onClick={() => setShowFull(true)}
              className="mt-1 text-xs text-rd-primary hover:text-rd-primaryHover"
            >
              展开全部
            </button>
          )}
          {showFull && (
            <button
              type="button"
              onClick={() => setShowFull(false)}
              className="mt-1 text-xs text-rd-primary hover:text-rd-primaryHover"
            >
              收起
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 单个工具调用详情：深色浮层块 */
export function ToolCallDetail({ toolName, status, args, result, deltaBuffer }: Omit<ToolCallItem, 'id' | 'timestamp'>) {
  const resultStr = getResultText(result);
  const MAX_RESULT_LEN = 2000;
  const truncatedResult = resultStr.length > MAX_RESULT_LEN
    ? resultStr.slice(0, MAX_RESULT_LEN) + '\n... [结果已截断]'
    : resultStr;
  const filePath = getPathFromArgs(args);
  const command = typeof args?.command === 'string' ? args.command : '';
  const query = String(args?.query || args?.pattern || '');
  const url = String(args?.url || '');
  // Phase 96 P1-1：运行态优先展示实时增量输出，完成态展示最终结果
  const showLiveStream = status === 'running' && !!deltaBuffer;

  return (
    <div className="space-y-3 text-xs">
      {['file_read', 'file_write', 'file_edit'].includes(toolName) && filePath && toolName !== 'file_edit' && (
        <div>
          <div className="mb-1 text-rd-textSubtle">文件</div>
          <div className="rounded-md bg-rd-background p-2 font-mono text-rd-textMuted">{filePath}</div>
        </div>
      )}

      {toolName === 'list_directory' && filePath && (
        <div>
          <div className="mb-1 text-rd-textSubtle">目录</div>
          <div className="rounded-md bg-rd-background p-2 font-mono text-rd-textMuted">{filePath}</div>
        </div>
      )}

      {toolName === 'todo_write' && (
        <div className="text-rd-textMuted">待办详情请查看右侧任务监控。</div>
      )}

      {/* Phase 96 P1-1：运行态实时流式输出（shell_exec 等长任务） */}
      {showLiveStream && (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-rd-textSubtle">
            <Loader2 size={11} className="animate-spin" />
            <span>实时输出</span>
          </div>
          <pre className="max-h-80 overflow-auto rounded-md border border-rd-primary/30 bg-rd-background p-2 font-mono text-xs text-rd-textMuted">
            {deltaBuffer}
          </pre>
        </div>
      )}

      {toolName === 'shell_exec' && command && !showLiveStream && (
        <CommandOutput command={command} result={truncatedResult} status={status} />
      )}

      {toolName === 'file_edit' && args && !!(args.oldString || args.old_string || args.newString || args.new_string) && (
        <FileEditDiff args={args} />
      )}

      {['code_search', 'file_search', 'web_search'].includes(toolName) && query && (
        <div>
          <div className="mb-1 text-rd-textSubtle">搜索</div>
          <div className="rounded-md bg-rd-background p-2 text-rd-textMuted">{query}</div>
        </div>
      )}

      {toolName === 'web_fetch' && url && (
        <div>
          <div className="mb-1 text-rd-textSubtle">网页</div>
          <div className="rounded-md bg-rd-background p-2 text-rd-textMuted">{url}</div>
        </div>
      )}

      {truncatedResult && !['todo_write', 'file_read', 'list_directory', 'shell_exec', 'file_edit'].includes(toolName) && (
        <div>
          <div className="mb-1 text-rd-textSubtle">结果</div>
          <pre
            className={`max-h-40 overflow-auto rounded-md p-2 font-mono text-xs ${
              status === 'error' ? 'bg-rd-danger/10 text-rd-danger' : 'bg-rd-background text-rd-textMuted'
            }`}
          >
            {truncatedResult}
          </pre>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 74-A5/A6/A7/A8：折叠态摘要行——StatusBadge + 关键参数 + ToolIcon + shimmer
// ============================================================

interface ToolCallSummaryProps {
  toolName: string;
  status: ToolCallStatus;
  args?: Record<string, unknown>;
  onClick?: () => void;
}

function ToolCallSummary({ toolName, status, args, onClick }: ToolCallSummaryProps) {
  const toolType = getToolType(toolName);
  const actionSummary = getToolActionSummary(toolName, args);
  const statusText = getToolStatusText(toolName, status);
  const paramPreview = getKeyParamPreview(toolName, args);
  const isRunning = status === 'running';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${TOOL_LABELS[toolName] ?? toolName} · ${statusText}`}
      className={`group flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left transition-all ${
        isRunning
          ? 'border-rd-primary/40 bg-rd-surface shadow-[0_0_0_1px_var(--rd-primary),0_0_12px_rgba(139,141,255,0.15)] animate-pulse'
          : 'border-rd-border bg-rd-surface hover:border-rd-borderHover hover:bg-rd-surfaceHover'
      }`}
    >
      {/* 74-A7：ToolIcon 着色 */}
      <ToolIcon toolType={toolType} size="sm" />
      <span className="shrink-0 text-xs font-medium text-rd-text">
        {TOOL_LABELS[toolName] ?? toolName}
      </span>
      {/* 74-A6：关键参数预览（等宽字体） */}
      {paramPreview && (
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-rd-textMuted">
          <span className="text-rd-textSubtle">{paramPreview.key}</span>{' '}
          {paramPreview.value}
        </span>
      )}
      {!paramPreview && (
        <span className="min-w-0 flex-1 truncate text-xs text-rd-textMuted">
          {status === 'running' ? statusText : (actionSummary || statusText)}
        </span>
      )}
      {/* 74-A5：StatusBadge */}
      <StatusBadge variant={statusToBadgeVariant(status)} size="sm" showIcon>
        {getStatusBadgeText(status, toolName)}
      </StatusBadge>
    </button>
  );
}

// ============================================================
// 工具详情文本框：替代旧 ToolCallDetail，竖向滚动，风格与思考过程一致
// ============================================================

function formatToolInfo(toolName: string, args?: Record<string, unknown>, result?: unknown): string {
  const lines: string[] = [];
  if (args) {
    switch (toolName) {
      case 'file_read':
      case 'file_write':
      case 'list_directory': {
        const p = getPathFromArgs(args);
        if (p) lines.push(p);
        break;
      }
      case 'file_edit': {
        const p = getPathFromArgs(args);
        if (p) lines.push(p);
        const old = String((args.oldString ?? args.old_string) ?? '');
        const nw  = String((args.newString ?? args.new_string) ?? '');
        if (old) lines.push(`- ${old.slice(0, 120)}${old.length > 120 ? '…' : ''}`);
        if (nw)  lines.push(`+ ${nw.slice(0, 120)}${nw.length > 120 ? '…' : ''}`);
        break;
      }
      case 'shell_exec': {
        const cmd = String(args.command ?? '');
        if (cmd) lines.push(`$ ${cmd}`);
        break;
      }
      case 'code_search':
      case 'file_search':
      case 'web_search': {
        const q = String(args.query ?? args.pattern ?? '');
        if (q) lines.push(q);
        break;
      }
      case 'web_fetch': {
        const u = String(args.url ?? '');
        if (u) lines.push(u);
        break;
      }
      case 'spawn_agent': {
        const desc = String(args.description ?? args.task ?? '');
        if (desc) lines.push(desc);
        break;
      }
      default: {
        for (const [k, v] of Object.entries(args).slice(0, 3)) {
          if (typeof v === 'string' || typeof v === 'number') {
            lines.push(`${k}: ${String(v).slice(0, 100)}`);
          }
        }
      }
    }
  }
  const resultText = getResultText(result);
  if (resultText) {
    if (lines.length > 0) lines.push('');
    lines.push(resultText.slice(0, 3000));
  }
  return lines.join('\n');
}

function ToolTextBox({ toolName, args, result, isError }: {
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}) {
  const content = formatToolInfo(toolName, args, result);
  if (!content) return null;
  return (
    <div className={`max-h-48 overflow-y-auto rounded-md p-3 text-xs leading-relaxed whitespace-pre-wrap font-mono ${
      isError
        ? 'bg-rd-danger/10 text-rd-danger'
        : 'bg-rd-surfaceHighlight text-rd-textMuted'
    }`}>
      {content}
    </div>
  );
}

// ============================================================
// 聚合动作摘要行：用于第二层"动作"层，按工具名聚合
// ============================================================

export function ActionSummaryRow({
  toolName,
  items,
}: {
  toolName: string;
  items: ToolCallItem[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const toolType = getToolType(toolName);
  const runningCount = items.filter((i) => i.status === 'running').length;
  const errorCount = items.filter((i) => i.status === 'error').length;
  const hasRunning = runningCount > 0;

  const paths = items.map((i) => getPathFromArgs(i.args)).filter(Boolean);
  const uniquePaths = [...new Set(paths)];
  const pathPreview = uniquePaths.slice(0, 2).join(', ') + (uniquePaths.length > 2 ? ` 等 ${uniquePaths.length} 个` : '');
  let summary = '';
  if (toolName === 'shell_exec') {
    summary = `执行了 ${items.length} 条命令`;
  } else if (toolName === 'file_edit') {
    summary = pathPreview ? `编辑了 ${pathPreview}` : `编辑了 ${items.length} 个文件`;
  } else if (toolName === 'file_read') {
    summary = pathPreview ? `查看了 ${pathPreview}` : `查看了 ${items.length} 个文件`;
  } else if (toolName === 'file_write') {
    summary = pathPreview ? `写入了 ${pathPreview}` : `写入了 ${items.length} 个文件`;
  } else {
    summary = `${getToolLabel(toolName)} ${items.length} 次`;
  }

  const showBadge = hasRunning || errorCount > 0;
  const badgeVariant = hasRunning ? 'running' : 'error';
  // 失败时只显示数量，靠红色徽章 + XCircle 图标传递失败语义（避免 ✗ 字符冗余）
  const badgeText = hasRunning ? `${runningCount}/${items.length}` : `${errorCount}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-label={`${getToolLabel(toolName)} · ${items.length} 项 · ${summary}`}
        className={`group flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-all ${
          hasRunning
            ? 'bg-rd-primary/5'
            : 'hover:bg-rd-surfaceHover'
        }`}
      >
        <ToolIcon toolType={toolType} size="sm" />
        <span className="shrink-0 text-xs font-medium text-rd-text">
          {getToolLabel(toolName)}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-rd-textMuted">{summary}</span>
        {showBadge && (
          <StatusBadge variant={badgeVariant as 'running' | 'error'} size="sm" showIcon>
            {badgeText}
          </StatusBadge>
        )}
        {expanded
          ? <ChevronDown size={12} className="shrink-0 text-rd-textSubtle" />
          : <ChevronRight size={12} className="shrink-0 text-rd-textSubtle" />}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {(errorCount > 0 ? items.filter(i => i.status === 'error') : items).map((item) => (
            <ToolTextBox key={item.id} toolName={item.toolName} args={item.args} result={item.result} isError={item.status === 'error'} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 子 Agent 名称行：机器人头像 + 名称 + 可折叠
// ============================================================

export function SubAgentRow({
  item,
}: {
  item: ToolCallItem;
}) {
  const [expanded, setExpanded] = useState(false);
  const desc = (item.args?.description as string) || (item.args?.task as string) || '子 Agent';
  const name = desc.length > 40 ? `${desc.slice(0, 40)}...` : desc;
  const resultText = getResultText(item.result);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-label={`子 Agent · ${name} · ${getToolStatusText(item.toolName, item.status)}`}
        className={`group flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left transition-all ${
          item.status === 'running'
            ? 'border-rd-primary/40 bg-rd-surface shadow-[0_0_0_1px_var(--rd-primary),0_0_12px_rgba(139,141,255,0.15)] animate-pulse'
            : 'border-rd-border bg-rd-surface hover:border-rd-borderHover hover:bg-rd-surfaceHover'
        }`}
      >
        <ToolIcon toolType="spawn_agent" size="sm" />
        <span className="min-w-0 flex-1 truncate text-xs text-rd-text">{name}</span>
        {item.status === 'running' && (
          <StatusBadge variant="running" size="sm" showIcon>
            {getToolStatusText(item.toolName, item.status)}
          </StatusBadge>
        )}
        {item.status === 'error' && (
          <StatusBadge variant="error" size="sm" showIcon>
            {getToolStatusText(item.toolName, item.status)}
          </StatusBadge>
        )}
        {expanded
          ? <ChevronDown size={12} className="shrink-0 text-rd-textSubtle" />
          : <ChevronRight size={12} className="shrink-0 text-rd-textSubtle" />}
      </button>
      {expanded && resultText && (
        <div className="ml-4 mt-1 border-l border-rd-tree-line pl-3">
          <div className="py-1 text-xs leading-relaxed text-rd-textMuted whitespace-pre-wrap">
            {resultText.slice(0, 4000)}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 单个工具调用卡片（保留兼容）
// ============================================================

const ToolCallCard = memo(function ToolCallCard({
  toolName,
  status,
  args,
  result,
  deltaBuffer,
}: {
  toolName: string;
  status: ToolCallStatus;
  args?: Record<string, unknown>;
  result?: unknown;
  deltaBuffer?: string;
}) {
  // Phase 96 P1-1：运行态有流式输出时自动展开，让用户看到实时进度
  const hasLiveStream = status === 'running' && !!deltaBuffer;
  const [expanded, setExpanded] = useState(false);
  const [autoExpanded, setAutoExpanded] = useState(false);
  // 首次检测到 deltaBuffer 时自动展开（仅一次，用户手动折叠后不再自动展开）
  if (hasLiveStream && !autoExpanded) {
    setAutoExpanded(true);
    if (!expanded) setExpanded(true);
  }

  return (
    <div>
      <ToolCallSummary
        toolName={toolName}
        status={status}
        args={args}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div className="mt-1.5 rounded-md bg-rd-surfaceHighlight p-3 shadow-rd">
          <ToolCallDetail toolName={toolName} status={status} args={args} result={result} deltaBuffer={deltaBuffer} />
        </div>
      )}
    </div>
  );
});

export { ToolCallCard };

/** 分组工具调用卡片（保留兼容） */
export function ToolCallGroup({ items }: { items: ToolCallItem[] }) {
  if (items.length === 0) return null;
  const toolName = items[0].toolName;
  return <ActionSummaryRow toolName={toolName} items={items} />;
}
