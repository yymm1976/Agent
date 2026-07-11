// tests/tools/registry.test.ts
// ToolRegistry 单元测试

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { FileReadTool } from '../../src/tools/builtin/file-read.js';
import { FileWriteTool } from '../../src/tools/builtin/file-write.js';
import { FileEditTool } from '../../src/tools/builtin/file-edit.js';
import { FileSearchTool } from '../../src/tools/builtin/file-search.js';
import { ListDirectoryTool } from '../../src/tools/builtin/list-directory.js';
import { ShellExecTool } from '../../src/tools/builtin/shell-exec.js';
import { GitOpTool } from '../../src/tools/builtin/git-op.js';
import { CodeSearchTool } from '../../src/tools/builtin/code-search.js';
import { TodoWriteTool } from '../../src/tools/builtin/todo-write.js';
import { TodoStore } from '../../src/tools/builtin/todo-store.js';
import { AskUserTool } from '../../src/tools/builtin/ask-user.js';
import { WebSearchTool } from '../../src/tools/builtin/web-search.js';
import { WebFetchTool } from '../../src/tools/builtin/web-fetch.js';
import { RepoMapTool } from '../../src/tools/builtin/repo-map.js';
import { CodeGraphQueryTool } from '../../src/tools/builtin/code-graph-query.js';

describe('ToolRegistry', () => {
  it('should register and retrieve tools', () => {
    const registry = new ToolRegistry();
    const tool = new FileReadTool();
    registry.register(tool);

    expect(registry.has('file_read')).toBe(true);
    expect(registry.get('file_read')).toBe(tool);
    expect(registry.size).toBe(1);
  });

  it('should unregister tools', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    registry.unregister('file_read');

    expect(registry.has('file_read')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('should reject duplicate registrations by default', () => {
    const registry = new ToolRegistry();
    const tool1 = new FileReadTool();
    const tool2 = new FileReadTool();
    registry.register(tool1);

    expect(() => registry.register(tool2)).toThrow('already registered');

    expect(registry.get('file_read')).toBe(tool1);
    expect(registry.size).toBe(1);
  });

  it('should overwrite duplicate registrations when explicitly requested', () => {
    const registry = new ToolRegistry();
    const tool1 = new FileReadTool();
    const tool2 = new FileReadTool();
    registry.register(tool1);
    registry.register(tool2, true);

    expect(registry.get('file_read')).toBe(tool2);
    expect(registry.size).toBe(1);
  });

  it('should list all tools', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    registry.register(new FileWriteTool());
    registry.register(new FileSearchTool());

    const tools = registry.list();
    expect(tools.length).toBe(3);
    expect(tools.map(t => t.definition.name).sort()).toEqual(['file_read', 'file_search', 'file_write']);
  });

  it('should generate function schemas', () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());

    const schemas = registry.getFunctionSchemas();
    expect(schemas.length).toBe(1);
    expect(schemas[0].name).toBe('file_read');
    expect(schemas[0].description).toContain('文件');
    expect(schemas[0].parameters).toHaveProperty('properties');
  });
});

// Phase 81 Task 1：工具默认注册收口——profile 档位测试
describe('ToolProfile (Phase 81 Task 1)', () => {
  // Core 工具清单（≤10 个），与 app-init-tools.ts 中 core 档位注册一致
  const coreToolNames = [
    'file_read', 'file_write', 'file_edit', 'file_search',
    'shell_exec', 'git_op', 'todo_write', 'code_search',
    'ask_user', 'list_directory',
  ];

  /** 注册全部 Core 工具到 registry（模拟 core profile 行为） */
  function registerCoreTools(registry: ToolRegistry): void {
    registry.register(new FileReadTool());
    registry.register(new FileWriteTool());
    registry.register(new FileEditTool());
    registry.register(new FileSearchTool());
    registry.register(new ShellExecTool());
    registry.register(new GitOpTool());
    registry.register(new ListDirectoryTool());
    const todoStore = new TodoStore();
    registry.register(new TodoWriteTool(todoStore));
    registry.register(new CodeSearchTool());
    registry.register(new AskUserTool());
  }

  it('默认 profile（core）工具数 ≤ 10', () => {
    const registry = new ToolRegistry();
    registerCoreTools(registry);

    // 工具数恰好 10，不超过上限
    expect(registry.size).toBe(10);
    expect(registry.size).toBeLessThanOrEqual(10);
    // 所有 Core 工具均已注册
    for (const name of coreToolNames) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('full profile 可恢复全部工具', () => {
    const registry = new ToolRegistry();
    // Core 工具
    registerCoreTools(registry);
    // 非 Core 工具（模拟 full profile 注册）
    registry.register(new WebSearchTool());
    registry.register(new WebFetchTool());
    registry.register(new RepoMapTool());
    registry.register(new CodeGraphQueryTool());

    // full 工具数 > core 上限 10
    expect(registry.size).toBeGreaterThan(10);
    // 非 Core 工具已注册
    expect(registry.has('web_search')).toBe(true);
    expect(registry.has('web_fetch')).toBe(true);
    expect(registry.has('repo_map')).toBe(true);
    expect(registry.has('code_graph_query')).toBe(true);
  });

  it('未注册工具调用返回明确错误', async () => {
    const registry = new ToolRegistry();
    registerCoreTools(registry);
    const executor = new ToolExecutor(registry);

    // core profile 下 web_search 未注册——调用应返回明确错误
    const result = await executor.execute('web_search', { query: 'test' }, {
      workingDirectory: '/tmp',
      allowedDirectories: ['/tmp'],
      environment: {},
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('未注册');
    expect(result.error).toContain('web_search');
  });
});
