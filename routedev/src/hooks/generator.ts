// src/hooks/generator.ts
// Phase 39 Task 2：Hook AI 自动生成器
//
// 设计目标：
//   1. 用户用自然语言描述想要的 Hook 行为
//   2. 优先在模板库中做关键词匹配（零成本、确定性）
//   3. 模板匹配失败才调用 LLM 生成（成本高、需安全审查）
//   4. 对生成的 shell 命令做安全审查（检测 rm -rf、git push --force 等危险操作）
//
// 与 HookConfigRegistry 的关系：
//   - HookGenerator 负责"生成"（从描述到配置）
//   - HookConfigRegistry 负责"存储"（CRUD + 持久化）
//   - 生成后调用 registry.add() 持久化

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ILLMClient, LLMResponse } from '../router/types.js';
import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

/**
 * Hook 事件类型
 *
 * 注意：本类型在 src/agent/hooks.ts 的 HookEvent 基础上扩展了 'on-model-call'
 * 用于支持 token-alert 等模型调用相关的 Hook。
 * 当 hooks.ts 的 HookEvent 类型扩展后，可直接替换为导入。
 */
export type HookEvent =
  | 'pre-step'
  | 'post-step'
  | 'on-error'
  | 'on-complete'
  | 'pre-tool-call'
  | 'post-tool-call'
  | 'on-session-start'
  | 'on-session-end'
  | 'on-model-call';

/** Hook 生成请求 */
export interface HookGenerationRequest {
  /** 用户的自然语言描述 */
  description: string;
}

/** 生成的 Hook 结构 */
export interface GeneratedHook {
  /** kebab-case 名称 */
  name: string;
  /** 触发事件 */
  event: HookEvent;
  /** 触发条件（如文件扩展名） */
  condition?: string;
  /** 执行的 shell 命令（支持 {{filePath}} 变量） */
  command: string;
  /** 失败行为 */
  failBehavior: 'warn' | 'block' | 'silent';
  /** 安全审查结果 */
  securityReview: {
    passed: boolean;
    warnings: string[];
  };
}

/** Hook 模板结构（与 templates/*.json 文件格式一致） */
export interface HookTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称（展示用） */
  name: string;
  /** 模板描述 */
  description: string;
  /** 匹配关键词（用于子串匹配） */
  matchKeywords: string[];
  /** 触发事件 */
  event: HookEvent;
  /** 触发条件 */
  condition?: { toolName?: string; filePattern?: string };
  /** 执行命令 */
  command: string;
  /** 失败行为 */
  failBehavior: 'warn' | 'block' | 'silent';
}

// ============================================================
// 常量
// ============================================================

/** 默认最大 token 数 */
const DEFAULT_MAX_TOKENS = 1024;

/** 默认温度（低温度保证输出稳定） */
const DEFAULT_TEMPERATURE = 0.2;

/** 危险命令模式列表 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  { pattern: /rm\s+-rf?\s/i, warning: '检测到 rm -rf 命令' },
  { pattern: /format\s+/i, warning: '检测到 format 命令' },
  { pattern: /del\s+\/[fsq]/i, warning: '检测到 del 命令' },
  { pattern: /git\s+push\s+--force/i, warning: '检测到 git push --force' },
  { pattern: /:\(\)\s*\{/i, warning: '检测到可能的 fork bomb' },
];

// ============================================================
// HookGenerator
// ============================================================

/**
 * Hook 自动生成器
 *
 * 流程：
 *   1. 模板匹配优先（关键词子串匹配）
 *   2. 匹配失败 → 调用 LLM 生成
 *   3. LLM 生成结果 → 安全审查
 *   4. 返回 GeneratedHook 供 UI 确认
 */
export class HookGenerator {
  /** 模板缓存（首次访问时加载） */
  private templatesCache: HookTemplate[] | null = null;
  /** 模板目录路径 */
  private templatesDir: string;

  constructor(
    private llmClient?: ILLMClient,
    private modelId?: string,
  ) {
    // 计算 templates 目录路径（src/hooks/templates/）
    // 兼容 ESM 和 CJS
    const currentFile = typeof __filename !== 'undefined'
      ? __filename
      : fileURLToPath(import.meta.url);
    this.templatesDir = path.join(path.dirname(currentFile), 'templates');
  }

  /**
   * 根据自然语言描述生成 Hook 配置
   *
   * 步骤：模板匹配优先 → 匹配失败才调用 LLM → 安全审查
   */
  async generate(request: HookGenerationRequest): Promise<GeneratedHook> {
    if (!request.description || request.description.trim().length === 0) {
      throw new Error('Hook 描述不能为空');
    }

    // 1. 先在模板库中做关键词匹配
    const matched = this.matchTemplate(request.description);
    if (matched) {
      logger.info('HookGenerator: template matched', {
        templateId: matched.id,
        description: request.description,
      });
      return this.applyTemplate(matched);
    }

    // 2. 匹配失败 → 调用 LLM 生成
    if (this.llmClient && this.modelId) {
      logger.info('HookGenerator: no template matched, falling back to LLM', {
        description: request.description,
      });
      const generated = await this.generateWithLLM(request);
      // 3. 安全审查
      generated.securityReview = this.reviewSecurity(generated.command);
      return generated;
    }

    throw new Error('无法生成 Hook：模板不匹配且 LLM 不可用');
  }

  /**
   * 模板关键词匹配
   *
   * 策略：
   *   - 加载 src/hooks/templates/ 下的所有模板
   *   - 对每个模板的 matchKeywords 做子串匹配（大小写不敏感）
   *   - 返回第一个匹配的模板
   */
  matchTemplate(description: string): HookTemplate | null {
    const templates = this.loadTemplatesSync();
    const descLower = description.toLowerCase();

    for (const template of templates) {
      for (const keyword of template.matchKeywords) {
        if (descLower.includes(keyword.toLowerCase())) {
          return template;
        }
      }
    }
    return null;
  }

  /**
   * 安全审查：检查命令是否包含危险操作
   *
   * 检测模式：
   *   - rm -rf
   *   - format
   *   - del /f /s /q
   *   - git push --force
   *   - fork bomb 模式 :(){...}
   */
  reviewSecurity(command: string): { passed: boolean; warnings: string[] } {
    const warnings: string[] = [];
    for (const { pattern, warning } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        warnings.push(warning);
      }
    }
    return { passed: warnings.length === 0, warnings };
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 应用模板生成 Hook
   *
   * 模板生成的 Hook 默认通过安全审查（因为模板是预定义的）
   * 但仍会执行审查以保持一致性和未来扩展性
   */
  private applyTemplate(template: HookTemplate): GeneratedHook {
    const condition = template.condition
      ? [template.condition.toolName, template.condition.filePattern]
          .filter(Boolean)
          .join(':')
      : undefined;

    return {
      name: template.id,
      event: template.event,
      condition,
      command: template.command,
      failBehavior: template.failBehavior,
      securityReview: this.reviewSecurity(template.command),
    };
  }

  /**
   * 调用 LLM 生成 Hook
   */
  private async generateWithLLM(request: HookGenerationRequest): Promise<GeneratedHook> {
    const prompt = this.buildPrompt(request);

    const response: LLMResponse = await this.llmClient!.complete({
      model: this.modelId!,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
    });

    return this.parseLLMResponse(response.content);
  }

  /**
   * 构造 LLM prompt
   */
  private buildPrompt(request: HookGenerationRequest): string {
    return `你是一个 Hook 配置生成器。用户会描述他想要的 Hook 行为，你需要生成一个 Hook 配置。

用户描述：${request.description}

请输出 JSON 格式：
{
  "name": "kebab-case名称",
  "event": "事件类型（pre-step/post-step/on-error/on-complete/pre-tool-call/post-tool-call/on-session-start/on-session-end/on-model-call）",
  "condition": "触发条件（可选，如 file_write 或 .ts）",
  "command": "执行的 shell 命令（支持 {{filePath}} 变量）",
  "failBehavior": "warn|block|silent"
}

规则：
1. name 用 kebab-case
2. event 必须是上述合法值之一
3. command 是 shell 命令，可用 {{filePath}} 表示当前文件路径
4. failBehavior：warn=警告继续，block=阻止操作，silent=静默失败
5. 不要生成 rm -rf、git push --force 等危险命令

只输出 JSON，不要输出其他内容。`;
  }

  /**
   * 解析 LLM 响应为 GeneratedHook
   */
  private parseLLMResponse(raw: string): GeneratedHook {
    let obj: Partial<{
      name: string;
      event: string;
      condition?: string;
      command: string;
      failBehavior: string;
    }>;

    // 策略 1：提取 ```json ... ``` 代码块
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        obj = JSON.parse(codeBlockMatch[1].trim());
      } catch {
        obj = JSON.parse(raw.trim());
      }
    } else {
      obj = JSON.parse(raw.trim());
    }

    // 校验必填字段
    if (typeof obj.name !== 'string') throw new Error('LLM 输出缺少 name 字段');
    if (typeof obj.event !== 'string') throw new Error('LLM 输出缺少 event 字段');
    if (typeof obj.command !== 'string') throw new Error('LLM 输出缺少 command 字段');

    // 校验 event 合法性
    const validEvents: HookEvent[] = [
      'pre-step', 'post-step', 'on-error', 'on-complete',
      'pre-tool-call', 'post-tool-call',
      'on-session-start', 'on-session-end', 'on-model-call',
    ];
    if (!validEvents.includes(obj.event as HookEvent)) {
      throw new Error(`LLM 输出 event 不合法: ${obj.event}`);
    }

    // 校验 failBehavior
    const failBehavior = (obj.failBehavior as 'warn' | 'block' | 'silent') ?? 'warn';
    if (!['warn', 'block', 'silent'].includes(failBehavior)) {
      throw new Error(`LLM 输出 failBehavior 不合法: ${obj.failBehavior}`);
    }

    return {
      name: obj.name,
      event: obj.event as HookEvent,
      condition: typeof obj.condition === 'string' ? obj.condition : undefined,
      command: obj.command,
      failBehavior,
      securityReview: { passed: true, warnings: [] }, // 会被外层覆盖
    };
  }

  /**
   * 加载所有模板（带缓存）
   *
   * 同步加载：因为 matchTemplate 是同步方法
   * 首次调用时读取 templates 目录下所有 .json 文件
   */
  private loadTemplatesSync(): HookTemplate[] {
    if (this.templatesCache) {
      return this.templatesCache;
    }

    const templates: HookTemplate[] = [];

    try {
      const entries = fsSync.readdirSync(this.templatesDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const filePath = path.join(this.templatesDir, entry);
        try {
          const raw = fsSync.readFileSync(filePath, 'utf-8');
          const template = JSON.parse(raw) as HookTemplate;
          templates.push(template);
        } catch (err) {
          logger.warn('HookGenerator: failed to load template', {
            file: entry,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn('HookGenerator: templates dir not accessible', {
        dir: this.templatesDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.templatesCache = templates;
    logger.debug('HookGenerator: templates loaded', { count: templates.length });
    return templates;
  }

  /**
   * 列出所有可用模板（供 UI 展示）
   */
  listTemplates(): HookTemplate[] {
    return this.loadTemplatesSync();
  }
}
