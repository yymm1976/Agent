// src/cli/commands/output-style.ts
// Phase 34：/output-style 命令——运行时切换信息密度

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';
import { parseOutputStyle, nextOutputStyle } from '../output-style.js';
import type { OutputStyle } from '../../config/schema.js';

export const outputStyleCommand: CommandDefinition = {
  name: 'output-style',
  aliases: ['style'],
  description: '切换或查看输出样式（信息密度）',
  usage: '/output-style [minimal|standard|verbose]',
  handler: async (args, ctx: ServiceContext) => {
    const current = ctx.config.ui.outputStyle;

    // 无参数：显示当前样式
    const trimmed = args.trim().toLowerCase();
    if (!trimmed) {
      return {
        type: 'handled',
        messages: [`当前输出样式: ${current}（minimal/standard/verbose）`],
      };
    }

    let target: OutputStyle;
    if (trimmed === 'next' || trimmed === 'cycle') {
      target = nextOutputStyle(current);
    } else {
      const parsed = parseOutputStyle(trimmed);
      if (!parsed) {
        return {
          type: 'handled',
          messages: [
            `无效的输出样式: "${args.trim()}"`,
            '用法: /output-style [minimal|standard|verbose|next]',
          ],
        };
      }
      target = parsed;
    }

    // 运行时切换：通过 CommandBridge 更新 UI 状态与内存配置
    ctx.commandBridge.setOutputStyle(target);

    return {
      type: 'handled',
      messages: [`输出样式已切换: ${current} → ${target}`],
    };
  },
};
