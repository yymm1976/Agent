// desktop/renderer/src/hooks/useComposerReference.ts
// Phase 97 Part G（渲染层配套）：Composer 引用提示 hook
//
// 前缀协议与 src/agent/context/composer-reference.ts 对齐：
//   /  → skill / mcp     @  → file / symbol / url     &  → session     ~  → task
// 本 hook 仅提供「输入辅助」：检测光标前的引用前缀、聚合候选、生成替换文本。
// 真实解析由主进程 chat-bridge（sendChat → buildReferenceContext）在发送时完成，
// 发送逻辑与现有行为完全一致。
//
// 候选数据源（全部 fail-open，主进程未就绪 / 测试环境缺 API 时静默降级）：
//   /  → skill.list() + mcp.tools()
//   &  → trace.listSessions()
//   ~  → goal.listResumable()
//   @  → checkpoint.list() / experiment.list() 提取的最近改动文件 + 拖拽插入的文件

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CheckpointInfo,
  ExperimentInfo,
  MCPToolInfo,
  ResumableGoalIpcInfo,
  SkillInfo,
  TraceSession,
} from '../../../shared/ipc-types.js';

/** 引用前缀（与 composer-reference.ts 协议一致） */
export type ComposerRefPrefix = '/' | '@' | '&' | '~';

/** 候选类型 */
export type ComposerSuggestionKind = 'skill' | 'mcp' | 'session' | 'task' | 'file';

/** 引用候选项 */
export interface ComposerSuggestion {
  prefix: ComposerRefPrefix;
  kind: ComposerSuggestionKind;
  /** 插入文本（不含前缀），如 doc-writer / mcp__github__search / 会话 id / 任务 id / 文件路径 */
  id: string;
  /** 主显示文本 */
  label: string;
  /** 副显示文本（描述 / 摘要 / 路径） */
  hint?: string;
}

/** 引用触发状态 */
export interface ComposerTrigger {
  /** 光标前是否处于引用前缀输入 */
  active: boolean;
  prefix: ComposerRefPrefix | null;
  /** 前缀后的查询 token（可为空串） */
  query: string;
}

/** 光标前最后一个引用 token（允许前导空白，token 可为空串） */
const TRIGGER_RE = /(?:^|\s)([/&~@])([^\s@]*)$/;

/** @ 前缀 token 合法起始字符（与 mention-parser 的 MENTION_RE 一致） */
const AT_START_RE = /^[A-Za-z_$/.\\]/;

/** 每类候选上限 */
const MAX_PER_KIND = 6;
/** 总候选上限 */
const MAX_TOTAL = 14;

/** 从光标前文本检测引用触发（输入辅助专用，不含任何服务端解析） */
export function detectComposerTrigger(text: string, cursor: number): ComposerTrigger {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const m = TRIGGER_RE.exec(before);
  if (!m) return { active: false, prefix: null, query: '' };
  const prefix = m[1] as ComposerRefPrefix;
  const query = m[2] ?? '';
  // @ 后 token 起始字符不合法时（如中文自然语言 @中），不触发提示，避免误导
  if (prefix === '@' && query !== '' && !AT_START_RE.test(query)) {
    return { active: false, prefix: null, query: '' };
  }
  return { active: true, prefix, query };
}

/** 按 query 过滤（startsWith 优先）+ 截断 */
function rankAndSlice<T>(items: T[], query: string, pick: (t: T) => string): T[] {
  const q = query.toLowerCase();
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const s = pick(item).toLowerCase();
    const score = q.length === 0 ? 0 : s.startsWith(q) ? 0 : s.includes(q) ? 1 : -1;
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, MAX_PER_KIND).map((x) => x.item);
}

/** 路径 basename（兼容 Windows 反斜杠） */
function basename(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base || p;
}

/** 首行截断（会话摘要 / 任务目标展示用） */
function firstLine(s: string): string {
  const line = (s.split('\n')[0] ?? '').trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** 会话开始时间展示（MM-DD HH:mm） */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Composer 引用提示 hook
 *
 * @param input  输入框当前文本（受控 value）
 * @param cursor 光标位置（selectionStart，用于定位当前 token）
 * @returns 触发状态、过滤后的候选、以及生成替换文本的两个函数
 */
export function useComposerReference(input: string, cursor: number) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcpTools, setMcpTools] = useState<MCPToolInfo[]>([]);
  const [sessions, setSessions] = useState<TraceSession[]>([]);
  const [tasks, setTasks] = useState<ResumableGoalIpcInfo[]>([]);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);

  // 一次性加载候选数据源（全部 fail-open：主进程未就绪或测试环境缺 API 时静默降级）
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const api = window.routedev;
        const [skillList, mcpRes, sessionList, taskList, cpList, expList] = await Promise.all([
          api?.skill?.list?.() ?? Promise.resolve<SkillInfo[]>([]),
          api?.mcp?.tools?.() ?? Promise.resolve<{ tools: MCPToolInfo[] }>({ tools: [] }),
          api?.trace?.listSessions?.(50) ?? Promise.resolve<TraceSession[]>([]),
          api?.goal?.listResumable?.() ?? Promise.resolve<ResumableGoalIpcInfo[]>([]),
          api?.checkpoint?.list?.() ?? Promise.resolve<CheckpointInfo[]>([]),
          api?.experiment?.list?.() ?? Promise.resolve<ExperimentInfo[]>([]),
        ]);
        if (cancelled) return;
        setSkills(skillList);
        setMcpTools(mcpRes?.tools ?? []);
        setSessions(sessionList);
        setTasks(taskList);
        // @ 文件候选：checkpoint 改动文件 + 实验 modifiedFiles 去重
        const files = new Set<string>();
        for (const cp of cpList ?? []) {
          for (const f of cp.filesChanged ?? []) files.add(f);
        }
        for (const exp of expList ?? []) {
          for (const f of exp.modifiedFiles ?? []) files.add(f);
        }
        setRecentFiles([...files]);
      } catch {
        // fail-open：任何数据源失败都不阻塞输入
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const trigger = useMemo(() => detectComposerTrigger(input, cursor), [input, cursor]);

  const suggestions = useMemo<ComposerSuggestion[]>(() => {
    if (!trigger.active) return [];
    const q = trigger.query;
    const out: ComposerSuggestion[] = [];
    switch (trigger.prefix) {
      case '/':
        for (const s of rankAndSlice(skills, q, (x) => x.name)) {
          out.push({ prefix: '/', kind: 'skill', id: s.name, label: s.name, hint: s.description });
        }
        for (const t of rankAndSlice(mcpTools, q, (x) => x.name)) {
          out.push({ prefix: '/', kind: 'mcp', id: t.name, label: t.name, hint: t.description });
        }
        break;
      case '@':
        for (const f of rankAndSlice(recentFiles, q, (x) => x)) {
          out.push({ prefix: '@', kind: 'file', id: f, label: basename(f), hint: f });
        }
        break;
      case '&':
        for (const s of rankAndSlice(sessions, q, (x) => `${x.id} ${x.userInput}`)) {
          out.push({
            prefix: '&',
            kind: 'session',
            id: s.id,
            label: firstLine(s.userInput) || `会话 ${s.id}`,
            hint: `会话 ${s.id}${s.startTime ? ` · ${formatTime(s.startTime)}` : ''}`,
          });
        }
        break;
      case '~':
        for (const t of rankAndSlice(tasks, q, (x) => `${x.id} ${x.spec.goal}`)) {
          out.push({
            prefix: '~',
            kind: 'task',
            id: t.id,
            label: firstLine(t.spec.goal) || `任务 ${t.id}`,
            hint: `${t.status} · ${t.completedSteps}/${t.totalSteps}`,
          });
        }
        break;
      default:
        break;
    }
    return out.slice(0, MAX_TOTAL);
  }, [trigger, skills, mcpTools, sessions, tasks, recentFiles]);

  /** 选中候选 → 返回替换后的完整文本（替换光标前的当前 token） */
  const applySuggestion = useCallback(
    (s: ComposerSuggestion): string => {
      const before = input.slice(0, cursor);
      const after = input.slice(cursor);
      const m = TRIGGER_RE.exec(before);
      if (!m) return input;
      const tokenStart = m.index + m[1].length;
      const tokenEnd = tokenStart + m[2].length;
      return input.slice(0, tokenStart) + `${s.prefix}${s.id} ` + input.slice(tokenEnd);
    },
    [input, cursor],
  );

  /** 拖拽文件 → 返回插入 @路径 后的完整文本（同时注册为文件候选） */
  const insertDroppedFile = useCallback(
    (filePath: string): string => {
      const before = input.slice(0, cursor);
      const after = input.slice(cursor);
      const sep = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
      setRecentFiles((prev) => (prev.includes(filePath) ? prev : [filePath, ...prev].slice(0, 50)));
      return `${before}${sep}@${filePath} ${after}`;
    },
    [input, cursor],
  );

  return { trigger, suggestions, applySuggestion, insertDroppedFile };
}
