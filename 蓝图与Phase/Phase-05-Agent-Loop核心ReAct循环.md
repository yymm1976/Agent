# Phase 5：Agent Loop 核心（ReAct 循环）

**回应**：Phase 2-4 无 CONCERN（执行人未上报）

**观察记录**（非 CONCERN，但影响本 Phase 设计）：
| # | 来源 | 观察 | 本 Phase 处理 |
|---|------|------|-------------|
| O1 | 执行报告 | App.tsx 使用非流式调用（Phase 4 spec 要求流式） | **本 Phase 修复**：重构 App.tsx 使用 ReAct Loop 的流式输出 |
| O2 | 执行报告 | ModelConfig 使用 `provider` 而非蓝图 Phase 2 的 `providerId` | 本 Phase 代码以执行人实际的 types.ts 为准，如有差异用 CONCERN 上报 |
| O3 | 执行报告 | OpenAI SDK 6.x tool_calls 结构变化，用了 `(tc as { function?: {...} }).function` 类型断言 | Phase 6 工具层实现时统一处理，本 Phase 不涉及工具调用具体实现 |
| O4 | 执行报告 | TokenTracker 增加了磁盘持久化 | 本 Phase 正常使用 tracker.record() 接口，不受影响 |
| O5 | 执行报告 | Ink 7.0.6 + React 19.2.7（较新版本） | 本 Phase 按 Ink 7 API 编写，如有不兼容用 CONCERN 上报 |

---

**目标**：实现 ReAct Agent Loop（AsyncGenerator 流式输出），这是 RouteDev 的核心引擎——LLM 返回文本则输出，返回工具调用则执行并循环，直到获得最终回答。本 Phase 的工具执行器为最小桩实现（Phase 6 才实现真正的工具层）。

**蓝图参考**：第五节决策 1（ReAct 循环）、第五节决策 2（主进程+子进程）、第七节 7.1（Agent Loop 详细规格）、design-routedev-spec.md §2.1-2.3（Agent 层接口）

**前置依赖**：Phase 2-4 全部完成

---

## 架构说明

Phase 5 是 RouteDev 的"引擎"。前四个 Phase 搭建了底盘（配置）、发动机（LLM 客户端）、变速箱（Router）、方向盘（CLI）。本 Phase 安装引擎——让 LLM 真正"动起来"。

```
用户消息
  ↓
App.tsx（CLI 层）
  ↓
ReActAgentLoop.run()
  ↓
  ┌─ 迭代 1：LLM 流式调用 → 返回 text → yield text_delta → 循环结束
  │
  └─ 迭代 1：LLM 流式调用 → 返回 tool_call → StepExecutor 执行 → 结果注入上下文
     └─ 迭代 2：LLM 流式调用 → 返回 text → yield text_delta → 循环结束
        （最多 maxIterations 次）
```

**关键设计决策**：
1. **Loop 不做路由和分类**——路由（RouteDecision）由 CLI 层预先计算，Loop 只接收 modelId + providerId
2. **Loop 不直接依赖工具实现**——通过 `ToolExecutorAdapter` 接口解耦，Phase 6 替换为真实实现
3. **流式优先**——每次 LLM 调用都用 chatStream，yield 出 text_delta 事件，CLI 层实时渲染
4. **错误注入上下文**——工具执行失败时，错误信息作为 tool 消息注入，LLM 可自主决定重试或换策略
5. **防御性设计**——maxIterations 防止死循环，AbortSignal 支持用户取消

---

## 具体任务

### Task 1：Agent 循环配置类型

**文件：** 创建 `src/agent/loop-config.ts`

本文件定义 ReAct 循环所需的配置和事件类型。`src/agent/types.ts` 已有 `AgentEvent`、`AgentEventType` 等通用类型，本文件补充循环特有的配置。

- [ ] **Step 1：创建循环配置**

```typescript
// src/agent/loop-config.ts
// ReAct Agent Loop 的配置和辅助类型
// agent/types.ts 已定义 AgentEvent 等通用类型，这里只补充循环配置

import type { LLMToolDefinition } from '../router/types.js';

/** ReAct 循环配置 */
export interface ReActConfig {
  /** 最大迭代次数（防止死循环，默认 10） */
  maxIterations: number;
  /** 单次 LLM 调用的超时时间（毫秒，默认 120000） */
  llmTimeout: number;
  /** 是否启用工具调用（Phase 5 默认 false，Phase 6 改为 true） */
  toolsEnabled: boolean;
  /** 最大连续错误次数，超过则终止循环（默认 3） */
  maxConsecutiveErrors: number;
}

/** 默认循环配置 */
export const DEFAULT_REACT_CONFIG: ReActConfig = {
  maxIterations: 10,
  llmTimeout: 120000,
  toolsEnabled: false,
  maxConsecutiveErrors: 3,
};

/** 工具执行适配器接口
 *  Phase 5 使用最小桩实现，Phase 6 替换为完整的 ToolRegistry + ToolExecutor
 */
export interface ToolExecutorAdapter {
  /** 获取当前可用的工具定义（给 LLM 的 function calling schema） */
  getToolDefinitions(): LLMToolDefinition[];

  /** 执行一个工具调用，返回结果文本
   *  如果工具不存在或执行失败，返回错误描述（不抛异常）
   */
  executeTool(toolName: string, toolCallId: string, args: string): Promise<string>;

  /** 检查指定工具是否存在 */
  hasTool(toolName: string): boolean;
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build && pnpm typecheck
git add src/agent/loop-config.ts
git commit -m "feat(agent): define ReAct loop config and tool executor adapter interface"
```

---

### Task 2：最小工具执行器（Phase 5 桩实现）

**文件：** 创建 `src/agent/executor.ts`

Phase 5 的工具执行器是一个"无工具"桩——当 LLM 返回工具调用时，返回"工具暂不可用"的提示，让 LLM 改为文本回答。Phase 6 会替换为真实实现。

- [ ] **Step 1：创建最小工具执行器**

```typescript
// src/agent/executor.ts
// Phase 5 最小工具执行器
// 所有工具调用都返回"暂不可用"提示
// Phase 6 会替换为真实的 ToolRegistry + ToolExecutor

import type { LLMToolDefinition } from '../router/types.js';
import type { ToolExecutorAdapter } from './loop-config.js';
import { logger } from '../utils/logger.js';

/**
 * 无工具执行器（Phase 5 桩实现）
 * 当 LLM 尝试调用工具时，返回提示信息让 LLM 用文本回答
 */
export class NoOpToolExecutor implements ToolExecutorAdapter {
  getToolDefinitions(): LLMToolDefinition[] {
    // Phase 5 没有可用工具
    return [];
  }

  async executeTool(toolName: string, toolCallId: string, _args: string): Promise<string> {
    logger.warn('Tool call rejected (tools not available)', { toolName, toolCallId });
    return `[系统提示] 工具 "${toolName}" 当前不可用。请用文本直接回答用户的问题，不要尝试调用工具。`;
  }

  hasTool(_toolName: string): boolean {
    return false;
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build && pnpm typecheck
git add src/agent/executor.ts
git commit -m "feat(agent): add NoOp tool executor stub for Phase 5"
```

---

### Task 3：默认 System Prompt

**文件：** 创建 `src/agent/prompts.ts`

定义 ReAct 循环使用的默认系统提示。Phase 15 会被 PromptTemplateManager 替代，但 Phase 5 先用硬编码。

- [ ] **Step 1：创建默认 Prompt**

```typescript
// src/agent/prompts.ts
// 默认 System Prompt
// Phase 5 先硬编码，Phase 15 由 PromptTemplateManager 统一管理

/** 默认系统提示（中文） */
export const DEFAULT_SYSTEM_PROMPT_ZH = `你是 RouteDev，一个智能开发助手。

## 你的能力
- 智能路由：根据你的判断自动选择最合适的模型回答问题
- 代码辅助：帮助阅读、编写、修改、调试代码
- 项目管理：帮助分解任务、规划开发步骤

## 回答规范
- 使用中文回答（除非用户用英文提问）
- 代码块使用正确的语言标记
- 回答简洁清晰，避免不必要的重复
- 如果不确定，诚实说明并给出你的最佳判断

## 当前状态
- 工作模式：Build（读写执行）
- 自主度：半自动（关键步骤前会确认）`;

/** 默认系统提示（英文） */
export const DEFAULT_SYSTEM_PROMPT_EN = `You are RouteDev, an intelligent development assistant.

## Your Capabilities
- Smart routing: automatically selects the best model based on task complexity
- Code assistance: read, write, modify, and debug code
- Project management: decompose tasks and plan development steps

## Response Guidelines
- Respond in English (unless the user asks in another language)
- Use correct language tags for code blocks
- Be concise and clear, avoid unnecessary repetition
- If unsure, be honest and provide your best judgment`;

/** 根据语言选择系统提示 */
export function getSystemPrompt(language: string = 'zh-CN'): string {
  if (language.startsWith('zh')) {
    return DEFAULT_SYSTEM_PROMPT_ZH;
  }
  return DEFAULT_SYSTEM_PROMPT_EN;
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build && pnpm typecheck
git add src/agent/prompts.ts
git commit -m "feat(agent): add default system prompts for zh-CN and en"
```

---

### Task 4：ReAct Agent Loop 核心实现

**文件：** 创建 `src/agent/loop.ts`

这是整个项目最核心的文件。ReAct 循环用 AsyncGenerator 实现，每次 LLM 调用都使用流式输出，yield 出 `AgentEvent` 事件供 CLI 层消费。

- [ ] **Step 1：实现 ReAct Agent Loop**

```typescript
// src/agent/loop.ts
// ReAct Agent Loop — RouteDev 的核心引擎
//
// 设计原则：
// 1. Loop 不做路由和分类（由调用方预先计算）
// 2. 流式优先（每次 LLM 调用都用 chatStream）
// 3. 错误注入上下文（工具失败不中断循环，而是让 LLM 自主处理）
// 4. 防御性设计（maxIterations + AbortSignal）
//
// 事件流：
//   run() → yield thinking → yield text_delta* → yield done
//         → yield thinking → yield tool_call_start → yield tool_call_result → (循环)
//         → yield error → yield done

import type {
  LLMClient,
  LLMMessage,
  LLMToolDefinition,
  StreamEvent,
  RouteDecision,
  TokenUsageInfo,
} from '../router/types.js';
import type { AgentEvent } from './types.js';
import type { ReActConfig, ToolExecutorAdapter } from './loop-config.js';
import { DEFAULT_REACT_CONFIG } from './loop-config.js';
import { logger } from '../utils/logger.js';

/** ReAct 循环运行参数 */
export interface ReActRunParams {
  /** 用户原始消息 */
  userMessage: string;
  /** LLM 客户端（已选定的 provider 对应的客户端） */
  llmClient: LLMClient;
  /** 路由决策（包含 modelId 和 providerId） */
  routeDecision: RouteDecision;
  /** 对话历史（不包含当前消息） */
  conversationHistory: LLMMessage[];
  /** 系统提示（可选，不传则不加系统消息） */
  systemPrompt?: string;
  /** 取消信号 */
  signal?: AbortSignal;
}

/**
 * ReAct Agent Loop
 *
 * 核心循环：think → act → observe → think → ... → final answer
 * 使用 AsyncGenerator 流式输出事件
 */
export class ReActAgentLoop {
  private config: ReActConfig;
  private toolExecutor: ToolExecutorAdapter;

  constructor(
    toolExecutor: ToolExecutorAdapter,
    config?: Partial<ReActConfig>,
  ) {
    this.config = { ...DEFAULT_REACT_CONFIG, ...config };
    this.toolExecutor = toolExecutor;
  }

  /**
   * 运行 ReAct 循环
   * yield 出 AgentEvent 事件流
   */
  async *run(params: ReActRunParams): AsyncGenerator<AgentEvent> {
    const {
      userMessage,
      llmClient,
      routeDecision,
      conversationHistory,
      systemPrompt,
      signal,
    } = params;

    // 构建初始消息列表
    const messages: LLMMessage[] = [];

    // 系统提示
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // 对话历史
    messages.push(...conversationHistory);

    // 当前用户消息
    messages.push({ role: 'user', content: userMessage });

    // 获取可用工具定义
    const toolDefs = this.config.toolsEnabled
      ? this.toolExecutor.getToolDefinitions()
      : [];

    let iteration = 0;
    let consecutiveErrors = 0;
    let totalUsage: TokenUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    while (iteration < this.config.maxIterations) {
      // 检查取消信号
      if (signal?.aborted) {
        yield { type: 'error', data: '', error: '用户取消了执行' };
        yield { type: 'done', data: '' };
        return;
      }

      iteration++;

      logger.debug('ReAct iteration', {
        iteration,
        maxIterations: this.config.maxIterations,
        messageCount: messages.length,
      });

      // yield thinking 事件
      yield {
        type: 'thinking',
        data: `模型思考中... (${routeDecision.modelId}, 迭代 ${iteration})`,
      };

      try {
        // ===== LLM 流式调用 =====
        const result = yield* this.callLLMStream(
          llmClient,
          routeDecision.modelId,
          messages,
          toolDefs,
          signal,
        );

        // 累加 usage
        if (result.usage) {
          totalUsage.inputTokens += result.usage.inputTokens;
          totalUsage.outputTokens += result.usage.outputTokens;
          totalUsage.totalTokens += result.usage.totalTokens;
        }

        consecutiveErrors = 0; // 成功，重置错误计数

        // ===== 判断：文本回复 or 工具调用？ =====

        if (result.toolCalls && result.toolCalls.length > 0) {
          // ----- 有工具调用 -----

          // 将 assistant 消息（含 tool_calls）加入上下文
          messages.push({
            role: 'assistant',
            content: result.content || '',
            toolCalls: result.toolCalls,
          });

          // 执行每个工具调用
          for (const toolCall of result.toolCalls) {
            yield {
              type: 'tool_call_start',
              data: toolCall.name,
            };

            let toolResult: string;

            if (this.config.toolsEnabled && this.toolExecutor.hasTool(toolCall.name)) {
              // 有工具，执行
              toolResult = await this.toolExecutor.executeTool(
                toolCall.name,
                toolCall.id,
                toolCall.arguments,
              );
            } else {
              // 无工具，返回提示
              toolResult = await this.toolExecutor.executeTool(
                toolCall.name,
                toolCall.id,
                toolCall.arguments,
              );
            }

            yield {
              type: 'tool_call_result',
              data: toolResult,
            };

            // 将工具结果注入上下文
            messages.push({
              role: 'tool',
              content: toolResult,
              toolCallId: toolCall.id,
            });
          }

          // 继续循环——LLM 会根据工具结果生成下一轮回复
          continue;
        }

        // ----- 无工具调用，文本回复 → 循环结束 -----
        yield {
          type: 'done',
          data: result.content,
          usage: totalUsage,
        };
        return;

      } catch (error) {
        consecutiveErrors++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error('ReAct iteration error', {
          iteration,
          consecutiveErrors,
          error: errorMessage,
        });

        if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
          yield {
            type: 'error',
            data: '',
            error: `连续 ${consecutiveErrors} 次错误，终止执行。最后错误: ${errorMessage}`,
            usage: totalUsage,
          };
          yield { type: 'done', data: '' };
          return;
        }

        // 将错误注入上下文，让 LLM 知道发生了什么
        const errorContext = `[系统错误] 上一次调用出错: ${errorMessage}。请直接用文本回复用户，不要尝试调用工具。`;
        messages.push({ role: 'user', content: errorContext });

        yield {
          type: 'error',
          data: '',
          error: `迭代 ${iteration} 出错: ${errorMessage}，正在重试...`,
        };
      }
    }

    // 达到最大迭代次数
    yield {
      type: 'error',
      data: '',
      error: `达到最大迭代次数 (${this.config.maxIterations})，终止执行`,
      usage: totalUsage,
    };
    yield { type: 'done', data: '' };
  }

  /**
   * 执行一次 LLM 流式调用
   * yield text_delta 事件，返回完整的工具调用和 usage
   */
  private async *callLLMStream(
    client: LLMClient,
    modelId: string,
    messages: LLMMessage[],
    toolDefs: LLMToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, {
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    usage?: TokenUsageInfo;
  }> {
    let fullContent = '';
    let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let usage: TokenUsageInfo | undefined;

    const stream = client.chatStream({
      model: modelId,
      messages,
      stream: true,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      timeout: this.config.llmTimeout,
    });

    // 工具调用参数累积缓冲
    const toolCallBuffers = new Map<string, { id: string; name: string; arguments: string }>();

    for await (const event of stream) {
      // 检查取消
      if (signal?.aborted) break;

      switch (event.type) {
        case 'text_delta':
          fullContent += event.data;
          yield { type: 'text_delta', data: event.data };
          break;

        case 'tool_call_start': {
          // 解析工具调用开始
          try {
            const parsed = JSON.parse(event.data) as { id?: string; name?: string };
            const tcId = parsed.id ?? `tc-${Date.now()}`;
            const tcName = parsed.name ?? 'unknown';
            toolCallBuffers.set(tcId, { id: tcId, name: tcName, arguments: '' });
          } catch {
            logger.warn('Failed to parse tool_call_start', { data: event.data });
          }
          break;
        }

        case 'tool_call_delta': {
          // 累积工具调用参数
          // 将 delta 追加到最后一个 buffer
          const lastBuffer = Array.from(toolCallBuffers.values()).pop();
          if (lastBuffer) {
            lastBuffer.arguments += event.data;
          }
          break;
        }

        case 'tool_call_end': {
          // 工具调用结束
          try {
            const parsed = JSON.parse(event.data) as { id: string; name: string; arguments?: string };
            const buffer = toolCallBuffers.get(parsed.id);
            if (buffer) {
              // 使用 end 事件的完整 arguments（如果有），否则用 buffer 中累积的
              if (parsed.arguments) {
                buffer.arguments = parsed.arguments;
              }
              toolCalls.push(buffer);
            }
          } catch {
            logger.warn('Failed to parse tool_call_end', { data: event.data });
          }
          break;
        }

        case 'usage':
          if (event.usage) {
            usage = event.usage;
          }
          break;

        case 'error':
          throw new Error(event.error ?? 'LLM stream error');

        case 'done':
          // 流结束，收集最终的 tool calls
          // 如果有 tool_call_end 没触发（某些 provider），从 buffer 中取
          if (toolCalls.length === 0) {
            for (const [, buffer] of toolCallBuffers) {
              if (buffer.arguments) {
                toolCalls.push(buffer);
              }
            }
          }
          break;
      }
    }

    // 返回（AsyncGenerator return value）
    return { content: fullContent, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage };
  }

  /** 更新工具执行器（Phase 6 替换为真实实现时调用） */
  updateToolExecutor(executor: ToolExecutorAdapter): void {
    this.toolExecutor = executor;
  }

  /** 更新配置 */
  updateConfig(config: Partial<ReActConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
```

- [ ] **Step 2：构建验证**

```powershell
pnpm build
pnpm typecheck
```

预期：BUILD SUCCESSFUL

- [ ] **Step 3：提交**

```powershell
git add src/agent/loop.ts
git commit -m "feat(agent): implement ReAct agent loop with streaming, tool call handling, and error recovery"
```

---

### Task 5：ReAct 循环单元测试

**文件：** 创建 `tests/agent/loop.test.ts`

由于 LLM 客户端依赖外部 API，测试使用 mock 客户端。关键测试点：
1. 纯文本回复（无工具调用）→ 循环在 1 次迭代后结束
2. 工具调用 → 结果注入上下文 → LLM 第 2 次返回文本
3. 达到 maxIterations 限制 → 循环终止
4. 连续错误达上限 → 循环终止
5. AbortSignal 取消 → 循环终止
6. Usage 正确累加

- [ ] **Step 1：创建 Mock LLM 客户端**

```typescript
// tests/agent/helpers/mock-llm-client.ts
// 测试用的 Mock LLM 客户端
import type {
  LLMClient,
  LLMRequestOptions,
  LLMResponse,
  StreamEvent,
  Protocol,
  ToolCallInfo,
  TokenUsageInfo,
} from '../../../src/router/types.js';

/** Mock 响应配置 */
interface MockResponse {
  content: string;
  toolCalls?: ToolCallInfo[];
  usage?: TokenUsageInfo;
}

/**
 * Mock LLM 客户端
 * 按顺序返回预设的响应（用于测试 ReAct 循环的各种路径）
 */
export class MockLLMClient implements LLMClient {
  readonly protocol: Protocol = 'openai';
  private responses: MockResponse[];
  private callIndex = 0;

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  isReady(): boolean {
    return true;
  }

  /** 记录收到的请求（用于断言） */
  receivedRequests: LLMRequestOptions[] = [];

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    this.receivedRequests.push(options);
    const response = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;

    return {
      content: response.content,
      toolCalls: response.toolCalls,
      finishReason: response.toolCalls ? 'tool_calls' : 'stop',
      usage: response.usage ?? { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      modelId: options.model,
    };
  }

  async *chatStream(options: LLMRequestOptions): AsyncGenerator<StreamEvent> {
    this.receivedRequests.push(options);
    const response = this.responses[this.callIndex] ?? this.responses[this.responses.length - 1];
    this.callIndex++;

    // 模拟文本增量输出
    if (response.content) {
      // 按字符拆分，模拟真实流式
      const chunks = response.content.match(/.{1,10}/g) ?? [response.content];
      for (const chunk of chunks) {
        yield { type: 'text_delta', data: chunk };
      }
    }

    // 模拟工具调用
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        yield {
          type: 'tool_call_start',
          data: JSON.stringify({ id: tc.id, name: tc.name }),
        };
        yield {
          type: 'tool_call_delta',
          data: tc.arguments,
        };
        yield {
          type: 'tool_call_end',
          data: JSON.stringify({ id: tc.id, name: tc.name, arguments: tc.arguments }),
        };
      }
    }

    // usage 和 done
    yield {
      type: 'usage',
      data: '',
      usage: response.usage ?? { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    };
    yield { type: 'done', data: '' };
  }

  /** 获取已调用次数 */
  get callCount(): number {
    return this.callIndex;
  }
}
```

- [ ] **Step 2：创建 Mock 工具执行器**

```typescript
// tests/agent/helpers/mock-tool-executor.ts
import type { LLMToolDefinition } from '../../../src/router/types.js';
import type { ToolExecutorAdapter } from '../../../src/agent/loop-config.js';

/**
 * Mock 工具执行器
 * 支持预注册工具和处理逻辑
 */
export class MockToolExecutor implements ToolExecutorAdapter {
  private tools = new Map<string, {
    definition: LLMToolDefinition;
    handler: (args: string) => string;
  }>();

  /** 执行记录 */
  executionLog: Array<{ toolName: string; args: string; result: string }> = [];

  /** 注册一个工具 */
  registerTool(
    definition: LLMToolDefinition,
    handler: (args: string) => string,
  ): void {
    this.tools.set(definition.name, { definition, handler });
  }

  getToolDefinitions(): LLMToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  async executeTool(toolName: string, _toolCallId: string, args: string): Promise<string> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return `工具 "${toolName}" 不存在`;
    }
    const result = tool.handler(args);
    this.executionLog.push({ toolName, args, result });
    return result;
  }

  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }
}
```

- [ ] **Step 3：编写测试**

```typescript
// tests/agent/loop.test.ts
import { describe, it, expect } from 'vitest';
import { ReActAgentLoop } from '../../src/agent/loop.js';
import { NoOpToolExecutor } from '../../src/agent/executor.js';
import { MockLLMClient } from './helpers/mock-llm-client.js';
import { MockToolExecutor } from './helpers/mock-tool-executor.js';
import type { RouteDecision } from '../../src/router/types.js';

/** 测试用的路由决策 */
const testDecision: RouteDecision = {
  modelId: 'test-model',
  providerId: 'test-provider',
  tier: 'medium',
  isOverride: false,
  isDegraded: false,
  reason: 'test',
};

/** 收集 AsyncGenerator 产出的所有事件 */
async function collectEvents(gen: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('ReActAgentLoop', () => {
  describe('纯文本回复（无工具调用）', () => {
    it('应在 1 次迭代后结束', async () => {
      const mockLLM = new MockLLMClient([
        { content: '你好！我是 RouteDev。', usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 } },
      ]);
      const loop = new ReActAgentLoop(new NoOpToolExecutor());

      const events = await collectEvents(
        loop.run({
          userMessage: '你好',
          llmClient: mockLLM,
          routeDecision: testDecision,
          conversationHistory: [],
        }),
      );

      // 应有：thinking → text_delta(s) → done
      expect(events.some(e => e.type === 'thinking')).toBe(true);
      expect(events.some(e => e.type === 'text_delta')).toBe(true);
      expect(events[events.length - 1].type).toBe('done');

      // 拼接的文本应完整
      const textDeltas = events.filter(e => e.type === 'text_delta').map(e => e.data).join('');
      expect(textDeltas).toBe('你好！我是 RouteDev。');

      // LLM 应只被调用 1 次
      expect(mockLLM.callCount).toBe(1);

      // done 事件应包含 usage
      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent.usage?.totalTokens).toBe(70);
    });

    it('应正确传递 system prompt', async () => {
      const mockLLM = new MockLLMClient([
        { content: '收到' },
      ]);
      const loop = new ReActAgentLoop(new NoOpToolExecutor());

      await collectEvents(
        loop.run({
          userMessage: '测试',
          llmClient: mockLLM,
          routeDecision: testDecision,
          conversationHistory: [],
          systemPrompt: '你是测试助手',
        }),
      );

      // 检查第一条消息是否为 system prompt
      const request = mockLLM.receivedRequests[0];
      expect(request.messages[0].role).toBe('system');
      expect(request.messages[0].content).toBe('你是测试助手');
    });
  });

  describe('工具调用路径', () => {
    it('应执行工具并继续循环', async () => {
      // 第 1 次调用：返回工具调用
      // 第 2 次调用：返回文本
      const mockLLM = new MockLLMClient([
        {
          content: '',
          toolCalls: [{
            id: 'tc-1',
            name: 'read_file',
            arguments: '{"path": "main.ts"}',
          }],
          usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
        },
        {
          content: '文件内容已读取，main.ts 有 42 行代码。',
          usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
        },
      ]);

      const toolExecutor = new MockToolExecutor();
      toolExecutor.registerTool(
        { name: 'read_file', description: '读取文件', parameters: {} },
        (args) => `文件 ${JSON.parse(args).path} 的内容：console.log("hello")`,
      );

      const loop = new ReActAgentLoop(toolExecutor, { toolsEnabled: true });

      const events = await collectEvents(
        loop.run({
          userMessage: '读取 main.ts',
          llmClient: mockLLM,
          routeDecision: testDecision,
          conversationHistory: [],
        }),
      );

      // 应有工具调用事件
      expect(events.some(e => e.type === 'tool_call_start')).toBe(true);
      expect(events.some(e => e.type === 'tool_call_result')).toBe(true);

      // 最终应有文本输出
      const textDeltas = events.filter(e => e.type === 'text_delta').map(e => e.data).join('');
      expect(textDeltas).toContain('文件内容已读取');

      // LLM 应被调用 2 次
      expect(mockLLM.callCount).toBe(2);

      // 工具应被执行 1 次
      expect(toolExecutor.executionLog.length).toBe(1);
      expect(toolExecutor.executionLog[0].toolName).toBe('read_file');

      // usage 应累加
      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent.usage?.totalTokens).toBe(380); // 130 + 250
    });

    it('工具不存在时应返回提示给 LLM', async () => {
      const mockLLM = new MockLLMClient([
        {
          content: '',
          toolCalls: [{
            id: 'tc-1',
            name: 'nonexistent_tool',
            arguments: '{}',
          }],
        },
        {
          content: '抱歉，我无法调用该工具。',
        },
      ]);

      // NoOpToolExecutor 没有注册任何工具
      const loop = new ReActAgentLoop(new NoOpToolExecutor(), { toolsEnabled: true });

      const events = await collectEvents(
        loop.run({
          userMessage: '执行某个操作',
          llmClient: mockLLM,
          routeDecision: testDecision,
          conversationHistory: [],
        }),
      );

      // 应有工具调用结果（错误提示）
      const toolResult = events.find(e => e.type === 'tool_call_result');
      expect(toolResult?.data).toContain('不可用');

      // LLM 应被调用 2 次
      expect(mockLLM.callCount).toBe(2);
    });
  });

  describe('防御性设计', () => {
    it('达到 maxIterations 应终止', async () => {
      // 每次都返回工具调用，永远不返回文本
      const mockLLM = new MockLLMClient([
        {
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'loop_tool', arguments: '{}' }],
        },
      ]);

      const toolExecutor = new MockToolExecutor();
      toolExecutor.registerTool(
        { name: 'loop_tool', description: '循环工具', parameters: {} },
        () => '结果',
      );

      const loop = new ReActAgentLoop(toolExecutor, {
        toolsEnabled: true,
        maxIterations: 3,
      });

      const events = await collectEvents(
        loop.run({
          userMessage: '循环测试',
          llmClient: mockLLM,
          routeDecision: testDecision,
          conversationHistory: [],
        }),
      );

      // 应有错误事件说明达到上限
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents.some(e => e.error?.includes('最大迭代次数'))).toBe(true);

      // LLM 应被调用 3 次（maxIterations）
      expect(mockLLM.callCount).toBe(3);
    });

    it('AbortSignal 应取消执行', async () => {
      const mockLLM = new MockLLMClient([
        { content: '这个回答很长...' },
      ]);

      const controller = new AbortController();
      const loop = new ReActAgentLoop(new NoOpToolExecutor());

      // 立即取消
      controller.abort();

      const events = await collectEvents(
        loop.run({
          userMessage: '测试取消',
          llmClient: mockLLM,
          routeDecision: testDecision,
          conversationHistory: [],
          signal: controller.signal,
        }),
      );

      expect(events.some(e => e.type === 'error' && e.error?.includes('取消'))).toBe(true);
    });
  });
});
```

- [ ] **Step 4：运行全部测试**

```powershell
pnpm test
```

预期：Phase 1-4 的 73 个 + 新增 6 个 = 共 79 个测试全部通过

- [ ] **Step 5：提交**

```powershell
git add tests/agent/
git commit -m "test(agent): add unit tests for ReAct loop with mock LLM and tool executor"
```

---

### Task 6：CLI 集成（App.tsx 重构）

**文件：** 修改 `src/cli/App.tsx`（或执行人实际路径）

将 App.tsx 中的直接 LLM 调用替换为 ReActAgentLoop。这是 Phase 4 的非流式实现升级为真正流式的关键步骤。

- [ ] **Step 1：重构 handleSubmit**

核心改动点：
1. 在 App 组件中创建 `ReActAgentLoop` 实例（用 `useRef` 持有）
2. `handleSubmit` 中的 LLM 调用改为 `loop.run()`，消费 `AgentEvent` 事件流
3. `text_delta` → 更新流式消息（使用 Phase 4 已有的节流机制）
4. `tool_call_start` → 可选：在 ChatView 中显示工具调用状态
5. `done` → 记录 usage，完成处理

```typescript
// src/cli/App.tsx 中的关键改动
// （执行人需要根据当前 App.tsx 的实际结构进行适配）

import { ReActAgentLoop } from '../agent/loop.js';
import { NoOpToolExecutor } from '../agent/executor.js';
import { getSystemPrompt } from '../agent/prompts.js';

// 在 App 组件内部：

// 1. 创建 ReAct Loop 实例（useRef 持有，不触发重渲染）
const loopRef = useRef<ReActAgentLoop>(
  new ReActAgentLoop(new NoOpToolExecutor(), {
    maxIterations: 10,
    toolsEnabled: false, // Phase 5 先关闭工具
  }),
);

// 2. 获取系统提示
const systemPrompt = getSystemPrompt(config.general.language);

// 3. 重构 handleSubmit 中的 LLM 调用部分
// 替换原来的 client.chatStream / client.chat 为 ReAct Loop：

const loop = loopRef.current;
const client = clientManager.get(routeDecision.providerId);
if (!client || !client.isReady()) {
  // 错误处理...
  return;
}

const assistantId = nextId();
let assistantContent = '';

const assistantMsg: ChatMessage = {
  id: assistantId,
  role: 'assistant',
  content: '',
  tier: classifyResult.tier,
  modelId: routeDecision.modelId,
  isStreaming: true,
};
setMessages(prev => [...prev, assistantMsg]);

// 初始化节流缓冲（Phase 4 已有的机制）
streamBufferRef.current = '';
streamMsgIdRef.current = assistantId;
startFlushTimer();

try {
  const events = loop.run({
    userMessage: text,
    llmClient: client,
    routeDecision,
    conversationHistory: conversationRef.current,
    systemPrompt,
  });

  for await (const event of events) {
    switch (event.type) {
      case 'text_delta':
        // 累积到 buffer（由节流定时器批量刷新 UI）
        streamBufferRef.current += event.data;
        assistantContent = streamBufferRef.current;
        break;

      case 'tool_call_start':
        // Phase 5 暂不显示工具调用状态（Phase 6 添加 UI）
        logger.debug('Tool call requested', { toolName: event.data });
        break;

      case 'tool_call_result':
        // Phase 5 暂不显示工具结果
        logger.debug('Tool call completed');
        break;

      case 'error':
        // 显示错误信息（但循环可能还在继续重试）
        if (event.error) {
          logger.warn('ReAct loop error', { error: event.error });
        }
        break;

      case 'done':
        // 循环结束
        if (event.usage) {
          tracker.record(event.usage, {
            modelId: routeDecision.modelId,
            agentId: 'default',
            stepId: 'chat',
          });
        }
        break;
    }
  }

  // 停止节流定时器，刷新最终内容
  stopFlushTimer();

  // 更新消息为完成状态
  setMessages(prev =>
    prev.map(m =>
      m.id === assistantId
        ? { ...m, content: assistantContent, isStreaming: false }
        : m,
    ),
  );

  // 更新对话历史
  conversationRef.current.push({ role: 'user', content: text });
  conversationRef.current.push({ role: 'assistant', content: assistantContent });
  setRouterStatus(modelRouter.getStatus());

} catch (error) {
  stopFlushTimer();
  const errMsg: ChatMessage = {
    id: nextId(),
    role: 'system',
    content: `错误: ${error instanceof Error ? error.message : String(error)}`,
  };
  setMessages(prev => [...prev, errMsg]);
}
```

**注意**：以上代码是逻辑指引，执行人需要根据 Phase 4 实际创建的 App.tsx 结构进行适配。核心是：
- 替换直接 LLM 调用为 `loop.run()`
- 消费 `AgentEvent` 事件流
- 保留 Phase 4 已有的节流机制
- 保留错误处理和 finally 中的 `setIsProcessing(false)`

- [ ] **Step 2：构建验证 → 运行测试 → 提交**

```powershell
pnpm build
pnpm typecheck
pnpm test
```

```powershell
git add src/cli/App.tsx
git commit -m "feat(cli): integrate ReAct agent loop into chat interface with streaming"
```

---

### Task 7：集成验证 + 最终清理

- [ ] **Step 1：确认项目结构**

确认以下文件存在：

```
src/
├── agent/
│   ├── types.ts            # Phase 2 已有
│   ├── loop-config.ts      # Phase 5 新增
│   ├── executor.ts         # Phase 5 新增
│   ├── prompts.ts          # Phase 5 新增
│   └── loop.ts             # Phase 5 新增
```

- [ ] **Step 2：完整构建和测试**

```powershell
pnpm build
pnpm typecheck
pnpm test
```

预期：所有测试通过

- [ ] **Step 3：运行验证**

```powershell
pnpm start
```

验证：
1. CLI 启动，显示欢迎消息
2. 输入文本，能看到流式输出（需要配置有效的 API Key）
3. `/status` 命令正常显示路由状态
4. Ctrl+C 正常退出

- [ ] **Step 4：最终提交**

```powershell
git add -A
git commit -m "feat: Phase 5 complete - ReAct agent loop with streaming and CLI integration"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 79 个用例）
4. `ReActAgentLoop` 实现了 AsyncGenerator 流式输出
5. 纯文本对话：LLM 返回文本 → 1 次迭代结束，事件流正确 yield
6. 工具调用路径：LLM 返回 tool_call → 执行工具 → 结果注入上下文 → 第 2 次调用 → 结束
7. 防御性设计：maxIterations 限制、AbortSignal 取消、连续错误上限
8. CLI 集成：App.tsx 使用 ReAct Loop 替代直接 LLM 调用，流式输出正常
9. Token 追踪：每次 LLM 调用的 usage 正确记录到 tracker
10. 所有代码无 `any`（mock 测试工具除外）

## 注意事项

- **AsyncGenerator return value**：`callLLMStream` 的 return value（`{ content, toolCalls, usage }`）不会出现在 `for await` 循环中，需要通过 `iter.next()` 获取。本 Phase 的实现使用了嵌套的 `yield*` 语法，外层 `run()` 方法能直接拿到 `callLLMStream` 的 return value
- **工具调用缓冲**：`tool_call_delta` 事件可能分多次到达（尤其是长 JSON 参数），需要在 buffer 中累积。`tool_call_end` 时检查是否完整
- **流式节流**：Phase 4 的 80ms 节流机制在本 Phase 继续使用。如果执行人发现 Phase 4 没有实现节流，本 Phase 一并补上
- **对话历史格式**：传给 `loop.run()` 的 `conversationHistory` 不包含当前用户消息（loop 内部会添加）和 system prompt（通过 `systemPrompt` 参数单独传入）
- **NoOpToolExecutor 的行为**：当 LLM 返回工具调用但 `toolsEnabled: false` 时，NoOpToolExecutor 仍然会被调用（返回"不可用"提示）。这是因为 LLM 可能"幻觉"工具调用（即使没有传 tools 参数），Loop 需要优雅处理
- **Ink 7 + React 19 兼容**：如果 `useRef` 或 `useCallback` 的行为与 React 18 有差异，用 CONCERN 上报
- **Phase 4 踩坑清单**：
  - OpenAI SDK 6.x 的 apiKey 不能为空，用 'placeholder' 占位
  - ModelConfig 使用 `provider` 字段（非 `providerId`），以实际 types.ts 为准
  - Ink 7 的 `useInput` 中文 IME 兼容性问题已知，暂不修复
  - TokenTracker 有磁盘持久化功能，测试时注意清理

---

*Phase 5 | 蓝图 V1.0 | 预估新增文件：~6 个 | 预估修改文件：~1 个（App.tsx）*
