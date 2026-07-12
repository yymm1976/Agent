// src/code-map/token-counter.ts
// Phase 71：tiktoken 精确计 token，替代 length/4 估算
// G-F030：tiktoken 改为可选依赖，后台异步加载 + 降级估算（保持同步接口）
import { logger } from '../utils/logger.js';

// tiktoken encoder 类型（避免静态 import 导致可选依赖变为必需）
interface TiktokenEncoder {
  encode: (text: string) => { length: number };
  free: () => void;
}

let encoder: TiktokenEncoder | null = null;
let encoderLoadFailed = false;

// 模块加载时启动后台异步加载，不阻断调用方
// 首次调用 countTokens 时 encoder 可能尚未就绪，降级为 length/4 估算
// 加载完成后后续调用自动切换为精确计数
(async () => {
  try {
    const { encoding_for_model } = await import('tiktoken');
    encoder = encoding_for_model('gpt-4') as unknown as TiktokenEncoder;
  } catch (err) {
    encoderLoadFailed = true;
    logger.warn('[TokenCounter] tiktoken 不可用，降级为 length/4 估算', { err });
  }
})();

/**
 * 同步计 token 数
 * - tiktoken 已加载：精确计数
 * - tiktoken 未加载或不可用：降级为 length/4 估算（约 90% 精度）
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch (e) {
      logger.warn('[TokenCounter] tiktoken 编码失败，回退到 length/4 估算', { err: e });
    }
  }
  // tiktoken 未加载完成或不可用：降级为 length/4 估算
  return Math.ceil(text.length / 4);
}

/** 测试用：释放 encoder（tiktoken wasm 资源） */
export function freeEncoder(): void {
  encoder?.free();
  encoder = null;
  encoderLoadFailed = false;
}
