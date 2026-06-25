// tests/skills/registry-client-http.test.ts
// HttpRegistryClient 单元测试
// 覆盖：listSkills 解析、search URL 编码、错误信息、Authorization 头、URL 规范化

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpRegistryClient, type RegistryItem } from '../../src/skills/registry-client.js';

// ============================================================
// Mock 工厂
// ============================================================

/** 构造一个成功的 fetch Response mock */
function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    arrayBuffer: async () => {
      const str = JSON.stringify(body);
      return new TextEncoder().encode(str).buffer;
    },
  } as unknown as Response;
}

/** 构造一个失败的 fetch Response mock */
function makeErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
  } as unknown as Response;
}

/** 构造示例 RegistryItem */
function makeItem(name: string): RegistryItem {
  return {
    name,
    version: '1.0.0',
    type: 'skill',
    description: `${name} 描述`,
    author: 'tester',
    downloadUrl: `https://example.com/${name}`,
    size: 1024,
    publishedAt: Date.now(),
  };
}

// ============================================================
// 测试
// ============================================================

describe('HttpRegistryClient', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 1. listSkills 正确解析返回的 JSON 数组
  it('listSkills 正确解析返回的 JSON 数组', async () => {
    const items = [makeItem('skill-a'), makeItem('skill-b')];
    fetchMock.mockResolvedValue(makeOkResponse(items));

    const client = new HttpRegistryClient('https://registry.example.com');
    const result = await client.listSkills();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('skill-a');
    expect(result[1].name).toBe('skill-b');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://registry.example.com/api/skills');
  });

  // 2. search 对 query 做 URL 编码
  it('search 对 query 做 URL 编码', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    const client = new HttpRegistryClient('https://registry.example.com');
    await client.search('hello world & foo=bar');

    const url = fetchMock.mock.calls[0][0] as string;
    // 空格、&、= 都应被编码
    expect(url).toContain('/api/search?q=');
    expect(url).not.toContain('hello world');
    expect(url).toContain('hello%20world');
    // & 和 = 在 query value 中应被编码
    expect(url).toContain('%26');
    expect(url).toContain('%3D');
  });

  // 3. 网络错误时抛出可读的错误信息（含状态码）
  it('网络错误时抛出含状态码的可读错误信息', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(503, 'Service Unavailable'));

    const client = new HttpRegistryClient('https://registry.example.com');
    await expect(client.listSkills()).rejects.toThrow(/503/);
    await expect(client.listSkills()).rejects.toThrow(/Service Unavailable/);
  });

  // 4. token 存在时添加 Authorization 头
  it('token 存在时添加 Authorization 头', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    const client = new HttpRegistryClient('https://registry.example.com', 'my-secret-token');
    await client.listSkills();

    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-secret-token');
    expect(headers['Accept']).toBe('application/json');
  });

  // 4b. 无 token 时不添加 Authorization 头
  it('无 token 时不添加 Authorization 头', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    const client = new HttpRegistryClient('https://registry.example.com');
    await client.listSkills();

    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  // 5. registryUrl 规范化（补全协议、去尾斜杠）
  it('registryUrl 规范化：补全 https 协议前缀', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    // 不带协议 → 补全 https://
    const client = new HttpRegistryClient('registry.example.com');
    await client.listSkills();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://registry.example.com/api/skills');
  });

  it('registryUrl 规范化：去除尾部斜杠', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    // 带尾斜杠 → 去除
    const client = new HttpRegistryClient('https://registry.example.com/');
    await client.listSkills();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://registry.example.com/api/skills');
  });

  it('registryUrl 规范化：补全协议 + 去尾斜杠 + 多斜杠', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    const client = new HttpRegistryClient('registry.example.com///');
    await client.listSkills();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://registry.example.com/api/skills');
  });

  // 额外：http:// 协议保留（不强制升级为 https）
  it('registryUrl 规范化：保留 http:// 协议', async () => {
    fetchMock.mockResolvedValue(makeOkResponse([]));

    const client = new HttpRegistryClient('http://localhost:8080/');
    await client.listSkills();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:8080/api/skills');
  });
});
