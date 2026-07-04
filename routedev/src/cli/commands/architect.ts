// src/cli/commands/architect.ts
// /architect 命令：切换到 architect 模式（对齐 Aider 的 architect 模式）
//
// 设计：
//   - 强模型规划 + 弱模型执行的二阶段流程
//   - system prompt 追加"先规划再编码"指令（由 ModeManager.getSystemPromptAddendum 提供）
//   - 工具调用需先输出计划，等待用户确认后再执行
//   - 工具集与 code 模式相同（全部可用）
//
// 实际工具过滤与 system prompt 注入由父 Agent（app-init.ts）读取
// modeManager 单例完成，本命令只负责切换模式并返回提示。

import type { CommandDefinition } from '../command-registry.js';
import { modeManager } from './mode-manager.js';

export const architectCommand: CommandDefinition = {
  name: 'architect',
  description: '切换到 architect 模式（强模型规划，弱模型执行）',
  usage: '/architect',
  handler: async () => {
    const previous = modeManager.getMode();
    modeManager.setMode('architect');
    return {
      type: 'handled',
      messages: [
        `🔄 已切换到 Architect 模式${previous === 'architect' ? '（已是此模式）' : `（来自 ${previous} 模式）`}`,
        `  ✅ 强模型规划：先分析需求、列出步骤与改动点`,
        `  ✅ 弱模型执行：用户确认计划后再编码落地`,
        `  ✅ 工具集：全部可用（file_edit / file_write / shell_exec 等）`,
        `  💡 system prompt 已追加"先规划再编码"指令`,
        `  💡 用 /code 切回默认编码模式，/ask 切到只读问答模式`,
      ],
    };
  },
};
