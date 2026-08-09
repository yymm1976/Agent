// tests/store.test.ts
import { describe, it, expect } from 'vitest';
import { TaskStore } from '../src/store.js';

describe('TaskStore 基础', () => {
  it('addTask / getTask', () => {
    const s = new TaskStore();
    s.addTask({ id: 't1', name: 'a' });
    expect(s.getTask('t1')?.name).toBe('a');
  });

  it('addTask 递增 revision', () => {
    const s = new TaskStore();
    s.addTask({ id: 't1', name: 'a' });
    expect(s.revision).toBe(1);
  });
});
