# Phase 86 — OpenAI Responses API 兼容

> **Phase 类型：** Core 能力扩展（Core Feature Extension）
> **前置依赖：** Phase-85（发布门禁完成）
> **目标版本：** v4.9.1
> **核心目标：** 新增 `openai-responses` 协议，兼容 OpenAI Responses API（`/v1/responses`），与现有 Chat Completions API 并行可用

---

## 背景

OpenAI 于 2025 年推出 Responses API（`/v1/responses`），定位为 Chat Completions API 的下一代替代：

| 方面 | Chat Completions API | Responses API |
|------|---------------------|---------------|
| 端点 | `POST /v1/chat/completions` | `POST /v1/responses` |
| 输入格式 | `messages` 数组（role + content） | `input` 数组（typed items） |
| 工具调用 | `tool_calls`（`tool_call_id`） | `function_call` item（`call_id`） |
| 工具结果 | `role: 'tool'` 独立消息 | `function_call_output` item |
| 流式事件 | `choices[0].delta` | `response.output_text.delta` 等 20+ 种 |
| 内置工具 | 无 | `web_search` / `file_search` 等 |
| 状态管理 | 无 | `previous_response_id` 链式 |
| Usage 字段 | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |

**项目现状：**
- 已有 4 个 OpenAI 协议客户端（OpenAI / DeepSeek / Qwen / Ollama），全部使用 Chat Completions API
- openai npm SDK v6.42.0 已原生支持 `client.responses.create()`
- `Protocol` 枚举仅 3 个值（`openai` / `anthropic` / `gemini`）

**设计策略：新增独立客户端 `OpenAIResponsesClient`，通过 `protocol: 'openai-responses'` 区分，不影响现有 Chat Completions 客户端。**

---

## 可验证目标

| # | 目标 | 验证方式 |
|---|------|----------|
| 1 | `protocol: 'openai-responses'` 可配置 | Provider 设置页可选该协议 |
| 2 | 非流式调用通过 | 单元测试：complete() 返回正确 LLMResponse |
| 3 | 流式调用通过 | 单元测试：stream() 产出正确 LLMStreamEvent 序列 |
| 4 | 工具调用通过 | 单元测试：function_call 正确映射为 tool_use / tool_result |
| 5 | 不影响现有 OpenAI 客户端 | 回归测试：现有 OpenAIClient 测试全绿 |
| 6 | DeepSeek/Qwen 可选 Responses API | 配置 `protocol: 'openai-responses'` 即可用 |

---

## Task 1：配置层扩展

**文件：**
- 修改：`src/config/schema-router.ts`
- 修改：`src/router/types.ts`
- 修改：`src/router/llm/index.ts`

- [ ] **Step 1: 扩展 Protocol 枚举**

在 `schema-router.ts` 的 `ProtocolSchema` 中增加 `'openai-responses'`：
```ts
const ProtocolSchema = z.enum(['openai', 'anthropic', 'gemini', 'openai-responses']);
```

在 `types.ts` 的 `Protocol` 类型中同步增加：
```ts
export type Protocol = 'openai' | 'anthropic' | 'gemini' | 'openai-responses';
```

- [ ] **Step 2: 扩展客户端工厂**

在 `llm/index.ts` 的 `createLLMClient` 中增加 `'openai-responses'` 分支：
```ts
case 'openai-responses':
  return new OpenAIResponsesClient(config);
```

- [ ] **Step 3: 提交**

---

## Task 2：OpenAIResponsesClient 实现

**文件：**
- 创建：`src/router/llm/openai-responses.ts`
- 参考：`src/router/llm/openai.ts`（Chat Completions 实现）

- [ ] **Step 1: 类骨架**

```ts
export class OpenAIResponsesClient extends BaseLLMClient {
  readonly protocol = 'openai-responses' as const;
  private client: OpenAI;

  constructor(config: LLMClientConfig) {
    super(config);
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
  }
}
```

- [ ] **Step 2: 非流式 complete()**

使用 `this.client.responses.create()` 发送请求：
- `model` ← `options.model`
- `input` ← `convertMessages(options.messages)` + `convertSystemPrompt(options.systemPrompt)`
- `tools` ← `convertTools(options.tools)`（如有）
- `max_output_tokens` ← `options.maxTokens`
- `temperature` ← `options.temperature`

解析响应：
- 遍历 `response.output[]` 提取 message / function_call items
- `response.usage.input_tokens` / `output_tokens` → `TokenUsageInfo`
- `response.status` → finishReason

- [ ] **Step 3: 流式 stream()**

使用 `this.client.responses.create({ stream: true })` 获取 AsyncIterable。

事件映射：
| Responses API 事件 | LLMStreamEvent |
|-------------------|----------------|
| `response.output_text.delta` | `{ type: 'text_delta', text }` |
| `response.function_call_arguments.delta` | `{ type: 'tool_call_delta', argumentsDelta }` |
| `response.output_item.added` (function_call) | `{ type: 'tool_call_start', toolCall: { id, name } }` |
| `response.output_item.done` (function_call) | `{ type: 'tool_call_end', toolCallId }` |
| `response.completed` | `{ type: 'done', finishReason }` |
| `response.usage` | `{ type: 'usage', usage }` |
| 推理增量（如有） | `{ type: 'reasoning_delta', text }` |

- [ ] **Step 4: 消息格式转换**

`convertMessages(messages: LLMMessage[]): ResponseInputItem[]`

| LLMMessage | Responses API input item |
|------------|------------------------|
| `{ role: 'user', content: 'text' }` | `{ type: 'message', role: 'user', content: 'text' }` |
| `{ role: 'assistant', content: 'text' }` | `{ type: 'message', role: 'assistant', content: 'text' }` |
| `{ role: 'assistant', content: [tool_use] }` | `{ type: 'function_call', call_id, name, arguments }` |
| `{ role: 'user', content: [tool_result] }` | `{ type: 'function_call_output', call_id, output }` |
| `{ role: 'system', content }` | `instructions` 参数（不从 input 传） |

- [ ] **Step 5: 工具格式转换**

`convertTools(tools: LLMToolDefinition[]): ResponseTool[]`

```ts
// Chat Completions: { type: 'function', function: { name, description, parameters } }
// Responses API:   { type: 'function', name, description, parameters }
// 差异：name 提到外层，无 function 嵌套
```

- [ ] **Step 6: 提交**

---

## Task 3：测试

**文件：**
- 创建：`tests/router/openai-responses.test.ts`

- [ ] **Step 1: 消息转换测试**
  - 纯文本消息 → message items
  - tool_use → function_call item
  - tool_result → function_call_output item
  - system prompt → instructions 字段

- [ ] **Step 2: 工具转换测试**
  - LLMToolDefinition → ResponseTool 格式

- [ ] **Step 3: 非流式响应解析测试**
  - 纯文本响应 → LLMResponse
  - 工具调用响应 → LLMResponse with tool_calls
  - usage 字段映射

- [ ] **Step 4: 流式事件映射测试**
  - text delta → text_delta
  - function_call delta → tool_call_delta
  - completed → done

- [ ] **Step 5: 回归测试**
  - 现有 OpenAIClient 测试仍全绿
  - 现有 LLMClientManager 测试仍全绿

- [ ] **Step 6: 提交**

---

## Task 4：UI 与文档

**文件：**
- 修改：`desktop/renderer/src/components/settings/SettingsProvidersTab.tsx`
- 修改：`docs/CAPABILITY_LAYERS.md`
- 修改：`CHANGELOG.md`

- [ ] **Step 1: 设置页支持 openai-responses 协议**

在 Provider 设置页的协议下拉框中增加 `'openai-responses'` 选项。

- [ ] **Step 2: 文档更新**

- CAPABILITY_LAYERS.md：新增 OpenAIResponsesClient 条目
- CHANGELOG.md：新增 Phase 86 条目

- [ ] **Step 3: 提交**

---

## 验收

- [ ] `protocol: 'openai-responses'` 可在设置页配置
- [ ] 非流式 complete() 返回正确响应
- [ ] 流式 stream() 产出正确事件序列
- [ ] 工具调用 function_call 正确映射
- [ ] 现有 OpenAI / DeepSeek / Qwen / Ollama 客户端不受影响
- [ ] 测试全绿
- [ ] TypeScript 编译通过

---

## 风险

- Responses API 流式事件类型多（20+ 种），映射逻辑需仔细测试
- `call_id` 与 `tool_call_id` 命名差异易踩坑
- openai SDK 版本演进可能导致类型变化
- 初期不实现 `previous_response_id` 状态链和内置工具，保持最小可用
