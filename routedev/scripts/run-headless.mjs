// scripts/run-headless.mjs
// B-15：headless 任务 runner——stdin 接任务，stdout 输出 versioned EngineEventV1 JSONL
//
// 用法：
//   echo '{"task":"修复 src/x.ts 的类型错误","cwd":"C:/proj","pinModel":"deepseek-v4-flash"}' \
//     | DEEPSEEK_API_KEY=sk-xxx node --import tsx/esm scripts/run-headless.mjs
//
// stdin 任务 JSON：
//   { task: string（必填，要执行的任务描述）, cwd?: string（工作目录，默认当前目录）,
//     pinModel?: string（固定模型，跳过分类/路由）, requestId?: string }
//
// 输出：每行一个 JSON 事件（schemaVersion + EngineEventV1 字段），最后一行是 agent_end。
// stderr 仅用于错误信息。
//
// 退出码：
//   0 成功（agent_end reason = completed）
//   1 参数/任务格式错误（stdin JSON 解析失败或缺少 task）
//   2 环境阻塞（配置失败 / 无可用 provider——沿用 eval runner 语义）
//   3 执行失败（agent_end reason = error | max_iterations，或 run 抛出执行错误）
//   4 内部错误（装配异常、意外故障）
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 读取 stdin 全部内容 */
function readStdin() {
  return new Promise((resolveRead) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolveRead(data));
    process.stdin.on('error', () => resolveRead(data));
  });
}

/** 镜像 eval runner 的客户端类型推断（desktop 不导出，这里内联） */
function inferClientType(p) {
  const id = p.id.toLowerCase();
  const url = p.baseUrl.toLowerCase();
  if (id.includes('deepseek') || url.includes('deepseek')) return 'deepseek';
  if (id.includes('qwen') || url.includes('dashscope') || url.includes('qwen')) return 'qwen';
  if (id.includes('ollama') || url.includes('ollama') || url.includes('localhost:11434')) return 'ollama';
  return undefined;
}

/** 装配内核依赖（与 eval runner 相同路径，headless 只消费 EngineEventV1） */
async function bootstrap(configPath, workingDir = process.cwd()) {
  const { loadConfig } = await import('../src/config/loader.js');
  const { createAppDependencies } = await import('../src/runtime/app-init.js');
  const { LLMClientManager } = await import('../src/router/llm/index.js');
  const { TokenTracker } = await import('../src/router/tracker.js');
  const { ScenarioClassifier } = await import('../src/router/classifier.js');
  const { ModelRouter } = await import('../src/router/router.js');
  const { buildRouterConfig } = await import('../src/router/config.js');
  const { createDefaultExecutionContext } = await import('../src/agent/execution-context.js');
  const { engineEventsToJsonl } = await import('../src/harness/jsonl-exporter.js');

  let config;
  try {
    config = loadConfig({ globalConfigPath: configPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`env-blocked: ${msg}`), { code: 'ENV_BLOCKED' });
  }
  const clientManager = new LLMClientManager();
  clientManager.initializeFromConfig(
    config.providers.map((p) => ({
      id: p.id,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      clientType: inferClientType(p),
    })),
  );
  const readyClients = clientManager.getReadyClients();
  if (readyClients.length === 0) {
    throw Object.assign(new Error('env-blocked: 无可用 provider（检查 API Key 与网络）'), { code: 'ENV_BLOCKED' });
  }

  const routerConfig = buildRouterConfig(config);
  const tracker = new TokenTracker(routerConfig.budget);
  const modelRouter = new ModelRouter(routerConfig, tracker, config.providers);
  const classifier = new ScenarioClassifier({
    llmClient: readyClients[0].client,
    classifierModel: routerConfig.classifierModel,
  });
  const defaultModel = config.providers[0]?.models[0]?.id ?? '';
  // 任务 cwd 真实生效（审查 Minor 修复）：工作目录按 stdin 任务字段解析
  const deps = createAppDependencies(config, clientManager, defaultModel, workingDir, classifier, modelRouter, tracker);
  return { deps, config, modelRouter, classifier, createDefaultExecutionContext, engineEventsToJsonl };
}

/** 固定模型时手工构造 routeDecision（保证可复现，与 eval runner 相同） */
function pinnedRoute(config, modelId) {
  const model = config.providers
    .flatMap((p) => p.models.map((m) => ({ ...m, provider: p.id })))
    .find((m) => m.id === modelId);
  if (!model) throw new Error(`--pin-model 指定的模型不存在: ${modelId}`);
  return { model, providerId: model.provider, fallbackUsed: false, originalTier: model.tier, degraded: false };
}

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: join(REPO_ROOT, 'tests/evals/eval-config.yaml') },
    cwd: { type: 'string', default: process.cwd() },
  },
});

try {
  // 1. 读 stdin 任务
  const raw = await readStdin();
  let task;
  try {
    task = JSON.parse(raw || '{}');
  } catch {
    console.error('任务 JSON 解析失败（stdin 必须是合法 JSON）');
    process.exit(1);
  }
  if (typeof task.task !== 'string' || task.task.trim().length === 0) {
    console.error('任务缺少必填字段 task（字符串）');
    process.exit(1);
  }
  const cwd = typeof task.cwd === 'string' && task.cwd.length > 0 ? task.cwd : values.cwd;
  const requestId = typeof task.requestId === 'string' ? task.requestId : `headless-${Date.now().toString(36)}`;

  // 2. 装配（env-blocked 显式退出码 2；任务 cwd 作为工作目录）
  let boot;
  try {
    boot = await bootstrap(values.config, cwd);
  } catch (err) {
    if (err?.code === 'ENV_BLOCKED') {
      console.error(String(err.message));
      process.exit(2);
    }
    console.error(`内部错误: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(4);
  }
  const { deps, config, modelRouter, classifier, createDefaultExecutionContext, engineEventsToJsonl } = boot;

  // 3. 路由（pinModel 跳过分类）
  const routeDecision = task.pinModel
    ? pinnedRoute(config, task.pinModel)
    : await modelRouter.route(await classifier.classify({ query: task.task }));

  // 4. 驱动内核：EngineEventV1 → JSONL（kernel.run 装配了 trace sink + params factory）
  const kernel = deps.agentKernel;
  if (!kernel.run) {
    console.error('内部错误: AgentKernel 未提供 run（EngineEventV1 流路径）');
    process.exit(4);
  }
  const ctx = createDefaultExecutionContext(requestId, {
    triggerSource: 'automation',
    model: routeDecision.model.id,
  });

  let endReason = null;
  try {
    for await (const line of engineEventsToJsonl(kernel.run(ctx, task.task))) {
      const event = JSON.parse(line);
      if (event.type === 'agent_end') endReason = event.payload?.reason ?? null;
      process.stdout.write(line + '\n');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`执行失败: ${msg}`);
    process.exit(3);
  }

  // 5. 退出码：completed=0；error/max_iterations=3；意外无 agent_end=3
  if (endReason === 'completed') process.exit(0);
  if (endReason === 'error' || endReason === 'max_iterations') {
    console.error(`执行失败: agent_end reason=${endReason}`);
    process.exit(3);
  }
  console.error('执行失败: 未收到 agent_end 事件');
  process.exit(3);
} catch (err) {
  console.error(`内部错误: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(4);
}
