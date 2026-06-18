// src/cli/commands/checkpoint.ts
// 检查点管理命令：/checkpoint create [描述] | /checkpoint list

import type { CommandDefinition } from '../command-registry.js';

export const checkpointCommand: CommandDefinition = {
  name: 'checkpoint',
  aliases: ['cp'],
  description: '检查点管理',
  usage: '/checkpoint create [描述] | /checkpoint list',
  handler: async (args, ctx) => {
    const { checkpointManager } = ctx;
    const parts = args.split(/\s+/);
    const sub = parts[0] || 'list';

    switch (sub) {
      case 'create': {
        const description = parts.slice(1).join(' ') || '手动创建的检查点';
        const cp = await checkpointManager.create({ description, isAutoCreated: false });
        if (!cp) {
          return { type: 'handled', messages: ['检查点创建失败（可能不在 Git 仓库中或未启用检查点）。'] };
        }
        return {
          type: 'handled',
          messages: [`💾 检查点已创建: cp-${cp.id} (${cp.gitCommitHash.slice(0, 7)}, ${cp.filesSnapshot.length} 个文件)`],
        };
      }
      case 'list': {
        const checkpoints = checkpointManager.list();
        if (checkpoints.length === 0) {
          return { type: 'handled', messages: ['暂无检查点。检查点会在 /goal 步骤执行前自动创建。'] };
        }
        const lines = checkpoints.map((cp, i) => {
          const time = new Date(cp.timestamp).toLocaleString('zh-CN');
          const auto = cp.isAutoCreated ? '自动' : '手动';
          const files = cp.filesSnapshot.length;
          return `  ${i + 1}. [cp-${cp.id}] ${cp.description}\n     ${time} | ${cp.gitCommitHash.slice(0, 7)} | ${files} 文件 | ${auto}`;
        });
        return { type: 'handled', messages: [`检查点列表 (${checkpoints.length}):\n${lines.join('\n')}`] };
      }
      default:
        return { type: 'handled', messages: ['用法: /checkpoint create [描述] | /checkpoint list'] };
    }
  },
};
