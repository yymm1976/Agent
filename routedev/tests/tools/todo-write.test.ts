import { describe, expect, it } from 'vitest';
import { TodoStore } from '../../src/tools/builtin/todo-store.js';
import { TodoWriteTool } from '../../src/tools/builtin/todo-write.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

const context = {} as ToolExecutionContext;

describe('TodoWriteTool numeric references', () => {
  it('replaces rather than accumulates the active todo list', async () => {
    const store = new TodoStore();
    const tool = new TodoWriteTool(store);

    await tool.execute({ action: 'add', content: '旧计划' }, context);
    const result = await tool.execute({
      action: 'replace',
      todos: [
        { content: '实现界面', status: 'in_progress' },
        { content: '验证改动', priority: 'high' },
      ],
    }, context);

    expect(result.success).toBe(true);
    expect(store.list().map((item) => item.content)).toEqual(['实现界面', '验证改动']);
    expect(store.list()[0]?.status).toBe('in_progress');
  });

  it('resolves numeric references by stable creation order', async () => {
    const store = new TodoStore();
    const tool = new TodoWriteTool(store);
    const first = store.add('第一项');
    const second = store.add('第二项');
    store.add('第三项');

    const firstResult = await tool.execute(
      { action: 'update', id: '1', status: 'completed' },
      context,
    );
    const secondResult = await tool.execute(
      { action: 'update', id: '2', status: 'in_progress' },
      context,
    );

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(store.get(first.id)?.status).toBe('completed');
    expect(store.get(second.id)?.status).toBe('in_progress');
  });

  it('returns the resolved ID when deleting by numeric reference', async () => {
    const store = new TodoStore();
    const tool = new TodoWriteTool(store);
    store.add('保留');
    const removed = store.add('删除');

    const result = await tool.execute({ action: 'delete', id: '2' }, context);

    expect(result.success).toBe(true);
    expect(result.metadata?.deletedId).toBe(removed.id);
    expect(store.get(removed.id)).toBeNull();
  });
});
