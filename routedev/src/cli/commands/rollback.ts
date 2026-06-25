// src/cli/commands/rollback.ts
// 回滚命令：支持检查点回滚和选择性回滚
//
// 用法：
//   /rollback <checkpoint-id>                  — 回滚到指定检查点（破坏性操作）
//   /rollback file <path> [checkpoint-id]      — 只回滚指定文件
//   /rollback step <step-id>                   — 回滚到某步骤之前
//   /rollback preview <checkpoint-id>          — 预览回滚差异（不执行）
//
// file 子命令：用 git checkout <commit> -- <path> 回滚单个文件，回滚前自动创建检查点（"回滚前快照"）
// preview 子命令：用 git diff <commit> HEAD 显示差异，不修改任何文件
// step 子命令：简化为查找包含 step-id 的检查点并回滚

import type { CommandDefinition, CommandHandlerResult } from '../command-registry.js';
import type { ServiceContext } from '../service-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 执行 git 命令（使用 execFile 避免 shell 注入） */
async function execGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export const rollbackCommand: CommandDefinition = {
  name: 'rollback',
  description: '回滚到指定检查点或选择性回滚文件/步骤',
  usage:
    '/rollback <checkpoint-id> | /rollback file <path> [checkpoint-id] | /rollback step <step-id> | /rollback preview <checkpoint-id>',
  handler: async (args, ctx) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] || '';

    // 子命令分发：file / step / preview
    if (sub === 'file') {
      return handleFileRollback(parts.slice(1), ctx);
    }
    if (sub === 'step') {
      return handleStepRollback(parts.slice(1), ctx);
    }
    if (sub === 'preview') {
      return handlePreviewRollback(parts.slice(1), ctx);
    }

    // 原有行为：/rollback <checkpoint-id>
    const { checkpointManager, commandBridge } = ctx;
    const id = args.trim();
    if (!id) {
      return {
        type: 'handled',
        messages: [
          '用法:',
          '  /rollback <checkpoint-id> — 回滚到指定检查点',
          '  /rollback file <path> [checkpoint-id] — 只回滚指定文件',
          '  /rollback step <step-id> — 回滚到某步骤之前',
          '  /rollback preview <checkpoint-id> — 预览回滚差异',
          '使用 /checkpoint list 查看可用检查点。',
        ],
      };
    }

    // 支持前缀匹配
    const checkpoints = checkpointManager.list();
    const target = checkpoints.find(c => c.id === id || c.id.startsWith(id));
    if (!target) {
      return { type: 'handled', messages: [`未找到检查点 "${id}"。使用 /checkpoint list 查看可用检查点。`] };
    }

    const confirmed = await commandBridge.requestConfirm(
      [
        `⚠️ 即将回滚到检查点: cp-${target.id}`,
        `  描述: ${target.description}`,
        `  提交: ${target.gitCommitHash.slice(0, 7)}`,
        `  时间: ${new Date(target.timestamp).toLocaleString('zh-CN')}`,
        '',
        '⚠️ 这是破坏性操作（git reset --hard），回滚后当前未提交的变更将丢失！',
      ].join('\n'),
    );
    if (!confirmed) {
      return { type: 'handled', messages: ['回滚已取消。'] };
    }

    const success = await checkpointManager.rollback(target.id);
    if (!success) {
      return { type: 'handled', messages: ['回滚失败。请检查 Git 状态。'] };
    }
    commandBridge.clearChat();
    const remaining = checkpointManager.count;
    return {
      type: 'handled',
      messages: [`✓ 已回滚到 cp-${target.id} (${target.gitCommitHash.slice(0, 7)})。剩余 ${remaining} 个检查点。`],
    };
  },
};

/** /rollback file <path> [checkpoint-id] — 只回滚指定文件
 *  用 git checkout <commit> -- <path> 回滚单个文件
 *  回滚前自动创建检查点（"回滚前快照"）
 */
async function handleFileRollback(
  parts: string[],
  ctx: ServiceContext,
): Promise<CommandHandlerResult> {
  const { checkpointManager, cwd } = ctx;
  const filePath = parts[0];
  const checkpointId = parts[1];

  if (!filePath) {
    return {
      type: 'handled',
      messages: ['用法: /rollback file <path> [checkpoint-id]'],
    };
  }

  // 确定要回滚到的 commit
  let commitHash: string;
  let commitLabel: string;
  if (checkpointId) {
    const checkpoints = checkpointManager.list();
    const target = checkpoints.find(
      c => c.id === checkpointId || c.id.startsWith(checkpointId),
    );
    if (!target) {
      return {
        type: 'handled',
        messages: [`未找到检查点 "${checkpointId}"。`],
      };
    }
    commitHash = target.gitCommitHash;
    commitLabel = target.gitCommitHash.slice(0, 7);
  } else {
    // 默认回滚到 HEAD（即放弃当前工作区的修改）
    commitHash = 'HEAD';
    commitLabel = 'HEAD';
  }

  // 回滚前自动创建检查点（快照）
  const snapshot = await checkpointManager.create({
    description: `回滚前快照: ${filePath}`,
    isAutoCreated: false,
  });

  // 用 git checkout <commit> -- <path> 回滚单个文件
  try {
    await execGit(['checkout', commitHash, '--', filePath], cwd);
  } catch (error: any) {
    return {
      type: 'handled',
      messages: [`文件回滚失败: ${error.message}`],
    };
  }

  const snapshotMsg = snapshot
    ? `（已创建快照 cp-${snapshot.id}）`
    : '（无变更需快照）';
  return {
    type: 'handled',
    messages: [
      `✓ 文件 ${filePath} 已回滚到 ${commitLabel} ${snapshotMsg}`,
    ],
  };
}

/** /rollback step <step-id> — 回滚到某步骤之前
 *  简化实现：查找包含 step-id 的检查点并回滚（等同于 /rollback <checkpoint-id>）
 */
async function handleStepRollback(
  parts: string[],
  ctx: ServiceContext,
): Promise<CommandHandlerResult> {
  const { checkpointManager, commandBridge } = ctx;
  const stepIdStr = parts[0];
  if (!stepIdStr) {
    return {
      type: 'handled',
      messages: ['用法: /rollback step <step-id>'],
    };
  }

  const stepId = parseInt(stepIdStr, 10);
  if (isNaN(stepId)) {
    return {
      type: 'handled',
      messages: [`无效的步骤 ID: "${stepIdStr}"`],
    };
  }

  // 查找包含该 stepId 的检查点
  const checkpoints = checkpointManager.list();
  const target = checkpoints.find(c => c.stepId === stepId);
  if (!target) {
    return {
      type: 'handled',
      messages: [`未找到步骤 ${stepId} 对应的检查点。`],
    };
  }

  const confirmed = await commandBridge.requestConfirm(
    [
      `⚠️ 即将回滚到步骤 ${stepId} 之前的检查点: cp-${target.id}`,
      `  描述: ${target.description}`,
      `  提交: ${target.gitCommitHash.slice(0, 7)}`,
      '',
      '⚠️ 这是破坏性操作（git reset --hard），回滚后当前未提交的变更将丢失！',
    ].join('\n'),
  );
  if (!confirmed) {
    return { type: 'handled', messages: ['回滚已取消。'] };
  }

  const success = await checkpointManager.rollback(target.id);
  if (!success) {
    return { type: 'handled', messages: ['回滚失败。请检查 Git 状态。'] };
  }
  commandBridge.clearChat();
  return {
    type: 'handled',
    messages: [`✓ 已回滚到步骤 ${stepId} 之前 (cp-${target.id})。`],
  };
}

/** /rollback preview <checkpoint-id> — 预览回滚差异（不执行）
 *  用 git diff <commit> HEAD 显示差异，不修改任何文件
 */
async function handlePreviewRollback(
  parts: string[],
  ctx: ServiceContext,
): Promise<CommandHandlerResult> {
  const { checkpointManager, cwd } = ctx;
  const checkpointId = parts[0];
  if (!checkpointId) {
    return {
      type: 'handled',
      messages: ['用法: /rollback preview <checkpoint-id>'],
    };
  }

  const checkpoints = checkpointManager.list();
  const target = checkpoints.find(
    c => c.id === checkpointId || c.id.startsWith(checkpointId),
  );
  if (!target) {
    return {
      type: 'handled',
      messages: [`未找到检查点 "${checkpointId}"。`],
    };
  }

  // 用 git diff <commit> HEAD 显示差异，不修改任何文件
  try {
    const { stdout } = await execGit(
      ['diff', target.gitCommitHash, 'HEAD'],
      cwd,
    );
    if (!stdout.trim()) {
      return {
        type: 'handled',
        messages: [`检查点 cp-${target.id} 与当前 HEAD 无差异。`],
      };
    }
    // 截断过长的 diff 输出
    const lines = stdout.split('\n');
    const preview =
      lines.length > 100
        ? lines.slice(0, 100).join('\n') +
          `\n...（共 ${lines.length} 行，已截断）`
        : stdout;
    return {
      type: 'handled',
      messages: [
        `📋 回滚预览: cp-${target.id} (${target.gitCommitHash.slice(0, 7)}) → HEAD`,
        '（此操作不会修改任何文件）',
        '',
        preview,
      ],
    };
  } catch (error: any) {
    return {
      type: 'handled',
      messages: [`预览失败: ${error.message}`],
    };
  }
}
