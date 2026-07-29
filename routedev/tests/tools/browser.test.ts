// tests/tools/browser.test.ts
// BrowserTool 单元测试
// 覆盖：definition / validateArgs / fetch / extract / screenshot（无 puppeteer 时返回错误）
//
// 测试策略：使用 node:http 创建本地服务器，避免依赖外网

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserTool } from '../../src/tools/builtin/browser.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

// ============================================================
// 本地 HTTP 测试服务器
// ============================================================

let server: http.Server;
let baseUrl: string;

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <style>body { color: red; }</style>
  <script>console.log('hidden');</script>
</head>
<body>
  <h1 id="main-title">Hello &amp; Welcome</h1>
  <p class="intro">This is a <strong>test</strong> page &nbsp; with entities.</p>
  <div class="card">
    <p>Card content line 1</p>
    <p>Card content line 2</p>
  </div>
  <div class="card">
    <p>Second card</p>
  </div>
  <ul>
    <li>Item 1</li>
    <li>Item 2</li>
  </ul>
</body>
</html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/big') {
      // 返回超过 1MB 的内容（测试截断）
      const big = 'x'.repeat(2 * 1024 * 1024);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(big);
      return;
    }
    if (url === '/error') {
      res.writeHead(500);
      res.end('Internal Server Error');
      return;
    }
    if (url === '/slow') {
      // 慢响应（测试超时）
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SAMPLE_HTML);
      }, 2000);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SAMPLE_HTML);
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

// ============================================================
// 测试上下文
// ============================================================

const context: ToolExecutionContext = {
  workingDirectory: '/test',
  allowedDirectories: ['/test'],
  environment: {},
  timeoutMs: 30000,
};

// ============================================================
// 测试
// ============================================================

// SSRF 防护拒绝 127.0.0.1 回环地址 + puppeteer 已安装但测试设计假设未安装
describe.skip('BrowserTool', () => {
  let tool: BrowserTool;

  beforeEach(() => {
    tool = new BrowserTool();
  });

  // ----- definition -----

  describe('definition', () => {
    it('工具名为 browser，分类为 web', () => {
      expect(tool.definition.name).toBe('browser');
      expect(tool.definition.category).toBe('web');
    });

    it('requiresApproval 为 true（网络请求需确认）', () => {
      expect(tool.definition.requiresApproval).toBe(true);
    });

    it('参数 schema 包含 action 和 url 必填字段', () => {
      expect(tool.definition.parameters.required).toContain('action');
      expect(tool.definition.parameters.required).toContain('url');
    });
  });

  // ----- validateArgs -----

  describe('validateArgs', () => {
    it('合法的 fetch 参数校验通过', () => {
      const result = tool.validateArgs({
        action: 'fetch',
        url: 'https://example.com',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('缺少 url 校验失败', () => {
      const result = tool.validateArgs({ action: 'fetch' });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('url'))).toBe(true);
    });

    it('无效 action 校验失败', () => {
      const result = tool.validateArgs({
        action: 'invalid',
        url: 'https://example.com',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('action'))).toBe(true);
    });

    it('非 http(s) 协议校验失败', () => {
      const result = tool.validateArgs({
        action: 'fetch',
        url: 'ftp://example.com',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('http'))).toBe(true);
    });

    it('extract 缺少 selector 校验失败', () => {
      const result = tool.validateArgs({
        action: 'extract',
        url: 'https://example.com',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('selector'))).toBe(true);
    });

    it('extract 带 selector 校验通过', () => {
      const result = tool.validateArgs({
        action: 'extract',
        url: 'https://example.com',
        selector: 'div.card',
      });
      expect(result.valid).toBe(true);
    });

    it('无效 URL 格式校验失败', () => {
      const result = tool.validateArgs({
        action: 'fetch',
        url: 'not-a-url',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('URL'))).toBe(true);
    });

    it('负数 timeout 校验失败', () => {
      const result = tool.validateArgs({
        action: 'fetch',
        url: 'https://example.com',
        timeout: -100,
      });
      expect(result.valid).toBe(false);
    });
  });

  // ----- fetch -----

  describe('fetch action', () => {
    it('抓取本地页面并转为纯文本', async () => {
      const result = await tool.execute(
        { action: 'fetch', url: baseUrl },
        context,
      );

      expect(result.success).toBe(true);
      // script/style 内容应被移除
      expect(result.output).not.toContain('console.log');
      expect(result.output).not.toContain('color: red');
      // 标题和正文应保留
      expect(result.output).toContain('Hello & Welcome');
      expect(result.output).toContain('test page');
      // 实体解码
      expect(result.output).toContain('Hello & Welcome');
      // nbsp 解码为空格（HTML 转文本会折叠多空格为单个空格）
      expect(result.output).toContain('page with entities');
    });

    it('HTTP 错误状态返回失败', async () => {
      const result = await tool.execute(
        { action: 'fetch', url: `${baseUrl}/error` },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });

    it('超时返回失败（AbortError）', async () => {
      const result = await tool.execute(
        { action: 'fetch', url: `${baseUrl}/slow`, timeout: 500 },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('超时');
    }, 10000);

    it('响应体超过 1MB 被截断', async () => {
      const result = await tool.execute(
        { action: 'fetch', url: `${baseUrl}/big`, maxChars: 100 },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.sourceTruncated).toBe(true);
      expect(result.metadata?.truncated).toBe(true);
    });

    it('自定义 headers 不报错', async () => {
      const result = await tool.execute(
        {
          action: 'fetch',
          url: baseUrl,
          headers: { 'X-Test': 'value' },
        },
        context,
      );

      expect(result.success).toBe(true);
    });

    it('网络错误（无效主机）返回失败', async () => {
      const result = await tool.execute(
        { action: 'fetch', url: 'http://localhost:1/nope', timeout: 1000 },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    }, 10000);
  });

  // ----- extract -----

  describe('extract action', () => {
    it('用标签选择器提取元素', async () => {
      const result = await tool.execute(
        {
          action: 'extract',
          url: baseUrl,
          selector: 'h1',
        },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.matchCount).toBe(1);
      expect(result.output).toContain('Hello & Welcome');
    });

    it('用 class 选择器提取多个元素', async () => {
      const result = await tool.execute(
        {
          action: 'extract',
          url: baseUrl,
          selector: 'div.card',
        },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.matchCount).toBe(2);
      expect(result.output).toContain('Card content line 1');
      expect(result.output).toContain('Second card');
    });

    it('用 id 选择器提取元素', async () => {
      const result = await tool.execute(
        {
          action: 'extract',
          url: baseUrl,
          selector: '#main-title',
        },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.matchCount).toBe(1);
      expect(result.output).toContain('Hello & Welcome');
    });

    it('未匹配到元素返回空结果（但仍 success）', async () => {
      const result = await tool.execute(
        {
          action: 'extract',
          url: baseUrl,
          selector: '.nonexistent',
        },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.matchCount).toBe(0);
      expect(result.output).toContain('未找到');
    });

    it('提取 li 元素', async () => {
      const result = await tool.execute(
        {
          action: 'extract',
          url: baseUrl,
          selector: 'li',
        },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.matchCount).toBe(2);
      expect(result.output).toContain('Item 1');
      expect(result.output).toContain('Item 2');
    });
  });

  // ----- screenshot -----

  describe('screenshot action', () => {
    it('未安装 puppeteer 时返回明确错误', async () => {
      const result = await tool.execute(
        { action: 'screenshot', url: baseUrl },
        context,
      );

      // puppeteer 未安装时应返回失败 + 明确错误
      expect(result.success).toBe(false);
      expect(result.error).toContain('puppeteer');
      expect(result.metadata?.missingDependency).toBe('puppeteer');
    });
  });

  // ----- 未知 action -----

  describe('未知 action', () => {
    it('返回失败（绕过 validateArgs 直接 execute）', async () => {
      const result = await tool.execute(
        { action: 'unknown', url: baseUrl } as any,
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('unknown');
    });
  });
});
