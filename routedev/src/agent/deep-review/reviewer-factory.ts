// src/agent/deep-review/reviewer-factory.ts
// Phase 72：reviewer 工厂——构建 reviewer prompt + 选择模型
//
// 设计要点：
//   1. prompt 模板从 prompts/<focus>.txt 加载（不写死在代码里）
//   2. 模块级缓存避免重复读盘
//   3. diff 截断到 8000 字符（内联实现，避免与 review.ts 循环依赖）
//   4. crossModel 启发式：security 用最强模型，style 用轻量模型

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewFocus } from '../../cli/commands/review.js';
import type { DeepReviewConfig } from './types.js';

/** prompt 模板文件所在目录（基于当前模块路径推导，避免硬编码绝对路径） */
const PROMPTS_DIR = path.dirname(fileURLToPath(import.meta.url)) + path.sep + 'prompts';

/** 模块级缓存：focus → 模板字符串 */
const promptCache = new Map<ReviewFocus, string>();

/** diff 最大字符数（与 review.ts 保持一致，避免 prompt 超限） */
const MAX_DIFF_CHARS = 8000;

/** 截断过长的 diff（内联实现，避免与 review.ts 形成循环依赖） */
function truncateDiff(diff: string, maxLen: number = MAX_DIFF_CHARS): string {
  if (diff.length <= maxLen) return diff;
  return diff.slice(0, maxLen) + `\n\n... (diff 已截断，仅展示前 ${maxLen} 字符)`;
}

/**
 * 加载指定 focus 的 prompt 模板（带模块级缓存）
 *
 * 加载失败时回退到一个通用模板，保证流程不中断（fail-open）。
 */
function loadPromptTemplate(focus: ReviewFocus): string {
  const cached = promptCache.get(focus);
  if (cached !== undefined) return cached;

  const filePath = path.join(PROMPTS_DIR, `${focus}.txt`);
  try {
    const content = readFileSync(filePath, 'utf-8');
    promptCache.set(focus, content);
    return content;
  } catch (err) {
    // fail-open：模板文件缺失时回退到最小可用模板
    const fallback = [
      `你是一个对抗性代码审查员，负责「${focus}」维度的审查。`,
      '',
      '【变更文件列表】',
      '{{changedFiles}}',
      '',
      '【当前 diff】',
      '{{diff}}',
      '',
      '【输出格式】',
      '### Critical / ### Major / ### Minor / ### 总结',
    ].join('\n');
    promptCache.set(focus, fallback);
    return fallback;
  }
}

/**
 * 构建 reviewer prompt
 *
 * @param focus 审查维度
 * @param diff 当前 diff 文本
 * @param changedFiles 变更文件列表
 * @param strictness 审查严格度（注入到 prompt，影响问题判定从严程度）
 * @returns 替换占位符后的完整 prompt
 */
export function buildReviewerPrompt(
  focus: ReviewFocus,
  diff: string,
  changedFiles: string[],
  strictness: 'low' | 'medium' | 'high' = 'medium',
): string {
  const template = loadPromptTemplate(focus);
  const fileList = changedFiles.length > 0
    ? changedFiles.map(f => `  - ${f}`).join('\n')
    : '  （未解析出文件列表）';
  const truncatedDiff = truncateDiff(diff);
  // Phase 72 修复 C3：消费 reviewStrictness 死字段
  const strictnessDesc = strictness === 'high'
    ? '严格——所有可疑问题均需报告，宁可误报不可漏报'
    : strictness === 'low'
      ? '宽松——仅报告明确的高严重度问题，可疑项不报'
      : '默认——报告明确的问题，可疑项标注后上报';

  return template
    .replaceAll('{{changedFiles}}', fileList)
    .replaceAll('{{diff}}', truncatedDiff)
    .replaceAll('{{strictness}}', strictnessDesc);
}

/**
 * 选择 reviewer 使用的模型 id
 *
 * crossModel=true 时按 focus 启发式选择：
 *   - security：用列表中最强模型（启发式：取第一个，假设按降序排列）
 *   - style：用列表中最轻量模型（启发式：取最后一个）
 *   - 其他：取中间
 * crossModel=false 时统一用 config.reviewModel（'auto' 时取列表第一个）
 *
 * @param focus 当前 reviewer 维度
 * @param config Deep Review 配置
 * @param availableModels 当前可用模型 id 列表（按能力降序，启发式假设）
 * @returns 选中的模型 id；无可用模型时返回 'auto'
 */
export function pickModel(
  focus: ReviewFocus,
  config: DeepReviewConfig,
  availableModels: string[],
): string {
  // 无可用模型时回退到 auto（由路由器决定）
  if (availableModels.length === 0) return 'auto';

  if (!config.crossModel) {
    // 非跨模型模式：统一用 reviewModel；'auto' 时取第一个可用模型
    return config.reviewModel === 'auto' ? availableModels[0] : config.reviewModel;
  }

  // 跨模型模式：按 focus 启发式选择
  switch (focus) {
    case 'security':
      // 安全审查用最强模型（列表第一个，启发式假设降序排列）
      return availableModels[0];
    case 'style':
      // 风格审查用最轻量模型（列表最后一个）
      return availableModels[availableModels.length - 1];
    case 'correctness':
    case 'performance':
      // 正确性/性能用中间模型
      return availableModels[Math.floor(availableModels.length / 2)] ?? availableModels[0];
    default:
      return availableModels[0];
  }
}
