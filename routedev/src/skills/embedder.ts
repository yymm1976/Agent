// src/skills/embedder.ts
// Embedder 接口与降级实现
//
// 论文：all-MiniLM-L6-v2（384 维）+ FAISS 精确内积
// 降级：HashEmbedder（384 维稀疏哈希向量，无需外部模型）

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

const DIM = 384;

function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

function hashEmbed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  for (const w of words) {
    const h = hashCode(w);
    const idx = h % DIM;
    const sign = (h >>> 31) === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export class HashEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    return hashEmbed(text);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(hashEmbed);
  }
}

export class TransformersEmbedder implements Embedder {
  private pipeline: ((text: string, opts: unknown) => Promise<{ data: Float32Array }>) | null = null;
  private ready = false;
  private initError: string | null = null;

  async initialize(modelId: string): Promise<boolean> {
    try {
      const mod = await import('@xenova/transformers' as string);
      const pipe = await mod.pipeline('feature-extraction', modelId);
      // mod 为动态 import（非字面量路径）返回 any，pipe 即目标函数类型，直接赋值
      this.pipeline = pipe;
      this.ready = true;
      return true;
    } catch (e) {
      this.initError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.pipeline) throw new Error(`TransformersEmbedder not ready: ${this.initError}`);
    const out = await this.pipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
