// src/agent/multi/handoff.ts
// 结构化交接：Worker 之间传递上下文的标准化协议
//
// 解决问题：当前 Worker 完成后只把 conclusion 字符串写入 Blackboard，
// 下游 Worker 无法快速获取「修改了哪些文件」「做了什么决策」「有哪些风险」。
//
// HandoffArtifact 是结构化的交接产物：
//   - summary：本次工作摘要
//   - decisions：做出的决策（what/why/confidence）
//   - modifiedFiles：修改的文件列表
//   - openQuestions：未解决的问题
//   - risks：识别的风险
//   - relevantSymbols：相关的代码符号（函数/类名）
//   - relevantFacts：相关的项目事实
//
// 解析策略（parse）：
//   1. 优先从 ```json ... ``` 块提取结构化字段
//   2. 失败则用正则提取关键信息（文件路径、决策关键词）
//   3. 都失败则把整个文本作为 summary，其他字段为空数组

import { logger } from '../../utils/logger.js';

/** 结构化交接产物 */
export interface HandoffArtifact {
  stepId: string;
  role: string;
  summary: string;
  decisions: Array<{ what: string; why: string; confidence: number }>;
  modifiedFiles: string[];
  openQuestions: string[];
  risks: string[];
  relevantSymbols: string[];
  relevantFacts: string[];
}

/** 文件路径正则：匹配 src/xxx/yyy.ts 或 ./xxx/yyy.js 等 */
const FILE_PATH_REGEX = /(?:src\/|\.\/|tests\/|test\/)?[\w\-./]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|c|cpp|h)\b/g;

/** 决策关键词正则（中英文） */
const DECISION_KEYWORDS = /(?:决策|决定|选择|采用|decision|chose|selected|adopted)[:：]\s*([^\n。]+)/gi;

/** 风险关键词正则 */
const RISK_KEYWORDS = /(?:风险|注意|警告|risk|warning|caution)[:：]\s*([^\n。]+)/gi;

/** 问题关键词正则 */
const QUESTION_KEYWORDS = /(?:问题|疑问|待确认|question|todo|tbd)[:：]\s*([^\n。]+)/gi;

export class HandoffParser {
  /**
   * 从 LLM 自由文本结论解析为 HandoffArtifact
   *
   * 解析顺序：
   *   1. 尝试从 ```json ... ``` 块提取结构化字段
   *   2. 失败则用正则提取关键信息
   *   3. 都失败则把整个文本作为 summary
   *
   * @param rawOutput LLM 原始输出
   * @param stepId 步骤 ID
   * @param role Worker 角色
   */
  static parse(rawOutput: string, stepId: string, role: string): HandoffArtifact {
    const base: HandoffArtifact = {
      stepId,
      role,
      summary: '',
      decisions: [],
      modifiedFiles: [],
      openQuestions: [],
      risks: [],
      relevantSymbols: [],
      relevantFacts: [],
    };

    if (!rawOutput || rawOutput.trim().length === 0) {
      return base;
    }

    // 策略 1：尝试从 JSON 块解析
    const jsonParsed = HandoffParser.tryParseJsonBlock(rawOutput);
    if (jsonParsed) {
      return HandoffParser.mergeWithBase(base, jsonParsed, rawOutput);
    }

    // 策略 2：用正则提取关键信息
    const regexExtracted = HandoffParser.extractByRegex(rawOutput);
    const modifiedFiles = regexExtracted.modifiedFiles ?? [];
    const decisions = regexExtracted.decisions ?? [];
    if (modifiedFiles.length > 0 || decisions.length > 0) {
      return {
        ...base,
        summary: HandoffParser.extractSummary(rawOutput),
        modifiedFiles,
        decisions,
        openQuestions: regexExtracted.openQuestions ?? [],
        risks: regexExtracted.risks ?? [],
      };
    }

    // 策略 3：纯文本回退
    return {
      ...base,
      summary: HandoffParser.extractSummary(rawOutput),
    };
  }

  /**
   * 将 HandoffArtifact 数组格式化为 system prompt 注入文本
   * 用于下游 Worker 的上下文构建
   */
  static formatForPrompt(artifacts: HandoffArtifact[]): string {
    if (!artifacts || artifacts.length === 0) {
      return '（无前置交接信息）';
    }

    const parts: string[] = ['=== 前置步骤交接信息 ==='];

    for (const artifact of artifacts) {
      parts.push('');
      parts.push(`【步骤 ${artifact.stepId}】角色: ${artifact.role}`);

      if (artifact.summary) {
        parts.push(`  摘要: ${artifact.summary}`);
      }

      if (artifact.modifiedFiles.length > 0) {
        parts.push(`  修改的文件:`);
        for (const f of artifact.modifiedFiles) {
          parts.push(`    - ${f}`);
        }
      }

      if (artifact.decisions.length > 0) {
        parts.push(`  决策:`);
        for (const d of artifact.decisions) {
          parts.push(`    - ${d.what}（原因: ${d.why}，置信度: ${(d.confidence * 100).toFixed(0)}%）`);
        }
      }

      if (artifact.openQuestions.length > 0) {
        parts.push(`  待确认问题:`);
        for (const q of artifact.openQuestions) {
          parts.push(`    - ${q}`);
        }
      }

      if (artifact.risks.length > 0) {
        parts.push(`  风险:`);
        for (const r of artifact.risks) {
          parts.push(`    - ${r}`);
        }
      }

      if (artifact.relevantSymbols.length > 0) {
        parts.push(`  相关符号: ${artifact.relevantSymbols.join(', ')}`);
      }

      if (artifact.relevantFacts.length > 0) {
        parts.push(`  相关事实:`);
        for (const f of artifact.relevantFacts) {
          parts.push(`    - ${f}`);
        }
      }
    }

    parts.push('');
    parts.push('=== 交接信息结束 ===');
    return parts.join('\n');
  }

  /**
   * 验证 HandoffArtifact 完整性
   * @returns 是否包含必要的字段（stepId、role、summary 非空）
   */
  static validate(artifact: HandoffArtifact): boolean {
    if (!artifact) return false;
    if (!artifact.stepId || artifact.stepId.trim().length === 0) return false;
    if (!artifact.role || artifact.role.trim().length === 0) return false;
    if (!artifact.summary || artifact.summary.trim().length === 0) return false;
    // decisions 的 confidence 应在 0-1 之间
    for (const d of artifact.decisions) {
      if (d.confidence < 0 || d.confidence > 1) return false;
    }
    return true;
  }

  // ============================================================
  // 私有辅助方法
  // ============================================================

  /** 尝试从 ```json ... ``` 块解析 */
  private static tryParseJsonBlock(rawOutput: string): Record<string, unknown> | null {
    const jsonMatch = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (e) {
      logger.debug('HandoffParser: JSON block parse failed, falling back to regex', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return null;
  }

  /** 将 JSON 解析结果合并到 base artifact */
  private static mergeWithBase(
    base: HandoffArtifact,
    parsed: Record<string, unknown>,
    rawOutput: string,
  ): HandoffArtifact {
    const summary = typeof parsed.summary === 'string' ? parsed.summary : HandoffParser.extractSummary(rawOutput);

    const decisions = Array.isArray(parsed.decisions)
      ? parsed.decisions
          .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object')
          .map(d => ({
            what: typeof d.what === 'string' ? d.what : '',
            why: typeof d.why === 'string' ? d.why : '',
            confidence: typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : 0.5,
          }))
          .filter(d => d.what.length > 0)
      : [];

    const toStringArray = (val: unknown): string[] => {
      if (!Array.isArray(val)) return [];
      return val.filter((v): v is string => typeof v === 'string' && v.length > 0);
    };

    return {
      ...base,
      summary,
      decisions,
      modifiedFiles: toStringArray(parsed.modifiedFiles),
      openQuestions: toStringArray(parsed.openQuestions),
      risks: toStringArray(parsed.risks),
      relevantSymbols: toStringArray(parsed.relevantSymbols),
      relevantFacts: toStringArray(parsed.relevantFacts),
    };
  }

  /** 用正则提取关键信息 */
  private static extractByRegex(rawOutput: string): Partial<HandoffArtifact> {
    const result: Partial<HandoffArtifact> = {
      decisions: [],
      modifiedFiles: [],
      openQuestions: [],
      risks: [],
    };

    // 提取文件路径
    const fileMatches = rawOutput.match(FILE_PATH_REGEX);
    if (fileMatches) {
      result.modifiedFiles = [...new Set(fileMatches)];
    }

    // 提取决策
    let match: RegExpExecArray | null;
    const decisions: Array<{ what: string; why: string; confidence: number }> = [];
    DECISION_KEYWORDS.lastIndex = 0;
    while ((match = DECISION_KEYWORDS.exec(rawOutput)) !== null) {
      if (match[1] && match[1].trim().length > 0) {
        decisions.push({
          what: match[1].trim(),
          why: '（从文本提取，未明确说明）',
          confidence: 0.6,
        });
      }
    }
    result.decisions = decisions;

    // 提取风险
    const risks: string[] = [];
    RISK_KEYWORDS.lastIndex = 0;
    while ((match = RISK_KEYWORDS.exec(rawOutput)) !== null) {
      if (match[1] && match[1].trim().length > 0) {
        risks.push(match[1].trim());
      }
    }
    result.risks = risks;

    // 提取待确认问题
    const questions: string[] = [];
    QUESTION_KEYWORDS.lastIndex = 0;
    while ((match = QUESTION_KEYWORDS.exec(rawOutput)) !== null) {
      if (match[1] && match[1].trim().length > 0) {
        questions.push(match[1].trim());
      }
    }
    result.openQuestions = questions;

    return result;
  }

  /** 提取摘要：取前 200 字符或第一段 */
  private static extractSummary(rawOutput: string): string {
    const trimmed = rawOutput.trim();
    if (trimmed.length === 0) return '';

    // 尝试取第一段（以空行分隔）
    const firstParagraph = trimmed.split(/\n\s*\n/)[0];
    if (firstParagraph && firstParagraph.length <= 500) {
      return firstParagraph.replace(/\s+/g, ' ').trim();
    }

    // 回退：取前 200 字符
    if (trimmed.length <= 200) return trimmed;
    return trimmed.slice(0, 200) + '...';
  }
}
