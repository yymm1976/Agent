// src/code-map/token-counter.ts
// Phase 71：tiktoken 精确计 token，替代 length/4 估算
import { encoding_for_model, type Tiktoken } from 'tiktoken';

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    // 用 cl100k_base（GPT-4/Claude 3 通用编码），对中文代码混排准确度最高
    encoder = encoding_for_model('gpt-4');
  }
  return encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return getEncoder().encode(text).length;
  } catch (e) {
    // fail-open：tiktoken wasm 加载失败时回退到 length/4
    // eslint-disable-next-line no-console
    console.warn(`[token-counter] tiktoken 编码失败，回退到 length/4: ${e instanceof Error ? e.message : String(e)}`);
    return Math.ceil(text.length / 4);
  }
}

/** 测试用：释放 encoder（tiktoken wasm 资源） */
export function freeEncoder(): void {
  encoder?.free();
  encoder = null;
}
