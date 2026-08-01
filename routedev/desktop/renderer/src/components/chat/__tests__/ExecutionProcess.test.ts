import { describe, expect, it } from 'vitest';
import type { ToolCallItem } from '../../ToolCallCard.js';
import { buildTimeline } from '../ExecutionProcess.js';

describe('buildTimeline', () => {
  it('keeps real model output between two calls to the same tool', () => {
    const toolGroups: Record<string, ToolCallItem[]> = {
      shell_exec: [
        { id: 'tool-1', toolName: 'shell_exec', status: 'completed', timestamp: 10 },
        { id: 'tool-2', toolName: 'shell_exec', status: 'completed', timestamp: 30 },
      ],
    };

    const timeline = buildTimeline(
      [{ id: 'thought-1', text: '正在检查结果', timestamp: 20 }],
      toolGroups,
    );

    expect(timeline.map((entry) => entry.kind)).toEqual(['tool-group', 'thought', 'tool-group']);
  });

  it('merges only adjacent calls to the same tool', () => {
    const timeline = buildTimeline([], {
      code_search: [
        { id: 'tool-1', toolName: 'code_search', status: 'completed', timestamp: 10 },
        { id: 'tool-2', toolName: 'code_search', status: 'completed', timestamp: 20 },
      ],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: 'tool-group', toolName: 'code_search' });
    expect(timeline[0].kind === 'tool-group' && timeline[0].items).toHaveLength(2);
  });
});
