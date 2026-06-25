// src/router/deterministic-rules.ts
// Phase 40 Task 2：确定性路由规则表
// 在 LLM 分类之前匹配确定性规则，命中后跳过 LLM 调用，直接走对应 handler
// 支持三种匹配方式：exact / startsWith / regex
// 支持用户自定义规则（从 .routedev/deterministic-rules.json 加载）

import { promises as fs } from 'node:fs';
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

// ============================================================
// 自定义规则加载
// ============================================================

/**
 * 从 JSON 文件加载用户自定义规则
 * 文件格式：DeterministicRule[]
 * 文件不存在或解析失败时返回空数组（不抛错，降级到仅内置规则）
 *
 * @param rulesPath JSON 文件绝对路径（如 .routedev/deterministic-rules.json）
 */
export async function loadCustomRules(rulesPath: string): Promise<DeterministicRule[]> {
  try {
    const content = await fs.readFile(rulesPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      logger.warn('Custom deterministic rules file is not an array, ignoring', { rulesPath });
      return [];
    }
    // 基本字段校验：每条规则必须有 id/pattern/matchType/handler
    const valid: DeterministicRule[] = [];
    for (const [idx, raw] of parsed.entries()) {
      if (isValidRule(raw)) {
        valid.push(raw);
      } else {
        logger.warn('Invalid deterministic rule at index, skipping', { rulesPath, index: idx });
      }
    }
    return valid;
  } catch (err) {
    // 文件不存在或 JSON 解析失败：静默降级
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.debug('Custom deterministic rules file not found, using builtin only', { rulesPath });
    } else {
      logger.warn('Failed to load custom deterministic rules, using builtin only', {
        rulesPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return [];
  }
}

/** 规则基本字段校验 */
function isValidRule(raw: unknown): raw is DeterministicRule {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.pattern === 'string' &&
    (r.matchType === 'exact' || r.matchType === 'regex' || r.matchType === 'startsWith') &&
    (r.handler === 'direct-response' || r.handler === 'tool-direct' || r.handler === 'command-dispatch')
  );
}

// ============================================================
// 规则合并
// ============================================================

/**
 * 合并内置规则和自定义规则
 * 策略：内置规则在前，自定义规则在后（自定义规则作为补充，不覆盖内置规则）
 * 自定义规则中与内置规则 id 重复的会被跳过（避免重复匹配）
 *
 * @param builtin 内置规则表
 * @param custom 用户自定义规则表
 * @returns 合并后的规则表
 */
export function mergeRules(builtin: DeterministicRule[], custom: DeterministicRule[]): DeterministicRule[] {
  const builtinIds = new Set(builtin.map((r) => r.id));
  const dedupedCustom = custom.filter((r) => !builtinIds.has(r.id));
  return [...builtin, ...dedupedCustom];
}
