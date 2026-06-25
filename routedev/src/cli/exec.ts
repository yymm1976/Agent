// src/cli/exec.ts
// 非交互 exec 模式：一次性执行任务并输出结构化结果
// 借鉴 Open Interpreter 的 `interpreter exec` 非交互模式
// 适用于 CI 集成和批处理场景
//
// 用法：
//   routedev exec "任务描述"                    # 纯文本输出
//   routedev exec "任务描述" --json             # JSONL 事件流输出
//   routedev exec "任务描述" --output-schema '...'  # 强制结果匹配 JSON Schema
//   echo "任务描述" | routedev exec --json      # 从 stdin 读取任务
//   routedev exec "任务描述" --timeout 120      # 120 秒超时
//
// 退出码：
//   0 = 成功
//   1 = 执行失败
//   2 = 超时

import { loadConfig } from '../config/loader.js';
import { logger } from '../utils/logger.js';
import { LLMClientManager } from '../router/llm/index.js';
import { TokenTracker } from '../router/tracker.js';
import { ScenarioClassifier } from '../router/classifier.js';
import { ModelRouter } from '../router/router.js';
import { buildRouterConfig } from '../router/config.js';
import { createAppDependencies } from './app-init.js';
import { validateProviders, formatValidationMessages } from '../utils/provider-validator.js';
import type { ReActEvent } from '../agent/loop-config.js';

/** exec 子命令专用参数 */
export interface ExecArgs {
  /** 任务描述（命令行传入）；为空时从 stdin 读取 */
  task?: string;
  /** JSONL 事件流输出模式 */
  json: boolean;
  /** 输出 JSON Schema（强制最终答案匹配此 Schema） */
  outputSchema?: string;
  /** 超时秒数 */
  timeout?: number;
  /** 配置文件路径覆盖 */
  configPath?: string;
}

/** exec 模式退出码 */
export const EXEC_EXIT_CODE = {
  SUCCESS: 0,
  FAILURE: 1,
  TIMEOUT: 2,
} as const;

/** JSONL 事件流中的事件类型 */
interface JsonlEvent {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * 从 stdin 读取全部内容（非 TTY 模式下）
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

/**
 * 将 ReActEvent 转换为 JSONL 事件对象
 */
function eventToJsonl(event: ReActEvent): JsonlEvent {
  const base: JsonlEvent = {
    type: event.type,
    timestamp: new Date().toISOString(),
  };
  switch (event.type) {
    case 'thinking':
      return { ...base, message: event.message };
    case 'reasoning_delta':
      return { ...base, text: event.text };
    case 'text_delta':
      return { ...base, text: event.text };
    case 'tool_call_start':
      return { ...base, toolName: event.toolName, toolCallId: event.toolCallId, args: event.args };
    case 'tool_call_result':
      return { ...base, toolName: event.toolName, toolCallId: event.toolCallId, result: event.result, isError: event.isError };
    case 'approval_required':
      return { ...base, toolName: event.toolName, toolCallId: event.toolCallId, args: event.args, reason: event.reason };
    case 'error':
      return { ...base, error: event.error, usage: event.usage };
    case 'done':
      return { ...base, content: event.content, usage: event.usage };
    case 'token_profile':
      return { ...base, snapshot: event.snapshot };
    default:
      return base;
  }
}

/**
 * 验证最终答案是否匹配指定的 JSON Schema
 * 简化实现：尝试解析为 JSON 并检查必填字段存在
 *
 * @param content 最终答案文本
 * @param schemaJson JSON Schema 字符串
 * @returns 验证结果（valid + 错误信息）
 */
function validateOutputSchema(content: string, schemaJson: string): { valid: boolean; error?: string } {
  let schema: { required?: string[]; type?: string };
  try {
    schema = JSON.parse(schemaJson);
  } catch (err) {
    return { valid: false, error: `output-schema 不是有效的 JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 尝试从答案中提取 JSON（可能被 markdown 代码块包裹）
  let jsonStr = content.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { valid: false, error: `最终答案不是有效的 JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 检查 type 字段
  if (schema.type) {
    const actualType = Array.isArray(parsed) ? 'array' : typeof parsed;
    if (actualType !== schema.type) {
      return { valid: false, error: `类型不匹配：期望 ${schema.type}，实际 ${actualType}` };
    }
  }

  // 检查 required 字段
  if (schema.required && schema.required.length > 0 && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const field of schema.required) {
      if (!(field in obj)) {
        return { valid: false, error: `缺少必填字段: ${field}` };
      }
    }
  }

  return { valid: true };
}

/**
 * 执行 exec 子命令
 *
 * @param args exec 参数
 * @returns 退出码（0=成功，1=失败，2=超时）
 */
export async function runExec(args: ExecArgs): Promise<number> {
  // 1. 获取任务描述：命令行参数优先，否则从 stdin 读取
  let task = args.task?.trim();
  if (!task) {
    // stdin 非 TTY 时读取
    if (!process.stdin.isTTY) {
      task = await readStdin();
    }
    if (!task) {
      process.stderr.write('错误：未提供任务描述。用法：routedev exec "任务描述" 或通过 stdin 传入\n');
      return EXEC_EXIT_CODE.FAILURE;
    }
  }

  // 2. 设置超时定时器
  let timeoutHandle: NodeJS.Timeout | null = null;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((resolve) => {
    if (args.timeout && args.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve(new Promise(() => {})); // 永不 resolve，让 Promise.race 走超时分支
      }, args.timeout * 1000);
    }
    // 无超时配置时返回永不 resolve 的 Promise，让主逻辑正常执行
    return new Promise(() => {});
  });

  // 3. 执行任务（带超时竞争）
  const execPromise = executeTask(task, args);

  try {
    const exitCode = await Promise.race([execPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return exitCode;
  } catch {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut) {
      if (args.json) {
        const event: JsonlEvent = {
          type: 'timeout',
          timestamp: new Date().toISOString(),
          timeoutSeconds: args.timeout,
        };
        process.stdout.write(JSON.stringify(event) + '\n');
      } else {
        process.stderr.write(`错误：任务执行超时（${args.timeout} 秒）\n`);
      }
      return EXEC_EXIT_CODE.TIMEOUT;
    }
    process.stderr.write('错误：任务执行失败\n');
    return EXEC_EXIT_CODE.FAILURE;
  }
}

/**
 * 执行任务核心逻辑：装配服务、运行 ReAct Loop、输出结果
 */
async function executeTask(task: string, args: ExecArgs): Promise<number> {
  // 加载配置
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

  // Provider 配置校验（仅记录日志，不阻断）
  const validationResult = validateProviders(config, clientManager);
  const validationMessages = formatValidationMessages(validationResult);
  for (const msg of validationMessages) {
    logger.warn(msg);
  }

  // 检查是否有可用的 LLM 客户端
  const readyClients = clientManager.getReadyClients();
  if (readyClients.length === 0) {
    if (args.json) {
      const event: JsonlEvent = {
        type: 'error',
        timestamp: new Date().toISOString(),
        error: '没有可用的 LLM 客户端，请检查 Provider 配置',
      };
      process.stdout.write(JSON.stringify(event) + '\n');
    } else {
      process.stderr.write('错误：没有可用的 LLM 客户端，请检查 Provider 配置\n');
    }
    return EXEC_EXIT_CODE.FAILURE;
  }

  // 构建路由配置
  const routerConfig = buildRouterConfig(config);
  const tracker = new TokenTracker(routerConfig.budget);
  const classifierClient = readyClients[0].client;
  const classifier = new ScenarioClassifier({
    llmClient: classifierClient,
    classifierModel: routerConfig.classifierModel,
  });
  // CONCERN 修复：传入 execution 配置，使熔断器参数可配置
  // Phase 42：传入 reasoningMode，让 fast/balanced/accurate 影响 tier 选择
  const modelRouter = new ModelRouter(routerConfig, tracker, config.providers, undefined, config.execution, config.reasoningMode);

  // 装配全部服务依赖（复用 App 的装配逻辑）
  const currentModel = config.providers[0]?.models[0]?.id ?? '';
  const deps = createAppDependencies(
    config,
    clientManager,
    currentModel,
    process.cwd(),
    classifier,
    modelRouter,
    tracker,
  );

  // 4. 场景分类 + 路由
  const classification = await classifier.classify({ query: task });
  const routeDecision = await modelRouter.route(classification);

  // 获取 LLM 客户端
  const llmClient = clientManager.get(routeDecision.providerId) ?? readyClients[0].client;

  // 5. 构造系统提示词
  // --output-schema 模式下，在系统提示词中注入 Schema 约束
  let systemPrompt = '你是一个专注的开发助手。请直接完成任务并给出最终答案。';
  if (args.outputSchema) {
    systemPrompt += `\n\n重要：你的最终答案必须是符合以下 JSON Schema 的有效 JSON 对象，不要包含其他文本：\n${args.outputSchema}`;
  }

  // 6. 运行 ReAct Loop，收集事件
  let finalContent = '';
  let hasError = false;
  let errorMessage = '';

  try {
    for await (const event of deps.agentLoop.run({
      userMessage: task,
      llmClient,
      routeDecision,
      conversationHistory: [],
      systemPrompt,
      // 非交互模式：所有工具调用自动批准（CI 场景）
      onConfirmTool: async () => true,
    })) {
      // --json 模式：实时输出 JSONL 事件流
      if (args.json) {
        const jsonlEvent = eventToJsonl(event);
        process.stdout.write(JSON.stringify(jsonlEvent) + '\n');
      }

      switch (event.type) {
        case 'text_delta':
          finalContent += event.text;
          break;
        case 'done':
          if (event.content) finalContent = event.content;
          break;
        case 'error':
          hasError = true;
          errorMessage = event.error;
          break;
      }
    }
  } catch (err) {
    hasError = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // 7. 输出最终结果
  if (hasError) {
    if (!args.json) {
      process.stderr.write(`错误：${errorMessage}\n`);
    }
    return EXEC_EXIT_CODE.FAILURE;
  }

  // --output-schema 模式：验证最终答案
  if (args.outputSchema) {
    const validation = validateOutputSchema(finalContent, args.outputSchema);
    if (!validation.valid) {
      if (args.json) {
        const event: JsonlEvent = {
          type: 'schema_validation_failed',
          timestamp: new Date().toISOString(),
          error: validation.error,
          content: finalContent,
        };
        process.stdout.write(JSON.stringify(event) + '\n');
      } else {
        process.stderr.write(`错误：最终答案不符合指定的 JSON Schema：${validation.error}\n`);
        process.stderr.write(`答案内容：${finalContent}\n`);
      }
      return EXEC_EXIT_CODE.FAILURE;
    }
  }

  // 非 --json 模式：输出纯文本结果到 stdout
  if (!args.json) {
    process.stdout.write(finalContent + '\n');
  }

  return EXEC_EXIT_CODE.SUCCESS;
}
