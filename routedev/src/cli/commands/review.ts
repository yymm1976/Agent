// src/cli/commands/review.ts
// /review 命令：启动独立子代理对当前 diff 做对抗性审查
//
// 设计要点（Phase 47 Task 5）：
//   1. 独立子代理会话：不传入主会话的 conversationHistory（避免自我偏袒）
//      spawn_agent 内部已硬编码 conversationHistory: []，再通过 isolated: true 显式声明
//   2. 工具白名单：subagentType: 'reviewer'，只有 file_read/code_search/list_directory
//   3. 陷阱 #137：不能只靠工具白名单，沙箱级是确定性兜底
//      调用子代理前临时将 permissionEngine 沙箱级设为 read-only，调用后恢复
//   4. focus 参数：correctness/security/performance/style，决定审查侧重
//
// 流程：
//   1. 获取当前 diff（simple-git）
//   2. 无变更 → 返回「无需审查」
//   3. 获取变更文件列表
//   4. 构建审查 prompt（含 focus）
//   5. 临时设置沙箱级 read-only（确定性兜底）
//   6. 调用 spawn_agent（reviewer + isolated）
//   7. 恢复原沙箱级
//   8. 格式化审查结果输出

import type { CommandDefinition } from '../command-registry.js';
import type { SandboxLevel } from '../../tools/permission-engine.js';
import { logger } from '../../utils/logger.js';
import simpleGit from 'simple-git';

/** 审查 focus 参数类型 */
export type ReviewFocus = 'correctness' | 'security' | 'performance' | 'style';

/** 合法 focus 值列表 */
const VALID_FOCUS: ReviewFocus[] = ['correctness', 'security', 'performance', 'style'];

/** focus 参数中文说明，用于 prompt 构建 */
const FOCUS_LABEL: Record<ReviewFocus, string> = {
  correctness: '正确性（逻辑错误、边界条件、异常处理）',
  security: '安全性（注入、越权、敏感信息泄露、权限提升）',
  performance: '性能（时间复杂度、空间复杂度、不必要的开销）',
  style: '代码风格（命名、可读性、一致性、注释）',
};

/** focus 对应的审查要点关键词，注入到 prompt 中引导子代理关注 */
const FOCUS_KEYWORDS: Record<ReviewFocus, string[]> = {
  correctness: ['逻辑错误', '边界条件', '空指针', '异常处理', '竞态条件', 'off-by-one'],
  security: ['注入', '越权', '敏感信息', '权限提升', 'XSS', 'CSRF', 'SQL 注入', '路径穿越'],
  performance: ['时间复杂度', '空间复杂度', 'N+1 查询', '不必要的循环', '内存泄漏', '冗余计算'],
  style: ['命名规范', '可读性', '一致性', '注释缺失', '魔法数字', '函数过长'],
};

/** 解析 focus 参数，非法值默认 correctness */
function parseFocus(args: string): ReviewFocus {
  const trimmed = args.trim().toLowerCase();
  if (VALID_FOCUS.includes(trimmed as ReviewFocus)) {
    return trimmed as ReviewFocus;
  }
  return 'correctness';
}

/** 从 diff 文本中提取变更文件列表 */
function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  // 匹配 diff --git a/path b/path 行
  const regex = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(diff)) !== null) {
    files.add(match[2]);
  }
  return Array.from(files);
}

/** 截断过长的 diff，避免 prompt 超限 */
function truncateDiff(diff: string, maxLen: number = 8000): string {
  if (diff.length <= maxLen) return diff;
  return diff.slice(0, maxLen) + '\n\n... (diff 已截断，仅展示前 ' + maxLen + ' 字符)';
}

/**
 * 构建审查 prompt
 * @param focus 审查侧重
 * @param diff 当前 diff 文本
 * @param changedFiles 变更文件列表
 * @returns 给子代理的完整 prompt
 */
export function buildReviewPrompt(
  focus: ReviewFocus,
  diff: string,
  changedFiles: string[],
): string {
  const focusLabel = FOCUS_LABEL[focus];
  const keywords = FOCUS_KEYWORDS[focus].join('、');
  const fileList = changedFiles.length > 0
    ? changedFiles.map(f => `  - ${f}`).join('\n')
    : '  （未解析出文件列表）';
  const truncatedDiff = truncateDiff(diff);

  return `你是一个严格、对抗性的代码审查员（reviewer）。你的任务是找出当前代码变更中的问题，不偏袒作者。

【审查侧重】
${focusLabel}

【重点关注关键词】
${keywords}

【变更文件列表】
${fileList}

【当前 diff】
--- diff 开始 ---
${truncatedDiff}
--- diff 结束 ---

【审查要求】
1. 只针对 ${focusLabel} 方面审查，不要泛泛而谈
2. 每个问题必须给出：文件路径、行号（如能推断）、问题描述、严重级别（critical/major/minor）、修复建议
3. 如果没有发现问题，明确说明「未发现 ${focusLabel} 方面的问题」
4. 不要赞美代码，对抗性审查只关注问题
5. 可使用 file_read / code_search / list_directory 工具读取相关文件以确认问题

【输出格式】
按严重级别从高到低排列：

### Critical（必须修复）
- [文件:行号] 问题描述 → 修复建议

### Major（建议修复）
- [文件:行号] 问题描述 → 修复建议

### Minor（可选修复）
- [文件:行号] 问题描述 → 修复建议

### 总结
问题总数：X 个（critical: A, major: B, minor: C）`;
}

/**
 * 从子代理输出中统计问题数量
 * 简单解析：统计以 "- [" 开头的行数，并按严重级别分类
 */
export function parseReviewResult(output: string): {
  critical: number;
  major: number;
  minor: number;
  total: number;
} {
  let critical = 0;
  let major = 0;
  let minor = 0;

  // 按严重级别段落统计
  const sections = output.split(/###\s+/);
  for (const section of sections) {
    const isCritical = section.startsWith('Critical');
    const isMajor = section.startsWith('Major');
    const isMinor = section.startsWith('Minor');
    if (!isCritical && !isMajor && !isMinor) continue;

    // 统计以 "- [" 或 "* [" 开头的问题条目
    const lines = section.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[-*]\s*\[/.test(trimmed)) {
        if (isCritical) critical++;
        else if (isMajor) major++;
        else if (isMinor) minor++;
      }
    }
  }

  return { critical, major, minor, total: critical + major + minor };
}

/** 格式化审查结果输出 */
function formatReviewOutput(
  focus: ReviewFocus,
  changedFiles: string[],
  reviewOutput: string,
  counts: { critical: number; major: number; minor: number; total: number },
): string {
  const lines: string[] = [
    '━━━ /review 对抗性审查结果 ━━━',
    `审查侧重：${FOCUS_LABEL[focus]}`,
    `变更文件数：${changedFiles.length}`,
    `问题总数：${counts.total}（critical: ${counts.critical}, major: ${counts.major}, minor: ${counts.minor}）`,
    '───────────────────────────────',
    '',
    reviewOutput,
  ];
  return lines.join('\n');
}

export const reviewCommand: CommandDefinition = {
  name: 'review',
  aliases: ['rv'],
  description: '启动独立子代理对当前 diff 做对抗性审查（不共享主会话上下文）',
  usage: '/review [correctness|security|performance|style]',
  handler: async (args, ctx) => {
    const focus = parseFocus(args);
    const { cwd, toolExecutor, commandBridge, permissionEngine } = ctx;

    // ===== 第一步：获取当前 diff =====
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

    // ===== 第二步：获取变更文件列表 =====
    const changedFiles = extractChangedFiles(diff);

    // ===== 第三步：构建审查 prompt =====
    const reviewPrompt = buildReviewPrompt(focus, diff, changedFiles);

    commandBridge.addSystemMessage(
      `🔍 /review 启动对抗性审查（focus: ${focus}，变更文件 ${changedFiles.length} 个）...`,
    );

    // ===== 第四步：临时设置沙箱级为 read-only（陷阱 #137：确定性兜底） =====
    // 子代理工具白名单（reviewer）已限制为只读工具，但沙箱级是确定性兜底
    // 防止白名单遗漏或未来工具变更导致写工具被引入
    let originalSandboxLevel: SandboxLevel | null = null;
    if (permissionEngine) {
      originalSandboxLevel = permissionEngine.getSandboxLevel();
      permissionEngine.setSandboxLevel('read-only');
      logger.debug('review: sandbox level temporarily set to read-only', {
        original: originalSandboxLevel,
      });
    }

    // ===== 第五步：调用 spawn_agent 启动独立子代理 =====
    // 关键：isolated: true + subagentType: 'reviewer'
    // spawn_agent 内部硬编码 conversationHistory: []，子代理不接收主会话历史（避免自我偏袒）
    try {
      const result = await toolExecutor.executeTool(
        'spawn_agent',
        `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        {
          description: `对抗性代码审查 (focus: ${focus})`,
          prompt: reviewPrompt,
          subagentType: 'reviewer',
          isolated: true,
          maxIterations: 15,
        },
      );

      const isSuccess = !result.startsWith('[工具错误]');

      if (!isSuccess) {
        commandBridge.addSystemMessage(`❌ /review 子代理执行失败：${result}`);
        logger.warn('review command: sub-agent failed', { result });
        return { type: 'handled' };
      }

      // ===== 第六步：解析并格式化审查结果 =====
      const counts = parseReviewResult(result);
      const formatted = formatReviewOutput(focus, changedFiles, result, counts);

      logger.info('review command completed', {
        focus,
        changedFilesCount: changedFiles.length,
        totalIssues: counts.total,
        critical: counts.critical,
        major: counts.major,
        minor: counts.minor,
      });

      return { type: 'handled', messages: [formatted] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('review command failed', { error: msg });
      return { type: 'handled', messages: [`❌ /review 执行异常：${msg}`] };
    } finally {
      // ===== 恢复原沙箱级（陷阱 #137：必须恢复，避免影响主会话） =====
      if (permissionEngine && originalSandboxLevel !== null) {
        permissionEngine.setSandboxLevel(originalSandboxLevel);
        logger.debug('review: sandbox level restored', { restored: originalSandboxLevel });
      }
    }
  },
};
