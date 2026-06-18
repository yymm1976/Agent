// tests/harness/tracing-executor.test.ts
// TracingToolExecutor 单元测试

import { describe, it, expect, vi } from 'vitest';
import { TracingToolExecutor } from '../../src/harness/tracing-executor.js';
import { TraceCollector } from '../../src/harness/trace-collector.js';
import { AuditLogger } from '../../src/harness/audit-logger.js';
import type { ToolExecutorAdapter } from '../../src/agent/loop-config.js';
import type { LLMToolDefinition } from '../../src/router/types.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

function makeInner(overrides?: Partial<ToolExecutorAdapter>): ToolExecutorAdapter & { executeTool: any } {
  return {
    getToolDefinitions: vi.fn((): LLMToolDefinition[] => [
      { name: 'file_write', description: 'write file', parameters: [] },
      { name: 'file_read', description: 'read file', parameters: [] },
      { name: 'shell_exec', description: 'run command', parameters: [] },
    ]),
    hasTool: vi.fn((name: string) => ['file_write', 'file_read', 'shell_exec'].includes(name)),
    executeTool: vi.fn(async () => 'mocked result'),
    ...overrides,
  } as any;
}

describe('TracingToolExecutor', () => {
  it('should proxy getToolDefinitions', async () => {
    const inner = makeInner();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exec-'));
    try {
      const trace = new TraceCollector({ storageDir: tempDir });
      const audit = new AuditLogger('sess-1', { storageDir: tempDir });
      trace.startSession('test');
      const exec = new TracingToolExecutor(inner, trace, audit);
      const defs = exec.getToolDefinitions();
      expect(defs.length).toBe(3);
      expect(defs[0].name).toBe('file_write');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should proxy hasTool', async () => {
    const inner = makeInner();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exec-'));
    try {
      const trace = new TraceCollector({ storageDir: tempDir });
      const audit = new AuditLogger('sess-1', { storageDir: tempDir });
      trace.startSession('test');
      const exec = new TracingToolExecutor(inner, trace, audit);
      expect(exec.hasTool('file_write')).toBe(true);
      expect(exec.hasTool('unknown')).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should record tool_call_start and tool_call_end in trace', async () => {
    const inner = makeInner();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exec-'));
    try {
      const trace = new TraceCollector({ storageDir: tempDir });
      const audit = new AuditLogger('sess-1', { storageDir: tempDir });
      trace.startSession('test');
      const exec = new TracingToolExecutor(inner, trace, audit);
      const result = await exec.executeTool('file_read', 'c1', { filePath: '/tmp/x' });
      expect(result).toBe('mocked result');
      const spans = trace.getSpans();
      expect(spans.length).toBeGreaterThan(0);
      expect(spans[0].type).toBe('tool_call');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should propagate errors and mark span as error', async () => {
    const inner = makeInner({
      executeTool: vi.fn(async () => { throw new Error('boom'); }),
    });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exec-'));
    try {
      const trace = new TraceCollector({ storageDir: tempDir });
      const audit = new AuditLogger('sess-1', { storageDir: tempDir });
      trace.startSession('test');
      const exec = new TracingToolExecutor(inner, trace, audit);
      await expect(exec.executeTool('file_read', 'c1', {})).rejects.toThrow('boom');
      const spans = trace.getSpans();
      // tool_call span should be marked with isError
      expect(spans[0].type).toBe('tool_call');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should audit file_write calls', async () => {
    const inner = makeInner();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exec-'));
    try {
      const trace = new TraceCollector({ storageDir: tempDir });
      const audit = new AuditLogger('sess-1', { storageDir: tempDir });
      trace.startSession('test');
      const exec = new TracingToolExecutor(inner, trace, audit);
      await exec.executeTool('file_write', 'c1', { filePath: '/tmp/test.ts' });
      await new Promise(r => setTimeout(r, 50));
      const records = await audit.listToday();
      const fileRecords = records.filter(r => r.action === 'file_write');
      expect(fileRecords.length).toBe(1);
      expect(fileRecords[0].target).toBe('/tmp/test.ts');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should audit shell_exec calls', async () => {
    const inner = makeInner();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exec-'));
    try {
      const trace = new TraceCollector({ storageDir: tempDir });
      const audit = new AuditLogger('sess-1', { storageDir: tempDir });
      trace.startSession('test');
      const exec = new TracingToolExecutor(inner, trace, audit);
      await exec.executeTool('shell_exec', 'c1', { command: 'ls -la' });
      await new Promise(r => setTimeout(r, 50));
      const records = await audit.listToday();
      const shellRecords = records.filter(r => r.action === 'shell_exec');
      expect(shellRecords.length).toBe(1);
      expect(shellRecords[0].target).toBe('ls -la');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should NOT audit file_read calls', async () => {
    const inner = makeInner();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exec-'));
    try {
      const trace = new TraceCollector({ storageDir: tempDir });
      const audit = new AuditLogger('sess-1', { storageDir: tempDir });
      trace.startSession('test');
      const exec = new TracingToolExecutor(inner, trace, audit);
      await exec.executeTool('file_read', 'c1', { filePath: '/tmp/x' });
      await new Promise(r => setTimeout(r, 50));
      const records = await audit.listToday();
      expect(records.length).toBe(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should support updateInner', async () => {
    const inner1 = makeInner();
    const inner2 = makeInner({
      executeTool: vi.fn(async () => 'inner2 result'),
    });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exec-'));
    try {
      const trace = new TraceCollector({ storageDir: tempDir });
      const audit = new AuditLogger('sess-1', { storageDir: tempDir });
      trace.startSession('test');
      const exec = new TracingToolExecutor(inner1, trace, audit);
      exec.updateInner(inner2);
      const r = await exec.executeTool('file_read', 'c1', {});
      expect(r).toBe('inner2 result');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});