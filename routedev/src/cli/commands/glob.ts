// src/cli/commands/glob.ts
// 轻量级 glob 实现：不引入 minimatch / fast-glob 依赖
//
// 支持：
//   - * 单层通配（不匹配路径分隔符）
//   - ** 跨层通配（匹配任意层级）
//   - ? 单字符
//   - 字面量
//   - 大括号展开 {a,b}（src/{a,b}.ts → src/a.ts + src/b.ts）
//
// 仅用于 /include 命令的文件路径展开，性能足够（项目级文件数 < 100k）
// 复用 src/tools/security.ts 中 globToRegExp 的核心思路

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 判断字符串是否为 glob 模式（包含 * ? { 等通配符）
 */
export function isGlobPattern(s: string): boolean {
  return /[*?{}]/.test(s);
}

/**
 * 将 glob 模式转换为正则表达式
 * 支持 *（单层）、**（跨层）、?（单字符）
 */
function globToRegExp(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** 跨目录通配
        regex += '.*';
        i += 2;
        // 跳过紧跟的路径分隔符（**/ 中的 /）
        if (pattern[i] === '/' || pattern[i] === '\\') {
          i++;
        }
      } else {
        // * 单层通配（不匹配路径分隔符）
        regex += '[^/\\\\]*';
        i++;
      }
    } else if (ch === '?') {
      regex += '[^/\\\\]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  return new RegExp('^' + regex + '$', 'i');
}

/**
 * 展开大括号模式 {a,b,c}
 * 例如：src/{foo,bar}.ts → ['src/foo.ts', 'src/bar.ts']
 * 不支持嵌套大括号（保持简单）
 */
function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{');
  if (start === -1) return [pattern];
  const end = pattern.indexOf('}', start);
  if (end === -1) return [pattern];
  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  const options = pattern.slice(start + 1, end).split(',');
  const results: string[] = [];
  for (const opt of options) {
    results.push(...expandBraces(prefix + opt + suffix));
  }
  return results;
}

/**
 * 在 cwd 下递归扫描文件，返回匹配 glob 模式的所有文件相对路径
 *
 * @param pattern glob 模式（如 src 下递归所有 .ts）
 * @param cwd 工作目录
 * @returns 匹配的文件相对路径列表（按字典序）
 */
export async function expandGlob(pattern: string, cwd: string): Promise<string[]> {
  // 1. 展开大括号
  const patterns = expandBraces(pattern);
  const allMatches = new Set<string>();

  for (const p of patterns) {
    const matches = await expandSingleGlob(p, cwd);
    for (const m of matches) allMatches.add(m);
  }

  return Array.from(allMatches).sort();
}

/**
 * 展开单个 glob 模式（不含大括号）
 */
async function expandSingleGlob(pattern: string, cwd: string): Promise<string[]> {
  // 统一路径分隔符为正斜杠
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // 如果不含通配符，直接返回（调用方应已用 isGlobPattern 判断）
  if (!/[*?]/.test(normalizedPattern)) {
    return [pattern];
  }

  // 把模式按 / 拆分为段，逐段匹配
  const segments = normalizedPattern.split('/');
  const results: string[] = [];
  await walkAndMatch(cwd, '', segments, 0, results);
  return results;
}

/**
 * 递归遍历目录，按段匹配 glob
 *
 * @param cwd 工作根目录
 * @param relDir 当前相对目录（相对 cwd）
 * @param segments glob 拆分的段
 * @param segIdx 当前匹配到第几段
 * @param results 收集匹配的相对路径
 */
async function walkAndMatch(
  cwd: string,
  relDir: string,
  segments: string[],
  segIdx: number,
  results: string[],
): Promise<void> {
  if (segIdx >= segments.length) return;

  const seg = segments[segIdx];
  const isLast = segIdx === segments.length - 1;
  const currentAbsDir = relDir ? path.join(cwd, relDir) : cwd;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(currentAbsDir, { withFileTypes: true });
  } catch {
    return; // 目录不存在或无权限
  }

  if (seg === '**') {
    // ** 匹配任意层级目录
    // 1. ** 匹配当前层（即跳过 **，继续匹配下一段）
    await walkAndMatch(cwd, relDir, segments, segIdx + 1, results);
    // 2. ** 递归进入每个子目录，仍保持 segIdx（继续吃后续层级）
    for (const entry of entries) {
      if (entry.isDirectory() && !shouldSkipDir(entry.name)) {
        const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
        await walkAndMatch(cwd, childRel, segments, segIdx, results);
      }
    }
    return;
  }

  // 普通段：用正则匹配 entry 名
  const regex = globToRegExp(seg);
  for (const entry of entries) {
    if (!regex.test(entry.name)) continue;
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (isLast) {
      // 最后一段：只收文件（和符号链接）
      if (entry.isFile() || entry.isSymbolicLink()) {
        results.push(childRel);
      }
    } else {
      // 中间段：必须是目录才能继续下钻
      if (entry.isDirectory()) {
        await walkAndMatch(cwd, childRel, segments, segIdx + 1, results);
      }
    }
  }
}

/** 应跳过的目录（避免扫描 node_modules 等） */
function shouldSkipDir(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === 'out' || name === '.next' || name === 'build';
}
