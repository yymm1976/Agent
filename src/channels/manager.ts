// src/channels/manager.ts
// ChannelManager：渠道管理器

import type { ChannelAdapter, ChannelType, ChannelStatus } from './types.js';
import type { ChannelEntryConfig } from '../config/schema.js';
import type { MessageRouter } from './message-router.js';
import { WeChatWorkAdapter } from './adapters/wechat-work.js';
import { TelegramAdapter, type TelegramConfig } from './adapters/telegram.js';
import { WebhookServer } from './server.js';
import { logger } from '../utils/logger.js';

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private router: MessageRouter | null = null;
  private server: WebhookServer | null = null;
  private port: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(port: number) {
    this.port = port;
  }

  /** 初始化所有已配置的渠道 */
  initializeAdapters(entries: ChannelEntryConfig[], router: MessageRouter): void {
    this.router = router;
    this.server = new WebhookServer({ port: this.port });

    for (const entry of entries) {
      if (!entry.enabled) {
        logger.info('Channel disabled, skipping', { id: entry.id, type: entry.type });
        continue;
      }

      try {
        const adapter = this.createAdapter(entry, router);
        this.adapters.set(entry.type, adapter);
        this.server.registerAdapter(adapter);
        logger.info('Channel adapter created', { id: entry.id, type: entry.type });
      } catch (error) {
        logger.error('Failed to create channel adapter', {
          id: entry.id,
          type: entry.type,
          error: String(error),
        });
      }
    }
  }

  private createAdapter(entry: ChannelEntryConfig, router: MessageRouter): ChannelAdapter {
    switch (entry.type) {
      case 'wechat-work':
        return new WeChatWorkAdapter({
          id: entry.id,
          type: 'wechat-work',
          enabled: entry.enabled,
          options: entry.options as WeChatWorkConfig['options'],
        });
      case 'telegram':
        return new TelegramAdapter({
          id: entry.id,
          type: 'telegram',
          enabled: entry.enabled,
          options: entry.options as TelegramConfig['options'],
        });
      default:
        throw new Error(`Unsupported channel type: ${entry.type}`);
    }
  }

  /** 启动所有渠道和服务器 */
  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start();
      // 注册消息处理器
      if (this.router) {
        adapter.onMessage(async msg => {
          return await this.router!.handleMessage(msg);
        });
      }
    }

    if (this.server) {
      await this.server.start();
    }

    // 启动定期清理
    if (this.router) {
      this.cleanupInterval = setInterval(() => {
        this.router!.cleanupExpiredContexts();
      }, 10 * 60 * 1000); // 每 10 分钟
    }
  }

  /** 停止所有渠道和服务器 */
  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch (error) {
        logger.warn('Failed to stop adapter', { error: String(error) });
      }
    }

    if (this.server) {
      await this.server.stop();
    }
  }

  /** 获取所有渠道状态 */
  getAllStatus(): ChannelStatus[] {
    return [...this.adapters.values()].map(a => a.getStatus());
  }

  /** 获取渠道数量 */
  get adapterCount(): number {
    return this.adapters.size;
  }

  /** 获取活跃渠道数量 */
  get runningAdapterCount(): number {
    return [...this.adapters.values()].filter(a => a.isRunning()).length;
  }
}

import type { WeChatWorkConfig } from './adapters/wechat-work.js';