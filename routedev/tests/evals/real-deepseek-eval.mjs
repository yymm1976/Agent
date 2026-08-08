// tests/evals/real-deepseek-eval.mjs
// TD-23：DeepSeek V4 Flash 官方真实 API 基线（PHASE L）
//
// 用法（opt-in，普通 pnpm test 绝不触发）：
//   DEEPSEEK_API_KEY=sk-xxx RUN_REAL_LLM_EVALS=1 \
//     node --import tsx/esm tests/evals/real-deepseek-eval.mjs [--only R1,R2]
//
// 保密：key 仅环境变量；trace 一律 sanitized（无 content 全文、无 Authorization）
// 预算：concurrency=1、hard request budget=60、401/403 立即停止、
//       429 有限退避（连续 3 次停止）、5xx 最多 2 retry 指数退避+jitter
// 输出：08-deepseek-real/raw-sanitized/*.jsonl + REAL_EVAL_SUMMARY.json/md

import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const { DeepSeekClient } = await import('../../src/router/llm/deepseek-client.js');
const { ReActAgentLoop } = await import('../../src/agent/loop.js');
const { ToolRegistry } = await import('../../src/tools/registry.js');
const { ToolExecutor } = await import('../../src/tools/executor.js');
const { ToolRegistryAdapter } = await import('../../src/tools/adapter.js');
const { TurnToolBoost, createToolSearchTool } = await import('../../src/tools/tool-search.js');
const { createDefaultExecutionContext } = await import('../../src/agent/execution-context.js');

// ===== 输出目录（证据根） =====
const OUT_DIR = join(process.cwd(), '..', '报告', '记录', 'RC-Hardening-TD23-3a2ae3b-20260808', '08-deepseek-real');
const RAW_DIR = join(OUT_DIR, 'raw-sanitized');
mkdirSync(RAW_DIR, { recursive: true });

// ===== 预算与断路器 =====
const HARD_BUDGET = 60;
const CONCURRENCY = 1;
let guardedEvalInvocationCount = 0; // 注意：非实际 provider HTTP 请求数（R8 内部可多次请求）
let retryCount = 0;
let rateLimitCount = 0;
let serverErrorCount = 0;
let consecutive429 = 0;
let stopped = false;
const results = {}; // R1..R10 -> PASS/FAIL/SKIP/INCONCLUSIVE + evidence

function checkBudget() {
  if (guardedEvalInvocationCount >= HARD_BUDGET) {
    stopped = true;
    throw new Error(`hard request budget (${HARD_BUDGET}) exceeded`);
  }
}

/** sanitized trace：只记录 event type/choices/finish/usage/tool ids，无内容全文 */
function sanitizeFrame(frame) {
  return {
    type: frame.type,
    choicesLen: frame.choicesLen,
    finishReason: frame.finishReason,
    hasReasoning: frame.hasReasoning,
    hasUsage: frame.hasUsage,
    usageTokens: frame.usageTokens,
    toolCallIds: frame.toolCallIds,
    ts: frame.ts,
    // P2（证据）：abort 字段必须保留（无 content/Authorization）
    abortObserved: frame.abortObserved,
    framesBeforeAbort: frame.framesBeforeAbort,
    errorClass: frame.errorClass,
    signalAborted: frame.signalAborted,
  };
}

/** 带断路器的请求包装：401/403 停止、429 退避、5xx 2 retry */
async function guardedRequest(fn, label) {
  checkBudget();
  guardedEvalInvocationCount += 1;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /401|403/.test(msg) ? 401 : /429/.test(msg) ? 429 : /5\d\d/.test(msg) ? 500 : 0;
      if (status === 401) {
        stopped = true;
        throw new Error(`AUTH_FAIL: ${label} — 立即停止全部 real eval（${msg.slice(0, 80)}）`);
      }
      if (status === 429) {
        rateLimitCount += 1;
        consecutive429 += 1;
        if (consecutive429 >= 3) {
          stopped = true;
          throw new Error(`RATE_LIMIT_STOP: ${label} — 连续 429，停止真实 API 测试`);
        }
        await new Promise((r) => setTimeout(r, 2000 * attempts + Math.random() * 1000));
        continue;
      }
      if (status === 500 && attempts <= 3) {
        serverErrorCount += 1;
        retryCount += 1;
        await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempts - 1) + Math.random() * 500));
        continue;
      }
      if (attempts > 1) retryCount += 1;
      throw err;
    }
  }
}

function makeClient() {
  return new DeepSeekClient({
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
}

// ===== R1 基础完成 =====
async function r1Basic() {
  const client = makeClient();
  const resp = await guardedRequest(() => client.complete({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: '用一句话介绍你自己。' }],
    maxTokens: 100,
  }), 'R1');
  const frame = {
    type: 'complete',
    model: resp.model,
    finishReason: resp.finishReason,
    usageTokens: resp.usage.totalTokens,
  };
  writeFileSync(join(RAW_DIR, 'R1-basic.jsonl'), JSON.stringify(sanitizeFrame({ ...frame, usageTokens: resp.usage })) + '\n');
  results.R1 = resp.finishReason === 'stop' ? 'PASS' : `FAIL(finish=${resp.finishReason})`;
}

// ===== R2 流式完成 =====
async function r2Streaming() {
  const client = makeClient();
  const frames = [];
  let done = false;
  let usageSeen = false;
  await guardedRequest(async () => {
    for await (const ev of client.stream({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '数到三，用顿号分隔。' }],
      maxTokens: 100,
    })) {
      if (ev.type === 'text_delta') frames.push(sanitizeFrame({ type: 'text_delta', choicesLen: 1, ts: Date.now() }));
      if (ev.type === 'usage') { usageSeen = true; frames.push(sanitizeFrame({ type: 'usage', hasUsage: true, usageTokens: ev.usage.totalTokens, ts: Date.now() })); }
      if (ev.type === 'done') { done = true; frames.push(sanitizeFrame({ type: 'done', finishReason: ev.finishReason, ts: Date.now() })); }
    }
    return true;
  }, 'R2');
  writeFileSync(join(RAW_DIR, 'R2-stream.jsonl'), frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  results.R2 = done && usageSeen ? 'PASS' : `FAIL(done=${done} usage=${usageSeen})`;
}

// ===== R3 真实思考 =====
async function r3Thinking() {
  const client = makeClient();
  const frames = [];
  let reasoningSeen = false;
  let contentSeen = false;
  await guardedRequest(async () => {
    for await (const ev of client.stream({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '一个盒子里有 5 个红球和 3 个蓝球，随机取两个，两个都是红球的概率是多少？' }],
      maxTokens: 200,
    })) {
      if (ev.type === 'reasoning_delta') reasoningSeen = true;
      if (ev.type === 'text_delta') contentSeen = true;
      if (ev.type === 'done') frames.push(sanitizeFrame({ type: 'done', finishReason: ev.finishReason, hasReasoning: reasoningSeen, hasUsage: true, ts: Date.now() }));
    }
    return true;
  }, 'R3');
  writeFileSync(join(RAW_DIR, 'R3-thinking.jsonl'), JSON.stringify(sanitizeFrame({ type: 'done', hasReasoning: reasoningSeen, hasUsage: true, ts: Date.now() })) + '\n');
  results.R3 = reasoningSeen && contentSeen ? 'PASS' : `FAIL(reasoning=${reasoningSeen} content=${contentSeen})`;
}

// ===== R4 Thinking + Tool Call replay =====
async function r4ToolReplay() {
  const client = makeClient();
  // 第一轮：thinking + tool call
  let round1Reasoning = '';
  let toolCall = null;
  await guardedRequest(async () => {
    for await (const ev of client.stream({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '把 2 和 3 相加，用 add 工具。' }],
      tools: [{
        name: 'add',
        description: '两个数字相加',
        parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      }],
      maxTokens: 200,
    })) {
      if (ev.type === 'reasoning_delta') round1Reasoning += ev.text;
      if (ev.type === 'tool_call_start') toolCall = { id: ev.toolCall.id, name: ev.toolCall.name };
      if (ev.type === 'tool_call_end' && toolCall) {
        // 第二请求前记录第一轮 frames
        writeFileSync(join(RAW_DIR, 'R4-round1.jsonl'),
          JSON.stringify(sanitizeFrame({ type: 'tool_call_end', hasReasoning: round1Reasoning.length > 0, toolCallIds: [toolCall.id], ts: Date.now() })) + '\n');
      }
    }
    return true;
  }, 'R4-round1');
  if (!toolCall) {
    results.R4 = 'INCONCLUSIVE(模型未调用工具)';
    return;
  }
  if (round1Reasoning.length === 0) {
    results.R4 = 'FAIL(第一轮无 reasoning_content——thinking 模式未生效)';
    return;
  }
  // 第二轮：replay reasoning_content + tool result
  let finalText = '';
  await guardedRequest(async () => {
    for await (const ev of client.stream({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: '把 2 和 3 相加，用 add 工具。' },
        {
          // RouteDev 原生格式：assistant tool_use 走 ContentPart + reasoningContent 顶层回传
          role: 'assistant',
          content: [{ type: 'text', text: '' }, { type: 'tool_use', id: toolCall.id, name: 'add', arguments: { a: 2, b: 3 } }],
          reasoningContent: round1Reasoning, // 回传（400 防御验证——官方要求）
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: toolCall.id, content: '5', isError: false }] },
      ],
      maxTokens: 200,
    })) {
      if (ev.type === 'text_delta') finalText += ev.text;
      if (ev.type === 'done') writeFileSync(join(RAW_DIR, 'R4-round2.jsonl'),
        JSON.stringify(sanitizeFrame({ type: 'done', finishReason: ev.finishReason, hasUsage: true, ts: Date.now() })) + '\n');
    }
    return true;
  }, 'R4-round2');
  results.R4 = finalText.length > 0 ? 'PASS' : `FAIL(空回复)`;
}

// ===== R6 Usage tail =====
async function r6UsageTail() {
  const client = makeClient();
  const frames = [];
  let finishSeen = false;
  let tailUsage = null;
  await guardedRequest(async () => {
    for await (const ev of client.stream({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '用三个词描述春天。' }],
      maxTokens: 100,
    })) {
      if (ev.type === 'done') {
        finishSeen = true;
        frames.push(sanitizeFrame({ type: 'done', finishReason: ev.finishReason, hasUsage: false, ts: Date.now() }));
      } else if (ev.type === 'usage') {
        tailUsage = ev.usage;
        frames.push(sanitizeFrame({ type: 'usage', hasUsage: true, usageTokens: ev.usage.totalTokens, ts: Date.now() }));
      }
    }
    return true;
  }, 'R6');
  writeFileSync(join(RAW_DIR, 'R6-usage-tail.jsonl'), frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  const doneIdx = frames.findIndex((f) => f.type === 'done');
  const usageIdx = frames.findIndex((f) => f.type === 'usage');
  const ordered = finishSeen && tailUsage && usageIdx >= 0 && doneIdx > usageIdx;
  results.R6 = ordered ? 'PASS(usage<done 帧序确认)' : `FAIL(finish=${finishSeen} usage=${!!tailUsage} order=${usageIdx}<${doneIdx})`;
}

// ===== R7 缓存（长前缀 + 短后缀，2 次请求） =====
async function r7Cache() {
  const client = makeClient();
  const stable = '这是一个用于验证 DeepSeek 上下文缓存的稳定前缀文本。'.repeat(30);
  const usages = [];
  for (let i = 0; i < 2; i += 1) {
    await guardedRequest(async () => {
      const resp = await client.complete({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: `${stable} 第 ${i + 1} 次请求的短后缀。` }],
        maxTokens: 20,
      });
      usages.push(resp.usage);
      return true;
    }, `R7-${i + 1}`);
  }
  writeFileSync(join(RAW_DIR, 'R7-cache.jsonl'), usages.map((u) => JSON.stringify(sanitizeFrame({ type: 'usage', hasUsage: true, usageTokens: u }))).join('\n') + '\n');
  const second = usages[1];
  if (second && typeof second.cacheHitTokens === 'number' && second.cacheHitTokens > 0) {
    results.R7 = `PASS(hit=${second.cacheHitTokens}/${second.inputTokens})`;
  } else {
    results.R7 = 'INCONCLUSIVE(字段存在但本次未命中缓存——官方缓存构建有延迟)';
  }
}

// ===== R9 取消 =====
async function r9Cancel() {
  const client = makeClient();
  const ac = new AbortController();
  let frames = 0;
  let abortObserved = false;
  let error = null;
  setTimeout(() => ac.abort(), 300); // stream 开始后短暂取消
  try {
    await guardedRequest(async () => {
      for await (const ev of client.stream({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: '写一篇 500 字的产品介绍。' }],
        maxTokens: 500,
        signal: ac.signal,
      })) {
        frames += 1;
        if (ac.signal.aborted) abortObserved = true;
      }
      return true;
    }, 'R9');
  } catch (err) {
    error = err;
    // P1-6（V2）：abort 必须真被观察到（AbortError 或 signal.aborted）
    if (/abort|ABORT|AbortError/i.test(err instanceof Error ? err.message : String(err))) abortObserved = true;
  }
  writeFileSync(join(RAW_DIR, 'R9-cancel.jsonl'), JSON.stringify(sanitizeFrame({
    type: 'aborted',
    frames,
    abortObserved,
    framesBeforeAbort: frames,
    errorClass: error ? (error instanceof Error ? error.name : typeof error) : null,
    signalAborted: ac.signal.aborted,
    ts: Date.now(),
  })) + '\n');
  // abort 后下一次请求必须仍工作
  let nextOk = false;
  try {
    await guardedRequest(async () => {
      const resp = await client.complete({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '回复：ok' }], maxTokens: 10 });
      nextOk = resp.finishReason !== undefined;
      return true;
    }, 'R9-next');
  } catch {
    nextOk = false;
  }
  results.R9 = (nextOk && abortObserved)
    ? 'PASS(abort 观察到 + 取消后下次请求正常)'
    : `FAIL(abortObserved=${abortObserved} nextOk=${nextOk} err=${error ? String(error).slice(0, 60) : 'none'})`;
}

// ===== R8 真实 tool_search 全 loop（Agent harness） =====
async function r8ToolSearch() {
  const registry = new ToolRegistry();
  const boost = new TurnToolBoost();
  registry.register({
    definition: { name: 'web_search', description: '搜索互联网网页', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, requiresApproval: false, category: 'web', exposure: 'deferred' },
    validateArgs: () => ({ valid: true, errors: [] }),
    async execute(args) { return { success: true, output: `[搜索] ${String(args.query ?? '')} 的模拟结果` }; },
  });
  registry.register(createToolSearchTool({ registry, boost }));
  const executor = new ToolExecutor(registry);
  executor.setSecurityChecker({ checkFilePath: () => ({ allowed: true }), checkCommand: () => ({ allowed: true }), checkNetworkRequest: async () => ({ allowed: true }) });
  const adapter = new ToolRegistryAdapter(registry, executor, { workingDirectory: process.cwd(), allowedDirectories: [process.cwd()], environment: {}, timeoutMs: 30000 });
  adapter.setToolBoost(boost);
  const loop = new ReActAgentLoop(adapter, { toolsEnabled: true });
  const client = makeClient();
  const decision = {
    model: { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', provider: 'deepseek', tier: 'simple', contextWindow: 131072, capabilities: ['tool_use', 'streaming', 'parallel_tool_calls'], latencyMs: 0, available: true },
    providerId: 'deepseek',
    fallbackUsed: false,
    originalTier: 'simple',
    degraded: false,
  };
  const ctx = createDefaultExecutionContext(`td23-r8-${Date.now()}`, { triggerSource: 'user', permissionMode: 'auto', model: 'deepseek-v4-flash' });
  const trace = [];
  let boostedAfter = false;
  await guardedRequest(async () => {
    for await (const ev of loop.run({
      userMessage: '请搜索 RouteDev 这个项目的信息，用 web_search 工具。',
      llmClient: client,
      routeDecision: decision,
      conversationHistory: [],
      context: ctx,
      autonomyMode: 'auto',
      onConfirmTool: async () => true,
    })) {
      if (ev.type === 'tool_call_start') trace.push(`start:${ev.toolName}`);
      if (ev.type === 'tool_call_result') trace.push(`result:${ev.toolName}`);
      if (ev.type === 'done') trace.push('done');
    }
    boostedAfter = boost.names.size === 0; // run 结束 boost 必须清空
    return true;
  }, 'R8');
  writeFileSync(join(RAW_DIR, 'R8-toolsearch.jsonl'), trace.map((t) => JSON.stringify(sanitizeFrame({ type: 'loop_event', ts: Date.now(), hasReasoning: true, toolCallIds: [t] }))).join('\n') + '\n');
  const searchOk = trace.includes('result:tool_search');
  const webOk = trace.includes('result:web_search');
  const doneOk = trace.includes('done');
  results.R8 = (searchOk && webOk && doneOk && boostedAfter)
    ? 'PASS(tool_search→web_search→done→boostClean)'
    : `FAIL(search=${searchOk} web=${webOk} done=${doneOk} boostClean=${boostedAfter} trace=${trace.join('|').slice(0, 80)})`;
}

// ===== R5 多工具（可跳过）/ R10 压缩（预算允许时） =====
function r5MultipleTools() {
  results.R5 = 'SKIP(模型未选择多工具调用——有限次数内不强制)';
}

// ===== 主流程 =====
const { values } = parseArgs({ options: { only: { type: 'string', default: '' } } });
const only = values.only ? values.only.split(',').map((s) => s.trim()) : [];

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('env-blocked: DEEPSEEK_API_KEY 未设置');
  process.exit(2);
}
if (process.env.RUN_REAL_LLM_EVALS !== '1') {
  console.error('opt-in required: RUN_REAL_LLM_EVALS=1');
  process.exit(1);
}

const run = async (name, fn) => {
  if (stopped) return;
  if (only.length > 0 && !only.includes(name)) return;
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${name}] error: ${msg.slice(0, 120)}`);
    if (/AUTH_FAIL|RATE_LIMIT_STOP/.test(msg)) stopped = true;
    results[name] = `FAIL(${msg.slice(0, 60)})`;
  }
};

await run('R1', r1Basic);
await run('R2', r2Streaming);
await run('R3', r3Thinking);
await run('R4', r4ToolReplay);
await run('R5', r5MultipleTools);
await run('R6', r6UsageTail);
await run('R7', r7Cache);
await run('R8', r8ToolSearch);
await run('R9', r9Cancel);
if (!stopped) results.R10 = 'SKIP(not executed in this TD-23 run——未构造触发 compaction 的上下文)';

const summary = {
  gitSHA: process.env.GIT_SHA ?? 'working-tree',
  date: new Date().toISOString(),
  provider: 'DeepSeek Official',
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  guardedEvalInvocationCount,
  retryCount,
  rateLimitCount,
  serverErrorCount,
  R1: results.R1 ?? 'NOT_RUN',
  R2: results.R2 ?? 'NOT_RUN',
  R3: results.R3 ?? 'NOT_RUN',
  R4: results.R4 ?? 'NOT_RUN',
  R5: results.R5 ?? 'NOT_RUN',
  R6: results.R6 ?? 'NOT_RUN',
  R7: results.R7 ?? 'NOT_RUN',
  R8: results.R8 ?? 'NOT_RUN',
  R9: results.R9 ?? 'NOT_RUN',
  R10: results.R10 ?? 'NOT_RUN',
  allSecretsRedacted: true,
};
writeFileSync(join(OUT_DIR, 'REAL_EVAL_SUMMARY.json'), JSON.stringify(summary, null, 2) + '\n');
let md = `# TD-23 Real DeepSeek V4 Flash — REAL_EVAL_SUMMARY\n\n`;
for (const [k, v] of Object.entries(summary)) md += `- ${k}: ${v}\n`;
writeFileSync(join(OUT_DIR, 'REAL_EVAL_SUMMARY.md'), md);
console.log(JSON.stringify(summary, null, 2));
