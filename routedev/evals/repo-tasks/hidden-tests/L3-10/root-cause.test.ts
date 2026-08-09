// hidden/root-cause.test.ts
// 根因：updateTask 必须递增 revision（只 patch UI 表面无法通过此测试）
import { describe, it, expect } from 'vitest';
import { TaskStore } from '../src/store.js';
import { TaskView } from '../src/ui.js';

describe('rename 后状态一致（hidden——根因在 store）', () => {
  it('updateTask 递增 revision（根因断言：只改 UI 不通过）', () => {
    const s = new TaskStore();
    s.addTask({ id: 't1', name: 'old' });
    s.updateTask('t1', { name: 'new' });
    expect(s.revision).toBe(2); // add(1) + update(1)
  });

  it('UI 重渲染显示新名（非 stale）', () => {
    const s = new TaskStore();
    s.addTask({ id: 't1', name: 'old' });
    const view = new TaskView(s);
    view.render();
    s.updateTask('t1', { name: 'new' });
    const r = view.render();
    expect(r.stale).toBe(false);
    expect(r.tasks[0]!.name).toBe('new');
  });
});
