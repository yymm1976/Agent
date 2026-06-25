// desktop/renderer/src/components/ToolCallCard.tsx
// 工具调用展示：Trae Work 风格 —— 一行摘要 + 可展开深色详情块
// 合并工具与命令为“动作”层；第三层详情用投影浮层；命令输出支持两层折叠

import { useState } from 'react';
import {
  Loader2, CheckCircle, XCircle, Wrench, FileText, FolderSearch, FileEdit, FilePlus,
  Terminal, Search, ListChecks, Bot, ChevronDown, ChevronRight,
} from 'lucide-react';

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

/** 工具图标映射 */
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

/** 获取工具图标 */
export function getToolIcon(toolName: string): React.ReactNode {
  return TOOL_ICONS[toolName] ?? <Wrench size={13} />;
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
 * 从工具参数中提取动作摘要（用于第二层一行摘要）
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

/** 状态配置 */
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

/** 文件编辑差异：深色背景 + 红绿删增 */
function FileEditDiff({ args }: { args: Record<string, unknown> }) {
  const oldString = (args.oldString as string) || (args.old_string as string) || '';
  const newString = (args.newString as string) || (args.new_string as string) || '';
  const filePath = getPathFromArgs(args);

  return (
    <div className="space-y-2">
      {filePath && (
        <div className="text-xs text-rd-textSubtle">{filePath}</div>
      )}
      {oldString && (
        <div>
          <pre className="overflow-x-auto rounded-md bg-rd-danger/10 p-2 font-mono text-xs text-rd-danger line-through opacity-80">
            {oldString}
          </pre>
        </div>
      )}
      {newString && (
        <div>
          <pre className="overflow-x-auto rounded-md bg-rd-success/10 p-2 font-mono text-xs text-rd-success">
            {newString}
          </pre>
        </div>
      )}
    </div>
  );
}

/** 命令输出：默认折叠，展开后显示前 5 行，再次点击展开全部 */
function CommandOutput({ command, result, status }: { command: string; result: string; status: ToolCallStatus }) {
  const [expandedAll, setExpandedAll] = useState(false);
  const lines = result ? result.split('\n') : [];
  const previewLines = 5;
  const hasMore = lines.length > previewLines;
  const displayText = expandedAll
    ? result
    : lines.slice(0, previewLines).join('\n') + (hasMore ? '\n...' : '');

  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 text-xs text-rd-textSubtle">命令</div>
        <pre className="overflow-x-auto rounded-md bg-rd-background p-2 font-mono text-xs text-rd-text">
          {command}
        </pre>
      </div>
      {displayText && (
        <div>
          <div className="mb-1 text-xs text-rd-textSubtle">输出</div>
          <pre
            className={`max-h-60 overflow-auto rounded-md p-2 font-mono text-xs ${
              status === 'error' ? 'bg-rd-danger/10 text-rd-danger' : 'bg-rd-background text-rd-textMuted'
            }`}
          >
            {displayText}
          </pre>
          {hasMore && (
            <button
              type="button"
              onClick={() => setExpandedAll((v) => !v)}
              className="mt-1 text-xs text-rd-primary hover:text-rd-primaryHover"
            >
              {expandedAll ? '收起' : '展开全部'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 单个工具调用详情：深色浮层块 */
export function ToolCallDetail({ toolName, status, args, result }: Omit<ToolCallItem, 'id' | 'timestamp'>) {
  const resultStr = getResultText(result);
  const MAX_RESULT_LEN = 2000;
  const truncatedResult = resultStr.length > MAX_RESULT_LEN
    ? resultStr.slice(0, MAX_RESULT_LEN) + '\n... [结果已截断]'
    : resultStr;
  const filePath = getPathFromArgs(args);
  const command = typeof args?.command === 'string' ? args.command : '';
  const query = String(args?.query || args?.pattern || '');
  const url = String(args?.url || '');

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

      {toolName === 'shell_exec' && command && (
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

/** 单个工具摘要行 */
function ToolCallSummary({
  toolName,
  status,
  args,
  onClick,
}: {
  toolName: string;
  status: ToolCallStatus;
  args?: Record<string, unknown>;
  onClick?: () => void;
}) {
  const config = getStatusConfig(status);
  const actionSummary = getToolActionSummary(toolName, args);
  const statusText = getToolStatusText(toolName, status);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 py-1 text-left transition-colors hover:text-rd-text"
    >
      <span className="shrink-0 text-rd-textSubtle">{getToolIcon(toolName)}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-rd-textMuted">
        {status === 'running' ? statusText : (actionSummary || statusText)}
      </span>
      <span className={`shrink-0 ${config.colorClass}`}>{config.icon}</span>
    </button>
  );
}

/** 聚合动作摘要行：用于第二层“动作”层，按工具名聚合 */
export function ActionSummaryRow({
  toolName,
  items,
}: {
  toolName: string;
  items: ToolCallItem[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const icon = getToolIcon(toolName);
  const runningCount = items.filter((i) => i.status === 'running').length;
  const errorCount = items.filter((i) => i.status === 'error').length;
  const overallStatus: ToolCallStatus = runningCount > 0 ? 'running' : errorCount > 0 ? 'error' : 'completed';
  const config = getStatusConfig(overallStatus);

  // 聚合摘要
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

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 py-1 text-left transition-colors hover:text-rd-text"
      >
        <span className="shrink-0 text-rd-textSubtle">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-rd-textMuted">{summary}</span>
        <span className={`shrink-0 ${config.colorClass}`}>{config.icon}</span>
        {expanded
          ? <ChevronDown size={12} className="shrink-0 text-rd-textSubtle" />
          : <ChevronRight size={12} className="shrink-0 text-rd-textSubtle" />}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-2 rounded-md bg-rd-surfaceHighlight p-3 shadow-rd">
          {items.map((item) => (
            <div key={item.id} className="border-b border-rd-border/30 pb-2 last:border-0 last:pb-0">
              <ToolCallDetail
                toolName={item.toolName}
                status={item.status}
                args={item.args}
                result={item.result}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 子 Agent 名称行：机器人头像 + 名称 + 可折叠 */
export function SubAgentRow({
  item,
}: {
  item: ToolCallItem;
}) {
  const [expanded, setExpanded] = useState(false);
  const desc = (item.args?.description as string) || (item.args?.task as string) || '子 Agent';
  const name = desc.length > 40 ? `${desc.slice(0, 40)}...` : desc;
  const config = getStatusConfig(item.status);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 py-1 text-left transition-colors hover:text-rd-text"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-rd-surfaceHighlight text-rd-textSubtle">
          <Bot size={11} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-rd-text">{name}</span>
        <span className={`shrink-0 ${config.colorClass}`}>{config.icon}</span>
        {expanded
          ? <ChevronDown size={12} className="shrink-0 text-rd-textSubtle" />
          : <ChevronRight size={12} className="shrink-0 text-rd-textSubtle" />}
      </button>
      {expanded && (
        <div className="mt-1.5 rounded-md bg-rd-surfaceHighlight p-3 shadow-rd">
          <ToolCallDetail
            toolName={item.toolName}
            status={item.status}
            args={item.args}
            result={item.result}
          />
        </div>
      )}
    </div>
  );
}

/** 单个工具调用卡片（保留兼容，目前主要在独立 system 消息中使用） */
export function ToolCallCard({
  toolName,
  status,
  args,
  result,
}: {
  toolName: string;
  status: ToolCallStatus;
  args?: Record<string, unknown>;
  result?: unknown;
}) {
  const [expanded, setExpanded] = useState(false);

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
          <ToolCallDetail toolName={toolName} status={status} args={args} result={result} />
        </div>
      )}
    </div>
  );
}

/** 分组工具调用卡片（保留兼容） */
export function ToolCallGroup({ items }: { items: ToolCallItem[] }) {
  if (items.length === 0) return null;
  const toolName = items[0].toolName;
  return <ActionSummaryRow toolName={toolName} items={items} />;
}
