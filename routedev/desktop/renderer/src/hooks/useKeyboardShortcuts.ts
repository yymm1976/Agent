import { useEffect } from 'react';

export interface ShortcutCallbacks {
  onOpenSettings?: () => void;
  onNewTask?: () => void;
  onToggleSidebar?: () => void;
  onFocusInput?: () => void;
  onStopGeneration?: () => void;
  onNextConversation?: () => void;
  onPrevConversation?: () => void;
}

export function useKeyboardShortcuts(callbacks: ShortcutCallbacks): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+, → 打开设置
      if (ctrl && e.key === ',') {
        e.preventDefault();
        callbacks.onOpenSettings?.();
        return;
      }

      // Ctrl+N → 新建任务
      if (ctrl && e.key === 'n') {
        e.preventDefault();
        callbacks.onNewTask?.();
        return;
      }

      // Ctrl+B → 切换侧边栏
      if (ctrl && e.key === 'b') {
        e.preventDefault();
        callbacks.onToggleSidebar?.();
        return;
      }

      // Ctrl+L → 聚焦输入框
      if (ctrl && e.key === 'l') {
        e.preventDefault();
        callbacks.onFocusInput?.();
        return;
      }

      // Ctrl+Shift+Backspace → 停止生成
      if (ctrl && e.shiftKey && e.key === 'Backspace') {
        e.preventDefault();
        callbacks.onStopGeneration?.();
        return;
      }

      // Ctrl+] → 下一个对话
      if (ctrl && e.key === ']') {
        e.preventDefault();
        callbacks.onNextConversation?.();
        return;
      }

      // Ctrl+[ → 上一个对话
      if (ctrl && e.key === '[') {
        e.preventDefault();
        callbacks.onPrevConversation?.();
        return;
      }

      // Esc → 取消聚焦（不阻止默认行为，让组件自己处理）
      // Esc 不在这里处理，各组件已有自己的 Escape 处理
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [callbacks]);
}
