import { Minus, Square, X } from 'lucide-react';

export function TitleBar() {
  return (
    <div
      className="flex h-8 shrink-0 items-center justify-end gap-1 px-2"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => window.routedev.window.minimize()}
          className="flex h-6 w-6 items-center justify-center rounded text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
          title="最小化"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => window.routedev.window.maximize()}
          className="flex h-6 w-6 items-center justify-center rounded text-rd-textSubtle transition hover:bg-rd-surfaceHover hover:text-rd-text"
          title="最大化/还原"
        >
          <Square size={11} />
        </button>
        <button
          onClick={() => window.routedev.window.close()}
          className="flex h-6 w-6 items-center justify-center rounded text-rd-textSubtle transition hover:bg-rd-danger/80 hover:text-white"
          title="关闭"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
