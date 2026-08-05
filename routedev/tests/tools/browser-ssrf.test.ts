import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '../../src/tools/types.js';

const mockCheckSSRF = vi.hoisted(() => vi.fn());

vi.mock('../../src/tools/security-enhanced.js', () => ({
  checkSSRF: mockCheckSSRF,
}));

import { BrowserTool } from '../../src/tools/builtin/browser.js';

const context: ToolExecutionContext = {
  workingDirectory: '/test',
  allowedDirectories: ['/test'],
  environment: {},
  timeoutMs: 30000,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockCheckSSRF.mockReset();
});

describe('BrowserTool redirect SSRF boundary', () => {
  it('rechecks every redirect and blocks a public URL redirecting to loopback', async () => {
    mockCheckSSRF.mockImplementation(async (url: string) => ({
      allowed: !url.includes('127.0.0.1'),
      reason: url.includes('127.0.0.1') ? 'loopback address' : undefined,
    }));
    const fetchMock = vi.fn(async () => new Response('', {
      status: 302,
      headers: { location: 'http://127.0.0.1:8080/internal' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new BrowserTool().execute({
      action: 'fetch',
      url: 'https://public.example/start',
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('SSRF redirect blocked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockCheckSSRF).toHaveBeenCalledWith('http://127.0.0.1:8080/internal');
  });

  it('follows a bounded public redirect chain and reports the final URL', async () => {
    mockCheckSSRF.mockResolvedValue({ allowed: true });
    const responses = [
      new Response('', { status: 302, headers: { location: 'https://public.example/step-1' } }),
      new Response('', { status: 302, headers: { location: 'https://public.example/final' } }),
      new Response('final body', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);

    const result = await new BrowserTool().execute({
      action: 'fetch',
      url: 'https://public.example/start',
    }, context);

    expect(result.success).toBe(true);
    expect(result.output).toContain('final body');
    expect(result.metadata?.url).toBe('https://public.example/final');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
