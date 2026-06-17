#!/usr/bin/env node
// CLI 入口（Phase 4：Ink UI；Phase 13：支持 `serve` 子命令启动服务器模式）

import React from 'react';
import { render } from 'ink';
import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { LLMClientManager } from './router/llm/index.js';
import { TokenTracker } from './router/tracker.js';
import { ScenarioClassifier } from './router/classifier.js';
import { ModelRouter } from './router/router.js';
import { buildRouterConfig } from './router/config.js';
import { App } from './cli/App.js';
import { startServer } from './cli/server.js';

const VERSION = '0.13.0';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (subcommand === '--version' || subcommand === '-v') {
    console.log(`RouteDev v${VERSION}`);
    process.exit(0);
  }

  if (subcommand === 'serve') {
    await startServer();
    return;
  }

  try {
    // 加载配置
    const config = loadConfig();

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

    // 初始化分类器
    const readyClients = clientManager.getReadyClients();
    const classifierClient = readyClients.length > 0 ? readyClients[0].client : undefined;
    const classifier = new ScenarioClassifier({
      llmClient: classifierClient,
      classifierModel: routerConfig.classifierModel,
    });

    // 初始化路由器
    const modelRouter = new ModelRouter(routerConfig, tracker);

    logger.info('RouteDev started', {
      version: VERSION,
      providers: config.providers.length,
      routerRules: config.router.rules.length,
      llmClients: clientManager.listAll().size,
    });

    // 渲染 Ink UI
    render(
      React.createElement(App, {
        config,
        clientManager,
        classifier,
        modelRouter,
        tracker,
      }),
      {
        exitOnCtrlC: true,
      }
    );
  } catch (err) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
      logger.error('Startup failed', { error: err.message, stack: err.stack });
    }
    process.exit(1);
  }
}

main();
