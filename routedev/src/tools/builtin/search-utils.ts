// src/tools/builtin/search-utils.ts
// 搜索工具公共 utilities
// Phase 29 Task 5：提取 code-search.ts 和 file-search.ts 的重复代码（修复 A4）
//
// 提取的函数：
//   - walkDir：递归遍历目录
//   - isIgnoredPath：判断路径是否在忽略列表中
//   - matchGlob：简单的 glob 模式匹配
//   - isPathWithinAllowedDirs：路径边界校验（C1 修复，防御性深度防御）

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionContext } from '../types.js';

/** 忽略的目录列表（通用开发环境） */
const IGNORED_DIRS = ['node_modules', '.git', 'dist', '.next', 'coverage', '__pycache__'];

/**
 * 递归遍历目录，返回所有文件路径
 * @param dir 起始目录
 * @param maxFiles 最大文件数（防止过大目录导致性能问题）
 */
export async function walkDir(dir: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (files.length >= maxFiles) return;

    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * 判断路径是否在忽略列表中
 * @param relativePath 相对于搜索根目录的路径
 */
export function isIgnoredPath(relativePath: string): boolean {
  return IGNORED_DIRS.some(dir =>
    relativePath.startsWith(dir + path.sep) ||
    relativePath.includes(path.sep + dir + path.sep),
  );
}

/**
 * 简单的 glob 模式匹配
 * 支持 *（任意字符）和 ?（单字符）通配符
 * @param pattern glob 模式，如 "*.ts"、"test?.js"
 * @param filePath 待匹配的文件名
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  // I5 修复：转义所有 regex 特殊字符，仅保留 * 和 ? 作为通配符
  // 先转义所有特殊字符，再还原 * 和 ? 为通配符语义
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  const regex = new RegExp('^' + regexStr + '$');
  return regex.test(filePath);
}

/**
 * 路径边界校验：检查目标路径是否在允许的目录范围内
 * C1 修复：为所有文件工具提供防御性深度防御，防止路径遍历攻击
 * 即使 executor.ts 的外部检查被绕过，工具内部仍会拦截
 * @param targetPath 待检查的绝对路径
 * @param context 工具执行上下文
 * @returns 校验通过返回 null，校验失败返回错误消息
 */
export function checkPathBoundary(
  targetPath: string,
  context: ToolExecutionContext,
): string | null {
  const allowedDirs = context.allowedDirectories ?? [context.workingDirectory];
  // Windows 路径归一化：统一大小写 + 统一为正斜杠
  const normalize = (p: string): string => {
    return path.resolve(p).replace(/\\/g, '/').toLowerCase();
  };
  const normalizedTarget = normalize(targetPath);
  const isAllowed = allowedDirs.some(dir => {
    const normalizedDir = normalize(dir);
    return normalizedTarget === normalizedDir
      || normalizedTarget.startsWith(normalizedDir + '/');
  });
  if (!isAllowed) {
    return `路径超出项目边界: ${targetPath}（允许目录: ${allowedDirs.join(', ')}）`;
  }
  return null;
}
