// src/session/session-commands.ts
// Phase 84 Task 2：/tree /fork /clone 斜杠命令处理
//
// 纯函数式命令处理器：接收 SessionTree，返回 CommandResult。
// 不直接操作 UI 或 IPC，由调用方（chat-bridge）负责将 CommandResult 呈现给用户。
//
// 设计约束：
//   - 纯函数式：不直接操作 UI 或 IPC
//   - 不修改 SessionTree 类（只读取/调用其方法）
//   - 所有 import 路径带 .js 后缀

import type { SessionTree, BranchInfo } from './session-tree.js';

/** 命令处理结果 */
export interface CommandResult {
  /** 输出文本 */
  text: string;
  /** 动作类型 */
  action?: 'fork' | 'clone' | 'switch' | 'tree';
  /** 附加数据（如新分支 ID、克隆的新树） */
  data?: unknown;
}

/**
 * 截断内容用于显示
 * @param content 节点内容
 * @param maxLen 最大长度
 * @returns 截断后的单行字符串
 */
function formatContent(content: unknown, maxLen = 40): string {
  if (content === null || content === undefined) return '';
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  const oneLine = str.replace(/\n/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
}

/**
 * 获取分支显示名（label 或截断 ID）
 * @param branch 分支信息
 * @returns 显示名
 */
function branchLabel(branch: BranchInfo): string {
  return branch.label ?? branch.id.slice(0, 8);
}

/**
 * 查找包含指定节点的分支
 *
 * 遍历所有分支，返回第一个路径中包含该节点的分支。
 *
 * @param tree 会话树
 * @param nodeId 目标节点 ID
 * @returns 分支信息（未找到时返回 undefined）
 */
function findBranchContainingNode(tree: SessionTree, nodeId: string): BranchInfo | undefined {
  for (const branch of tree.branches.values()) {
    const path = tree.getPath(tree.rootId, branch.leafId);
    if (path.some(n => n.id === nodeId)) {
      return branch;
    }
  }
  return undefined;
}

/**
 * 渲染 ASCII 树形图
 *
 * 从根节点递归渲染，使用 ├── └── │ 绘制树结构。
 * 当前活跃节点用 → 标记，分支叶节点用 [分支名] 标记。
 *
 * @param tree 会话树
 * @returns ASCII 树形图文本
 */
function renderTree(tree: SessionTree): string {
  const activeId = tree.activeBranchId;

  // 收集每个叶节点对应的分支列表
  const leafToBranches = new Map<string, BranchInfo[]>();
  for (const branch of tree.branches.values()) {
    const arr = leafToBranches.get(branch.leafId) ?? [];
    arr.push(branch);
    leafToBranches.set(branch.leafId, arr);
  }

  const lines: string[] = [];

  /**
   * 递归渲染节点
   * @param nodeId 节点 ID
   * @param prefix 当前行的前缀（树绘制字符）
   * @param isLast 是否是父节点的最后一个子节点
   * @param isRoot 是否是根节点
   */
  function renderNode(nodeId: string, prefix: string, isLast: boolean, isRoot: boolean): void {
    const node = tree.getNode(nodeId);
    if (!node) return;

    const connector = isRoot ? '' : (isLast ? '└── ' : '├── ');
    const isActive = nodeId === activeId;
    const marker = isActive ? '→ ' : '';

    // 节点标签
    let label: string;
    if (isRoot) {
      label = `${marker}root`;
    } else {
      label = `${marker}${node.role}: ${formatContent(node.content)}`;
    }

    // 分支标记（此节点是某些分支的叶节点）
    const branchesHere = leafToBranches.get(nodeId);
    const branchTag = branchesHere && branchesHere.length > 0
      ? `  [${branchesHere.map(b => branchLabel(b)).join(', ')}]`
      : '';

    lines.push(`${prefix}${connector}${label}${branchTag}`);

    // 递归渲染子节点
    const children = tree.getChildren(nodeId);
    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
    children.forEach((child, i) => {
      renderNode(child.id, childPrefix, i === children.length - 1, false);
    });
  }

  renderNode(tree.rootId, '', true, true);
  return lines.join('\n');
}

/**
 * /tree 命令——输出当前会话的分支结构
 *
 * 用法：
 *   /tree              — 输出 ASCII 树形图，标注当前节点
 *   /tree --jump <id>  — 跳转到指定节点（切换到包含该节点的分支）
 *
 * @param tree 会话树
 * @param args 命令参数
 * @returns 命令结果
 */
export function handleTreeCommand(tree: SessionTree, args?: string): CommandResult {
  // --jump <nodeId>：跳转到指定节点
  if (args?.includes('--jump')) {
    const match = args.match(/--jump\s+(\S+)/);
    if (!match) {
      return {
        text: '❌ 用法: /tree --jump <nodeId>',
        action: 'tree',
      };
    }

    const targetId = match[1];
    const node = tree.getNode(targetId);
    if (!node) {
      return {
        text: `❌ 节点不存在: ${targetId}`,
        action: 'tree',
      };
    }

    const branch = findBranchContainingNode(tree, targetId);
    if (!branch) {
      return {
        text: `❌ 找不到包含节点 ${targetId} 的分支`,
        action: 'tree',
      };
    }

    // 通过 jumpToNode 切换分支 + 设置活跃节点（封装保证分支信息一致性）
    if (!tree.jumpToNode(targetId)) {
      return {
        text: `❌ 跳转失败: ${targetId}`,
        action: 'tree',
      };
    }

    return {
      text: `✅ 已跳转到节点 ${targetId}（分支: ${branchLabel(branch)}）`,
      action: 'switch',
      data: { nodeId: targetId, branchId: branch.id },
    };
  }

  // 空树——返回友好提示
  if (tree.nodes.size <= 1) {
    return {
      text: '🌳 会话树为空，发送消息开始对话。',
      action: 'tree',
    };
  }

  // 渲染树形图
  const header = `🌳 Session Tree（${tree.branches.size} 分支，${tree.nodes.size} 节点）`;
  const separator = '─'.repeat(40);
  const body = renderTree(tree);

  return {
    text: `${header}\n${separator}\n${body}`,
    action: 'tree',
  };
}

/**
 * /fork 命令——从当前消息或指定节点创建新分支
 *
 * 用法：
 *   /fork          — 从当前活跃分支的最后一条用户消息 fork
 *   /fork <nodeId> — 从指定节点 fork
 *
 * fork 后自动切换到新分支。
 *
 * @param tree 会话树
 * @param args 命令参数（可选 nodeId）
 * @returns 命令结果
 */
export function handleForkCommand(tree: SessionTree, args?: string): CommandResult {
  const nodeId = args?.trim();

  let forkNodeId: string;

  if (nodeId) {
    // 指定节点 fork
    const node = tree.getNode(nodeId);
    if (!node) {
      return {
        text: `❌ 节点不存在: ${nodeId}`,
        action: 'fork',
      };
    }
    forkNodeId = nodeId;
  } else {
    // 从最后一条用户消息 fork
    const path = tree.getActiveBranch();
    const lastUser = [...path].reverse().find(n => n.role === 'user' && n.parentId !== null);
    if (!lastUser) {
      return {
        text: '❌ 当前分支没有用户消息，请指定节点 ID 进行 fork',
        action: 'fork',
      };
    }
    forkNodeId = lastUser.id;
  }

  // 创建新分支（fork 内部会自动切换到新分支）
  const newBranchId = tree.fork(forkNodeId);

  return {
    text: `✅ 已从节点 ${forkNodeId} 创建新分支\n分支 ID: ${newBranchId}`,
    action: 'fork',
    data: { branchId: newBranchId, forkNodeId },
  };
}

/**
 * /clone 命令——复制当前完整活跃分支到新会话
 *
 * 深拷贝当前活跃分支路径到新 SessionTree 实例，
 * 新树所有节点 ID 重新生成，内容保持一致。
 *
 * @param tree 会话树
 * @returns 命令结果（data.newTree 为克隆的新树）
 */
export function handleCloneCommand(tree: SessionTree): CommandResult {
  const path = tree.getActiveBranch();
  const msgCount = path.filter(n => n.parentId !== null).length;

  const cloned = tree.clone();

  return {
    text: `✅ 已克隆当前分支到新会话\n源分支消息数: ${msgCount}\n新会话节点数: ${cloned.nodes.size}`,
    action: 'clone',
    data: { newTree: cloned, messageCount: msgCount },
  };
}
