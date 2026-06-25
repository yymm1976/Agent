// tests/agent/code-map-context.test.ts
// Phase 39 Task 1：CodeMapContextMiddleware 测试
// 覆盖：formatSummary / findRelatedFiles / formatRelatedFiles / handler 注入

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodeMapContextMiddleware } from '../../src/agent/middleware/code-map-context.js';
import type { MiddlewareContext } from '../../src/agent/middleware.js';
import type { RepoMapFileEntry } from '../../src/tools/repo-map.js';

let tempDir: string;

async function writeFile(relPath: string, content: string): Promise<void> {
  const fullPath = path.join(tempDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-map-context-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function makeEntry(partial: Partial<RepoMapFileEntry>): RepoMapFileEntry {
  return {
    path: partial.path ?? 'unknown.ts',
    exports: partial.exports ?? [],
    signatures: partial.signatures ?? [],
    dependencies: partial.dependencies,
    language: partial.language ?? 'typescript',
  };
}

describe('CodeMapContextMiddleware', () => {
  describe('formatSummary', () => {
    it('输出 <project_structure> XML 段落，每个文件一行路径 + 签名', () => {
      const mw = new CodeMapContextMiddleware(tempDir);
      const entries: RepoMapFileEntry[] = [
        makeEntry({
          path: 'src/index.ts',
          exports: ['main'],
          signatures: ['export function main() {}'],
        }),
        makeEntry({
          path: 'src/utils.ts',
          exports: ['helper'],
          signatures: ['export function helper() {}'],
        }),
      ];

      const summary = mw.formatSummary(entries);

      expect(summary).toContain('<project_structure>');
      expect(summary).toContain('</project_structure>');
      expect(summary).toContain('src/index.ts');
      expect(summary).toContain('src/utils.ts');
      expect(summary).toContain('export function main() {}');
      expect(summary).toContain('export function helper() {}');
    });

    it('空条目列表仍输出空 XML 段落', () => {
      const mw = new CodeMapContextMiddleware(tempDir);
      const summary = mw.formatSummary([]);
      expect(summary).toContain('<project_structure>');
      expect(summary).toContain('</project_structure>');
    });
  });

  describe('findRelatedFiles', () => {
    it('关键词匹配：按匹配数排序，取前 10', () => {
      const mw = new CodeMapContextMiddleware(tempDir);
      const entries: RepoMapFileEntry[] = [
        makeEntry({
          path: 'src/auth/login.ts',
          exports: ['login', 'logout'],
          signatures: ['export function login() {}'],
        }),
        makeEntry({
          path: 'src/auth/session.ts',
          exports: ['createSession'],
          signatures: ['export function createSession() {}'],
        }),
        makeEntry({
          path: 'src/utils/math.ts',
          exports: ['add', 'subtract'],
          signatures: ['export function add() {}'],
        }),
      ];

      // 查询 "login" 应匹配到 login.ts
      const related = mw.findRelatedFiles('login', entries);
      expect(related.length).toBeGreaterThan(0);
      expect(related[0].path).toBe('src/auth/login.ts');

      // 查询 "auth" 应匹配到 auth 下的两个文件
      const authRelated = mw.findRelatedFiles('auth', entries);
      expect(authRelated.length).toBe(2);
      expect(authRelated.some(e => e.path === 'src/auth/login.ts')).toBe(true);
      expect(authRelated.some(e => e.path === 'src/auth/session.ts')).toBe(true);
    });

    it('空查询返回空数组', () => {
      const mw = new CodeMapContextMiddleware(tempDir);
      const entries: RepoMapFileEntry[] = [
        makeEntry({ path: 'src/a.ts', exports: ['a'] }),
      ];
      expect(mw.findRelatedFiles('', entries)).toEqual([]);
      expect(mw.findRelatedFiles('   ', entries)).toEqual([]);
    });

    it('无匹配时返回空数组', () => {
      const mw = new CodeMapContextMiddleware(tempDir);
      const entries: RepoMapFileEntry[] = [
        makeEntry({ path: 'src/a.ts', exports: ['foo'] }),
      ];
      const related = mw.findRelatedFiles('nonexistent', entries);
      expect(related).toEqual([]);
    });

    it('停用词被过滤，不作为匹配关键词', () => {
      const mw = new CodeMapContextMiddleware(tempDir);
      const entries: RepoMapFileEntry[] = [
        makeEntry({ path: 'src/the.ts', exports: ['the'] }),
        makeEntry({ path: 'src/real.ts', exports: ['realFunction'] }),
      ];
      // "the" 是停用词，应被过滤；"realFunction" 是有效关键词
      const related = mw.findRelatedFiles('the realFunction', entries);
      expect(related.some(e => e.path === 'src/real.ts')).toBe(true);
    });
  });

  describe('formatRelatedFiles', () => {
    it('输出 <related_files> XML 段落，包含路径和导出', () => {
      const mw = new CodeMapContextMiddleware(tempDir);
      const entries: RepoMapFileEntry[] = [
        makeEntry({
          path: 'src/auth/login.ts',
          exports: ['login', 'logout'],
          signatures: ['export function login() {}'],
        }),
      ];

      const formatted = mw.formatRelatedFiles(entries);

      expect(formatted).toContain('<related_files>');
      expect(formatted).toContain('</related_files>');
      expect(formatted).toContain('src/auth/login.ts');
      expect(formatted).toContain('exports: login, logout');
      expect(formatted).toContain('signature:');
    });

    it('空列表输出空 XML 段落', () => {
      const mw = new CodeMapContextMiddleware(tempDir);
      const formatted = mw.formatRelatedFiles([]);
      expect(formatted).toContain('<related_files>');
      expect(formatted).toContain('</related_files>');
    });
  });

  describe('getHandler - 中间件 handler', () => {
    it('将项目结构注入 systemPrompt', async () => {
      // 准备临时项目
      await writeFile('src/index.ts', 'export function main() {}');
      await writeFile('src/utils.ts', 'export function helper() {}');

      const mw = new CodeMapContextMiddleware(tempDir);
      const handler = mw.getHandler();

      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: '你是一个 AI 助手。',
        metadata: { userQuery: 'main function' },
      };

      await handler(ctx, async () => {});

      expect(ctx.systemPrompt).toContain('你是一个 AI 助手。');
      expect(ctx.systemPrompt).toContain('<project_structure>');
      expect(ctx.systemPrompt).toContain('src/index.ts');
      expect(ctx.systemPrompt).toContain('src/utils.ts');
      expect(ctx.metadata.codeMapInjected).toBe(true);
      expect(ctx.metadata.codeMapFileCount).toBeGreaterThan(0);
    });

    it('用户查询匹配时注入 <related_files>', async () => {
      await writeFile('src/auth/login.ts', 'export function login() {}');
      await writeFile('src/utils/math.ts', 'export function add() {}');

      const mw = new CodeMapContextMiddleware(tempDir);
      const handler = mw.getHandler();

      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: '你是一个 AI 助手。',
        metadata: { userQuery: 'login' },
      };

      await handler(ctx, async () => {});

      expect(ctx.systemPrompt).toContain('<related_files>');
      expect(ctx.systemPrompt).toContain('src/auth/login.ts');
      expect(ctx.metadata.codeMapRelatedCount).toBeGreaterThan(0);
    });

    it('空 systemPrompt 时也能注入', async () => {
      await writeFile('src/index.ts', 'export function main() {}');

      const mw = new CodeMapContextMiddleware(tempDir);
      const handler = mw.getHandler();

      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: undefined,
        metadata: {},
      };

      await handler(ctx, async () => {});

      expect(ctx.systemPrompt).toBeDefined();
      expect(ctx.systemPrompt).toContain('<project_structure>');
    });

    it('调用 next() 不阻断管线', async () => {
      await writeFile('src/index.ts', 'export function main() {}');

      const mw = new CodeMapContextMiddleware(tempDir);
      const handler = mw.getHandler();

      let nextCalled = false;
      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: 'test',
        metadata: {},
      };

      await handler(ctx, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });

    it('扫描失败时不阻断 next()', async () => {
      // 使用一个不存在的目录
      const mw = new CodeMapContextMiddleware(path.join(tempDir, 'nonexistent'));
      const handler = mw.getHandler();

      let nextCalled = false;
      const ctx: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: 'test',
        metadata: {},
      };

      await handler(ctx, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });
  });

  describe('invalidateCache', () => {
    it('重置缓存后下次调用重新扫描', async () => {
      await writeFile('src/index.ts', 'export function v1() {}');

      const mw = new CodeMapContextMiddleware(tempDir);
      const handler = mw.getHandler();

      const ctx1: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: '',
        metadata: {},
      };
      await handler(ctx1, async () => {});
      expect(ctx1.systemPrompt).toContain('v1');

      // 修改文件
      await new Promise(resolve => setTimeout(resolve, 50));
      await writeFile('src/index.ts', 'export function v2() {}');

      // 重置缓存
      mw.invalidateCache();

      const ctx2: MiddlewareContext = {
        phase: 'onSystemPrompt',
        systemPrompt: '',
        metadata: {},
      };
      await handler(ctx2, async () => {});
      expect(ctx2.systemPrompt).toContain('v2');
    });
  });
});
