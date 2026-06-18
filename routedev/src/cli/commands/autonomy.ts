// src/cli/commands/autonomy.ts
// 自治模式切换命令：/auto /semi /manual

import type { CommandDefinition } from '../command-registry.js';
import type { AutonomyMode } from '../../config/schema.js';

/** 模式标签映射 */
const MODE_LABELS: Record<AutonomyMode, string> = {
  auto: '全自动',
  semi: '半自动',
  manual: '手动',
};

/** 模式图标映射 */
const MODE_ICONS: Record<AutonomyMode, string> = {
  auto: '🤖',
  semi: '🌓',
  manual: '🖐️',
};

/** 工厂函数：创建模式切换命令 */
function makeModeCommand(name: string, mode: AutonomyMode): CommandDefinition {
  return {
    name,
    description: `切换到${MODE_LABELS[mode]}模式`,
    handler: async (_args, ctx) => {
      ctx.commandBridge.setAutonomyMode(mode);
      return {
        type: 'handled',
        messages: [`${MODE_ICONS[mode]} 已切换到 ${MODE_LABELS[mode]}模式`],
      };
    },
  };
}

export const autoCommand = makeModeCommand('auto', 'auto');
export const semiCommand = makeModeCommand('semi', 'semi');
export const manualCommand = makeModeCommand('manual', 'manual');
