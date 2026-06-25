// src/tools/builtin/web-search.ts
// 网页搜索工具（多引擎回退，借鉴 PilotDeck + DeepSeek-Reasonix 方案）
//
// 支持 11 个搜索引擎，按中国可用性排序：
//   中国直连（无需翻墙）：
//     1. 智谱 GLM web_search API（需 Key，推荐）
//     2. 秘塔搜索 API（需 Key）
//     3. 百度千帆 AI 搜索 API（需 Key）
//     4. Bing CN HTML 抓取（无需 Key）
//     5. SearXNG HTML 抓取（需自建实例 URL）
//   需翻墙：
//     6. Tavily API（需 Key）
//     7. Bing Web Search API（需 Key）
//     8. Perplexity API（AI 原生搜索，需 Key）
//     9. Exa API（AI 原生搜索，需 Key）
//    10. Brave Search API（需 Key）
//    11. DuckDuckGo HTML（无需 Key，中国可能不可用）

import https from 'node:https';
import http from 'node:http';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';
import { checkSSRF } from '../security-enhanced.js';
import { logger } from '../../utils/logger.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.0';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** AI 生成的答案（Perplexity/Exa 等 AI 原生引擎设置） */
  answer?: string;
}

export class WebSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'web_search',
    description:
      '当用户需要搜索网页获取最新信息时，使用此工具。多引擎回退（11 引擎），优先中国直连引擎（GLM/Metaso/Baidu/Bing CN/SearXNG），返回标题、链接和摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词',
        },
        maxResults: {
          type: 'number',
          description: '最大返回结果数（默认 5）',
        },
      },
      required: ['query'],
    },
    requiresApproval: false,
    category: 'web',
  };

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!args.query || typeof args.query !== 'string') {
      errors.push('缺少必需参数: query');
    }
    if (args.maxResults !== undefined && typeof args.maxResults !== 'number') {
      errors.push('maxResults 必须是数字');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = args.query as string;
    const maxResults = (args.maxResults as number) ?? 5;
    const env = context.environment;

    // 解析 API Key 和配置（多环境变量回退，借鉴 Reasonix）
    const glmKey = env['GLM_WEB_SEARCH_API_KEY'] || env['ZAI_API_KEY'];
    const metasoKey = env['METASO_API_KEY'];
    const baiduKey = env['BAIDU_API_KEY'] || env['QIANFAN_API_KEY'];
    const tavilyKey = env['TAVILY_API_KEY'];
    const bingKey = env['BING_SEARCH_API_KEY'];
    const perplexityKey = env['PERPLEXITY_API_KEY'];
    const exaKey = env['EXA_API_KEY'];
    const braveKey = env['BRAVE_SEARCH_API_KEY'] || env['BRAVE_API_KEY'];
    const searxngEndpoint = env['SEARXNG_ENDPOINT'];

    // 引擎回退链（按中国可用性排序）
    const engines: Array<{ name: string; fn: () => Promise<WebSearchResult[]> }> = [];

    // === 中国直连引擎 ===
    if (glmKey) {
      engines.push({ name: 'glm', fn: () => this.searchGlm(query, maxResults, glmKey) });
    }
    if (metasoKey) {
      engines.push({ name: 'metaso', fn: () => this.searchMetaso(query, maxResults, metasoKey) });
    }
    if (baiduKey) {
      engines.push({ name: 'baidu', fn: () => this.searchBaidu(query, maxResults, baiduKey) });
    }
    // Bing CN HTML（无需 Key，中国可访问）
    engines.push({ name: 'bing-cn', fn: () => this.searchBingHtml(query, maxResults, 'cn') });
    // SearXNG（需自建实例）
    if (searxngEndpoint) {
      engines.push({ name: 'searxng', fn: () => this.searchSearxng(query, maxResults, searxngEndpoint) });
    }

    // === 需翻墙引擎 ===
    if (tavilyKey) {
      engines.push({ name: 'tavily', fn: () => this.searchTavily(query, maxResults, tavilyKey) });
    }
    if (bingKey) {
      engines.push({ name: 'bing-api', fn: () => this.searchBingApi(query, maxResults, bingKey) });
    }
    if (perplexityKey) {
      engines.push({ name: 'perplexity', fn: () => this.searchPerplexity(query, maxResults, perplexityKey) });
    }
    if (exaKey) {
      engines.push({ name: 'exa', fn: () => this.searchExa(query, maxResults, exaKey) });
    }
    if (braveKey) {
      engines.push({ name: 'brave', fn: () => this.searchBrave(query, maxResults, braveKey) });
    }
    // DuckDuckGo（最后手段）
    engines.push({ name: 'duckduckgo', fn: () => this.searchDuckDuckGo(query, maxResults) });

    const errors: string[] = [];

    for (const engine of engines) {
      try {
        logger.debug(`web_search 尝试引擎: ${engine.name}`, { query });
        const results = await engine.fn();

        if (results.length > 0) {
          const formatted = this.formatResults(results);
          return {
            success: true,
            output: formatted,
            durationMs: 0,
            metadata: { resultCount: results.length, engine: engine.name },
          };
        }

        logger.debug(`web_search 引擎 ${engine.name} 返回空结果`, { query });
        errors.push(`${engine.name}: 无结果`);
      } catch (err) {
        const msg = this.extractErrorMessage(err);
        logger.warn(`web_search 引擎 ${engine.name} 失败`, { query, error: msg });
        errors.push(`${engine.name}: ${msg}`);
      }
    }

    // 所有引擎都失败
    const hasApiKey = glmKey || metasoKey || baiduKey || tavilyKey || bingKey || perplexityKey || exaKey || braveKey;
    const hint = !hasApiKey
      ? '\n提示：当前未配置任何搜索 API Key。建议在设置 → 安全设置 → 网络搜索中配置智谱 GLM API Key（中国直连可用，推荐）或秘塔/百度 API Key。'
      : '';

    return {
      success: false,
      output: '',
      error: `搜索失败，所有引擎均不可用。详细错误:\n${errors.join('\n')}${hint}`,
      durationMs: 0,
      metadata: { engines: engines.map((e) => e.name) },
    };
  }

  /** 格式化搜索结果输出 */
  private formatResults(results: WebSearchResult[]): string {
    const parts: string[] = [];

    // AI 原生引擎的答案放在最前面
    const aiAnswer = results.find((r) => r.answer);
    if (aiAnswer?.answer) {
      parts.push(`answer: ${aiAnswer.answer}`);
      parts.push('');
      parts.push(`sources (${results.length}):`);
    } else {
      parts.push(`results (${results.length}):`);
    }

    results.forEach((r, i) => {
      parts.push(`${i + 1}. ${r.title}`);
      parts.push(`   ${r.url}`);
      if (r.snippet) parts.push(`   ${r.snippet}`);
      if (i < results.length - 1) parts.push('');
    });

    return parts.join('\n');
  }

  // ============================================================
  // 引擎1：智谱 GLM web_search API（中国直连，借鉴 PilotDeck）
  // ============================================================

  private async searchGlm(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const url = 'https://api.z.ai/api/paas/v4/web_search';
    await this.ensureSSRF(url);

    const body = JSON.stringify({
      search_engine: 'search-prime',
      search_query: query,
      count: Math.max(1, Math.min(maxResults, 50)),
      search_recency_filter: 'noLimit',
    });

    const json = await this.postJson(url, body, {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });

    try {
      const data = JSON.parse(json) as Record<string, unknown>;
      const items = this.extractArray(data, ['search_result', 'results', 'items', 'data']);
      if (!items) return [];

      return items.slice(0, maxResults).map((entry) => {
        const obj = entry as Record<string, unknown>;
        return {
          title: this.readString(obj, ['title', 'name']),
          url: this.readString(obj, ['url', 'link', 'href']),
          snippet: this.readString(obj, ['snippet', 'summary', 'content', 'text']),
        };
      }).filter((r) => r.title && r.url);
    } catch (e) {
      throw new Error(`GLM API 响应解析失败: ${this.extractErrorMessage(e)}`);
    }
  }

  // ============================================================
  // 引擎2：秘塔搜索 API（中国直连，借鉴 Reasonix）
  // ============================================================

  private async searchMetaso(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const url = 'https://metaso.cn/api/v1/search';
    await this.ensureSSRF(url);

    const body = JSON.stringify({
      q: query,
      scope: 'webpage',
      size: Math.max(1, Math.min(maxResults, 20)),
    });

    const json = await this.postJson(url, body, {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });

    try {
      const data = JSON.parse(json) as Record<string, unknown>;
      // 秘塔返回结果可能在 data / results / items 中
      const items = this.extractArray(data, ['data', 'results', 'items', 'search_result']);
      if (!items) return [];

      return items.slice(0, maxResults).map((entry) => {
        const obj = entry as Record<string, unknown>;
        return {
          title: this.readString(obj, ['title', 'name']),
          url: this.readString(obj, ['url', 'link', 'href']),
          snippet: this.readString(obj, ['snippet', 'summary', 'content', 'text', 'description']),
        };
      }).filter((r) => r.title && r.url);
    } catch (e) {
      throw new Error(`秘塔 API 响应解析失败: ${this.extractErrorMessage(e)}`);
    }
  }

  // ============================================================
  // 引擎3：百度千帆 AI 搜索 API（中国直连，借鉴 Reasonix）
  // ============================================================

  private async searchBaidu(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const url = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
    await this.ensureSSRF(url);

    const body = JSON.stringify({
      messages: [{ role: 'user', content: query }],
    });

    const json = await this.postJson(url, body, {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });

    try {
      const data = JSON.parse(json) as Record<string, unknown>;
      // 百度千帆返回 references 数组
      const items = this.extractArray(data, ['references', 'data', 'results', 'items']);
      if (!items) return [];

      return items.slice(0, maxResults).map((entry) => {
        const obj = entry as Record<string, unknown>;
        return {
          title: this.readString(obj, ['title', 'name']),
          url: this.readString(obj, ['url', 'link', 'href']),
          snippet: this.readString(obj, ['content', 'snippet', 'summary', 'text']),
        };
      }).filter((r) => r.title && r.url);
    } catch (e) {
      throw new Error(`百度 API 响应解析失败: ${this.extractErrorMessage(e)}`);
    }
  }

  // ============================================================
  // 引擎4：Bing HTML 页面抓取（无需 Key，CN/国际双端点）
  // ============================================================

  private async searchBingHtml(query: string, maxResults: number, region: 'cn' | 'intl'): Promise<WebSearchResult[]> {
    const encoded = encodeURIComponent(query);
    const host = region === 'cn' ? 'cn.bing.com' : 'www.bing.com';
    const url = `https://${host}/search?q=${encoded}&count=${Math.min(maxResults * 2, 30)}&setlang=en`;

    await this.ensureSSRF(url);

    // I19 修复：Bing 反爬虫机制严格，需要更真实的浏览器指纹和随机延迟
    // 1. 随机延迟 1-3 秒，避免频繁请求触发速率限制
    const delayMs = 1000 + Math.floor(Math.random() * 2000);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

    // 2. 使用更完整的浏览器 headers（sec-ch-ua / sec-fetch-* 等），模拟真实 Chrome 请求
    const html = await this.fetchUrl(url, {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'sec-ch-ua': '"Chromium";v="120", "Not_A Brand";v="8", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });

    return this.parseBingResults(html, maxResults);
  }

  /** 解析 Bing HTML 搜索结果页面 */
  private parseBingResults(html: string, maxResults: number): WebSearchResult[] {
    const results: WebSearchResult[] = [];

    // 策略1：标准 Bing 结果 <li class="b_algo">
    const blocks = html.split(/<li\s+class="b_algo"/i);
    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const block = blocks[i];
      const linkMatch = block.match(/<h2>\s*<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      let url = this.decodeHtmlEntities(linkMatch[1]);
      const title = this.stripHtml(linkMatch[2]);

      // 解码 Bing 点击跟踪 URL（国际版 /ck/a?u=... 格式）
      url = this.unwrapBingUrl(url);

      if (!url.startsWith('http')) continue;
      if (url.includes('bing.com/') || url.includes('msn.com/')) continue;

      let snippet = '';
      const snippetMatch =
        block.match(/<p\s+class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
        block.match(/<div\s+class="b_caption[^"]*">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ??
        block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (snippetMatch) {
        snippet = this.stripHtml(snippetMatch[1]);
      }

      if (title && url) {
        results.push({ title, url, snippet });
      }
    }

    if (results.length > 0) return results;

    // 策略2：通用 fallback——找所有 <h2><a href="http..."> 模式
    const genericMatches = html.matchAll(/<h2>\s*<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
    for (const match of genericMatches) {
      if (results.length >= maxResults) break;
      let url = this.decodeHtmlEntities(match[1]);
      url = this.unwrapBingUrl(url);
      const title = this.stripHtml(match[2]);
      if (url.includes('bing.com/') || url.includes('msn.com/')) continue;
      if (title && url) {
        results.push({ title, url, snippet: '' });
      }
    }

    return results;
  }

  /** 解码 Bing 点击跟踪 URL（借鉴 Reasonix 的 unwrapBingUrl） */
  private unwrapBingUrl(url: string): string {
    // 国际版 Bing 返回 /ck/a?u=a1<base64url> 格式的重定向 URL
    const ckMatch = url.match(/\/ck\/a.*[?&]u=a1([^&]+)/);
    if (ckMatch) {
      try {
        const b64 = ckMatch[1].replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        if (decoded.startsWith('http')) return decoded;
      } catch { /* 解码失败返回原 URL */ }
    }
    return url;
  }

  // ============================================================
  // 引擎5：SearXNG HTML 抓取（自托管实例，借鉴 Reasonix）
  // ============================================================

  private async searchSearxng(query: string, maxResults: number, endpoint: string): Promise<WebSearchResult[]> {
    const base = endpoint.replace(/\/+$/, '');
    const url = `${base}/search?format=html&q=${encodeURIComponent(query)}`;
    await this.ensureSSRF(url);

    const html = await this.fetchUrl(url, {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    });

    return this.parseSearxngResults(html, maxResults);
  }

  /** 解析 SearXNG HTML 搜索结果（借鉴 Reasonix） */
  private parseSearxngResults(html: string, maxResults: number): WebSearchResult[] {
    const results: WebSearchResult[] = [];

    // 策略1：标准 SearXNG 结果 <article class="result"> 或 <div class="result">
    const blocks = html.split(/<(?:article|div)\s+class="[^"]*result[^"]*"/i);
    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const block = blocks[i];
      const linkMatch = block.match(/<h3>\s*<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ??
        block.match(/<a\s+[^>]*href="([^"]+)"[^>]*class="[^"]*url[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const url = this.decodeHtmlEntities(linkMatch[1]);
      const title = this.stripHtml(linkMatch[2]);
      if (!url.startsWith('http')) continue;

      let snippet = '';
      const snippetMatch = block.match(/<p\s+class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
        block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (snippetMatch) snippet = this.stripHtml(snippetMatch[1]);

      if (title && url) results.push({ title, url, snippet });
    }

    if (results.length > 0) return results;

    // 策略2：通用 fallback——找所有 <h3><a href="http..."> 模式
    const genericMatches = html.matchAll(/<h3>\s*<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
    for (const match of genericMatches) {
      if (results.length >= maxResults) break;
      const url = this.decodeHtmlEntities(match[1]);
      const title = this.stripHtml(match[2]);
      if (title && url) results.push({ title, url, snippet: '' });
    }

    return results;
  }

  // ============================================================
  // 引擎6：Tavily API
  // ============================================================

  private async searchTavily(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const url = 'https://api.tavily.com/search';
    await this.ensureSSRF(url);

    const body = JSON.stringify({
      api_key: apiKey,
      query,
      max_results: Math.max(1, Math.min(maxResults, 10)),
      include_answer: true,
      search_depth: 'basic',
    });

    const json = await this.postJson(url, body, { 'Content-Type': 'application/json' });

    try {
      const data = JSON.parse(json) as {
        results?: Array<{ title: string; url: string; content: string }>;
        answer?: string;
      };
      const results: WebSearchResult[] = (data.results ?? []).slice(0, maxResults).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content ?? '',
      }));
      if (data.answer) {
        results.unshift({ title: 'AI Answer', url: '', snippet: '', answer: data.answer });
      }
      return results;
    } catch (e) {
      throw new Error(`Tavily API 响应解析失败: ${this.extractErrorMessage(e)}`);
    }
  }

  // ============================================================
  // 引擎7：Bing Web Search API（需要 API Key）
  // ============================================================

  private async searchBingApi(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const encoded = encodeURIComponent(query);
    const count = Math.min(maxResults, 50);
    const url = `https://api.bing.microsoft.com/v7.0/search?q=${encoded}&count=${count}&mkt=en-US`;
    await this.ensureSSRF(url);

    const json = await this.fetchUrl(url, {
      'Ocp-Apim-Subscription-Key': apiKey,
      Accept: 'application/json',
    });

    try {
      const data = JSON.parse(json) as {
        webPages?: { value: Array<{ name: string; url: string; snippet: string }> };
      };
      return (data.webPages?.value ?? []).slice(0, maxResults).map((item) => ({
        title: item.name,
        url: item.url,
        snippet: item.snippet ?? '',
      }));
    } catch (e) {
      throw new Error(`Bing API 响应解析失败: ${this.extractErrorMessage(e)}`);
    }
  }

  // ============================================================
  // 引擎8：Perplexity API（AI 原生搜索，借鉴 Reasonix）
  // ============================================================

  private async searchPerplexity(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const url = 'https://api.perplexity.ai/chat/completions';
    await this.ensureSSRF(url);

    const body = JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: query }],
    });

    const json = await this.postJson(url, body, {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    });

    try {
      const data = JSON.parse(json) as {
        choices?: Array<{ message?: { content?: string } }>;
        citations?: string[];
      };
      const answer = data.choices?.[0]?.message?.content ?? '';
      const citations = data.citations ?? [];

      const results: WebSearchResult[] = [];
      if (answer) {
        results.push({ title: 'AI Answer', url: '', snippet: '', answer });
      }
      citations.slice(0, maxResults).forEach((citeUrl, i) => {
        results.push({
          title: `Source ${i + 1}`,
          url: citeUrl,
          snippet: '',
        });
      });
      return results;
    } catch (e) {
      throw new Error(`Perplexity API 响应解析失败: ${this.extractErrorMessage(e)}`);
    }
  }

  // ============================================================
  // 引擎9：Exa API（AI 原生搜索，借鉴 Reasonix）
  // ============================================================

  private async searchExa(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const url = 'https://api.exa.ai/answer';
    await this.ensureSSRF(url);

    const body = JSON.stringify({ query, text: true, numResults: maxResults });

    const json = await this.postJson(url, body, {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    });

    try {
      const data = JSON.parse(json) as {
        answer?: string;
        citations?: Array<{ title?: string; url: string; text?: string }>;
      };
      const results: WebSearchResult[] = [];
      if (data.answer) {
        results.push({ title: 'AI Answer', url: '', snippet: '', answer: data.answer });
      }
      (data.citations ?? []).forEach((cite) => {
        results.push({
          title: cite.title ?? 'Source',
          url: cite.url,
          snippet: cite.text ?? '',
        });
      });
      return results;
    } catch (e) {
      throw new Error(`Exa API 响应解析失败: ${this.extractErrorMessage(e)}`);
    }
  }

  // ============================================================
  // 引擎10：Brave Search API（借鉴 Reasonix）
  // ============================================================

  private async searchBrave(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const encoded = encodeURIComponent(query);
    const url = `https://api.search.brave.com/res/v1/web_search?q=${encoded}&count=${Math.min(maxResults, 20)}`;
    await this.ensureSSRF(url);

    const json = await this.fetchUrl(url, {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    });

    try {
      const data = JSON.parse(json) as {
        web?: { results?: Array<{ title: string; url: string; description?: string }> };
      };
      return (data.web?.results ?? []).slice(0, maxResults).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.description ?? '',
      }));
    } catch (e) {
      throw new Error(`Brave API 响应解析失败: ${this.extractErrorMessage(e)}`);
    }
  }

  // ============================================================
  // 引擎11：DuckDuckGo HTML（最后手段）
  // ============================================================

  private async searchDuckDuckGo(query: string, maxResults: number): Promise<WebSearchResult[]> {
    const encoded = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
    await this.ensureSSRF(url);

    const html = await this.fetchUrl(url);
    return this.parseDuckDuckGoResults(html, maxResults);
  }

  private parseDuckDuckGoResults(html: string, maxResults: number): WebSearchResult[] {
    const results: WebSearchResult[] = [];
    const blocks = html.split('<div class="result results_links results_links_deep web-result"');

    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const block = blocks[i];
      const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*>(.*?)<\/a>/);
      const urlMatch = block.match(/<a[^>]+class="result__a"[^>]+href="(.*?)"/);
      const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/);

      if (titleMatch && urlMatch) {
        results.push({
          title: this.stripHtml(titleMatch[1]),
          url: this.decodeHtmlEntities(urlMatch[1]),
          snippet: snippetMatch ? this.stripHtml(snippetMatch[1]) : '',
        });
      }
    }
    return results;
  }

  // ============================================================
  // HTTP 工具方法
  // ============================================================

  /** SSRF 校验快捷方法 */
  private async ensureSSRF(url: string): Promise<void> {
    const ssrfResult = await checkSSRF(url);
    if (!ssrfResult.allowed) {
      throw new Error(`SSRF 防护拦截: ${ssrfResult.reason}`);
    }
  }

  /** POST JSON 请求 */
  private postJson(
    url: string,
    body: string,
    headers: Record<string, string>,
    redirectCount = 0,
    originalDomain?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // I3 修复：强制 HTTPS，拒绝 HTTP 请求（除非是 localhost）
      if (parsed.protocol === 'http:' && !this.isLocalhostHost(hostname)) {
        reject(new Error(`仅允许 HTTPS 请求（postJson 拒绝 HTTP）: ${url}`));
        return;
      }

      // C3 修复：记录原始域名，用于重定向域检查
      const domain = originalDomain ?? hostname;

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = https.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // C3 修复：限制最大重定向次数为 3
          if (redirectCount >= 3) {
            reject(new Error(`超过最大重定向次数 (3): ${url}`));
            return;
          }

          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString();

          // C3 修复：每次重定向检查目标 URL 的域（同域才跟随）
          try {
            const redirectParsed = new URL(redirectUrl);
            const redirectDomain = redirectParsed.hostname.toLowerCase();
            if (redirectDomain !== domain) {
              reject(new Error(`重定向到不同域名被拒绝: ${redirectDomain}（原域名: ${domain}）`));
              return;
            }
          } catch {
            reject(new Error(`无效的重定向 URL: ${redirectUrl}`));
            return;
          }

          this.postJson(redirectUrl, body, headers, redirectCount + 1, domain).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
          res.on('end', () => {
            reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`));
          });
          return;
        }

        let data = '';
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) { req.destroy(); return; }
          data += chunk.toString('utf-8');
        });
        res.on('end', () => resolve(data));
        res.on('aborted', () => resolve(data));
      });

      req.on('error', (err: Error & { code?: string }) => {
        reject(new Error(err.message || err.code || '未知网络错误'));
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`请求超时 (${REQUEST_TIMEOUT_MS}ms)`));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * I3 修复：判断 hostname 是否为 localhost（HTTP 豁免）
   */
  private isLocalhostHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
  }

  /** GET 请求（带重定向处理） */
  private fetchUrl(url: string, extraHeaders?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https:') ? https : http;

      const req = protocol.get(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: extraHeaders?.['Accept'] ?? 'text/html,application/xhtml+xml',
          'Accept-Language': extraHeaders?.['Accept-Language'] ?? 'zh-CN,zh;q=0.9,en;q=0.8',
          ...extraHeaders,
        },
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString();

          checkSSRF(redirectUrl)
            .then((ssrfResult) => {
              if (!ssrfResult.allowed) {
                reject(new Error(`重定向目标被 SSRF 防护拦截: ${ssrfResult.reason}`));
                return;
              }
              this.fetchUrl(redirectUrl, extraHeaders).then(resolve).catch(reject);
            })
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim()));
          return;
        }

        let data = '';
        let totalBytes = 0;
        let truncated = false;

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            if (!truncated) {
              truncated = true;
              const remaining = Math.max(0, MAX_RESPONSE_BYTES - (totalBytes - chunk.length));
              if (remaining > 0) data += chunk.toString('utf-8', 0, remaining);
            }
            req.destroy();
            return;
          }
          data += chunk.toString('utf-8');
        });

        res.on('end', () => resolve(data));
        res.on('aborted', () => resolve(data));
      });

      req.on('error', (err: Error & { code?: string }) => {
        reject(new Error(err.message || err.code || '未知网络错误'));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`请求超时 (${REQUEST_TIMEOUT_MS}ms)`));
      });
    });
  }

  // ============================================================
  // JSON / HTML 工具方法
  // ============================================================

  private readString(obj: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const val = obj[key];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return '';
  }

  private extractArray(data: Record<string, unknown>, keys: string[]): unknown[] | null {
    for (const key of keys) {
      const val = data[key];
      if (Array.isArray(val) && val.length > 0) return val;
    }
    return null;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  private extractErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message || err.name || '未知错误';
    if (typeof err === 'string') return err || '未知错误';
    if (err && typeof err === 'object' && 'message' in err) {
      const msg = (err as { message: unknown }).message;
      if (typeof msg === 'string' && msg) return msg;
    }
    if (err && typeof err === 'object' && 'code' in err) {
      const code = (err as { code: unknown }).code;
      if (typeof code === 'string' && code) return code;
    }
    return String(err) || '未知错误';
  }
}
