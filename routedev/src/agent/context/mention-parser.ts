// src/agent/context/mention-parser.ts
// Phase 71 Task B2：@-mention 统一引用协议解析器
// 解析用户输入中的 @-mention，区分文件路径 / 符号名 / URL
// 供 mention-resolver 中间件和后续工具共享同一引用上下文
//
// 设计原则：
//   1. fail-open：符号 DB 查询失败时 resolved 退化为符号名本身，不抛异常
//   2. 跨平台：文件路径用 path.resolve 处理，不硬编码分隔符
//   3. 无副作用：DB 文件不存在时跳过查询，不创建空 DB

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import { initDatabase, getNodeByName } from '../../code-map/database.js';

/** Mention 类型 */
export type MentionType = 'file' | 'symbol' | 'url';

/** 解析后的 Mention 项 */
export interface Mention {
  type: MentionType;
  /** 原始 token（@ 后面的部分） */
  raw: string;
  /** 解析结果：文件绝对路径 / 符号所在文件路径 / URL 本身 */
  resolved: string;
}

/** 符号标识符正则：纯标识符（无 / \ . : 等路径/命名空间分隔符） */
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * @-mention 主正则：匹配 @ 后以合法字符开头的 token
 * 合法起始字符：字母 / _ / $（标识符）/ / / \ / .（路径）
 * 排除 @ 后跟空格或非标识符字符（如 ! ? , ;）的情况
 */
const MENTION_RE = /@([A-Za-z_$/.\\][^\s@]*)/g;

/**
 * 解析文本中的 @-mention，区分文件路径 / 符号名 / URL
 *
 * 解析规则（按优先级）：
 * - URL：以 http:// 或 https:// 开头
 * - 符号名：纯标识符（无 / \ . :），查 code-map 数据库匹配
 * - 文件路径：含路径分隔符或扩展名点，相对路径基于 cwd 解析为绝对路径
 *
 * fail-open：符号 DB 查询失败时 resolved 退化为符号名本身，不抛异常
 *
 * @param text 用户输入文本
 * @param cwd 当前工作目录（用于解析相对路径和定位 code-map DB）
 * @returns 解析后的 Mention 数组（可能为空，绝不抛异常）
 */
export function parseMentions(text: string, cwd: string): Mention[] {
  const mentions: Mention[] = [];
  let match: RegExpExecArray | null;
  // 重置 lastIndex 防止全局正则状态残留（同一进程多次调用）
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const token = match[1];
    // @ 后跟空格或非标识符字符时 token 为空，跳过
    if (!token) continue;

    const mention = resolveMention(token, cwd);
    if (mention) {
      mentions.push(mention);
    }
  }
  return mentions;
}

/**
 * 解析单个 @-mention token
 * 按 URL → 符号名 → 文件路径顺序判断类型
 */
function resolveMention(token: string, cwd: string): Mention | null {
  // 1. URL：以 http:// 或 https:// 开头
  if (token.startsWith('http://') || token.startsWith('https://')) {
    return { type: 'url', raw: token, resolved: token };
  }

  // 2. 符号名：纯标识符（无 / \ . :）
  if (SYMBOL_RE.test(token)) {
    const resolved = resolveSymbol(token, cwd);
    return { type: 'symbol', raw: token, resolved };
  }

  // 3. 文件路径：含路径分隔符或扩展名点
  //    相对路径基于 cwd 解析为绝对路径（path.resolve 跨平台）
  const absPath = path.resolve(cwd, token);
  return { type: 'file', raw: token, resolved: absPath };
}

/**
 * 查询 code-map 数据库解析符号名到文件路径
 * fail-open：DB 不存在或查询失败时返回符号名本身
 *
 * DB 路径约定：{cwd}/.routedev/code-map/code-map.db（与 indexer.ts 默认路径一致）
 */
function resolveSymbol(symbolName: string, cwd: string): string {
  try {
    const dbPath = path.join(cwd, '.routedev', 'code-map', 'code-map.db');
    // DB 文件不存在时直接返回符号名（避免 initDatabase 创建空 DB 的副作用）
    if (!fs.existsSync(dbPath)) {
      return symbolName;
    }
    const db = initDatabase(dbPath);
    try {
      const nodes = getNodeByName(db, symbolName);
      if (nodes.length > 0) {
        // 返回第一个匹配符号所在文件路径
        return nodes[0].filePath;
      }
    } finally {
      // 关闭 DB 连接，避免句柄泄漏
      db.close();
    }
    return symbolName;
  } catch (err) {
    logger.debug('resolveSymbol 查询失败 (fail-open)', {
      symbol: symbolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return symbolName;
  }
}
