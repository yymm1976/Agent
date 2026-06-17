// src/cli/commands/memory.ts

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';

export const memoryCommand: CommandDefinition = {
  name: 'memory',
  description: '管理项目记忆',
  usage: '/memory [show|notes|write|clear]',
  handler: async (args, ctx) => {
    const { checkpointWriter, projectMemory, prompts, audit } = ctx;
    const sub = args.trim().toLowerCase();

    switch (sub) {
      case 'show': {
        const status = await projectMemory.getStatus();
        const lines = [
          '## 项目记忆状态',
          `rules.md: ${status.files.rules.exists ? '存在' : '缺失'}`,
          `MEMORY.md: ${status.files.memory.exists ? '存在' : '缺失'}`,
          `decisions.log: ${status.files.decisions.exists ? status.files.decisions.count + ' 条' : '缺失'}`,
          `context.md: ${status.files.context.exists ? '存在' : '缺失'}`,
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      case 'notes': {
        const notes = await checkpointWriter.readNotes();
        return { type: 'handled', messages: [notes || '（notes.md 为空）'] };
      }

      case 'write': {
        // 触发 checkpoint 写入（异步，不阻塞）
        checkpointWriter
          .write({
            recentMessages: [],
            notes: '',
            previousCheckpoint: null,
            usagePercent: 0,
            level: 'incremental',
          })
          .catch(() => {});
        audit.log('checkpoint_create', 'manual', { reason: '/memory write' });
        return { type: 'handled', messages: ['已触发检查点写入。'] };
      }

      case 'clear': {
        await projectMemory.clearMemory();
        return { type: 'handled', messages: ['已清空 MEMORY.md。'] };
      }

      default: {
        const lines = [
          '用法：/memory <subcommand>',
          '  show  — 显示检查点和项目记忆状态',
          '  notes — 查看 notes.md',
          '  write — 手动触发检查点写入',
          '  clear — 清空 MEMORY.md',
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }
    }
  },
};
