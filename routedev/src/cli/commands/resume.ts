// src/cli/commands/resume.ts
// 恢复执行命令：/resume [planId]
// 读取 GoalPersistence 的 .routedev/goals/<id>.json 状态文件，列出可恢复的目标，
// 用户选择后重新进入 /goal 流程恢复执行。

import type { CommandDefinition } from '../command-registry.js';
import { renderSnapshotListText } from '../components/ResumePicker.js';
import { GoalPersistence } from '../../agent/goal-persistence.js';
import { logger } from '../../utils/logger.js';

export const resumeCommand: CommandDefinition = {
  name: 'resume',
  description: '恢复中断的目标执行（从 .routedev/goals 断点恢复）',
  usage: '/resume [planId]',
  handler: async (args, ctx) => {
    const { commandBridge, cwd } = ctx;

    // 基于 cwd 实例化 GoalPersistence，读取 .routedev/goals/<id>.json
    const goalPersistence = new GoalPersistence(cwd);

    try {
      // 列出可恢复的目标（status 为 executing 或 paused）
      const goals = await goalPersistence.listResumable();

      // 无可恢复目标时给出明确提示
      if (goals.length === 0) {
        return {
          type: 'handled',
          messages: [
            '⚠️ 无可恢复的目标。',
            '',
            '可能原因：',
            '  1. 尚未通过 /goal 执行过目标（.routedev/goals/ 目录为空）',
            '  2. config.goalIntegration.persistenceEnabled 未开启（目标未持久化）',
            '  3. 所有目标已完成或已归档',
          ],
        };
      }

      const planId = args.trim();

      // 直接指定 planId：重新进入 /goal 流程恢复执行
      if (planId) {
        const target = goals.find(g => g.id === planId || g.id.startsWith(planId));
        if (!target) {
          return {
            type: 'handled',
            messages: [`❌ 未找到目标 ${planId}。使用 /resume 查看可恢复列表。`],
          };
        }
        const goalText = target.spec?.goal ?? '';
        if (!goalText) {
          return {
            type: 'handled',
            messages: [`❌ 目标 ${target.id} 缺失 spec.goal 字段，无法恢复。`],
          };
        }
        commandBridge.addSystemMessage(`🔄 从断点恢复执行: ${target.id}（重新进入 /goal 流程）`);
        logger.debug('resume: re-entering /goal flow', { planId: target.id, status: target.status });
        commandBridge.startGoal(goalText);
        return { type: 'handled', messages: [] };
      }

      // 有多个目标且 ResumePicker 开启时触发交互式选择
      if (
        goals.length > 1 &&
        ctx.config?.ui?.components?.resumePicker !== false &&
        commandBridge.showResumePicker
      ) {
        commandBridge.showResumePicker(goals);
        return { type: 'handled', messages: [] };
      }

      // 无 planId：显示可恢复列表（纯文本，交互式 UI 由 ResumePicker 组件提供）
      const listText = renderSnapshotListText(goals);
      return {
        type: 'handled',
        messages: [listText],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('resume: failed to list recoverable goals', { error: msg });
      return {
        type: 'handled',
        messages: [`❌ 恢复执行失败: ${msg}`],
      };
    }
  },
};
