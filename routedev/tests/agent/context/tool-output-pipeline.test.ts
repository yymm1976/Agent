// tests/agent/context/tool-output-pipeline.test.ts
// Phase 71 Task D3：ToolOutputPipeline 单元测试
// Phase 71 Task D7：更新占位测试以反映 Budget Offload 实装行为
// Phase 72 Task B2：更新测试为 async（process 改为 async 以支持 ContentRouter）
import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { ToolOutputPipeline } from '../../../src/agent/context/tool-output-pipeline.js';
import type { ToolResultSanitizer } from '../../../src/tools/result-sanitizer.js';

// 构造 mock sanitizer 的辅助函数（避免 as any 散落各处）
function makeMockSanitizer(impl: (toolName: string, content: string) => {
  content: string;
  injectionDetected: boolean;
  patterns: string[];
  truncated: boolean;
  originalLength: number;
}): ToolResultSanitizer {
  return { sanitize: vi.fn(impl) } as unknown as ToolResultSanitizer;
}

describe('ToolOutputPipeline', () => {
  it('无 sanitizer 时跳过安全检查', async () => {
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = await pipeline.process('read', 'hello');
    expect(result.output).toBe('hello');
    expect(result.stages).not.toContain('sanitizer');
  });

  it('sanitizer 检测到注入时仍返回内容（加 warning）', async () => {
    const mockSanitizer = makeMockSanitizer(() => ({
      content: 'warned content',
      injectionDetected: true,
      patterns: ['sql-injection'],
      truncated: false,
      originalLength: 9,
    }));
    const pipeline = new ToolOutputPipeline({
      sanitizer: mockSanitizer,
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = await pipeline.process('exec', 'malicious');
    expect(result.output).toBe('warned content');
    expect(result.stages).toContain('sanitizer');
  });

  it('conciseThinkingEnabled=true 时裁剪过长输出', async () => {
    const longOutput = 'a'.repeat(3000);
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: true,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = await pipeline.process('read', longOutput);
    expect(result.output.length).toBeLessThan(longOutput.length);
    expect(result.stages).toContain('concise-thinking');
  });

  it('conciseThinkingEnabled=false 时不裁剪', async () => {
    const longOutput = 'a'.repeat(3000);
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = await pipeline.process('read', longOutput);
    expect(result.output).toBe(longOutput);
  });

  it('sanitizer 抛错时 fail-open 返回原内容', async () => {
    const mockSanitizer = makeMockSanitizer(() => {
      throw new Error('sanitizer error');
    });
    const pipeline = new ToolOutputPipeline({
      sanitizer: mockSanitizer,
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = await pipeline.process('read', 'content');
    expect(result.output).toContain('Tool output withheld');
    expect(result.output).not.toContain('content');
    expect(result.stages).toContain('sanitizer-failed');
  });

  it('budgetEnabled=false 时跳过 offload 阶段', async () => {
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = await pipeline.process('read', 'a'.repeat(5000));
    expect(result.offloadedPath).toBeUndefined();
    expect(result.stages).not.toContain('budget-offload');
  });

  it('budgetEnabled=true 且输出超长时写入 offload 文件并返回路径（Task D7 实装）', async () => {
    // 用真实临时目录验证 offload 写入
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routedev-offload-'));
    try {
      const pipeline = new ToolOutputPipeline({
        conciseThinkingEnabled: false,
        budgetEnabled: true,
        offloadDir: tmpRoot,
        maxChars: 2000,
        sessionId: 'test-session',
      });
      const result = await pipeline.process('read', 'a'.repeat(5000));
      // 阶段记录由 'budget-offload-skipped' 改为 'budget-offload'
      expect(result.stages).toContain('budget-offload');
      expect(result.stages).not.toContain('budget-offload-skipped');
      // offloadedPath 在 Task D7 后会被实际填充
      expect(result.offloadedPath).toBeDefined();
      // 文件确实落盘
      expect(fs.existsSync(result.offloadedPath!)).toBe(true);
      // 路径包含 sessionId 子目录
      expect(result.offloadedPath).toContain('test-session');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('stages 字段记录所有执行阶段', async () => {
    const mockSanitizer = makeMockSanitizer(() => ({
      content: 'safe',
      injectionDetected: false,
      patterns: [],
      truncated: false,
      originalLength: 3000,
    }));
    const pipeline = new ToolOutputPipeline({
      sanitizer: mockSanitizer,
      conciseThinkingEnabled: true,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = await pipeline.process('read', 'a'.repeat(3000));
    expect(result.stages).toContain('sanitizer');
    expect(result.stages).toContain('concise-thinking');
  });

  // ============================================================
  // Phase 72 Task B2：ContentRouter 阶段测试
  // ============================================================
  it('Phase 72 Task B2：contentRoutingEnabled=true 时 JSON 走 json-sampler', async () => {
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
      contentRoutingEnabled: true,
    });
    // 构造一个 > 200 token 的 JSON
    const bigJson = JSON.stringify({
      items: Array.from({ length: 30 }, (_, i) => ({ id: i, name: `item-${i}` })),
    });
    const result = await pipeline.process('file_read', bigJson);
    expect(result.stages).toContain('content-router');
    expect(result.compressStrategy).toBe('json-sampler');
    // 压缩后应保留 array 长度信息
    expect(result.output).toContain('omitted');
  });

  it('Phase 72 Task B2：< 200 token 直通（content-router-skipped）', async () => {
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
      contentRoutingEnabled: true,
    });
    const result = await pipeline.process('file_read', 'short content');
    expect(result.stages).toContain('content-router-skipped');
    expect(result.compressStrategy).toBe('passthrough');
  });

  it('Phase 72 Task B2：contentRoutingEnabled=false 时跳过路由压缩（零回归）', async () => {
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
      contentRoutingEnabled: false,
    });
    const result = await pipeline.process('file_read', '{"items":[1,2,3]}'.repeat(100));
    expect(result.stages).not.toContain('content-router');
    expect(result.stages).not.toContain('content-router-skipped');
  });
});

describe('B-10 截断元数据与 offload receipt', () => {
  it('未截断时 truncated=false 且 originalLength=keptLength', async () => {
    const { ToolOutputPipeline } = await import('../../../src/agent/context/tool-output-pipeline.js');
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      offloadDir: '/tmp/rd-offload',
    });
    const result = await pipeline.process('file_read', '短输出');
    expect(result.truncated).toBe(false);
    expect(result.originalLength).toBe('短输出'.length);
    expect(result.keptLength).toBe('短输出'.length);
  });

  it('concise-thinking 截断时 truncated=true 且 keptLength < originalLength', async () => {
    const { ToolOutputPipeline } = await import('../../../src/agent/context/tool-output-pipeline.js');
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: true,
      offloadDir: '/tmp/rd-offload',
    });
    const big = 'x'.repeat(5000);
    const result = await pipeline.process('shell_exec', big);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(5000);
    expect(result.keptLength).toBeLessThan(5000);
    expect(result.output).toContain('已裁剪');
  });

  it('offload 路径产出 receipt（offloadedPath + size 引用）且 truncated=true', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const offloadDir = mkdtempSync(join(tmpdir(), 'rd-offload-'));
    try {
      const { ToolOutputPipeline } = await import('../../../src/agent/context/tool-output-pipeline.js');
      const pipeline = new ToolOutputPipeline({
        conciseThinkingEnabled: false,
        budgetEnabled: true,
        offloadDir,
        sessionId: 'sess-1',
        maxChars: 100,
      });
      const big = 'y'.repeat(500);
      const result = await pipeline.process('shell_exec', big);
      expect(result.truncated).toBe(true);
      expect(result.originalLength).toBe(500);
      expect(result.offloadedPath).toBeDefined();
      expect(existsSync(result.offloadedPath!)).toBe(true);
      // receipt 引用可回读句柄
      expect(result.output).toContain('persisted-output');
      expect(result.output).toContain('size="500"');
    } finally {
      rmSync(offloadDir, { recursive: true, force: true });
    }
  });

  it('sanitizer 失败时返回 withhold 标记而非原文（R-04/B-10 契约）', async () => {
    const { ToolOutputPipeline } = await import('../../../src/agent/context/tool-output-pipeline.js');
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      offloadDir: '/tmp/rd-offload',
      sanitizer: {
        sanitize: () => { throw new Error('sanitizer boom'); },
      } as never,
    });
    const result = await pipeline.process('shell_exec', 'secret output');
    expect(result.output).toContain('withheld');
    expect(result.output).not.toContain('secret output');
    expect(result.stages).toContain('sanitizer-failed');
  });
});
