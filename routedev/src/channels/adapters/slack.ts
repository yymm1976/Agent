// src/channels/adapters/slack.ts
// SlackAdapter：Slack 通道适配器（Phase 23 Task 2）
// 实现 ChannelAdapter 接口，验证签名、去重消息、格式转换
// 不引入新依赖——使用 node:crypto 和全局 fetch

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelMessage,
  ChannelResponse,
  ChannelMessageHandler,
  ChannelStatus,
  ChannelType,
} from '../types.js';
import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';

/** Slack 适配器配置 */
export interface SlackAdapterConfig extends ChannelConfig {
  type: 'slack';
  options: {
    /** Bot OAuth Token（xoxb-...） */
    botToken?: string;
    /** Signing Secret（用于验证 Events API 请求签名） */
    signingSecret?: string;
    /** App-Level Token（xapp-...，Socket Mode 可选） */
    appToken?: string;
  };
}

/** Slack 签名验证最大时间偏差（5 分钟，防重放） */
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/** Slack Web API 基础 URL */
const SLACK_API_BASE = 'https://slack.com/api';

/** Slack API 请求超时时间（10 秒，防止网络挂起导致通道阻塞） */
const SLACK_API_TIMEOUT_MS = 10_000;

export class SlackAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'slack';
  readonly config: SlackAdapterConfig;
  private messageHandler: ChannelMessageHandler | null = null;
  private messagesProcessed = 0;
  private lastMessageAt: number | undefined;
  private running = false;
  /** 已处理的 event_id 集合（消息去重） */
  private processedEventIds = new Set<string>();
  /** 去重集合最大容量（避免内存泄漏） */
  private readonly DEDUP_MAX_SIZE = 1000;

  constructor(config: SlackAdapterConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.options.botToken) {
      logger.warn('SlackAdapter: missing botToken');
      return;
    }
    this.running = true;
    logger.info('SlackAdapter started', {
      hasSigningSecret: !!this.config.options.signingSecret,
      hasAppToken: !!this.config.options.appToken,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    logger.info('SlackAdapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  async sendResponse(targetId: string, text: string, _isGroup: boolean): Promise<ChannelResponse> {
    const token = this.config.options.botToken;
    if (!token) {
      return { text: '', success: false, error: 'missing botToken' };
    }

    // 10 秒超时控制：防止网络挂起导致通道阻塞
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SLACK_API_TIMEOUT_MS);

    try {
      const body = this.formatOutbound(text);
      const response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          channel: targetId,
          ...body,
        }),
        signal: controller.signal,
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        return { text, success: false, error: data.error ?? 'send failed' };
      }
      return { text, success: true };
    } catch (error) {
      // AbortError 转为更友好的超时提示
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      return {
        text,
        success: false,
        error: isTimeout ? `slack api timeout (${SLACK_API_TIMEOUT_MS}ms)` : (error instanceof Error ? error.message : String(error)),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  getStatus(): ChannelStatus {
    return {
      type: this.type,
      running: this.isRunning(),
      messagesProcessed: this.messagesProcessed,
      lastMessageAt: this.lastMessageAt,
    };
  }

  // ===== 签名验证 =====

  /**
   * 验证 Slack Events API 请求签名
   * Slack 签名格式：v0=HMAC-SHA256(signingSecret, "v0:timestamp:body")
   * @param body 原始请求体字符串
   * @param signature X-Slack-Signature 头值（v0=...）
   * @param timestamp X-Slack-Request-Timestamp 头值
   * @returns 验证是否通过
   */
  verifySignature(body: string, signature: string, timestamp: string): boolean {
    const secret = this.config.options.signingSecret;
    if (!secret) {
      // 生产模式：签名密钥未配置时拒绝请求，避免静默放行
      // 开发模式：降级放行（保留开发便利），但记录警告
      if (process.env.NODE_ENV === 'production') {
        logger.error('SlackAdapter signingSecret 未配置，生产模式拒绝处理请求');
        return false;
      }
      logger.warn('SlackAdapter signingSecret 未配置，开发模式放行（不安全）');
      return true;
    }

    // 时间戳防重放：超过 5 分钟拒绝
    const tsNum = parseInt(timestamp, 10);
    if (isNaN(tsNum)) return false;
    const ageMs = Math.abs(Date.now() - tsNum * 1000);
    if (ageMs > SIGNATURE_MAX_AGE_MS) {
      logger.warn('SlackAdapter: rejected stale request', { ageMs });
      return false;
    }

    // 计算期望签名：v0=HMAC-SHA256(secret, "v0:timestamp:body")
    const base = `v0:${timestamp}:${body}`;
    const expected = 'v0=' + crypto
      .createHmac('sha256', secret)
      .update(base)
      .digest('hex');

    // 使用 timingSafeEqual 防止时序攻击
    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);
    if (expectedBuf.length !== signatureBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  }

  // ===== URL Verification 挑战 =====

  /**
   * 处理 Slack URL Verification 挑战
   * Slack 在配置 Events API 时会发送 challenge 请求
   * @returns challenge 值或 null（非挑战请求）
   */
  handleUrlVerification(body: string): { challenge: string } | null {
    try {
      const payload = JSON.parse(body) as { challenge?: string; type?: string };
      if (payload.type === 'url_verification' && payload.challenge) {
        return { challenge: payload.challenge };
      }
    } catch {
      // 非 JSON 或解析失败——不是挑战请求
    }
    return null;
  }

  // ===== 消息去重 =====

  /**
   * 检查 event_id 是否已处理（幂等判断）
   * @returns true 表示已处理（应跳过），false 表示首次出现
   */
  isDuplicate(eventId: string): boolean {
    if (this.processedEventIds.has(eventId)) {
      return true;
    }
    // 容量保护：超过上限时清空旧记录
    if (this.processedEventIds.size >= this.DEDUP_MAX_SIZE) {
      this.processedEventIds.clear();
    }
    this.processedEventIds.add(eventId);
    return false;
  }

  // ===== 消息格式转换 =====

  /**
   * Inbound：Slack mrkdwn → plain text
   * - `<!here>` / `<!channel>` → @here / @channel
   * - `<@U123>` → @U123（无用户名映射时保留 ID）
   * - `*bold*` → `**bold**`（标准 Markdown）
   * - `~strike~` → `~~strike~~`
   * - `> quote` 保留
   */
  formatInbound(text: string): string {
    return text
      // 特殊提及：<!here> → @here, <!channel> → @channel
      .replace(/<!(here|channel|everyone)>/g, '@$1')
      // 用户提及：<@U123> → @U123
      .replace(/<@([A-Z0-9]+)>/g, '@$1')
      // 频道提及：<#C123|general> → #general
      .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2')
      // 简单频道提及：<#C123> → #C123
      .replace(/<#([A-Z0-9]+)>/g, '#$1')
      // 链接：<http://...|text> → text
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
      // 纯链接：<http://...> → http://...
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      // Slack bold：*text* → **text**
      .replace(/\*([^*]+)\*/g, '**$1**')
      // Slack strike：~text~ → ~~text~~
      .replace(/~([^~]+)~/g, '~~$1~~');
  }

  /**
   * Outbound：plain text → Slack blocks 格式
   * 将 Markdown 文本转换为 Slack Block Kit 结构
   */
  formatOutbound(text: string): { text?: string; blocks?: unknown[] } {
    // 按代码块分段
    const codeBlockRegex = /```([\s\S]*?)```/g;
    const segments: Array<{ type: 'code' | 'text'; content: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
      }
      segments.push({ type: 'code', content: match[1] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      segments.push({ type: 'text', content: text.slice(lastIndex) });
    }

    // 构建 blocks
    const blocks: unknown[] = [];
    for (const seg of segments) {
      const trimmed = seg.content.trim();
      if (!trimmed) continue;
      if (seg.type === 'code') {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `\`\`\`${trimmed}\`\`\`` },
        });
      } else {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: trimmed },
        });
      }
    }

    // 无 blocks 时回退为纯文本
    if (blocks.length === 0) {
      return { text: text.slice(0, 4000) };
    }

    return { blocks };
  }

  // ===== Webhook 处理 =====

  /**
   * 解析 Slack Events API webhook payload
   * @param body 原始请求体字符串
   * @returns ChannelMessage 或 null（非消息事件）
   */
  parseWebhook(body: string): ChannelMessage | null {
    try {
      const payload = JSON.parse(body) as {
        event_id?: string;
        event?: {
          type: string;
          text?: string;
          user?: string;
          channel?: string;
          ts?: string;
          thread_ts?: string;
          channel_type?: string;
        };
        team_id?: string;
      };

      // 仅处理 message 事件
      if (!payload.event || payload.event.type !== 'message') {
        return null;
      }

      const evt = payload.event;
      const eventId = payload.event_id ?? evt.ts ?? `${evt.user}-${evt.ts}`;
      if (this.isDuplicate(eventId)) {
        logger.debug('SlackAdapter: duplicate event skipped', { eventId });
        return null;
      }

      const text = this.formatInbound(evt.text ?? '');
      if (!text) return null;

      const tsNum = parseFloat(evt.ts ?? '0');
      return {
        id: eventId,
        channelType: 'slack',
        sender: { id: evt.user ?? 'unknown' },
        receiver: { id: evt.channel ?? 'unknown' },
        text,
        isGroup: evt.channel_type === 'channel' || evt.channel_type === 'group',
        timestamp: tsNum > 0 ? tsNum * 1000 : Date.now(),
      };
    } catch (error) {
      logger.warn('SlackAdapter: parseWebhook failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 处理 webhook 请求（由 HTTP server 调用）
   * @returns 响应体（challenge 或处理结果）
   */
  async handleWebhook(body: string, signature: string, timestamp: string): Promise<{
    status: number;
    body: unknown;
  }> {
    // 1. 验证签名
    if (!this.verifySignature(body, signature, timestamp)) {
      return { status: 401, body: { error: 'invalid signature' } };
    }

    // 2. URL Verification 挑战
    const challenge = this.handleUrlVerification(body);
    if (challenge) {
      return { status: 200, body: { challenge: challenge.challenge } };
    }

    // 3. 解析消息
    const message = this.parseWebhook(body);
    if (!message) {
      return { status: 200, body: { ok: true, skipped: true } };
    }

    // 4. 触发处理器
    if (this.messageHandler) {
      this.messagesProcessed++;
      this.lastMessageAt = Date.now();
      try {
        const reply = await this.messageHandler(message);
        await this.sendResponse(message.receiver.id, reply, message.isGroup);
      } catch (error) {
        logger.error('SlackAdapter: handle message failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { status: 200, body: { ok: true } };
  }
}
