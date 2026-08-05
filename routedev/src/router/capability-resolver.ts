// src/router/capability-resolver.ts
// B-14：Provider/Model 运行时能力声明与显式降级
//
// 设计目的：
//   模型配置中的 capabilities 标签（tool_use / streaming / parallel_tool_calls / multimodal）
//   声明"这个模型能用什么"。本模块把声明解析为执行决策，缺失的能力显式降级
//   （降级原因以 human-readable 字符串返回），模型特例不散落在适配器各处。
//
// 语义：
//   - 白名单：未声明 = 不支持 = 降级（用户自定义模型未标 tool_use 时，工具调用被显式关闭）
//   - 内置模型由 router 在路由后从 model-catalog 合并能力标签，保证开箱即用
//   - 降级总是显式：decision.degradations 携带原因，消费方记录/展示，不静默吞掉
//
// 消费点：
//   - src/agent/loop.ts（run 开头解析一次，run 期间生效：tools 不传/串行/禁图像/预算提示）
//   - 未来适配器/工具面层可复用同一决策（单一真相源）

/** 调用方意图（某次 run/请求需要哪些能力） */
export interface CapabilityRequest {
  /** 本次 run 是否使用工具调用 */
  wantsTools?: boolean;
  /** 本次 run 是否可能注入图片输入 */
  wantsImages?: boolean;
  /** 本次 run 是否允许并行工具执行 */
  wantsParallelTools?: boolean;
}

/** 能力解析决策（消费方按字段执行，degradations 用于显式记录） */
export interface CapabilityDecision {
  /** 是否向模型暴露工具 schema（false = 本次 run 纯文本） */
  toolsEnabled: boolean;
  /** 是否允许图片输入注入（false = 图片被剥离/拒绝） */
  imageInputEnabled: boolean;
  /** 是否允许并行工具执行（false = 串行执行） */
  parallelToolsEnabled: boolean;
  /** 是否支持流式（false = 适配器应切非流式或显式失败） */
  streamingEnabled: boolean;
  /** 工具 schema 最大 token 预算 */
  maxSchemaTokens: number;
  /** 显式降级原因（人类可读，空数组 = 无降级） */
  degradations: string[];
}

const EMPTY: readonly string[] = [];

/**
 * 解析模型能力声明为执行决策。
 * @param capabilities 模型声明的能力标签（缺失视为不支持，显式降级）
 * @param maxSchemaTokens 工具 schema token 预算（默认 4096）
 * @param request 本次 run 的能力需求（不请求的能力不判降级）
 */
export function resolveCapabilities(
  capabilities: readonly string[] | undefined,
  maxSchemaTokens: number | undefined,
  request: CapabilityRequest = {},
): CapabilityDecision {
  const caps = capabilities ?? EMPTY;
  const degradations: string[] = [];

  const has = (c: string): boolean => caps.includes(c);

  let toolsEnabled = true;
  if (request.wantsTools && !has('tool_use')) {
    toolsEnabled = false;
    degradations.push('模型未声明 tool_use：工具调用被禁用，本次 run 以纯文本执行');
  }

  let imageInputEnabled = true;
  if (request.wantsImages && !has('multimodal')) {
    imageInputEnabled = false;
    degradations.push('模型未声明 multimodal：图片输入被剥离');
  }

  let parallelToolsEnabled = true;
  if (request.wantsParallelTools && !has('parallel_tool_calls')) {
    parallelToolsEnabled = false;
    degradations.push('模型未声明 parallel_tool_calls：工具调用改为串行执行');
  }

  const streamingEnabled = has('streaming');
  if (request.wantsTools && !streamingEnabled) {
    degradations.push('模型未声明 streaming：流式输出不支持，调用方需显式处理');
  }

  const budget = maxSchemaTokens ?? 4096;
  return {
    toolsEnabled,
    imageInputEnabled,
    parallelToolsEnabled,
    streamingEnabled,
    maxSchemaTokens: budget,
    degradations,
  };
}
