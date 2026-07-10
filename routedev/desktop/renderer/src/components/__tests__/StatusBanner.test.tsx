// desktop/renderer/src/components/__tests__/StatusBanner.test.tsx
// TD-14：StatusBanner 组件渲染测试（示例：渲染层组件测试基建）
// 验证组件在不同 store 状态下的挂载与空态渲染行为

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// mock useRouteDevStore：避免引入真实 store 的副作用（IPC 订阅等）
vi.mock('../../store/useRouteDevStore.js', () => ({
  useRouteDevStore: (selector: (s: { config: unknown }) => unknown) =>
    selector({ config: null }),
}));

import { StatusBanner } from '../StatusBanner.js';

describe('StatusBanner 组件', () => {
  beforeEach(() => {
    // 清除 window.routedev，模拟无 IPC API 的纯渲染环境
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).routedev = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  it('无通知时正常挂载且不抛错（空态渲染）', () => {
    // 组件内部 items 初始为空，所有横幅区域条件渲染均不触发
    const { container } = render(<StatusBanner />);
    // 空态下仅渲染 <style> 标签，不应出现通知文本
    expect(container.querySelector('style')).not.toBeNull();
    // 不应渲染任何固定定位的通知容器
    expect(container.querySelector('div[style*="position: fixed"]')).toBeNull();
  });

  it('无 window.routedev API 时安全挂载（IPC 订阅为 no-op）', () => {
    // 验证 G-003 修复后：status:* 事件无发送方，组件在无 API 时不报错
    expect(() => render(<StatusBanner />)).not.toThrow();
  });

  it('组件卸载时清理定时器无副作用', () => {
    const { unmount } = render(<StatusBanner />);
    // 卸载不应抛错（验证 useEffect 清理函数正常工作）
    expect(() => unmount()).not.toThrow();
  });
});
