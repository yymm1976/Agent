// tests/skills/runtime-fallback-detector.test.ts
// 运行时兜底检测器单元测试（Phase 49 Task 3.7）
//
// 测试策略：
//   - 构造 AI 输出字符串（含/不含兜底信号、含/不含确认信号）
//   - 验证"改用"无确认信号时报告违规
//   - 验证"改用"+询问用户时不报告违规
//   - 验证无任何兜底信号时不报告违规

import { describe, it, expect } from 'vitest';
import { RuntimeFallbackDetector } from '../../src/skills/runtime-fallback-detector.js';

describe('RuntimeFallbackDetector (Phase 49 Task 3.7)', () => {
  it('检测到"改用"且无确认信号时报告违规', () => {
    const output = '原方案不可用，改用备用方案完成。';
    const violation = RuntimeFallbackDetector.detect(output);

    expect(violation).not.toBeNull();
    expect(violation!.type).toBe('silent-fallback');
    expect(violation!.signal).toBeTruthy();
    expect(violation!.excerpt).toContain('改用');
    expect(violation!.suggestion).toContain('告知用户');
  });

  it('检测到"改用"且伴随"询问用户"时不报告违规', () => {
    const output = '原方案不可用，改用备用方案，已询问用户确认。';
    const violation = RuntimeFallbackDetector.detect(output);

    expect(violation).toBeNull();
  });

  it('无任何兜底信号时不报告违规', () => {
    const output = '任务正常完成，所有步骤都已执行。';
    const violation = RuntimeFallbackDetector.detect(output);

    expect(violation).toBeNull();
  });

  it('检测到"降级为"且无确认信号时报告违规', () => {
    const output = '高级功能不可用，降级为基础版本。';
    const violation = RuntimeFallbackDetector.detect(output);

    expect(violation).not.toBeNull();
    expect(violation!.type).toBe('silent-fallback');
  });

  it('检测到"回退到"且伴随"等待确认"时不报告违规', () => {
    const output = '新方案异常，回退到旧版本，等待确认后继续。';
    const violation = RuntimeFallbackDetector.detect(output);

    expect(violation).toBeNull();
  });
});
