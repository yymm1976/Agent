#!/usr/bin/env node
// CLI 入口（Phase 2 版本：集成 LLM 客户端管理器）

import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { LLMClientManager } from './router/llm/index.js';

const VERSION = '0.2.0';

async function main(): Promise<void> {
  console.log(`RouteDev v${VERSION}`);
  console.log('---');

  try {
    // 加载配置
    const config = loadConfig();

    console.log(`Language:   ${config.general.language}`);
    console.log(`Theme:      ${config.general.theme}`);
    console.log(`Providers:  ${config.providers.length} configured`);
    console.log(`Router:     ${config.router.rules.length} rules, preference=${config.router.userPreference}`);
    console.log(`Security:   directoryBoundary=${config.security.directoryBoundary}`);
    console.log(`Autonomy:   default=${config.autonomy.defaultMode}`);
    console.log('---');

    // 初始化 LLM 客户端
    const clientManager = new LLMClientManager();
    clientManager.initializeFromConfig(
      config.providers.map((p) => ({
        id: p.id,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
      })),
    );

    // 显示客户端状态
    for (const [providerId, client] of clientManager.listAll()) {
      const status = client.isReady() ? 'ready' : 'not ready';
      console.log(`  LLM [${client.protocol}] ${providerId}: ${status}`);
    }

    console.log('---');
    console.log('Configuration loaded successfully.');
    console.log('(Router coming in Phase 3, CLI interface in Phase 4)');

    logger.info('RouteDev started', {
      version: VERSION,
      providers: config.providers.length,
      routerRules: config.router.rules.length,
      llmClients: clientManager.listAll().size,
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
