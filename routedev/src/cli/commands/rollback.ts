// src/cli/commands/rollback.ts
// 回滚到指定检查点命令：/rollback <checkpoint-id>

import type { CommandDefinition } from '../command-registry.js';

export const rollbackCommand: CommandDefinition = {
  name: 'rollback',
  description: '回滚到指定检查点（破坏性操作）',
  usage: '/rollback <checkpoint-id>',
  handler: async (args, ctx) => {
    const { checkpointManager, commandBridge } = ctx;
    const id = args.trim();
    if (!id) {
      return { type: 'handled', messages: ['用法: /rollback <checkpoint-id>\n使用 /checkpoint list 查看可用检查点。'] };
    }

    // 支持前缀匹配
    const checkpoints = checkpointManager.list();
    const target = checkpoints.find(c => c.id === id || c.id.startsWith(id));
    if (!target) {
      return { type: 'handled', messages: [`未找到检查点 "${id}"。使用 /checkpoint list 查看可用检查点。`] };
    }

    const confirmed = await commandBridge.requestConfirm(
      [
        `⚠️ 即将回滚到检查点: cp-${target.id}`,
        `  描述: ${target.description}`,
        `  提交: ${target.gitCommitHash.slice(0, 7)}`,
        `  时间: ${new Date(target.timestamp).toLocaleString('zh-CN')}`,
        '',
        '⚠️ 这是破坏性操作（git reset --hard），回滚后当前未提交的变更将丢失！',
      ].join('\n'),
    );
    if (!confirmed) {
      return { type: 'handled', messages: ['回滚已取消。'] };
    }

    const success = await checkpointManager.rollback(target.id);
    if (!success) {
      return { type: 'handled', messages: ['回滚失败。请检查 Git 状态。'] };
    }
    commandBridge.clearChat();
    const remaining = checkpointManager.count;
    return {
      type: 'handled',
      messages: [`✓ 已回滚到 cp-${target.id} (${target.gitCommitHash.slice(0, 7)})。剩余 ${remaining} 个检查点。`],
    };
  },
};
