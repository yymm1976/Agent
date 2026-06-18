# Phase 19：渠道完善 + UX 打磨 + 安全加固

**回应**：V1 蓝图审视报告

| # | 审视项 | 处理 |
|---|--------|------|
| 缺失 #1 | Telegram/Slack/Discord 适配器未实现 | **Task 1 核心**：实现 TelegramAdapter |
| 缺陷 #2 | wechat-work refreshAccessToken 凭证在 URL 中 | **Task 5**：改为 POST body |
| 缺陷 #3 | 错误信息仅 console.log 不持久化 | **Task 6**：统一 logger.error 持久化 |
| 缺陷 #6 | message-router 用 length/4 估算 token（中文不准） | **Task 3**：改进中文 token 估算 |
| 缺陷 #7 | webhook 无 rate limit + 无 body size limit | **Task 4**：添加安全中间件 |
| 缺陷 #8 | webhook 无通用认证 token | **Task 4**：添加 Bearer token 验证 |
| UX #8 | 启动无 splash 屏幕 | **Task 7**：添加启动画面 |
| UX #10 | 没有 /history 查看之前对话 | **Task 8**：新增 /history 和 /cost 命令 |

---

**目标**：补全渠道适配器（Telegram）、加固 Webhook 安全（rate limit + auth + body limit）、修复中文 token 估算、添加实用 UX 命令（/cost、/history）、修复 wechat-work 凭证安全问题。

**前置依赖**：Phase 18（CLI 基础设施——retry/circuit breaker 用于渠道 LLM 调用，config watcher 用于渠道配置热更新）

---

## 架构说明

Phase 13 搭好了渠道集成的骨架（ChannelAdapter 接口 + WeChatWorkAdapter），Phase 19 要把这个骨架填满肉——多一个真实可用的 Telegram 适配器，给 webhook 加上"安检门"（rate limit + auth + body size），修复几个安全隐患，再给用户补几个常用命令。

```
Phase 19 新增/修改：

渠道适配器
  ├── TelegramAdapter（新增）
  │     ├── Bot Token 认证
  │     ├── long polling 或 webhook 模式
  │     ├── 支持 Markdown 格式回复
  │     └── 长消息自动分段发送
  │
  └── WeChatWorkAdapter（修复）
        ├── 凭证从 URL 移到 POST body
        └── 主动推送 sendToUser 验证修复

Webhook 安全层（server.ts 改造）
  ├── RateLimiter（基于 IP 的请求频率限制）
  ├── BodySizeLimit（请求体大小限制）
  └── Bearer Token 认证（通用，不依赖渠道签名）

Token 估算改进（message-router.ts）
  └── 中文内容用 length/2 替代 length/4

UX 命令
  ├── /cost — 显示 token 消耗和估算费用
  └── /history — 查看最近 N 条对话记录
```

**关键约束**：
- TelegramAdapter 优先使用 webhook 模式（与现有 WebhookServer 架构一致），long polling 作为备选
- Webhook 安全层使用中间件模式——在路由分发前检查 rate limit / body size / auth
- /cost 的费用计算基于各模型的公开定价（硬编码价格表，后续可配置化）
- 中文 token 估算采用混合策略：检测内容是否含中文，是则 length/2，否则 length/4

---

## 具体任务

### Task 1：TelegramAdapter 实现

**文件：** 创建 `src/channels/adapters/telegram.ts`

- [ ] **Step 1：实现 TelegramAdapter**

```typescript
// src/channels/adapters/telegram.ts
// Telegram Bot 适配器：基于 Bot API webhook 模式
// 与现有 WebhookServer 架构一致（POST /webhook/telegram）

import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
} from '../types.js';
import { logger } from '../../utils/logger.js';

interface TelegramConfig {
  botToken: string;
  webhookUrl?: string; // 外部可访问的 webhook URL
  allowedChatIds?: number[]; // 白名单（可选）
}

export class TelegramAdapter implements ChannelAdapter {
  private config: TelegramConfig;
  private running = false;
  private messageHandler: ((msg: ChannelMessage) => void) | null = null;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    this.running = true;

    // 如果配置了 webhookUrl，注册 webhook
    if (this.config.webhookUrl) {
      await this.setWebhook(this.config.webhookUrl);
    }

    logger.info('TelegramAdapter started', {
      webhook: !!this.config.webhookUrl,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    // 可选：删除 webhook
    if (this.config.webhookUrl) {
      await this.deleteWebhook();
    }
    logger.info('TelegramAdapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandler = handler;
  }

  /** 解析 Telegram webhook payload */
  parseWebhook(body: string): ChannelMessage | null {
    try {
      const data = JSON.parse(body);

      // 标准 Telegram Update 格式
      const message = data.message ?? data.edited_message;
      if (!message) return null;

      const chat = message.chat;
      const from = message.from;
      if (!chat || !from) return null;

      // 白名单检查
      if (this.config.allowedChatIds?.length) {
        if (!this.config.allowedChatIds.includes(chat.id)) {
          logger.warn('TelegramAdapter: chat not in whitelist', {
            chatId: chat.id,
          });
          return null;
        }
      }

      return {
        id: `tg-${message.message_id}`,
        channelType: 'telegram',
        sender: from.username ?? String(from.id),
        receiver: chat.id.toString(),
        text: message.text ?? message.caption ?? '',
        isGroup: chat.type !== 'private',
        timestamp: message.date * 1000,
        attachments: this.extractAttachments(message),
      };
    } catch (error) {
      logger.error('TelegramAdapter: parse failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** 验证 Telegram webhook（可选——Telegram 使用 secret_token 验证） */
  verifySignature(body: string, signature: string, timestamp: string): boolean {
    // Telegram webhook 使用 x-telegram-bot-api-secret-token 头验证
    // 这个值在注册 webhook 时设定，服务端收到后比对即可
    // 此处 signature 参数即为 secret_token 的值
    return signature === this.config.botToken.slice(0, 16); // 简化验证
  }

  /** 发送回复（注意签名含 isGroup 参数，返回 ChannelResponse） */
  async sendResponse(targetId: string, text: string, isGroup: boolean): Promise<ChannelResponse> {
    try {
      // Telegram 消息长度限制 4096 字符
      const chunks = this.splitMessage(text, 4096);
      for (const chunk of chunks) {
        await this.apiCall('sendMessage', {
          chat_id: targetId,
          text: chunk,
          parse_mode: 'Markdown',
        });
      }
      return { success: true, messageId: '' };
    } catch (error) {
      logger.error('TelegramAdapter: send failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: String(error) };
    }
  }

  getStatus(): ChannelStatus {
    return {
      type: 'telegram',
      running: this.running,
      messagesProcessed: this.messageCount,
    };
  }

  // ===== 内部方法 =====

  private async setWebhook(url: string): Promise<void> {
    await this.apiCall('setWebhook', {
      url: `${url}/webhook/telegram`,
      secret_token: this.config.botToken.slice(0, 16),
      allowed_updates: ['message', 'edited_message'],
    });
  }

  private async deleteWebhook(): Promise<void> {
    await this.apiCall('deleteWebhook', { drop_pending_updates: false });
  }

  private async apiCall(method: string, params: Record<string, unknown>): Promise<any> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Telegram API ${method} failed: ${response.status} ${errorBody}`);
    }

    return response.json();
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // 在最近的换行处分割
      let splitIdx = remaining.lastIndexOf('\n', maxLen);
      if (splitIdx < maxLen * 0.5) {
        splitIdx = maxLen; // 没有合适的换行点，硬切
      }
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }
    return chunks;
  }

  private extractAttachments(message: any): string[] {
    const attachments: string[] = [];
    if (message.photo) {
      // 取最大尺寸的图片
      const photo = message.photo[message.photo.length - 1];
      attachments.push(`photo:${photo.file_id}`);
    }
    if (message.document) {
      attachments.push(`document:${message.document.file_id}`);
    }
    return attachments;
  }
}
```

- [ ] **Step 2：在 ChannelManager 中注册**

修改 `src/channels/manager.ts`，添加 Telegram 适配器创建逻辑：

```typescript
// 在 ChannelManager.initializeAdapters() 中添加：
case 'telegram': {
  const adapter = new TelegramAdapter({
    botToken: entry.options.botToken,
    webhookUrl: this.publicUrl,
    allowedChatIds: entry.options.allowedChatIds,
  });
  adapters.push(adapter);
  break;
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/channels/adapters/telegram.ts src/channels/manager.ts
git commit -m "feat(channels): add TelegramAdapter with webhook mode support"
```

---

### Task 2：ChannelAdapter 接口扩展

**文件：** 修改 `src/channels/types.ts`

当前 `ChannelType` 只包含 4 种类型，`sendResponse` 的参数签名需验证一致性。

- [ ] **Step 1：确认 ChannelType 和 ChannelStatus 包含 telegram**

检查 `src/channels/types.ts` 的 `ChannelTypeSchema`，确保包含 `'telegram'`。如果当前只有 `'wechat-work'`，需要添加。

```typescript
export const ChannelTypeSchema = z.enum([
  'wechat-work', 'telegram', 'slack', 'discord',
]);
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/channels/types.ts
git commit -m "feat(channels): add telegram to ChannelType enum"
```

---

### Task 3：中文 Token 估算修复

**文件：** 修改 `src/channels/message-router.ts`

- [ ] **Step 1：改进 token 估算函数**

当前（lines 70-73）用 `Math.ceil(text.length / 4)` 对所有语言一视同仁。中文的实际 token 比约 1-2 字符/token（是英文的 2-4 倍）。

```typescript
// message-router.ts 中新增估算函数
/**
 * 估算 token 数（支持中英文混合）
 * 策略：检测 CJK 字符比例，CJK 部分按 length/1.5，非 CJK 部分按 length/4
 */
function estimateTokens(text: string): number {
  // 匹配 CJK 字符（中日韩统一表意文字）
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
  const cjkMatches = text.match(cjkRegex);
  const cjkCount = cjkMatches?.length ?? 0;
  const nonCjkLength = text.length - cjkCount;

  // CJK 字符约 1.5 字符/token，非 CJK 约 4 字符/token
  const cjkTokens = Math.ceil(cjkCount / 1.5);
  const nonCjkTokens = Math.ceil(nonCjkLength / 4);

  return cjkTokens + nonCjkTokens;
}

// 替换原来的 Math.ceil(text.length / 4)
const estimatedTokens = ctx.history.reduce((acc, h) => {
  const text = typeof h.content === 'string' ? h.content : '';
  return acc + estimateTokens(text);
}, 0);
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/channels/message-router.ts
git commit -m "fix(channels): improve token estimation for Chinese content"
```

---

### Task 4：Webhook 安全加固

**文件：** 修改 `src/channels/server.ts`

当前 WebhookServer 无 rate limit、无 body size limit、无通用 auth token。

- [ ] **Step 1：添加 RateLimiter**

```typescript
// 在 server.ts 中添加简单的内存 RateLimiter
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private maxRequests: number;
  private windowMs: number;
  private cleanupInterval: NodeJS.Timeout;

  constructor(maxRequests = 60, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    // 每 5 分钟清理过期条目
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /** 检查是否允许请求 */
  check(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.entries.get(ip);

    if (!entry || now >= entry.resetAt) {
      this.entries.set(ip, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.maxRequests - 1, resetAt: now + this.windowMs };
    }

    entry.count++;
    if (entry.count > this.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }

    return { allowed: true, remaining: this.maxRequests - entry.count, resetAt: entry.resetAt };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(ip);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
```

- [ ] **Step 2：添加 Bearer Token 认证 + Body Size Limit**

在 `WebhookServer` 构造函数中添加安全配置：

```typescript
interface WebhookSecurityConfig {
  /** 通用 Bearer Token（所有 webhook 请求需携带） */
  authToken?: string;
  /** 请求体最大字节数（默认 1MB） */
  maxBodySize: number;
  /** 每分钟最大请求数 */
  rateLimit: number;
}

// 在 handleRequest 中添加安全检查：
// 1. Rate limit 检查
const clientIp = req.socket.remoteAddress ?? 'unknown';
const rateResult = this.rateLimiter.check(clientIp);
if (!rateResult.allowed) {
  res.writeHead(429, { 'Retry-After': String(Math.ceil((rateResult.resetAt - Date.now()) / 1000)) });
  res.end('Too Many Requests');
  return;
}

// 2. Auth token 检查（如果配置了）
if (this.securityConfig.authToken) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${this.securityConfig.authToken}`) {
    this.sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
}

// 3. Body size 检查
// 在 readBody 中：
private readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > this.securityConfig.maxBodySize) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
```

- [ ] **Step 3：日志修复（server.ts:120）**

在 400 响应前添加日志：

```typescript
if (!message) {
  logger.warn('WebhookServer: invalid message body', {
    channelType,
    bodyLength: body.length,
    clientIp,
  });
  this.sendJson(res, 400, { error: 'invalid message' });
  return;
}
```

- [ ] **Step 4：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/channels/server.ts
git commit -m "security(channels): add rate limiting, body size limit, and auth token to WebhookServer"
```

---

### Task 5：WeChatWork 凭证安全修复

**文件：** 修改 `src/channels/adapters/wechat-work.ts`

- [ ] **Step 1：refreshAccessToken 凭证改为 POST body**

当前（line 172）将 corpId 和 corpSecret 放在 URL 查询参数中，会出现在服务器日志和代理日志中。

修复：改为 POST body（虽然微信 API 用 GET，但可以在 header 中传或至少 log 时脱敏）：

```typescript
// 实际修复方案：微信 API 是 GET 请求无法改为 POST
// 但可以在日志中脱敏 + 添加警告
private async refreshAccessToken(): Promise<string | null> {
  // 注意：corpSecret 不应出现在日志中
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.config.options.corpId)}&corpsecret=${encodeURIComponent(this.config.options.corpSecret)}`;

  // 日志中不输出完整 URL（含 secret）
  logger.info('WeChatWork: refreshing access token');

  try {
    const response = await fetch(url);
    // ...
  } catch (error) {
    // 错误日志中不输出 URL（含 secret）
    logger.error('WeChatWork: refresh token failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
```

同时修复签名验证中的 timing attack（line 90）：

```typescript
import { timingSafeEqual } from 'node:crypto';

verifySignature(body: string, signature: string, timestamp: string): boolean {
  const token = this.config.options.token;
  if (!token) {
    logger.warn('WeChatWork: no token configured, skipping signature verification');
    return true;
  }

  const expected = createHash('sha1')
    .update(token + timestamp + body)
    .digest();

  // 使用 constant-time 比较防止 timing attack
  if (expected.length !== Buffer.byteLength(signature)) return false;
  return timingSafeEqual(expected, Buffer.from(signature));
}
```

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/channels/adapters/wechat-work.ts
git commit -m "security(channels): fix credential exposure and timing attack in WeChatWorkAdapter"
```

---

### Task 6：错误持久化统一

**文件：** 修改 `src/cli/App.tsx`（或 `src/cli/service-context.ts`）

当前多处错误只 `console.log`，不写入 logger。统一为 `logger.error()`。

- [ ] **Step 1：搜索并替换所有 console.log 错误输出**

搜索 App.tsx 和相关文件中的 `console.log` + `console.error`，替换为 `logger.error` 或 `logger.warn`：

```typescript
// 替换模式：
// console.log('Error:', err) → logger.error('描述', { error: String(err) })
// console.error('...', err) → logger.error('描述', { error: String(err) })
```

确保所有用户可见的错误消息同时写入日志文件（通过 winston daily-rotate-file 持久化）。

- [ ] **Step 2：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/App.tsx src/cli/service-context.ts
git commit -m "fix(cli): replace console.log with logger.error for persistent error tracking"
```

---

### Task 7：启动画面

**文件：** 创建 `src/cli/splash.ts`

- [ ] **Step 1：实现 splash 组件**

```typescript
// src/cli/splash.ts
// 启动画面：显示 logo + 版本 + 状态信息
import chalk from 'chalk';

export function printSplash(config: { version: string; providers: number; channels: number }): void {
  const logo = `
  ╔═══════════════════════════════════════╗
  ║         R O U T E D E V              ║
  ║     AI-Powered Dev Assistant          ║
  ╚═══════════════════════════════════════╝`;

  console.log(chalk.cyan(logo));
  console.log(chalk.gray(`  v${config.version}`));
  console.log('');
  console.log(chalk.white(`  Providers: ${config.providers}`));
  console.log(chalk.white(`  Channels:  ${config.channels}`));
  console.log(chalk.gray('  Type /help for commands'));
  console.log('');
}
```

- [ ] **Step 2：在 App.tsx 或 index.tsx 中调用**

```typescript
// index.tsx 交互模式启动前：
printSplash({
  version: '0.14.0',
  providers: config.providers.length,
  channels: config.channels.entries.length,
});
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/splash.ts src/index.tsx
git commit -m "feat(cli): add splash screen with logo and status on startup"
```

---

### Task 8：/cost + /history 命令

**文件：** 修改 `src/cli/commands/system.ts`（或创建新文件）

- [ ] **Step 1：/cost 命令**

```typescript
{
  name: '/cost',
  description: '查看 Token 消耗和估算费用',
  handler: (input) => {
    const { tracker } = input.services;
    const stats = tracker.getStats(); // 返回 TokenStats（total + byModel + byAgent + byStep）

    // 模型定价表（USD per 1M tokens，可后续配置化）
    const PRICING: Record<string, { input: number; output: number }> = {
      'deepseek-v4-flash': { input: 0.14, output: 0.28 },
      'deepseek-v4-pro': { input: 0.55, output: 2.19 },
      'minimax-m3': { input: 0.30, output: 1.20 },
      'qwen3.7-plus': { input: 0.40, output: 1.20 },
      'kimi-k2.7': { input: 0.60, output: 2.40 },
    };

    let totalCost = 0;
    const lines: string[] = [];
    // 按模型维度统计
    for (const [modelId, usage] of Object.entries(stats.byModel)) {
      const price = PRICING[modelId];
      if (price) {
        const cost = (usage.inputTokens / 1e6) * price.input
                   + (usage.outputTokens / 1e6) * price.output;
        totalCost += cost;
        lines.push(`  ${modelId}: ${usage.inputTokens + usage.outputTokens} tokens ≈ $${cost.toFixed(4)}`);
      }
    }

    const total = stats.total;
    const totalTokens = total.inputTokens + total.outputTokens;

    input.addSystemMessage(
      `今日消耗:\n${lines.join('\n') || '  (无记录)'}\n\n总计: ${totalTokens} tokens ≈ $${totalCost.toFixed(4)}`
    );
  },
}
```

- [ ] **Step 2：/history 命令**

```typescript
{
  name: '/history',
  description: '查看最近的对话记录',
  usage: '/history [数量]',
  handler: (input) => {
    const count = parseInt(input.parts[1] ?? '10', 10);
    const history = input.services.conversationHistory.current;

    if (history.length === 0) {
      input.addSystemMessage('暂无对话记录。');
      return;
    }

    const recent = history.slice(-count * 2); // user + assistant pairs
    const lines = recent.map((msg, i) => {
      const prefix = msg.role === 'user' ? '👤' : '🤖';
      const text = typeof msg.content === 'string'
        ? msg.content.slice(0, 100)
        : '(多模态内容)';
      return `  ${prefix} ${text}${text.length >= 100 ? '...' : ''}`;
    });

    input.addSystemMessage(
      `最近 ${Math.min(count, history.length / 2)} 轮对话:\n${lines.join('\n')}`
    );
  },
}
```

- [ ] **Step 3：构建验证 → 提交**

```powershell
pnpm build
pnpm typecheck
git add src/cli/commands/
git commit -m "feat(cli): add /cost and /history commands"
```

---

### Task 9：单元测试

- [ ] **Step 1：TelegramAdapter 测试（5 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | parseWebhook 正常消息 | 返回正确的 ChannelMessage |
| 2 | parseWebhook 无效 JSON | 返回 null + logger.error |
| 3 | 白名单过滤 | allowedChatIds 外的 chat 返回 null |
| 4 | sendResponse 长消息分段 | 超过 4096 字符的消息被正确分段 |
| 5 | getStatus | 返回正确的 ChannelStatus |

- [ ] **Step 2：RateLimiter 测试（3 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | 正常请求通过 | count < max 时 allowed: true |
| 2 | 超限被拒绝 | count > max 时 allowed: false |
| 3 | 窗口重置后恢复 | resetAt 过后计数归零 |

- [ ] **Step 3：Token 估算测试（3 用例）**

| # | 用例 | 验证点 |
|---|------|--------|
| 1 | 纯英文 | 约 length/4 |
| 2 | 纯中文 | 约 length/1.5（比原来多 2-3 倍） |
| 3 | 中英混合 | 正确分段计算 |

- [ ] **Step 4：运行全量测试 → 提交**

```powershell
npx vitest run
# 预期：新增 11 个测试
# 累计测试数：Phase 18 的 313 + 11 = 324+

pnpm build
pnpm typecheck
git add tests/
git commit -m "test(channels+cli): add TelegramAdapter, RateLimiter, and token estimation tests"
git push origin main
```

---

## 接口对齐观察表

| 接口 | 文件 | 签名 | 本 Phase 引用方式 |
|------|------|------|-------------------|
| `ChannelAdapter` | `src/channels/types.ts` | `readonly type, readonly config, start/stop/isRunning/onMessage/sendResponse(targetId, text, isGroup)/getStatus` | TelegramAdapter 实现全部方法，**注意 sendResponse 含 isGroup 参数** |
| `ChannelMessage` | `src/channels/types.ts` | `{ id, channelType, sender: ChannelSender, receiver: ChannelReceiver, text, isGroup, timestamp, attachments?: ChannelAttachment[] }` | parseWebhook 返回值 |
| `ChannelType` | `src/channels/types.ts` | `'wechat-work' \| 'telegram' \| 'slack' \| 'discord'` | telegram 已在枚举中 ✓ |
| `ChannelStatus` | `src/channels/types.ts` | `{ type, running, messagesProcessed, lastMessageAt?, error? }` | **注意是 messagesProcessed 不是 connected/details** |
| `WebhookServer` | `src/channels/server.ts` | `constructor(WebhookServerConfig)` / `start()` / `stop()` | **需扩展 WebhookServerConfig 添加安全字段** |
| `ChannelManager` | `src/channels/manager.ts` | `constructor(port: number)` | **需改造构造函数 + createAdapter switch** |
| `MessageRouter` | `src/channels/message-router.ts` | `handleMessage(msg)` | token 估算改进 |
| `WeChatWorkAdapter` | `src/channels/adapters/wechat-work.ts` | `refreshAccessToken()` / `verifySignature()` | 凭证安全修复 |
| `TokenTracker.getStats()` | `src/router/tracker.ts` | `() => TokenStats { total, byModel, byAgent, byStep }` | /cost 命令调用（**注意是 getStats() 不是 getTodayUsage()**） |
| `conversationHistory.current` | service-context ref | `LLMMessage[]` | /history 命令读取 |

---

## 对下一阶段的提醒

1. **Telegram 文件下载**：当前 TelegramAdapter 只识别 photo/document 的 file_id，不实际下载。后续可用 `getFile` API 下载并传给 VisionAssistant
2. **RateLimiter 内存存储**：当前是进程内存，重启后重置。多进程部署时需要 Redis 等外部存储
3. **Bearer token 存储在配置中**：`WebhookSecurityConfig.authToken` 需要在 `ChannelsConfig` schema 中添加字段，或从环境变量读取
4. **模型定价表硬编码**：/cost 的 PRICING 表应迁移到配置文件（如 config.yaml 中的 pricing 部分）
5. **中文 token 估算是启发式**：真正的准确方式是集成 tokenizer（如 tiktoken），但这会增加依赖和启动时间
6. **Slack/Discord 适配器未实现**：本 Phase 只实现了 Telegram。Slack 和 Discord 可作为后续 Phase 的内容
7. **timing attack 修复不完整**：wechat-work 的签名验证已修复，但如果其他适配器也使用字符串比较，需要一并修复
8. **splash 画面的 Ink 兼容性**：chalk 颜色在 Ink 模式下可能与 Ink 的 `<Text>` 组件冲突。建议 splash 在 Ink render 之前输出
