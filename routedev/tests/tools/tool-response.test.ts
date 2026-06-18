// tests/tools/tool-response.test.ts
// ToolResponse / executeSafe 单元测试

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { FileReadTool } from '../../src/tools/builtin/file-read.js';
import type {
  ITool,
  ToolDefinition,
  ToolResult,
  ToolExecutionContext,
  ToolResponse,
} from '../../src/tools/types.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'routedev-resp-'));
}

const context = (dir: string): ToolExecutionContext => ({
  workingDirectory: dir,
  allowedDirectories: [dir],
  environment: {},
  timeoutMs: 30000,
});

/** 造一个永远抛出异常的工具，用于测试 executeSafe 的容错 */
class ThrowingTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'throwing_tool',
    description: '永远抛出异常的测试工具',
    parameters: { type: 'object', properties: {} },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }

  async execute(): Promise<ToolResult> {
    throw new Error('boom-from-tool');
  }
}

/** 造一个返回成功结果的工具 */
class OkTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'ok_tool',
    description: '永远成功的测试工具',
    parameters: { type: 'object', properties: {} },
    requiresApproval: false,
    category: 'system',
  };

  validateArgs(): { valid: boolean; errors: string[] } {
    return { valid: true, errors: [] };
  }

  async execute(): Promise<ToolResult> {
    return {
      success: true,
      output: 'ok-result',
      durationMs: 5,
      metadata: { extra: 'meta' },
    };
  }
}

describe('executeSafe', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('工具正常返回时 isError 为 false', async () => {
    const registry = new ToolRegistry();
    registry.register(new OkTool());
    const executor = new ToolExecutor(registry);

    const resp = await executor.executeSafe('ok_tool', {}, context(tempDir));

    expect(resp.isError).toBe(false);
    expect(resp.content).toBe('ok-result');
    expect(resp.metadata).toEqual({ extra: 'meta' });
  });

  it('工具抛出异常时返回 isError: true', async () => {
    const registry = new ToolRegistry();
    registry.register(new ThrowingTool());
    const executor = new ToolExecutor(registry);

    const resp = await executor.executeSafe('throwing_tool', {}, context(tempDir));

    expect(resp.isError).toBe(true);
    expect(resp.content).toContain('throwing_tool');
    expect(resp.content).toContain('boom-from-tool');
  });

  it('工具未注册时返回 isError: true', async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    const resp = await executor.executeSafe('nonexistent', {}, context(tempDir));

    expect(resp.isError).toBe(true);
    expect(resp.content).toContain('nonexistent');
  });

  it('真实工具成功时返回 isError: false', async () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    const executor = new ToolExecutor(registry);

    await fs.writeFile(path.join(tempDir, 'hello.txt'), 'hello world', 'utf-8');

    const resp = await executor.executeSafe('file_read', { path: 'hello.txt' }, context(tempDir));

    expect(resp.isError).toBe(false);
    expect(resp.content).toContain('hello world');
  });

  it('真实工具失败时（读取不存在文件）返回 isError: true', async () => {
    const registry = new ToolRegistry();
    registry.register(new FileReadTool());
    const executor = new ToolExecutor(registry);

    const resp = await executor.executeSafe(
      'file_read',
      { path: 'does-not-exist.txt' },
      context(tempDir),
    );

    expect(resp.isError).toBe(true);
    expect(resp.content).toContain('file_read');
  });

  it('executeSafe 永不抛出异常（即使 execute 抛出）', async () => {
    const registry = new ToolRegistry();
    registry.register(new ThrowingTool());
    const executor = new ToolExecutor(registry);

    // executeSafe 应该 resolve 而不是 reject
    await expect(executor.executeSafe('throwing_tool', {}, context(tempDir))).resolves.toBeDefined();
  });
});

describe('ToolResponse 类型', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('ToolResponse 字段完整（content + isError + 可选 metadata）', async () => {
    const registry = new ToolRegistry();
    registry.register(new OkTool());
    const executor = new ToolExecutor(registry);

    const resp: ToolResponse = await executor.executeSafe('ok_tool', {}, context(tempDir));

    expect(typeof resp.content).toBe('string');
    expect(typeof resp.isError).toBe('boolean');
    expect(resp.metadata).toBeDefined();
    expect(typeof resp.metadata).toBe('object');
  });

  it('失败响应也包含 content 和 isError 字段', async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    const resp: ToolResponse = await executor.executeSafe('nope', {}, context(tempDir));

    expect(typeof resp.content).toBe('string');
    expect(resp.content.length).toBeGreaterThan(0);
    expect(resp.isError).toBe(true);
  });
});

// ============================================================
// Phase 0c Task 1：ToolExecutor 权限检查移除验证
// 验证 ToolExecutor 不再做权限检查（权限由 PermissionEngine 中间件处理）
// ============================================================
describe('Phase 0c: ToolExecutor 不再做权限检查', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('ToolExecutor 无 setPermissionChecker 方法', () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    // setPermissionChecker 已被移除
    expect((executor as unknown as { setPermissionChecker?: unknown }).setPermissionChecker).toBeUndefined();
  });

  it('execute() 不因权限拒绝而返回错误（权限由中间件处理）', async () => {
    // 即使是 shell_exec 这种需要 confirm 的工具，ToolExecutor 本身也不会拦截
    // 拦截发生在 AgentMiddlewarePipeline.onActing 中间件层
    const registry = new ToolRegistry();
    registry.register(new OkTool());
    const executor = new ToolExecutor(registry);

    const result = await executor.execute('ok_tool', {}, context(tempDir));
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('ToolExecutor 仍保留 setSecurityChecker 方法', () => {
    // 安全检查 ≠ 权限检查，SecurityChecker 保留
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    expect(typeof (executor as unknown as { setSecurityChecker?: unknown }).setSecurityChecker).toBe('function');
  });
});
