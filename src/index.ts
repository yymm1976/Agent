#!/usr/bin/env node
// CLI 入口（Phase 1 版本：仅展示配置加载结果，Phase 4+ 替换为 Ink UI）

import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  console.log(`RouteDev v${VERSION}`);
  console.log('---');

  try {
    // 尝试加载配置
    const config = loadConfig();

    console.log(`Language:   ${config.general.language}`);
    console.log(`Theme:      ${config.general.theme}`);
    console.log(`Providers:  ${config.providers.length} configured`);
    console.log(`Router:     ${config.router.rules.length} rules, preference=${config.router.userPreference}`);
    console.log(`Security:   directoryBoundary=${config.security.directoryBoundary}`);
    console.log(`Autonomy:   default=${config.autonomy.defaultMode}`);
    console.log('---');
    console.log('Configuration loaded successfully.');
    console.log('(CLI interface coming in Phase 4)');

    logger.info('RouteDev started', {
      version: VERSION,
      providers: config.providers.length,
      routerRules: config.router.rules.length,
    });
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
      logger.error('Startup failed', { error: err.message, stack: err.stack });
    }
    process.exit(1);
  }
}

main();
