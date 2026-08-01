// desktop/renderer/src/hooks/useGlobalInterruptions.ts
// Phase 97 Part C：全局中断消费 hook
//
// 设计目的：
//   在应用顶层挂载一次，渲染层重载后从主进程 reclaim 回未处理中断，
//   写入 store，避免页面切换或组件卸载导致中断请求丢失。
//   审批的实时推送仍走现有 chat 事件流（chat-bridge），本 hook 只负责重载兜底。

import { useEffect } from 'react';
import { useRouteDevStore } from '../store/useRouteDevStore.js';

export function useGlobalInterruptions(): void {
  useEffect(() => {
    let cancelled = false;
    const api = window.routedev?.interruption;
    if (!api) return;

    api
      .reclaim()
      .then((items) => {
        if (!cancelled && items.length > 0) {
          useRouteDevStore.getState()._setReclaimedInterruptions(items);
        }
      })
      .catch(() => {
        // 主进程未就绪或引擎未启动时静默跳过，下次重载再恢复
      });

    return () => {
      cancelled = true;
    };
  }, []);
}
