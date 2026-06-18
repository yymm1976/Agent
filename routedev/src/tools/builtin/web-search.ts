// src/tools/builtin/web-search.ts
// 网页搜索工具（使用 DuckDuckGo HTML）
// 权限：confirm

import https from 'node:https';
import type { ITool, ToolDefinition, ToolResult, ToolExecutionContext } from '../types.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0';

export class WebSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'web_search',
    description: '使用 DuckDuckGo 搜索网页。返回搜索结果的标题和链接。',
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
    requiresApproval: true,
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
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = encodeURIComponent(args.query as string);
    const maxResults = (args.maxResults as number) ?? 5;
    const url = `https://html.duckduckgo.com/html/?q=${query}`;

    try {
      const html = await this.fetchUrl(url);
      const results = this.parseResults(html, maxResults);

      if (results.length === 0) {
        return {
          success: true,
          output: '未找到搜索结果',
          durationMs: 0,
        };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
      ).join('\n\n');

      return {
        success: true,
        output: formatted,
        durationMs: 0,
        metadata: { resultCount: results.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: '',
        error: `搜索失败: ${msg}`,
        durationMs: 0,
      };
    }
  }

  private fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString('utf-8'); });
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
    });
  }

  private parseResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // 简单正则匹配 DuckDuckGo HTML 结果
    const resultBlocks = html.split('<div class="result results_links results_links_deep web-result"');

    for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
      const block = resultBlocks[i];

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

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
}
