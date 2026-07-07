// desktop/renderer/src/components/tool/ansi-renderer.ts
// Phase 74-A1：ANSI 颜色解析——把含 \x1b[xxm 转义序列的命令输出转为 HTML
// 使用 ansi_up 库（~8KB，默认 XSS 安全，零依赖）

import { escapeHtml } from './escape';
import { AnsiUp } from 'ansi_up';

const ansi = new AnsiUp();
ansi.use_classes = false; // 输出内联 style，便于直接渲染

/**
 * 把含 ANSI 转义的字符串转为可安全渲染的 HTML 片段
 * - 先 escapeHtml 防注入
 * - 再用 ansi_up 解析 \x1b[xxm 序列转为 <span style="color:..."> 标签
 */
export function ansiToHtml(text: string): string {
  if (!text) return '';
  // ansi_up 自带 toHtml，但输入需先转义避免 <script> 等
  const escaped = escapeHtml(text);
  return ansi.ansi_to_html(escaped);
}

/**
 * 头尾保留策略（Phase 74-A2）：
 * - 头部 HEAD_LINES 行 + 尾部 TAIL_LINES 行 + 中段折叠
 * - 行数 <= HEAD + TAIL + 1 时全量返回（无需折叠）
 * - 返回 { head, tail, foldedCount } 三段，由调用方决定如何渲染折叠按钮
 */
export function splitHeadTail(
  text: string,
  headLines = 3,
  tailLines = 5
): { head: string; tail: string; foldedCount: number } {
  if (!text) return { head: '', tail: '', foldedCount: 0 };
  const lines = text.split('\n');
  const total = lines.length;
  const threshold = headLines + tailLines + 1;
  if (total <= threshold) {
    return { head: text, tail: '', foldedCount: 0 };
  }
  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(total - tailLines).join('\n');
  return { head, tail, foldedCount: total - headLines - tailLines };
}
