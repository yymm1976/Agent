import { describe, expect, it } from 'vitest';
import { TodoStore } from '../../src/tools/builtin/todo-store.js';
import { TodoWriteTool } from '../../src/tools/builtin/todo-write.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

describe('TodoWriteTool replace', () => {
  it('replaces rather than accumulates the active todo list', async () => {
    const store = new TodoStore();
    const tool = new TodoWriteTool(store);
    const context = {} as ToolExecutionContext;

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
});
