import { logger } from '../../utils/logger.js';

export interface ToolOutputBudgetConfig {
  maxCharsPerOutput: number;
  previewHeadChars: number;
  previewTailChars: number;
  offloadDir: string;
  enabled: boolean;
}

export const DEFAULT_BUDGET_CONFIG: ToolOutputBudgetConfig = {
  maxCharsPerOutput: 2000,
  previewHeadChars: 500,
  previewTailChars: 500,
  offloadDir: '.routedev/offloaded',
  enabled: false,
};

interface OffloadRecord {
  hash: string;
  filePath: string;
  preview: string;
  originalSize: number;
}

export class ToolOutputBudgetManager {
  private processedHashes = new Map<string, OffloadRecord>();

  constructor(private config: ToolOutputBudgetConfig) {}

  async processMessages<T>(
    messages: T[],
    extractText: (msg: T) => string,
    replaceText: (msg: T, newText: string) => T,
  ): Promise<{ messages: T[]; offloadedCount: number }> {
    if (!this.config.enabled) return { messages, offloadedCount: 0 };
    let offloadedCount = 0;
    const result = [...messages];
    for (let i = 0; i < result.length; i++) {
      const msg = result[i];
      const text = extractText(msg);
      if (text.length <= this.config.maxCharsPerOutput) continue;
      const hash = this.simpleHash(text);
      const existing = this.processedHashes.get(hash);
      if (existing) {
        result[i] = replaceText(msg, existing.preview);
        continue;
      }
      try {
        const filePath = this.buildFilePath(i);
        const preview = this.buildPreview(text, filePath);
        const record: OffloadRecord = { hash, filePath, preview, originalSize: text.length };
        this.processedHashes.set(hash, record);
        result[i] = replaceText(msg, preview);
        offloadedCount++;
      } catch (err) {
        logger.warn('ToolOutputBudgetManager: offload failed, falling back to truncation', {
          index: i,
          error: err instanceof Error ? err.message : String(err),
        });
        const truncated =
          text.slice(0, this.config.previewHeadChars) +
          '[...truncated...]' +
          text.slice(-this.config.previewTailChars);
        result[i] = replaceText(msg, truncated);
        offloadedCount++;
      }
    }
    return { messages: result, offloadedCount };
  }

  getProcessedCount(): number {
    return this.processedHashes.size;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  private buildFilePath(index: number): string {
    const filename = `output-${index}-${Date.now()}.txt`;
    return `${this.config.offloadDir}/${filename}`;
  }

  private buildPreview(content: string, filePath: string): string {
    const head = content.slice(0, this.config.previewHeadChars);
    const tail = content.slice(-this.config.previewTailChars);
    return `<persisted-output file="${filePath}" size="${content.length}">\n${head}\n[...saved locally, ${content.length} chars total...]\n${tail}\n</persisted-output>`;
  }

  private simpleHash(text: string): string {
    let hash = 0;
    for (let i = 0; i < Math.min(text.length, 1000); i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }
}
