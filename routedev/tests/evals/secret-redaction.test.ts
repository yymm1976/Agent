// tests/evals/secret-redaction.test.ts
// GA Infrastructure Sprint TASK 3：Secret / Trace Redaction Hardening
//
// 只使用 fake secret（明显伪造值，绝不使用真实 key/环境变量）。
// 覆盖：
// 1. redactText 模式 corpus：API keys / Bearer / Authorization / JWT / password= /
//    token= / secret= / 连接 URL / nested JSON
// 2. redactValue：敏感键名整体 redact + 递归嵌套
// 3. artifact-level regression：构建含全部 fake secret 的 report → redactReport →
//    JSON 序列化后断言每个 raw secret literal 出现 0 次
// 4. 结构保持：pass/hardGates/metrics/usage 数值与数组长度不变

import { describe, it, expect } from 'vitest';
import { redactText, redactValue, redactReport } from '../../evals/repo-tasks/runner/redact.js';

/** fake secret corpus——全部为明显伪造值 */
const FAKE_SECRETS = {
  skKey: 'sk-fake1234567890abcdef123456',
  ghp: 'ghp_fakeToken1234567890abcdef',
  pat: 'github_pat_11FAKEABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
  bearer: 'Bearer fake-bearer-token-9876543210',
  authHeader: 'Authorization: Basic ZmFrZTpmYWtl',
  basic: 'Basic ZmFrZTpmYWtlLXNlY3JldA==',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.fakeSignature123',
  password: 'password=super-secret-123',
  tokenAssign: 'token=abc123tokenxyz',
  secretAssign: 'client_secret=verysecretvalue42',
  connUrl: 'https://admin:dbpass123@example.com:8443/api',
  mysqlUrl: 'mysql://root:mysqlpass@db.internal:3306/prod',
};

describe('redactText — 模式 corpus', () => {
  it('API key（sk- 前缀）', () => {
    expect(redactText(`key=${FAKE_SECRETS.skKey}`)).toBe('key=[REDACTED]');
  });

  it('GitHub token（ghp_ / github_pat_）', () => {
    // 级联替换：ghp 命中后 token= 前缀可能被后续模式再替换——语义断言（literal 必须消失）
    expect(redactText(`token=${FAKE_SECRETS.ghp}`)).not.toContain(FAKE_SECRETS.ghp);
    expect(redactText(FAKE_SECRETS.pat)).toBe('[REDACTED]');
  });

  it('Bearer token', () => {
    expect(redactText(`curl -H "${FAKE_SECRETS.bearer}" https://api.x`)).toContain('[REDACTED]');
    expect(redactText(FAKE_SECRETS.bearer)).not.toContain('fake-bearer-token');
  });

  it('Authorization 头与 Basic', () => {
    expect(redactText(FAKE_SECRETS.authHeader)).not.toContain('ZmFrZTpmYWtl');
    expect(redactText(FAKE_SECRETS.basic)).toBe('[REDACTED]');
  });

  it('JWT（三段式）', () => {
    expect(redactText(FAKE_SECRETS.jwt)).toBe('[REDACTED]');
  });

  it('password=/token=/secret= 赋值', () => {
    expect(redactText(FAKE_SECRETS.password)).toBe('[REDACTED]');
    expect(redactText(FAKE_SECRETS.tokenAssign)).toBe('[REDACTED]');
    expect(redactText(FAKE_SECRETS.secretAssign)).toBe('[REDACTED]');
  });

  it('连接 URL（含 user:pass@）', () => {
    expect(redactText(FAKE_SECRETS.connUrl)).not.toContain('dbpass123');
    expect(redactText(FAKE_SECRETS.mysqlUrl)).not.toContain('mysqlpass');
  });

  it('普通文本不受影响', () => {
    const t = 'The quick brown fox jumps over the lazy dog.';
    expect(redactText(t)).toBe(t);
  });
});

describe('redactValue — 键名与嵌套', () => {
  it('敏感键名（password/token/secret/authorization/api_key）值整体 redact', () => {
    const v = redactValue({ password: 'p1', token: 't1', api_key: 'k1', name: 'svc' });
    expect(v).toEqual({ password: '[REDACTED]', token: '[REDACTED]', api_key: '[REDACTED]', name: 'svc' });
  });

  it('嵌套 JSON（对象套对象套数组）递归 redact', () => {
    const v = redactValue({
      config: { auth: { apiKey: FAKE_SECRETS.skKey }, retries: 3 },
      headers: { Authorization: FAKE_SECRETS.bearer },
      list: ['keep', `pw=${FAKE_SECRETS.password}`],
      count: 42,
    });
    const json = JSON.stringify(v);
    expect(json).not.toContain(FAKE_SECRETS.skKey);
    expect(json).not.toContain('fake-bearer-token');
    expect(json).toContain('"retries":3');
    expect(json).toContain('"count":42');
    expect(json).toContain('keep');
  });
});

describe('artifact-level regression：注入 fake secrets → redact → 持久化断言 raw literal = 0', () => {
  it('完整 report（trajectory/runEventLog/finalPatch/checks）redact 后无任何 fake secret literal', () => {
    const report = {
      taskId: 'L2-FAKE',
      level: 'L2',
      provider: 'deepseek',
      scoring: { pass: false, mode: 'model-capability', hardGates: { safety: false, duplicateSideEffects: true, eventLogValid: true } },
      metrics: { llmRounds: 3, toolCalls: 4, failedToolCalls: 1, filesChanged: 1, linesChanged: 12, retries: 0, durationMs: 5000 },
      artifact: {
        baselineSha: 'abc123',
        toolTrajectory: [
          { toolName: 'shell_exec', toolCallId: 'c1', isError: false, args: { command: `curl -H "${FAKE_SECRETS.bearer}" ${FAKE_SECRETS.connUrl}` }, outputPreview: `HTTP ${FAKE_SECRETS.skKey}`, outputTail: `err: ${FAKE_SECRETS.jwt}`, timestamp: 1 },
          { toolName: 'file_write', toolCallId: 'c2', isError: false, args: { path: 'tests/a.test.ts', content: `const k = '${FAKE_SECRETS.password}';` }, outputPreview: 'written', timestamp: 2 },
        ],
        runEventLog: [
          { type: 'llm_failed', payload: { error: `provider error: ${FAKE_SECRETS.authHeader}`, errorKind: 'rate_limit' } },
          { type: 'tool_completed', payload: { outputPreview: `token=${FAKE_SECRETS.tokenAssign}`, isError: false } },
          { type: 'run_interrupted', payload: { reason: `secret=${FAKE_SECRETS.secretAssign}` } },
        ],
        finalPatch: `diff --git a/src/x.ts b/src/x.ts\n+const KEY='${FAKE_SECRETS.skKey}';\n+const URL='${FAKE_SECRETS.mysqlUrl}';`,
        changedFiles: ['src/x.ts'],
        publicChecks: [{ name: 't', passed: true, outputPreview: `${FAKE_SECRETS.ghp}` }],
      },
    };

    const safe = redactReport(report);
    const json = JSON.stringify(safe);

    // 断言：每个 fake secret literal 出现 0 次
    for (const [name, literal] of Object.entries(FAKE_SECRETS)) {
      expect(json.includes(literal), `${name} 泄漏: ${literal}`).toBe(false);
    }

    // 结构保持：评分/指标/数组长度不变
    const s = safe as typeof report;
    expect(s.scoring).toEqual(report.scoring);
    expect(s.metrics).toEqual(report.metrics);
    expect((s.artifact.toolTrajectory as unknown[]).length).toBe(2);
    expect((s.artifact.runEventLog as unknown[]).length).toBe(3);
    expect(s.artifact.changedFiles).toEqual(['src/x.ts']);
    // 文本字段被替换为 [REDACTED] 而非删除
    const traj = (s.artifact.toolTrajectory as Array<Record<string, unknown>>)[0]!;
    expect(String(traj.outputPreview)).toContain('[REDACTED]');
    expect(String(traj.args?.command)).toContain('[REDACTED]');
  });

  it('无 secret 的 report 保持逐字节一致（redaction 不误伤）', () => {
    const report = {
      taskId: 'L2-01',
      scoring: { pass: true, mode: 'model-capability' },
      metrics: { llmRounds: 15 },
      artifact: {
        toolTrajectory: [{ toolName: 'file_read', toolCallId: 'c1', isError: false, args: { path: 'src/a.ts' }, outputPreview: 'export const a = 1;', timestamp: 1 }],
        runEventLog: [{ type: 'llm_succeeded', payload: { usage: { totalTokens: 100 } } }],
        finalPatch: 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 2;',
      },
    };
    const safe = redactReport(report);
    expect(safe).toEqual(report);
  });
});
