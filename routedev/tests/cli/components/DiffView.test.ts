// tests/cli/components/DiffView.test.ts
// DiffView 差异视图解析与渲染测试（Phase 25 Task 6）

import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, renderDiffText, countDiffLines } from '../../../src/cli/components/DiffView.js';

const SAMPLE_DIFF = `--- a/src/auth/handler.ts
+++ b/src/auth/handler.ts
@@ -15,7 +15,10 @@
   const token = req.headers.authorization;
-  if (!token) {
-    return res.status(401).send();
-  }
+  if (!token) {
+    logger.warn('Missing auth token');
+    return res.status(401).json({
+      error: 'UNAUTHORIZED'
+    });
+  }
`;

describe('DiffView: parseUnifiedDiff', () => {
  it('解析文件名', () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    expect(parsed.fileName).toBe('src/auth/handler.ts');
  });

  it('统计新增和删除行数', () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    expect(parsed.additions).toBe(6);
    expect(parsed.deletions).toBe(3);
  });

  it('解析 hunk 头', () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0].oldStart).toBe(15);
    expect(parsed.hunks[0].oldCount).toBe(7);
    expect(parsed.hunks[0].newStart).toBe(15);
    expect(parsed.hunks[0].newCount).toBe(10);
  });

  it('空 diff 返回空 hunks', () => {
    const parsed = parseUnifiedDiff('');
    expect(parsed.hunks).toHaveLength(0);
    expect(parsed.additions).toBe(0);
    expect(parsed.deletions).toBe(0);
  });

  it('识别上下文、删除、新增行', () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    const lines = parsed.hunks[0].lines;
    expect(lines.some(l => l.type === 'context' && l.content.includes('const token'))).toBe(true);
    expect(lines.some(l => l.type === 'del' && l.content.includes('return res.status(401).send()'))).toBe(true);
    expect(lines.some(l => l.type === 'add' && l.content.includes("logger.warn('Missing auth token')"))).toBe(true);
  });
});

describe('DiffView: countDiffLines', () => {
  it('统计所有 hunk 行数', () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    expect(countDiffLines(parsed.hunks)).toBe(parsed.hunks[0].lines.length);
  });
});

describe('DiffView: renderDiffText', () => {
  it('空 hunks 返回提示', () => {
    const text = renderDiffText({ fileName: '', additions: 0, deletions: 0, hunks: [] });
    expect(text).toContain('未检测到 diff 内容');
  });

  it('渲染包含文件名、统计和操作的文本', () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    const text = renderDiffText(parsed);
    expect(text).toContain('变更: src/auth/handler.ts');
    expect(text).toContain('+6 -3');
    expect(text).toContain('[A] 全部接受');
    expect(text).toContain('[R] 全部拒绝');
    expect(text).toContain('[S] 逐行审查');
  });

  it('分页显示页码', () => {
    const parsed = parseUnifiedDiff(SAMPLE_DIFF);
    const text = renderDiffText(parsed, 0, 3);
    expect(text).toContain('页 1/');
  });
});
