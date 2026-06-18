// src/utils/token-estimate.ts
// 中文感知的 Token 估算

/**
 * 估算文本的 token 数量（中文感知）
 * - CJK 字符（中日韩统一表意文字）：每字约 1.5 token
 * - 其他字符（英文/数字/标点）：每 4 字符约 1 token
 */
export function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 1.5 + otherChars / 4);
}
