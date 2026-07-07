// desktop/renderer/src/components/chat/StreamIndicator.tsx
// 流式输出指示器：助手正在生成回复时显示的脉冲动画 + 文案
// Phase 74-C：性能基座组件，为后续 74-A/B 接入流式状态展示预留
// 当前未接入渲染树（纯重构不改变视觉效果），子 Phase 可按需引入

import { Loader2 } from 'lucide-react';

export function StreamIndicator({
  isStreaming,
  label = '生成中…',
}: {
  isStreaming: boolean;
  label?: string;
}) {
  if (!isStreaming) return null;
  return (
    <div className="flex items-center gap-1.5 px-1 py-0.5 text-xs text-rd-textSubtle">
      <Loader2 size={12} className="shrink-0 animate-spin text-rd-primary" />
      <span>{label}</span>
    </div>
  );
}
