// src/utils/redact-sensitive.ts
// GA Observability Closure（P1-INFRA-01）：共享持久化脱敏模块。
//
// 设计原则（评审指定）：
//   - 只对 persistence / diagnostic sink 脱敏——不得修改运行时真实 ToolResult、
//     LLM context、执行参数（否则改变 Agent 行为）。
//   - 所有持久化诊断出口统一复用：Production Logger sink / RunEventLog disk payload /
//     TraceCollector disk record / Eval report。
//   - schema 不变：只做值级脱敏（字符串替换、敏感键整体 [REDACTED]），结构与数值保留。

export const REDACTED = '[REDACTED]';

/** 明显凭据模式 corpus（fake-secret 测试同款；模式级匹配，不依赖真实 key） */
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'sk-api-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'ghp-token', re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { name: 'authorization-header', re: /\b(Authorization|authorization)\s*[:=]\s*[^\s,;]{8,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'password-assign', re: /\b(password|passwd|pwd)\s*[:=]\s*[^\s,;]{4,}/gi },
  { name: 'token-assign', re: /\b(token|access_token|refresh_token|api_token|api_key|apikey)\s*[:=]\s*[^\s,;]{4,}/gi },
  { name: 'secret-assign', re: /\b(secret|client_secret|app_secret)\s*[:=]\s*[^\s,;]{4,}/gi },
  { name: 'conn-url-userpass', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/]+:[^\s@/]+@[^\s/]+/gi },
  { name: 'basic-auth', re: /\bBasic\s+[A-Za-z0-9+/=]{12,}/g },
];

/** 文本级脱敏：明显凭据 → [REDACTED] */
export function redactSensitiveText(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/** 文本级脱敏 + 替换次数（artifact 完整性 metadata 用） */
export function redactSensitiveTextWithCount(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, () => { count += 1; return REDACTED; });
  }
  return { text: out, count };
}

/** 键名含敏感词 → 值整体 redact（防御：结构化字段如 headers/password 对象） */
const SENSITIVE_KEYS = /(password|passwd|token|secret|authorization|api[_-]?key|apikey|credential)/i;

/** 递归值级脱敏：字符串应用 redactSensitiveText；敏感键的值直接 [REDACTED] */
export function redactSensitiveValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEYS.test(key)) return REDACTED;
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactSensitiveValue(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSensitiveValue(v, k);
    return out;
  }
  return value;
}

/**
 * P2-2（GA Unified Closure）：递归值级脱敏 + **真实替换计数**。
 * redactSensitiveValue 内部的替换（嵌套结构、敏感键整体、数组元素）此前不计数——
 * artifact 的 redactionCount/redacted 可能为 0 而值实际已变。本函数把
 * 字符串模式替换与敏感键整体替换全部计入 count。
 */
export function redactSensitiveValueWithCount(value: unknown, key?: string): { value: unknown; count: number } {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEYS.test(key)) return { value: REDACTED, count: 1 };
    const r = redactSensitiveTextWithCount(value);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((v) => {
      const r = redactSensitiveValueWithCount(v);
      count += r.count;
      return r.value;
    });
    return { value: out, count };
  }
  if (value !== null && typeof value === 'object') {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactSensitiveValueWithCount(v, k);
      count += r.count;
      out[k] = r.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}
