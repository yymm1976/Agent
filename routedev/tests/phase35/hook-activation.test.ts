// tests/phase35/hook-activation.test.ts
// Phase 35 Task 2：HookRunner 生产激活与文件变更验证测试
// 验证：内置钩子注册、post-tool-call 文件验证触发、session 生命周期记录、钩子错误隔离

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HookRunner, type HookContext, type HookResult } from '../../src/agent/hooks.js';
import { registerBuiltinHooks } from '../../src/hooks/built-in.js';
import { AuditLogger } from '../../src/harness/audit-logger.js';
import { TraceCollector } from '../../src/harness/trace-collector.js';

// ============================================================
// 测试辅助
// ============================================================

/** 创建临时目录用于测试文件验证 */
async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `phase35-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 创建基础 HookContext */
function makeContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    stepId: 'test-step',
    agentId: 'test-agent',
    projectPath: process.cwd(),
    ...overrides,
  };
}

/** 创建带 TraceCollector 的 HookRunner */
function makeHookRunner(): HookRunner {
  const runner = new HookRunner();
  const trace = new TraceCollector({ storageDir: undefined });
  runner.setTraceCollector(trace);
  return runner;
}

// ============================================================
// 测试用例
// ============================================================

describe('Phase 35 Task 2: HookRunner 生产激活与文件变更验证', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  describe('内置钩子注册', () => {
    it('registerBuiltinHooks 注册 3 个内置钩子（post-tool-call + session-start + session-end）', () => {
      const runner = makeHookRunner();
      const audit = new AuditLogger('test-session');

      registerBuiltinHooks(runner, audit, process.cwd(), 'test-model');

      const hooks = runner.list();
      expect(hooks.length).toBe(3);

      // 验证事件类型
      const events = hooks.map(h => h.event).sort();
      expect(events).toEqual(['on-session-end', 'on-session-start', 'post-tool-call']);

      // 验证钩子名称
      const names = hooks.map(h => h.name);
      expect(names).toContain('builtin:post-file-change-validate');
      expect(names).toContain('builtin:session-start-logger');
      expect(names).toContain('builtin:session-end-logger');
    });

    it('内置钩子优先级为 50（低于默认 100，让用户插件排在后面）', () => {
      const runner = makeHookRunner();
      const audit = new AuditLogger('test-session');

      registerBuiltinHooks(runner, audit, process.cwd(), 'test-model');

      const hooks = runner.list();
      for (const h of hooks) {
        expect(h.priority).toBe(50);
      }
    });
  });

  describe('post-tool-call 文件验证', () => {
    it('file_write 后对存在的文件验证通过（返回 continue 无警告）', async () => {
      const runner = makeHookRunner();
      const audit = new AuditLogger('test-session');
      registerBuiltinHooks(runner, audit, tempDir, 'test-model');

      // 创建测试文件
      const filePath = path.join(tempDir, 'test.ts');
      await fs.writeFile(filePath, 'console.log("hello");', 'utf-8');

      const ctx = makeContext({
        toolName: 'file_write',
        toolArgs: { path: filePath },
        toolResult: '文件写入成功',
        projectPath: tempDir,
      });

      const result = await runner.fire('post-tool-call', ctx);
      expect(result.action).toBe('continue');
      expect(result.message).toBeUndefined(); // 验证通过无警告
    });

    it('file_edit 后对空文件发出警告（返回 continue + 警告消息）', async () => {
      const runner = makeHookRunner();
      const audit = new AuditLogger('test-session');
      registerBuiltinHooks(runner, audit, tempDir, 'test-model');

      // 创建空文件
      const filePath = path.join(tempDir, 'empty.ts');
      await fs.writeFile(filePath, '', 'utf-8');

      const ctx = makeContext({
        toolName: 'file_edit',
        toolArgs: { path: filePath },
        toolResult: '文件编辑成功',
        projectPath: tempDir,
      });

      const result = await runner.fire('post-tool-call', ctx);
      expect(result.action).toBe('continue'); // 不 abort
      expect(result.message).toContain('警告');
      expect(result.message).toContain('empty.ts');
    });

    it('JSON 文件语法错误时发出警告', async () => {
      const runner = makeHookRunner();
      const audit = new AuditLogger('test-session');
      registerBuiltinHooks(runner, audit, tempDir, 'test-model');

      // 创建语法错误的 JSON 文件
      const filePath = path.join(tempDir, 'broken.json');
      await fs.writeFile(filePath, '{ "name": "test", invalid syntax }', 'utf-8');

      const ctx = makeContext({
        toolName: 'file_write',
        toolArgs: { path: filePath },
        toolResult: '文件写入成功',
        projectPath: tempDir,
      });

      const result = await runner.fire('post-tool-call', ctx);
      expect(result.action).toBe('continue');
      expect(result.message).toContain('JSON');
      expect(result.message).toContain('警告');
    });

    it('非文件工具（如 shell_exec）不触发文件验证', async () => {
      const runner = makeHookRunner();
      const audit = new AuditLogger('test-session');
      registerBuiltinHooks(runner, audit, tempDir, 'test-model');

      const ctx = makeContext({
        toolName: 'shell_exec',
        toolArgs: { command: 'echo hello' },
        toolResult: 'hello',
        projectPath: tempDir,
      });

      const result = await runner.fire('post-tool-call', ctx);
      expect(result.action).toBe('continue');
      expect(result.message).toBeUndefined(); // 非文件工具不验证
    });

    it('文件不存在时发出警告（不 abort）', async () => {
      const runner = makeHookRunner();
      const audit = new AuditLogger('test-session');
      registerBuiltinHooks(runner, audit, tempDir, 'test-model');

      const ctx = makeContext({
        toolName: 'file_write',
        toolArgs: { path: path.join(tempDir, 'nonexistent.ts') },
        toolResult: '文件写入成功',
        projectPath: tempDir,
      });

      const result = await runner.fire('post-tool-call', ctx);
      expect(result.action).toBe('continue'); // 不 abort
      expect(result.message).toContain('警告');
    });
  });

  describe('session 生命周期记录', () => {
    it('on-session-start 写入 AuditLogger（action: session_start）', async () => {
      const runner = makeHookRunner();
      // 使用临时目录作为 audit 存储位置，便于验证
      const auditDir = path.join(tempDir, 'audit');
      const audit = new AuditLogger('test-session', { storageDir: auditDir });

      registerBuiltinHooks(runner, audit, tempDir, 'test-model-001');

      const ctx = makeContext({
        stepId: 'session-init',
        agentId: 'main-agent',
        projectPath: tempDir,
      });

      const result = await runner.fire('on-session-start', ctx);
      expect(result.action).toBe('continue');

      // 验证 AuditLogger 写入了 session_start 记录
      const records = await audit.listToday(50);
      const sessionStart = records.find(r => r.action === 'session_start');
      expect(sessionStart).toBeDefined();
      expect(sessionStart!.details.modelId).toBe('test-model-001');
      expect(sessionStart!.details.cwd).toBe(tempDir);
    });

    it('on-session-end 写入 AuditLogger（action: session_end）', async () => {
      const runner = makeHookRunner();
      const auditDir = path.join(tempDir, 'audit');
      const audit = new AuditLogger('test-session', { storageDir: auditDir });

      registerBuiltinHooks(runner, audit, tempDir, 'test-model-001');

      const ctx = makeContext({
        stepId: 'session-end',
        agentId: 'main-agent',
        stepResult: { success: true, output: '完成', durationMs: 5000 },
        projectPath: tempDir,
      });

      const result = await runner.fire('on-session-end', ctx);
      expect(result.action).toBe('continue');

      // 验证 AuditLogger 写入了 session_end 记录
      const records = await audit.listToday(50);
      const sessionEnd = records.find(r => r.action === 'session_end');
      expect(sessionEnd).toBeDefined();
    });
  });

  describe('钩子错误隔离', () => {
    it('单个钩子崩溃不影响其他钩子和主流程', async () => {
      const runner = makeHookRunner();
      const audit = new AuditLogger('test-session');

      // 注册一个会崩溃的钩子（优先级 10，先执行）
      runner.register({
        event: 'post-tool-call',
        name: 'crashing-hook',
        priority: 10,
        handler: async () => {
          throw new Error('钩子故意崩溃');
        },
      });

      // 注册一个正常的内置钩子（优先级 50，后执行）
      registerBuiltinHooks(runner, audit, tempDir, 'test-model');

      const filePath = path.join(tempDir, 'test.ts');
      await fs.writeFile(filePath, 'valid content', 'utf-8');

      const ctx = makeContext({
        toolName: 'file_write',
        toolArgs: { path: filePath },
        toolResult: '成功',
        projectPath: tempDir,
      });

      // 崩溃钩子不应影响后续钩子执行
      const result = await runner.fire('post-tool-call', ctx);
      expect(result.action).toBe('continue'); // 主流程继续
    });

    it('钩子返回 abort 时短路，后续钩子不执行', async () => {
      const runner = makeHookRunner();
      const audit = new AuditLogger('test-session');

      let secondHookCalled = false;

      // 第一个钩子返回 abort
      runner.register({
        event: 'pre-step',
        name: 'abort-hook',
        priority: 10,
        handler: async () => ({ action: 'abort', message: '禁止执行' }),
      });

      // 第二个钩子不应被调用
      runner.register({
        event: 'pre-step',
        name: 'should-not-run',
        priority: 20,
        handler: async () => {
          secondHookCalled = true;
          return { action: 'continue' };
        },
      });

      const result = await runner.fire('pre-step', makeContext());
      expect(result.action).toBe('abort');
      expect(result.message).toBe('禁止执行');
      expect(secondHookCalled).toBe(false);
    });
  });
});
