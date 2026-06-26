// src/router/deterministic-rules.ts
// Phase 40 Task 2：确定性路由规则表
// 在 LLM 分类之前匹配确定性规则，命中后跳过 LLM 调用，直接走对应 handler
// 支持三种匹配方式：exact / startsWith / regex

import { logger } from '../utils/logger.js';

/** 确定性规则匹配方式 */
export type DeterministicMatchType = 'exact' | 'regex' | 'startsWith';

/** 确定性规则命中后的处理方式 */
export type DeterministicHandler =
  | 'direct-response' // 直接用 responseTemplate 返回（不调用 LLM）
  | 'tool-direct' // 直接调用 targetTool（不调用 LLM）
  | 'command-dispatch'; // 派发到 targetCommand（如 /cost → cost 命令）

/** 单条确定性规则 */
export interface DeterministicRule {
  /** 规则 ID（唯一标识，用于审计/日志） */
  id: string;
  /** 匹配模式（exact 时为字面量，regex 时为正则字符串，startsWith 时为前缀） */
  pattern: string;
  /** 匹配类型 */
  matchType: DeterministicMatchType;
  /** 命中后的处理方式 */
  handler: DeterministicHandler;
  /** direct-response 时的响应模板（支持 {{now}} {{date}} 等占位符） */
  responseTemplate?: string;
  /** tool-direct 时的目标工具名 */
  targetTool?: string;
  /** command-dispatch 时的目标命令名（不含斜杠） */
  targetCommand?: string;
}

// ============================================================
// 内置规则表
// 顺序敏感：matchDeterministicRule 返回第一个匹配的规则
// ============================================================

export const BUILTIN_DETERMINISTIC_RULES: DeterministicRule[] = [
  // --- 斜杠命令查询类（command-dispatch）---
  { id: 'cmd-cost', pattern: '/cost', matchType: 'exact', handler: 'command-dispatch', targetCommand: 'cost' },
  { id: 'cmd-history', pattern: '/history', matchType: 'exact', handler: 'command-dispatch', targetCommand: 'history' },
  { id: 'cmd-status', pattern: '/status', matchType: 'exact', handler: 'command-dispatch', targetCommand: 'status' },
  { id: 'cmd-help', pattern: '/help', matchType: 'exact', handler: 'command-dispatch', targetCommand: 'help' },
  { id: 'cmd-trust', pattern: '/trust', matchType: 'startsWith', handler: 'command-dispatch', targetCommand: 'trust' },
  { id: 'cmd-quality', pattern: '/quality', matchType: 'exact', handler: 'command-dispatch', targetCommand: 'quality' },

  // --- 简单信息查询（direct-response）---
  {
    id: 'time-query',
    pattern: '(现在几点|当前时间|几点了)',
    matchType: 'regex',
    handler: 'direct-response',
    responseTemplate: '当前时间：{{now}}',
  },
  {
    id: 'date-query',
    pattern: '(今天日期|今天几号|今天星期)',
    matchType: 'regex',
    handler: 'direct-response',
    responseTemplate: '今天：{{date}}',
  },

  // --- 纯文件读取/目录列出（无分析需求，tool-direct）---
  {
    id: 'read-file',
    pattern: '^读取\\s+(.+)$',
    matchType: 'regex',
    handler: 'tool-direct',
    targetTool: 'file_read',
  },
  {
    id: 'list-dir',
    pattern: '^列出\\s+(.+)\\s*目录?$',
    matchType: 'regex',
    handler: 'tool-direct',
    targetTool: 'list_directory',
  },
];

// ============================================================
// 规则匹配
// ============================================================

/**
 * 遍历规则表，返回第一个匹配的规则
 * - exact: trim 后精确比较
 * - startsWith: trim 后前缀匹配
 * - regex: 正则匹配（pattern 作为正则源，默认非全局、非多行）
 *
 * @param input 用户输入（已 trim）
 * @param rules 规则表（默认使用内置规则）
 * @returns 第一个匹配的规则，无匹配返回 null
 */
export function matchDeterministicRule(
  input: string,
  rules: DeterministicRule[] = BUILTIN_DETERMINISTIC_RULES,
): DeterministicRule | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  for (const rule of rules) {
    if (matchesRule(trimmed, rule)) {
      return rule;
    }
  }
  return null;
}

/** 单条规则匹配判断 */
function matchesRule(input: string, rule: DeterministicRule): boolean {
  switch (rule.matchType) {
    case 'exact':
      return input === rule.pattern;
    case 'startsWith':
      return input.startsWith(rule.pattern);
    case 'regex': {
      try {
        const re = new RegExp(rule.pattern);
        return re.test(input);
      } catch (err) {
        // 非法正则：记录警告并跳过该规则，避免阻断整个匹配链
        logger.warn('Invalid regex pattern in deterministic rule, skipping', {
          ruleId: rule.id,
          pattern: rule.pattern,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }
    default:
      return false;
  }
}

