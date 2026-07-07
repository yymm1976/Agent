// desktop/renderer/src/components/chat/ScrollToBottom.tsx
// 跳到底部浮动按钮
// Phase 74-C：从 ChatPage.tsx 抽离，保持渲染结果完全一致

import { ArrowDown } from 'lucide-react';

export function ScrollToBottom({
  visible,
  onClick,
  rightOffset = false,
}: {
  visible: boolean;
  onClick: () => void;
  /** 检查点面板打开时按钮需右移让位 */
  rightOffset?: boolean;
}) {
  if (!visible) return null;
  return (
    <button
      onClick={onClick}
      title="跳到底部"
      className={[
        'absolute bottom-4 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-rd-border bg-rd-background text-rd-textMuted shadow-rdMd transition hover:text-rd-primary hover:border-rd-primary/30',
        rightOffset ? 'right-[21rem]' : 'right-6',
      ].join(' ')}
    >
      <ArrowDown size={16} />
    </button>
  );
}
