// evals/repo-tasks/runner/redact.ts
// GA Infrastructure Sprint TASK 3 + Observability Closure（P1-INFRA-01）：
// Eval report 出口 redaction——复用共享脱敏模块（src/utils/redact-sensitive.ts），
// 不维护第二套正则。
//
// 持久化诊断 artifact（eval report JSON）不得包含明显凭据。本模块在
// run-task.ts 写 report 之前对敏感字段做值级 redaction：
//   - toolTrajectory 的 args / outputPreview / outputTail（shell 命令与输出可能含凭据）
//   - runEventLog 事件 payload 的 error / outputPreview / reason / input 文本
//   - finalPatch（diff 文本）中的凭据模式
// 结构保持不变（评分/分析字段 pass/hardGates/metrics/usage 数值不受影响）。
// Observability Closure（P2-ARTIFACT-05）：附加 artifactSecurity 完整性 metadata——
//   redacted / redactionCount / preRedactionSha256（只存 hash，不存 raw artifact）。

import { createHash } from 'node:crypto';
import {
  redactSensitiveText,
  redactSensitiveValue,
  redactSensitiveValueWithCount,
  redactSensitiveTextWithCount,
  SECRET_PATTERNS,
} from '../../../src/utils/redact-sensitive.js';

export { SECRET_PATTERNS, redactSensitiveText, redactSensitiveValue };
// 向后兼容别名（既有测试/调用方用 redactText/redactValue）
export { redactSensitiveText as redactText, redactSensitiveValue as redactValue };

/** 对整份 report 的字符串字段做脱敏并计数（finalPatch/checks 等） */
function redactTextCounted(value: string): { text: string; count: number } {
  return redactSensitiveTextWithCount(value);
}

/**
 * report 级 redaction（RunResult 持久化副本）：
 *   artifact.toolTrajectory[].args/outputPreview/outputTail
 *   artifact.runEventLog[].payload（文本字段）
 *   artifact.finalPatch / changedFiles（diff 与文件名中的凭据）
 * 结构、数值字段（pass/hardGates/metrics/usage）保持不变。
 * 附加 artifactSecurity：{ redacted, redactionCount, preRedactionSha256 }。
 */
export function redactReport(report: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...report };
  const artifact = (report.artifact ?? {}) as Record<string, unknown>;
  if (!artifact) return out;

  const redactedArtifact: Record<string, unknown> = { ...artifact };
  let redactionCount = 0;

  const trajectory = artifact.toolTrajectory as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(trajectory)) {
    redactedArtifact.toolTrajectory = trajectory.map((c) => {
      const safe: Record<string, unknown> = { ...c };
      for (const field of ['args', 'outputPreview', 'outputTail'] as const) {
        const v = safe[field];
        if (v === undefined || v === null) continue;
        // P2-2：全部走递归计数版本——嵌套结构/敏感键的替换也计入 redactionCount
        const r = redactSensitiveValueWithCount(v, field);
        safe[field] = r.value;
        redactionCount += r.count;
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
          const r = redactSensitiveValueWithCount(v, k);
          safePayload[k] = r.value;
          redactionCount += r.count;
        }
        safe.payload = safePayload;
      }
      return safe;
    });
  }

  for (const field of ['finalPatch', 'publicChecks', 'hiddenChecks'] as const) {
    const v = artifact[field];
    if (typeof v === 'string') {
      const r = redactTextCounted(v);
      redactedArtifact[field] = r.text;
      redactionCount += r.count;
    } else if (Array.isArray(v)) {
      redactedArtifact[field] = v.map((c) => {
        if (typeof c === 'string') return redactSensitiveText(c);
        if (c && typeof c === 'object') {
          const o = c as Record<string, unknown>;
          const safe: Record<string, unknown> = { ...o };
          if (typeof safe.outputPreview === 'string') {
            const r = redactTextCounted(safe.outputPreview as string);
            safe.outputPreview = r.text;
            redactionCount += r.count;
          }
          return safe;
        }
        return c;
      });
    }
  }

  if (Array.isArray(artifact.changedFiles)) {
    redactedArtifact.changedFiles = (artifact.changedFiles as string[]).map((f) => redactSensitiveText(f));
  }

  // Observability Closure（P2-ARTIFACT-05）：完整性 metadata——只存 hash，不存 raw
  const rawFinalPatch = typeof artifact.finalPatch === 'string' ? artifact.finalPatch : '';
  redactedArtifact.artifactSecurity = {
    redacted: redactionCount > 0,
    redactionCount,
    preRedactionSha256: createHash('sha256').update(rawFinalPatch, 'utf-8').digest('hex'),
  };

  out.artifact = redactedArtifact;
  return out;
}
