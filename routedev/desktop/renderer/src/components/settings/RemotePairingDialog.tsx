import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Smartphone, X } from 'lucide-react';
import type { RemotePairingView } from '../../../../shared/ipc-types.js';
import { Button } from '../ui/button.js';

interface RemotePairingDialogProps {
  pairing: RemotePairingView | null;
  onClose: () => void;
}

function remainingText(expiresAt: string, now: number): string {
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return remaining === 0
    ? '已过期，请重新生成'
    : `${minutes}:${seconds.toString().padStart(2, '0')} 后过期`;
}

export function RemotePairingDialog({ pairing, onClose }: RemotePairingDialogProps) {
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!pairing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const expiry = useMemo(
    () => pairing ? remainingText(pairing.expiresAt, now) : '',
    [pairing, now],
  );
  if (!pairing) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-pairing-title"
        className="w-full max-w-md rounded-2xl bg-rd-card p-6 shadow-rdLg"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-rd-primary/15 text-rd-primary">
              <Smartphone size={20} />
            </span>
            <div>
              <h2 id="remote-pairing-title" className="text-lg font-semibold text-rd-text">
                用手机扫描
              </h2>
              <p className="mt-1 text-sm text-rd-textMuted">{pairing.desktopName}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭配对窗口">
            <X size={18} />
          </Button>
        </div>

        <div className="mx-auto mt-6 w-fit rounded-2xl bg-white p-3">
          <img
            src={pairing.qrDataUrl}
            alt="RouteDev 一次性手机配对二维码"
            className="h-64 w-64"
          />
        </div>

        <div className="mt-5 flex items-center justify-between gap-3 rounded-xl bg-rd-surfaceHover px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm text-rd-text">{pairing.baseUrl}</p>
            <p className="mt-1 text-xs text-rd-textMuted">{expiry}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={async () => {
              await window.routedev.writeClipboard(pairing.baseUrl);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            }}
            aria-label="复制连接地址"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </Button>
        </div>
        <p className="mt-4 text-sm font-medium text-rd-text">
          {pairing.transport === 'lan' ? '局域网直连：手机和电脑需要在同一 Wi-Fi' : 'HTTPS 远程连接：可跨网络使用'}
        </p>
        <p className="mt-2 text-sm leading-6 text-rd-textMuted">
          {pairing.transport === 'lan'
            ? '请确认两台设备在同一个可信局域网内。'
            : '手机需要加入同一个 tailnet。'}
          {' '}二维码只能使用一次，过期后不会继续有效。
        </p>
      </section>
    </div>
  );
}
