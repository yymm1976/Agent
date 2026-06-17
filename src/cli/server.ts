// src/cli/server.ts
// 服务器模式入口（`routedev serve`）
// 不启动 Ink UI，只运行渠道集成层

import { loadConfig } from '../config/loader.js';
import { logger } from '../utils/logger.js';
import { LLMClientManager } from '../router/llm/index.js';
import { TokenTracker } from '../router/tracker.js';
import { ModelRouter } from '../router/router.js';
import { ScenarioClassifier } from '../router/classifier.js';
import { buildRouterConfig } from '../router/config.js';
import { MessageRouter } from '../channels/message-router.js';
import { ChannelManager } from '../channels/manager.js';
import type { ModelConfig } from '../config/schema.js';

export async function startServer(
  portOverride?: number,
  configPath?: string,
): Promise<void> {
  logger.info('RouteDev server starting...');

  // 1. 加载配置
  const config = loadConfig({ globalConfigPath: configPath });
  const serverPort = portOverride ?? config.channels.port;

  // 2. 初始化 LLM 客户端
  const clientManager = new LLMClientManager();
  clientManager.initializeFromConfig(
    config.providers.map(p => ({
      id: p.id,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
    })),
  );

  // 3. 路由器 + 追踪器 + 分类器
  const routerConfig = buildRouterConfig(config);
  const tracker = new TokenTracker(routerConfig.budget);
  const readyClients = clientManager.getReadyClients();
  const classifierClient = readyClients.length > 0 ? readyClients[0].client : undefined;
  const classifier = new ScenarioClassifier({
    llmClient: classifierClient,
    classifierModel: routerConfig.classifierModel,
  });
  const modelRouter = new ModelRouter(routerConfig, tracker);

  // 4. MessageRouter
  const primaryModel: ModelConfig = config.providers[0]?.models[0] ?? {
    id: routerConfig.classifierModel,
    name: 'Default',
    provider: config.providers[0]?.id ?? 'default',
    tier: 'simple',
    contextWindow: 128000,
    capabilities: [],
    latencyMs: 0,
    available: true,
  };
  const defaultClient = readyClients[0]?.client;
  if (!defaultClient) {
    throw new Error('No LLM client available. Configure at least one provider.');
  }

  const messageRouter = new MessageRouter(
    {
      maxResponseLength: config.channels.maxResponseLength,
      contextTtlMs: 2 * 60 * 60 * 1000,
      contextWindow: primaryModel.contextWindow,
      compressionThreshold: 0.8,
    },
    {
      llmClient: defaultClient,
      router: modelRouter,
      classifier,
      tracker,
    },
  );

  // 5. ChannelManager
  const channelManager = new ChannelManager(serverPort);
  channelManager.initializeAdapters(config.channels.entries, messageRouter);

  // 6. 启动
  await channelManager.start();
  logger.info('RouteDev server ready', {
    adapters: channelManager.adapterCount,
    port: serverPort,
  });
  console.log(`✓ Channel server started on port ${serverPort}`);
  console.log(`  Adapters: ${channelManager.adapterCount}`);
  console.log(`  Endpoints: GET /status, POST /webhook/<channel-type>`);

  // 7. 优雅关闭
  const shutdown = async (signal: string) => {
    logger.info('RouteDev server shutting down', { signal });
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      await channelManager.stop();
      console.log('✓ Server stopped');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}