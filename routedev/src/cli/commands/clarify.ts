// src/cli/commands/clarify.ts
// /clarify 命令：需求澄清追问
// 调用 RequirementsClarifier 分析目标模糊度，展示追问问题，收集回答后调用 enrichGoal

import type { CommandDefinition } from '../command-registry.js';
import { RequirementsClarifier } from '../../agent/requirements-clarifier.js';
import { logger } from '../../utils/logger.js';

export const clarifyCommand: CommandDefinition = {
  name: 'clarify',
  description: '需求澄清追问',
  usage: '/clarify "目标描述"',
  handler: async (args, ctx) => {
    const goalText = args.trim();
    if (!goalText) {
      return { type: 'handled', messages: ['用法: /clarify "目标描述"'] };
    }

    // 从配置读取澄清参数
    const clarificationConfig = ctx.config.optimization?.clarification;
    const enabled = clarificationConfig?.enabled ?? true;
    if (!enabled) {
      return { type: 'handled', messages: ['需求澄清已禁用（optimization.clarification.enabled=false）'] };
    }

    // 获取分类器模型（便宜模型）作为澄清器使用的模型
    const modelId = ctx.config.router?.classifierModel ?? 'deepseek-v4-flash';

    // 从 clientManager 获取一个可用的 LLM 客户端
    const readyClients = ctx.clientManager.getReadyClients();
    if (readyClients.length === 0) {
      return { type: 'handled', messages: ['错误：没有可用的 LLM 客户端，无法执行需求澄清'] };
    }
    const llmClient = readyClients[0].client;

    const clarifier = new RequirementsClarifier({
      llmClient,
      modelId,
      threshold: clarificationConfig?.threshold,
      maxQuestions: clarificationConfig?.maxQuestions,
      skipIfConfident: clarificationConfig?.skipIfConfident,
    });

    try {
      // 第一步：分析模糊度
      const result = await clarifier.clarify(goalText);

      if (!result.needsClarification) {
        const scorePercent = (result.score * 100).toFixed(0);
        return {
          type: 'handled',
          messages: [
            `目标清晰度足够（模糊度 ${scorePercent}%），无需澄清，可直接执行。`,
            `目标：${goalText}`,
          ],
        };
      }

      // 第二步：展示追问问题
      const messages: string[] = [];
      const scorePercent = (result.score * 100).toFixed(0);
      messages.push(`目标模糊度 ${scorePercent}%，需要澄清以下问题：`);
      messages.push('');

      for (const q of result.questions) {
        const optionalTag = q.optional ? '（可选）' : '（必填）';
        messages.push(`[${q.id}] ${q.question} ${optionalTag}`);
        if (q.context) {
          messages.push(`  原因：${q.context}`);
        }
        if (q.options && q.options.length > 0) {
          messages.push(`  选项：${q.options.join(' / ')}`);
        }
        messages.push('');
      }

      messages.push('请回答以上问题后，将回答补充到 /goal 命令的目标描述中重新执行。');

      // 第三步：如果有回答则合并到目标（当前简化版：无交互式收集，直接展示）
      // 完整交互流程需要 CommandBridge 支持多轮输入，此处先实现展示层
      logger.info('clarify command: questions generated', {
        questionCount: result.questions.length,
        score: result.score,
      });

      return { type: 'handled', messages };
    } catch (error) {
      logger.error('clarify command failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        type: 'handled',
        messages: [
          `需求澄清失败：${error instanceof Error ? error.message : String(error)}`,
          '可以直接使用 /goal 执行目标。',
        ],
      };
    }
  },
};
