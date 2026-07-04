// src/cli/commands/ask.ts
// /ask 命令：只问答不修改文件（对齐 Aider 的 /ask）
//
// 设计：
//   - /ask <question>  切到 ask 模式并提交问题
//   - ask 模式下禁用所有写工具（file_edit / file_write / shell_exec）
//   - 只允许读工具（file_read / file_search / code_search / code_graph_query / repo_map）
//   - 问题回答后自动恢复原模式（由 modeManager.restoreMode() 完成）
//
// 自动恢复机制：
//   - 命令把当前模式保存到 modeManager.previousMode，切到 ask
//   - 返回 passthrough，让父 Agent 把问题发给 LLM（在 ask 模式下工具被过滤）
//   - 父 Agent 在 LLM 循环结束后调用 modeManager.restoreMode() 恢复原模式
//   - 也可由用户手动 /code 恢复

import type { CommandDefinition } from '../command-registry.js';
import { modeManager } from './mode-manager.js';

export const askCommand: CommandDefinition = {
  name: 'ask',
  description: '只问答不修改文件（ask 模式，禁用写工具）',
  usage: '/ask <question>',
  handler: async (args, ctx) => {
    const question = args.trim();
    if (!question) {
      return {
        type: 'handled',
        messages: [
          '❌ 用法: /ask <question>',
          '  示例: /ask 这个函数是做什么的？',
          '  💡 ask 模式下只允许读工具，回答后自动恢复原模式',
        ],
      };
    }

    const previous = modeManager.getMode();
    modeManager.setMode('ask');
    // 通知 UI：已进入 ask 模式
    ctx.commandBridge.addSystemMessage(
      [
        `🔄 进入 Ask 模式（来自 ${previous} 模式）`,
        `  ✅ 允许: file_read / file_search / code_search / code_graph_query / repo_map`,
        `  🚫 禁用: file_edit / file_write / shell_exec`,
        `  💡 回答完成后将自动恢复到 ${previous} 模式`,
      ].join('\n'),
    );

    // 返回 passthrough：问题交给 LLM 处理（在 ask 模式下工具被过滤）
    // 父 Agent 在 LLM 循环结束后应调用 modeManager.restoreMode() 恢复
    return { type: 'passthrough', input: question };
  },
};
