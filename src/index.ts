#!/usr/bin/env node
// CLI 入口（Phase 3 版本：集成分类器 + 路由器 + Token 追踪器）

import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { LLMClientManager } from './router/llm/index.js';
import { TokenTracker } from './router/tracker.js';
import { ScenarioClassifier } from './router/classifier.js';
import { ModelRouter } from './router/router.js';
import { buildRouterConfig } from './router/config.js';

const VERSION = '0.3.0';

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

    // 构建路由配置
    const routerConfig = buildRouterConfig(config);

    // 初始化 Token 追踪器
    const tracker = new TokenTracker(routerConfig.budget);

    // 初始化分类器（使用第一个可用的 LLM 客户端）
    const readyClients = clientManager.getReadyClients();
    const classifierClient = readyClients.length > 0 ? readyClients[0].client : undefined;
    const classifier = new ScenarioClassifier({
      llmClient: classifierClient,
      classifierModel: routerConfig.classifierModel,
    });

    // 初始化路由器
    const router = new ModelRouter(routerConfig, tracker);

    // 显示客户端状态
    for (const [providerId, client] of clientManager.listAll()) {
      const status = client.isReady() ? 'ready' : 'not ready';
      console.log(`  LLM [${client.protocol}] ${providerId}: ${status}`);
    }

    console.log('---');
    console.log('Router initialized:');
    console.log(`  Budget mode: ${routerConfig.budget.mode}`);
    console.log(`  Daily limit: ${routerConfig.budget.dailyLimit} tokens`);
    console.log(`  Rules: ${routerConfig.rules.length}`);
    console.log('---');

    // 演示分类 + 路由
    const demoQueries = [
      '/help',
      'git status',
      '分析一下这个架构',
      '重构这个模块',
    ];

    console.log('Demo classification + routing:');
    for (const query of demoQueries) {
      const classification = await classifier.classify({ query });
      const routing = await router.route(classification);
      console.log(`  "${query}"`);
      console.log(`    → tier: ${classification.tier} (${classification.source})`);
      console.log(`    → model: ${routing.model.id}${routing.degraded ? ' (degraded)' : ''}`);
    }

    console.log('---');
    console.log('Configuration loaded successfully.');
    console.log('(CLI interface coming in Phase 4)');

    // 清理
    tracker.destroy();

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
