// tests/cli/components/DisclosureLevel.test.ts
// 渐进披露组件纯文本渲染测试（Phase 25 Task 3）

import { describe, it, expect } from 'vitest';
import { renderDisclosureText } from '../../../src/cli/components/DisclosureLevel.js';

describe('DisclosureLevel: renderDisclosureText', () => {
  it('L1 只返回摘要', () => {
    const content = { l1: '摘要', l2: '细节', l3: '完整' };
    expect(renderDisclosureText(content, 1)).toBe('摘要');
  });

  it('L2 返回细节（如有）', () => {
    const content = { l1: '摘要', l2: '细节', l3: '完整' };
    expect(renderDisclosureText(content, 2)).toBe('细节');
  });

  it('L3 返回完整数据（如有）', () => {
    const content = { l1: '摘要', l2: '细节', l3: '完整' };
    expect(renderDisclosureText(content, 3)).toBe('完整');
  });

  it('L2 缺失时降级到 L1', () => {
    const content = { l1: '摘要' };
    expect(renderDisclosureText(content, 2)).toBe('摘要');
    expect(renderDisclosureText(content, 3)).toBe('摘要');
  });

  it('L3 缺失但 L2 存在时降级到 L2', () => {
    const content = { l1: '摘要', l2: '细节' };
    expect(renderDisclosureText(content, 3)).toBe('细节');
  });

  it('默认层级为 2', () => {
    const content = { l1: '摘要', l2: '细节' };
    expect(renderDisclosureText(content)).toBe('细节');
  });
});
