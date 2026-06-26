// src/cli/commands/resume.ts
// 恢复执行命令：/resume [planId]
// Phase 27 Task 6：列出可恢复的执行快照，支持交互式选择或直接指定 planId 恢复
// Phase 50 Task 7：当有多个快照时触发 ResumePicker 组件渲染（受配置开关控制）

import type { CommandDefinition } from '../command-registry.js';
import { renderSnapshotListText } from '../components/ResumePicker.js';

export const resumeCommand: CommandDefinition = {
  name: 'resume',
  description: '恢复中断的执行（从断点继续）',
  usage: '/resume [planId]',
  handler: async (args, ctx) => {
    const { durableExecutor, commandBridge } = ctx;

    // 检查 DurableExecutor 是否可用
    if (!durableExecutor) {
      return {
        type: 'handled',
        messages: ['❌ 持久化执行器不可用，无法恢复执行。'],
      };
    }

    try {
      // 调用 listRecoverableAsync 获取可恢复列表
      const snapshots = await durableExecutor.listRecoverableAsync();

      // 无可恢复执行时显示友好提示
      if (snapshots.length === 0) {
        return {
          type: 'handled',
          messages: ['ℹ️ 无可恢复的执行。所有计划已完成或未启动。'],
        };
      }

      const planId = args.trim();

      // 直接指定 planId：从断点恢复
      if (planId) {
        const target = snapshots.find(s => s.planId === planId || s.planId.startsWith(planId));
        if (!target) {
          return {
            type: 'handled',
            messages: [`❌ 未找到计划 ${planId}。使用 /resume 查看可恢复列表。`],
          };
        }
        commandBridge.addSystemMessage(`🔄 正在从断点恢复执行: ${target.planId}...`);
        const result = await durableExecutor.resumeFrom(target.planId);
        if (result.success) {
          return {
            type: 'handled',
            messages: [`✓ 恢复成功: ${target.planId}（${result.snapshot.lastStepCompleted}/${result.snapshot.totalSteps} 步完成）`],
          };
        }
        return {
          type: 'handled',
          messages: [`❌ 恢复失败: ${result.error ?? '未知错误'}`],
        };
      }

      // Phase 50 Task 7：有多个快照时优先触发 ResumePicker 组件渲染
      // 若配置开关关闭或回调不存在，回退到纯文本列表
      if (
        snapshots.length > 1 &&
        ctx.config?.ui?.components?.resumePicker !== false &&
        commandBridge.showResumePicker
      ) {
        commandBridge.showResumePicker(snapshots);
        return { type: 'handled', messages: [] };
      }

      // 无 planId：显示可恢复列表（纯文本，交互式 UI 由 ResumePicker 组件提供）
      const listText = renderSnapshotListText(snapshots);
      return {
        type: 'handled',
        messages: [listText],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        type: 'handled',
        messages: [`❌ 恢复执行失败: ${msg}`],
      };
    }
  },
};
