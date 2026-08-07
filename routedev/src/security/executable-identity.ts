// src/security/executable-identity.ts
// A1（RC Hardening）：ExecutableIdentity V3——executable 归一化唯一权威
//
// 背景：多个安全判定点曾各自实现 basename/stripExt（allowlist、blocklist、
// dangerous policy、approval classification、audit metadata），扩展名处理
// 集合不一致（.exe/.cmd/.bat 缺 .com）会导致同一 executable 在不同策略
// 点判定不同。本模块是唯一权威，禁止消费者自行重新实现 stripExt。
//
// canonicalName 统一：node.exe→node、npm.cmd→npm、cmd.exe→cmd、
// powershell.exe→powershell、format.com→format（含 .com 扩展）。
//
// 注意：canonicalName 是 identity 归一，不是 executable authenticity——
// basename allowlist 不保证 PATH 解析出的就是可信二进制（见 G3）。

import { parseCommand } from '../tools/command-parser.js';
import path from 'node:path';

/** 归一化后的可执行身份 */
export interface ExecutableIdentity {
  /** 原始 command 字符串 */
  original: string;
  /** parseCommand 首 token（带引号路径正确处理；无引号 Windows 盘符路径整体） */
  token: string;
  /** win32/posix basename 取短者（跨平台反斜杠/正斜杠） */
  basename: string;
  /** strip 平台可执行扩展名（.exe/.cmd/.bat/.com）后的小写名 */
  canonicalName: string;
}

/** Windows 可执行扩展名（A1：补齐 .com——format.com 此前不在 strip 集合） */
const EXECUTABLE_EXTENSIONS = /\.(exe|cmd|bat|com)$/i;

/** 可执行名跨平台规范化（win32/posix basename 取短者） */
function extractBasename(s: string): string {
  const win = path.win32.basename(s);
  const posix = path.posix.basename(s);
  return win.length <= posix.length ? win : posix;
}

/**
 * 提取 executable identity token——
 * A1 修复：parseCommand 会把 Windows 反斜杠当转义符吞掉（'C:\Program' → 'C:Program'、
 * '\n' → 换行），因此 Windows 路径由本模块自行处理：
 * - 带引号整体（"C:\Program Files\node.exe"）：strip 外层引号后整体
 * - 结构化入口（wholeAsExecutable）：command 即完整 executable（spawn 语义），
 *   strip 外层引号后整体视为 token（含空格路径不需要引号）
 * - 无引号盘符路径（字符串接口）：取第一段（含空格路径必须加引号——与 shell 语义一致）
 * - 普通命令：parseCommand 首 token
 */
function extractToken(command: string, wholeAsExecutable: boolean): string {
  const raw = command.trim();
  if (wholeAsExecutable) {
    return stripOuterQuotes(raw);
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    return raw.split(/\s+/)[0] ?? raw;
  }
  return parseCommand(command).command || raw;
}

/** strip 外层成对引号（不处理内部转义——Windows 路径反斜杠必须保留） */
function stripOuterQuotes(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** 唯一权威：executable 身份归一化 */
export function normalizeExecutableIdentity(
  command: string,
  options?: { wholeAsExecutable?: boolean },
): ExecutableIdentity {
  const token = extractToken(command, options?.wholeAsExecutable ?? false);
  const basename = extractBasename(token);
  return {
    original: command,
    token,
    basename,
    canonicalName: basename.replace(EXECUTABLE_EXTENSIONS, '').toLowerCase(),
  };
}
