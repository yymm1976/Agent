// src/cli/commands/code.ts
// /code 命令：切换到 code 模式（默认模式，直接编码）
//
// 设计：
//   - code 是默认模式，所有工具可用，无额外 system prompt
//   - 从 architect 模式或 ask 模式切回 code 模式
//   - 对齐 Aider 的 code 模式（默认 editor）

import type { CommandDefinition } from '../command-registry.js';
import { modeManager } from './mode-manager.js';

export const codeCommand: CommandDefinition = {
  name: 'code',
  description: '切换到 code 模式（默认模式，直接编码）',
  usage: '/code',
  handler: async () => {
    const previous = modeManager.getMode();
    modeManager.setMode('code');
    return {
      type: 'handled',
      messages: [
        `🔄 已切换到 Code 模式${previous === 'code' ? '（已是此模式）' : `（来自 ${previous} 模式）`}`,
        `  ✅ 直接编码：所有工具可用（file_edit / file_write / shell_exec 等）`,
        `  ✅ system prompt：默认（无追加指令）`,
        `  💡 用 /architect 切到规划先行模式，/ask 切到只读问答模式`,
      ],
    };
  },
};
