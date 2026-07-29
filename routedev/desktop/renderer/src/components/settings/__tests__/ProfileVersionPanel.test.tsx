// desktop/renderer/src/components/settings/__tests__/ProfileVersionPanel.test.tsx
// Phase 94：ProfileVersionPanel 组件测试
// 覆盖：空态 / 版本列表 / Diff 展开 / 回滚确认 / refreshKey 重载

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { FieldDiff, VersionMeta } from '../../../../../shared/ipc-types.js';
import { ProfileVersionPanel } from '../ProfileVersionPanel.js';

// ============================================================
// Mock 数据
// ============================================================

const VERSION_A: VersionMeta = {
  versionId: 'ver-a',
  profileId: 'profile-1',
  timestamp: new Date('2026-03-20T10:00:00').getTime(),
  source: 'user_edit',
  fieldChanges: ['modelId', 'systemPrompt'],
  changeSummary: '调整模型与提示词',
  label: '编辑 v1',
};

const VERSION_B: VersionMeta = {
  versionId: 'ver-b',
  profileId: 'profile-1',
  timestamp: new Date('2026-03-21T12:30:00').getTime(),
  source: 'programmatic_write',
  fieldChanges: ['temperature'],
  changeSummary: '程序写入 temperature',
};

const DIFFS: FieldDiff[] = [
  { field: 'modelId', before: 'gpt-4o-mini', after: 'gpt-4o' },
  { field: 'temperature', before: 0.2, after: 0.7 },
];

// ============================================================
// Helpers
// ============================================================

type ProfileApiMock = {
  listVersions: ReturnType<typeof vi.fn>;
  diffCurrentWith: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
};

function installProfileApi(overrides: Partial<ProfileApiMock> = {}): ProfileApiMock {
  const api: ProfileApiMock = {
    listVersions: vi.fn().mockResolvedValue([]),
    diffCurrentWith: vi.fn().mockResolvedValue([]),
    rollback: vi.fn().mockResolvedValue({ success: true, id: 'profile-1' }),
    ...overrides,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).routedev = {
    profile: api,
  };

  return api;
}

// ============================================================
// Tests
// ============================================================

describe('ProfileVersionPanel', () => {
  afterEach(() => {
    cleanup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).routedev;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('加载空列表时展示「暂无版本历史」', async () => {
    const api = installProfileApi({
      listVersions: vi.fn().mockResolvedValue([]),
    });

    render(<ProfileVersionPanel profileId="profile-1" />);

    await waitFor(() => {
      expect(api.listVersions).toHaveBeenCalledWith('profile-1');
    });
    expect(await screen.findByText('暂无版本历史')).toBeInTheDocument();
    expect(screen.getByTestId('profile-version-panel')).toBeInTheDocument();
  });

  it('有版本时渲染时间轴、来源标签与字段数', async () => {
    installProfileApi({
      listVersions: vi.fn().mockResolvedValue([VERSION_A, VERSION_B]),
    });

    render(<ProfileVersionPanel profileId="profile-1" />);

    expect(await screen.findByText('编辑 v1')).toBeInTheDocument();
    expect(screen.getByText('程序写入 temperature')).toBeInTheDocument();
    expect(screen.getByText('用户编辑')).toBeInTheDocument();
    expect(screen.getByText('程序写入')).toBeInTheDocument();
    expect(screen.getByText('2 字段')).toBeInTheDocument();
    expect(screen.getByText('1 字段')).toBeInTheDocument();

    const items = screen.getAllByTestId('version-item');
    expect(items).toHaveLength(2);
  });

  it('listVersions 失败时展示错误与重试', async () => {
    const listVersions = vi
      .fn()
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce([VERSION_A]);
    installProfileApi({ listVersions });

    render(<ProfileVersionPanel profileId="profile-1" />);

    expect(await screen.findByText('网络错误')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByText('编辑 v1')).toBeInTheDocument();
    expect(listVersions).toHaveBeenCalledTimes(2);
  });

  it('选中版本后调用 diffCurrentWith 并渲染字段 Diff', async () => {
    const api = installProfileApi({
      listVersions: vi.fn().mockResolvedValue([VERSION_A]),
      diffCurrentWith: vi.fn().mockResolvedValue(DIFFS),
    });

    render(<ProfileVersionPanel profileId="profile-1" />);

    expect(await screen.findByText('编辑 v1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('编辑 v1'));

    await waitFor(() => {
      expect(api.diffCurrentWith).toHaveBeenCalledWith('profile-1', 'ver-a');
    });

    expect(await screen.findByText('与当前版本的差异')).toBeInTheDocument();
    const rows = await screen.findAllByTestId('field-diff-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('modelId')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
  });

  it('无字段差异时展示一致提示', async () => {
    installProfileApi({
      listVersions: vi.fn().mockResolvedValue([VERSION_A]),
      diffCurrentWith: vi.fn().mockResolvedValue([]),
    });

    render(<ProfileVersionPanel profileId="profile-1" />);
    expect(await screen.findByText('编辑 v1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('编辑 v1'));

    expect(await screen.findByText('无字段差异（与当前一致）')).toBeInTheDocument();
  });

  it('再次点击已选版本可收起 Diff', async () => {
    const api = installProfileApi({
      listVersions: vi.fn().mockResolvedValue([VERSION_A]),
      diffCurrentWith: vi.fn().mockResolvedValue(DIFFS),
    });

    render(<ProfileVersionPanel profileId="profile-1" />);
    expect(await screen.findByText('编辑 v1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('编辑 v1'));
    expect(await screen.findByText('与当前版本的差异')).toBeInTheDocument();
    expect(api.diffCurrentWith).toHaveBeenCalledTimes(1);

    // 再次点击同一版本 → 收起
    fireEvent.click(screen.getByText('编辑 v1'));
    await waitFor(() => {
      expect(screen.queryByText('与当前版本的差异')).toBeNull();
    });
  });

  it('确认回滚成功后刷新列表、展示结果并回调父组件', async () => {
    const onRollbackSuccess = vi.fn();
    const api = installProfileApi({
      listVersions: vi
        .fn()
        .mockResolvedValueOnce([VERSION_A])
        .mockResolvedValueOnce([
          {
            ...VERSION_A,
            versionId: 'ver-rollback',
            source: 'rollback',
            changeSummary: '回滚到 ver-a',
            label: '回滚记录',
          },
          VERSION_A,
        ]),
      diffCurrentWith: vi.fn().mockResolvedValue(DIFFS),
      rollback: vi.fn().mockResolvedValue({ success: true, id: 'profile-1' }),
    });

    render(
      <ProfileVersionPanel
        profileId="profile-1"
        onRollbackSuccess={onRollbackSuccess}
      />,
    );

    expect(await screen.findByText('编辑 v1')).toBeInTheDocument();
    fireEvent.click(screen.getByText('编辑 v1'));
    expect(await screen.findByText('回滚到此版本')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /回滚到此版本/ }));
    // 确认对话框标题与按钮文本均为「确认回滚」，用 getAllByText 验证至少出现一个
    expect(await screen.findAllByText('确认回滚')).not.toHaveLength(0);

    fireEvent.click(screen.getByTestId('confirm-rollback-btn'));

    await waitFor(() => {
      expect(api.rollback).toHaveBeenCalledWith('profile-1', 'ver-a');
    });
    await waitFor(() => {
      expect(onRollbackSuccess).toHaveBeenCalledWith('profile-1');
    });
    expect(await screen.findByTestId('rollback-result')).toHaveTextContent('回滚成功');
    // 回滚后会再次 listVersions
    expect(api.listVersions.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('回滚失败时在确认框内展示错误信息', async () => {
    const api = installProfileApi({
      listVersions: vi.fn().mockResolvedValue([VERSION_A]),
      diffCurrentWith: vi.fn().mockResolvedValue([]),
      rollback: vi.fn().mockResolvedValue({ success: false, error: '目标版本不存在' }),
    });

    render(<ProfileVersionPanel profileId="profile-1" />);

    expect(await screen.findByText('编辑 v1')).toBeInTheDocument();
    fireEvent.click(screen.getByText('编辑 v1'));
    fireEvent.click(await screen.findByRole('button', { name: /回滚到此版本/ }));
    fireEvent.click(screen.getByTestId('confirm-rollback-btn'));

    await waitFor(() => {
      expect(api.rollback).toHaveBeenCalled();
    });
    expect(await screen.findByText('目标版本不存在')).toBeInTheDocument();
    // 确认框仍在：标题与按钮文本均为「确认回滚」，用 getAllByText 验证至少一个
    expect(screen.getAllByText('确认回滚')).not.toHaveLength(0);
  });

  it('refreshKey 变化时重新加载版本列表', async () => {
    const listVersions = vi
      .fn()
      .mockResolvedValueOnce([VERSION_A])
      .mockResolvedValueOnce([VERSION_A, VERSION_B]);
    installProfileApi({ listVersions });

    const { rerender } = render(
      <ProfileVersionPanel profileId="profile-1" refreshKey={0} />,
    );

    expect(await screen.findByText('编辑 v1')).toBeInTheDocument();
    expect(listVersions).toHaveBeenCalledTimes(1);

    rerender(<ProfileVersionPanel profileId="profile-1" refreshKey={1} />);

    await waitFor(() => {
      expect(listVersions).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('程序写入 temperature')).toBeInTheDocument();
  });

  it('showHeader=false 时不渲染标题栏', async () => {
    installProfileApi({
      listVersions: vi.fn().mockResolvedValue([]),
    });

    render(<ProfileVersionPanel profileId="profile-1" showHeader={false} />);

    await waitFor(() => {
      expect(screen.getByText('暂无版本历史')).toBeInTheDocument();
    });
    expect(screen.queryByText('版本历史')).toBeNull();
  });
});
