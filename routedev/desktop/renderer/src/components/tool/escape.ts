// desktop/renderer/src/components/tool/escape.ts
// 简易 HTML 转义——避免 ansi_up 输入含 <script> 等标签时被注入
// 仅在 ansi-renderer.ts 中使用，独立模块便于测试

/**
 * 转义 HTML 特殊字符：& < > " '
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
