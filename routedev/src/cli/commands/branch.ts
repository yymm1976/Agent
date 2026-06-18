// src/cli/commands/branch.ts
// 对话分支管理命令：/branch list | switch <id> | edit <N> <内容>
// Phase 25：list 使用 BranchSwitcher 的文本渲染，提供可视化分支树

import type { CommandDefinition } from '../command-registry.js';
import { renderBranchTreeText } from '../components/BranchSwitcher.js';

export const branchCommand: CommandDefinition = {
  name: 'branch',
  description: '对话分支管理',
  usage: '/branch list | /branch switch <id> | /branch edit <序号> <新内容>',
  handler: async (args, ctx) => {
    const { branchManager, commandBridge } = ctx;
    const parts = args.split(/\s+/);
    const sub = parts[0] || 'list';

    switch (sub) {
      case 'list': {
        const branches = branchManager.listBranches();
        if (branches.length === 0) {
          return { type: 'handled', messages: ['没有分支。在消息前输入 /branch edit 可以创建分支。'] };
        }
        const text = renderBranchTreeText(branches, branchManager.getActiveBranchId());
        return { type: 'handled', messages: [text] };
      }
      case 'switch': {
        const id = parts[1];
        if (!id) return { type: 'handled', messages: ['用法: /branch switch <id>\n使用 /branch list 查看所有分支。'] };
        const newPath = branchManager.switchBranch(id);
        if (!newPath) {
          return { type: 'handled', messages: [`未找到分支 "${id}"`] };
        }
        return {
          type: 'handled',
          messages: [`✓ 已切换到分支 [${branchManager.getActiveBranchId()}] (${newPath.length} 条消息)`],
        };
      }
      case 'edit': {
        const editArg = parts.slice(2).join(' ');
        const spaceIdx = editArg.indexOf(' ');
        if (spaceIdx < 0) {
          return { type: 'handled', messages: ['用法: /branch edit <消息索引> <新内容>\n例: /branch edit 3 修正一下: 这个函数应该返回字符串'] };
        }
        const indexStr = editArg.slice(0, spaceIdx);
        const newContent = editArg.slice(spaceIdx + 1);
        const idx = parseInt(indexStr, 10);
        if (isNaN(idx) || idx < 1) {
          return { type: 'handled', messages: [`无效的索引: ${indexStr}（应为正整数）`] };
        }
        const newBranchId = branchManager.editByHistoryIndex(idx - 1, newContent);
        if (!newBranchId) {
          return { type: 'handled', messages: [`编辑失败: 索引 ${idx} 超出范围`] };
        }
        commandBridge.addSystemMessage(`🌿 已创建新分支 [${newBranchId}]，第 ${idx} 条消息已替换为新内容。`);
        return { type: 'handled' };
      }
      default:
        return { type: 'handled', messages: ['用法: /branch list | switch <id> | edit <N> <内容>'] };
    }
  },
};
