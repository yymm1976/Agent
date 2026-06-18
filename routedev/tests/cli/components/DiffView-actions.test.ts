// tests/cli/components/DiffView-actions.test.ts
// DiffView 动作绑定测试（Phase 27 Task 5）
// 测试 [A]/[R]/[S] 动作相关的纯函数：buildPatchFromHunks、buildPatchFromDecisions

import { describe, it, expect } from 'vitest';
import {
  parseUnifiedDiff,
  buildPatchFromHunks,
  buildPatchFromDecisions,
  type DiffHunk,
  type HunkDecision,
} from '../../../src/cli/components/DiffView.js';

// 多 hunk 测试样本：两个独立 hunk
const MULTI_HUNK_DIFF = `--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,4 @@
 import { foo } from 'bar';
+import { baz } from 'qux';
 const x = 1;
 const y = 2;
@@ -10,3 +11,4 @@
 function main() {
   return x + y;
 }
+export { main };
`;

// 单 hunk 测试样本
const SINGLE_HUNK_DIFF = `--- a/src/handler.ts
+++ b/src/handler.ts
@@ -5,3 +5,4 @@
 function handler() {
   return null;
 }
+// 新增注释
`;

describe('DiffView 动作绑定: buildPatchFromHunks', () => {
  it('空 hunk 列表返回空字符串', () => {
    const patch = buildPatchFromHunks('src/test.ts', []);
    expect(patch).toBe('');
  });

  it('单个 hunk 重建为合法 patch', () => {
    const parsed = parseUnifiedDiff(SINGLE_HUNK_DIFF);
    const patch = buildPatchFromHunks(parsed.fileName, parsed.hunks);
    // 包含文件头
    expect(patch).toContain('--- a/src/handler.ts');
    expect(patch).toContain('+++ b/src/handler.ts');
    // 包含 hunk 头
    expect(patch).toContain('@@ -5,3 +5,4 @@');
    // 包含新增行
    expect(patch).toContain('+// 新增注释');
  });

  it('多个 hunk 合并为单个 patch 文本', () => {
    const parsed = parseUnifiedDiff(MULTI_HUNK_DIFF);
    const patch = buildPatchFromHunks(parsed.fileName, parsed.hunks);
    // 两个 hunk 头都应存在
    expect(patch).toContain('@@ -1,3 +1,4 @@');
    expect(patch).toContain('@@ -10,3 +11,4 @@');
    // 两个新增行都应存在
    expect(patch).toContain("+import { baz } from 'qux';");
    expect(patch).toContain('+export { main };');
  });
});

describe('DiffView 动作绑定: buildPatchFromDecisions', () => {
  it('全部 accept 返回完整 patch', () => {
    const parsed = parseUnifiedDiff(MULTI_HUNK_DIFF);
    const decisions: HunkDecision[] = ['accept', 'accept'];
    const patch = buildPatchFromDecisions(parsed, decisions);
    expect(patch).toContain('@@ -1,3 +1,4 @@');
    expect(patch).toContain('@@ -10,3 +11,4 @@');
  });

  it('全部 reject 返回空 patch', () => {
    const parsed = parseUnifiedDiff(MULTI_HUNK_DIFF);
    const decisions: HunkDecision[] = ['reject', 'reject'];
    const patch = buildPatchFromDecisions(parsed, decisions);
    expect(patch).toBe('');
  });

  it('部分 accept 仅包含接受的 hunk', () => {
    const parsed = parseUnifiedDiff(MULTI_HUNK_DIFF);
    // 第一个 accept，第二个 reject
    const decisions: HunkDecision[] = ['accept', 'reject'];
    const patch = buildPatchFromDecisions(parsed, decisions);
    expect(patch).toContain('@@ -1,3 +1,4 @@');
    expect(patch).toContain("+import { baz } from 'qux';");
    // 第二个 hunk 不应出现
    expect(patch).not.toContain('@@ -10,3 +11,4 @@');
    expect(patch).not.toContain('+export { main };');
  });

  it('skip 等同于 reject，不包含在 patch 中', () => {
    const parsed = parseUnifiedDiff(MULTI_HUNK_DIFF);
    const decisions: HunkDecision[] = ['skip', 'accept'];
    const patch = buildPatchFromDecisions(parsed, decisions);
    // 第一个 hunk 被跳过
    expect(patch).not.toContain('@@ -1,3 +1,4 @@');
    // 第二个 hunk 被接受
    expect(patch).toContain('@@ -10,3 +11,4 @@');
  });

  it('重建的 patch 可被 parseUnifiedDiff 重新解析', () => {
    const parsed = parseUnifiedDiff(MULTI_HUNK_DIFF);
    const decisions: HunkDecision[] = ['accept', 'accept'];
    const patch = buildPatchFromDecisions(parsed, decisions);
    // 重建的 patch 应可被重新解析
    const reparsed = parseUnifiedDiff(patch);
    expect(reparsed.fileName).toBe('src/utils.ts');
    expect(reparsed.hunks).toHaveLength(2);
  });
});
