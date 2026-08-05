// tests/tools/tool-search.test.ts
// B-01B：tool_search 搜索与回合级提升测试
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { buildTool } from '../../src/tools/types.js';
import { TurnToolBoost, searchDeferredTools, createToolSearchTool, scoreTool } from '../../src/tools/tool-search.js';
import { ToolRegistryAdapter } from '../../src/tools/adapter.js';

function deferredTool(name: string, description: string, category = 'web') {
  return buildTool({
    name,
    description,
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    requiresApproval: true,
    category: category as never,
    exposure: 'deferred',
    async execute() {
      return { success: true, output: `executed ${name}` };
    },
  });
}

function coreTool(name: string) {
  return buildTool({
    name,
    description: `core ${name}`,
    parameters: { type: 'object', properties: {} },
    requiresApproval: false,
    category: 'system',
    async execute() {
      return { success: true, output: `executed ${name}` };
    },
  });
}

function buildRegistry() {
  const registry = new ToolRegistry();
  registry.register(coreTool('file_read'));
  registry.register(deferredTool('web_search', '搜索互联网网页，返回搜索结果摘要', 'web'));
  registry.register(deferredTool('web_fetch', '抓取指定 URL 的网页内容', 'web'));
  registry.register(deferredTool('browser', '控制浏览器打开页面、点击与截图', 'web'));
  registry.register(deferredTool('repo_map', '生成代码仓库结构地图（PageRank 排序）', 'code'));
  return registry;
}

describe('B-01B scoreTool 确定性评分', () => {
  it('名称精确匹配得分最高', () => {
    expect(scoreTool('web_search', '搜索网页', 'web', 'web_search')).toBeGreaterThan(
      scoreTool('web_search', '搜索网页', 'web', 'fetch'),
    );
  });

  it('无关 query 得 0 分', () => {
    expect(scoreTool('web_search', '搜索网页', 'web', 'checkout')).toBe(0);
  });
});

describe('B-01B searchDeferredTools', () => {
  it('只返回 deferred 工具（core 工具搜索不到）', () => {
    const registry = buildRegistry();
    const hits = searchDeferredTools(registry, '搜索网页');
    const names = hits.map((h) => h.name);
    expect(names).toContain('web_search');
    expect(names).not.toContain('file_read');
  });

  it('按相关度排序且最多 5 个', () => {
    const registry = buildRegistry();
    const hits = searchDeferredTools(registry, 'browser 浏览器');
    expect(hits.length).toBeLessThanOrEqual(5);
    expect(hits[0].name).toBe('browser');
    // 候选含单句用途与参数摘要
    expect(hits[0].purpose.length).toBeGreaterThan(0);
    expect(hits[0].parameters).toContain('query');
  });

  it('deny 工具搜索不到', () => {
    const registry = buildRegistry();
    const hits = searchDeferredTools(registry, 'web_search', { deniedTools: new Set(['web_search']) });
    expect(hits.map((h) => h.name)).not.toContain('web_search');
  });

  it('空 query 不返回结果', () => {
    const registry = buildRegistry();
    expect(searchDeferredTools(registry, '  ')).toEqual([]);
  });
});

describe('B-01B tool_search 执行与提升', () => {
  it('执行后清空旧提升并提升新候选；候选名在 adapter schema 中可见', () => {
    const registry = buildRegistry();
    const boost = new TurnToolBoost();
    boost.add(['web_fetch']); // 模拟旧提升
    const tool = createToolSearchTool({ registry, boost });
    const adapter = new ToolRegistryAdapter(registry, { execute: () => Promise.resolve({ success: true, output: 'x' }) } as never, {} as never);
    adapter.setToolBoost(boost);

    // 提升前：deferred 工具不在 schema
    expect(adapter.getToolDefinitions().map((d) => d.name)).not.toContain('web_search');

    const result = (tool.execute as (args: Record<string, unknown>) => Promise<{ success: boolean; output: string }>)({ query: '搜索' });
    return result.then((res) => {
      expect(res.success).toBe(true);
      expect(res.output).toContain('web_search');
      // 旧提升被清空，只保留本轮候选（query '搜索' 只命中 web_search）
      expect(boost.names.has('web_fetch')).toBe(false);
      expect(boost.names.has('web_search')).toBe(true);
      // 提升后：候选出现在 adapter schema
      const names = adapter.getToolDefinitions().map((d) => d.name);
      expect(names).toContain('web_search');
      expect(names).not.toContain('browser');
    });
  });

  it('候选工具成功执行后从 boost 收回（消费即收回）', () => {
    const registry = buildRegistry();
    const boost = new TurnToolBoost();
    const adapter = new ToolRegistryAdapter(registry, {
      async execute(name: string) {
        return { success: true, output: `ok ${name}` };
      },
    } as never, {} as never);
    adapter.setToolBoost(boost);
    boost.add(['web_search']);
    return adapter.executeTool('web_search', 'id1', {}).then(() => {
      expect(boost.names.has('web_search')).toBe(false);
    });
  });

  it('无匹配时返回提示且不提升任何工具', () => {
    const registry = buildRegistry();
    const boost = new TurnToolBoost();
    const tool = createToolSearchTool({ registry, boost });
    return (tool.execute as (args: Record<string, unknown>) => Promise<{ output: string }>)({ query: 'zzz-no-such' }).then((res) => {
      expect(res.output).toContain('没有找到');
      expect(boost.names.size).toBe(0);
    });
  });
});
