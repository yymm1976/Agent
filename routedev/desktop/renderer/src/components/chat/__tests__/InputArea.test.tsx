import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('submits the entered text with Enter', () => {
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

    const input = screen.getByPlaceholderText('输入问题开始... Shift+Enter 换行，输入 / 查看命令');
    fireEvent.change(input, { target: { value: '检查这个项目' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('检查这个项目');
  });
});
