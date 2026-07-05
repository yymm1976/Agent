// src/cli/commands/deep-review.ts
// /deep-review 命令：并行多 reviewer 对抗性审查（Phase 72）
//
// 用法：
//   /deep-review                     用 config.deepReviewFocuses（默认 4 个全开）
//   /deep-review correctness,security 只用指定 focus
//   /deep-review auto                按 config.focuses，风险评分低于阈值时降级提示
//
// 流程：
//   1. 获取 diff（simple-git）
//   2. 提取 changedFiles
//   3. 从 config 读取 DeepReviewConfig
//   4. 实例化 DeepReviewOrchestrator
//   5. 调用 orchestrator.review()
//   6. triggered=false 时降级提示
//   7. 格式化输出：风险评分 + 各 reviewer 摘要 + 仲裁结论 + 去重后问题列表

import type { CommandDefinition } from '../command-registry.js';
import type { WorkflowConfig } from '../../config/schema.js';
import type { ILLMClient } from '../../router/types.js';
import type { ReviewFocus } from './review.js';
import { logger } from '../../utils/logger.js';
import simpleGit from 'simple-git';
import { DeepReviewOrchestrator } from '../../agent/deep-review/orchestrator.js';
import type { DeepReviewConfig } from '../../agent/deep-review/types.js';

/** 合法 focus 值列表 */
const VALID_FOCUSES: ReviewFocus[] = ['correctness', 'security', 'performance', 'style'];

/**
 * 从 AppConfig 提取 DeepReviewConfig
 *
 * 把 WorkflowConfig 中的 deepReview* 字段映射到 DeepReviewConfig 结构，
 * 便于 orchestrator 单参数传入。
 */
function extractDeepReviewConfig(workflow: WorkflowConfig): DeepReviewConfig {
  return {
    enabled: workflow.deepReviewEnabled,
    focuses: workflow.deepReviewFocuses,
    parallel: workflow.deepReviewParallel,
    arbitration: workflow.deepReviewArbitration,
    aggregateMode: workflow.deepReviewAggregateMode,
    crossModel: workflow.deepReviewCrossModel,
    riskThreshold: workflow.deepReviewRiskThreshold,
    reviewModel: workflow.reviewModel,
    reviewStrictness: workflow.reviewStrictness,
  };
}

/** 解析 focus 列表参数（如 "correctness,security"） */
function parseFocuses(args: string): ReviewFocus[] | null {
  const trimmed = args.trim().toLowerCase();
  if (trimmed === 'auto' || trimmed === '') return null; // 用 config 默认

  const parts = trimmed.split(',').map(s => s.trim()).filter(s => s.length > 0);
  const valid: ReviewFocus[] = [];
  for (const p of parts) {
    if (VALID_FOCUSES.includes(p as ReviewFocus)) {
      valid.push(p as ReviewFocus);
    }
  }
  return valid.length > 0 ? valid : null;
}

/** 从 diff 文本中提取变更文件列表（与 review.ts 一致） */
function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  const regex = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(diff)) !== null) {
    files.add(match[2]);
  }
  return Array.from(files);
}

/** 严重级别对应图标 */
const SEVERITY_ICON: Record<string, string> = {
  critical: '🔴',
  major: '🟡',
  minor: '🔵',
};

/** 仲裁决策中文说明 */
const ARBITRATION_LABEL: Record<string, string> = {
  approve: '✅ 通过（可合并）',
  request_changes: '🟡 需要修改',
  reject: '🔴 拒绝（存在 critical 问题）',
  inconclusive: '⚪ 无法判定（reviewer 失败过多）',
};

/** 格式化最终输出 */
function formatDeepReviewOutput(
  riskScore: number,
  reports: Array<{ focus: ReviewFocus; success: boolean; issueCounts: { total: number; critical: number; major: number; minor: number }; error?: string; durationMs: number }>,
  issues: Array<{ focus: ReviewFocus; severity: string; file?: string; line?: string; description: string; suggestion?: string }>,
  arbitration: string,
  summary: string,
  durationMs: number,
): string {
  const lines: string[] = [];
  lines.push('━━━ /deep-review 并行多 reviewer 审查结果 ━━━');
  lines.push(`风险评分：${riskScore}/100`);
  lines.push(`总耗时：${durationMs}ms`);
  lines.push('───────────────────────────────');
  lines.push('');
  lines.push('【各 reviewer 摘要】');
  for (const r of reports) {
    const status = r.success
      ? `${r.issueCounts.total} 个问题（critical: ${r.issueCounts.critical}, major: ${r.issueCounts.major}, minor: ${r.issueCounts.minor}）`
      : `❌ 失败：${r.error ?? '未知错误'}`;
    lines.push(`  - ${r.focus}: ${status}（${r.durationMs}ms）`);
  }
  lines.push('');
  lines.push('【仲裁结论】');
  lines.push(`  ${ARBITRATION_LABEL[arbitration] ?? arbitration}`);
  lines.push('');
  lines.push('【汇总摘要】');
  lines.push(summary);
  lines.push('');
  if (issues.length > 0) {
    lines.push('【去重后问题列表】');
    // 按严重级别排序
    const order: Record<string, number> = { critical: 0, major: 1, minor: 2 };
    const sorted = [...issues].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    for (const i of sorted) {
      const icon = SEVERITY_ICON[i.severity] ?? '⚪';
      const loc = i.file ? `[${i.file}${i.line ? ':' + i.line : ''}]` : '[未知位置]';
      const sugg = i.suggestion ? ` → ${i.suggestion}` : '';
      lines.push(`  ${icon} (${i.focus}) ${loc} ${i.description}${sugg}`);
    }
  } else {
    lines.push('【去重后问题列表】');
    lines.push('  ✅ 无问题');
  }
  return lines.join('\n');
}

export const deepReviewCommand: CommandDefinition = {
  name: 'deep-review',
  aliases: ['dr'],
  description: '并行多 reviewer 对抗性审查（按风险评分触发，多维度去重仲裁）',
  usage: '/deep-review [focus1,focus2,...] | /deep-review auto',
  handler: async (args, ctx) => {
    const { config, cwd, toolExecutor, permissionEngine, commandBridge, clientManager } = ctx;

    // ===== 第一步：检查 Deep Review 是否启用 =====
    const workflow = config.optimization?.workflow;
    if (!workflow?.deepReviewEnabled) {
      return {
        type: 'handled',
        messages: [
          '❌ Deep Review 未启用。请在配置中设置 optimization.workflow.deepReviewEnabled=true',
          '提示：/review 命令无需启用 Deep Review 即可使用（单维度审查）',
        ],
      };
    }

    // ===== 第二步：获取当前 diff =====
    let diff: string;
    try {
      const git = simpleGit(cwd);
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return { type: 'handled', messages: ['当前目录不是 Git 仓库，无法审查。'] };
      }
      diff = await git.diff();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { type: 'handled', messages: [`❌ 获取 diff 失败: ${msg}`] };
    }

    if (!diff.trim()) {
      return { type: 'handled', messages: ['当前没有未提交的代码变更，无需审查。'] };
    }

    // ===== 第三步：提取变更文件列表 =====
    const changedFiles = extractChangedFiles(diff);

    // ===== 第四步：构建 DeepReviewConfig =====
    const deepConfig = extractDeepReviewConfig(workflow);
    // 解析 focus 参数：覆盖 config 中的 focuses
    const focusArgs = parseFocuses(args);
    if (focusArgs && focusArgs.length > 0) {
      deepConfig.focuses = focusArgs;
    }

    // ===== 第五步：获取可用 LLM 客户端（供 llm-summary 聚合用 + 模型选择） =====
    // Phase 72 修复 C1：从 clientManager 派生 availableModels，避免 llm-summary/crossModel 静默失效
    const readyClients = clientManager.getReadyClients();
    const llmClient: ILLMClient | undefined = readyClients[0]?.client;
    // providerId 作为可用模型 id 列表（pickModel 启发式假设按能力降序排列）
    const availableModels = readyClients
      .map(c => c.providerId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    // ===== 第六步：实例化 orchestrator =====
    const orchestrator = new DeepReviewOrchestrator({
      toolExecutor,
      permissionEngine,
      commandBridge,
      llmClient,
      config: deepConfig,
      availableModels,
      cwd,
    });

    commandBridge?.addSystemMessage(
      `🔍 /deep-review 启动（focus: ${deepConfig.focuses.join(', ')}，变更文件 ${changedFiles.length} 个）...`,
    );

    // ===== 第七步：执行 review =====
    try {
      const result = await orchestrator.review({ diff, changedFiles });

      // ===== 第八步：triggered=false 时降级提示 =====
      if (!result.triggered) {
        return {
          type: 'handled',
          messages: [
            `⚠️ Deep Review 未触发：风险评分 ${result.riskScore}/100 低于阈值 ${deepConfig.riskThreshold}/100。`,
            `建议使用 /review 单维度审查（更轻量）。`,
            `如需强制触发，请在配置中调低 optimization.workflow.deepReviewRiskThreshold。`,
          ],
        };
      }

      // ===== 第九步：格式化输出 =====
      const formatted = formatDeepReviewOutput(
        result.riskScore,
        result.reports,
        result.aggregatedIssues,
        result.arbitration,
        result.summary,
        result.durationMs,
      );

      logger.info('deep-review command completed', {
        riskScore: result.riskScore,
        reviewerCount: result.reports.length,
        issueCount: result.aggregatedIssues.length,
        arbitration: result.arbitration,
        durationMs: result.durationMs,
      });

      return { type: 'handled', messages: [formatted] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('deep-review command failed', { error: msg });
      return { type: 'handled', messages: [`❌ /deep-review 执行异常：${msg}`] };
    }
  },
};
