// evals/repo-tasks/runner/redact.ts
// GA Infrastructure Sprint TASK 3：Secret / Trace Redaction Hardening
//
// 持久化诊断 artifact（eval report JSON）不得包含明显的凭据。本模块在
// run-task.ts 写 report 之前对敏感字段做值级 redaction：
//   - toolTrajectory 的 args / outputPreview / outputTail（shell 命令与输出可能含凭据）
//   - runEventLog 事件 payload 的 error / outputPreview / reason / input 文本
//   - finalPatch（diff 文本）中的凭据模式
//   - 键名含 password/token/secret/authorization/api_key 的对象字段 → 值整体 [REDACTED]
//
// 结构保持不变（评分/分析字段 pass/hardGates/metrics/usage 数值不受影响）。
// 生产 RunEventLog schema 不改——redaction 只作用于持久化出口副本。

const REDACTED = '[REDACTED]';

/** 明显凭据模式 corpus（与 fake-secret 测试同款） */
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

/** 文本级 redaction：把明显凭据替换为 [REDACTED] */
export function redactText(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/** 键名含敏感词 → 值整体 redact（防御：结构化字段如 headers/password 对象） */
const SENSITIVE_KEYS = /(password|passwd|token|secret|authorization|api[_-]?key|apikey|credential)/i;

/** 递归值级 redaction：字符串应用 redactText；敏感键的值直接 [REDACTED] */
export function redactValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEYS.test(key)) return REDACTED;
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}

/**
 * report 级 redaction（RunResult 持久化副本）：
 *   artifact.toolTrajectory[].args/outputPreview/outputTail
 *   artifact.runEventLog[].payload（文本字段）
 *   artifact.finalPatch / changedFiles（diff 与文件名中的凭据）
 * 结构、数值字段（pass/hardGates/metrics/usage）保持不变。
 */
export function redactReport(report: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...report };
  const artifact = (report.artifact ?? {}) as Record<string, unknown>;
  if (!artifact) return out;

  const redactedArtifact: Record<string, unknown> = { ...artifact };

  const trajectory = artifact.toolTrajectory as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(trajectory)) {
    redactedArtifact.toolTrajectory = trajectory.map((c) => {
      const safe: Record<string, unknown> = { ...c };
      for (const field of ['args', 'outputPreview', 'outputTail'] as const) {
        if (typeof safe[field] === 'string') safe[field] = redactText(safe[field] as string);
        else if (safe[field] !== undefined && safe[field] !== null) safe[field] = redactValue(safe[field]);
      }
      return safe;
    });
  }

  const eventLog = artifact.runEventLog as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(eventLog)) {
    redactedArtifact.runEventLog = eventLog.map((e) => {
      const safe: Record<string, unknown> = { ...e };
      if (e.payload && typeof e.payload === 'object') {
        const payload = e.payload as Record<string, unknown>;
        const safePayload: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload)) {
          if (typeof v === 'string' && /(error|outputPreview|reason|input|message)/i.test(k)) {
            safePayload[k] = redactText(v);
          } else {
            safePayload[k] = redactValue(v, k);
          }
        }
        safe.payload = safePayload;
      }
      return safe;
    });
  }

  for (const field of ['finalPatch', 'publicChecks', 'hiddenChecks'] as const) {
    const v = artifact[field];
    if (typeof v === 'string') redactedArtifact[field] = redactText(v);
    else if (Array.isArray(v)) {
      redactedArtifact[field] = v.map((c) => {
        if (typeof c === 'string') return redactText(c);
        if (c && typeof c === 'object') {
          const o = c as Record<string, unknown>;
          const safe: Record<string, unknown> = { ...o };
          if (typeof safe.outputPreview === 'string') safe.outputPreview = redactText(safe.outputPreview);
          return safe;
        }
        return c;
      });
    }
  }

  if (Array.isArray(artifact.changedFiles)) {
    redactedArtifact.changedFiles = (artifact.changedFiles as string[]).map((f) => redactText(f));
  }

  out.artifact = redactedArtifact;
  return out;
}
