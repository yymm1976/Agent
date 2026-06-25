// src/cli/commands/btw.ts
// /btw 命令：临时问答（advisor 子 Agent）
// 借鉴 kimi-code 的 /BTW 功能，用户可在 Agent 工作中途临时提问，不污染主上下文
//
// 流程：
//   1. 用户输入 /btw <问题>
//   2. 创建 advisor 子 Agent（无工具权限，isolated: true）
//   3. 传入当前对话历史作为只读上下文
//   4. 子 Agent 单次 LLM 调用回答问题
//   5. 结果显示给用户但不注入主对话历史

import type { CommandDefinition } from '../command-registry.js';
import type { LLMMessage } from '../../router/types.js';
import { logger } from '../../utils/logger.js';

/**
 * 将对话历史格式化为只读上下文文本
 * 截取最近的消息，避免上下文过长
 */
function formatHistoryAsContext(history: LLMMessage[], maxMessages: number = 20): string {
  const recent = history.slice(-maxMessages);
  if (recent.length === 0) {
    return '（暂无对话历史）';
  }
  return recent
    .map((msg, i) => {
      const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : '系统';
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      // 截取过长的单条消息
      const truncated = content.length > 500 ? content.slice(0, 500) + '...(已截断)' : content;
      return `[${i + 1}] ${roleLabel}: ${truncated}`;
    })
    .join('\n');
}

export const btwCommand: CommandDefinition = {
  name: 'btw',
  aliases: ['BTW'],
  description: '临时问答（advisor 子 Agent，不污染主上下文）',
  usage: '/btw <问题>',
  handler: async (args, ctx) => {
    const question = args.trim();
    if (!question) {
      return { type: 'handled', messages: ['用法: /btw <问题>'] };
    }

    const { commandBridge, toolExecutor } = ctx;

    // 获取当前对话历史作为只读上下文
    const history = commandBridge.getConversationHistory?.() ?? [];
    const historyContext = formatHistoryAsContext(history);

    commandBridge.addSystemMessage(`💡 /btw 临时问答：正在创建 advisor 子 Agent...`);

    // 构建 advisor 子 Agent 的 prompt（包含对话历史上下文 + 用户问题）
    const advisorPrompt = `你是一个临时顾问（advisor），负责回答用户的临时提问。

以下是当前对话的只读上下文（仅供参考，不要修改）：

--- 对话历史 ---
${historyContext}
--- 历史结束 ---

用户临时提问：${question}

请基于对话历史上下文（如有）回答用户的问题。回答应简洁、准确。这是一次性问答，不需要调用任何工具。`;

    try {
      // 调用 spawn_agent 创建 advisor 子 Agent
      // - subagentType: 'advisor'（无工具权限）
      // - isolated: true（结果不写回主历史）
      const result = await toolExecutor.executeTool(
        'spawn_agent',
        `btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        {
          description: `临时问答: ${question.slice(0, 50)}`,
          prompt: advisorPrompt,
          subagentType: 'advisor',
          isolated: true,
          maxIterations: 1,
        },
      );

      const isSuccess = !result.startsWith('[工具错误]');

      if (!isSuccess) {
        commandBridge.addSystemMessage(`❌ /btw 执行失败：${result}`);
        logger.warn('btw command: advisor sub-agent failed', { result });
        return { type: 'handled' };
      }

      // 结果显示给用户，但不注入主对话历史（isolated: true 已在 spawn_agent 层面保证）
      commandBridge.addSystemMessage('━━━ /btw 顾问回答 ━━━');
      commandBridge.addSystemMessage(result);

      logger.info('btw command completed', {
        questionLength: question.length,
        historyLength: history.length,
        resultLength: result.length,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('btw command failed', { error: msg });
      commandBridge.addSystemMessage(`❌ /btw 执行异常：${msg}`);
    }

    return { type: 'handled' };
  },
};
