// src/agent/vision.ts
// VisionAssistant：多模态视觉辅助
// 用有视觉能力的模型（如 MiMoV2.5）分析图片，生成文字描述
// 然后将描述注入给主力文本模型（如 GLM5.2）继续推理

import type { ILLMClient, LLMMessage, ImageContent, ModelConfig } from '../router/types.js';
import type { ProviderConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 图片输入 */
export interface ImageInput {
  data: string;
  mediaType: string;
  fileName?: string;
}

/** 视觉分析结果 */
export interface VisionResult {
  description: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

/** 视觉模型选择结果 */
export interface VisionModelSelection {
  model: ModelConfig;
  providerId: string;
  client: ILLMClient;
}

export class VisionAssistant {
  private providers: ProviderConfig[];
  private clientGetter: (providerId: string) => ILLMClient | undefined;

  constructor(
    providers: ProviderConfig[],
    clientGetter: (providerId: string) => ILLMClient | undefined,
  ) {
    this.providers = providers;
    this.clientGetter = clientGetter;
  }

  findVisionModel(): VisionModelSelection | null {
    for (const provider of this.providers) {
      for (const model of provider.models) {
        if (model.capabilities.includes('multimodal') && model.available) {
          const client = this.clientGetter(provider.id);
          if (client && client.isReady()) {
            return { model, providerId: provider.id, client };
          }
        }
      }
    }
    return null;
  }

  async analyze(images: ImageInput[], userQuestion: string): Promise<VisionResult | null> {
    const selection = this.findVisionModel();
    if (!selection) {
      logger.warn('VisionAssistant: no multimodal model available');
      return null;
    }

    try {
      const content: Array<ImageContent | { type: 'text'; text: string }> = [];
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', mediaType: img.mediaType, data: img.data },
        });
      }
      content.push({
        type: 'text',
        text: userQuestion || '请详细描述这张图片的内容，包括 UI 元素、文本、布局、颜色等。',
      });

      const response = await selection.client.complete({
        model: selection.model.id,
        messages: [{ role: 'user', content }],
        systemPrompt: [
          '你是一个视觉分析助手。请仔细观察图片，提供详细、准确的描述。',
          '描述应包含：',
          '- 整体布局和结构',
          '- 可见的文本内容',
          '- UI 元素（按钮、输入框、图标等）',
          '- 颜色和样式',
          '- 可能的问题或需要注意的地方',
          '如果用户有具体问题，请针对性回答。',
        ].join('\n'),
        maxTokens: 1000,
        temperature: 0.3,
      });

      return {
        description: response.content,
        modelId: selection.model.id,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('VisionAssistant analysis failed', { error: msg });
      return null;
    }
  }

  static async loadImage(filePath: string): Promise<ImageInput | null> {
    try {
      const absolutePath = path.resolve(filePath);
      const buffer = await fs.readFile(absolutePath);
      const ext = path.extname(filePath).toLowerCase();

      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
      };

      const mediaType = mimeMap[ext];
      if (!mediaType) {
        logger.warn('Unsupported image format', { ext });
        return null;
      }

      return {
        data: buffer.toString('base64'),
        mediaType,
        fileName: path.basename(filePath),
      };
    } catch (error) {
      logger.error('Failed to load image', { filePath, error: String(error) });
      return null;
    }
  }

  static extractImageReferences(message: string): string[] {
    const atMatches = message.match(/@[\w./\\:_-]+\.(png|jpg|jpeg|gif|webp|bmp)/gi);
    if (!atMatches) return [];
    return atMatches.map(m => m.slice(1));
  }

  static needsVision(message: string): boolean {
    const visionKeywords = [
      '看看', '截图', '图片', '这张', '这个图', '看一下',
      '分析图', '看这个', '帮我看看', '识别', 'OCR',
      'screenshot', 'image', 'picture', 'look at',
    ];
    const lowerMsg = message.toLowerCase();
    return visionKeywords.some(kw => lowerMsg.toLowerCase().includes(kw.toLowerCase()));
  }
}
