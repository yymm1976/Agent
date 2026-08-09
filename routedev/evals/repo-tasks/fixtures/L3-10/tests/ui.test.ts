// tests/ui.test.ts
import { describe, it, expect } from 'vitest';
import { TaskStore } from '../src/store.js';
import { TaskView } from '../src/ui.js';

describe('TaskView 基础', () => {
  it('首次渲染非 stale', () => {
    const s = new TaskStore();
    s.addTask({ id: 't1', name: 'a' });
    const view = new TaskView(s);
    expect(view.render().stale).toBe(false);
  });
});
