// src/channels/server.ts
// WebhookServer：HTTP 服务器，监听渠道 webhook 请求
// 使用 Node.js 内置 http 模块，零依赖

import http from 'node:http';
import { URL } from 'node:url';
import type { ChannelAdapter, ChannelMessage, ChannelType } from './types.js';
import { logger } from '../utils/logger.js';

export interface WebhookServerConfig {
  port: number;
  /** GET URL（健康检查） */
  statusPath?: string;
  /** 是否启用 verbose 日志 */
  verbose?: boolean;
}

export class WebhookServer {
  private server: http.Server | null = null;
  private adapters = new Map<string, ChannelAdapter>();
  private config: WebhookServerConfig;

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
    });
  }

  /** 停止服务器 */
  stop(): Promise<void> {
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

    // 状态端点
    if (url.pathname === this.config.statusPath && req.method === 'GET') {
      this.handleStatus(res);
      return;
    }

    // 渠道 webhook 路由
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
      const signature = (req.headers['msg_signature'] as string) ?? '';
      const timestamp = (req.headers['timestamp'] as string) ?? '';
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
        this.sendJson(res, 500, { error: String(error) });
      }
    } else {
      this.sendJson(res, 501, { error: 'adapter not fully implemented' });
    }
  }

  private handleStatus(res: http.ServerResponse): void {
    const adapters = [...this.adapters.values()].map(a => a.getStatus());
    this.sendJson(res, 200, {
      running: this.server !== null,
      adapters,
      port: this.config.port,
    });
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
}