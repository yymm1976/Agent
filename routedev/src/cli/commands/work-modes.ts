// src/cli/commands/work-modes.ts
// 工作模式切换命令：/build /plan /compose（蓝图第十二节）
// 与自治度模式（/auto /semi /manual）正交：WorkMode 控制"能做什么类型的操作"

import type { CommandDefinition } from '../command-registry.js';
import type { WorkMode } from '../../agent/work-modes.js';

/** 模式说明表 */
const MODE_INFO: Record<WorkMode, { label: string; allowed: string; blocked: string }> = {
  build: {
    label: 'Build（读写执行）',
    allowed: '文件读写、Shell 执行、Git 操作、MCP 工具',
    blocked: '无限制',
  },
  plan: {
    label: 'Plan（只读分析）',
    allowed: '文件读取、代码搜索、目录浏览、只读 Git 命令',
    blocked: '文件写入/编辑、Shell 写入命令、Git 写操作、MCP 工具',
  },
  compose: {
    label: 'Compose（编排全流程）',
    allowed: '全部操作 + 自动管线编排（需求→编码→测试→审查）',
    blocked: '无限制（管线自动推进）',
  },
};

/** 工厂函数：创建工作模式切换命令 */
function makeWorkModeCommand(name: string, mode: WorkMode): CommandDefinition {
  const info = MODE_INFO[mode];
  return {
    name,
    description: `切换到${info.label}模式`,
    handler: async (_args, ctx) => {
      ctx.commandBridge.setWorkMode(mode);
      return {
        type: 'handled',
        messages: [
          `🔄 已切换到 ${info.label} 模式`,
          `  ✅ 允许: ${info.allowed}`,
          `  🚫 拦截: ${info.blocked}`,
        ],
      };
    },
  };
}

export const buildCommand = makeWorkModeCommand('build', 'build');
export const planCommand = makeWorkModeCommand('plan', 'plan');
export const composeCommand = makeWorkModeCommand('compose', 'compose');
