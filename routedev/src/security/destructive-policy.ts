// src/security/destructive-policy.ts
// A2（RC Hardening）：rm 结构化破坏性策略——argv 语义解析
//
// 不再堆 regex：解析 flags（combined short -rf/-fr/-rfi/-rvf、separated
// -r -f、long --recursive/--force、-- 终止符）与 target operands，
// 对 target 做路径归一（//、/./、/x/../、$HOME 折叠后指向根/主目录即危险）。
//
// 与 security-enhanced.ts 的 Layer 4c 共用同一 target 归一（唯一权威）。

/**
 * 单参数归一化判定：折叠后为 /、/* 或 ~（家目录）即危险。
 * A2 修复：段折叠替代正则迭代——旧实现 `/etc/..` 被整个替换为空串
 * （应为 `/`），且 `/tmp/../..` 的边界匹配不稳定。按 / 分段后
 * `.` 删除、`..` 上溯、`//` 合并，语义与真实路径解析一致。
 */
export function isDestructiveRmTarget(raw: string): boolean {
  let normalized = raw.replace(/\$\{HOME\}/g, '~').replace(/\$HOME/g, '~');
  if (normalized === '~' || normalized.startsWith('~/')) return true;
  if (!normalized.startsWith('/')) return false;
  const parts = normalized.split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      stack.pop();
      continue;
    }
    stack.push(p);
  }
  const folded = '/' + stack.join('/');
  return folded === '/' || folded.startsWith('/*');
}

/** rm flags 解析结果 */
export interface RmFlagAnalysis {
  recursive: boolean;
  force: boolean;
  /** 是否出现 -- 终止符（其后全部为 target） */
  sawDoubleDash: boolean;
  /** target operands（跳过 flags/命令名） */
  targets: string[];
}

/**
 * argv 语义解析：combined short options（-rf/-fr/-rfi/-rvf）、
 * separated（-r -f）、long（--recursive/--force）、-- 终止符。
 */
export function parseRmFlags(args: readonly string[]): RmFlagAnalysis {
  let recursive = false;
  let force = false;
  let sawDoubleDash = false;
  const targets: string[] = [];
  for (const a of args) {
    if (sawDoubleDash) {
      targets.push(a);
      continue;
    }
    if (a === '--') {
      sawDoubleDash = true;
      continue;
    }
    if (a.startsWith('--')) {
      if (a === '--recursive') recursive = true;
      else if (a === '--force' || a === '--no-preserve-root') force = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (ch === 'r' || ch === 'R') recursive = true;
        if (ch === 'f') force = true;
      }
      continue;
    }
    targets.push(a);
  }
  return { recursive, force, sawDoubleDash, targets };
}

/**
 * rm 破坏性判定：recursive/force 生效时，任一 target 归一化后指向根/主目录即拒绝。
 * @returns 危险原因；undefined = 安全
 */
export function checkRmPolicy(
  canonicalName: string,
  args: readonly string[],
): string | undefined {
  if (canonicalName !== 'rm') return undefined;
  const { recursive, force, targets } = parseRmFlags(args);
  if (!recursive && !force) return undefined;
  for (const t of targets) {
    if (isDestructiveRmTarget(t)) {
      return 'rm 删除目标归一化后指向根/主目录（递归/强制标志生效）';
    }
  }
  return undefined;
}
