// src/cli/commands/status.ts
// 系统状态命令：/status

import type { CommandDefinition } from '../command-registry.js';

export const statusCommand: CommandDefinition = {
  name: 'status',
  description: '显示系统状态',
  handler: async (_args, ctx) => {
    const { tracker, router, clientManager, config, checkpointManager, contextManager, branchManager, mcpManager, commandBridge } = ctx;
    const ready = clientManager.getReadyClients();
    const clients = clientManager.listAll();
    const stats = tracker.getStats();
    const state = commandBridge.getState();

    // 记忆状态
    const memoryCheckpoint = contextManager.getCheckpoint();
    const memoryStatus = memoryCheckpoint
      ? `有 (${memoryCheckpoint.currentIntent.slice(0, 30)})`
      : '无';

    // 检查点状态
    const cpCount = checkpointManager.count;
    const cpEnabled = checkpointManager.isEnabled;

    // 分支状态
    const branchCount = branchManager.listBranches().length;
    const activeBranchId = branchManager.getActiveBranchId()?.slice(0, 4) ?? '无';

    const lines = [
      '系统状态: 运行中',
      `模型就绪: ${ready.length}/${clients.size}`,
      `当前模型: ${state.currentModel}`,
      `场景等级: ${state.currentTier}`,
      `已降级: ${state.isDegraded ? '是' : '否'}`,
      `自治度模式: ${state.autonomyMode}`,
      `预算模式: ${config.router.budget.mode}`,
      `日预算: ${config.router.budget.dailyLimit}`,
      `Token 使用: ${stats.total.totalTokens ?? 0} tokens`,
      `对话历史: ${state.conversationHistoryLength} 条消息`,
      `检查点: ${cpCount} 个${cpEnabled ? '' : ' (未启用 / 非 Git 仓库)'}`,
      `记忆: ${memoryStatus}`,
      `分支: ${branchCount} 个 (active: ${activeBranchId})`,
      `MCP: ${state.mcpConnectedCount} 个 server, ${state.mcpTotalToolCount} 个工具`,
    ];
    return { type: 'handled', messages: [lines.join('\n')] };
  },
};
