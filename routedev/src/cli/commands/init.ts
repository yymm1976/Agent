// src/cli/commands/init.ts
// 项目分析命令：/init

import type { CommandDefinition } from '../command-registry.js';

export const initCommand: CommandDefinition = {
  name: 'init',
  description: '分析项目结构生成 .routedev-rules.md',
  handler: async (_args, ctx) => {
    const { initAnalyzer, commandBridge } = ctx;

    commandBridge.addSystemMessage('🔍 正在分析项目结构...');
    try {
      const info = await initAnalyzer.analyze();
      const rules = await initAnalyzer.generateRules(info);
      const filePath = await initAnalyzer.saveRules(rules);
      return {
        type: 'handled',
        messages: [
          `✓ 项目规则已生成: ${filePath}\n- 主要语言: ${info.primaryLanguage}\n- 检测到框架: ${info.detectedFrameworks.join(', ') || '无'}\n- 包含测试: ${info.hasTests ? '是' : '否'}`,
        ],
      };
    } catch (error) {
      return { type: 'handled', messages: [`❌ /init 失败: ${error instanceof Error ? error.message : String(error)}`] };
    }
  },
};
