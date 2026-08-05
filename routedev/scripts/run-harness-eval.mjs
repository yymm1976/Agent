// scripts/run-harness-eval.mjs
// B-00：Flash 基础任务基线 runner
//
// 职责：
//   - 只消费现有 Kernel/EventV1（NativeAgentKernel.runReAct + ReActEvent 流），不新增代理逻辑
//   - 逐任务：物化 fixture 工作区 → 分类/路由（或 --pin-model 固定）→ 驱动内核 → 收集指标
//   - 产出 JSONL 条目 + 聚合摘要（Markdown），供基线报告与后续 A/B（B-02B）复用
//
// 用法：
//   DEEPSEEK_API_KEY=sk-xxx node --import tsx/esm scripts/run-harness-eval.mjs \
//     [--config tests/evals/eval-config.yaml] [--tasks id1,id2|all] [--out eval-results.jsonl] \
//     [--pin-model deepseek-v4-flash]
// 退出码：0 全部通过；1 存在失败/部分通过；2 环境阻塞（无可用 provider）
import { parseArgs } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const { loadConfig } = await import('../src/config/loader.js');
const { createAppDependencies } = await import('../src/runtime/app-init.js');
const { LLMClientManager } = await import('../src/router/llm/index.js');
const { TokenTracker } = await import('../src/router/tracker.js');
const { ScenarioClassifier } = await import('../src/router/classifier.js');
const { ModelRouter } = await import('../src/router/router.js');
const { buildRouterConfig } = await import('../src/router/config.js');
const { createDefaultExecutionContext } = await import('../src/agent/execution-context.js');
const { estimateTokens } = await import('../src/utils/token-estimate.js');
const { EVAL_TASKS } = await import('../tests/evals/tasks.js');
const { aggregateResults, summaryToMarkdown } = await import('../tests/evals/summarize.js');
const { copyDirSync } = await import('../tests/evals/fs-utils.js');

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: join(REPO_ROOT, 'tests/evals/eval-config.yaml') },
    tasks: { type: 'string', default: 'all' },
    out: { type: 'string', default: join(REPO_ROOT, 'eval-results.jsonl') },
    'pin-model': { type: 'string' },
    'prompt-variant': { type: 'string', default: 'default' }, // B-02B：default | compact
  },
});
if (!['default', 'compact'].includes(values['prompt-variant'])) {
  console.error(`--prompt-variant 只支持 default|compact，收到: ${values['prompt-variant']}`);
  process.exit(1);
}
/** B-02B：提示变体 → 模板 id */
const PROMPT_TEMPLATE_BY_VARIANT = {
  default: 'main.system',
  compact: 'main.system.compact',
};

/** 与 desktop/main/engine-bridge.ts 的 inferClientType 相同逻辑（desktop 不导出，这里内联镜像） */
function inferClientType(p) {
  const id = p.id.toLowerCase();
  const url = p.baseUrl.toLowerCase();
  if (id.includes('deepseek') || url.includes('deepseek')) return 'deepseek';
  if (id.includes('qwen') || url.includes('dashscope') || url.includes('qwen')) return 'qwen';
  if (id.includes('ollama') || url.includes('ollama') || url.includes('localhost:11434')) return 'ollama';
  return undefined;
}

let config;
try {
  config = loadConfig({ globalConfigPath: values.config });
} catch (err) {
  // loadConfig 对缺失环境变量是 fail-closed（抛 ConfigValidationError），评测场景转为环境阻塞状态
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`env-blocked: ${msg}`);
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify({ error: `env-blocked: ${msg}` }) + '\n');
  process.exit(2);
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
  const msg = 'env-blocked: 无可用 provider（检查 DEEPSEEK_API_KEY 与网络代理）';
  console.error(msg);
  writeFileSync(values.out, `{"error":"${msg}"}\n`);
  process.exit(2);
}

const routerConfig = buildRouterConfig(config);
const tracker = new TokenTracker(routerConfig.budget);
const modelRouter = new ModelRouter(routerConfig, tracker, config.providers);
const classifier = new ScenarioClassifier({
  llmClient: readyClients[0].client,
  classifierModel: routerConfig.classifierModel,
});
const defaultModel = config.providers[0]?.models[0]?.id ?? '';
const deps = createAppDependencies(config, clientManager, defaultModel, process.cwd(), classifier, modelRouter, tracker);

/** 固定模型时手工构造 routeDecision（保证基线可复现，跳过分类器/路由波动） */
function pinnedRoute(modelId) {
  const model = config.providers
    .flatMap((p) => p.models.map((m) => ({ ...m, provider: p.id })))
    .find((m) => m.id === modelId);
  if (!model) throw new Error(`--pin-model 指定的模型不存在: ${modelId}`);
  return { model, providerId: model.provider, fallbackUsed: false, originalTier: model.tier, degraded: false };
}

const selected = values.tasks === 'all' ? EVAL_TASKS : EVAL_TASKS.filter((t) => values.tasks.split(',').includes(t.id));
if (selected.length === 0) {
  console.error(`没有匹配的任务: ${values.tasks}`);
  process.exit(1);
}
console.log(`[eval] 任务 ${selected.length} 个 | config=${values.config} | pin-model=${values['pin-model'] ?? '路由'}`);

const entries = [];
for (const task of selected) {
  const startedAt = Date.now();
  const entry = {
    taskId: task.id,
    name: task.name,
    category: task.category,
    promptVariant: values['prompt-variant'],
    completed: false,
    passed: false,
    toolCalls: 0,
    invalidToolCalls: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolSchemaTokens: 0,
    toolCount: 0,
    durationMs: 0,
  };
  const ws = mkdtempSync(join(tmpdir(), `routedev-eval-${task.id}-`));
  const sessionId = `eval-${task.id}-${Date.now()}`;
  let finalContent = '';
  try {
    copyDirSync(join(REPO_ROOT, 'tests/evals/fixtures', task.fixtureDir), ws);
    // B-01A 口径修复：toolCount/toolSchemaTokens 按模型可见面统计
    // （core + 本回合提升），而非全部已注册工具——否则收窄工具面的收益会被低估。
    const { resolveVisibleTools } = await import('../src/tools/tool-surface-resolver.js');
    const registered = deps.registry.list();
    const boosted = deps.toolBoost ? [...deps.toolBoost.names] : [];
    const visibleDefs = resolveVisibleTools(registered, {
      mode: 'coding',
      allowedTools: boosted.length > 0 ? new Set(boosted) : undefined,
    }).map((t) => t.definition);
    entry.toolCount = visibleDefs.length;
    entry.toolSchemaTokens = estimateTokens(JSON.stringify(visibleDefs));

    const classifyResult = values['pin-model'] ? null : await classifier.classify({ query: task.prompt });
    const routeDecision = values['pin-model'] ? pinnedRoute(values['pin-model']) : await modelRouter.route(classifyResult);
    const client = clientManager.get(routeDecision.providerId);
    if (!client || !client.isReady()) {
      entry.error = `env-blocked: provider ${routeDecision.providerId} 不可用`;
      entries.push(entry);
      continue;
    }
    const executionContext = createDefaultExecutionContext(sessionId, {
      triggerSource: 'user',
      permissionMode: task.autonomyMode ?? 'auto',
      model: routeDecision.model.id,
    });
    // B-02B：提示变体（default|compact）渲染并拆分为稳定/动态区
    const renderedZones = await deps.prompts.renderPromptZones(PROMPT_TEMPLATE_BY_VARIANT[values['prompt-variant']], {
      language: config.general.language === 'zh-CN' ? '中文' : 'English',
      autonomyMode: task.autonomyMode ?? 'auto',
      availableTools: visibleDefs
        .map((d) => `${d.name}`)
        .join(', ') || '（无可用工具）',
      projectRules: '',
      projectMemory: '',
      cwd: ws,
      taskShape: task.taskShape,
      userProfile: '',
    });
    const runParams = {
      requestId: sessionId,
      userMessage: task.prompt,
      llmClient: client,
      routeDecision,
      conversationHistory: [],
      context: executionContext,
      systemBlocks: [
        {
          type: 'text',
          text: renderedZones.stable,
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: `${renderedZones.dynamic}\n\n当前路由决策：${routeDecision.model.id} (${routeDecision.originalTier})`,
        },
      ],
      signal: undefined,
      autonomyMode: task.autonomyMode ?? 'auto',
      onConfirmTool: async (toolName, args) => {
        if (task.denyTool && toolName === task.denyTool.tool && task.denyTool.match(args)) return false;
        if (toolName === 'ask_user') return false;
        return true;
      },
    };
    let requiredToolSeen = false;
    let escalated = null;
    for await (const event of deps.agentKernel.runReAct(executionContext, runParams)) {
      switch (event.type) {
        case 'token_profile':
          entry.turns += 1;
          break;
        case 'tool_call_start':
          entry.toolCalls += 1;
          if (task.requiresToolCall && event.toolName === task.requiresToolCall) requiredToolSeen = true;
          break;
        case 'tool_call_result':
          if (event.isError) entry.invalidToolCalls += 1;
          break;
        case 'escalation':
          escalated = event.reason;
          break;
        case 'error':
          if (!entry.error) entry.error = event.error;
          break;
        case 'done':
          finalContent = event.content;
          entry.inputTokens = event.usage?.inputTokens ?? 0;
          entry.outputTokens = event.usage?.outputTokens ?? 0;
          entry.totalTokens = event.usage?.totalTokens ?? 0;
          break;
        default:
          break;
      }
    }
    entry.durationMs = Date.now() - startedAt;
    entry.completed = true;
    if (!finalContent && escalated) {
      entry.passed = false;
      entry.failStage = 'escalation';
      entry.error = entry.error ?? escalated;
    } else {
      const wsCheck = await task.checkWorkspace(ws);
      const answerAll = (task.answerKeywordsAll ?? []).every((k) => finalContent.includes(k));
      const answerAny = !task.answerKeywordsAny || task.answerKeywordsAny.some((k) => finalContent.includes(k));
      const toolReq = !task.requiresToolCall || requiredToolSeen;
      entry.verifyDetail = wsCheck.detail;
      entry.passed = wsCheck.passed && answerAll && answerAny && toolReq;
      if (!entry.passed) {
        entry.failStage = !wsCheck.passed ? 'checkWorkspace' : !answerAll || !answerAny ? 'answer' : !toolReq ? 'tool' : 'unknown';
      }
    }
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
    entry.durationMs = Date.now() - startedAt;
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
  entries.push(entry);
  console.log(`[eval] ${task.id}: ${entry.passed ? 'PASS' : entry.completed ? 'FAIL' : 'SKIP'} ${entry.failStage ?? ''}${entry.error ? ` (${entry.error.slice(0, 120)})` : ''} tools=${entry.toolCalls} turns=${entry.turns} in=${entry.inputTokens}`);
}

const summary = aggregateResults(entries);
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
const mdPath = values.out.replace(/\.jsonl$/, '.md');
writeFileSync(mdPath, `# RouteDev Harness Eval ${new Date().toISOString()}\n\n${summaryToMarkdown(summary)}\n`);
console.log(`\n${summaryToMarkdown(summary)}\n`);
console.log(`[eval] JSONL: ${values.out}\n[eval] 摘要: ${mdPath}`);
await deps.dispose();
process.exit(summary.blocked.length === summary.total ? 2 : summary.passed === summary.total ? 0 : 1);
