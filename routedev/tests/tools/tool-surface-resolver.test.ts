// tests/tools/tool-surface-resolver.test.ts
// B-01A：模型可见工具面解析器测试
import { describe, expect, it } from 'vitest';
import { resolveVisibleTools, type ToolSurfaceEntry } from '../../src/tools/tool-surface-resolver.js';

/** 测试辅助：解析后的工具名列表 */
function names(tools: ToolSurfaceEntry[], ctx: Parameters<typeof resolveVisibleTools>[1]): string[] {
  return resolveVisibleTools(tools, ctx).map((t) => t.definition.name);
}

function entry(name: string, overrides: Partial<ToolSurfaceEntry['definition']> = {}): ToolSurfaceEntry {
  return {
    definition: {
      name,
      category: 'system',
      requiresApproval: false,
      ...overrides,
    },
  };
}

const CORE_READ = entry('file_read');
const CORE_WRITE = entry('file_write', { requiresApproval: true });
const SHELL = entry('shell_exec', { requiresApproval: true, category: 'shell' });
const SEARCH = entry('file_search');
const VFS_READ = entry('vfs_read', { exposure: 'mode', modes: ['vfs'], readOnly: true });
const VFS_WRITE = entry('vfs_write', { exposure: 'mode', modes: ['vfs'] });
const PLAN_GET = entry('plan_get', { exposure: 'mode', modes: ['plan'] });
const WEB_SEARCH = entry('web_search', { exposure: 'deferred' });
const MCP_TOOL = entry('mcp__server_tool', { category: 'mcp', requiresApproval: true });
const INTERNAL = entry('debug_probe', { exposure: 'hidden' });

const ALL = [CORE_READ, CORE_WRITE, SHELL, SEARCH, VFS_READ, VFS_WRITE, PLAN_GET, WEB_SEARCH, MCP_TOOL, INTERNAL];

describe('B-01A resolveVisibleTools', () => {
  it('默认 coding 回合：隐藏/延迟/未绑定模式的内部工具不可见，VFS/Plan 工具不出现', () => {
    const result = names(ALL, { mode: 'coding' });
    // MCP 工具在 coding 回合可见（审批是运行时行为，与旧 chat-bridge 行为一致）
    expect(result).toEqual(['file_read', 'file_write', 'shell_exec', 'file_search', 'mcp__server_tool']);
    expect(result).not.toContain('vfs_read');
    expect(result).not.toContain('plan_get');
    expect(result).not.toContain('web_search');
    expect(result).not.toContain('debug_probe');
  });

  it('未声明元数据的旧工具按 core 暴露（兼容）', () => {
    const legacy = entry('legacy_tool');
    const result = names([legacy, INTERNAL], { mode: 'coding' });
    expect(result).toEqual(['legacy_tool']);
  });

  it('vfs 模式：vfs 工具可见，plan 工具仍不可见', () => {
    const result = names(ALL, { mode: 'vfs' });
    expect(result).toContain('vfs_read');
    expect(result).toContain('vfs_write');
    expect(result).not.toContain('plan_get');
    expect(result).not.toContain('web_search');
  });

  it('exposure=mode 但未声明 modes 的工具永不暴露（防御）', () => {
    const orphan = entry('orphan', { exposure: 'mode' });
    expect(names([orphan], { mode: 'coding' })).toEqual([]);
    expect(names([orphan], { mode: 'any' })).toEqual([]);
  });

  it('权限拒绝的工具不会出现在 schema', () => {
    const denied = new Set(['shell_exec']);
    const result = names(ALL, { mode: 'coding', deniedTools: denied });
    expect(result).not.toContain('shell_exec');
    expect(result).toContain('file_write');
  });

  it('会话白名单非空时只保留白名单内（仍受 exposure 约束）', () => {
    const result = names(ALL, {
      mode: 'coding',
      allowedTools: new Set(['file_read', 'vfs_read', 'web_search']),
    });
    // vfs_read 是 mode 工具且模式不匹配 → 仍被排除；web_search 是 deferred → 仍被排除
    expect(result).toEqual(['file_read']);
  });

  it('qa 模式只保留无需审批工具；显式点名 MCP 时保留 MCP', () => {
    const result = names(ALL, { mode: 'qa' });
    expect(result).toEqual(['file_read', 'file_search']);
    const withMcp = names(ALL, { mode: 'qa', mcpRequested: true });
    expect(withMcp).toContain('mcp__server_tool');
    expect(withMcp).not.toContain('file_write');
    expect(withMcp).not.toContain('shell_exec');
  });

  it('maxCoreTools 按注册顺序截断 core 工具，不影响非 core', () => {
    const result = names(ALL, { mode: 'vfs', maxCoreTools: 2 });
    // vfs 模式下可见：file_read/file_write/shell_exec/file_search(vfs 前 4 个 core 截断为 2) + vfs_read/vfs_write
    expect(result).toEqual(['file_read', 'file_write', 'vfs_read', 'vfs_write']);
  });

  it('resolveVisibleTools 保留原对象引用（不做拷贝）', () => {
    const result = resolveVisibleTools(ALL, { mode: 'coding' });
    expect(result[0]).toBe(CORE_READ);
  });

  it('P2: boostedTools 提升 deferred 工具（tool_search 提升后可见）', () => {
    // 默认 deferred 不可见
    expect(names(ALL, { mode: 'coding' })).not.toContain('web_search');
    // 提升后可见
    const boosted = names(ALL, { mode: 'coding', boostedTools: new Set(['web_search']) });
    expect(boosted).toContain('web_search');
    // hidden 工具即使提升也不可见
    const boostedHidden = names(ALL, { mode: 'coding', boostedTools: new Set(['debug_probe']) });
    expect(boostedHidden).not.toContain('debug_probe');
    // 提升不改变白名单约束
    const allowed = names(ALL, {
      mode: 'coding',
      boostedTools: new Set(['web_search']),
      allowedTools: new Set(['file_read']),
    });
    expect(allowed).toEqual(['file_read']);
  });
});
