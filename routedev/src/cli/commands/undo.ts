// src/cli/commands/undo.ts
// /undo 命令：撤销最近一次文件编辑（Aider 风格）
//
// 设计：
//   - 单次编辑级别的撤销（不是 git commit 级别）
//   - 从 EditHistory 单例弹栈，恢复编辑前的文件内容
//   - 进程内存级（不持久化，重启清空）
//   - 栈为空时提示"无可撤销操作"
//
// 用法：/undo

import fs from 'node:fs/promises';
import type { CommandDefinition } from '../command-registry.js';
import { editHistory } from '../../tools/builtin/edit-history.js';

export const undoCommand: CommandDefinition = {
  name: 'undo',
  description: '撤销最近一次文件编辑（Aider 风格，单次编辑级别）',
  usage: '/undo',
  handler: async () => {
    const entry = editHistory.pop();
    if (!entry) {
      return { type: 'handled', messages: ['无可撤销操作（编辑历史栈为空）。'] };
    }

    try {
      // 恢复编辑前的原始内容
      await fs.writeFile(entry.filePath, entry.content, 'utf-8');
      const time = new Date(entry.timestamp).toLocaleString('zh-CN');
      return {
        type: 'handled',
        messages: [
          `✓ 已撤销最近一次编辑`,
          `  文件: ${entry.filePath}`,
          `  编辑时间: ${time}`,
          `  剩余可撤销操作: ${editHistory.size()}`,
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 恢复失败：把条目推回栈，避免丢失历史
      editHistory.push(entry.filePath, entry.content);
      return {
        type: 'handled',
        messages: [`❌ 撤销失败: ${msg}`],
      };
    }
  },
};
