// desktop/renderer/src/components/tool/line-diff.ts
// Phase 74-A3：行级 diff——把 file_edit 的 oldString/newString 转为带行号的 diff 视图数据
// 使用 diff-match-patch（Google，~50KB，纯计算库，UI 完全自定义）

import dmp from 'diff-match-patch';

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  oldLn: number | null; // 旧文件行号（删除/上下文有，新增为 null）
  newLn: number | null; // 新文件行号（新增/上下文有，删除为 null）
  text: string;
}

/**
 * 计算行级 diff
 * - diff-match-patch 默认是字符级，这里用字符级 diff 结果重组为行级
 * - 输出带旧/新行号的 DiffLine[]，UI 直接渲染
 */
export function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  if (!oldStr && !newStr) return [];

  // 全新增
  if (!oldStr) {
    return newStr.split('\n').map((text, i) => ({
      type: 'add' as const,
      oldLn: null,
      newLn: i + 1,
      text,
    }));
  }
  // 全删除
  if (!newStr) {
    return oldStr.split('\n').map((text, i) => ({
      type: 'del' as const,
      oldLn: i + 1,
      newLn: null,
      text,
    }));
  }

  // 字符级 diff
  const d = new dmp();
  const diffs: Array<[number, string]> = d.diff_main(oldStr, newStr);
  d.diff_cleanupSemantic(diffs);

  // 重组为行级
  const result: DiffLine[] = [];
  let oldLn = 1;
  let newLn = 1;

  // 把字符级 diff 按行边界切分
  // 策略：遍历 diffs，把 text 按 \n 拆分，每行根据 op 类型生成 DiffLine
  for (const [op, text] of diffs) {
    if (!text) continue;
    const lines = text.split('\n');
    // 处理每行：注意最后一个元素如果后面没有 \n，是下一行开头，需与后续 diff 连接
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      // 末尾空行（来自结尾 \n）跳过
      if (isLast && line === '') break;

      if (op === 0) {
        // 上下文行
        result.push({ type: 'ctx', oldLn: oldLn++, newLn: newLn++, text: line });
      } else if (op === 1) {
        // 新增行
        result.push({ type: 'add', oldLn: null, newLn: newLn++, text: line });
      } else if (op === -1) {
        // 删除行
        result.push({ type: 'del', oldLn: oldLn++, newLn: null, text: line });
      }
    }
  }

  return result;
}

/**
 * 统计 diff 摘要：+X -Y
 */
export function summarizeDiff(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'del') removed++;
  }
  return { added, removed };
}
