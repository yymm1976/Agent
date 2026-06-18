// src/channels/adapters/wechat-work.ts
// WeChatWorkAdapter：企业微信适配器
// 实现 ChannelAdapter 接口，验证签名、解密消息、发送回复

import type { ChannelAdapter, ChannelConfig, ChannelMessage, ChannelResponse, ChannelMessageHandler, ChannelStatus, ChannelType } from '../types.js';
import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';

export interface WeChatWorkConfig extends ChannelConfig {
  type: 'wechat-work';
  options: {
    corpId?: string;
    corpSecret?: string;
    agentId?: string;
    token?: string;
    encodingAESKey?: string;
  };
}

export class WeChatWorkAdapter implements ChannelAdapter {
  readonly type: ChannelType = 'wechat-work';
  readonly config: WeChatWorkConfig;
  private messageHandler: ChannelMessageHandler | null = null;
  private messagesProcessed = 0;
  private lastMessageAt: number | undefined;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private aesKey: Buffer | null = null;

  constructor(config: WeChatWorkConfig) {
    this.config = config;
    if (config.options.encodingAESKey) {
      // EncodingAESKey 是 Base64 编码的 43 字符，解码后是 32 字节密钥
      this.aesKey = Buffer.from(config.options.encodingAESKey + '=', 'base64');
    }
  }

  async start(): Promise<void> {
    logger.info('WeChatWorkAdapter started', {
      corpId: this.config.options.corpId ? '***' : '(missing)',
      agentId: this.config.options.agentId,
    });
  }

  async stop(): Promise<void> {
    this.accessToken = null;
    logger.info('WeChatWorkAdapter stopped');
  }

  isRunning(): boolean {
    return !!this.config.options.corpId && !!this.config.options.corpSecret;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }

  async sendResponse(targetId: string, text: string, isGroup: boolean): Promise<ChannelResponse> {
    if (!this.messageHandler) {
      return { text: '', success: false, error: 'no handler' };
    }

    // 应用渠道回复（实际上 onMessage 已被外部调用，这里保留占位）
    this.messagesProcessed++;
    this.lastMessageAt = Date.now();
    return { text, success: true };
  }

  getStatus(): ChannelStatus {
    return {
      type: this.type,
      running: this.isRunning(),
      messagesProcessed: this.messagesProcessed,
      lastMessageAt: this.lastMessageAt,
    };
  }

  /** 验证企业微信签名 */
  verifySignature(body: string, signature: string, timestamp: string): boolean {
    const token = this.config.options.token;
    if (!token) return true; // 未配置 token 时跳过验证（开发模式）

    // 企业微信签名算法：sha1(token + timestamp + body)
    const expected = crypto
      .createHash('sha1')
      .update(token)
      .update(timestamp)
      .update(body)
      .digest('hex');
    return expected === signature;
  }

  /** 解密企业微信消息（如果需要） */
  decryptMessage(encrypted: string): string {
    if (!this.aesKey) {
      return encrypted; // 未配置 AES key，直接返回原文
    }

    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.aesKey.slice(0, 16));
      let decrypted = decipher.update(encrypted, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      // 去除 PKCS#7 padding
      const padLen = decrypted.charCodeAt(decrypted.length - 1);
      if (padLen >= 1 && padLen <= 32) {
        decrypted = decrypted.slice(0, decrypted.length - padLen);
      }
      return decrypted;
    } catch (error) {
      logger.warn('WeChatWork: decrypt failed', { error: String(error) });
      return encrypted;
    }
  }

  /** 解析企业微信 XML 消息 */
  parseWebhook(body: string): ChannelMessage | null {
    const decrypted = this.decryptMessage(body);

    // 提取关键字段（XML 格式：<xml><Content>...</Content><FromUserName>...</FromUserName></xml>）
    const extract = (tag: string): string => {
      const match = decrypted.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, 's'));
      return match ? match[1] : '';
    };

    const content = extract('Content');
    const fromUser = extract('FromUserName');
    const toUser = extract('ToUserName');
    const msgId = extract('MsgId');
    const createTime = parseInt(extract('CreateTime'), 10);

    if (!content || !fromUser) {
      return null;
    }

    return {
      id: msgId || `${fromUser}-${Date.now()}`,
      channelType: 'wechat-work',
      sender: { id: fromUser, name: fromUser },
      receiver: { id: toUser, name: toUser },
      text: content,
      isGroup: false,
      timestamp: createTime ? createTime * 1000 : Date.now(),
    };
  }

  /** 触发消息处理（由外部调用） */
  async triggerMessage(message: ChannelMessage): Promise<string> {
    if (!this.messageHandler) {
      throw new Error('no handler registered');
    }
    this.messagesProcessed++;
    this.lastMessageAt = Date.now();
    return await this.messageHandler(message);
  }

  /** 获取 access_token（带缓存） */
  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 5 * 60 * 1000) {
      return this.accessToken;
    }
    return null; // 需要调用 refreshAccessToken
  }

  /** 刷新 access_token（实际调用企业微信 API） */
  async refreshAccessToken(): Promise<string | null> {
    const { corpId, corpSecret } = this.config.options;
    if (!corpId || !corpSecret) return null;

    try {
      // 实际生产环境使用 fetch
      const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`;
      const response = await fetch(url);
      const data = await response.json() as { access_token?: string; expires_in?: number; errcode?: number };

      if (data.access_token && data.expires_in) {
        this.accessToken = data.access_token;
        this.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
        return this.accessToken;
      }
      logger.warn('WeChatWork: gettoken failed', { data });
      return null;
    } catch (error) {
      logger.error('WeChatWork: refreshAccessToken error', { error: String(error) });
      return null;
    }
  }

  /** 发送消息到企业微信（实际调用 API） */
  async sendToUser(userId: string, text: string): Promise<boolean> {
    let token = await this.getAccessToken();
    if (!token) {
      token = await this.refreshAccessToken();
      if (!token) return false;
    }

    const agentId = this.config.options.agentId;
    if (!agentId) return false;

    try {
      const response = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: userId,
            msgtype: 'text',
            agentid: parseInt(agentId, 10),
            text: { content: text },
          }),
        },
      );
      const data = await response.json() as { errcode?: number; errmsg?: string };
      return data.errcode === 0;
    } catch (error) {
      logger.error('WeChatWork: sendToUser error', { error: String(error) });
      return false;
    }
  }
}