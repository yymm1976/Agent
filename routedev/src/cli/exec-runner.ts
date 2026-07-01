// src/cli/exec-runner.ts
// Phase 47 Task 3：非交互 exec 模式执行器
// 支持工具白名单、工作模式权限、总超时（陷阱 #135）、进度走 stderr / 结果走 stdout
//
// 设计要点：
//   1. 进度信息输出到 stderr，结果输出到 stdout（或 --output 指定的文件）
//   2. 总超时使用 Promise.race 实现，超时返回退出码 2（陷阱 #135）
//   3. headless 模式下 always-ask 工具自动 deny（不卡在等待确认）
//   4. 工具白名单通过向 PermissionEngine 添加 deny 规则实现
//   5. runExec 接受可选的 executeFn 参数，便于测试注入 mock 实现

import { loadConfig } from '../config/loader.js';
import { logger } from '../utils/logger.js';
import { LLMClientManager } from '../router/llm/index.js';
import { TokenTracker } from '../router/tracker.js';
import { ScenarioClassifier } from '../router/classifier.js';
import { ModelRouter } from '../router/router.js';
import { buildRouterConfig } from '../router/config.js';
import { createAppDependencies } from './app-init.js';
import { registerPermissionMiddleware } from './plugin-init.js';
import { validateProviders, formatValidationMessages } from '../utils/provider-validator.js';
import { PermissionEngine, type SandboxLevel } from '../tools/permission-engine.js';
import type { AutonomyMode } from '../config/schema.js';
import type { ExecArgs, ExecWorkMode } from './args.js';
import * as fs from 'node:fs';

/** exec 模式退出码 */
export const EXEC_EXIT_CODE = {
  SUCCESS: 0,
  FAILURE: 1,
  TIMEOUT: 2,
} as const;

/** exec 执行结果（内部传递，最终转换为 stdout 输出） */
export interface ExecResult {
  /** 是否成功 */
  success: boolean;
  /** 最终输出内容 */
  output: string;
  /** 错误信息（失败时） */
  error?: string;
  /** 执行步数 */
  steps: number;
}

/** 执行函数类型（可注入 mock 用于测试） */
export type ExecuteFn = (
  args: ExecArgs,
  progress: (msg: string) => void,
  signal?: AbortSignal,
) => Promise<ExecResult>;

/**
 * 应用工作模式权限到 PermissionEngine
 *
 * - setSandboxLevel: 设置沙箱级（read-only / workspace-write / full-access）
 * - setHeadlessMode(true): headless 模式下 always-ask 工具自动 deny（陷阱 #135）
 *
 * @param engine 权限引擎
 * @param workMode 工作模式
 */
export function applyWorkMode(engine: PermissionEngine, workMode: ExecWorkMode): void {
  engine.setSandboxLevel(workMode as SandboxLevel);
  engine.setHeadlessMode(true);
}

/**
 * 应用工具白名单到 PermissionEngine
 *
 * 为不在白名单中的工具添加 deny 规则，使其被拒绝调用。
 *
 * @param engine 权限引擎
 * @param allTools 所有已注册的工具名列表
 * @param allowedTools 允许使用的工具名列表
 */
export function applyToolWhitelist(
  engine: PermissionEngine,
  allTools: string[],
  allowedTools: string[],
): void {
  const allowedSet = new Set(allowedTools);
  for (const toolName of allTools) {
    if (!allowedSet.has(toolName)) {
      engine.addRule({
        id: `deny-whitelist-${toolName}`,
        layer: 'deny',
        toolPattern: toolName,
        description: `白名单限制: ${toolName} 不在允许列表`,
      });
    }
  }
}

/**
 * 执行 exec 子命令
 *
 * 流程：
 *   1. 设置总超时（Promise.race，陷阱 #135）
 *   2. 进度输出到 stderr
 *   3. 调用 executeFn 执行任务
 *   4. 结果输出到 stdout（JSON 或 text 格式）或 --output 指定的文件
 *
 * @param args exec 参数
 * @param executeFn 执行函数（可选，默认为 defaultExecuteFn；测试时可注入 mock）
 * @returns 退出码（0=成功，1=失败，2=超时）
 */
export async function runExec(
  args: ExecArgs,
  executeFn: ExecuteFn = defaultExecuteFn,
): Promise<number> {
  // 进度回调：输出到 stderr，不污染 stdout
  const progress = (msg: string): void => {
    process.stderr.write(`[exec] ${msg}\n`);
  };

  progress(`开始执行任务，工作模式: ${args.workMode}，超时: ${args.timeout}ms，最大步数: ${args.maxSteps}`);

  // 总超时控制（陷阱 #135）：使用 Promise.race 实现超时
  // I2 修复：超时时通过 AbortController 取消正在运行的 Agent/LLM/工具调用
  let timeoutHandle: NodeJS.Timeout | null = null;
  let timedOut = false;
  const abortController = new AbortController();
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      reject(new Error('EXEC_TIMEOUT'));
    }, args.timeout);
  });

  try {
    const exitCode = await Promise.race([
      executeAndFormat(args, executeFn, progress, abortController.signal),
      timeoutPromise,
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return exitCode;
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut) {
      progress(`任务执行超时（${args.timeout} 毫秒）`);
      outputResult(args, {
        success: false,
        output: '',
        error: `任务执行超时（${args.timeout} 毫秒）`,
        steps: 0,
      });
      return EXEC_EXIT_CODE.TIMEOUT;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    progress(`任务执行失败（${errorMessage}）`);
    outputResult(args, {
      success: false,
      output: '',
      error: errorMessage,
      steps: 0,
    });
    return EXEC_EXIT_CODE.FAILURE;
  }
}

/**
 * 调用 executeFn 执行任务并格式化输出
 */
async function executeAndFormat(
  args: ExecArgs,
  executeFn: ExecuteFn,
  progress: (msg: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const result = await executeFn(args, progress, signal);
    outputResult(args, result);
    return result.success ? EXEC_EXIT_CODE.SUCCESS : EXEC_EXIT_CODE.FAILURE;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    progress(`任务执行异常: ${errorMessage}`);
    outputResult(args, {
      success: false,
      output: '',
      error: errorMessage,
      steps: 0,
    });
    return EXEC_EXIT_CODE.FAILURE;
  }
}

/**
 * 输出结果到 stdout 或文件
 *
 * - JSON 格式：输出 { success, output, error?, steps } 结构
 * - text 格式：成功时输出 output，失败时输出 error 到 stderr
 * - --output 指定文件时，将结果写入文件而非 stdout
 */
function outputResult(args: ExecArgs, result: ExecResult): void {
  if (args.outputFormat === 'json') {
    const jsonResult: Record<string, unknown> = {
      success: result.success,
      output: result.output,
      steps: result.steps,
    };
    if (result.error) {
      jsonResult['error'] = result.error;
    }
    const output = JSON.stringify(jsonResult) + '\n';
    if (args.outputFile) {
      fs.writeFileSync(args.outputFile, output, 'utf-8');
    } else {
      process.stdout.write(output);
    }
  } else {
    // text 格式
    if (result.success) {
      const output = result.output + '\n';
      if (args.outputFile) {
        fs.writeFileSync(args.outputFile, output, 'utf-8');
      } else {
        process.stdout.write(output);
      }
    } else {
      // 失败时错误信息走 stderr，不污染 stdout
      process.stderr.write(`错误：${result.error ?? '未知错误'}\n`);
    }
  }
}

/**
 * 默认执行函数：装配服务、应用权限、运行 ReAct Loop
 *
 * 复用 createAppDependencies 装配全部服务依赖，但不渲染 Ink UI。
 * 应用工作模式权限（setSandboxLevel + setHeadlessMode）和工具白名单。
 */
async function defaultExecuteFn(
  args: ExecArgs,
  progress: (msg: string) => void,
  signal?: AbortSignal,
): Promise<ExecResult> {
  progress('加载配置...');
  // 接线修复：原实现固定传 {} 走默认全局配置，忽略 args.configPath
  // 导致 GitHub Action 通过 --config 注入的临时配置无法生效
  // 现透传给 loadConfig.globalConfigPath，未指定时仍走默认路径
  const config = args.configPath
    ? loadConfig({ globalConfigPath: args.configPath })
    : loadConfig({});

  progress('初始化 LLM 客户端...');
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

  const readyClients = clientManager.getReadyClients();
  if (readyClients.length === 0) {
    return {
      success: false,
      output: '',
      error: '没有可用的 LLM 客户端，请检查 Provider 配置',
      steps: 0,
    };
  }

  // 构建路由配置
  progress('构建路由配置...');
  const routerConfig = buildRouterConfig(config);
  const tracker = new TokenTracker(routerConfig.budget);
  const classifierClient = readyClients[0].client;
  const classifier = new ScenarioClassifier({
    llmClient: classifierClient,
    classifierModel: routerConfig.classifierModel,
  });
  const modelRouter = new ModelRouter(
    routerConfig,
    tracker,
    config.providers,
    undefined,
    config.execution,
    config.reasoningMode,
  );

  // 装配全部服务依赖（复用 App 的装配逻辑，但不渲染 Ink UI）
  progress('装配服务依赖...');
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

  // 应用工作模式权限（setSandboxLevel + setHeadlessMode）
  progress(`应用工作模式权限: ${args.workMode}`);
  applyWorkMode(deps.permissionEngine, args.workMode);

  // 应用工具白名单（如有 allowedTools）
  if (args.allowedTools && args.allowedTools.length > 0) {
    progress(`应用工具白名单: ${args.allowedTools.join(', ')}`);
    const allToolNames = deps.registry.list().map((t) => t.definition.name);
    applyToolWhitelist(deps.permissionEngine, allToolNames, args.allowedTools);
  }

  // C1 修复：注册权限中间件到 middleware pipeline，否则 PermissionEngine 的
  // sandbox/headless/whitelist 规则不会被 Agent Loop 调用，权限模型静默失效。
  // 交互模式在 App.tsx 中注册，exec/headless 路径此前遗漏了这一步。
  progress('注册权限中间件');
  const autonomyModeRef: { current: AutonomyMode } = {
    current: config.autonomy?.defaultMode ?? 'semi',
  };
  // headless 模式：confirm 决策直接 deny（onConfirmTool 已返回 true，
  // 但 PermissionEngine 内部 headless 模式会让 always-ask 工具走 deny）
  const commandBridgeRef = {
    current: {
      requestConfirm: async (_p: string): Promise<boolean> => false,
    },
  };
  registerPermissionMiddleware(
    deps.middlewarePipeline,
    deps.permissionEngine,
    autonomyModeRef,
    commandBridgeRef,
  );

  // 场景分类 + 路由
  progress('场景分类与路由...');
  const classification = await classifier.classify({ query: args.prompt });
  const routeDecision = await modelRouter.route(classification);
  const llmClient = clientManager.get(routeDecision.providerId) ?? readyClients[0].client;

  // 运行 ReAct Loop
  progress('运行 ReAct Loop...');
  let finalContent = '';
  let hasError = false;
  let errorMessage = '';
  let stepCount = 0;

  const systemPrompt = '你是一个专注的开发助手。请直接完成任务并给出最终答案。';

  try {
    for await (const event of deps.agentLoop.run({
      userMessage: args.prompt,
      llmClient,
      routeDecision,
      conversationHistory: [],
      systemPrompt,
      // I2 修复：传入取消信号，超时后 Agent Loop 会中断 LLM 流和工具执行
      signal,
      onModelSuccess: modelId => modelRouter.recordModelSuccess(modelId),
      onModelFailure: modelId => modelRouter.recordModelFailure(modelId),
      // headless 模式：always-ask 工具已被 PermissionEngine deny，不会触发确认
      // 非 always-ask 的 confirm 工具在 headless 下自动批准（CI 场景）
      onConfirmTool: async () => true,
    })) {
      switch (event.type) {
        case 'thinking':
          stepCount++;
          progress(`步骤 ${stepCount}/${args.maxSteps}: ${event.message}`);
          break;
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

      // 检查最大步数
      if (stepCount >= args.maxSteps) {
        progress(`已达最大步数 ${args.maxSteps}，停止执行`);
        break;
      }
    }
  } catch (err) {
    hasError = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (hasError) {
    progress(`任务失败: ${errorMessage}`);
    return {
      success: false,
      output: '',
      error: errorMessage,
      steps: stepCount,
    };
  }

  progress('任务完成');
  return {
    success: true,
    output: finalContent,
    steps: stepCount,
  };
}
