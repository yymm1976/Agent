// tests/phase37/mcp-marketplace.test.ts
// MCP 插件市场：目录搜索 + 安装逻辑 + 配置写入测试

import { describe, it, expect } from 'vitest';
import { listCatalog, searchCatalog, getCatalogEntry, getCategories } from '../../desktop/main/mcp-catalog.js';

describe('Phase 37 MCP 插件市场', () => {
  // ============================================================
  // 目录浏览
  // ============================================================
  it('1. listCatalog 返回全部目录（按流行度降序）', () => {
    const result = listCatalog();
    expect(result.total).toBeGreaterThan(15);
    expect(result.entries.length).toBe(result.total);
    // 验证按流行度降序
    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i - 1].popularity).toBeGreaterThanOrEqual(result.entries[i].popularity);
    }
  });

  it('2. listCatalog 按分类过滤', () => {
    const fsResult = listCatalog('filesystem');
    expect(fsResult.entries.every((e) => e.category === 'filesystem')).toBe(true);
    expect(fsResult.total).toBeGreaterThan(0);

    const dbResult = listCatalog('database');
    expect(dbResult.entries.every((e) => e.category === 'database')).toBe(true);
    expect(dbResult.total).toBeGreaterThan(0);
  });

  // ============================================================
  // 搜索
  // ============================================================
  it('3. searchCatalog 按关键词搜索（匹配 id/displayName/description）', () => {
    const result = searchCatalog('github');
    expect(result.entries.some((e) => e.id === 'github')).toBe(true);

    const result2 = searchCatalog('browser');
    expect(result2.entries.some((e) => e.category === 'browser')).toBe(true);
  });

  it('4. searchCatalog 空关键词返回全部', () => {
    const result = searchCatalog('');
    expect(result.total).toBeGreaterThan(15);
  });

  it('5. searchCatalog 无匹配时返回空', () => {
    const result = searchCatalog('不存在的服务器xyz');
    expect(result.total).toBe(0);
    expect(result.entries).toHaveLength(0);
  });

  // ============================================================
  // 目录条目结构
  // ============================================================
  it('6. getCatalogEntry 按 id 获取条目', () => {
    const entry = getCatalogEntry('filesystem');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('filesystem');
    expect(entry!.displayName).toBe('Filesystem');
    expect(entry!.transport).toBe('stdio');
    expect(entry!.command).toBe('npx');
    expect(entry!.args).toContain('-y');
    expect(entry!.homepage).toMatch(/^https?:\/\//);
  });

  it('7. 每个目录条目都有必填字段', () => {
    const all = listCatalog().entries;
    for (const entry of all) {
      expect(entry.id).toBeTruthy();
      expect(entry.displayName).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(entry.transport).toMatch(/^(stdio|http)$/);
      expect(entry.homepage).toMatch(/^https?:\/\//);
      expect(typeof entry.popularity).toBe('number');
      expect(typeof entry.requiresApiKey).toBe('boolean');

      // stdio 必须有 command 和 args
      if (entry.transport === 'stdio') {
        expect(entry.command).toBeTruthy();
        expect(Array.isArray(entry.args)).toBe(true);
      }
      // http 必须有 url
      if (entry.transport === 'http') {
        expect(entry.url).toMatch(/^https?:\/\//);
      }
    }
  });

  // ============================================================
  // 分类
  // ============================================================
  it('8. getCategories 返回 all + 7 个分类', () => {
    const cats = getCategories();
    expect(cats).toContain('all');
    expect(cats).toContain('filesystem');
    expect(cats).toContain('database');
    expect(cats).toContain('browser');
    expect(cats).toContain('search');
    expect(cats).toContain('devtool');
    expect(cats).toContain('communication');
    expect(cats).toContain('other');
  });

  // ============================================================
  // 需 API Key 的服务器标记正确
  // ============================================================
  it('9. requiresApiKey=true 的服务器必须有 requiredEnv 或 requiredHeaders', () => {
    const all = listCatalog().entries;
    for (const entry of all) {
      if (entry.requiresApiKey) {
        const hasEnv = (entry.requiredEnv ?? []).length > 0;
        const hasHeaders = (entry.requiredHeaders ?? []).length > 0;
        expect(hasEnv || hasHeaders).toBe(true);
      }
    }
  });

  it('10. GitHub 服务器标记为需要 API Key', () => {
    const github = getCatalogEntry('github');
    expect(github).toBeDefined();
    expect(github!.requiresApiKey).toBe(true);
    expect(github!.requiredEnv).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
  });
});
