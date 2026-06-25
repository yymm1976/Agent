// tests/agent/concise-thinking.test.ts
// Phase 30 Task 4：简洁思考约束单元测试
//
// 覆盖验收标准：
//   1. 配置开关正确控制"输出纪律"段落的注入（CONCISE_THINKING_BLOCK 非空）
//   2. 工具返回裁剪在 > 2000 字符时触发
//   3. 工具返回 ≤ 2000 字符时不裁剪
//   4. 用户关键词"详细"、"完整"能临时跳过约束（shouldSkipConcise 返回 true）
//   5. enabled=false 时 trimToolResult 原样返回

import { describe, it, expect } from 'vitest';
import {
  CONCISE_THINKING_BLOCK,
  trimToolResult,
  shouldSkipConcise,
} from '../../src/agent/concise-thinking.js';

// 辅助：生成超长字符串（模拟大工具输出）
function makeLongText(length: number): string {
  return 'A'.repeat(length);
}

describe('concise-thinking（简洁思考约束）', () => {
  // ============================================================
  // CONCISE_THINKING_BLOCK 常量
  // ============================================================

  describe('CONCISE_THINKING_BLOCK', () => {
    it('应是非空字符串，包含"输出纪律"段落', () => {
      // 验收标准 1：配置开关正确控制"输出纪律"段落的注入
      expect(CONCISE_THINKING_BLOCK).toBeTruthy();
      expect(typeof CONCISE_THINKING_BLOCK).toBe('string');
      expect(CONCISE_THINKING_BLOCK.length).toBeGreaterThan(0);
      expect(CONCISE_THINKING_BLOCK).toContain('输出纪律');
    });

    it('应包含核心纪律条目（直接结论、不复述工具返回、思考 5 要点）', () => {
      expect(CONCISE_THINKING_BLOCK).toContain('直接给出结论');
      expect(CONCISE_THINKING_BLOCK).toContain('不要复述工具返回');
      expect(CONCISE_THINKING_BLOCK).toContain('5 个要点');
    });
  });

  // ============================================================
  // trimToolResult() 裁剪逻辑
  // ============================================================

  describe('trimToolResult()', () => {
    it('enabled=false 时应原样返回（不裁剪）', () => {
      // 验收标准 5：enabled=false 时 trimToolResult 原样返回
      const longText = makeLongText(3000);
      const result = trimToolResult(longText, false);
      expect(result).toBe(longText);
      expect(result.length).toBe(3000);
      expect(result).not.toContain('已裁剪');
    });

    it('enabled=true 且长度 > 2000 时应裁剪为 800 首 + 标记 + 800 尾', () => {
      // 验收标准 2：工具返回裁剪在 > 2000 字符时触发
      const longText = makeLongText(3000);
      const result = trimToolResult(longText, true);

      // 应包含裁剪标记
      expect(result).toContain('已裁剪');
      expect(result).toContain('展示完整结果');

      // 被裁掉的字符数 = 3000 - 1600 = 1400
      expect(result).toContain('1400');

      // 应以 800 个 A 开头
      expect(result.startsWith('A'.repeat(800))).toBe(true);
      // 应以 800 个 A 结尾
      expect(result.endsWith('A'.repeat(800))).toBe(true);
    });

    it('enabled=true 且长度 = 2000 时不应裁剪（边界值）', () => {
      // 验收标准 3：工具返回 ≤ 2000 字符时不裁剪
      const boundaryText = makeLongText(2000);
      const result = trimToolResult(boundaryText, true);
      expect(result).toBe(boundaryText);
      expect(result.length).toBe(2000);
      expect(result).not.toContain('已裁剪');
    });

    it('enabled=true 且长度 < 2000 时不应裁剪', () => {
      const shortText = makeLongText(500);
      const result = trimToolResult(shortText, true);
      expect(result).toBe(shortText);
      expect(result).not.toContain('已裁剪');
    });

    it('裁剪标记中的字符数应正确反映被裁剪量', () => {
      // 5000 字符 → 裁掉 5000 - 1600 = 3400 字符
      const longText = makeLongText(5000);
      const result = trimToolResult(longText, true);
      expect(result).toContain('3400');
      // 验证裁剪后总长度 = 800 + 标记长度 + 800
      // 标记格式：\n\n[...已裁剪 3400 字符，如需完整内容请说"展示完整结果"...]\n\n
      const expectedMarker =
        '\n\n[...已裁剪 3400 字符，如需完整内容请说"展示完整结果"...]\n\n';
      expect(result.length).toBe(800 + expectedMarker.length + 800);
    });

    it('空字符串应原样返回', () => {
      expect(trimToolResult('', true)).toBe('');
      expect(trimToolResult('', false)).toBe('');
    });
  });

  // ============================================================
  // shouldSkipConcise() 关键词检测
  // ============================================================

  describe('shouldSkipConcise()', () => {
    it('包含"详细"关键词时应返回 true', () => {
      // 验收标准 4：用户关键词"详细"能临时跳过约束
      expect(shouldSkipConcise('请详细解释一下这段代码')).toBe(true);
      expect(shouldSkipConcise('详细的实现思路是什么')).toBe(true);
    });

    it('包含"完整"关键词时应返回 true', () => {
      // 验收标准 4：用户关键词"完整"能临时跳过约束
      expect(shouldSkipConcise('展示完整结果')).toBe(true);
      expect(shouldSkipConcise('请给我完整的列表')).toBe(true);
    });

    it('包含"全部"关键词时应返回 true', () => {
      expect(shouldSkipConcise('列出全部文件')).toBe(true);
    });

    it('包含英文 "explain in detail" 时应返回 true（大小写不敏感）', () => {
      expect(shouldSkipConcise('Please explain in detail')).toBe(true);
      expect(shouldSkipConcise('EXPLAIN IN DETAIL the architecture')).toBe(true);
      expect(shouldSkipConcise('Could you explain in detail?')).toBe(true);
    });

    it('不含任何关键词时应返回 false', () => {
      expect(shouldSkipConcise('帮我写一个函数')).toBe(false);
      expect(shouldSkipConcise('这段代码有 bug')).toBe(false);
      expect(shouldSkipConcise('什么是闭包')).toBe(false);
    });

    it('空字符串应返回 false', () => {
      expect(shouldSkipConcise('')).toBe(false);
    });

    it('"展示完整"作为复合关键词应被检测到', () => {
      // "展示完整" 是独立关键词，应被识别
      expect(shouldSkipConcise('请展示完整内容')).toBe(true);
    });
  });

  // ============================================================
  // 集成场景：trimToolResult + shouldSkipConcise
  // ============================================================

  describe('集成场景', () => {
    it('用户请求详细输出时，应跳过裁剪（即使 enabled=true）', () => {
      // 模拟上层集成逻辑：先检测 shouldSkipConcise，再决定是否裁剪
      const userMessage = '请详细解释这个工具的输出';
      const toolResult = makeLongText(3000);
      const enabled = true;

      // 用户请求详细 → 跳过约束
      const skip = shouldSkipConcise(userMessage);
      expect(skip).toBe(true);

      // 上层应根据 skip 决定是否调用 trimToolResult
      const effectiveEnabled = enabled && !skip;
      const result = trimToolResult(toolResult, effectiveEnabled);
      expect(result).toBe(toolResult);
      expect(result).not.toContain('已裁剪');
    });

    it('用户未请求详细输出时，应正常应用裁剪', () => {
      const userMessage = '帮我修复这个 bug';
      const toolResult = makeLongText(3000);
      const enabled = true;

      const skip = shouldSkipConcise(userMessage);
      expect(skip).toBe(false);

      const effectiveEnabled = enabled && !skip;
      const result = trimToolResult(toolResult, effectiveEnabled);
      expect(result).toContain('已裁剪');
    });
  });
});
