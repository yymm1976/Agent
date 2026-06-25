// src/cli/commands/config.ts

import { loadConfig } from '../../config/loader.js';
import { logger } from '../../utils/logger.js';
import type { CommandDefinition } from '../command-registry.js';
import { getGlobalConfigPath, getProjectConfigPath } from '../../utils/paths.js';

export async function validateConfigCommand(configPath?: string): Promise<void> {
  try {
    loadConfig({ globalConfigPath: configPath });
    logger.info(`✓ 配置文件有效: ${configPath || '默认路径'}`);
    process.exit(0);
  } catch (error) {
    logger.error(
      `配置文件无效: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

/**
 * /config 命令——显示配置文件路径和状态
 * Phase 31 Task 7.3：注册已定义但未注册的命令
 */
export const configCommand: CommandDefinition = {
  name: 'config',
  description: '显示配置文件路径和状态',
  usage: '/config [path|validate]',
  handler: async (args, ctx) => {
    const sub = args.trim().toLowerCase();

    if (sub === 'path') {
      const globalPath = getGlobalConfigPath();
      const projectPath = getProjectConfigPath(ctx.cwd);
      const lines = [
        '## 配置文件路径',
        `全局配置: ${globalPath}`,
        `项目配置: ${projectPath}`,
      ];
      return { type: 'handled', messages: [lines.join('\n')] };
    }

    if (sub === 'validate') {
      try {
        loadConfig({});
        return { type: 'handled', messages: ['✓ 配置文件有效'] };
      } catch (error) {
        return {
          type: 'handled',
          messages: [`✗ 配置文件无效: ${error instanceof Error ? error.message : String(error)}`],
        };
      }
    }

    // 默认：显示帮助
    const lines = [
      '## /config 命令',
      '用法:',
      '  /config path      — 显示配置文件路径',
      '  /config validate  — 验证配置文件有效性',
    ];
    return { type: 'handled', messages: [lines.join('\n')] };
  },
};
