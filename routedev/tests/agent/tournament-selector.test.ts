import { describe, it, expect, vi } from 'vitest';
import { TournamentSelector } from '../../src/agent/tournament-selector.js';
import type { TournamentCandidate } from '../../src/agent/tournament-selector.js';

function makeClient(winnerId: string) {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify({ winnerId, reason: 'better answer', confidence: 0.9 }),
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    }),
  };
}

function makeCandidates(ids: string[]): TournamentCandidate<string>[] {
  return ids.map((id) => ({ id, content: `answer from ${id}` }));
}

describe('TournamentSelector', () => {
  describe('单候选者直接返回', () => {
    it('只有一个候选者时不调用 LLM', async () => {
      const client = makeClient('c1');
      const selector = new TournamentSelector(client as never);
      const candidates = makeCandidates(['c1']);
      const result = await selector.select(candidates);
      expect(result.winner.id).toBe('c1');
      expect(result.totalComparisons).toBe(0);
      expect(client.complete).not.toHaveBeenCalled();
    });
  });

  describe('单轮淘汰赛 (singleElimination=true)', () => {
    it('两个候选者一轮决出胜者', async () => {
      const client = makeClient('c2');
      const selector = new TournamentSelector(client as never, {
        candidateCount: 2,
        singleElimination: true,
      });
      const result = await selector.select(makeCandidates(['c1', 'c2']));
      expect(result.winner.id).toBe('c2');
      expect(result.totalComparisons).toBe(1);
      expect(result.rounds).toHaveLength(1);
    });

    it('四个候选者两轮决出胜者（半决赛 + 决赛）', async () => {
      const client = {
        complete: vi.fn()
          .mockResolvedValueOnce({ content: JSON.stringify({ winnerId: 'c1', reason: 'r', confidence: 0.8 }), usage: {} })
          .mockResolvedValueOnce({ content: JSON.stringify({ winnerId: 'c3', reason: 'r', confidence: 0.8 }), usage: {} })
          .mockResolvedValueOnce({ content: JSON.stringify({ winnerId: 'c3', reason: 'r', confidence: 0.9 }), usage: {} }),
      };
      const selector = new TournamentSelector(client as never, {
        candidateCount: 4,
        singleElimination: true,
      });
      const result = await selector.select(makeCandidates(['c1', 'c2', 'c3', 'c4']));
      expect(result.winner.id).toBe('c3');
      expect(result.rounds).toHaveLength(2);
      expect(result.totalComparisons).toBe(3);
    });

    it('奇数候选者时轮空者晋级', async () => {
      const client = makeClient('c1');
      const selector = new TournamentSelector(client as never, {
        candidateCount: 3,
        singleElimination: true,
      });
      const result = await selector.select(makeCandidates(['c1', 'c2', 'c3']));
      expect(['c1', 'c2', 'c3']).toContain(result.winner.id);
    });
  });

  describe('顺序淘汰 (singleElimination=false)', () => {
    it('顺序比较当前最强', async () => {
      const client = {
        complete: vi.fn()
          .mockResolvedValueOnce({ content: JSON.stringify({ winnerId: 'c2', reason: 'r', confidence: 0.7 }), usage: {} })
          .mockResolvedValueOnce({ content: JSON.stringify({ winnerId: 'c2', reason: 'r', confidence: 0.8 }), usage: {} }),
      };
      const selector = new TournamentSelector(client as never, {
        candidateCount: 3,
        singleElimination: false,
      });
      const result = await selector.select(makeCandidates(['c1', 'c2', 'c3']));
      expect(result.winner.id).toBe('c2');
      expect(result.rounds).toHaveLength(1);
      expect(result.totalComparisons).toBe(2);
    });
  });

  describe('LLM 调用失败 fail-open', () => {
    it('judge 失败时默认选择第一个候选（不抛出异常）', async () => {
      const failClient = {
        complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
      };
      const selector = new TournamentSelector(failClient as never, {
        candidateCount: 2,
        singleElimination: true,
      });
      const result = await selector.select(makeCandidates(['c1', 'c2']));
      expect(result.winner.id).toBe('c1');
      expect(result.rounds[0][0].confidence).toBe(0);
    });
  });

  describe('空候选者抛出错误', () => {
    it('没有候选者时抛出 Error', async () => {
      const client = makeClient('c1');
      const selector = new TournamentSelector(client as never);
      await expect(selector.select([])).rejects.toThrow('至少需要');
    });
  });
});
