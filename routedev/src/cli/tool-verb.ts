// src/cli/tool-verb.ts
// Phase 34 Task 3：动作动词体系与工具执行反馈
// 统一工具调用的“执行中/已完成/失败”三种状态的文案，使用过去时动词降低焦虑

import type { OutputStyle } from '../config/schema.js';

/** 工具反馈状态 */
type ToolFeedbackState = 'running' | 'completed' | 'failed';

/** 单工具的三态动词文案 */
interface ToolVerbSet {
  /** 执行中（现在时/进行态） */
  running: string;
  /** 执行后（过去时） */
  completed: string;
  /** 失败（过去时） */
  failed: string;
}

/**
 * 内置工具动词表
 * key 为工具名（含常见 MCP 工具别名），value 为三态文案模板
 * 模板中使用 {{arg}} 占位符，渲染时替换为具体参数
 */
const TOOL_VERBS: Record<string, ToolVerbSet> = {
  file_read: {
    running: '读取 {{path}}...',
    completed: '已读取 {{path}}',
    failed: '读取失败：{{path}}',
  },
  file_write: {
    running: '写入 {{path}}...',
    completed: '已写入 {{path}}',
    failed: '写入失败：{{path}}',
  },
  file_edit: {
    running: '修改 {{path}}...',
    completed: '已修改 {{path}}',
    failed: '修改失败：{{path}}',
  },
  file_search: {
    running: '搜索文件 {{query}}...',
    completed: '找到 {{count}} 个文件',
    failed: '搜索失败：{{query}}',
  },
  code_search: {
    running: '搜索代码 {{pattern}}...',
    completed: '找到 {{count}} 处匹配',
    failed: '代码搜索失败：{{pattern}}',
  },
  list_directory: {
    running: '列出目录 {{path}}...',
    completed: '已列出目录 {{path}}',
    failed: '列出目录失败：{{path}}',
  },
  shell_exec: {
    running: '运行 {{command}}...',
    completed: '命令执行完成',
    failed: '命令执行失败',
  },
  git_op: {
    running: '执行 git {{operation}}...',
    completed: 'git {{operation}} 完成',
    failed: 'git {{operation}} 失败',
  },
  web_search: {
    running: '搜索网络 {{query}}...',
    completed: '找到 {{count}} 条结果',
    failed: '网络搜索失败',
  },
  web_fetch: {
    running: '抓取网页 {{url}}...',
    completed: '已抓取 {{url}}',
    failed: '抓取失败：{{url}}',
  },
  todo_write: {
    running: '更新任务列表...',
    completed: '已更新任务列表',
    failed: '更新任务列表失败',
  },
  notes: {
    running: '记录笔记...',
    completed: '已记录笔记',
    failed: '记录笔记失败',
  },
  spawn_agent: {
    running: '派生子 Agent...',
    completed: '子 Agent 完成',
    failed: '子 Agent 失败',
  },
  repo_map: {
    running: '生成代码地图...',
    completed: '已生成代码地图',
    failed: '代码地图生成失败',
  },
};

/** 兜底动词（用于未注册的 MCP 工具） */
const DEFAULT_VERBS: ToolVerbSet = {
  running: '调用 {{toolName}}...',
  completed: '已完成 {{toolName}}',
  failed: '{{toolName}} 失败',
};

/**
 * 从工具参数中提取可读片段
 * 只返回前 N 个字符，避免 URL/命令/路径过长撑爆一行
 */
function extractArgPreview(args: Record<string, unknown>, key: string, maxLen = 40): string {
  const value = args[key];
  if (value === undefined || value === null) return '';
  const str = String(value).trim();
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

/**
 * 填充动词模板
 * 可用占位符：{{toolName}}, {{argKey}}（取 args 中对应字段）
 */
function fillTemplate(
  template: string,
  toolName: string,
  args: Record<string, unknown>,
  extra: Record<string, string> = {},
): string {
  return template
    .replace(/\{\{toolName\}\}/g, toolName)
    .replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      if (key in extra) return extra[key];
      return extractArgPreview(args, key);
    })
    .trim();
}

/**
 * 根据工具名获取动词集合（支持常见别名）
 */
function getVerbSet(toolName: string): ToolVerbSet {
  const normalized = toolName.toLowerCase();
  // 精确匹配
  if (TOOL_VERBS[normalized]) return TOOL_VERBS[normalized];
  // MCP 工具常见前缀匹配（如 mcp:file_read）
  const suffix = normalized.split(/[:_]/).pop() ?? '';
  if (TOOL_VERBS[suffix]) return TOOL_VERBS[suffix];
  return DEFAULT_VERBS;
}

/**
 * 生成工具执行反馈文案
 *
 * @param toolName 工具名
 * @param state 当前状态
 * @param args 工具参数
 * @param result 工具结果（用于 completed/failed 时补充信息）
 * @param isError 是否错误
 * @param outputStyle 输出样式
 */
export function formatToolFeedback(
  toolName: string,
  state: ToolFeedbackState,
  args: Record<string, unknown> = {},
  result?: string,
  isError = false,
  outputStyle: OutputStyle = 'standard',
): string {
  const verbs = getVerbSet(toolName);
  const effectiveState = state === 'completed' && isError ? 'failed' : state;
  const template = verbs[effectiveState];

  // 从结果中提取匹配数量（简单启发式）
  const count = result ? extractCountFromResult(result) : '';
  const extra: Record<string, string> = { count };

  const base = fillTemplate(template, toolName, args, extra);

  if (state === 'running') return base;

  // 完成后附加简洁结果摘要
  const suffix = buildResultSuffix(result, isError, outputStyle);
  if (suffix) return `${base}${suffix}`;
  return base;
}

/**
 * 从工具结果文本中提取“找到 N 个”这类数量
 */
function extractCountFromResult(result: string): string {
  const m = result.match(/(?:找到|发现|匹配|返回|共)\s*(\d+)/);
  if (m) return m[1];
  // 按行计数（适用于文件列表、搜索结果）
  const lines = result.split('\n').filter(l => l.trim());
  if (lines.length > 1 && lines.length <= 50) return String(lines.length);
  return '';
}

/**
 * 构造结果后缀（控制信息密度）
 */
function buildResultSuffix(
  result: string | undefined,
  isError: boolean,
  outputStyle: OutputStyle,
): string {
  if (!result) return '';
  if (isError) {
    const reason = result.slice(0, 80).replace(/\n/g, ' ');
    return ` — ${reason}`;
  }
  if (outputStyle === 'minimal') return '';
  if (outputStyle === 'standard') {
    // 标准模式只展示结果的第一行或简短摘要
    const firstLine = result.split('\n')[0]?.trim() ?? '';
    if (!firstLine) return '';
    const preview = firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine;
    return ` — ${preview}`;
  }
  // verbose 模式下由调用方单独展示完整结果，这里不加后缀
  return '';
}

/** 工具执行中消息 ID 前缀（用于后续替换） */
export const TOOL_RUNNING_PREFIX = 'tool-running-';

/**
 * 根据 toolCallId 生成运行中消息的 ID
 */
export function getToolRunningMessageId(toolCallId: string): string {
  return `${TOOL_RUNNING_PREFIX}${toolCallId}`;
}
