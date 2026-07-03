// tests/agent/context/tool-output-pipeline.test.ts
// Phase 71 Task D3：ToolOutputPipeline 单元测试
// Phase 71 Task D7：更新占位测试以反映 Budget Offload 实装行为
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
  it('无 sanitizer 时跳过安全检查', () => {
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = pipeline.process('read', 'hello');
    expect(result.output).toBe('hello');
    expect(result.stages).not.toContain('sanitizer');
  });

  it('sanitizer 检测到注入时仍返回内容（加 warning）', () => {
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
    const result = pipeline.process('exec', 'malicious');
    expect(result.output).toBe('warned content');
    expect(result.stages).toContain('sanitizer');
  });

  it('conciseThinkingEnabled=true 时裁剪过长输出', () => {
    const longOutput = 'a'.repeat(3000);
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: true,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = pipeline.process('read', longOutput);
    expect(result.output.length).toBeLessThan(longOutput.length);
    expect(result.stages).toContain('concise-thinking');
  });

  it('conciseThinkingEnabled=false 时不裁剪', () => {
    const longOutput = 'a'.repeat(3000);
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = pipeline.process('read', longOutput);
    expect(result.output).toBe(longOutput);
  });

  it('sanitizer 抛错时 fail-open 返回原内容', () => {
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
    const result = pipeline.process('read', 'content');
    expect(result.output).toBe('content');
    expect(result.stages).toContain('sanitizer-failed');
  });

  it('budgetEnabled=false 时跳过 offload 阶段', () => {
    const pipeline = new ToolOutputPipeline({
      conciseThinkingEnabled: false,
      budgetEnabled: false,
      offloadDir: '/tmp',
      maxChars: 2000,
    });
    const result = pipeline.process('read', 'a'.repeat(5000));
    expect(result.offloadedPath).toBeUndefined();
    expect(result.stages).not.toContain('budget-offload');
  });

  it('budgetEnabled=true 且输出超长时写入 offload 文件并返回路径（Task D7 实装）', () => {
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
      const result = pipeline.process('read', 'a'.repeat(5000));
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

  it('stages 字段记录所有执行阶段', () => {
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
    const result = pipeline.process('read', 'a'.repeat(3000));
    expect(result.stages).toContain('sanitizer');
    expect(result.stages).toContain('concise-thinking');
  });
});
