// desktop/main/__tests__/mcp-catalog.test.ts
// TD-14：mcp-catalog 模块测试（示例：主进程纯数据模块测试基建）
// 注：ipc-guard 已有 tests/desktop/ipc-guard.test.ts 覆盖，此处测试不同的 main 模块
//
// 验证内置 MCP 市场目录的数据完整性与查询函数行为

import { describe, it, expect } from 'vitest';
import {
  listCatalog,
  searchCatalog,
  getCatalogEntry,
  getCategories,
} from '../mcp-catalog.js';

describe('mcp-catalog listCatalog', () => {
  it('返回全部条目且按流行度降序排序', () => {
    const result = listCatalog();
    expect(result.total).toBe(result.entries.length);
    expect(result.total).toBeGreaterThan(0);
    // 验证降序：相邻条目 popularity 不递增
    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i - 1].popularity).toBeGreaterThanOrEqual(
        result.entries[i].popularity,
      );
    }
  });

  it('按分类过滤仅返回对应条目', () => {
    const all = listCatalog();
    const fsOnly = listCatalog('filesystem');
    expect(fsOnly.total).toBeLessThan(all.total);
    expect(fsOnly.entries.every((e) => e.category === 'filesystem')).toBe(true);
  });

  it('category=all 等价于不传参数', () => {
    expect(listCatalog('all')).toEqual(listCatalog());
  });
});

describe('mcp-catalog searchCatalog', () => {
  it('空查询返回全部条目', () => {
    expect(searchCatalog('')).toEqual(listCatalog());
    expect(searchCatalog('   ')).toEqual(listCatalog());
  });

  it('按 id 匹配', () => {
    const result = searchCatalog('github');
    expect(result.entries.some((e) => e.id === 'github')).toBe(true);
  });

  it('按 displayName 匹配（大小写不敏感）', () => {
    const result = searchCatalog('POSTGRES');
    expect(result.entries.some((e) => e.id === 'postgres')).toBe(true);
  });

  it('无匹配时返回空列表', () => {
    const result = searchCatalog('不存在的服务zzz');
    expect(result.total).toBe(0);
    expect(result.entries).toEqual([]);
  });
});

describe('mcp-catalog getCatalogEntry', () => {
  it('存在 id 返回对应条目', () => {
    const entry = getCatalogEntry('filesystem');
    expect(entry).toBeDefined();
    expect(entry?.id).toBe('filesystem');
    expect(entry?.displayName).toBe('Filesystem');
  });

  it('不存在 id 返回 undefined', () => {
    expect(getCatalogEntry('nonexistent-id')).toBeUndefined();
  });
});

describe('mcp-catalog getCategories', () => {
  it('返回包含 all 在内的全部分类', () => {
    const categories = getCategories();
    expect(categories[0]).toBe('all');
    expect(categories).toContain('filesystem');
    expect(categories).toContain('database');
    expect(categories).toContain('browser');
    expect(categories).toContain('devtool');
    expect(categories).toContain('communication');
    expect(categories).toContain('other');
  });
});
