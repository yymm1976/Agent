// src/tools/builtin/web-fetch.ts
// 网页抓取工具：获取 URL 内容并转为纯文本
// P1-7：Codex/Claude Code 都有 web_fetch/browse 工具，RouteDev 缺失
// P0-1 修复：集成 SSRF 防护（DNS 解析后校验 IP + 私有网段拦截 + 重定向深度限制）
//
// 功能：
//   1. 抓取 HTTP/HTTPS URL 内容
//   2. 去除 HTML 标签，提取纯文本
//   3. 限制返回内容大小（防止撑爆上下文）
//   4. 超时保护
//   5. SSRF 防护：DNS 解析后校验 IP，防止访问内网/元数据端点
//   6. 重定向深度限制（最多 5 次），每次重定向重新校验目标

import https from 'node:https';
import http from 'node:http';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { checkSSRF, getMaxRedirectDepth } from '../security-enhanced.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0';

// 修复：放宽到 1MB，GitHub/文档站等现代网页常超过 256KB
const MAX_CONTENT_BYTES = 1024 * 1024;

/** 请求超时（30 秒） */
const REQUEST_TIMEOUT_MS = 30000;

export class WebFetchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'web_fetch',
    description: '当用户需要抓取网页内容并转为纯文本时，使用此工具。支持 HTTP/HTTPS，自动去除 HTML 标签，内置 SSRF 防护与重定向深度限制。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要抓取的 URL（必须包含 http:// 或 https://）',
        },
        maxChars: {
          type: 'number',
          description: '最大返回字符数（默认 50000，约 12K tokens）',
        },
      },
      required: ['url'],
    },
    // 修复：网页抓取是只读操作，默认不需要用户确认
    requiresApproval: false,
    category: 'web',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.url || typeof args.url !== 'string') {
      errors.push('缺少必需参数: url');
    } else {
      try {
        const parsed = new URL(args.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push('URL 必须使用 http 或 https 协议');
        }
      } catch {
        errors.push('无效的 URL 格式');
      }
    }
    if (args.maxChars !== undefined && typeof args.maxChars !== 'number') {
      errors.push('maxChars 必须是数字');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const url = args.url as string;
    const maxChars = (args.maxChars as number) ?? 50000;

    try {
      // P0-1 修复：抓取前执行 SSRF 检查
      // DNS 解析后校验 IP，防止访问内网/元数据端点
      const ssrfResult = await checkSSRF(url);
      if (!ssrfResult.allowed) {
        return {
          success: false,
          output: '',
          error: `SSRF 防护拦截: ${ssrfResult.reason}`,
          durationMs: 0,
          metadata: { url, ssrfBlocked: true },
        };
      }

      const rawContent = await this.fetchUrl(url, 0);
      const text = this.htmlToText(rawContent);

      // 截断到最大字符数
      const sourceTruncated = rawContent.length >= MAX_CONTENT_BYTES;
      const truncated = text.length > maxChars;
      let result = text;
      if (truncated) {
        result = text.slice(0, maxChars) + `\n\n[... 内容已截断，共 ${text.length} 字符，已显示前 ${maxChars} 字符]`;
      }
      if (sourceTruncated) {
        result += `\n[... 网页源内容超过 ${MAX_CONTENT_BYTES} 字节，已按 1MB 截断读取]`;
      }

      return {
        success: true,
        output: result,
        durationMs: 0,
        metadata: {
          url,
          totalChars: text.length,
          returnedChars: truncated ? maxChars : text.length,
          truncated,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `抓取网页失败: ${msg}`,
        durationMs: 0,
      };
    }
  }

  /** 抓取 URL 内容（带重定向深度限制和 SSRF 重新校验） */
  private fetchUrl(url: string, redirectDepth: number): Promise<string> {
    return new Promise((resolve, reject) => {
      // P0-1 修复：重定向深度限制
      const maxDepth = getMaxRedirectDepth();
      if (redirectDepth >= maxDepth) {
        reject(new Error(`重定向深度超过限制 (${maxDepth})`));
        return;
      }

      const protocol = url.startsWith('https:') ? https : http;

      const req = protocol.get(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        // 处理重定向
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location;
          // 相对路径重定向
          const fullRedirectUrl = redirectUrl.startsWith('http')
            ? redirectUrl
            : new URL(redirectUrl, url).toString();

          // P0-1 修复：重定向目标也需要 SSRF 校验
          checkSSRF(fullRedirectUrl).then(ssrfResult => {
            if (!ssrfResult.allowed) {
              reject(new Error(`重定向目标被 SSRF 防护拦截: ${ssrfResult.reason}`));
              return;
            }
            this.fetchUrl(fullRedirectUrl, redirectDepth + 1).then(resolve).catch(reject);
          }).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
          return;
        }

        let data = '';
        let totalBytes = 0;
        let truncated = false;

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          // 修复：超过最大字节数时截断而不是抛错，返回已接收内容
          if (totalBytes > MAX_CONTENT_BYTES) {
            if (!truncated) {
              truncated = true;
              // 把当前 chunk 能放下的部分追加进去（近似截断）
              const remaining = Math.max(0, MAX_CONTENT_BYTES - (totalBytes - chunk.length));
              if (remaining > 0) {
                data += chunk.toString('utf-8', 0, remaining);
              }
            }
            req.destroy();
            return;
          }
          data += chunk.toString('utf-8');
        });

        res.on('end', () => resolve(data));
        res.on('aborted', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
    });
  }

  /** HTML 转纯文本（简易版） */
  private htmlToText(html: string): string {
    let text = html;

    // 移除 script 和 style 标签及其内容
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    // 将 <br>、<p>、<div> 等块级标签转为换行
    text = text.replace(/<(br|hr|p|div|h[1-6]|li|tr|table)[^>]*>/gi, '\n');

    // 移除所有 HTML 标签
    text = text.replace(/<[^>]+>/g, '');

    // 解码 HTML 实体（P2-3：扩展数字实体和命名实体）
    // M2 修复：使用 String.fromCodePoint 替代 String.fromCharCode
    // fromCharCode 仅支持 16 位码元（BMP），code points > 0xFFFF（如 emoji 😀 = U+1F600）会被截断为乱码
    // fromCodePoint 支持完整 Unicode 范围，正确处理 emoji 和辅助平面字符
    // 数字实体（十进制）：&#8217; → ' 等
    text = text.replace(/&#(\d+);/g, (_, code) => {
      return String.fromCodePoint(parseInt(code, 10));
    });
    // 数字实体（十六进制）：&#x27; → ' 等
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
      return String.fromCodePoint(parseInt(code, 16));
    });
    // 常见命名实体
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      .replace(/&hellip;/g, '…')
      .replace(/&lsquo;/g, '\u2018')
      .replace(/&rsquo;/g, '\u2019')
      .replace(/&ldquo;/g, '\u201C')
      .replace(/&rdquo;/g, '\u201D')
      .replace(/&copy;/g, '©')
      .replace(/&reg;/g, '®')
      .replace(/&trade;/g, '™');

    // 压缩多余空白行
    text = text
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text;
  }
}
