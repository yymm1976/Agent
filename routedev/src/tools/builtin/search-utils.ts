// src/tools/builtin/search-utils.ts
// 搜索工具公共 utilities
// Phase 29 Task 5：提取 code-search.ts 和 file-search.ts 的重复代码（修复 A4）
//
// 提取的函数：
//   - walkDir：递归遍历目录
//   - isIgnoredPath：判断路径是否在忽略列表中
//   - matchGlob：简单的 glob 模式匹配

import fs from 'node:fs/promises';
import path from 'node:path';

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
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
  return regex.test(filePath);
}
