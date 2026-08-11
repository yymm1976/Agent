import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EffectResolver } from '../tools/effect-resolver.js';
import { parseCommand, type ParsedCommand } from '../tools/command-parser.js';

export type ObligationKind = 'file' | 'component' | 'behavior' | 'verification' | 'implementation';

export interface TaskObligation {
  id: string;
  description: string;
  kind: ObligationKind;
  resourceHints: string[];
}

export interface RequirementEvidence {
  obligationId: string;
  description: string;
  sources: string[];
}

export interface CompletionEvidenceResult {
  status: 'complete' | 'recover' | 'interrupted';
  missing: string[];
  evidence: RequirementEvidence[];
  recoveryAttempts: number;
  recoveryMessage?: string;
  reason?: 'cancelled' | 'completion_evidence_missing' | 'policy_blocked_requirement';
}

interface MutationRecord {
  resource: string;
  epoch: number;
}

interface ObservedApiFile {
  /** comparison identity（normalized/lowercase——跨平台对比用） */
  identity: string;
  /** 实际文件系统路径（保留原始大小写——terminal 读取必须用真实路径，Linux case-sensitive） */
  actualPath: string;
  baseline: string;
}

const CODING_INTENT = /\b(add|build|change|create|delete|edit|fix|implement|migrate|refactor|remove|rename|update|write)\b|修复|实现|新增|修改|重构|删除|迁移/i;
const VERIFICATION_REQUEST = /\b(test|tests|typecheck|lint|build|verify|verification|green)\b|测试|验证|构建|类型检查/i;
const EXPLICIT_API_CHANGE = /\b(?:break(?:ing)? change|change|alter|widen|narrow|remove|rename)\b[^.\n]{0,48}\b(?:api|signature|return type|export)\b|(?:修改|变更|移除|重命名)[^。\n]{0,32}(?:API|接口|签名|返回类型|导出)/i;

/**
 * P1-1（GA Unified Closure）：verifier 定义文件——repository-controlled verifier
 * 的可信度必须绑定其定义未被 Run 内 mutation 修改。Agent 不能先改 verifier 定义
 * （package.json script / vitest·jest config / tsconfig）再用修改后的 verifier
 * 证明自己的完成。
 */
const VERIFIER_DEFINITION_FILES = [
  'package.json',
  'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs',
  'vitest.workspace.ts', 'vitest.workspace.js', 'vitest.workspace.mts', 'vitest.workspace.mjs',
  'jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs',
  'tsconfig.json', 'tsconfig.evals.json', 'tsconfig.desktop.json',
];

function normalizedExecutable(parsed: ParsedCommand): string | undefined {
  const normalized = parsed.command.replace(/\\/g, '/');
  if (normalized.includes('/')) return undefined;
  return normalized.toLowerCase().replace(/\.(?:cmd|exe|bat)$/, '');
}

function hasMutatingVerifierFlag(args: string[]): boolean {
  return args.some((arg) => arg === '--fix' || arg.startsWith('--fix=')
    || arg === '-u' || arg === '--update' || arg === '--update-snapshot'
    || arg === '--updatesnapshot' || arg.startsWith('--updatesnapshot=')
    || arg === '-o' || arg === '--output-file' || arg.startsWith('--output-file='));
}

function isTypeScriptNoEmit(args: string[]): boolean {
  const index = args.indexOf('--noemit');
  return (index >= 0 && args[index + 1] !== 'false') || args.includes('--noemit=true');
}

function isVerifierInvocation(parsed: ParsedCommand): boolean {
  const executable = normalizedExecutable(parsed);
  if (!executable) return false;
  const args = parsed.args.map((arg) => arg.toLowerCase());
  if (executable === 'pnpm' || executable === 'npm' || executable === 'yarn' || executable === 'npx') {
    if (hasMutatingVerifierFlag(args)) return false;
    const commandIndex = args[0] === 'run' || args[0] === 'exec' ? 1 : 0;
    const command = args[commandIndex];
    const commandArgs = args.slice(commandIndex + 1);
    if (command === 'tsc') return isTypeScriptNoEmit(commandArgs);
    if (command === 'vitest' || command === 'jest') return true;
    if (command === 'eslint') return executable === 'npx';
    return executable !== 'npx'
      && typeof command === 'string'
      && /^(?:test(?::[\w-]+)?|typecheck(?::[\w-]+)?|lint|build)$/.test(command);
  }
  if (executable === 'tsc') {
    return isTypeScriptNoEmit(args);
  }
  if (executable === 'eslint') {
    return !hasMutatingVerifierFlag(args);
  }
  if (executable === 'vitest' || executable === 'jest') return !hasMutatingVerifierFlag(args);
  if (executable === 'pytest') return true;
  if (executable === 'ruff') {
    return args[0] === 'check' && !hasMutatingVerifierFlag(args)
      || args[0] === 'format' && args.includes('--check');
  }
  if (executable === 'cargo') return ['test', 'check', 'build', 'clippy'].includes(args[0] ?? '');
  if (executable === 'go') return args[0] === 'test';
  if (['gradle', 'gradlew', 'mvn', 'dotnet'].includes(executable)) {
    return ['test', 'check', 'build'].includes(args[0] ?? '');
  }
  return false;
}

function isVerifierCommand(command: string): boolean {
  // A trailing fd-to-fd merge preserves the verifier exit status and does not
  // write a resource. File redirects and all other shell composition remain rejected.
  const directCommand = command.trim().replace(/\s+[12]>&[12]\s*$/, '');
  const parsed = parseCommand(directCommand);
  // A single successful shell status cannot prove every step in a pipeline,
  // sequence, fallback chain, redirect, or substitution succeeded safely.
  if (parsed.hasCommandChain || parsed.hasPipe || parsed.hasRedirect || parsed.hasSubstitution) return false;
  return isVerifierInvocation(parsed);
}

function normalizeResource(resource: string): string {
  return resource.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function matchingParen(source: string, open: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

/** Extract only explicit exported function return annotations; inferred internals are out of scope. */
function explicitFunctionReturns(source: string): Map<string, string> {
  const contracts = new Map<string, string>();
  const declaration = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of source.matchAll(declaration)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    const close = matchingParen(source, open);
    if (close < 0) continue;
    let cursor = close + 1;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== ':') continue;
    const start = ++cursor;
    while (cursor < source.length && source[cursor] !== '{' && source[cursor] !== '\n') cursor += 1;
    const returnType = source.slice(start, cursor).replace(/\s+/g, ' ').trim();
    if (returnType) contracts.set(match[1], returnType);
  }
  return contracts;
}

function uniquePush(obligations: TaskObligation[], obligation: Omit<TaskObligation, 'id'>): void {
  if (obligations.some((item) => item.description === obligation.description)) return;
  obligations.push({ id: `obligation-${obligations.length + 1}`, ...obligation });
}

function isReferenceOnlyPath(message: string, index: number): boolean {
  const prefix = message.slice(Math.max(0, index - 64), index);
  return /(?:\b(?:see|reference|compare with)|参考|参见|查看)[^.!?。]{0,32}$/i.test(prefix);
}

/** Deterministic, bounded task-contract extraction; no extra model call. */
export function extractTaskObligations(userMessage: string): TaskObligation[] {
  if (!CODING_INTENT.test(userMessage)) return [];
  const obligations: TaskObligation[] = [];
  const pathPattern = /\b(?:src|tests?|docs?|config|lib)[\\/][a-zA-Z0-9_.\\/-]+/g;
  for (const match of userMessage.matchAll(pathPattern)) {
    if (isReferenceOnlyPath(userMessage, match.index ?? 0)) continue;
    const resource = match[0].replace(/[.,;:]+$/, '');
    uniquePush(obligations, {
      description: `修改要求涉及文件 ${resource}`,
      kind: 'file',
      resourceHints: [normalizeResource(resource)],
    });
  }

  const components: Array<[RegExp, string, string[]]> = [
    [/schema|type definition|类型定义|配置模式/i, '实现 schema/type definition', ['schema', 'type']],
    [/config loader|\bloader\b|配置加载/i, '实现 config loader', ['loader']],
    [/runtime logger|\blogger\b|日志器/i, '实现 runtime logger', ['logger']],
    [/(?:its|the) tests|add[^.]{0,30}tests|update[^.]{0,30}tests|测试用例/i, '更新相关 tests', ['test', 'spec']],
    [/\breadme\b|documentation|文档示例/i, '更新 README/documentation', ['readme', 'docs/']],
  ];
  for (const [pattern, description, hints] of components) {
    if (pattern.test(userMessage)) uniquePush(obligations, { description, kind: 'component', resourceHints: hints });
  }

  if (/invalid[^.]{0,80}reject|validated?|校验|无效[^。]{0,40}拒绝/i.test(userMessage)) {
    uniquePush(obligations, {
      description: '无效配置必须被验证并拒绝',
      kind: 'behavior',
      resourceHints: ['loader', 'schema'],
    });
  }

  if (obligations.length === 0) {
    uniquePush(obligations, { description: '完成请求的实现变更', kind: 'implementation', resourceHints: [] });
  }
  if (VERIFICATION_REQUEST.test(userMessage) && obligations.length < 8) {
    uniquePush(obligations, { description: '在最新变更后完成验证', kind: 'verification', resourceHints: [] });
  }
  return obligations.slice(0, 8).map((item, index) => ({ ...item, id: `obligation-${index + 1}` }));
}

/**
 * Run-local evidence tracker. Assistant prose is intentionally never accepted
 * as evidence: only observed tool outcomes and their mutation/verification epoch.
 */
export class CompletionEvidenceGate {
  private readonly resolver = new EffectResolver();
  private readonly obligations: TaskObligation[];
  private readonly mutations: MutationRecord[] = [];
  private readonly verifierCommands: string[] = [];
  private readonly unresolvedFailures = new Set<string>();
  private readonly policyBlockedObligations = new Set<string>();
  private readonly observedApiFiles = new Map<string, ObservedApiFile>();
  private readonly apiContractChangesAllowed: boolean;
  private mutationEpoch = 0;
  private verifiedEpoch = -1;
  /** P1-B（Closure-2）：run 开始时冻结的 verifier 定义面 hash——仅当当前 verifier
   *  定义面与 baseline 完全一致时，verifier 成功才能 advance verifiedEpoch。
   *  （替代 P1-1 的"最后 mutation epoch"比较——后者在 verifier 被改后又发生无关
   *    mutation 时会错误恢复信任。） */
  private readonly baselineVerifierHash: string;
  private recoveryAttempts = 0;

  constructor(userMessage: string, private readonly workingDirectory: string) {
    this.obligations = extractTaskObligations(userMessage);
    this.apiContractChangesAllowed = EXPLICIT_API_CHANGE.test(userMessage);
    this.baselineVerifierHash = this.verifierSurfaceHash();
  }

  /** P1-B：verifier 定义面 hash——VERIFIER_DEFINITION_FILES 中实际存在的文件内容组合 */
  private verifierSurfaceHash(): string {
    const parts: string[] = [];
    for (const file of VERIFIER_DEFINITION_FILES) {
      try {
        parts.push(`${file}=${readFileSync(join(this.workingDirectory, file), 'utf-8')}`);
      } catch { /* 文件不存在 → 不参与 hash（baseline 与当前一致对待） */ }
    }
    return createHash('sha256').update(parts.join('\n---\n'), 'utf-8').digest('hex');
  }

  getObligations(): readonly TaskObligation[] {
    return this.obligations;
  }

  getEpochs(): { mutationEpoch: number; verifiedEpoch: number } {
    return { mutationEpoch: this.mutationEpoch, verifiedEpoch: this.verifiedEpoch };
  }

  observeAssistantText(_content: string): void {
    // Deliberate no-op: self-reported completion is not requirement evidence.
  }

  observeToolRejection(
    kind: 'safety' | 'user' | 'hook' = 'safety',
    toolName?: string,
    args?: Record<string, unknown>,
  ): void {
    this.unresolvedFailures.add(kind);
    if (kind !== 'safety' || !toolName || !args) return;
    const resolution = this.resolver.resolve(toolName, args, { workingDirectory: this.workingDirectory });
    const deniedResources = resolution.effects.flatMap((effect) => [
      effect.relativeResource,
      effect.resource,
      effect.canonicalResource,
    ]).filter((resource): resource is string => typeof resource === 'string')
      .map(normalizeResource);
    for (const obligation of this.obligations) {
      if (obligation.kind === 'verification' || obligation.resourceHints.length === 0) continue;
      if (obligation.resourceHints.some((hint) => deniedResources.some((resource) => resource.includes(normalizeResource(hint))))) {
        this.policyBlockedObligations.add(obligation.id);
      }
    }
  }

  observeToolResult(
    toolName: string,
    args: Record<string, unknown>,
    isError: boolean,
    output: string,
  ): void {
    const command = toolName === 'shell_exec' && typeof args.command === 'string' ? args.command : '';
    if (isError) {
      this.unresolvedFailures.add(isVerifierCommand(command) ? 'verification' : `tool:${toolName}`);
      return;
    }

    this.observeApiSurface(toolName, args, output);

    const effects = this.resolver.resolve(toolName, args, { workingDirectory: this.workingDirectory });
    const mutations = effects.effects.filter((effect) =>
      effect.kind === 'fs.write' || effect.kind === 'fs.create' || effect.kind === 'fs.delete'
      || effect.kind === 'fs.move' || effect.kind === 'git.mutate');
    if (mutations.length > 0) {
      this.mutationEpoch += 1;
      for (const effect of mutations) {
        const resource = effect.relativeResource ?? effect.resource;
        if (resource) {
          const normalized = normalizeResource(resource);
          this.mutations.push({ resource: normalized, epoch: this.mutationEpoch });
          // P2-B（Closure-2）：合法替代 evidence 可 supersede 被策略阻塞的 obligation——
          // file 级需精确路径命中；behavior/component 级任一匹配 mutation 即合法替代。
          for (const obligation of this.obligations) {
            if (!this.policyBlockedObligations.has(obligation.id)) continue;
            const superseded = obligation.kind === 'file'
              ? obligation.resourceHints.some((hint) => normalized === normalizeResource(hint))
              : obligation.resourceHints.length === 0
                || obligation.resourceHints.some((hint) => normalized.includes(normalizeResource(hint)));
            if (superseded) this.policyBlockedObligations.delete(obligation.id);
          }
        }
      }
      this.unresolvedFailures.delete(`tool:${toolName}`);
    }

    if (isVerifierCommand(command)) {
      // P1-B（Closure-2）：仅当当前 verifier 定义面与 baseline hash 完全一致时，
      // verifier 成功才 advance verifiedEpoch——`Agent 修改 verifier → 无关 mutation →
      // 用修改后的 verifier 自证` 的 invariant 成立（sticky：修改后永不恢复信任，
      // 除非 byte-identical 恢复原定义）。
      if (this.verifierSurfaceHash() === this.baselineVerifierHash) {
        this.verifiedEpoch = this.mutationEpoch;
      }
      this.verifierCommands.push(command.replace(/\s+/g, ' ').trim().slice(0, 160));
      this.unresolvedFailures.delete('verification');
      // A successful verifier supersedes earlier transient shell diagnostics:
      // the final repository state is now evidenced, while failed commands remain
      // available in the durable event log for audit.
      this.unresolvedFailures.delete('tool:shell_exec');
      // A successful verifier after a safely rejected attempt demonstrates the
      // accepted implementation path is coherent; the rejection remains in audit logs.
      this.unresolvedFailures.delete('safety');
    } else if (toolName !== 'shell_exec') {
      this.unresolvedFailures.delete(`tool:${toolName}`);
    }
  }

  evaluate(options: { cancelled?: boolean } = {}): CompletionEvidenceResult {
    if (options.cancelled) {
      return this.result('interrupted', [], [], 'cancelled');
    }
    if (this.obligations.length === 0) {
      return this.result('complete', [], []);
    }

    const evidence = this.buildEvidence();
    const missing = evidence.filter((item) => item.sources.length === 0).map((item) => item.description);

    // P1-2（GA Unified Closure）：policy denial 是 BLOCKED，不是 SATISFIED——
    // 被策略阻塞的 required obligation 不能通过 verifier green 或其他 evidence 满足。
    // 若存在被阻塞且无合法替代（无 mutation evidence）的 obligation，直接中断
    // （reason=policy_blocked_requirement），不进入 recover 循环（Agent 无法满足）。
    const blockedUnresolved = evidence.filter((item) =>
      this.policyBlockedObligations.has(item.obligationId) && item.sources.length === 0);
    if (blockedUnresolved.length > 0) {
      return this.result(
        'interrupted',
        blockedUnresolved.map((item) => item.description),
        evidence,
        'policy_blocked_requirement',
      );
    }

    if (this.mutationEpoch > 0 && this.verifiedEpoch !== this.mutationEpoch) {
      missing.push(`最新变更尚未验证（mutation epoch ${this.mutationEpoch}, verified epoch ${this.verifiedEpoch}）`);
    }
    if (this.unresolvedFailures.size > 0) {
      missing.push(`仍有未解决的失败：${[...this.unresolvedFailures].join(', ')}`);
    }
    missing.push(...this.apiContractViolations());

    if (missing.length === 0) return this.result('complete', missing, evidence);
    if (this.recoveryAttempts < 2) {
      this.recoveryAttempts += 1;
      const compact = missing.slice(0, 6).map((item) => `- ${item}`).join('\n');
      return {
        ...this.result('recover', missing, evidence),
        recoveryMessage: `[完成证据门] 尚不能宣告完成。请只补齐以下缺口，然后重新运行相关验证：\n${compact}`,
      };
    }
    return this.result('interrupted', missing, evidence, 'completion_evidence_missing');
  }

  private buildEvidence(): RequirementEvidence[] {
    const verificationCurrent = this.mutationEpoch > 0
      && this.verifiedEpoch === this.mutationEpoch;
    const verificationSource = verificationCurrent && this.verifierCommands.length > 0
      ? `verification:${this.verifierCommands.at(-1)}@${this.verifiedEpoch}`
      : undefined;
    return this.obligations.map((obligation) => {
      if (this.policyBlockedObligations.has(obligation.id)) {
        // P1-2：policy denial 不产生 positive evidence——被阻塞 obligation 的
        // sources 保持为空（缺失），由 evaluate 决定 interrupted 终态。
        return {
          obligationId: obligation.id,
          description: obligation.description,
          sources: [],
        };
      }
      const matching = obligation.kind === 'verification'
        ? []
        : this.mutations.filter((mutation) => obligation.resourceHints.length === 0
          || obligation.resourceHints.some((hint) => mutation.resource.includes(normalizeResource(hint))));
      const sources = matching.map((mutation) => `mutation:${mutation.resource}@${mutation.epoch}`);
      if (obligation.kind === 'verification') {
        if (verificationSource) sources.push(verificationSource);
      } else if (sources.length > 0 && verificationSource) {
        sources.push(verificationSource);
      } else if (sources.length > 0 && this.mutationEpoch === 0) {
        sources.length = 0;
      }
      return { obligationId: obligation.id, description: obligation.description, sources };
    });
  }

  private observeApiSurface(toolName: string, args: Record<string, unknown>, output: string): void {
    const rawPath = args.path ?? args.filePath ?? args.file_path;
    if (typeof rawPath !== 'string' || !/\.[cm]?[jt]sx?$/i.test(rawPath)) return;
    // P2-A（Closure-2）：identity 用于跨平台对比（normalized/lowercase）；
    // actualPath 保留原始大小写——terminal 读取必须用真实路径（Linux case-sensitive
    // 下 `src/MyLogger.ts` 不能被 `src/mylogger.ts` 替代，否则 ENOENT 假 violation）。
    const identity = normalizeResource(rawPath);
    const actualPath = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (toolName === 'file_read') {
      if (!this.observedApiFiles.has(identity) && explicitFunctionReturns(output).size > 0) {
        this.observedApiFiles.set(identity, { identity, actualPath, baseline: output });
      }
      return;
    }
    // file_write/file_edit 仍可用于更新 shadow（作为观察），但 terminal 校验以真实文件为准
    void toolName;
    void actualPath;
  }

  private apiContractViolations(): string[] {
    if (this.apiContractChangesAllowed) return [];
    const violations: string[] = [];
    for (const observed of this.observedApiFiles.values()) {
      const baseline = explicitFunctionReturns(observed.baseline);
      // P2-1 + P2-A（Closure/Closure-2）：terminal 校验比较 baseline contract 与
      // **实际最终文件系统**（真实路径大小写）——shell/node/python/git mutation 对
      // 真实源码的修改不能被 shadow replay 掩盖；Linux case-sensitive 下用原始路径。
      let currentSource: string;
      try {
        currentSource = readFileSync(join(this.workingDirectory, observed.actualPath), 'utf-8');
      } catch {
        currentSource = ''; // 文件被删除/移动 → 导出缺失 → violation
      }
      const current = explicitFunctionReturns(currentSource);
      for (const [name, expected] of baseline) {
        const actual = current.get(name);
        if (actual !== expected) {
          violations.push(`公共 API 返回契约发生未授权变更：${observed.actualPath}#${name} ${expected} → ${actual ?? '缺少显式返回类型'}`);
        }
      }
    }
    return violations;
  }

  private result(
    status: CompletionEvidenceResult['status'],
    missing: string[],
    evidence: RequirementEvidence[],
    reason?: CompletionEvidenceResult['reason'],
  ): CompletionEvidenceResult {
    return { status, missing, evidence, recoveryAttempts: this.recoveryAttempts, ...(reason ? { reason } : {}) };
  }
}
