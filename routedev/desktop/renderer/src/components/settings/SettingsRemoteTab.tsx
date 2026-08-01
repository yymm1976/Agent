import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Loader2,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  WifiOff,
} from 'lucide-react';
import type { AppConfig } from '../../../../shared/config-types.js';
import type {
  RemoteGatewayStatus,
  RemotePairingView,
} from '../../../../shared/ipc-types.js';
import {
  REMOTE_DEVICE_SCOPES,
  type RemoteDevice,
  type RemoteDeviceScope,
} from '../../../../shared/remote-protocol.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Switch } from '../ui/switch.js';
import { RemotePairingDialog } from './RemotePairingDialog.js';

interface SettingsRemoteTabProps {
  draft: AppConfig;
  updateDraft: (patch: Partial<AppConfig>) => void;
  applyConfig: () => Promise<void>;
}

const SCOPE_LABELS: Record<RemoteDeviceScope, string> = {
  'sessions:read': '查看任务',
  'messages:send': '新建对话与发消息',
  'tasks:stop': '停止任务',
  'approvals:resolve': '在手机上批准工具',
  'skills:select': '选择 Skill',
  'mcp:select': '选择 MCP',
  'autonomy:change': '修改自主模式',
};

function formatLastSeen(value: string | null): string {
  if (!value) return '尚未连接';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function SettingsRemoteTab({
  draft,
  updateDraft,
  applyConfig,
}: SettingsRemoteTabProps) {
  const [status, setStatus] = useState<RemoteGatewayStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [pairing, setPairing] = useState<RemotePairingView | null>(null);
  const [busy, setBusy] = useState<'apply' | 'pair' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy('refresh');
    setError(null);
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        window.routedev.remote.status(),
        window.routedev.remote.listDevices(),
      ]);
      setStatus(nextStatus);
      setDevices(nextDevices);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法读取远程连接状态');
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateRemote = (patch: Partial<AppConfig['remote']>) => {
    updateDraft({ remote: { ...draft.remote, ...patch } });
  };

  const activeDevices = useMemo(
    () => devices.filter((device) => !device.revokedAt),
    [devices],
  );
  const connectionBaseUrl = draft.remote.transport === 'lan'
    ? (draft.remote.lanBaseUrl || status?.baseUrl || '')
    : draft.remote.tailscaleBaseUrl;
  const serveCommand = `tailscale serve --bg http://127.0.0.1:${draft.remote.port}`;

  const applyAndRestart = async () => {
    setBusy('apply');
    setError(null);
    try {
      await applyConfig();
      const next = await window.routedev.remote.restart();
      setStatus(next);
      setDevices(await window.routedev.remote.listDevices());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '连接服务启动失败');
    } finally {
      setBusy(null);
    }
  };

  const createPairing = async () => {
    setBusy('pair');
    setError(null);
    try {
      setPairing(await window.routedev.remote.createPairing());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法生成配对二维码');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-4xl pb-10">
      <div className="flex flex-wrap items-start justify-between gap-5 rounded-2xl bg-rd-surfaceHover p-6 shadow-rd">
        <div className="max-w-2xl">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-rd-primary/15 text-rd-primary">
              <MonitorSmartphone size={22} />
            </span>
            <div>
              <h2 className="text-xl font-semibold text-rd-text">手机远程连接</h2>
              <p className="mt-1 text-sm text-rd-textMuted">
                在安卓手机上查看任务、新建对话，并在任务完成时收到通知。
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-2 text-sm text-rd-textMuted sm:grid-cols-3">
            <span>电脑必须保持在线</span>
            <span>手机需加入同一 tailnet</span>
            <span>没有云端中继</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-2 text-sm ${status?.running ? 'text-rd-success' : 'text-rd-textMuted'}`}>
            {status?.running ? <CheckCircle2 size={16} /> : <WifiOff size={16} />}
            {status?.running ? '服务运行中' : '服务未运行'}
          </span>
          <Switch
            checked={draft.remote.enabled}
            onCheckedChange={(enabled) => updateRemote({ enabled })}
            aria-label="开启手机远程连接"
          />
        </div>
      </div>

      <section className="mt-8 rounded-2xl bg-rd-surfaceHover p-6 shadow-rd">
        <h3 className="text-base font-semibold text-rd-text">连接方式</h3>
        <p className="mt-1 text-sm leading-6 text-rd-textMuted">
          局域网模式不需要第三方软件；只有跨网络访问时才需要 Tailscale 或其他 HTTPS 通道。
        </p>
        <select
          className="mt-4 h-10 w-full rounded-lg border border-rd-border bg-rd-background px-3 text-sm text-rd-text"
          value={draft.remote.transport}
          onChange={(event) => updateRemote({ transport: event.target.value as 'lan' | 'tailscale' })}
        >
          <option value="lan">局域网直连（同一 Wi-Fi）</option>
          <option value="tailscale">Tailscale（跨网络 HTTPS）</option>
        </select>
      </section>

      <section className="mt-8">
        <h3 className="text-base font-semibold text-rd-text">连接地址</h3>
        <p className="hidden mt-1 max-w-2xl text-sm leading-6 text-rd-textMuted">
          RouteDev 只监听本机地址。Tailscale Serve 负责 HTTPS 和跨网络连接，不会把端口直接暴露到公网。
        </p>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-rd-textMuted">
          {draft.remote.transport === 'lan'
            ? '手机和电脑连在同一 Wi-Fi 即可直连；不会使用第三方中转服务。'
            : '跨网络连接需要 HTTPS 地址，例如 Tailscale Serve 提供的地址。'}
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_140px]">
          <label className="min-w-0">
            <span className="mb-2 block text-sm font-medium text-rd-text">
              {draft.remote.transport === 'lan' ? '局域网地址' : 'Tailscale HTTPS 地址'}
            </span>
            <Input
              value={draft.remote.transport === 'lan' ? draft.remote.lanBaseUrl : draft.remote.tailscaleBaseUrl}
              placeholder={draft.remote.transport === 'lan' ? 'http://192.168.1.20:43117' : 'https://your-pc.tailnet-name.ts.net'}
              onChange={(event) => updateRemote(
                draft.remote.transport === 'lan'
                  ? { lanBaseUrl: event.target.value.trim() }
                  : { tailscaleBaseUrl: event.target.value.trim() },
              )}
            />
          </label>
          <label>
            <span className="mb-2 block text-sm font-medium text-rd-text">本机端口</span>
            <Input
              type="number"
              min={1024}
              max={65535}
              value={draft.remote.port}
              onChange={(event) => updateRemote({ port: Number(event.target.value) || 43117 })}
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void applyAndRestart()} disabled={busy !== null}>
            {busy === 'apply' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            保存并应用
          </Button>
          <Button
            variant="outline"
            className={draft.remote.transport === 'lan' ? 'hidden' : undefined}
            onClick={async () => {
              await window.routedev.writeClipboard(serveCommand);
            }}
          >
            <Copy size={16} /> 复制 Tailscale 命令
          </Button>
          <code className="rounded-lg bg-rd-background px-3 py-2 text-xs text-rd-textMuted">
             {draft.remote.transport === 'lan' ? (status?.baseUrl || `http://192.168.x.x:${draft.remote.port}`) : `127.0.0.1:${draft.remote.port}`}
          </code>
        </div>
      </section>

      <section className="mt-9 rounded-2xl bg-rd-surfaceHover p-6 shadow-rd">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-rd-text">配对新手机</h3>
            <p className="mt-1 text-sm text-rd-textMuted">二维码五分钟内有效，并且只能使用一次。</p>
          </div>
          <Button
            onClick={() => void createPairing()}
             disabled={!status?.running || !connectionBaseUrl || busy !== null}
          >
            {busy === 'pair' ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            生成二维码
          </Button>
        </div>
      </section>

      <section className="mt-9">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-rd-text">已配对设备</h3>
            <p className="mt-1 text-sm text-rd-textMuted">
              {activeDevices.length > 0 ? `${activeDevices.length} 台设备可以连接` : '还没有手机完成配对'}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={busy !== null}>
            <RefreshCw size={15} className={busy === 'refresh' ? 'animate-spin' : ''} /> 刷新
          </Button>
        </div>

        {activeDevices.length === 0 ? (
          <div className="mt-4 flex min-h-36 flex-col items-center justify-center rounded-2xl bg-rd-surfaceHover px-6 text-center">
            <Smartphone size={24} className="text-rd-textMuted" />
            <p className="mt-3 text-sm font-medium text-rd-text">扫描二维码后，手机会出现在这里</p>
            <p className="mt-1 text-sm text-rd-textMuted">你可以随时收回权限或撤销设备。</p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {activeDevices.map((device) => (
              <div key={device.deviceId} className="rounded-2xl bg-rd-surfaceHover p-5 shadow-rd">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-rd-background text-rd-textMuted">
                      <Smartphone size={18} />
                    </span>
                    <div>
                      <p className="font-medium text-rd-text">{device.deviceName}</p>
                      <p className="mt-1 text-xs text-rd-textMuted">
                        最近连接：{formatLastSeen(device.lastSeenAt)}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-rd-danger hover:text-rd-danger"
                    onClick={async () => {
                      const choice = await window.routedev.showMessage({
                        type: 'warning',
                        title: '撤销这台设备？',
                        message: `撤销后，“${device.deviceName}”会立即断开，需要重新扫码才能连接。`,
                        buttons: ['撤销设备', '取消'],
                      });
                      if (choice !== 0) return;
                      await window.routedev.remote.revokeDevice(device.deviceId);
                      await refresh();
                    }}
                  >
                    <Trash2 size={15} /> 撤销
                  </Button>
                </div>
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-3">
                  {REMOTE_DEVICE_SCOPES.map((scope) => {
                    const riskyDisabled =
                      (scope === 'approvals:resolve' && !draft.remote.allowRemoteApprovals)
                      || (scope === 'autonomy:change' && !draft.remote.allowAutonomyChange);
                    return (
                      <label key={scope} className="flex items-center gap-2 text-sm text-rd-textMuted">
                        <input
                          type="checkbox"
                          checked={device.scopes.includes(scope)}
                          disabled={riskyDisabled}
                          onChange={async (event) => {
                            const scopes = event.target.checked
                              ? [...device.scopes, scope]
                              : device.scopes.filter((item) => item !== scope);
                            const updated = await window.routedev.remote.updateDeviceScopes(
                              device.deviceId,
                              scopes,
                            );
                            if (updated) {
                              setDevices((current) => current.map((item) =>
                                item.deviceId === updated.deviceId ? updated : item,
                              ));
                            }
                          }}
                          className="h-4 w-4 accent-[var(--rd-primary)]"
                        />
                        {SCOPE_LABELS[scope]}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-9 rounded-2xl bg-rd-surfaceHover p-6 shadow-rd">
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className="mt-0.5 shrink-0 text-rd-primary" />
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-rd-text">高风险权限默认关闭</h3>
            <p className="mt-1 text-sm leading-6 text-rd-textMuted">
              手机默认可以看任务、发消息、停止任务和选择能力；批准工具与修改自主模式需要你显式开启。
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="flex items-center justify-between gap-4 rounded-xl bg-rd-background px-4 py-3">
                <span className="text-sm text-rd-text">允许手机批准工具</span>
                <Switch
                  checked={draft.remote.allowRemoteApprovals}
                  onCheckedChange={(allowRemoteApprovals) => updateRemote({ allowRemoteApprovals })}
                />
              </label>
              <label className="flex items-center justify-between gap-4 rounded-xl bg-rd-background px-4 py-3">
                <span className="text-sm text-rd-text">允许手机修改自主模式</span>
                <Switch
                  checked={draft.remote.allowAutonomyChange}
                  onCheckedChange={(allowAutonomyChange) => updateRemote({ allowAutonomyChange })}
                />
              </label>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="mt-5 rounded-xl bg-rd-danger/10 px-4 py-3 text-sm text-rd-danger" role="alert">
          {error}
        </div>
      )}

      <RemotePairingDialog pairing={pairing} onClose={() => setPairing(null)} />
    </div>
  );
}
