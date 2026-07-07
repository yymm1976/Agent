// src/agent/handoff-contract.ts
// Phase 75-B1：File Handoff 契约（借鉴 Superpowers v6）
//
// subagent 间传递的数据（task brief / implementer report / review package / fix report）
// 落文件到 .routedev/sdd/<task-id>/，subagent 只回 <15 行 summary 给 parent。
//
// 设计动机：避免 42k chars dispatch 教训（99% 是粘贴的历史）。
// fresh subagent 只需要当前 task brief + 相关 interfaces + global constraints，
// 前序上下文由 ledger + git log + 落盘 artifact 承载，不应在 dispatch prompt 中重复。
//
// 本模块只定义契约 API，不重写 subagent 调度系统。
// 未来 subagent dispatch 时按此契约写 artifact + 回 summary 即可。

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ============================================================
// 类型定义
// ============================================================

/** Handoff artifact 类型 */
export type ArtifactType =
  | 'task-brief'
  | 'implementer-report'
  | 'review-package'
  | 'fix-report';

/** Handoff artifact 元数据 */
export interface HandoffArtifact {
  /** artifact 类型 */
  type: ArtifactType;
  /** 所属 task id */
  taskId: string;
  /** artifact 文件绝对路径 */
  filePath: string;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** <15 行 summary（给 parent agent 的内联响应） */
  summary: string;
}

// ============================================================
// 常量
// ============================================================

/** Summary 行数限制（Superpowers v6 规范） */
const MAX_SUMMARY_LINES = 15;

/** 合法的 artifact 类型集合（用于 listArtifacts 过滤） */
const VALID_ARTIFACT_TYPES: readonly ArtifactType[] = [
  'task-brief',
  'implementer-report',
  'review-package',
  'fix-report',
] as const;

// ============================================================
// 核心 API
// ============================================================

/**
 * 生成 artifact 文件路径
 *
 * 路径约定：`.routedev/sdd/<task-id>/<type>.md`
 *
 * @param taskId  所属 task id
 * @param type    artifact 类型
 * @param cwd     工作目录（默认 process.cwd()）
 * @returns artifact 文件绝对路径
 */
export function getArtifactPath(
  taskId: string,
  type: ArtifactType,
  cwd: string = process.cwd(),
): string {
  const dir = path.resolve(cwd, '.routedev', 'sdd', taskId);
  const fileName = `${type}.md`;
  return path.join(dir, fileName);
}

/**
 * 写 artifact 到文件，返回 summary（<15 行）
 *
 * @param taskId   所属 task id
 * @param type     artifact 类型
 * @param content  artifact 完整内容（落盘）
 * @param summary  <15 行 summary（内联回给 parent agent）
 * @param cwd      工作目录（默认 process.cwd()）
 * @returns HandoffArtifact 元数据
 * @throws 当 summary 超过 15 行限制时抛错
 */
export async function writeArtifact(
  taskId: string,
  type: ArtifactType,
  content: string,
  summary: string,
  cwd?: string,
): Promise<HandoffArtifact> {
  const filePath = getArtifactPath(taskId, type, cwd);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');

  // 校验 summary 行数（Superpowers v6 规范：≤15 行）
  const summaryLines = summary.split('\n');
  if (summaryLines.length > MAX_SUMMARY_LINES) {
    throw new Error(
      `Summary 超过 ${MAX_SUMMARY_LINES} 行限制（实际 ${summaryLines.length} 行）。` +
        'Summary 应只含：status + commits + one-line test summary + concerns + report path',
    );
  }

  return {
    type,
    taskId,
    filePath,
    createdAt: new Date().toISOString(),
    summary,
  };
}

/**
 * 读 artifact 文件内容
 *
 * @param taskId  所属 task id
 * @param type    artifact 类型
 * @param cwd     工作目录（默认 process.cwd()）
 * @returns 文件内容字符串；文件不存在时返回 null
 */
export async function readArtifact(
  taskId: string,
  type: ArtifactType,
  cwd?: string,
): Promise<string | null> {
  const filePath = getArtifactPath(taskId, type, cwd);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 列出指定 task 的所有 artifact
 *
 * 仅返回元数据（不含 content）；需要内容请用 readArtifact 获取。
 *
 * @param taskId  所属 task id
 * @param cwd     工作目录（默认 process.cwd()）
 * @returns HandoffArtifact 元数据数组（按 mtime 作为 createdAt）；目录不存在时返回 []
 */
export async function listArtifacts(
  taskId: string,
  cwd?: string,
): Promise<HandoffArtifact[]> {
  const dir = path.resolve(cwd ?? process.cwd(), '.routedev', 'sdd', taskId);
  try {
    const files = await fs.readdir(dir);
    const artifacts: HandoffArtifact[] = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const type = file.replace(/\.md$/, '') as ArtifactType;
      if (!VALID_ARTIFACT_TYPES.includes(type)) continue;
      const filePath = path.join(dir, file);
      const stat = await fs.stat(filePath);
      artifacts.push({
        type,
        taskId,
        filePath,
        createdAt: stat.mtime.toISOString(),
        summary: '', // list 不返回 content，需 readArtifact 获取
      });
    }
    return artifacts;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// ============================================================
// Summary 构造模板
// ============================================================

/**
 * Implementer report summary 模板（<15 行）
 *
 * 字段：status + commits + one-line test summary + concerns + report path
 *
 * @param params.summary 字段集合
 * @returns 多行 summary 字符串
 */
export function buildImplementerSummary(params: {
  status: 'DONE' | 'DONE_WITH_CONCERNS' | 'NEEDS_CONTEXT' | 'BLOCKED';
  commits?: string[];
  testSummary?: string;
  concerns?: string[];
  reportPath: string;
}): string {
  const lines: string[] = [];
  lines.push(`Status: ${params.status}`);
  if (params.commits?.length) {
    lines.push(`Commits: ${params.commits.join(', ')}`);
  }
  if (params.testSummary) {
    lines.push(`Tests: ${params.testSummary}`);
  }
  if (params.concerns?.length) {
    lines.push(`Concerns:`);
    for (const c of params.concerns) lines.push(`  - ${c}`);
  }
  lines.push(`Report: ${params.reportPath}`);
  return lines.join('\n');
}

/**
 * Reviewer report summary 模板（<15 行，含三态）
 *
 * 三态：✅ clean / ❌ issues-found / ⚠️ cannot-verify
 * ⚠️ 项与 ✅/❌ 并列输出，不阻塞本次 review 其余部分；
 * controller 收到 ⚠️ 后必须自行校验（见 controller.rules 第 7 条）。
 *
 * @param params summary 字段集合
 * @returns 多行 summary 字符串
 */
export function buildReviewerSummary(params: {
  verdict: 'clean' | 'issues-found' | 'cannot-verify';
  findingsCount?: { critical: number; important: number; minor: number };
  cannotVerifyItems?: string[];
  reportPath: string;
}): string {
  const lines: string[] = [];
  // 三态符号映射：✅ clean / ❌ issues-found / ⚠️ cannot-verify
  const verdictSymbol =
    params.verdict === 'clean'
      ? '✅'
      : params.verdict === 'issues-found'
        ? '❌'
        : '⚠️';
  lines.push(`Verdict: ${verdictSymbol} ${params.verdict}`);
  if (params.findingsCount) {
    const { critical, important, minor } = params.findingsCount;
    lines.push(`Findings: ${critical} critical / ${important} important / ${minor} minor`);
  }
  if (params.cannotVerifyItems?.length) {
    lines.push(`Cannot verify from diff:`);
    for (const item of params.cannotVerifyItems) lines.push(`  ⚠️ ${item}`);
  }
  lines.push(`Report: ${params.reportPath}`);
  return lines.join('\n');
}
