// src/tools/git-ops.ts
// B-03：git_op 读/写操作边界
//
// 问题：git_op 一个工具名同时承载 status/log（读）与 commit/push/prune（写），
// allowlist 里的 `tool:git_op` 会因工具名共同预授权写操作。
// 修复：按 operation 区分——`tool:git_op` 只预授权读操作；
// 写操作需要显式的 `tool:git_op:write` 条目，否则走正常确认流。

/** 只读 Git 操作（预授权安全） */
export const GIT_READ_OPERATIONS = new Set([
  'status', 'log', 'diff', 'blame', 'show', 'branch', 'ls-files', 'remote',
]);

/** 写 Git 操作（不得因工具名共同预授权） */
export const GIT_WRITE_OPERATIONS = new Set([
  'add', 'commit', 'push', 'pull', 'prune', 'merge', 'rebase', 'reset',
  'checkout', 'restore', 'clean', 'revert', 'rm', 'mv', 'tag', 'stash', 'gc',
]);

/** 未列出的操作保守按写处理（fail-closed） */
export function isGitWriteOperation(operation: unknown): boolean {
  if (typeof operation !== 'string' || operation.length === 0) return true;
  if (GIT_READ_OPERATIONS.has(operation)) return false;
  return true;
}
