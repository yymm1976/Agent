// tests/cli/components/BranchSwitcher.test.ts
// BranchSwitcher 分支树可视化测试（Phase 25 Task 1）

import { describe, it, expect, vi } from 'vitest';
import { renderBranchTreeText, formatRelativeTime } from '../../../src/cli/components/BranchSwitcher.js';
import type { BranchInfo } from '../../../src/agent/branch.js';

describe('BranchSwitcher: formatRelativeTime', () => {
  it('格式化相对时间', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    expect(formatRelativeTime(now - 30 * 1000)).toBe('30秒前');
    expect(formatRelativeTime(now - 5 * 60 * 1000)).toBe('5分钟前');
    expect(formatRelativeTime(now - 3 * 60 * 60 * 1000)).toBe('3小时前');
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60 * 1000)).toBe('2天前');
    vi.useRealTimers();
  });
});

describe('BranchSwitcher: renderBranchTreeText', () => {
  it('空分支列表返回提示', () => {
    const text = renderBranchTreeText([], null);
    expect(text).toContain('没有分支');
  });

  it('渲染当前分支高亮', () => {
    const branches: BranchInfo[] = [
      { id: 'main', name: 'main', tipNodeId: 'n1', messageCount: 12, isActive: true, createdAt: 0, parentId: null, lastActiveAt: Date.now() },
    ];
    const text = renderBranchTreeText(branches, 'main');
    expect(text).toContain('● main');
    expect(text).toContain('12 条消息');
    expect(text).toContain('/branch switch');
  });

  it('非当前分支使用空心圆', () => {
    const branches: BranchInfo[] = [
      { id: 'main', name: 'main', tipNodeId: 'n1', messageCount: 12, isActive: true, createdAt: 0, parentId: null, lastActiveAt: Date.now() },
      { id: 'feat', name: 'feature-auth', tipNodeId: 'n2', messageCount: 5, isActive: false, createdAt: 1, parentId: 'main', lastActiveAt: Date.now() },
    ];
    const text = renderBranchTreeText(branches, 'main');
    expect(text).toContain('● main');
    expect(text).toContain('○ feature-auth');
  });

  it('树形结构使用 ├─ 和 └─ 连接符', () => {
    const branches: BranchInfo[] = [
      { id: 'main', name: 'main', tipNodeId: 'n1', messageCount: 1, isActive: true, createdAt: 0, parentId: null, lastActiveAt: Date.now() },
      { id: 'a', name: 'a', tipNodeId: 'n2', messageCount: 1, isActive: false, createdAt: 1, parentId: 'main', lastActiveAt: Date.now() },
      { id: 'b', name: 'b', tipNodeId: 'n3', messageCount: 1, isActive: false, createdAt: 2, parentId: 'main', lastActiveAt: Date.now() },
    ];
    const text = renderBranchTreeText(branches, 'main');
    expect(text).toContain('├─');
    expect(text).toContain('└─');
  });

  it('分页显示页码', () => {
    const branches: BranchInfo[] = Array.from({ length: 12 }, (_, i) => ({
      id: `b${i}`,
      name: `branch-${i}`,
      tipNodeId: `n${i}`,
      messageCount: 1,
      isActive: false,
      createdAt: i,
      parentId: null,
      lastActiveAt: Date.now(),
    }));
    const text = renderBranchTreeText(branches, null, 0, 10);
    expect(text).toContain('页 1/2');
  });
});
