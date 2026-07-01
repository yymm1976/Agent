// src/channels/server.ts
// WebhookServer：HTTP 服务器，监听渠道 webhook 请求
// 使用 Node.js 内置 http 模块，零依赖

import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import type { ChannelAdapter, ChannelMessage, ChannelType } from './types.js';
import { logger } from '../utils/logger.js';

export interface WebhookServerConfig {
  port: number;
  /** GET URL（健康检查） */
  statusPath?: string;
  /** 是否启用 verbose 日志 */
  verbose?: boolean;
  /** Bearer Token 认证（未配置时为开发模式，跳过认证） */
  authToken?: string;
  /** I4 修复：开发模式是否要求认证（读取 config.security?.devModeAuth ?? false） */
  devModeAuth?: boolean;
  /** I18 修复：是否信任 X-Forwarded-For 头（反代场景才应启用，直连时禁用防伪造） */
  trustProxy?: boolean;
}

/** 速率限制令牌桶配置 */
interface RateLimitConfig {
  maxTokens: number;
  refillRate: number;
  refillIntervalMs: number;
}

/** 默认速率限制配置：30 个令牌，每秒补充 10 个 */
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxTokens: 30,
  refillRate: 10,
  refillIntervalMs: 1000,
};

/** 单个客户端的令牌桶状态 */
interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export class WebhookServer {
  private server: http.Server | null = null;
  private adapters = new Map<string, ChannelAdapter>();
  private config: WebhookServerConfig;
  /** 速率限制：按 clientIp 维护令牌桶 */
  private rateLimit = new Map<string, TokenBucket>();
  private rateLimitConfig: RateLimitConfig = DEFAULT_RATE_LIMIT;
  /** rateLimit 定期清理定时器（在 stop() 中清除，防止泄漏） */
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: WebhookServerConfig) {
    this.config = {
      statusPath: '/status',
      verbose: false,
      ...config,
    };
  }

  /** 注册渠道适配器 */
  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  /** 启动服务器 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          logger.error('WebhookServer: handleRequest error', { error: String(err) });
          this.sendJson(res, 500, { error: 'internal error' });
        });
      });

      this.server.on('error', err => {
        reject(err);
      });

      this.server.listen(this.config.port, () => {
        logger.info('WebhookServer started', { port: this.config.port });
        resolve();
      });

      // I17 修复：定期清理过期 rateLimit 条目（1 小时无活动），防止 Map 无界增长
      this.cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [ip, bucket] of this.rateLimit) {
          if (now - bucket.lastRefill > 3600_000) {
            this.rateLimit.delete(ip);
          }
        }
      }, 600_000);
      // I15 修复：使用前检查 cleanupInterval 是否为 null，防止 setInterval 返回异常时崩溃
      if (this.cleanupInterval) {
        this.cleanupInterval.unref();
      }
    });
  }

  /** 停止服务器 */
  stop(): Promise<void> {
    // 清理 rateLimit 定时器，防止泄漏
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    return new Promise(resolve => {
      if (this.server) {
        this.server.close(() => {
          logger.info('WebhookServer stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** 获取运行中的适配器列表 */
  getRunningAdapters(): ChannelAdapter[] {
    return [...this.adapters.values()].filter(a => a.isRunning());
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // 1. 速率限制（所有路径都受限，包括 /status）
    const clientIp = this.getClientIp(req);
    if (!this.checkRateLimit(clientIp)) {
      this.sendJson(res, 429, { error: 'rate limit exceeded' });
      return;
    }

    // 状态端点（免认证）
    if (url.pathname === this.config.statusPath && req.method === 'GET') {
      this.handleStatus(res);
      return;
    }

    // 2. 认证（/status 已在上面提前返回，其余路径需要认证）
    if (!this.verifyAuth(req)) {
      this.sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // 3. 原有逻辑：渠道 webhook 路由
    // 路径格式: /webhook/<channel-type>
    const match = url.pathname.match(/^\/webhook\/([\w-]+)$/);
    if (!match) {
      this.sendJson(res, 404, { error: 'not found' });
      return;
    }

    const channelType = match[1] as ChannelType;
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      this.sendJson(res, 404, { error: `no adapter for ${channelType}` });
      return;
    }

    // 读取请求体
    const body = await this.readBody(req);

    // 验证签名（由 adapter 实现）
    if (typeof (adapter as unknown as { verifySignature?: (body: string, signature: string, timestamp: string) => boolean }).verifySignature === 'function') {
      // 安全修复：不同渠道使用不同的签名 header，原行为硬编码企业微信 header 名
      // Slack 发送 X-Slack-Signature / X-Slack-Request-Timestamp，企业微信发送 msg_signature / timestamp
      let signature: string;
      let timestamp: string;
      if (channelType === 'slack') {
        signature = (req.headers['x-slack-signature'] as string) ?? '';
        timestamp = (req.headers['x-slack-request-timestamp'] as string) ?? '';
      } else {
        // 企业微信及其他渠道使用 msg_signature / timestamp
        signature = (req.headers['msg_signature'] as string) ?? '';
        timestamp = (req.headers['timestamp'] as string) ?? '';
      }
      const valid = (adapter as unknown as { verifySignature: (body: string, signature: string, timestamp: string) => boolean }).verifySignature(body, signature, timestamp);
      if (!valid) {
        this.sendJson(res, 401, { error: 'invalid signature' });
        return;
      }
    }

    // 解析消息（由 adapter 实现）
    if (typeof (adapter as unknown as { parseWebhook?: (body: string) => Promise<ChannelMessage | null> }).parseWebhook === 'function') {
      try {
        const message = await (adapter as unknown as { parseWebhook: (body: string) => Promise<ChannelMessage | null> }).parseWebhook(body);
        if (!message) {
          this.sendJson(res, 400, { error: 'invalid message' });
          return;
        }

        // 调用 adapter 的 onMessage handler
        const handler = (adapter as unknown as { messageHandler?: (msg: ChannelMessage) => Promise<string> }).messageHandler;
        if (handler) {
          const responseText = await handler(message);
          // 适配器发送回复
          await adapter.sendResponse(message.sender.id, responseText, message.isGroup);
        }
        this.sendJson(res, 200, { ok: true });
      } catch (error) {
        logger.error('WebhookServer: parse failed', { error: String(error) });
        // Minor 修复：不向客户端泄露内部错误细节，仅返回通用错误消息
        this.sendJson(res, 500, { error: 'internal server error' });
      }
    } else {
      this.sendJson(res, 501, { error: 'adapter not fully implemented' });
    }
  }

  private handleStatus(res: http.ServerResponse): void {
    // I4 修复：/status 免认证，仅返回最小健康状态，不泄露适配器列表和端口
    this.sendJson(res, 200, { ok: true });
  }

  /** 读取请求体，限制最大字节数（默认 1MB）防止内存耗尽攻击 */
  private readBody(req: http.IncomingMessage, maxBytes = 1_048_576): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          // 超过限制：销毁请求流并拒绝
          req.destroy();
          reject(new Error(`request body exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  /** 验证 Bearer Token 认证 */
  private verifyAuth(req: http.IncomingMessage): boolean {
    // I3 修复：未配置 authToken 时，默认拒绝（安全优先）。
    // 仅当显式开启 devModeAuth=false（即 config.security.devModeAuth=false）时才放行，
    // 避免 routedev serve 暴露端口后未认证请求驱动 Agent。
    if (!this.config.authToken) {
      if (process.env.NODE_ENV === 'production') {
        logger.error('Webhook authToken 未配置，生产环境拒绝请求');
        return false;
      }
      // devModeAuth 默认 true（要求认证）；仅显式 false 时放行
      if (this.config.devModeAuth !== false) {
        logger.error('Webhook authToken 未配置且 devModeAuth 未显式关闭，拒绝请求');
        return false;
      }
      return true; // 显式开发模式放行
    }

    const authHeader = req.headers['authorization'];
    if (typeof authHeader !== 'string') return false;
    if (!authHeader.startsWith('Bearer ')) return false;

    const token = authHeader.slice('Bearer '.length);
    const expected = this.config.authToken;

    // 长度不同直接返回 false（timingSafeEqual 要求长度相等）
    if (token.length !== expected.length) return false;

    try {
      // 使用 timingSafeEqual 防止时序攻击
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  /** 令牌桶速率限制检查 */
  private checkRateLimit(clientIp: string): boolean {
    // I17 修复：限制 rateLimit Map 大小，防止每个唯一 clientIp 创建条目导致无界增长
    if (this.rateLimit.size >= 10000 && !this.rateLimit.has(clientIp)) {
      logger.warn('Rate limit map full, rejecting new IP', { clientIp });
      return false;
    }
    const now = Date.now();
    const bucket = this.rateLimit.get(clientIp);

    if (!bucket) {
      // 新客户端：初始化为满桶
      this.rateLimit.set(clientIp, {
        tokens: this.rateLimitConfig.maxTokens - 1,
        lastRefill: now,
      });
      return true;
    }

    // 计算补充的令牌数
    const elapsed = now - bucket.lastRefill;
    const refillSteps = Math.floor(elapsed / this.rateLimitConfig.refillIntervalMs);
    const refilled = refillSteps * this.rateLimitConfig.refillRate;

    // 更新令牌数（不超过最大值）
    bucket.tokens = Math.min(this.rateLimitConfig.maxTokens, bucket.tokens + refilled);
    bucket.lastRefill = bucket.lastRefill + refillSteps * this.rateLimitConfig.refillIntervalMs;

    if (bucket.tokens <= 0) {
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }

  /** 从请求中提取客户端 IP（兼容反向代理） */
  private getClientIp(req: http.IncomingMessage): string {
    // I18 修复：仅在 trustProxy 启用时信任 X-Forwarded-For，防止直连场景下客户端伪造此头绕过速率限制
    if (this.config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded.length > 0) {
        // 取第一个 IP（最原始的客户端 IP）
        return forwarded.split(',')[0].trim();
      }
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}
