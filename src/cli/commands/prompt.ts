// src/cli/commands/prompt.ts

import type { CommandDefinition } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';

export const promptCommand: CommandDefinition = {
  name: 'prompt',
  description: '管理 Prompt 模板',
  usage: '/prompt [list|show <id>|render <id>]',
  handler: async (args, ctx) => {
    const { prompts } = ctx;
    const [sub, id] = args.trim().split(/\s+/);

    switch (sub) {
      case 'list': {
        const list = prompts.listBuiltinTemplates();
        const lines = ['内置模板:'];
        for (const t of list) {
          lines.push(`  ${t.id} — ${t.name}`);
        }
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      case 'show': {
        if (!id) return { type: 'handled', messages: ['用法: /prompt show <id>'] };
        const t = await prompts.getTemplate(id);
        const lines = [
          `ID: ${t.id}`,
          `名称: ${t.name}`,
          `来源: ${t.source}`,
          `变量: ${t.variables.join(', ') || '无'}`,
          `内容:\n${t.content.slice(0, 500)}`,
        ];
        return { type: 'handled', messages: [lines.join('\n')] };
      }

      case 'render': {
        if (!id) return { type: 'handled', messages: ['用法: /prompt render <id>'] };
        const rendered = await prompts.render(id, {
          language: 'zh',
          autonomyMode: 'auto',
          projectRules: '（示例规则）',
          projectMemory: '（示例记忆）',
          blackboard: '（示例黑板）',
          availableTools: '（示例工具）',
          conversationContext: '（示例上下文）',
        });
        return { type: 'handled', messages: [rendered.slice(0, 800)] };
      }

      default:
        return { type: 'handled', messages: ['用法: /prompt [list|show <id>|render <id>]'] };
    }
  },
};
