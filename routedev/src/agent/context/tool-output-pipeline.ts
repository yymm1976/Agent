// src/agent/context/tool-output-pipeline.ts
// Phase 71 Task D3：统一工具输出截断机制为一个 pipeline
// Phase 71 Task D7：实装 Budget Offload 阶段（写文件 + 清理钩子）
// Phase 72 Task B2：新增 ContentRouter 阶段（按内容类型分派压缩）
//
// 收拢原本散落在 sanitizeToolResult 中的截断步骤到一处编排，便于维护：
//   1. Sanitizer：安全检查 + 脎敏（ToolResultSanitizer）
//   1.5 ContentRouter：按内容类型分派压缩（Phase 72 Task B2 新增）
//      - JSON 走统计采样、代码走 AST/正则摘要、散文走 ksentence、<200 token 直通
//   2. Concise Thinking：> maxChars 字符时 800 首 + 标记 + 800 尾（trimToolResult）
//   3. Budget Offload：超长输出写文件 + 返回 preview（Task D7 实装）
//
// 设计要点：
//   - 零回归：process() 的输出与原 sanitizeToolResult 在同等配置下完全一致（ContentRouter 默认关闭）
//   - fail-open：sanitizer/offload/content-router 抛错时不阻断工具执行，降级到内存截断
//   - 跨平台路径：offload 文件路径用 path.join，不硬编码分隔符
import * as path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { ToolResultSanitizer } from '../../tools/result-sanitizer.js';
import { trimToolResult } from '../concise-thinking.js';
import { logger } from '../../utils/logger.js';
import { routeCompress, type ContentRouterConfig } from '../memory/content-router.js';

/** offload 摘要保留的首部字符数 */
const OFFLOAD_PREVIEW_HEAD = 500;
/** offload 摘要保留的尾部字符数 */
const OFFLOAD_PREVIEW_TAIL = 500;

export interface ToolOutputPipelineOptions {
  /** ToolResultSanitizer 实例（可选，未注入时跳过安全检查） */
  sanitizer?: ToolResultSanitizer | null;
  /** 是否启用简洁思考裁剪（> maxChars 字符时 800 首 + 标记 + 800 尾） */
  conciseThinkingEnabled: boolean;
  /** 是否启用 Budget Offload（phase70Integration.toolOutputBudget.enabled） */
  budgetEnabled: boolean;
  /** offload 根目录（budgetEnabled=true 时使用，如 '.routedev/offload'） */
  offloadDir: string;
  /** 单个工具输出最大字符数（默认 2000，与 trimToolResult 阈值对齐） */
  maxChars: number;
  /** 会话 ID（budgetEnabled=true 时用于构造 offload 子目录；未提供时退化为 'anon'） */
  sessionId?: string;
  /**
   * Phase 72 Task B2：是否启用 ContentRouter 按内容类型分派压缩
   * 默认 false（零回归保护）；启用后在 Sanitizer 之后、Concise Thinking 之前调用 routeCompress
   */
  contentRoutingEnabled?: boolean;
  /** Phase 72 Task B2：ContentRouter 配置（可选） */
  contentRouterConfig?: Partial<ContentRouterConfig>;
}

export interface ToolOutputResult {
  /** 处理后的输出（注入回 LLM） */
  output: string;
  /** offload 文件路径（如启用 offload 且文件已写入；未启用或失败时为 undefined） */
  offloadedPath?: string;
  /** 处理阶段记录（用于调试，如 ['sanitizer', 'content-router', 'concise-thinking', 'budget-offload']） */
  stages: string[];
  /** Phase 72 Task B2：ContentRouter 实际使用的压缩策略（仅 content-routing 阶段记录） */
  compressStrategy?: 'passthrough' | 'json-sampler' | 'code-ast-summary' | 'ksentence';
}

/**
 * 工具输出统一处理 pipeline
 *
 * 把 Sanitizer / ContentRouter / Concise Thinking / Budget Offload 四个阶段收拢到 process() 方法，
 * 替代原 sanitizeToolResult 中分散的截断逻辑。pipeline 未注入时 loop 仍走原逻辑（零回归）。
 *
 * Phase 72 Task B2：process() 改为 async 以支持 ContentRouter 的 AST 提取（async WASM 调用）
 */
export class ToolOutputPipeline {
  constructor(private options: ToolOutputPipelineOptions) {}

  /**
   * 处理工具输出，依次执行：
   *   1. Sanitizer：安全检查 + 脎敏（fail-open：抛错时返回原内容）
   *   1.5 ContentRouter（若启用）：按内容类型分派压缩（JSON/代码/散文）
   *   2. Concise Thinking：> maxChars 字符时裁剪（未启用则原样返回）
   *   3. Budget Offload（若启用且输出仍超长）：写文件 + 返回截断摘要 + 路径引用
   *
   * Phase 72 Task B2：方法改为 async 以支持 ContentRouter 内部的 AST 提取
   *
   * @param toolName 工具名称
   * @param result 原始工具输出
   * @param toolArgs 工具参数（可选，传给 ContentRouter 用于提取 filePath 做 AST 提取）
   * @returns 处理后的 output + offloadedPath + stages
   */
  async process(toolName: string, result: string, toolArgs?: Record<string, unknown>): Promise<ToolOutputResult> {
    const stages: string[] = [];
    let processed = result;
    let compressStrategy: ToolOutputResult['compressStrategy'];

    // 阶段 1：Sanitizer 安全检查 + 脎敏
    if (this.options.sanitizer) {
      try {
        const sanitized = this.options.sanitizer.sanitize(toolName, processed);
        if (sanitized.injectionDetected) {
          logger.warn('Injection detected in tool result, warning prefix added', {
            toolName,
            patterns: sanitized.patterns,
          });
        }
        processed = sanitized.content;
        stages.push('sanitizer');
      } catch (err) {
        // 净化失败不阻断工具执行，返回原始结果（fail-open）
        logger.warn('ToolResultSanitizer failed, returning raw result', {
          toolName,
          error: String(err),
        });
        stages.push('sanitizer-failed');
      }
    }

    // 阶段 1.5：ContentRouter 按内容类型分派压缩（Phase 72 Task B2 新增）
    if (this.options.contentRoutingEnabled) {
      try {
        const routeResult = await routeCompress(
          processed,
          toolName,
          toolArgs,
          this.options.contentRouterConfig,
        );
        processed = routeResult.output;
        compressStrategy = routeResult.strategy;
        if (routeResult.wasCompressed) {
          stages.push('content-router');
        } else {
          stages.push('content-router-skipped');
        }
      } catch (err) {
        // 路由压缩失败不阻断工具执行，降级到后续 concise-thinking（fail-open）
        logger.warn('ContentRouter failed, falling through to concise-thinking', {
          toolName,
          error: String(err),
        });
        stages.push('content-router-failed');
      }
    }

    // 阶段 2：Concise Thinking 裁剪（> maxChars 时 800 首 + 标记 + 800 尾）
    processed = trimToolResult(processed, this.options.conciseThinkingEnabled);
    if (this.options.conciseThinkingEnabled) {
      stages.push('concise-thinking');
    }

    // 阶段 3：Budget Offload（若启用且输出仍超长）
    // 触发阈值 maxChars * 2：避免与 concise-thinking 阈值重叠，仅在内容确实超长时落盘
    if (this.options.budgetEnabled && processed.length > this.options.maxChars * 2) {
      const sessionId = this.options.sessionId ?? 'anon';
      try {
        const offloadPath = this.writeOffload(sessionId, toolName, processed);
        processed = this.buildOffloadPreview(processed, offloadPath);
        stages.push('budget-offload');
        return {
          output: processed,
          offloadedPath: offloadPath,
          stages,
          compressStrategy,
        };
      } catch (err) {
        // 写入失败不阻断工具执行，降级到内存截断（fail-open）
        logger.warn('Budget Offload 写入失败，降级到内存截断', {
          toolName,
          sessionId,
          error: String(err),
        });
        processed = this.fallbackTruncate(processed);
        stages.push('budget-offload-failed');
      }
    }

    return {
      output: processed,
      stages,
      compressStrategy,
    };
  }

  /**
   * 把完整输出写入 offload 文件
   * 路径：<offloadDir>/<sessionId>/<toolName>-<timestamp>.txt
   */
  private writeOffload(sessionId: string, toolName: string, content: string): string {
    const sessionDir = path.join(this.options.offloadDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const filename = `${toolName}-${Date.now()}.txt`;
    const filePath = path.join(sessionDir, filename);
    writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  /**
   * 构造 offload 摘要：保留首尾各 500 字符 + 文件路径引用
   * 让 Agent 知道完整内容在磁盘上的位置，可按需读取
   */
  private buildOffloadPreview(content: string, offloadPath: string): string {
    const head = content.slice(0, OFFLOAD_PREVIEW_HEAD);
    const tail = content.slice(-OFFLOAD_PREVIEW_TAIL);
    return (
      `<persisted-output file="${offloadPath}" size="${content.length}">\n` +
      head +
      `\n[...saved locally, ${content.length} chars total...]\n` +
      tail +
      `\n</persisted-output>`
    );
  }

  /**
   * offload 写入失败时的内存截断降级
   * 与 ToolOutputBudgetManager 的 fallback 截断格式保持一致
   */
  private fallbackTruncate(content: string): string {
    const head = content.slice(0, OFFLOAD_PREVIEW_HEAD);
    const tail = content.slice(-OFFLOAD_PREVIEW_TAIL);
    return `${head}\n[...truncated, offload failed...]\n${tail}`;
  }
}
