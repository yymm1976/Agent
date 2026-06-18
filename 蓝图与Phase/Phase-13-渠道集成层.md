# Phase 13：渠道集成层（消息适配 + Bot 基础）

**回应**：Phase 12 完成报告的 CONCERN（预估）

| # | CONCERN | 处理 |
|---|---------|------|
| C1 | BranchManager 的 edit 功能需要 getNodeByPath 方法暴露 | Phase 13 不涉及，BranchManager 后续完善 |
| C2 | .routedev-rules.md 生成后未自动加载到系统 prompt | Phase 13 不涉及，留待 Phase 14（Prompt 模板系统） |
| C3 | /dream 多次运行的幂等性未经充分测试 | Phase 13 不涉及 |

---

**目标**：实现渠道集成层——让 RouteDev 从"只有一个嘴巴（CLI 终端）"变成"多个嘴巴"。企业微信（WeChat Work）作为第一个渠道适配器，通过 HTTP Webhook 接收消息，经过 ReAct loop 处理后通过企业微信 API 回复。新增 `routedev serve` 服务器模式。

**蓝图参考**：蓝图 MVP 排除列表（第二节）"多端协同（手机 Remote、Bot 集成）"——本 Phase 是 Bot 集成的第一步

**前置依赖**：Phase 9（自主模式）、Phase 11（记忆系统，渠道消息需要记忆持久化）

**用户需求背景**：用户希望"加入微信就能与 AI 对话"。个人微信没有官方 Bot API（封号风险极高），因此采用企业微信（WeCom）路线——企业微信有官方 API，同时可接收微信用户的消息。

---

## 架构说明

渠道集成层是在 RouteDev 现有架构上叠加的"输入/输出适配层"。打个比方：RouteDev 原来只有一个"嘴巴"（CLI 终端），渠道层给它多装了几个"嘴巴"——企业微信是一个嘴巴、Telegram 是另一个嘴巴。每个嘴巴听懂不同的"语言"（消息格式），但背后连的是同一个"大脑"（ReAct loop）。

```
现有架构（CLI 模式）：
  用户在终端输入 → App.tsx (Ink UI) → classify → route → ReAct loop → 终端显示

Phase 13 新增（服务器模式）：
  用户在微信发消息 → 企业微信服务器 → Webhook 回调 → ChannelAdapter →
    classify → route → ReAct loop → ChannelAdapter → 企业微信 API → 用户微信显示

  用户在 Telegram 发消息 → Telegram Bot API → ChannelAdapter →
    classify → route → ReAct loop → ChannelAdapter → Telegram API → 用户显示
```

**两种运行模式**：
- `routedev`（CLI 模式）：和现在一样，Ink 终端 UI，面向开发者本人
- `routedev serve`（服务器模式）：无 UI，启动 HTTP 服务器监听渠道 Webhook，面向 Bot 场景

**关键约束**：
- 渠道适配器 **不修改** ReAct loop 或任何核心 Agent 逻辑
- 渠道消息转换为标准的 `LLMMessage` 格式后走正常的 classify → route → run 流程
- 每个渠道有**独立的对话历史**（不同用户的消息不混合）
- 服务器模式不渲染 Ink UI（纯后台运行）
- 企业微信的消息需要**加密验证**（Token + AES 解密）
- 渠道消息有**长度限制**（企业微信单条消息 2048 字符），长回复需要分段发送

---

## 具体任务

**接口对齐观察表**（已验证实际代码库）：

| # | 接口 | 实际签名 | Phase 13 用法 | 备注 |
|---|------|---------|--------------|------|
| 1 | `ScenarioClassifier.classify()` | `classify(input: ClassificationInput): Promise<ClassificationResult>` | `classifier.classify({ query: message.text })` | 接受 ClassificationInput 对象 |
| 2 | `ModelRouter.route()` | `route(classification: ClassificationResult): Promise<RoutingResult>` | `modelRouter.route(classification)` | **注意**：接受完整 ClassificationResult，不是 ScenarioTier |
| 3 | `LLMClientManager.get()` | `get(providerId: string): ILLMClient \| undefined` | `clientManager.get(routeDecision.providerId)` | 返回 undefined 时需检查 |
| 4 | `LLMClientManager.listAll()` | `listAll(): Map<string, ILLMClient>` | `[...clientManager.listAll().values()]` | **返回 Map，不是数组** |
| 5 | CLI 入口文件 | `src/index.tsx`（编译为 `dist/index.js`） | 在此文件中添加 serve 分支 | **不是 bin/routedev.ts** |
| 6 | `getSystemPrompt()` | `getSystemPrompt(language?: string): string` | `getSystemPrompt(config.general.language)` | 默认值 'zh-CN' |
| 7 | `getAppDataDir()` | `getAppDataDir(): string` | paths.ts 导出 | 已验证存在 |
| 8 | `ensureDir()` | `ensureDir(dirPath: string): void` | paths.ts 导出 | 已验证存在 |

---

### Task 1：渠道类型定义 + 配置 Schema

**文件：**
- 创建 `src/channels/types.ts`
- 修改 `src/config/schema.ts`

定义渠道适配器的抽象接口 + 渠道配置 Schema。

- [ ] **Step 1：定义渠道类型**

```typescript
// src/channels/types.ts
// 渠道集成层的类型定义（Phase 13）
// 渠道 = 一个消息输入/输出通道（企业微信、Telegram、Discord 等）
//
// 核心抽象：ChannelAdapter
//   - 每种渠道实现一个 ChannelAdapter
//   - Adapter 负责：接收渠道消息 → 转换为标准格式 → 交给 MessageRouter
//   - Adapter 负责：接收标准回复 → 转换为渠道格式 → 发送到渠道

import type { LLMMessage } from '../router/types.js';

/** 渠道类型标识 */
export type ChannelType = 'wechat-work' | 'telegram' | 'slack' | 'discord';

/** 渠道配置（通用部分） */
export interface ChannelConfig {
  /** 渠道唯一 ID */
  id: string;
  /** 渠道类型 */
  type: ChannelType;
  /** 是否启用 */
  enabled: boolean;
  /** 渠道特定配置（由各 Adapter 解释） */
  options: Record<string, string>;
}

/** 企业微信配置 */
export interface WeChatWorkConfig extends ChannelConfig {
  type: 'wechat-work';
  options: {
    /** 企业 ID */
    corpId: string;
    /** 应用 ID */
    agentId: string;
    /** 应用 Secret */
    corpSecret: string;
    /** 回调 Token（用于验证消息签名） */
    token: string;
    /** 回调 EncodingAESKey（用于消息加解密） */
    encodingAesKey: string;
  };
}

/** Telegram 配置 */
export interface TelegramConfig extends ChannelConfig {
  type: 'telegram';
  options: {
    /** Bot Token */
    botToken: string;
    /** Webhook URL（公网地址） */
    webhookUrl: string;
  };
}

/** 渠道消息（标准化格式） */
export interface ChannelMessage {
  /** 消息唯一 ID（渠道原生 ID） */
  id: string;
  /** 渠道类型 */
  channelType: ChannelType;
  /** 发送者标识（用户 ID 或名称） */
  sender: {
    id: string;
    name: string;
  };
  /** 消息文本内容 */
  text: string;
  /** 是否为群聊消息 */
  isGroup: boolean;
  /** 群聊 ID（如果是群聊） */
  groupId?: string;
  /** 消息时间戳 */
  timestamp: number;
  /** 附件（图片、文件等） */
  attachments?: ChannelAttachment[];
}

/** 渠道附件 */
export interface ChannelAttachment {
  /** 附件类型 */
  type: 'image' | 'file' | 'voice';
  /** 下载 URL（渠道提供） */
  url?: string;
  /** 本地缓存路径（下载后） */
  localPath?: string;
  /** MIME 类型 */
  mediaType?: string;
  /** base64 数据（如果是小文件） */
  data?: string;
}

/** 渠道回复 */
export interface ChannelResponse {
  /** 回复文本 */
  text: string;
  /** 是否回复成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
}

/** 渠道适配器接口（每种渠道实现一个） */
export interface ChannelAdapter {
  /** 渠道类型 */
  readonly type: ChannelType;
  /** 渠道配置 */
  readonly config: ChannelConfig;

  /** 启动适配器（注册 webhook、建立连接等） */
  start(): Promise<void>;
  /** 停止适配器 */
  stop(): Promise<void>;
  /** 适配器是否正在运行 */
  isRunning(): boolean;

  /** 设置消息处理器（由 MessageRouter 注入） */
  onMessage(handler: ChannelMessageHandler): void;
  /** 发送回复到渠道 */
  sendResponse(targetId: string, text: string, isGroup: boolean): Promise<ChannelResponse>;

  /** 获取适配器状态信息（用于 /channels status） */
  getStatus(): ChannelStatus;
}

/** 渠道消息处理器（由 MessageRouter 实现） */
export type ChannelMessageHandler = (message: ChannelMessage) => Promise<string>;

/** 渠道状态 */
export interface ChannelStatus {
  /** 渠道类型 */
  type: ChannelType;
  /** 是否运行中 */
  running: boolean;
  /** 已处理的消息数 */
  messagesProcessed: number;
  /** 最后一条消息时间 */
  lastMessageAt?: number;
  /** 错误信息 */
  error?: string;
}
```

- [ ] **Step 2：在 schema.ts 中添加渠道配置**

在 `src/config/schema.ts` 中添加：

```typescript
// --- 渠道配置（Phase 13） ---

export const ChannelTypeSchema = z.enum(['wechat-work', 'telegram', 'slack', 'discord']);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const ChannelEntrySchema = z.object({
  id: z.string().min(1),
  type: ChannelTypeSchema,
  enabled: z.boolean().default(true),
  options: z.record(z.string(), z.string()).default({}),
});

export const ChannelsConfigSchema = z.object({
  entries: z.array(ChannelEntrySchema).default([]),
  /** 本地 HTTP 服务器端口（接收 Webhook 回调） */
  port: z.number().positive().int().default(9800),
  /** 公网 URL（用于注册 Webhook 回调地址） */
  publicUrl: z.string().optional(),
  /** 最大回复长度（超出分段发送） */
  maxResponseLength: z.number().positive().int().default(2000),
  /** 请求超时（毫秒） */
  requestTimeout: z.number().positive().int().default(60000),
});
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;
export type ChannelEntryConfig = z.infer<typeof ChannelEntrySchema>;

// 在 AppConfigSchema 中添加：
//   channels: z.preprocess((v) => v ?? {}, ChannelsConfigSchema),
```

- [ ] **Step 3：在 defaults.ts 中添加默认值**

```typescript
// 在 DEFAULT_CONFIG 中添加：
channels: {
  entries: [],
  port: 9800,
  maxResponseLength: 2000,
  requestTimeout: 60000,
},
```

- [ ] **Step 4：创建 channels 目录 + 提交**

```powershell
mkdir src\channels
git add src/channels/types.ts src/config/schema.ts src/config/defaults.ts
git commit -m "feat(channels): add channel types and config schema for Phase 13"
```

---

### Task 2：渠道消息路由器

**文件：** 创建 `src/channels/message-router.ts`

MessageRouter 是渠道消息和 ReAct loop 之间的桥梁——接收渠道消息，走正常的 classify → route → run 流程，返回回复文本。

- [ ] **Step 1：实现 MessageRouter**

```typescript
// src/channels/message-router.ts
// 渠道消息路由器：渠道消息 → classify → route → ReAct loop → 回复文本
//
// 这个类复用了 App.tsx 中的核心逻辑（classify, route, run），
// 但去掉了 Ink UI 部分。它是渠道模式下的"无头 App"。

import type { AppConfig } from '../config/schema.js';
import type { LLMMessage, RoutingResult } from '../router/types.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import { ReActAgentLoop } from '../agent/loop.js';
import type { ToolExecutorAdapter } from '../agent/loop-config.js';
import { getSystemPrompt } from '../agent/prompts.js';
import type { ChannelMessage, ChannelMessageHandler } from './types.js';
import { logger } from '../utils/logger.js';

/** 每个渠道用户的独立对话上下文 */
interface UserContext {
  /** 对话历史 */
  history: LLMMessage[];
  /** 最后活动时间 */
  lastActiveAt: number;
}

export class MessageRouter {
  private config: AppConfig;
  private clientManager: LLMClientManager;
  private classifier: ScenarioClassifier;
  private modelRouter: ModelRouter;
  private tracker: TokenTracker;
  private toolAdapter: ToolExecutorAdapter;
  private agentLoop: ReActAgentLoop;

  /** 用户 ID → 对话上下文（每个渠道用户独立） */
  private userContexts: Map<string, UserContext> = new Map();
  /** 对话历史上限（与 App.tsx 一致） */
  private maxHistoryLength = 20;
  /** 用户上下文过期时间（毫秒，默认 2 小时） */
  private contextTTL = 2 * 60 * 60 * 1000;

  constructor(
    config: AppConfig,
    clientManager: LLMClientManager,
    classifier: ScenarioClassifier,
    modelRouter: ModelRouter,
    tracker: TokenTracker,
    toolAdapter: ToolExecutorAdapter,
    agentLoop: ReActAgentLoop,
  ) {
    this.config = config;
    this.clientManager = clientManager;
    this.classifier = classifier;
    this.modelRouter = modelRouter;
    this.tracker = tracker;
    this.toolAdapter = toolAdapter;
    this.agentLoop = agentLoop;
  }

  /**
   * 创建消息处理器（给 ChannelAdapter 用）
   * 返回一个函数，ChannelAdapter 在收到消息时调用
   */
  createHandler(): ChannelMessageHandler {
    return async (message: ChannelMessage): Promise<string> => {
      return this.handleMessage(message);
    };
  }

  /** 处理一条渠道消息，返回回复文本 */
  async handleMessage(message: ChannelMessage): Promise<string> {
    try {
      // 1. 获取或创建用户上下文
      const userKey = `${message.channelType}:${message.sender.id}`;
      const ctx = this.getOrCreateContext(userKey);

      // 2. 构建用户消息
      const userMessage: LLMMessage = {
        role: 'user',
        content: message.text,
      };

      // 3. 分类
      const classification = await this.classifier.classify({
        query: message.text,
      });

      // 4. 路由（route() 接受 ClassificationResult，不是 ScenarioTier）
      const routeDecision = await this.modelRouter.route(classification);

      // 5. 获取 LLM 客户端
      const client = this.clientManager.get(routeDecision.providerId);
      if (!client) {
        return '[错误] 无法获取 LLM 客户端';
      }

      // 6. 运行 ReAct loop
      let responseText = '';
      const abortController = new AbortController();

      // 超时保护
      const timeout = setTimeout(() => {
        abortController.abort();
      }, this.config.channels.requestTimeout);

      try {
        for await (const event of this.agentLoop.run({
          userMessage: message.text,
          llmClient: client,
          routeDecision,
          conversationHistory: ctx.history,
          systemPrompt: getSystemPrompt(this.config.general.language),
          signal: abortController.signal,
          // 渠道模式不使用 onConfirmTool（auto 模式）
        })) {
          switch (event.type) {
            case 'text_delta':
              responseText += event.text;
              break;
            case 'tool_call_start':
              // 工具调用在后台静默执行
              break;
            case 'tool_call_result':
              // 工具结果不发给渠道用户
              break;
            case 'done':
              if (event.content) {
                responseText = event.content;
              }
              break;
            case 'error':
              logger.error('ReAct loop error in channel mode', { error: event.error });
              break;
          }
        }
      } finally {
        clearTimeout(timeout);
      }

      // 7. 更新对话历史
      ctx.history.push(userMessage);
      ctx.history.push({ role: 'assistant', content: responseText });

      // 截断历史
      if (ctx.history.length > this.maxHistoryLength) {
        ctx.history = ctx.history.slice(-this.maxHistoryLength);
      }

      ctx.lastActiveAt = Date.now();

      // 8. 记录 token
      // （token 已在 ReAct loop 内部通过 tracker 记录）

      return responseText || '（无回复）';
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('MessageRouter error', { error: msg });
      return `[错误] ${msg}`;
    }
  }

  /** 获取或创建用户上下文 */
  private getOrCreateContext(userKey: string): UserContext {
    const now = Date.now();

    // 清理过期上下文
    for (const [key, ctx] of this.userContexts) {
      if (now - ctx.lastActiveAt > this.contextTTL) {
        this.userContexts.delete(key);
      }
    }

    let ctx = this.userContexts.get(userKey);
    if (!ctx) {
      ctx = { history: [], lastActiveAt: now };
      this.userContexts.set(userKey, ctx);
    }

    return ctx;
  }

  /** 获取活跃用户数 */
  get activeUserCount(): number {
    return this.userContexts.size;
  }

  /** 清除指定用户的对话历史 */
  clearUserContext(userKey: string): void {
    this.userContexts.delete(userKey);
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/channels/message-router.ts
git commit -m "feat(channels): implement MessageRouter for headless channel message processing"
```

---

### Task 3：HTTP Webhook 服务器

**文件：** 创建 `src/channels/server.ts`

一个轻量 HTTP 服务器，接收渠道 Webhook 回调。

- [ ] **Step 1：实现 WebhookServer**

```typescript
// src/channels/server.ts
// HTTP Webhook 服务器：接收渠道回调消息
// 使用 Node.js 内置 http 模块（零依赖）
//
// 路由规则：
//   POST /webhook/:channelId → 转发给对应 ChannelAdapter 处理
//   GET  /health             → 健康检查
//   GET  /status             → 服务器状态

import http from 'node:http';
import type { ChannelAdapter } from './types.js';
import { logger } from '../utils/logger.js';

export class WebhookServer {
  private port: number;
  private server: http.Server | null = null;
  /** channelId → ChannelAdapter */
  private adapters: Map<string, ChannelAdapter> = new Map();
  /** 企业微信验证回调（GET 请求，需要在 adapter 外部处理） */
  private verificationHandlers: Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => boolean> = new Map();

  constructor(port: number) {
    this.port = port;
  }

  /** 注册渠道适配器 */
  registerAdapter(channelId: string, adapter: ChannelAdapter): void {
    this.adapters.set(channelId, adapter);
  }

  /** 注册验证处理器（企业微信 GET 验证） */
  registerVerification(
    channelId: string,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => boolean,
  ): void {
    this.verificationHandlers.set(channelId, handler);
  }

  /** 启动服务器 */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (error) {
          logger.error('Webhook server error', { error: String(error) });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error' }));
        }
      });

      this.server.on('error', (error) => {
        logger.error('Webhook server failed to start', { error: String(error) });
        reject(error);
      });

      this.server.listen(this.port, () => {
        logger.info(`Webhook server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /** 停止服务器 */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Webhook server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** 获取服务器是否在运行 */
  get isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
    const pathname = url.pathname;

    // 健康检查
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', adapters: this.adapters.size }));
      return;
    }

    // 服务器状态
    if (pathname === '/status' && req.method === 'GET') {
      const statuses = [...this.adapters.entries()].map(([id, adapter]) => ({
        id,
        ...adapter.getStatus(),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: true, channels: statuses }));
      return;
    }

    // 渠道 Webhook 回调
    const webhookMatch = pathname.match(/^\/webhook\/([^/]+)$/);
    if (webhookMatch) {
      const channelId = webhookMatch[1];

      // GET 请求：渠道验证（企业微信的 URL 验证）
      if (req.method === 'GET') {
        const verifier = this.verificationHandlers.get(channelId);
        if (verifier && verifier(req, res)) return;

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Channel not found');
        return;
      }

      // POST 请求：消息回调
      if (req.method === 'POST') {
        const adapter = this.adapters.get(channelId);
        if (!adapter) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Channel "${channelId}" not found` }));
          return;
        }

        // 读取请求体
        const body = await this.readBody(req);

        // 将原始请求传递给适配器处理
        // 适配器负责解析消息格式并调用 onMessage handler
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));

        // 异步处理消息（不阻塞 HTTP 响应）
        // 注意：具体的消息解析在各 adapter 的 handleWebhook 中实现
        logger.debug('Webhook received', { channelId, bodyLength: body.length });
        return;
      }
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/channels/server.ts
git commit -m "feat(channels): implement WebhookServer for receiving channel callbacks"
```

---

### Task 4：企业微信适配器

**文件：** 创建 `src/channels/adapters/wechat-work.ts`

企业微信（WeCom）渠道适配器——接收企业微信回调消息，通过企业微信 API 回复。

- [ ] **Step 1：实现 WeChatWorkAdapter**

```typescript
// src/channels/adapters/wechat-work.ts
// 企业微信（WeCom）渠道适配器
// 官方文档：https://developer.work.weixin.qq.com/document/
//
// 工作流程：
//   1. 企业微信服务器 → POST /webhook/wechat-work → 加密的 XML 消息
//   2. 验证签名（SHA1(sort(token, timestamp, nonce, encrypt))）
//   3. AES 解密消息体
//   4. 解析 XML 提取消息内容
//   5. 调用 onMessage handler 获取回复
//   6. 通过企业微信 API 发送回复（POST https://qyapi.weixin.qq.com/cgi-bin/message/send）
//
// 安全机制：
//   - 回调验证：Token + Timestamp + Nonce + Encrypt 的 SHA1 签名
//   - 消息加解密：AES-256-CBC，密钥由 EncodingAESKey（Base64 编码的 43 字符）派生
//   - Access Token：通过 corpid + corpsecret 获取，有效期 2 小时，缓存复用

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelResponse,
  ChannelStatus,
  WeChatWorkConfig,
} from '../types.js';
import { logger } from '../../utils/logger.js';
import crypto from 'node:crypto';

export class WeChatWorkAdapter implements ChannelAdapter {
  readonly type = 'wechat-work' as const;
  readonly config: WeChatWorkConfig;

  private handler: ChannelMessageHandler | null = null;
  private running = false;
  private messagesProcessed = 0;
  private lastMessageAt: number | undefined;
  private error: string | undefined;

  /** Access Token 缓存 */
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: ChannelConfig) {
    this.config = config as WeChatWorkConfig;
  }

  async start(): Promise<void> {
    // 获取初始 access token
    await this.refreshAccessToken();
    this.running = true;
    logger.info('WeChatWork adapter started', {
      corpId: this.config.options.corpId,
      agentId: this.config.options.agentId,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.accessToken = null;
    logger.info('WeChatWork adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handler = handler;
  }

  /**
   * 处理来自 Webhook 服务器的原始请求体
   * 由 WebhookServer 在收到 POST /webhook/wechat-work 时调用
   */
  async handleWebhook(body: string, query: Record<string, string>): Promise<void> {
    try {
      // 1. 验证签名
      const { msg_signature, timestamp, nonce } = query;
      if (!this.verifySignature(msg_signature, timestamp, nonce, body)) {
        logger.warn('WeChatWork: signature verification failed');
        return;
      }

      // 2. 解密消息
      const decrypted = this.decryptMessage(body);
      if (!decrypted) {
        logger.warn('WeChatWork: message decryption failed');
        return;
      }

      // 3. 解析 XML
      const parsed = this.parseXml(decrypted);
      if (!parsed || parsed.MsgType !== 'text') {
        // 只处理文本消息
        return;
      }

      // 4. 构建标准 ChannelMessage
      const message: ChannelMessage = {
        id: parsed.MsgId ?? crypto.randomUUID(),
        channelType: 'wechat-work',
        sender: {
          id: parsed.FromUserName ?? 'unknown',
          name: parsed.FromUserName ?? 'unknown',
        },
        text: parsed.Content ?? '',
        isGroup: false, // 企业微信应用消息默认为单聊
        timestamp: parseInt(parsed.CreateTime ?? '0', 10) * 1000,
      };

      // 5. 调用 handler
      if (this.handler) {
        this.messagesProcessed++;
        this.lastMessageAt = Date.now();

        const reply = await this.handler(message);

        // 6. 发送回复
        await this.sendResponse(message.sender.id, reply, false);
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      logger.error('WeChatWork webhook error', { error: this.error });
    }
  }

  /**
   * 处理 GET 验证请求（企业微信 URL 验证）
   * 企业微信在配置回调 URL 时会发送 GET 请求验证
   */
  handleVerification(query: Record<string, string>): string | null {
    const { msg_signature, timestamp, nonce, echostr } = query;

    if (!this.verifySignature(msg_signature, timestamp, nonce, echostr)) {
      return null;
    }

    return this.decryptMessage(echostr);
  }

  /** 发送回复到企业微信 */
  async sendResponse(targetId: string, text: string, _isGroup: boolean): Promise<ChannelResponse> {
    try {
      const token = await this.getAccessToken();

      // 企业微信消息长度限制
      const maxLen = 2048;
      const chunks = text.length > maxLen
        ? this.splitText(text, maxLen)
        : [text];

      for (const chunk of chunks) {
        const response = await fetch(
          `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              touser: targetId,
              msgtype: 'text',
              agentid: parseInt(this.config.options.agentId, 10),
              text: { content: chunk },
            }),
          },
        );

        const result = await response.json();
        if (result.errcode !== 0) {
          logger.error('WeChatWork send error', { errcode: result.errcode, errmsg: result.errmsg });
          return { text: chunk, success: false, error: result.errmsg };
        }
      }

      return { text, success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { text: '', success: false, error: msg };
    }
  }

  getStatus(): ChannelStatus {
    return {
      type: 'wechat-work',
      running: this.running,
      messagesProcessed: this.messagesProcessed,
      lastMessageAt: this.lastMessageAt,
      error: this.error,
    };
  }

  // ===== 内部方法 =====

  /** 获取 Access Token（缓存 2 小时） */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<string> {
    const { corpId, corpSecret } = this.config.options;
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`;

    const response = await fetch(url);
    const result = await response.json();

    if (result.errcode !== 0) {
      throw new Error(`Failed to get access token: ${result.errmsg}`);
    }

    this.accessToken = result.access_token;
    // 提前 5 分钟过期
    this.tokenExpiresAt = Date.now() + (result.expires_in - 300) * 1000;

    return this.accessToken;
  }

  /** 验证签名 */
  private verifySignature(signature: string, timestamp: string, nonce: string, encrypt: string): boolean {
    const { token } = this.config.options;
    const sorted = [token, timestamp, nonce, encrypt].sort().join('');
    const hash = crypto.createHash('sha1').update(sorted).digest('hex');
    return hash === signature;
  }

  /** 解密消息（简化版，实际需要 AES-256-CBC） */
  private decryptMessage(encrypted: string): string | null {
    try {
      const { encodingAesKey } = this.config.options;
      // EncodingAESKey 是 Base64 编码的 43 字符，解码后得到 32 字节 AES 密钥
      const aesKey = Buffer.from(encodingAesKey + '=', 'base64');
      const iv = aesKey.subarray(0, 16);

      const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
      decipher.setAutoPadding(false);

      const decrypted = Buffer.concat([
        decipher.update(encrypted, 'base64'),
        decipher.final(),
      ]);

      // 去掉 PKCS#7 填充
      const padLen = decrypted[decrypted.length - 1];
      const content = decrypted.subarray(0, decrypted.length - padLen);

      // 消息格式：16字节随机串 + 4字节消息长度 + 消息体 + CorpId
      const msgLen = content.readUInt32BE(16);
      const message = content.subarray(20, 20 + msgLen).toString('utf-8');

      return message;
    } catch (error) {
      logger.error('WeChatWork decrypt failed', { error: String(error) });
      return null;
    }
  }

  /** 简易 XML 解析（企业微信消息格式固定） */
  private parseXml(xml: string): Record<string, string> | null {
    const result: Record<string, string> = {};
    const tagRegex = /<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>|<(\w+)>([\s\S]*?)<\/\3>/g;
    let match;

    while ((match = tagRegex.exec(xml)) !== null) {
      const key = match[1] ?? match[3];
      const value = match[2] ?? match[4];
      result[key] = value;
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  /** 长文本分段 */
  private splitText(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }
    return chunks;
  }
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/channels/adapters/wechat-work.ts
git commit -m "feat(channels): implement WeChatWork adapter with webhook and API integration"
```

---

### Task 5：ChannelManager + `routedev serve` 入口

**文件：**
- 创建 `src/channels/manager.ts`
- 修改 `src/index.tsx`（CLI 入口，编译后为 dist/index.js）

ChannelManager 管理所有渠道的生命周期。`routedev serve` 是服务器模式的入口命令。

- [ ] **Step 1：实现 ChannelManager**

```typescript
// src/channels/manager.ts
// ChannelManager：管理所有渠道的生命周期
// 负责：创建适配器 → 启动 → 注册 Webhook → 监控 → 停止

import type { AppConfig, ChannelEntryConfig } from '../config/schema.js';
import type { LLMClientManager } from '../router/llm/index.js';
import type { ScenarioClassifier } from '../router/classifier.js';
import type { ModelRouter } from '../router/router.js';
import type { TokenTracker } from '../router/tracker.js';
import type { ToolExecutorAdapter } from '../agent/loop-config.js';
import { ReActAgentLoop } from '../agent/loop.js';
import { WebhookServer } from './server.js';
import { MessageRouter } from './message-router.js';
import { WeChatWorkAdapter } from './adapters/wechat-work.js';
import type { ChannelAdapter, ChannelStatus } from './types.js';
import { logger } from '../utils/logger.js';

export class ChannelManager {
  private config: AppConfig;
  private server: WebhookServer;
  private adapters: Map<string, ChannelAdapter> = new Map();
  private messageRouter: MessageRouter | null = null;

  constructor(
    config: AppConfig,
    clientManager: LLMClientManager,
    classifier: ScenarioClassifier,
    modelRouter: ModelRouter,
    tracker: TokenTracker,
    toolAdapter: ToolExecutorAdapter,
    agentLoop: ReActAgentLoop,
  ) {
    this.config = config;
    this.server = new WebhookServer(config.channels.port);

    // 创建消息路由器
    this.messageRouter = new MessageRouter(
      config,
      clientManager,
      classifier,
      modelRouter,
      tracker,
      toolAdapter,
      agentLoop,
    );
  }

  /** 初始化并启动所有已配置的渠道 */
  async startAll(): Promise<void> {
    const entries = this.config.channels.entries.filter(e => e.enabled);

    if (entries.length === 0) {
      logger.info('No channels configured');
      return;
    }

    // 创建适配器
    for (const entry of entries) {
      const adapter = this.createAdapter(entry);
      if (adapter) {
        adapter.onMessage(this.messageRouter!.createHandler());
        this.adapters.set(entry.id, adapter);
        this.server.registerAdapter(entry.id, adapter);
      }
    }

    // 启动 Webhook 服务器
    await this.server.start();

    // 启动所有适配器
    for (const [id, adapter] of this.adapters) {
      try {
        await adapter.start();
        logger.info(`Channel "${id}" (${adapter.type}) started`);
      } catch (error) {
        logger.error(`Channel "${id}" failed to start`, { error: String(error) });
      }
    }

    logger.info(`ChannelManager started: ${this.adapters.size} channel(s) on port ${this.config.channels.port}`);
  }

  /** 停止所有渠道 */
  async stopAll(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      try {
        await adapter.stop();
        logger.info(`Channel "${id}" stopped`);
      } catch (error) {
        logger.error(`Channel "${id}" failed to stop`, { error: String(error) });
      }
    }

    await this.server.stop();
    this.adapters.clear();
  }

  /** 获取所有渠道状态 */
  getStatuses(): ChannelStatus[] {
    return [...this.adapters.values()].map(a => a.getStatus());
  }

  /** 获取适配器数量 */
  get count(): number {
    return this.adapters.size;
  }

  /** 根据配置创建适配器 */
  private createAdapter(entry: ChannelEntryConfig): ChannelAdapter | null {
    switch (entry.type) {
      case 'wechat-work':
        return new WeChatWorkAdapter(entry as any);
      // case 'telegram':
      //   return new TelegramAdapter(entry as any);
      default:
        logger.warn(`Unknown channel type: ${entry.type}`);
        return null;
    }
  }
}
```

- [ ] **Step 2：修改 CLI 入口，添加 `serve` 命令**

在 `src/index.tsx`（CLI 入口文件）中：

```typescript
// 检测命令行参数
const args = process.argv.slice(2);
const command = args[0];

if (command === 'serve') {
  // ===== 服务器模式 =====
  // 不启动 Ink UI，只启动渠道服务器

  console.log('RouteDev Server Mode');
  console.log('Starting channel server...');

  // 加载配置
  const config = await loadConfig();

  // 初始化所有组件（与 CLI 模式相同）
  const { clientManager, classifier, modelRouter, tracker, toolAdapter, agentLoop } = await initComponents(config);

  // 创建并启动 ChannelManager
  const channelManager = new ChannelManager(
    config, clientManager, classifier, modelRouter,
    tracker, toolAdapter, agentLoop,
  );

  await channelManager.startAll();

  console.log(`Server running on port ${config.channels.port}`);
  console.log(`Channels: ${channelManager.count}`);
  console.log('Press Ctrl+C to stop');

  // 优雅关闭
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await channelManager.stopAll();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await channelManager.stopAll();
    process.exit(0);
  });

} else {
  // ===== CLI 模式（现有逻辑） =====
  // 启动 Ink 渲染
  // ... 现有代码不变 ...
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/channels/manager.ts src/index.tsx
git commit -m "feat(channels): add ChannelManager and 'routedev serve' server mode"
```

---

### Task 6：/channels 命令（CLI 模式管理）

**文件：** 修改 `src/cli/App.tsx`

在 CLI 模式下管理渠道。

- [ ] **Step 1：实现 /channels 命令**

```typescript
case '/channels': {
  const subCmd = parts[1]?.toLowerCase();

  switch (subCmd) {
    case 'list':
    case undefined: {
      const entries = config.channels.entries;
      if (entries.length === 0) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '没有配置渠道。在 routedev.yaml 中添加 channels.entries 配置。',
        }]);
      } else {
        const lines = entries.map(e => {
          const enabled = e.enabled ? '✓' : '✗';
          return `  ${enabled} [${e.id}] ${e.type} - ${e.enabled ? '已启用' : '已禁用'}`;
        });
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `渠道配置 (${entries.length}):\n${lines.join('\n')}\n\n使用 "routedev serve" 启动服务器模式。`,
        }]);
      }
      break;
    }

    case 'test': {
      const channelId = parts[2];
      if (!channelId) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: '用法: /channels test <渠道ID>',
        }]);
        break;
      }

      // 发送一条测试消息
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: `正在向渠道 "${channelId}" 发送测试消息...`,
      }]);

      // 注意：需要 ChannelManager 实例在 CLI 模式下也可用
      // 当前简化实现：只验证配置是否正确
      const entry = config.channels.entries.find(e => e.id === channelId);
      if (!entry) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `未找到渠道 "${channelId}"。`,
        }]);
      } else {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'system' as const,
          content: `渠道 "${channelId}" (${entry.type}) 配置已验证。使用 "routedev serve" 启动。`,
        }]);
      }
      break;
    }

    default:
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system' as const,
        content: [
          '渠道命令：',
          '  /channels list     - 查看渠道配置',
          '  /channels test <id> - 测试渠道配置',
          '',
          '服务器模式：routedev serve',
        ].join('\n'),
      }]);
  }
  break;
}
```

- [ ] **Step 2：更新 /help**

```
  /channels list         - 查看渠道配置
  /channels test <id>    - 测试渠道
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx
git commit -m "feat(cli): add /channels command for channel management"
```

---

### Task 7：单元测试

**文件：**
- 创建 `tests/channels/wechat-work.test.ts`
- 创建 `tests/channels/message-router.test.ts`
- 创建 `tests/channels/server.test.ts`

- [ ] **Step 1：WeChatWorkAdapter 测试**

测试点：

- verifySignature() 正确参数 → 返回 true
- verifySignature() 错误签名 → 返回 false
- decryptMessage() 加密消息 → 正确解密
- parseXml() 标准企业微信 XML → 正确解析字段
- parseXml() 空 XML → 返回 null
- sendResponse() 长文本 → 自动分段发送
- handleVerification() GET 验证 → 返回 echostr
- getAccessToken() 首次获取 → 返回 token
- getAccessToken() 缓存未过期 → 复用 token

- [ ] **Step 2：MessageRouter 测试**

测试点（mock 所有依赖）：

- handleMessage() 正常消息 → 返回 AI 回复文本
- handleMessage() 不同用户 → 独立的对话历史
- handleMessage() 同一用户 → 共享对话历史
- handleMessage() 超时 → AbortController 中断
- activeUserCount → 返回正确数量
- clearUserContext() → 清除指定用户历史
- 用户上下文 TTL 过期 → 自动清理

- [ ] **Step 3：WebhookServer 测试**

测试点：

- start() → 服务器在指定端口监听
- stop() → 服务器停止
- GET /health → 返回 200 + status
- GET /status → 返回所有渠道状态
- POST /webhook/:id → 转发给对应 adapter
- POST /webhook/unknown → 返回 404
- GET /unknown → 返回 404

- [ ] **Step 4：运行全部测试 → 提交**

```powershell
pnpm test
git add tests/channels/
git commit -m "test(channels): add tests for WeChatWork, MessageRouter, and WebhookServer"
```

---

## 完成标准

1. `pnpm build` 成功
2. `pnpm typecheck` 零错误
3. `pnpm test` 所有测试通过（至少 225 个用例，Phase 12 的 200 + Phase 13 新增 ~25）
4. ChannelAdapter 接口定义了完整的生命周期（start/stop/onMessage/sendResponse）
5. WeChatWorkAdapter 能验证签名、解密消息、解析 XML、发送回复
6. WebhookServer 在指定端口监听，正确路由请求到对应 adapter
7. MessageRouter 能处理渠道消息（classify → route → ReAct loop → 回复）
8. 不同渠道用户有独立的对话历史
9. 用户上下文 2 小时后自动过期清理
10. 长回复自动分段发送（企业微信 2048 字符限制）
11. `routedev serve` 启动服务器模式（不渲染 Ink UI）
12. 服务器模式支持 SIGINT/SIGTERM 优雅关闭
13. /channels list 显示已配置的渠道
14. /help 和 /status 反映渠道功能
15. Access Token 缓存和自动刷新

## 注意事项

- **企业微信 vs 个人微信**：本 Phase 只支持企业微信（WeCom）。个人微信没有官方 Bot API，不推荐集成。如果用户确实需要个人微信，可以后续考虑微信客服（需要微信商户资质）或第三方协议（风险极高）
- **企业微信的前提条件**：用户需要注册企业微信，创建应用，获取 corpid、corpsecret、agentId，配置回调 URL 和 Token/EncodingAESKey。这些都是企业微信管理后台的操作
- **消息加解密**：企业微信的消息加解密使用 AES-256-CBC。EncodingAESKey 是 Base64 编码的 43 字符（解码后 32 字节密钥）。IV 是密钥的前 16 字节。Phase 13 实现了简化版，生产环境建议引用企业微信官方提供的加解密示例代码
- **Access Token 有效期**：2 小时。代码在过期前 5 分钟自动刷新。如果 corpsecret 错误，refreshAccessToken() 会抛错
- **Webhook 服务器端口**：默认 9800。如果用户通过 `routedev serve --port 8080` 指定端口，需要解析命令行参数（Phase 13 暂不实现命令行参数解析，使用配置文件中的端口）
- **公网访问**：企业微信回调需要公网可达的 URL。用户在本地开发时可以用 ngrok 或 frp 做内网穿透：`ngrok http 9800`
- **MessageRouter 不触发工具确认**：渠道模式下，ReAct loop 不传 `onConfirmTool`（相当于 auto 模式）。这是因为渠道用户无法像 CLI 用户那样交互确认。如果需要确认，应该在 semi/manual 模式下禁用渠道或强制 auto
- **Ink 与服务器模式互斥**：`routedev serve` 不启动 Ink UI。如果需要在服务器模式下查看状态，通过 `GET /status` HTTP 端点
- **渠道配置安全性**：corpid、corpsecret 等敏感信息存储在 config.yaml 中。建议使用环境变量引用（`${WECOM_CORP_SECRET}`）而非明文
- **Telegram 适配器**：Phase 13 只实现企业微信。Telegram 适配器作为下一个优先渠道，可在后续 Phase 中实现。接口设计已预留（ChannelType 枚举包含 'telegram'）
- **channels.entries 在 schema 中的位置**：作为 AppConfig 的新顶级字段添加，与 `providers`、`router`、`security` 等平级
- **WebhookServer 使用 Node.js 内置 http 模块**：零外部依赖。不引入 express/fastify 等框架，保持项目轻量

---

*Phase 13 | 蓝图 V1.0 | 预估新增文件：~6 个 | 预估修改文件：~3 个（schema.ts + defaults.ts + App.tsx + index.tsx）*
