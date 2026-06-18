// src/utils/error-messages.ts
// 错误消息人性化（Phase 24 Task 7）
// 将原始技术错误转换为三要素结构：发生了什么 + 可能原因 + 建议操作
// 使用设计系统的 ErrorMessageContent 类型

import type { ErrorMessageContent } from '../cli/design-system.js';
import {
  RouteDevError,
  ToolExecutionError,
  PermissionDeniedError,
  ConfigValidationError,
  SecurityViolationError,
  LLMError,
} from './errors.js';

// ============================================================
// 错误类型分类
// ============================================================

/** 错误大类 */
export type ErrorCategory =
  | 'llm_api'        // LLM API 调用失败
  | 'tool_exec'      // 工具执行失败
  | 'config'         // 配置错误
  | 'network'        // 网络错误
  | 'permission'     // 权限错误
  | 'unknown';       // 未知错误

// ============================================================
// 错误模式匹配规则
// ============================================================

interface ErrorPattern {
  /** 匹配模式（错误消息子串或正则） */
  pattern: RegExp;
  /** 对应的错误内容 */
  content: ErrorMessageContent;
}

/**
 * LLM API 错误模式表
 * 按常见错误类型分类
 */
const LLM_API_PATTERNS: ErrorPattern[] = [
  {
    pattern: /ECONNREFUSED|connect ECONNREFUSED/i,
    content: {
      what: '无法连接到 LLM 服务',
      why: '服务未启动，或端口号不对',
      how: '检查服务是否运行，或用 /config 修改 baseUrl',
    },
  },
  {
    pattern: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    content: {
      what: 'LLM 请求超时',
      why: '网络延迟过高，或模型响应过慢',
      how: '增加 timeoutMs 配置，或切换到更快的模型',
    },
  },
  {
    pattern: /401|unauthorized|invalid api key|authentication/i,
    content: {
      what: 'LLM API 鉴权失败',
      why: 'API Key 无效或已过期',
      how: '检查配置中的 apiKey 字段，确认环境变量已设置',
    },
  },
  {
    pattern: /429|rate limit|too many requests/i,
    content: {
      what: '触发 LLM 速率限制',
      why: '请求频率超过 provider 限制',
      how: '降低请求频率，或升级 API 配额',
    },
  },
  {
    pattern: /404|model not found|invalid model/i,
    content: {
      what: '指定的模型不存在',
      why: '模型 ID 拼写错误，或该 provider 不提供此模型',
      how: '用 /config 查看可用模型列表，或检查 router.rules 配置',
    },
  },
  {
    pattern: /500|502|503|internal server error|bad gateway|service unavailable/i,
    content: {
      what: 'LLM 服务端错误',
      why: 'provider 服务暂时不可用',
      how: '稍后重试，或切换到备用 provider',
    },
  },
];

/**
 * 工具执行错误模式表
 */
const TOOL_EXEC_PATTERNS: ErrorPattern[] = [
  {
    pattern: /ENOENT|no such file or directory/i,
    content: {
      what: '文件或目录不存在',
      why: '路径错误，或文件已被删除',
      how: '检查路径拼写，或用 file_search 查找文件',
    },
  },
  {
    pattern: /EACCES|permission denied/i,
    content: {
      what: '权限不足',
      why: '当前用户无权访问该资源',
      how: '检查文件权限，或以管理员身份运行',
    },
  },
  {
    pattern: /EISDIR/i,
    content: {
      what: '期望文件但收到目录',
      why: '路径指向了一个目录而非文件',
      how: '检查路径，或使用 list_directory 浏览目录',
    },
  },
  {
    pattern: /command not found|not recognized/i,
    content: {
      what: '命令未找到',
      why: '命令未安装，或不在 PATH 中',
      how: '安装对应工具，或检查 PATH 环境变量',
    },
  },
  {
    pattern: /exit code|exited with/i,
    content: {
      what: '命令执行失败',
      why: '命令返回非零退出码',
      how: '查看命令输出日志，修正参数或环境',
    },
  },
];

/**
 * 配置错误模式表
 */
const CONFIG_PATTERNS: ErrorPattern[] = [
  {
    pattern: /invalid config|config validation failed|schema error/i,
    content: {
      what: '配置文件格式错误',
      why: '配置不符合 schema 定义',
      how: '用 /config validate 检查配置，修正错误字段',
    },
  },
  {
    pattern: /missing required field|required property/i,
    content: {
      what: '配置缺少必填字段',
      why: '配置文件未提供所有必需字段',
      how: '查看 schema 文档，补充缺失字段',
    },
  },
  {
    pattern: /config file not found|cannot find config/i,
    content: {
      what: '配置文件未找到',
      why: '配置文件路径错误，或文件不存在',
      how: '用 /config init 创建默认配置，或指定正确路径',
    },
  },
];

/**
 * 网络错误模式表
 */
const NETWORK_PATTERNS: ErrorPattern[] = [
  {
    pattern: /ENOTFOUND|getaddrinfo ENOTFOUND/i,
    content: {
      what: 'DNS 解析失败',
      why: '域名不存在，或网络连接中断',
      how: '检查域名拼写，或检查网络连接',
    },
  },
  {
    pattern: /ECONNRESET|socket hang up/i,
    content: {
      what: '连接被重置',
      why: '服务端关闭了连接，或网络不稳定',
      how: '稍后重试，或检查网络稳定性',
    },
  },
  {
    pattern: /ECONNREFUSED/i,
    content: {
      what: '连接被拒绝',
      why: '目标服务未启动，或端口不对',
      how: '确认服务已启动，端口配置正确',
    },
  },
];

/**
 * 权限错误模式表
 */
const PERMISSION_PATTERNS: ErrorPattern[] = [
  {
    pattern: /permission denied|access denied/i,
    content: {
      what: '权限被拒绝',
      why: '当前自主度模式或权限规则不允许此操作',
      how: '用 /permissions 查看权限规则，或切换自主度模式',
    },
  },
  {
    pattern: /operation not allowed|blocked by/i,
    content: {
      what: '操作被拦截',
      why: '工作模式或权限引擎阻止了此操作',
      how: '切换工作模式（/build /plan /compose），或检查权限规则',
    },
  },
];

/**
 * 按类别组织的模式表
 */
const PATTERNS_BY_CATEGORY: Record<ErrorCategory, ErrorPattern[]> = {
  llm_api: LLM_API_PATTERNS,
  tool_exec: TOOL_EXEC_PATTERNS,
  config: CONFIG_PATTERNS,
  network: NETWORK_PATTERNS,
  permission: PERMISSION_PATTERNS,
  unknown: [],
};

// ============================================================
// 错误分类与格式化
// ============================================================

/**
 * 根据错误消息推断错误类别
 * @param errorMessage 错误消息
 * @returns 推断的错误类别
 */
export function classifyError(errorMessage: string): ErrorCategory {
  const lower = errorMessage.toLowerCase();

  // LLM API 错误
  if (/llm|api|model|openai|anthropic|claude|gpt|stream/.test(lower)) {
    return 'llm_api';
  }

  // 工具执行错误
  if (/tool|file|directory|command|exec|shell/.test(lower)) {
    return 'tool_exec';
  }

  // 配置错误
  if (/config|schema|validation/.test(lower)) {
    return 'config';
  }

  // 网络错误
  if (/network|dns|socket|connect|timeout/.test(lower)) {
    return 'network';
  }

  // 权限错误
  if (/permission|denied|blocked|forbidden/.test(lower)) {
    return 'permission';
  }

  return 'unknown';
}

/**
 * 人性化错误消息
 * 根据错误消息匹配模式表，返回三要素结构
 * @param error 原始错误对象或消息
 * @param category 强制指定类别（可选，未指定时自动推断）
 */
export function humanizeError(error: Error | string, category?: ErrorCategory): ErrorMessageContent {
  // Phase 26 Task 7：优先使用 instanceof 分类（结构化错误类型）
  if (error instanceof RouteDevError) {
    if (error instanceof ToolExecutionError) {
      return {
        what: `工具 ${error.toolName} 执行失败`,
        why: error.message,
        how: '检查工具参数和执行环境，查看 Trace 面板获取详细调用链',
      };
    }
    if (error instanceof PermissionDeniedError) {
      return {
        what: `权限不足: ${error.rule}`,
        why: error.message,
        how: '使用 /permissions 查看当前权限规则，或切换到更高自主度模式',
      };
    }
    if (error instanceof ConfigValidationError) {
      return {
        what: `配置错误: ${error.field}`,
        why: error.message,
        how: '检查配置文件中对应字段的值，参考 config.example.yaml',
      };
    }
    if (error instanceof SecurityViolationError) {
      return {
        what: '安全检查未通过',
        why: error.message,
        how: '确认操作是否在允许的目录和命令范围内',
      };
    }
    if (error instanceof LLMError) {
      return {
        what: `LLM 调用失败${error.provider ? ` (${error.provider})` : ''}`,
        why: error.message,
        how: error.statusCode === 401
          ? '检查 API Key 是否正确配置（使用 /config 查看当前配置）'
          : error.statusCode === 429
            ? '请求频率超限，稍后重试或降低调用频率'
            : '查看日志获取详细错误信息',
      };
    }
    // 其他 RouteDevError 子类
    return {
      what: error.message,
      why: `错误代码: ${error.code}`,
      how: '查看日志获取详细信息',
    };
  }

  // 降级到字符串模式匹配（向后兼容）
  const errorMessage = error instanceof Error ? error.message : String(error);
  const cat = category ?? classifyError(errorMessage);

  // 在对应类别的模式表中查找匹配
  const patterns = PATTERNS_BY_CATEGORY[cat];
  for (const pattern of patterns) {
    if (pattern.pattern.test(errorMessage)) {
      return pattern.content;
    }
  }

  // 跨类别查找（自动推断类别可能不准）
  for (const catKey of Object.keys(PATTERNS_BY_CATEGORY) as ErrorCategory[]) {
    if (catKey === cat || catKey === 'unknown') continue;
    for (const pattern of PATTERNS_BY_CATEGORY[catKey]) {
      if (pattern.pattern.test(errorMessage)) {
        return pattern.content;
      }
    }
  }

  // 兜底：返回原始错误消息
  return {
    what: errorMessage,
    why: '未知错误类型',
    how: '查看日志获取详细信息',
  };
}

/**
 * 格式化错误为多行字符串（带前缀标签）
 * @param error 原始错误
 * @param category 强制类别（可选）
 */
export function formatHumanError(error: Error | string, category?: ErrorCategory): string {
  const content = humanizeError(error, category);
  const lines = [`[错误] ${content.what}`];
  if (content.why) lines.push(`可能原因：${content.why}`);
  if (content.how) lines.push(`建议：${content.how}`);
  return lines.join('\n');
}

// ============================================================
// 路由透明化
// ============================================================

/** 路由通知配置 */
export interface RoutingNoticeOptions {
  /** 是否显示路由决策（默认 true） */
  showRoutingDecisions?: boolean;
  /** 是否显示详细信息（debug 模式） */
  verbose?: boolean;
}

/**
 * 生成路由决策通知消息
 * @param tier 任务等级
 * @param modelId 选择的模型 ID
 * @param confidence 分类置信度（可选）
 * @param reasoning 路由原因（可选）
 * @param options 显示选项
 */
export function formatRoutingNotice(
  tier: string,
  modelId: string,
  confidence?: number,
  reasoning?: string,
  options?: RoutingNoticeOptions,
): string[] {
  // 默认显示，可通过配置关闭
  if (options?.showRoutingDecisions === false) {
    return [];
  }

  const lines: string[] = [];
  const confidenceStr = confidence !== undefined ? ` (置信度 ${confidence.toFixed(2)})` : '';
  lines.push(`[路由] 任务分类: ${tier}${confidenceStr} → 使用 ${modelId}`);

  if (reasoning && options?.verbose) {
    lines.push(`[路由] 原因: ${reasoning}`);
  }

  return lines;
}
