// src/cli/commands/config.ts

import { loadConfig } from '../../config/loader.js';

export async function validateConfigCommand(configPath?: string): Promise<void> {
  try {
    loadConfig({ globalConfigPath: configPath });
    console.log(`✓ 配置文件有效: ${configPath || '默认路径'}`);
    process.exit(0);
  } catch (error) {
    console.error(
      `✗ 配置文件无效: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
