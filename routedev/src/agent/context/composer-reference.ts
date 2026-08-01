// src/agent/context/composer-reference.ts
// Phase 97 Part G：结构化输入框引用系统（ComposerReference）
//
// 设计目的：
//   把输入框变成上下文编排器——用户输入的是「任务 + 显式上下文引用」，
//   内部统一解析为结构化引用，而不是把一切拼进一段 prompt。
//
// 符号协议（与 Proma Composer 对齐，扩展 Phase 71 mention-parser）：
//   /  → skill / mcp 前缀（如 /doc-writer、/mcp__github__search）
//   @  → file / symbol / url（复用 mention-parser 语义）
//   &  → session（会话引用，解析为快照摘要而非原文）
//   ~  → task / calendar（Todo 或日历事件）
//   未知符号回退纯文本（不误伤普通输入）
//
// accessScope 校验：
//   - workspace：位于工作区内
//   - attached：位于显式附加目录/文件内（Part D Workspace 边界）
//   - system：系统级能力（skill/mcp/命令），不涉及文件系统
//
// 保持 mention-parser 旧 API 兼容：parseMentions 原样保留，本模块在其上扩展。

import path from 'node:path';
import { parseMentions, type Mention } from './mention-parser.js';

/** 引用类型 */
export type ComposerRefType =
  | 'file'
  | 'directory'
  | 'session'
  | 'task'
  | 'calendar'
  | 'skill'
  | 'mcp';

/** 访问作用域：workspace / attached / system */
export type AccessScope = 'workspace' | 'attached' | 'system';

/** 结构化引用 */
export interface ComposerReference {
  type: ComposerRefType;
  /** 引用 ID：文件绝对路径 / 会话 id / skill 名 / mcp 工具名 */
  id: string;
  /** 展示名（UI 提示与摘要用） */
  displayName: string;
  /** 解析后的路径（仅 file/directory 有） */
  resolvedPath?: string;
  accessScope: AccessScope;
}

/** 引用上下文（解析时注入） */
export interface ComposerReferenceContext {
  cwd: string;
  /** 工作区根（Part D：projectRoot），用于判定 workspace 作用域 */
  workspaceRoot?: string;
  /** 显式附加目录/文件（Part D：attachedDirectories + attachedFiles） */
  attachedRoots?: string[];
  /** 已知会话 id → 摘要（& 引用用；未提供时 id 原样返回） */
  sessions?: Record<string, string>;
  /** 已知 Todo/任务 id 列表（~ 引用用） */
  tasks?: string[];
}

/** 符号前缀 → 引用类型映射 */
const PREFIX_TO_TYPE: Record<string, ComposerRefType> = {
  '/': 'skill',
  '&': 'session',
  '~': 'task',
};

/** 文件引用允许的路径字符 */
const FILE_PATH_RE = /^[A-Za-z0-9_$/.\\:@~-]+$/;

/**
 * 统一引用解析器：处理 / @ & ~ 四种前缀
 *
 * 解析规则：
 *   - @：委托 mention-parser（file/symbol/url），保留原语义
 *   - / ：skill 或 mcp（mcp__ 前缀 → mcp 类型）
 *   - & ：session 引用（id 校验后返回；displayName 用摘要首行）
 *   - ~ ：task 或 calendar（todo:/task: 前缀 → task，其余按 task 处理）
 *   - 其他：回退纯文本（返回空数组，不误伤）
 *
 * @param text 输入框文本
 * @param ctx 解析上下文（cwd 必填，其余可选）
 * @returns 结构化引用数组（绝不抛异常）
 */
export function parseComposerReferences(text: string, ctx: ComposerReferenceContext): ComposerReference[] {
  const refs: ComposerReference[] = [];
  try {
    // 1. @ 引用：复用 mention-parser（file/symbol/url）
    for (const m of parseMentions(text, ctx.cwd)) {
      const ref = mapMentionToReference(m, ctx);
      if (ref) refs.push(ref);
    }

    // 2. / & ~ 引用：前缀前须为行首或空白（避免误抓 @路径 中的分隔符），
    //    token 仅允许 ASCII 路径/命名符（中文等自然语言立即截断）
    const prefixRe = /(?:^|\s)([/&~])([A-Za-z0-9_.:@-]+)/g;
    prefixRe.lastIndex = 0;
    let pmatch: RegExpExecArray | null;
    while ((pmatch = prefixRe.exec(text)) !== null) {
      const prefix = pmatch[1];
      const token = pmatch[2];
      if (!token) continue;
      const ref = resolvePrefixedToken(prefix, token, ctx);
      if (ref) refs.push(ref);
    }
  } catch (err) {
    // fail-open：解析失败返回空数组，绝不阻塞输入框
    return [];
  }
  return dedupe(refs);
}

/** 将 mention-parser 的 Mention 映射为 ComposerReference */
function mapMentionToReference(m: Mention, ctx: ComposerReferenceContext): ComposerReference | null {
  switch (m.type) {
    case 'file': {
      const resolved = path.resolve(m.resolved);
      const scope = resolveScope(resolved, ctx);
      // 文件存在且是目录 → directory 类型
      return {
        type: 'file',
        id: resolved,
        displayName: path.basename(resolved),
        resolvedPath: resolved,
        accessScope: scope,
      };
    }
    case 'url':
      return { type: 'file', id: m.resolved, displayName: m.resolved, accessScope: 'system' };
    case 'symbol':
      // 符号解析为所在文件（resolveSymbol fail-open 可能返回符号名本身）
      return {
        type: 'file',
        id: m.resolved,
        displayName: m.raw,
        resolvedPath: m.resolved,
        accessScope: resolveScope(m.resolved, ctx),
      };
    default:
      return null;
  }
}

/** 解析 / & ~ 前缀 token */
function resolvePrefixedToken(
  prefix: string,
  token: string,
  ctx: ComposerReferenceContext,
): ComposerReference | null {
  const type = PREFIX_TO_TYPE[prefix as keyof typeof PREFIX_TO_TYPE];
  if (!type) return null;

  if (type === 'session') {
    const summary = ctx.sessions?.[token];
    return {
      type: 'session',
      id: token,
      displayName: summary ? summary.split('\n')[0]!.slice(0, 60) : `会话 ${token}`,
      accessScope: 'system',
    };
  }

  if (type === 'task') {
    // ~todo:xxx / ~task:xxx → task；~cal:xxx / ~calendar:xxx → calendar
    if (token.startsWith('cal:') || token.startsWith('calendar:')) {
      return {
        type: 'calendar',
        id: token.slice(token.indexOf(':') + 1),
        displayName: `日历 ${token.slice(token.indexOf(':') + 1)}`,
        accessScope: 'system',
      };
    }
    const rawId = token.startsWith('todo:') || token.startsWith('task:')
      ? token.slice(token.indexOf(':') + 1)
      : token;
    const known = ctx.tasks?.includes(rawId);
    return {
      type: 'task',
      id: rawId,
      displayName: known ? `任务 ${rawId}` : `任务 ${rawId}`,
      accessScope: 'system',
    };
  }

  if (type === 'skill') {
    // mcp__ 前缀 → mcp 类型
    if (token.startsWith('mcp__')) {
      return {
        type: 'mcp',
        id: token,
        displayName: token,
        accessScope: 'system',
      };
    }
    return {
      type: 'skill',
      id: token,
      displayName: token,
      accessScope: 'system',
    };
  }

  return null;
}

/** 判定路径作用域：workspace 内 / attached 内 / 系统 */
function resolveScope(absPath: string, ctx: ComposerReferenceContext): AccessScope {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const target = norm(absPath);
  if (ctx.workspaceRoot && isWithinNorm(norm(ctx.workspaceRoot), target)) {
    return 'workspace';
  }
  for (const root of ctx.attachedRoots ?? []) {
    if (isWithinNorm(norm(root), target)) {
      return 'attached';
    }
  }
  return 'system';
}

/** 边界符前缀判断（防 /proj 匹配 /proj2） */
function isWithinNorm(rootNorm: string, targetNorm: string): boolean {
  return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + '/');
}

/** 去重（按 type + id） */
function dedupe(refs: ComposerReference[]): ComposerReference[] {
  const seen = new Set<string>();
  const out: ComposerReference[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
