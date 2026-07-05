// src/agent/deep-review/aggregator.ts
// Phase 72：聚合器——解析 reviewer 报告、去重问题、仲裁决策、生成汇总
//
// 设计要点：
//   1. parseIssuesFromReport：从 markdown 输出解析问题列表（正则匹配 ### 段落 + 列表项）
//   2. dedupeIssues：按 dedupeKey 去重，保留严重度最高的一项
//   3. arbitrate：按策略产生 approve/request_changes/reject/inconclusive
//   4. aggregate：组装完整结果（含 summary，支持 concat / llm-summary / tournament）

import type {
  ReviewerReport,
  ReviewIssue,
  ArbitrationDecision,
  ArbitrationStrategy,
  AggregateMode,
  DeepReviewConfig,
} from './types.js';
import type { ILLMClient } from '../../router/types.js';

/** 严重度权重，便于比较高低（数字越大越严重） */
const SEVERITY_WEIGHT: Record<ReviewIssue['severity'], number> = {
  critical: 3,
  major: 2,
  minor: 1,
};

/** 问题条目行正则：`- [文件:行号] 描述 → 建议` 或 `* [文件:行号] 描述` */
const ISSUE_LINE_REGEX = /^[-*]\s*\[([^:]*):([^\]]*)\]\s*(.+?)(?:\s*→\s*(.+))?$/;

/** 段落标题正则：匹配 ### Critical / ### Major / ### Minor */
const SECTION_REGEX = /^###\s+(Critical|Major|Minor)/i;

/**
 * 生成去重 key
 *
 * 规则：file + line + description 前 80 字符，全部归一化为小写并 trim。
 * 缺失字段用空字符串占位。
 */
function makeDedupeKey(file: string | undefined, line: string | undefined, description: string): string {
  const f = (file ?? '').trim().toLowerCase();
  const l = (line ?? '').trim().toLowerCase();
  const d = description.slice(0, 80).trim().toLowerCase();
  return `${f}:${l}:${d}`;
}

/**
 * 从单个 reviewer 的 markdown 输出中解析问题列表
 *
 * 解析规则：
 *   - 按 ### 段落识别当前严重级别（Critical/Major/Minor）
 *   - 在对应段落内匹配 `- [文件:行号] 描述 → 建议` 行
 *   - 格式错误的行直接跳过（不抛错，fail-open）
 *
 * @param report reviewer 原始报告
 * @returns 解析出的问题列表（可能为空数组）
 */
export function parseIssuesFromReport(report: ReviewerReport): ReviewIssue[] {
  // 失败的报告无 output，直接返回空
  if (!report.success || !report.output) return [];

  const issues: ReviewIssue[] = [];
  const lines = report.output.split('\n');
  let currentSeverity: ReviewIssue['severity'] | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // 检测段落标题
    const sectionMatch = trimmed.match(SECTION_REGEX);
    if (sectionMatch) {
      const sev = sectionMatch[1].toLowerCase();
      if (sev === 'critical' || sev === 'major' || sev === 'minor') {
        currentSeverity = sev;
      } else {
        currentSeverity = null;
      }
      continue;
    }

    // 仅在已知严重级别段落内匹配问题行
    if (currentSeverity === null) continue;

    const match = trimmed.match(ISSUE_LINE_REGEX);
    if (!match) continue;

    // match: [1]=file, [2]=line, [3]=description, [4]=suggestion(可选)
    const file = match[1]?.trim() || undefined;
    const line = match[2]?.trim() || undefined;
    const description = match[3]?.trim() ?? '';
    const suggestion = match[4]?.trim() || undefined;

    if (description.length === 0) continue;

    issues.push({
      focus: report.focus,
      severity: currentSeverity,
      file,
      line,
      description,
      suggestion,
      dedupeKey: makeDedupeKey(file, line, description),
    });
  }

  return issues;
}

/**
 * 按 dedupeKey 去重问题列表
 *
 * 去重规则：
 *   - 相同 dedupeKey 的问题合并为一项
 *   - 保留严重度最高的一项（critical > major > minor）
 *   - 严重度相同时保留第一个出现的问题
 *
 * @param issues 待去重的问题列表
 * @returns 去重后的问题列表
 */
export function dedupeIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const map = new Map<string, ReviewIssue>();
  for (const issue of issues) {
    const existing = map.get(issue.dedupeKey);
    if (!existing) {
      map.set(issue.dedupeKey, issue);
      continue;
    }
    // 已存在：保留严重度更高的；相同则保留原项（首个）
    if (SEVERITY_WEIGHT[issue.severity] > SEVERITY_WEIGHT[existing.severity]) {
      map.set(issue.dedupeKey, issue);
    }
  }
  return Array.from(map.values());
}

/**
 * 仲裁决策
 *
 * 策略：
 *   - critical-veto：任一 critical 问题 → reject；否则 approve
 *   - majority-vote：>50% reviewer 成功且无 critical → approve；否则 request_changes
 *   - highest-severity：取所有问题中的最高严重度作为结论
 *       - critical → reject
 *       - major → request_changes
 *       - minor 或无问题 → approve
 *   - all-must-pass：全部 reviewer 成功且无 critical/major → approve；否则 request_changes
 *
 * 特殊规则：半数以上 reviewer 失败 → inconclusive（无论何种策略）
 *
 * @param reports 各 reviewer 报告
 * @param issues 去重后的问题列表
 * @param strategy 仲裁策略
 */
export function arbitrate(
  reports: ReviewerReport[],
  issues: ReviewIssue[],
  strategy: ArbitrationStrategy,
): ArbitrationDecision {
  // 0 reviewer → inconclusive（避免"什么都没审查"却 approve 的误导）
  if (reports.length === 0) return 'inconclusive';

  // 半数以上 reviewer 失败 → inconclusive
  const successCount = reports.filter(r => r.success).length;
  if (successCount < reports.length / 2) {
    return 'inconclusive';
  }

  const hasCritical = issues.some(i => i.severity === 'critical');
  const hasMajor = issues.some(i => i.severity === 'major');

  switch (strategy) {
    case 'critical-veto':
      return hasCritical ? 'reject' : 'approve';

    case 'majority-vote': {
      // >50% reviewer 成功且无 critical → approve
      const majoritySuccess = reports.length > 0 && successCount > reports.length / 2;
      if (majoritySuccess && !hasCritical) return 'approve';
      return 'request_changes';
    }

    case 'highest-severity': {
      if (hasCritical) return 'reject';
      if (hasMajor) return 'request_changes';
      return 'approve';
    }

    case 'all-must-pass':
      // 全部 success 且无 critical/major → approve
      if (successCount === reports.length && !hasCritical && !hasMajor) return 'approve';
      return 'request_changes';

    default:
      return 'inconclusive';
  }
}

/**
 * 从 reviewer 报告中提取"### 总结"段落内容
 */
function extractSummarySection(output: string): string {
  const match = output.match(/###\s*总结[\s\S]*$/i);
  return match ? match[0] : '';
}

/**
 * 生成汇总摘要
 *
 * 按 aggregateMode：
 *   - concat：简单拼接各成功 reviewer 的总结段
 *   - llm-summary：调 LLM 生成汇总（无 llmClient 或 modelId 时降级为 concat）
 *   - tournament：暂不实现，降级为 llm-summary
 *
 * @param reports reviewer 报告列表
 * @param mode 聚合模式
 * @param llmClient 可选的 LLM 客户端
 * @param modelId 汇总用的具体模型 id（'auto' 或空表示不调用 LLM，直接 concat）
 */
async function buildSummary(
  reports: ReviewerReport[],
  mode: AggregateMode,
  llmClient?: ILLMClient,
  modelId?: string,
): Promise<string> {
  const successReports = reports.filter(r => r.success);
  const concatSummary = successReports
    .map(r => `【${r.focus}】\n${extractSummarySection(r.output) || '（无总结段）'}`)
    .join('\n\n');

  // concat 模式：直接返回拼接结果
  if (mode === 'concat') {
    return concatSummary || '（无 reviewer 成功完成）';
  }

  // llm-summary / tournament 模式：尝试 LLM 汇总，失败降级为 concat
  // tournament 暂未实现，按设计降级为 llm-summary
  // 无 LLM 客户端，或未提供具体模型 id（'auto' 由调用方解析，此处未解析则降级）
  if (!llmClient || !modelId || modelId === 'auto' || modelId === '') {
    return concatSummary || '（无 reviewer 成功完成，且无 LLM 客户端可用于汇总）';
  }

  try {
    const prompt = `请把以下多个 reviewer 的审查总结合并为一份简洁的中文汇总摘要，保留关键问题与严重级别统计，不要重复罗列每个 reviewer 的原始输出：\n\n${concatSummary}`;
    const resp = await llmClient.complete({
      model: modelId,
      messages: [
        { role: 'system', content: '你是代码审查汇总助手，负责合并多个维度的审查结论。' },
        { role: 'user', content: prompt },
      ],
      maxTokens: 800,
    });
    const text = resp.content?.trim();
    return text && text.length > 0 ? text : concatSummary;
  } catch {
    // LLM 调用失败，fail-open 降级为 concat
    return concatSummary || '（LLM 汇总失败，且无 reviewer 总结）';
  }
}

/** aggregate 函数的返回类型 */
export interface AggregateResult {
  issues: ReviewIssue[];
  arbitration: ArbitrationDecision;
  summary: string;
}

/**
 * 完整聚合流程
 *
 * 步骤：
 *   1. 从各 reviewer 报告解析问题
 *   2. 去重
 *   3. 按策略仲裁
 *   4. 生成汇总摘要
 *
 * @param reports reviewer 报告列表
 * @param config Deep Review 配置
 * @param llmClient 可选 LLM 客户端（llm-summary 模式用）
 * @param summaryModelId 可选的汇总模型 id（'auto' 或空时降级为 concat）
 */
export async function aggregate(
  reports: ReviewerReport[],
  config: DeepReviewConfig,
  llmClient?: ILLMClient,
  summaryModelId?: string,
): Promise<AggregateResult> {
  // 1. 解析所有问题
  const allIssues: ReviewIssue[] = [];
  for (const report of reports) {
    allIssues.push(...parseIssuesFromReport(report));
  }

  // 2. 去重
  const issues = dedupeIssues(allIssues);

  // 3. 仲裁
  const arbitration = arbitrate(reports, issues, config.arbitration);

  // 4. 汇总
  const summary = await buildSummary(reports, config.aggregateMode, llmClient, summaryModelId);

  return { issues, arbitration, summary };
}
