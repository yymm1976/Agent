// src/skills/operation-classifier.ts
// Phase 68 Task 1: 检索/搜索/发现三分标注

import { logger } from '../utils/logger.js';

export type OperationKind = 'retrieval' | 'search' | 'discovery';

export interface OperationSignal {
  ccrHit?: boolean;
  dagComposed?: boolean;
  regimeExtended?: boolean;
  newArtifactTypes?: string[];
}

export interface OperationClassification {
  kind: OperationKind;
  reason: string;
  timestamp: number;
  sessionId: string;
}

export function classifyOperation(signal: OperationSignal, sessionId: string): OperationClassification {
  const timestamp = Date.now();
  if (signal.regimeExtended) {
    return {
      kind: 'discovery',
      reason: `体制扩展：新增 ArtifactType [${(signal.newArtifactTypes ?? []).join(', ')}]`,
      timestamp,
      sessionId,
    };
  }
  if (signal.dagComposed) {
    return {
      kind: 'search',
      reason: '固定 schema 内多技能 DAG 组合',
      timestamp,
      sessionId,
    };
  }
  return {
    kind: 'retrieval',
    reason: signal.ccrHit ? 'CCRCache 命中，添加已可表示制品' : '无体制扩展无新组合，默认 retrieval',
    timestamp,
    sessionId,
  };
}

export interface RegimeTransition {
  beforeSchema: string[];
  afterSchema: string[];
  trigger: OperationClassification;
  claim: string;
}

export function buildRegimeTransition(
  beforeSchema: string[],
  afterSchema: string[],
  trigger: OperationClassification,
): RegimeTransition {
  const added = afterSchema.filter((t) => !beforeSchema.includes(t));
  return {
    beforeSchema: [...beforeSchema],
    afterSchema: [...afterSchema],
    trigger,
    claim: `体制扩展：新增类型 [${added.join(', ')}]，由 ${trigger.reason} 触发`,
  };
}
