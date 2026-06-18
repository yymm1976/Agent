#!/usr/bin/env node
// CLI 入口（Phase 4：Ink UI；Phase 13：支持 `serve` 子命令启动服务器模式）
// Phase 24 Task 8：启动时执行 Provider 配置完整性校验

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
import { parseArgs, printHelp, printVersion } from './cli/args.js';
import { getVersion } from './cli/splash.js';
import { validateProviders, formatValidationMessages } from './utils/provider-validator.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    printVersion();
    process.exit(0);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.command === 'serve') {
    await startServer(args.port, args.configPath);
    return;
  }

  if (args.command === 'config' && args.subArgs[0] === 'validate') {
    const { validateConfigCommand } = await import('./cli/commands/config.js');
    await validateConfigCommand(args.subArgs[1]);
    return;
  }

  try {
    // 加载配置（支持 -c 覆盖）
    const config = loadConfig({ globalConfigPath: args.configPath });

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

    // Phase 24 Task 8：Provider 配置完整性校验（不阻断启动）
    const validationResult = validateProviders(config, clientManager);
    const validationMessages = formatValidationMessages(validationResult);
    for (const msg of validationMessages) {
      logger.warn(msg);
    }

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

    // 初始化路由器（Phase 0c：传入 providers 配置，provider 推断优先从配置读取）
    const modelRouter = new ModelRouter(routerConfig, tracker, config.providers);

    logger.info('RouteDev started', {
      version: getVersion(),
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
      logger.error(`Startup failed: ${err.message}`, { stack: err.stack });
    }
    process.exit(1);
  }
}

main();
