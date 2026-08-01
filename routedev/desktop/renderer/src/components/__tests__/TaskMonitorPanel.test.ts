import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../store/useRouteDevStore.js';
import { rebuildTodosFromToolCalls } from '../TaskMonitorPanel.js';

function todoCall(
  action: string,
  toolArgs: Record<string, unknown>,
  toolResult: unknown,
  toolStatus: ChatMessage['toolStatus'] = 'completed',
): ChatMessage {
  return {
    id: `${action}-${Math.random()}`,
    role: 'system',
    content: '',
    toolName: 'todo_write',
    toolArgs: { action, ...toolArgs },
    toolResult,
    toolStatus,
    timestamp: Date.now(),
  };
}

describe('rebuildTodosFromToolCalls', () => {
  it('replaces the previous snapshot when a new todo list is generated', () => {
    const messages = [
      todoCall('replace', {
        todos: [
          { id: 'old-1', content: '旧任务一', status: 'completed' },
          { id: 'old-2', content: '旧任务二', status: 'pending' },
        ],
      }, {}),
      todoCall('replace', {
        todos: [
          { id: 'new-1', content: '新任务', status: 'in_progress' },
        ],
      }, {}),
    ];

    expect(rebuildTodosFromToolCalls(messages)).toEqual([
      expect.objectContaining({ id: 'new-1', text: '新任务', status: 'in_progress' }),
    ]);
  });

  it('does not create todos from failed tool-call arguments', () => {
    const messages = [
      todoCall('add', { content: '不应出现' }, { error: 'failed' }, 'error'),
    ];

    expect(rebuildTodosFromToolCalls(messages)).toEqual([]);
  });
});
