import { Minus, Route, Square, X } from 'lucide-react';

export function TitleBar() {
  return (
    <div
      className="flex h-9 shrink-0 items-center justify-between px-2 pl-3"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-rd-text-muted">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-rd-accent/14 text-rd-accent">
          <Route size={12} strokeWidth={2.2} />
        </span>
        <span>RouteDev</span>
      </div>

      <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          aria-label="最小化窗口"
          className="grid h-7 w-8 place-items-center rounded-md text-rd-text-muted transition-colors hover:bg-rd-surface-hover hover:text-rd-text"
          onClick={() => window.routedev.window.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          aria-label="最大化窗口"
          className="grid h-7 w-8 place-items-center rounded-md text-rd-text-muted transition-colors hover:bg-rd-surface-hover hover:text-rd-text"
          onClick={() => window.routedev.window.maximize()}
        >
          <Square size={12} />
        </button>
        <button
          type="button"
          aria-label="关闭窗口"
          className="grid h-7 w-8 place-items-center rounded-md text-rd-text-muted transition-colors hover:bg-red-500/15 hover:text-red-400"
          onClick={() => window.routedev.window.close()}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
