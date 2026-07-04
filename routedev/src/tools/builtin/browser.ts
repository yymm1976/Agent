// src/tools/builtin/browser.ts
// 轻量级浏览器工具：fetch / screenshot / extract
// 设计取舍：不引入 puppeteer/playwright（避免依赖膨胀）
//   - fetch：用 Node 原生 fetch API，支持超时和自定义 headers
//   - screenshot：puppeteer 可用则用，否则返回错误"截图需要 puppeteer"
//   - extract：用正则提取 HTML 元素（不完美但够用，避免 cheerio 依赖）
// fail-open：超时/网络错误返回 { success: false, error: ... }
//
// 权限：需要用户确认（网络请求）
// 分类：web

import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

const USER_AGENT = 'RouteDev/1.0';

/** 默认请求超时 30 秒 */
const DEFAULT_TIMEOUT_MS = 30000;

/** 响应体最大 1MB */
const MAX_BODY_BYTES = 1024 * 1024;

/** browser 工具参数 */
export interface BrowserToolArgs {
  action: 'fetch' | 'screenshot' | 'extract';
  url: string;
  /** CSS 选择器，用于 extract（简易版仅支持标签名、class、id） */
  selector?: string;
  /** 等待时间 ms（用于 JS 渲染，当前实现仅记录，不实际等待） */
  waitFor?: number;
  /** 超时 ms，默认 30000 */
  timeout?: number;
  /** 自定义请求头（fetch action） */
  headers?: Record<string, string>;
  /** 最大返回字符数（fetch/extract，默认 50000） */
  maxChars?: number;
}

/**
 * 轻量级浏览器工具
 * - fetch：抓取 URL 内容（增强版 web-fetch，支持超时和自定义 headers）
 * - screenshot：截图（需要 puppeteer，未安装时返回错误）
 * - extract：用 CSS 选择器提取页面元素
 */
export class BrowserTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'browser',
    description:
      '当用户需要浏览器能力时使用此工具。支持三种 action：fetch（抓取 URL 内容并转为纯文本）、screenshot（截图，需要 puppeteer）、extract（用 CSS 选择器提取页面元素）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['fetch', 'screenshot', 'extract'],
          description: '执行的动作：fetch=抓取内容，screenshot=截图，extract=提取元素',
        },
        url: {
          type: 'string',
          description: '目标 URL（必须包含 http:// 或 https://）',
        },
        selector: {
          type: 'string',
          description: 'CSS 选择器，仅 extract 动作使用（简易实现：支持 标签名 / .class / #id）',
        },
        waitFor: {
          type: 'number',
          description: '等待时间 ms（用于 JS 渲染，当前实现仅记录不实际等待）',
        },
        timeout: {
          type: 'number',
          description: '超时 ms，默认 30000',
        },
        headers: {
          type: 'object',
          description: '自定义请求头（仅 fetch 动作）',
        },
        maxChars: {
          type: 'number',
          description: '最大返回字符数（fetch/extract，默认 50000）',
        },
      },
      required: ['action', 'url'],
    },
    // 网络请求，需要用户确认
    requiresApproval: true,
    category: 'web',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const action = args.action as string | undefined;
    const url = args.url as string | undefined;

    if (!action || !['fetch', 'screenshot', 'extract'].includes(action)) {
      errors.push('action 必须是 fetch / screenshot / extract 之一');
    }

    if (!url || typeof url !== 'string') {
      errors.push('缺少必需参数: url');
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push('URL 必须使用 http 或 https 协议');
        }
      } catch {
        errors.push('无效的 URL 格式');
      }
    }

    if (action === 'extract' && (!args.selector || typeof args.selector !== 'string')) {
      errors.push('extract 动作需要 selector 参数');
    }

    if (args.timeout !== undefined && (typeof args.timeout !== 'number' || args.timeout <= 0)) {
      errors.push('timeout 必须是正数');
    }

    if (args.waitFor !== undefined && (typeof args.waitFor !== 'number' || args.waitFor < 0)) {
      errors.push('waitFor 必须是非负数');
    }

    if (args.headers !== undefined && typeof args.headers !== 'object') {
      errors.push('headers 必须是对象');
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const action = args.action as BrowserToolArgs['action'];
    const url = args.url as string;
    const timeout = (args.timeout as number) ?? DEFAULT_TIMEOUT_MS;
    const headers = (args.headers as Record<string, string> | undefined) ?? {};
    const maxChars = (args.maxChars as number) ?? 50000;
    const selector = args.selector as string | undefined;
    const waitFor = (args.waitFor as number) ?? 0;

    try {
      switch (action) {
        case 'fetch':
          return await this.doFetch(url, timeout, headers, maxChars, start);
        case 'screenshot':
          return await this.doScreenshot(url, timeout, waitFor, start);
        case 'extract':
          return await this.doExtract(url, timeout, headers, selector!, maxChars, start);
        default:
          return {
            success: false,
            output: '',
            error: `未知 action: ${action}`,
            durationMs: Date.now() - start,
          };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `browser ${action} 失败: ${msg}`,
        durationMs: Date.now() - start,
      };
    }
  }

  // ----------------------------------------------------------
  // fetch：抓取 URL 内容并转为纯文本
  // ----------------------------------------------------------
  private async doFetch(
    url: string,
    timeoutMs: number,
    headers: Record<string, string>,
    maxChars: number,
    start: number,
  ): Promise<ToolResult> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timer);

      if (!response.ok) {
        return {
          success: false,
          output: '',
          error: `HTTP ${response.status} ${response.statusText}`,
          durationMs: Date.now() - start,
          metadata: { url, status: response.status },
        };
      }

      // 限制响应体大小：先读取为 ArrayBuffer，超过 1MB 截断
      const buffer = await response.arrayBuffer();
      const totalBytes = buffer.byteLength;
      const truncated = totalBytes > MAX_BODY_BYTES;
      const slice = truncated ? buffer.slice(0, MAX_BODY_BYTES) : buffer;
      const rawHtml = new TextDecoder('utf-8').decode(slice);

      const text = this.htmlToText(rawHtml);
      const textTruncated = text.length > maxChars;
      let result = text;
      if (textTruncated) {
        result =
          text.slice(0, maxChars) +
          `\n\n[... 内容已截断，共 ${text.length} 字符，已显示前 ${maxChars} 字符]`;
      }
      if (truncated) {
        result += `\n[... 网页源内容超过 ${MAX_BODY_BYTES} 字节，已按 1MB 截断读取]`;
      }

      return {
        success: true,
        output: result,
        durationMs: Date.now() - start,
        metadata: {
          url,
          status: response.status,
          totalBytes,
          returnedChars: textTruncated ? maxChars : text.length,
          truncated: textTruncated,
          sourceTruncated: truncated,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // AbortError 通常是超时
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          output: '',
          error: `请求超时（${timeoutMs}ms）`,
          durationMs: Date.now() - start,
        };
      }
      return {
        success: false,
        output: '',
        error: `抓取失败: ${msg}`,
        durationMs: Date.now() - start,
      };
    }
  }

  // ----------------------------------------------------------
  // screenshot：截图（需要 puppeteer，未安装时返回错误）
  // ----------------------------------------------------------
  private async doScreenshot(
    url: string,
    timeoutMs: number,
    waitFor: number,
    start: number,
  ): Promise<ToolResult> {
    // 动态探测 puppeteer 是否可用（不强制依赖）
    let puppeteer: any;
    try {
      // @ts-expect-error — puppeteer 是可选依赖，未安装时 import 会抛错
      puppeteer = await import('puppeteer');
    } catch {
      return {
        success: false,
        output: '',
        error: '截图需要 puppeteer（未安装）。请运行：npm install puppeteer',
        durationMs: Date.now() - start,
        metadata: { url, missingDependency: 'puppeteer' },
      };
    }

    let browser: any;
    try {
      browser = await puppeteer.launch({ headless: 'new' });
      const page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);

      // 等待网络空闲或超时
      await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });

      // 可选等待（JS 渲染）
      if (waitFor > 0) {
        await page.waitForTimeout(waitFor);
      }

      const screenshotBuffer: Buffer = await page.screenshot({ fullPage: true });
      const base64 = screenshotBuffer.toString('base64');

      return {
        success: true,
        output: `截图成功（${screenshotBuffer.length} 字节，base64 编码 ${base64.length} 字符）`,
        durationMs: Date.now() - start,
        metadata: {
          url,
          byteLength: screenshotBuffer.length,
          encoding: 'base64',
          // 截图 base64 太大不放入 output，仅作为 metadata 占位
          base64Preview: base64.slice(0, 100) + '...',
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `截图失败: ${msg}`,
        durationMs: Date.now() - start,
      };
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch {
          // 关闭失败静默
        }
      }
    }
  }

  // ----------------------------------------------------------
  // extract：用 CSS 选择器提取页面元素（简易正则实现）
  // 支持的选择器：标签名（div）、.class、#id，可组合（div.foo / div#bar）
  // ----------------------------------------------------------
  private async doExtract(
    url: string,
    timeoutMs: number,
    headers: Record<string, string>,
    selector: string,
    maxChars: number,
    start: number,
  ): Promise<ToolResult> {
    // 先 fetch 页面 HTML
    let rawHtml: string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
          ...headers,
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timer);

      if (!response.ok) {
        return {
          success: false,
          output: '',
          error: `HTTP ${response.status} ${response.statusText}`,
          durationMs: Date.now() - start,
          metadata: { url, status: response.status },
        };
      }

      const buffer = await response.arrayBuffer();
      const truncated = buffer.byteLength > MAX_BODY_BYTES;
      const slice = truncated ? buffer.slice(0, MAX_BODY_BYTES) : buffer;
      rawHtml = new TextDecoder('utf-8').decode(slice);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          output: '',
          error: `请求超时（${timeoutMs}ms）`,
          durationMs: Date.now() - start,
        };
      }
      return {
        success: false,
        output: '',
        error: `抓取页面失败: ${msg}`,
        durationMs: Date.now() - start,
      };
    }

    // 解析选择器并提取
    const matches = this.extractBySelector(rawHtml, selector);

    if (matches.length === 0) {
      return {
        success: true,
        output: `未找到匹配 selector "${selector}" 的元素。`,
        durationMs: Date.now() - start,
        metadata: { url, selector, matchCount: 0 },
      };
    }

    // 每个匹配元素转纯文本
    const texts = matches.map(m => this.htmlToText(m));
    let result = texts
      .map((t, i) => `--- [${i + 1}] ---\n${t}`)
      .join('\n\n');

    const totalChars = result.length;
    const truncated = totalChars > maxChars;
    if (truncated) {
      result =
        result.slice(0, maxChars) +
        `\n\n[... 内容已截断，共 ${totalChars} 字符，已显示前 ${maxChars} 字符]`;
    }

    return {
      success: true,
      output: result,
      durationMs: Date.now() - start,
      metadata: {
        url,
        selector,
        matchCount: matches.length,
        totalChars,
        returnedChars: truncated ? maxChars : totalChars,
        truncated,
      },
    };
  }

  // ----------------------------------------------------------
  // 简易 CSS 选择器提取（正则实现）
  // 支持：tag / .class / #id / tag.class / tag#id
  // 不支持：后代选择器、属性选择器、伪类等
  // ----------------------------------------------------------
  private extractBySelector(html: string, selector: string): string[] {
    const sel = selector.trim();
    if (!sel) return [];

    // 解析选择器
    let tag = '';
    let cls = '';
    let id = '';

    // 匹配 tag.class#id 或任意组合
    const tagMatch = sel.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
    if (tagMatch) tag = tagMatch[1].toLowerCase();

    const classMatches = sel.match(/\.([a-zA-Z0-9_-]+)/g);
    if (classMatches) cls = classMatches.map(c => c.slice(1)).join(' ');

    const idMatch = sel.match(/#([a-zA-Z0-9_-]+)/);
    if (idMatch) id = idMatch[1];

    // 构建正则
    // 标签部分：如果没有 tag，则匹配任意标签
    const tagPattern = tag || '[a-zA-Z][a-zA-Z0-9]*';
    // class 匹配：class 属性中包含所有指定的 class
    // id 匹配：id 属性等于指定值
    let classPattern = '';
    if (cls) {
      const clsList = cls.split(' ');
      classPattern = clsList
        .map(c => `(?=[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escapeRegex(c)}\\b)`)
        .join('');
    }
    const idPattern = id ? `(?=[^>]*\\bid\\s*=\\s*["']${escapeRegex(id)}["'])` : '';

    // 构建开标签正则
    const openTagRegex = new RegExp(
      `<(${tagPattern})\\b${classPattern}${idPattern}[^>]*>`,
      'gi',
    );

    const matches: string[] = [];
    let openMatch: RegExpExecArray | null;
    while ((openMatch = openTagRegex.exec(html)) !== null) {
      const tagName = openMatch[1].toLowerCase();
      const startIndex = openMatch.index;
      const openTagEnd = startIndex + openMatch[0].length;

      // 自闭合标签（如 <img>, <br>）：直接返回开标签
      const voidTags = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr',
      ]);
      if (voidTags.has(tagName) || openMatch[0].endsWith('/>')) {
        matches.push(openMatch[0]);
        continue;
      }

      // 找匹配的关闭标签（处理嵌套）
      const closeTag = `</${tagName}>`;
      const openTag = `<${tagName}`;
      let depth = 1;
      let pos = openTagEnd;
      while (pos < html.length && depth > 0) {
        const nextOpen = html.indexOf(openTag, pos);
        const nextClose = html.indexOf(closeTag, pos);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          pos = nextOpen + openTag.length;
        } else {
          depth--;
          pos = nextClose + closeTag.length;
        }
      }

      if (depth === 0) {
        matches.push(html.slice(startIndex, pos));
      }
    }

    return matches;
  }

  // ----------------------------------------------------------
  // HTML 转纯文本（与 web-fetch 同款简易实现）
  // ----------------------------------------------------------
  private htmlToText(html: string): string {
    let text = html;

    // 移除 script 和 style 标签及其内容
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    // 将块级标签转为换行
    text = text.replace(/<(br|hr|p|div|h[1-6]|li|tr|table)[^>]*>/gi, '\n');

    // 移除所有 HTML 标签
    text = text.replace(/<[^>]+>/g, '');

    // 解码 HTML 实体
    text = text.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)));
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');

    // 压缩多余空白行
    text = text
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text;
  }
}

/** 转义正则特殊字符 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
