// tests/agent/composer-reference.test.ts
// Phase 97 Part G：ComposerReference 统一解析器——/ @ & ~ 前缀 + accessScope 校验

import { describe, it, expect } from 'vitest';
import { parseComposerReferences } from '../../src/agent/context/composer-reference.js';
import path from 'node:path';

const cwd = path.resolve('C:/fake-project');

describe('parseComposerReferences（统一引用解析）', () => {
  it('解析 @ 文件引用（复用 mention-parser）', () => {
    const refs = parseComposerReferences('请修改 @src/index.ts', {
      cwd,
      workspaceRoot: 'C:/fake-project',
    });
    expect(refs.length).toBe(1);
    expect(refs[0]!.type).toBe('file');
    expect(refs[0]!.accessScope).toBe('workspace');
    expect(refs[0]!.resolvedPath!.replace(/\\/g, '/')).toContain('src/index.ts');
  });

  it('解析 / skill 引用', () => {
    const refs = parseComposerReferences('用 /doc-writer 写文档', { cwd });
    const skill = refs.find((r) => r.type === 'skill');
    expect(skill).toBeDefined();
    expect(skill!.id).toBe('doc-writer');
    expect(skill!.accessScope).toBe('system');
  });

  it('解析 / mcp__ 前缀为 mcp 引用', () => {
    const refs = parseComposerReferences('调用 /mcp__github__search 查询', { cwd });
    const mcp = refs.find((r) => r.type === 'mcp');
    expect(mcp).toBeDefined();
    expect(mcp!.id).toBe('mcp__github__search');
  });

  it('解析 & 会话引用并注入摘要', () => {
    const refs = parseComposerReferences('参考 &sess-1 的结论', {
      cwd,
      sessions: { 'sess-1': '第一行摘要\n第二行' },
    });
    const session = refs.find((r) => r.type === 'session');
    expect(session).toBeDefined();
    expect(session!.id).toBe('sess-1');
    expect(session!.displayName).toBe('第一行摘要');
  });

  it('解析 ~ 任务与 ~cal 日历引用', () => {
    const refs = parseComposerReferences('完成 ~todo-42，并查看 ~cal:meeting', {
      cwd,
      tasks: ['todo-42'],
    });
    expect(refs.some((r) => r.type === 'task' && r.id === 'todo-42')).toBe(true);
    expect(refs.some((r) => r.type === 'calendar' && r.id === 'meeting')).toBe(true);
  });

  it('未知符号回退纯文本（不产出引用）', () => {
    const refs = parseComposerReferences('普通文本没有特殊符号', { cwd });
    expect(refs.length).toBe(0);
  });

  it('accessScope：附加目录内为 attached，外部为 system', () => {
    const refs = parseComposerReferences('看 @C:/shared-lib/api.ts', {
      cwd,
      workspaceRoot: 'C:/fake-project',
      attachedRoots: ['C:/shared-lib'],
    });
    const file = refs.find((r) => r.type === 'file' && r.id.includes('shared-lib'));
    expect(file).toBeDefined();
    expect(file!.accessScope).toBe('attached');
  });

  it('去重：同一引用多次出现只解析一次', () => {
    const refs = parseComposerReferences('修改 @src/a.ts 和 @src/a.ts', { cwd, workspaceRoot: 'C:/fake-project' });
    const files = refs.filter((r) => r.type === 'file');
    expect(files.length).toBe(1);
  });
});
