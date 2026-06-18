// src/cli/commands/diff.ts
// 查看最近代码变更差异：/diff [page]
// Phase 25 Task 6：调用 git diff 并渲染为可视化 diff
// Phase 27 Task 5：支持 /diff apply 和 /diff reject 直接操作变更

import type { CommandDefinition } from '../command-registry.js';
import { renderDiffText, parseUnifiedDiff } from '../components/DiffView.js';
import simpleGit from 'simple-git';

export const diffCommand: CommandDefinition = {
  name: 'diff',
  description: '查看最近代码变更差异',
  usage: '/diff [页码|apply|reject]',
  handler: async (args, ctx) => {
    const git = simpleGit(ctx.cwd);
    try {
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return { type: 'handled', messages: ['当前目录不是 Git 仓库，无法查看 diff。'] };
      }
      const diff = await git.diff();
      if (!diff.trim()) {
        return { type: 'handled', messages: ['工作区没有未提交的变更。'] };
      }

      const sub = args.trim().toLowerCase();

      // /diff apply：通过 git apply 应用全部变更
      if (sub === 'apply') {
        return applyDiffViaGit(ctx.cwd, diff, ctx.commandBridge);
      }

      // /diff reject：丢弃全部变更（git checkout -- .）
      if (sub === 'reject') {
        return rejectDiffViaGit(ctx.cwd, ctx.commandBridge);
      }

      const parsed = parseUnifiedDiff(diff);
      const page = parseInt(args.trim() || '0', 10) || 0;
      const text = renderDiffText(parsed, page);
      return { type: 'handled', messages: [text] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { type: 'handled', messages: [`❌ 获取 diff 失败: ${msg}`] };
    }
  },
};

/**
 * 通过 git apply 应用 diff 到工作目录
 * 使用 ToolExecutor 执行 git apply 命令，结果通过 CommandBridge.addSystemMessage 通知用户
 */
async function applyDiffViaGit(
  cwd: string,
  diff: string,
  bridge: { addSystemMessage: (content: string) => void },
): Promise<{ type: 'handled'; messages: string[] }> {
  try {
    const git = simpleGit(cwd);
    // simple-git 的 applyPatch 接收 patch 文本作为参数
    await git.applyPatch(diff);
    bridge.addSystemMessage('✓ 已通过 git apply 应用全部变更到工作目录。');
    return { type: 'handled', messages: ['✓ 变更已应用（git apply）。'] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    bridge.addSystemMessage(`❌ git apply 失败: ${msg}`);
    return { type: 'handled', messages: [`❌ 应用变更失败: ${msg}`] };
  }
}

/**
 * 丢弃全部工作区变更（git checkout -- .）
 * 通过 CommandBridge.addSystemMessage 通知"变更已拒绝"
 */
async function rejectDiffViaGit(
  cwd: string,
  bridge: { addSystemMessage: (content: string) => void },
): Promise<{ type: 'handled'; messages: string[] }> {
  try {
    const git = simpleGit(cwd);
    await git.checkout(['--', '.']);
    bridge.addSystemMessage('✓ 变更已拒绝，工作区已恢复到 HEAD 状态。');
    return { type: 'handled', messages: ['✓ 变更已拒绝（git checkout -- .）。'] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    bridge.addSystemMessage(`❌ 拒绝变更失败: ${msg}`);
    return { type: 'handled', messages: [`❌ 拒绝变更失败: ${msg}`] };
  }
}
