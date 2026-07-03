import { describe, it, expect, beforeEach } from 'vitest';
import { MessageGrouper, type MessageGroup } from '../../../src/agent/memory/message-grouper.js';

interface SimpleMessage {
  role: string;
  content: string;
}

function msg(role: string, content: string = ''): SimpleMessage {
  return { role, content };
}

describe('MessageGrouper', () => {
  let grouper: MessageGrouper;

  beforeEach(() => {
    grouper = new MessageGrouper();
  });

  it('groupByRounds 按 user 消息分割', () => {
    const messages: SimpleMessage[] = [
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('user', 'q2'),
      msg('assistant', 'a2'),
    ];
    const groups = grouper.groupByRounds(messages);
    expect(groups.length).toBe(2);
    expect(groups[0].messages.map(m => m.content)).toEqual(['q1', 'a1']);
    expect(groups[1].messages.map(m => m.content)).toEqual(['q2', 'a2']);
  });

  it('完整 round 检测（user + assistant）', () => {
    const messages: SimpleMessage[] = [
      msg('user', 'q1'),
      msg('assistant', 'a1'),
    ];
    const groups = grouper.groupByRounds(messages);
    expect(groups.length).toBe(1);
    expect(groups[0].isCompleteRound).toBe(true);
  });

  it('不完整 round（仅 user）', () => {
    const messages: SimpleMessage[] = [
      msg('user', 'q1'),
    ];
    const groups = grouper.groupByRounds(messages);
    expect(groups.length).toBe(1);
    expect(groups[0].isCompleteRound).toBe(false);
  });

  it('markCompressible 标记旧 group', () => {
    const messages: SimpleMessage[] = [
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('user', 'q2'),
      msg('assistant', 'a2'),
      msg('user', 'q3'),
      msg('assistant', 'a3'),
    ];
    const groups = grouper.groupByRounds(messages);
    const compressible = grouper.markCompressible(groups, 1);
    expect(compressible).toEqual([true, true, false]);
  });

  it('单条消息 → 单个 group', () => {
    const messages: SimpleMessage[] = [
      msg('user', 'hello'),
    ];
    const groups = grouper.groupByRounds(messages);
    expect(groups.length).toBe(1);
    expect(groups[0].messages.length).toBe(1);
    expect(groups[0].startIndex).toBe(0);
    expect(groups[0].endIndex).toBe(1);
  });

  it('空消息 → 空 groups', () => {
    const messages: SimpleMessage[] = [];
    const groups = grouper.groupByRounds(messages);
    expect(groups.length).toBe(0);
  });
});
