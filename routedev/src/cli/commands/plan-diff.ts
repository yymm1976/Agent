// src/cli/commands/plan-diff.ts
// /plan-diff 命令：Plan 修订历史查看 + 遗漏点检查
//   /plan-diff <goalId>             显示指定 goal 的 plan 修订历史（diff 视图）
//   /plan-diff omissions <goalId>   触发遗漏点检查（需 config.plan.omissionCheckEnabled=true）
//
// 注：命令名用 plan-diff 而非 plan，避免与 work-modes.ts 的 /plan（工作模式切换）冲突
// 修订历史读取自 .routedev/plan-revisions/<goalId>.jsonl（每行一个 revision）

import type { CommandDefinition } from '../command-registry.js';
import { PlanDiffEngine, type PlanStep, type PlanDiff } from '../../agent/plan-diff.js';
import { OmissionChecker, type OmissionResult } from '../../agent/omission-checker.js';
import { logger } from '../../utils/logger.js';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

/** 单条修订记录（从 JSONL 读取） */
interface PlanRevision {
  revisedAt: number;
  reason: string;
  before: PlanStep[];
  after: PlanStep[];
}

/** 渲染单个 PlanDiff 为可读文本 */
function renderPlanDiff(diff: PlanDiff, revisedAt: number, reason: string): string {
  const lines: string[] = [];
  const time = new Date(revisedAt).toLocaleString('zh-CN', { hour12: false });
  lines.push(`📅 修订时间: ${time}  原因: ${reason}`);

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
    lines.push('  (无差异)');
    return lines.join('\n');
  }

  if (diff.added.length > 0) {
    lines.push('  🟢 新增步骤:');
    for (const s of diff.added) {
      lines.push(`    + [${s.id}] ${s.description}`);
    }
  }
  if (diff.removed.length > 0) {
    lines.push('  🔴 删除步骤:');
    for (const s of diff.removed) {
      lines.push(`    - [${s.id}] ${s.description}`);
    }
  }
  if (diff.modified.length > 0) {
    lines.push('  🟡 修改步骤:');
    for (const m of diff.modified) {
      lines.push(`    ~ [${m.id}] 字段变更: ${m.fieldChanges.join(', ')}`);
      lines.push(`      修改前: ${m.before.description}`);
      lines.push(`      修改后: ${m.after.description}`);
    }
  }
  return lines.join('\n');
}

/** 渲染遗漏点检查结果 */
function renderOmissions(result: OmissionResult): string {
  const lines: string[] = [];
  lines.push(`📋 ${result.summary}`);

  if (result.omissions.length === 0) {
    lines.push('  ✅ 未发现遗漏点');
    return lines.join('\n');
  }

  const severityIcon: Record<string, string> = {
    critical: '🔴',
    major: '🟡',
    minor: '🔵',
  };

  for (const o of result.omissions) {
    const icon = severityIcon[o.severity] ?? '⚪';
    lines.push(`  ${icon} [${o.category}] ${o.description}`);
    if (o.suggestedStep) {
      lines.push(`     建议步骤: ${o.suggestedStep}`);
    }
  }
  return lines.join('\n');
}

/** 读取指定 goalId 的修订历史 */
function readRevisions(revisionDir: string, goalId: string): PlanRevision[] {
  const absDir = path.isAbsolute(revisionDir)
    ? revisionDir
    : path.resolve(process.cwd(), revisionDir);
  const filePath = path.join(absDir, `${goalId}.jsonl`);

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const revisions: PlanRevision[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        revisions.push(JSON.parse(trimmed) as PlanRevision);
      } catch (err) {
        logger.warn('[plan-diff] 跳过无法解析的修订记录行', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return revisions;
  } catch (err) {
    logger.warn('[plan-diff] 读取修订历史失败', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** /plan diff <goalId>：显示修订历史 */
async function handlePlanDiff(
  args: string,
  ctx: { config: { plan?: { revisionHistoryPath?: string } }; cwd: string },
): Promise<{ type: 'handled'; messages: string[] }> {
  const goalId = args.trim();
  if (!goalId) {
    return { type: 'handled', messages: ['用法: /plan diff <goalId>'] };
  }

  const revisionDir = ctx.config.plan?.revisionHistoryPath ?? '.routedev/plan-revisions/';
  const revisions = readRevisions(revisionDir, goalId);

  if (revisions.length === 0) {
    return { type: 'handled', messages: [`未找到 goalId=${goalId} 的 plan 修订历史`] };
  }

  const engine = new PlanDiffEngine();
  const lines: string[] = [`🎯 goalId=${goalId} 的 plan 修订历史（共 ${revisions.length} 次）`];
  for (const rev of revisions) {
    const diff = engine.diff(rev.before, rev.after);
    lines.push(renderPlanDiff(diff, rev.revisedAt, rev.reason));
    lines.push('');
  }
  return { type: 'handled', messages: [lines.join('\n')] };
}

/** /plan omissions <goalId>：触发遗漏点检查 */
async function handlePlanOmissions(
  args: string,
  ctx: { config: import('../../config/schema.js').AppConfig; clientManager: import('../../router/llm/index.js').LLMClientManager },
): Promise<{ type: 'handled'; messages: string[] }> {
  const goalId = args.trim();
  if (!goalId) {
    return { type: 'handled', messages: ['用法: /plan omissions <goalId>'] };
  }

  const planCfg = ctx.config.plan;
  if (!planCfg?.omissionCheckEnabled) {
    return {
      type: 'handled',
      messages: ['❌ 遗漏点检查未启用。请在配置中设置 plan.omissionCheckEnabled=true'],
    };
  }

  // 读取最近一次 plan 作为检查目标（用 after 字段）
  const revisionDir = planCfg.revisionHistoryPath ?? '.routedev/plan-revisions/';
  const revisions = readRevisions(revisionDir, goalId);
  const latestPlan = revisions.length > 0
    ? revisions[revisions.length - 1].after
    : [];

  if (latestPlan.length === 0) {
    return {
      type: 'handled',
      messages: [`未找到 goalId=${goalId} 的 plan 步骤，无法执行遗漏点检查`],
    };
  }

  // 获取 LLM 客户端（用 router 的 fast tier，或第一个可用客户端）
  const modelId = planCfg.omissionCheckModel ?? 'fast';
  // 从 clientManager 获取第一个就绪的客户端
  const readyClients = ctx.clientManager.getReadyClients();
  if (readyClients.length === 0) {
    return { type: 'handled', messages: ['❌ 无可用的 LLM 客户端，无法执行遗漏点检查'] };
  }
  const llmClient = readyClients[0].client;

  const checker = new OmissionChecker({
    llmClient,
    modelId,
    enabled: true,
  });

  try {
    const result = await checker.check(latestPlan, {
      goal: `goalId=${goalId} 的 plan 遗漏点检查`,
    });
    return { type: 'handled', messages: [renderOmissions(result)] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: 'handled', messages: [`❌ 遗漏点检查失败: ${msg}`] };
  }
}

export const planDiffCommand: CommandDefinition = {
  name: 'plan-diff',
  description: 'Plan 修订历史与遗漏点检查',
  usage: '/plan-diff <goalId> | /plan-diff omissions <goalId>',
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase();
    const restArgs = parts.slice(1).join(' ');

    // /plan-diff omissions <goalId>
    if (sub === 'omissions') {
      return handlePlanOmissions(restArgs, ctx);
    }

    // /plan-diff <goalId>（默认显示修订历史）
    // /plan-diff diff <goalId>（显式 diff 子命令也支持）
    if (sub === 'diff') {
      return handlePlanDiff(restArgs, ctx);
    }

    // 无子命令时把整个 args 当作 goalId
    if (args.trim().length > 0) {
      return handlePlanDiff(args.trim(), ctx);
    }

    return {
      type: 'handled',
      messages: [
        '用法:',
        '  /plan-diff <goalId>             查看 plan 修订历史',
        '  /plan-diff omissions <goalId>   触发遗漏点检查',
      ],
    };
  },
};
