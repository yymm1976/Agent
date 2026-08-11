import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InputArea } from '../InputArea.js';

function installIpcMock(skills = ['skill-a', 'skill-b', 'skill-c', 'skill-d']) {
  (window as unknown as { routedev: unknown }).routedev = {
    window: { restoreFocus: vi.fn().mockResolvedValue(undefined) },
    skill: {
      list: vi.fn().mockResolvedValue(skills.map((name) => ({ name, description: `${name} description`, enabled: true }))),
    },
    mcp: {
      tools: vi.fn().mockResolvedValue({ tools: [] }),
    },
  };
}

/**
 * GA Release Hygiene Task 4：flush mount 后 async IPC 微任务——
 * skill.list / mcp.tools 是 resolved promise，setState 若不包裹 act 会产生
 * "An update to InputArea inside a test was not wrapped in act(...)" warning。
 */
async function flushIpc() {
  await act(async () => {});
}

describe('InputArea', () => {
  afterEach(() => {
    cleanup();
    (window as unknown as { routedev?: unknown }).routedev = undefined;
  });

  it('uses an accurate text-only placeholder and keeps the capability bar compact', async () => {
    installIpcMock();

    render(
      <InputArea
        isProcessing={false}
        autonomyMode="semi"
        onAutonomyChange={vi.fn().mockResolvedValue(undefined)}
        onSubmit={vi.fn()}
        onFollowUp={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('输入问题开始... Shift+Enter 换行，输入 / 查看命令')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('+1')).toBeTruthy());
    expect(screen.queryByText('skill-d')).toBeNull();
  });

  it('submits the entered text with Enter', async () => {
    installIpcMock([]);
    const onSubmit = vi.fn();

    render(
      <InputArea
        isProcessing={false}
        autonomyMode="semi"
        onAutonomyChange={vi.fn().mockResolvedValue(undefined)}
        onSubmit={onSubmit}
        onFollowUp={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    await flushIpc(); // flush IPC 微任务，避免 act warning

    const input = screen.getByPlaceholderText('输入问题开始... Shift+Enter 换行，输入 / 查看命令');
    fireEvent.change(input, { target: { value: '检查这个项目' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('检查这个项目');
  });

  it('keeps plan, goal and auto approval in one switcher and applies goal mode', async () => {
    installIpcMock([]);
    const onSubmit = vi.fn();

    render(
      <InputArea
        isProcessing={false}
        autonomyMode="semi"
        onAutonomyChange={vi.fn().mockResolvedValue(undefined)}
        onSubmit={onSubmit}
        onFollowUp={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    await flushIpc(); // flush IPC 微任务，避免 act warning

    fireEvent.click(screen.getByText('计划'));
    fireEvent.click(screen.getByText('目标'));
    const input = screen.getByPlaceholderText('输入问题开始... Shift+Enter 换行，输入 / 查看命令');
    fireEvent.change(input, { target: { value: '整理发布流程' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('/goal 整理发布流程');
  });

  it('renders the context ring at text scale and expands details above it', async () => {
    installIpcMock([]);
    render(
      <InputArea
        isProcessing={false}
        autonomyMode="semi"
        onAutonomyChange={vi.fn().mockResolvedValue(undefined)}
        onSubmit={vi.fn()}
        onFollowUp={vi.fn()}
        onStop={vi.fn()}
        contextWindow={1000}
        messages={[{ id: 'm1', role: 'user', content: '上下文内容'.repeat(80), timestamp: 1 }]}
      />,
    );
    await flushIpc(); // flush IPC 微任务，避免 act warning

    const trigger = screen.getByRole('button', { name: /上下文占用 \d+%/ });
    const ring = trigger.querySelector('svg');
    expect(ring?.getAttribute('width')).toBe('14');
    fireEvent.click(trigger);
    expect(screen.getByText('上下文占用')).toBeTruthy();
    expect(screen.getByText('系统')).toBeTruthy();
  });
});
