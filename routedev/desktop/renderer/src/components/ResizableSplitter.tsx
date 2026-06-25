// desktop/renderer/src/components/ResizableSplitter.tsx
// 可拖动调整宽度的分隔条：放在侧边栏与主内容区之间
// 鼠标按住拖动可调整左侧面板宽度，松开时持久化宽度

import { useCallback, useEffect, useRef, useState } from 'react';

interface ResizableSplitterProps {
  /** 左侧面板当前宽度（px） */
  width: number;
  /** 最小宽度 */
  minWidth: number;
  /** 最大宽度 */
  maxWidth: number;
  /** 宽度变化回调 */
  onWidthChange: (width: number) => void;
  /** 对齐方向：left=左侧面板（默认），right=右侧面板（拖动方向相反） */
  align?: 'left' | 'right';
}

/**
 * 垂直分隔条：拖动调整面板宽度
 * 视觉上是一条 4px 宽的半透明竖线，hover 时高亮
 */
export function ResizableSplitter({
  width,
  minWidth,
  maxWidth,
  onWidthChange,
  align = 'left',
}: ResizableSplitterProps) {
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;
  }, [width]);

  // 全局监听 mousemove/mouseup，使拖动不局限于分隔条内
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = align === 'right'
        ? startXRef.current - e.clientX
        : e.clientX - startXRef.current;
      const newWidth = Math.min(
        Math.max(startWidthRef.current + delta, minWidth),
        maxWidth,
      );
      onWidthChange(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    // 拖动时禁用文本选择和光标闪烁
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, minWidth, maxWidth, onWidthChange, align]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className="relative w-3 shrink-0 cursor-col-resize"
      title="拖动调整宽度"
    >
      {/* 中间竖线：默认透明，hover/drag 时显现 */}
      <div
        className={[
          'absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors',
          isDragging ? 'bg-rd-primary/60' : 'bg-transparent hover:bg-rd-borderHover',
        ].join(' ')}
      />
    </div>
  );
}
