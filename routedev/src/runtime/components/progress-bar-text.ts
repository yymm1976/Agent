// src/runtime/components/progress-bar-text.ts
// 从 ProgressBar.tsx 抽出，纯字符串函数无 UI 依赖
// 切断 goal-progress.ts → ProgressBar.tsx(ink) 的传递依赖链

const FILLED = '█';
const EMPTY = '░';

/** 渲染进度条文本 */
export function renderProgressBar(
  current: number,
  total: number,
  width = 35,
): string {
  if (total <= 0) {
    return FILLED.repeat(width);
  }
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return FILLED.repeat(filled) + EMPTY.repeat(empty);
}
