import { logger } from '../utils/logger.js';
import type { ILLMClient } from '../router/types.js';

export interface TournamentCandidate<T = string> {
  id: string;
  content: T;
  metadata?: Record<string, unknown>;
}

export interface PairwiseJudgement {
  winnerId: string;
  loserId: string;
  reason: string;
  confidence: number;
}

export interface TournamentResult<T = string> {
  winner: TournamentCandidate<T>;
  rounds: PairwiseJudgement[][];
  totalComparisons: number;
  durationMs: number;
}

export interface TournamentConfig {
  candidateCount: number;
  singleElimination: boolean;
  judgeModelId?: string;
  judgePrompt?: string;
}

const DEFAULT_CONFIG: TournamentConfig = {
  candidateCount: 3,
  singleElimination: true,
};

export class TournamentSelector<T = string> {
  constructor(
    private readonly llmClient: ILLMClient,
    private readonly config: TournamentConfig = DEFAULT_CONFIG,
  ) {}

  async select(candidates: TournamentCandidate<T>[]): Promise<TournamentResult<T>> {
    if (candidates.length === 0) {
      throw new Error('TournamentSelector: 至少需要 1 个候选者');
    }
    if (candidates.length === 1) {
      return {
        winner: candidates[0],
        rounds: [],
        totalComparisons: 0,
        durationMs: 0,
      };
    }

    const start = Date.now();
    const rounds: PairwiseJudgement[][] = [];
    let pool = [...candidates];

    if (this.config.singleElimination) {
      while (pool.length > 1) {
        const roundJudgements: PairwiseJudgement[] = [];
        const nextPool: TournamentCandidate<T>[] = [];

        for (let i = 0; i < pool.length - 1; i += 2) {
          const a = pool[i];
          const b = pool[i + 1];
          const judgement = await this.judge(a, b);
          roundJudgements.push(judgement);
          const winnerCandidate = a.id === judgement.winnerId ? a : b;
          nextPool.push(winnerCandidate);
        }

        if (pool.length % 2 === 1) {
          nextPool.push(pool[pool.length - 1]);
        }

        rounds.push(roundJudgements);
        pool = nextPool;
      }
    } else {
      const roundJudgements: PairwiseJudgement[] = [];
      let current = pool[0];

      for (let i = 1; i < pool.length; i++) {
        const judgement = await this.judge(current, pool[i]);
        roundJudgements.push(judgement);
        current = current.id === judgement.winnerId ? current : pool[i];
      }

      rounds.push(roundJudgements);
      pool = [current];
    }

    const totalComparisons = rounds.reduce((sum, r) => sum + r.length, 0);

    logger.info('TournamentSelector: selection complete', {
      winnerId: pool[0].id,
      rounds: rounds.length,
      totalComparisons,
    });

    return {
      winner: pool[0],
      rounds,
      totalComparisons,
      durationMs: Date.now() - start,
    };
  }

  private async judge(
    a: TournamentCandidate<T>,
    b: TournamentCandidate<T>,
  ): Promise<PairwiseJudgement> {
    const prompt = this.config.judgePrompt
      ? `${this.config.judgePrompt}\n\n候选 A (id: ${a.id}):\n${JSON.stringify(a.content)}\n\n候选 B (id: ${b.id}):\n${JSON.stringify(b.content)}\n\n请选择更优的候选，输出 JSON: {"winnerId": "<id>", "reason": "<reason>", "confidence": 0.0-1.0}`
      : `请从以下两个候选答案中选出更优的一个：\n\n候选 A (id: ${a.id}):\n${JSON.stringify(a.content)}\n\n候选 B (id: ${b.id}):\n${JSON.stringify(b.content)}\n\n请输出 JSON: {"winnerId": "<候选id>", "reason": "<判断原因>", "confidence": 0.0-1.0}`;

    try {
      const response = await this.llmClient.complete({
        model: this.config.judgeModelId ?? '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        stream: false,
      });

      const text = response.content.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('LLM 未返回合法 JSON');
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        winnerId: string;
        reason: string;
        confidence: number;
      };

      const winnerId = parsed.winnerId === a.id ? a.id : b.id;
      const loserId = winnerId === a.id ? b.id : a.id;

      return {
        winnerId,
        loserId,
        reason: parsed.reason ?? '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      };
    } catch (err) {
      logger.warn('TournamentSelector: judge failed, defaulting to first candidate', {
        aId: a.id,
        bId: b.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        winnerId: a.id,
        loserId: b.id,
        reason: `裁判调用失败，默认选择第一个候选: ${err instanceof Error ? err.message : String(err)}`,
        confidence: 0,
      };
    }
  }
}
