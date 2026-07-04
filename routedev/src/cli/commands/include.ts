// src/cli/commands/include.ts
// /include 命令：将文件加入上下文（对齐 Aider 的 /add）
//
// 设计：
//   - /include <file-path>          加入单个文件
//   - /include <f1> <f2> ...        批量加入
//   - /include                      无参数：列出当前已包含文件
//   - /include -remove <file-path>  从上下文移除文件
//   - 支持 glob 模式（src/**/*.ts）
//
// 实现要点：
//   - 使用 cliContextManager 单例存储 path -> content
//   - glob 展开在 cwd 下递归扫描，匹配后逐个加入
//   - 单文件路径直接加入（不做 glob 匹配）

import type { CommandDefinition } from '../command-registry.js';
import { cliContextManager } from './context-manager.js';
import { expandGlob, isGlobPattern } from './glob.js';

export const includeCommand: CommandDefinition = {
  name: 'include',
  aliases: ['add'],
  description: '将文件加入上下文（对齐 Aider /add，支持 glob）',
  usage: '/include [<file-path>... | -remove <file-path>]',
  handler: async (args, ctx) => {
    const trimmed = args.trim();

    // 无参数：列出当前已包含文件
    if (!trimmed) {
      return listIncludedFiles();
    }

    // -remove <file-path>：移除文件
    if (trimmed.startsWith('-remove ') || trimmed === '-remove') {
      const target = trimmed.slice('-remove'.length).trim();
      if (!target) {
        return { type: 'handled', messages: ['❌ 用法: /include -remove <file-path>'] };
      }
      // -remove 也支持 glob（移除所有匹配的）
      if (isGlobPattern(target)) {
        const matches = await expandGlob(target, ctx.cwd);
        if (matches.length === 0) {
          return { type: 'handled', messages: [`❌ 未匹配到文件: ${target}`] };
        }
        let removed = 0;
        for (const m of matches) {
          if (cliContextManager.removeFile(m, ctx.cwd)) removed++;
        }
        return {
          type: 'handled',
          messages: [
            `✓ 已从上下文移除 ${removed} 个文件（匹配 ${target}，命中 ${matches.length} 个）`,
            `  当前上下文剩余: ${cliContextManager.size()} 个文件`,
          ],
        };
      }
      const ok = cliContextManager.removeFile(target, ctx.cwd);
      return ok
        ? { type: 'handled', messages: [`✓ 已移除: ${target}`, `  当前上下文剩余: ${cliContextManager.size()} 个文件`] }
        : { type: 'handled', messages: [`❌ 文件不在上下文中: ${target}`] };
    }

    // 未知 flag
    if (trimmed.startsWith('-')) {
      return { type: 'handled', messages: [`❌ 未知参数: ${trimmed.split(/\s+/)[0]}`, '用法: /include [<file-path>... | -remove <file-path>]'] };
    }

    // 加入文件：按空白分割，逐个处理（每个参数可能是 glob 或单文件）
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const added: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const token of tokens) {
      if (isGlobPattern(token)) {
        // glob 展开并批量加入
        let matches: string[];
        try {
          matches = await expandGlob(token, ctx.cwd);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          failed.push(`${token}（glob 展开失败: ${msg}）`);
          continue;
        }
        if (matches.length === 0) {
          skipped.push(`${token}（无匹配文件）`);
          continue;
        }
        for (const m of matches) {
          const r = await cliContextManager.addFile(m, ctx.cwd);
          if (r.added) added.push(m);
          else skipped.push(`${m}（${r.reason}）`);
        }
      } else {
        const r = await cliContextManager.addFile(token, ctx.cwd);
        if (r.added) added.push(token);
        else skipped.push(`${token}（${r.reason}）`);
      }
    }

    const lines: string[] = [];
    if (added.length > 0) {
      lines.push(`✓ 已加入 ${added.length} 个文件:`);
      for (const f of added) lines.push(`  + ${f}`);
    }
    if (skipped.length > 0) {
      lines.push(`⚠️  跳过 ${skipped.length} 个:`);
      for (const f of skipped) lines.push(`  - ${f}`);
    }
    if (failed.length > 0) {
      lines.push(`❌ 失败 ${failed.length} 个:`);
      for (const f of failed) lines.push(`  ! ${f}`);
    }
    lines.push(`  当前上下文共: ${cliContextManager.size()} 个文件`);
    return { type: 'handled', messages: [lines.join('\n')] };
  },
};

/** 列出当前已包含文件 */
function listIncludedFiles(): { type: 'handled'; messages: string[] } {
  const files = cliContextManager.getFiles();
  if (files.length === 0) {
    return { type: 'handled', messages: ['当前上下文为空（未包含任何文件）。', '用法: /include <file-path> 加入文件'] };
  }
  const lines = [`当前上下文已包含 ${files.length} 个文件:`];
  let totalSize = 0;
  let totalLines = 0;
  for (const f of files) {
    lines.push(`  ${f.path}  (${f.lines} 行, ${formatSize(f.size)})`);
    totalSize += f.size;
    totalLines += f.lines;
  }
  lines.push(`  合计: ${totalLines} 行, ${formatSize(totalSize)}`);
  return { type: 'handled', messages: [lines.join('\n')] };
}

/** 格式化字节数为人类可读 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
