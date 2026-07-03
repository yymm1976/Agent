// src/agent/quantitative-gate.ts
// Phase 68 Task 5: MDL/AIC 定量门

import { estimateTokens } from '../utils/token-estimate.js';

export interface CandidateSolution {
  id: string;
  description: string;
  artifact?: string;
  fitScore?: number;
  complexity?: number;
}

export type GateDecision = 'accept' | 'reject' | 'supersede' | 'hold';

export interface GateEvaluation {
  decision: GateDecision;
  mdlScore: number;
  aicScore: number;
  compositeScore: number;
  rationale: string;
}

export interface QuantitativeGateConfig {
  enabled: boolean;
  mdlWeight: number;
  aicWeight: number;
  acceptThreshold: number;
  rejectThreshold: number;
  complexityPenalty: number;
}

export const DEFAULT_GATE_CONFIG: QuantitativeGateConfig = {
  enabled: false,
  mdlWeight: 0.4,
  aicWeight: 0.6,
  acceptThreshold: 0.7,
  rejectThreshold: 0.3,
  complexityPenalty: 0.01,
};

export class QuantitativeGate {
  constructor(private readonly config: QuantitativeGateConfig) {}

  evaluate(candidate: CandidateSolution): GateEvaluation {
    const tokens = estimateTokens(candidate.description + (candidate.artifact ?? ''));
    const mdlScore = 1 - Math.min(1, tokens / 500);

    const fitScore = candidate.fitScore ?? 0.5;
    const complexity = candidate.complexity ?? tokens;
    const aicRaw = fitScore - complexity * this.config.complexityPenalty;
    const normalizedAic = 1 - Math.min(1, Math.max(0, aicRaw));

    const compositeScore =
      this.config.mdlWeight * mdlScore + this.config.aicWeight * normalizedAic;

    let decision: GateDecision;
    let rationale: string;
    if (compositeScore >= this.config.acceptThreshold) {
      decision = 'accept';
      rationale = `综合分 ${compositeScore.toFixed(3)} >= acceptThreshold ${this.config.acceptThreshold}`;
    } else if (compositeScore < this.config.rejectThreshold) {
      decision = 'reject';
      rationale = `综合分 ${compositeScore.toFixed(3)} < rejectThreshold ${this.config.rejectThreshold}`;
    } else {
      decision = 'hold';
      rationale = `综合分 ${compositeScore.toFixed(3)} 介于 reject 与 accept 之间，需人工/软判断`;
    }

    return { decision, mdlScore, aicScore: normalizedAic, compositeScore, rationale };
  }

  evaluateMultiple(candidates: CandidateSolution[]): GateEvaluation[] {
    const evaluations = candidates.map((c) => ({ candidate: c, eval: this.evaluate(c) }));
    evaluations.sort((a, b) => b.eval.compositeScore - a.eval.compositeScore);

    if (evaluations.length === 0) return [];

    const top = evaluations[0];
    const result: GateEvaluation[] = [];

    if (top.eval.decision === 'accept') {
      result.push({ ...top.eval, decision: 'accept' });
      for (let i = 1; i < evaluations.length; i++) {
        result.push({
          ...evaluations[i].eval,
          decision: 'supersede',
          rationale: `被更优候选 ${top.candidate.id} 取代（${top.eval.compositeScore.toFixed(3)} > ${evaluations[i].eval.compositeScore.toFixed(3)}）`,
        });
      }
    } else {
      for (const e of evaluations) result.push(e.eval);
    }

    return result;
  }
}
