// src/agent/omission-checker.ts
// Plan 遗漏点检查器——用 LLM 检查 plan 是否有遗漏点
// 检查维度：edge-case / error-handling / dependency / security / performance / testing
// fail-open：LLM 调用失败时返回空结果，不阻塞主流程

import type { ILLMClient, LLMMessage, LLMRequestOptions } from '../router/types.js';
import type { PlanStep } from './plan-diff.js';
import { logger } from '../utils/logger.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 遗漏点严重度 */
export type OmissionSeverity = 'critical' | 'major' | 'minor';

/** 遗漏点类别 */
export type OmissionCategory =
  | 'edge-case'
  | 'error-handling'
  | 'dependency'
  | 'security'
  | 'performance'
  | 'testing';

/** 单个遗漏点 */
export interface Omission {
  category: OmissionCategory;
  description: string;
  severity: OmissionSeverity;
  suggestedStep?: string;
}

/** 遗漏点检查结果 */
export interface OmissionResult {
  omissions: Omission[];
  summary: string;
}

/** 空结果（fail-open 兜底用） */
const EMPTY_RESULT: OmissionResult = { omissions: [], summary: '检查未执行或返回空结果' };

/** OmissionChecker 构造参数 */
export interface OmissionCheckerOptions {
  /** LLM 客户端 */
  llmClient: ILLMClient;
  /** 模型 id（如 'fast' / 'deepseek-v4-flash'） */
  modelId: string;
  /** 是否启用（关闭时直接返回空结果，不调用 LLM） */
  enabled: boolean;
  /** prompt 模板文件路径（可选，默认读取 prompts/omission-check.txt） */
  promptPath?: string;
  /** 调用超时（毫秒，默认 30s） */
  timeoutMs?: number;
}

// 加载 prompt 模板（模块级缓存，避免重复 IO）
let cachedPrompt: string | null = null;
let cachedPromptPath: string | null = null;

/**
 * 加载 prompt 模板
 * 默认读取 src/agent/prompts/omission-check.txt
 * 支持通过 promptPath 自定义路径
 */
function loadPrompt(promptPath?: string): string {
  if (cachedPrompt && cachedPromptPath === (promptPath ?? null)) {
    return cachedPrompt;
  }

  const targetPath = promptPath
    ?? join(dirname(fileURLToPath(import.meta.url)), 'prompts', 'omission-check.txt');

  try {
    cachedPrompt = readFileSync(targetPath, 'utf-8');
    cachedPromptPath = promptPath ?? null;
    return cachedPrompt;
  } catch (err) {
    logger.error('OmissionChecker: 加载 prompt 模板失败', {
      path: targetPath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`无法加载 omission-check prompt 模板: ${targetPath}`);
  }
}

/**
 * 渲染 prompt 模板——替换占位符
 */
function renderPrompt(
  template: string,
  vars: { goal: string; plan: string; projectContext: string },
): string {
  return template
    .replace(/\{\{goal\}\}/g, vars.goal)
    .replace(/\{\{plan\}\}/g, vars.plan)
    .replace(/\{\{projectContext\}\}/g, vars.projectContext);
}

/** 把 PlanStep[] 渲染为可读文本 */
function renderPlan(steps: PlanStep[]): string {
  return steps
    .map((s, i) => {
      const criteria = s.acceptanceCriteria && s.acceptanceCriteria.length > 0
        ? `\n  验收标准: ${s.acceptanceCriteria.join('; ')}`
        : '';
      return `${i + 1}. [${s.id}] ${s.description}${criteria}`;
    })
    .join('\n');
}

/** 从 LLM 响应中提取 JSON */
function extractJson(content: string): string | null {
  // 尝试提取 ```json ... ``` 代码块
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  // 尝试找第一个 { 到最后一个 }
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return content.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

/** 解析 LLM 响应为 OmissionResult（解析失败时返回空结果） */
function parseOmissionResult(content: string): OmissionResult {
  const jsonStr = extractJson(content);
  if (!jsonStr) {
    logger.warn('OmissionChecker: 响应中未找到 JSON', { content: content.slice(0, 200) });
    return { ...EMPTY_RESULT, summary: 'LLM 响应未包含有效 JSON' };
  }

  try {
    const parsed = JSON.parse(jsonStr) as {
      omissions?: Array<{
        category?: string;
        description?: string;
        severity?: string;
        suggestedStep?: string;
      }>;
      summary?: string;
    };

    const validCategories: OmissionCategory[] = [
      'edge-case', 'error-handling', 'dependency',
      'security', 'performance', 'testing',
    ];
    const validSeverities: OmissionSeverity[] = ['critical', 'major', 'minor'];

    const omissions: Omission[] = (parsed.omissions ?? [])
      .filter(o => o && typeof o.description === 'string' && o.description.length > 0)
      .map(o => ({
        category: (validCategories as string[]).includes(o.category ?? '')
          ? (o.category as OmissionCategory)
          : 'edge-case',
        description: o.description!,
        severity: (validSeverities as string[]).includes(o.severity ?? '')
          ? (o.severity as OmissionSeverity)
          : 'minor',
        ...(o.suggestedStep ? { suggestedStep: o.suggestedStep } : {}),
      }));

    return {
      omissions,
      summary: typeof parsed.summary === 'string' && parsed.summary.length > 0
        ? parsed.summary
        : `检查完成，发现 ${omissions.length} 个遗漏点`,
    };
  } catch (err) {
    logger.warn('OmissionChecker: JSON 解析失败', {
      error: err instanceof Error ? err.message : String(err),
      jsonStr: jsonStr.slice(0, 200),
    });
    return { ...EMPTY_RESULT, summary: 'LLM 响应 JSON 解析失败' };
  }
}

/**
 * Plan 遗漏点检查器
 * 通过 LLM 检查 plan 是否有遗漏点（边界情况、错误处理、依赖关系等）
 *
 * 设计要点：
 * - enabled=false 时直接返回空结果，不调用 LLM
 * - LLM 调用或解析失败时 fail-open 返回空 OmissionResult
 * - prompt 模板从外部文件加载，不写死在代码里
 */
export class OmissionChecker {
  private readonly opts: OmissionCheckerOptions;

  constructor(opts: OmissionCheckerOptions) {
    this.opts = opts;
  }

  /**
   * 检查 plan 的遗漏点
   * @param plan 当前 plan 步骤
   * @param context 上下文（goal + 可选 projectContext）
   * @returns 遗漏点检查结果（fail-open 时返回空结果）
   */
  async check(
    plan: PlanStep[],
    context: { goal: string; projectContext?: string },
  ): Promise<OmissionResult> {
    // 配置开关关闭时直接返回空结果
    if (!this.opts.enabled) {
      logger.debug('OmissionChecker: 已禁用，跳过检查');
      return { ...EMPTY_RESULT, summary: '遗漏点检查已禁用' };
    }

    // 加载 prompt 模板（失败时 fail-open）
    let template: string;
    try {
      template = loadPrompt(this.opts.promptPath);
    } catch (err) {
      logger.warn('OmissionChecker: 加载 prompt 失败，fail-open 返回空结果', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ...EMPTY_RESULT, summary: '加载 prompt 模板失败' };
    }

    // 渲染 prompt
    const planText = renderPlan(plan);
    const projectContext = context.projectContext?.trim() ?? '（未提供）';
    const prompt = renderPrompt(template, {
      goal: context.goal,
      plan: planText,
      projectContext,
    });

    // 调用 LLM
    const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
    const requestOptions: LLMRequestOptions = {
      model: this.opts.modelId,
      messages,
      maxTokens: 2000,
      temperature: 0.3,
      timeoutMs: this.opts.timeoutMs ?? 30000,
      stream: false,
    };

    try {
      logger.debug('OmissionChecker: 调用 LLM 检查遗漏点', {
        model: this.opts.modelId,
        stepCount: plan.length,
      });
      const response = await this.opts.llmClient.complete(requestOptions);
      return parseOmissionResult(response.content);
    } catch (err) {
      // fail-open：LLM 调用失败时返回空结果，不阻塞主流程
      logger.warn('OmissionChecker: LLM 调用失败，fail-open 返回空结果', {
        error: err instanceof Error ? err.message : String(err),
        model: this.opts.modelId,
      });
      return { ...EMPTY_RESULT, summary: 'LLM 调用失败（fail-open）' };
    }
  }
}
