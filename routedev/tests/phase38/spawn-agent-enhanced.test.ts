// tests/phase38/spawn-agent-enhanced.test.ts
// Phase 38 Task 2：子 Agent 工具化与防递归增强测试
// 覆盖：新签名、向后兼容、clone()、防递归、角色白名单、并行上限、计数器递减、modifiedFiles

import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { FileReadTool } from '../../src/tools/builtin/file-read.js';
import { FileWriteTool } from '../../src/tools/builtin/file-write.js';
import { FileEditTool } from '../../src/tools/builtin/file-edit.js';
import { FileSearchTool } from '../../src/tools/builtin/file-search.js';
import { ListDirectoryTool } from '../../src/tools/builtin/list-directory.js';
import { ShellExecTool } from '../../src/tools/builtin/shell-exec.js';
import { GitOpTool } from '../../src/tools/builtin/git-op.js';
import { WebSearchTool } from '../../src/tools/builtin/web-search.js';
import { WebFetchTool } from '../../src/tools/builtin/web-fetch.js';
import { CodeSearchTool } from '../../src/tools/builtin/code-search.js';
import {
  SpawnAgentTool,
  createChildRegistry,
  createConcurrencyLimitedSpawnFn,
  SUBAGENT_TOOL_WHITELIST,
  type SpawnAgentFunction,
  type SpawnResult,
  type SubagentType,
} from '../../src/tools/builtin/spawn-agent.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

// ============================================================
// 辅助工厂
// ============================================================

/** 创建包含全部内置工具的 registry（用于测试 clone/过滤） */
function createFullRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new FileReadTool());
  registry.register(new FileWriteTool());
  registry.register(new FileEditTool());
  registry.register(new FileSearchTool());
  registry.register(new ListDirectoryTool());
  registry.register(new ShellExecTool());
  registry.register(new GitOpTool());
  registry.register(new WebSearchTool());
  registry.register(new WebFetchTool());
  registry.register(new CodeSearchTool());
  return registry;
}

/** 创建 mock 执行上下文 */
function createMockContext(): ToolExecutionContext {
  return {
    workingDirectory: '/tmp/test',
    allowedDirectories: ['/tmp/test'],
    environment: {},
    timeoutMs: 30000,
  };
}

/** 创建 mock SpawnAgentFunction（返回指定结果，通过 mock.calls 追踪调用） */
function createMockSpawnFn(result: Partial<SpawnResult> = {}): SpawnAgentFunction {
  const fn = vi.fn(async (_params: any, _options?: any): Promise<SpawnResult> => {
    return {
      success: result.success ?? true,
      result: result.result ?? '子 Agent 完成',
      tokenUsage: result.tokenUsage,
      modifiedFiles: result.modifiedFiles,
      error: result.error,
    };
  });
  return fn as unknown as SpawnAgentFunction;
}

// ============================================================
// 测试
// ============================================================

describe('Phase 38 Task 2: SpawnAgentTool 增强', () => {
  describe('1. 新签名接受 description + prompt + subagentType', () => {
    it('应正确解析新签名参数并传递给 spawnFn', async () => {
      const mockFn = createMockSpawnFn({ result: '研究完成' });
      const tool = new SpawnAgentTool(mockFn);

      const result = await tool.execute(
        {
          description: '搜索代码',
          prompt: '在 src/ 目录下搜索所有包含 "TODO" 的文件并汇总',
          subagentType: 'researcher',
          maxIterations: 10,
          isolated: true,
        },
        createMockContext(),
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('研究完成');
      // 验证 spawnFn 收到的参数（通过 vitest mock.calls 追踪）
      const mockCalls = (mockFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(mockCalls).toHaveLength(1);
      const params = mockCalls[0][0] as any;
      expect(params.description).toBe('搜索代码');
      expect(params.prompt).toBe('在 src/ 目录下搜索所有包含 "TODO" 的文件并汇总');
      expect(params.subagentType).toBe('researcher');
      expect(params.maxIterations).toBe(10);
      expect(params.isolated).toBe(true);
    });

    it('definition 包含 subagentType/isolated/maxIterations 字段', () => {
      const mockFn = createMockSpawnFn();
      const tool = new SpawnAgentTool(mockFn);
      const props = tool.definition.parameters.properties as Record<string, unknown>;
      expect(props).toHaveProperty('description');
      expect(props).toHaveProperty('prompt');
      expect(props).toHaveProperty('subagentType');
      expect(props).toHaveProperty('maxIterations');
      expect(props).toHaveProperty('isolated');
      expect(tool.definition.parameters.required).toEqual(['description', 'prompt']);
      expect(tool.definition.requiresApproval).toBe(true);
    });
  });

  describe('2. 向后兼容旧的 taskDescription 字符串参数', () => {
    it('旧 taskDescription 应自动转换为 { description, prompt }', async () => {
      const mockFn = createMockSpawnFn({ result: '完成' });
      const tool = new SpawnAgentTool(mockFn);

      const taskDesc = '这是一个足够长的旧格式任务描述字符串';
      const result = await tool.execute(
        { taskDescription: taskDesc },
        createMockContext(),
      );

      expect(result.success).toBe(true);
      const mockCalls = (mockFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(mockCalls).toHaveLength(1);
      const params = mockCalls[0][0] as any;
      // 旧 taskDescription 同时填充 description 和 prompt
      expect(params.description).toBe(taskDesc);
      expect(params.prompt).toBe(taskDesc);
    });

    it('validateArgs 接受旧 taskDescription 字段', () => {
      const mockFn = createMockSpawnFn();
      const tool = new SpawnAgentTool(mockFn);
      const { valid, errors } = tool.validateArgs({
        taskDescription: '这是一个足够长的任务描述',
      });
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    });
  });

  describe('3. ToolRegistry.clone() 创建独立副本', () => {
    it('clone 后修改副本不影响原注册表', () => {
      const original = createFullRegistry();
      const originalSize = original.size;

      const copy = original.clone();
      // 副本与原注册表大小相同
      expect(copy.size).toBe(originalSize);

      // 在副本上移除工具
      copy.unregister('file_read');
      expect(copy.has('file_read')).toBe(false);
      expect(copy.size).toBe(originalSize - 1);

      // 原注册表不受影响
      expect(original.has('file_read')).toBe(true);
      expect(original.size).toBe(originalSize);
    });

    it('clone 后在副本上注册新工具不影响原注册表', () => {
      const original = createFullRegistry();
      const originalSize = original.size;

      const copy = original.clone();
      copy.register(new FileReadTool());  // 重复注册会覆盖，size 不变
      copy.register(new FileSearchTool()); // 重复注册

      expect(original.size).toBe(originalSize);
    });

    it('clone 共享工具对象引用', () => {
      const original = new ToolRegistry();
      const tool = new FileReadTool();
      original.register(tool);

      const copy = original.clone();
      // 浅拷贝：工具对象引用相同
      expect(copy.get('file_read')).toBe(tool);
      expect(original.get('file_read')).toBe(tool);
    });
  });

  describe('4. 子 Agent 的 ToolRegistry 不包含 spawn_agent（防递归）', () => {
    it('createChildRegistry 移除 spawn_agent', () => {
      const parent = createFullRegistry();
      // 父 registry 注册一个 spawn_agent
      const mockFn = createMockSpawnFn();
      parent.register(new SpawnAgentTool(mockFn));
      expect(parent.has('spawn_agent')).toBe(true);

      // 创建子 registry
      const child = createChildRegistry(parent, 'general');
      // 子 registry 不应包含 spawn_agent
      expect(child.has('spawn_agent')).toBe(false);

      // 父 registry 仍保留 spawn_agent
      expect(parent.has('spawn_agent')).toBe(true);
    });

    it('general 类型保留全部工具（除 spawn_agent）', () => {
      const parent = createFullRegistry();
      parent.register(new SpawnAgentTool(createMockSpawnFn()));
      const parentSize = parent.size;

      const child = createChildRegistry(parent, 'general');
      // 子 registry = 父工具数 - 1（spawn_agent）
      expect(child.size).toBe(parentSize - 1);
      expect(child.has('spawn_agent')).toBe(false);
      // 其他工具保留
      expect(child.has('file_read')).toBe(true);
      expect(child.has('file_write')).toBe(true);
      expect(child.has('shell_exec')).toBe(true);
    });
  });

  describe('5. researcher 类型子 Agent 只保留白名单工具', () => {
    it('researcher 只保留 file_read/code_search/web_search/web_fetch/list_directory', () => {
      const parent = createFullRegistry();
      parent.register(new SpawnAgentTool(createMockSpawnFn()));

      const child = createChildRegistry(parent, 'researcher');
      const allowedTools = SUBAGENT_TOOL_WHITELIST.researcher;

      // 白名单中的工具应保留
      for (const name of allowedTools) {
        expect(child.has(name)).toBe(true);
      }

      // 不在白名单中的工具应被移除
      expect(child.has('file_write')).toBe(false);
      expect(child.has('file_edit')).toBe(false);
      expect(child.has('shell_exec')).toBe(false);
      expect(child.has('git_op')).toBe(false);
      expect(child.has('spawn_agent')).toBe(false);

      // 工具数 = 白名单大小
      expect(child.size).toBe(allowedTools.size);
    });

    it('coder 类型只保留 file_read/file_write/file_edit/shell_exec/git_op', () => {
      const parent = createFullRegistry();
      parent.register(new SpawnAgentTool(createMockSpawnFn()));

      const child = createChildRegistry(parent, 'coder');
      const allowedTools = SUBAGENT_TOOL_WHITELIST.coder;

      for (const name of allowedTools) {
        expect(child.has(name)).toBe(true);
      }
      expect(child.has('web_search')).toBe(false);
      expect(child.has('code_search')).toBe(false);
      expect(child.has('spawn_agent')).toBe(false);
      expect(child.size).toBe(allowedTools.size);
    });

    it('reviewer 类型只保留 file_read/code_search/list_directory', () => {
      const parent = createFullRegistry();
      parent.register(new SpawnAgentTool(createMockSpawnFn()));

      const child = createChildRegistry(parent, 'reviewer');
      const allowedTools = SUBAGENT_TOOL_WHITELIST.reviewer;

      for (const name of allowedTools) {
        expect(child.has(name)).toBe(true);
      }
      expect(child.has('file_write')).toBe(false);
      expect(child.has('shell_exec')).toBe(false);
      expect(child.has('spawn_agent')).toBe(false);
      expect(child.size).toBe(allowedTools.size);
    });
  });

  describe('6. 达到 maxConcurrentSubAgents 时返回错误', () => {
    it('超过并行上限时返回错误', async () => {
      // 创建一个慢速的 inner fn，模拟长时间运行的子 Agent
      let resolveInner: () => void;
      const innerPromise = new Promise<void>((r) => { resolveInner = r; });
      const innerFn: SpawnAgentFunction = vi.fn(async () => {
        await innerPromise;
        return { success: true, result: '完成' };
      });

      const maxConcurrent = 2;
      const limitedFn = createConcurrencyLimitedSpawnFn(innerFn, maxConcurrent);

      // 启动 2 个并行子 Agent（达到上限）
      const p1 = limitedFn({ description: '任务1', prompt: '执行任务1的详细指令' });
      const p2 = limitedFn({ description: '任务2', prompt: '执行任务2的详细指令' });

      // 第 3 个应被拒绝
      const result3 = await limitedFn({ description: '任务3', prompt: '执行任务3的详细指令' });
      expect(result3.success).toBe(false);
      expect(result3.error).toContain('已达到最大并行子 Agent 数');
      expect(result3.error).toContain(String(maxConcurrent));

      // 释放前两个
      resolveInner!();
      await Promise.all([p1, p2]);
    });
  });

  describe('7. 子 Agent 完成后 activeSubAgents 计数器递减', () => {
    it('完成后计数器归零，可再次 spawn', async () => {
      const innerFn: SpawnAgentFunction = vi.fn(async () => {
        return { success: true, result: '完成' };
      });

      const maxConcurrent = 1;
      const limitedFn = createConcurrencyLimitedSpawnFn(innerFn, maxConcurrent);

      // 第一次 spawn 应成功
      const r1 = await limitedFn({ description: '任务1', prompt: '执行任务1的详细指令' });
      expect(r1.success).toBe(true);
      expect(limitedFn.getActiveCount()).toBe(0);

      // 计数器归零后，第二次 spawn 也应成功
      const r2 = await limitedFn({ description: '任务2', prompt: '执行任务2的详细指令' });
      expect(r2.success).toBe(true);
      expect(limitedFn.getActiveCount()).toBe(0);
    });

    it('异常时计数器也递减', async () => {
      const innerFn: SpawnAgentFunction = vi.fn(async () => {
        throw new Error('子 Agent 崩溃');
      });

      const limitedFn = createConcurrencyLimitedSpawnFn(innerFn, 1);

      // 即使 inner fn 抛异常，计数器也应递减
      await expect(limitedFn({ description: '任务', prompt: '执行任务的详细指令' })).rejects.toThrow('子 Agent 崩溃');
      expect(limitedFn.getActiveCount()).toBe(0);
    });
  });

  describe('8. SpawnResult 包含 modifiedFiles 字段（可选）', () => {
    it('SpawnResult 类型允许 modifiedFiles 字段', async () => {
      const modifiedFiles = ['src/foo.ts', 'src/bar.ts'];
      const mockFn = createMockSpawnFn({
        result: '修改了 2 个文件',
        modifiedFiles,
      });
      const tool = new SpawnAgentTool(mockFn);

      const result = await tool.execute(
        {
          description: '修改文件',
          prompt: '修改 src/foo.ts 和 src/bar.ts 中的类型定义',
          subagentType: 'coder',
        },
        createMockContext(),
      );

      expect(result.success).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.modifiedFiles).toEqual(modifiedFiles);
    });

    it('modifiedFiles 为可选字段，未提供时不报错', async () => {
      const mockFn = createMockSpawnFn({ result: '只读任务' });
      const tool = new SpawnAgentTool(mockFn);

      const result = await tool.execute(
        {
          description: '搜索代码',
          prompt: '搜索所有包含 TODO 的代码行',
          subagentType: 'researcher',
        },
        createMockContext(),
      );

      expect(result.success).toBe(true);
      // modifiedFiles 未提供时为 undefined
      expect(result.metadata?.modifiedFiles).toBeUndefined();
    });
  });
});
