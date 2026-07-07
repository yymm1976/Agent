// tests/skills/operation-classifier.test.ts
// Phase 68 Task 1: Operation Classifier 单元测试

import { describe, it, expect } from 'vitest';
import {
  classifyOperation,
} from '../../src/skills/operation-classifier.js';
import type { OperationSignal } from '../../src/skills/operation-classifier.js';

describe('classifyOperation (Phase 68 Task 1)', () => {
  it('ccrHit=true, no dagComposed, no regimeExtended → retrieval', () => {
    const signal: OperationSignal = { ccrHit: true };
    const result = classifyOperation(signal, 's1');

    expect(result.kind).toBe('retrieval');
    expect(result.reason).toBe('CCRCache 命中，添加已可表示制品');
    expect(result.sessionId).toBe('s1');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('dagComposed=true → search', () => {
    const signal: OperationSignal = { dagComposed: true };
    const result = classifyOperation(signal, 's2');

    expect(result.kind).toBe('search');
    expect(result.reason).toBe('固定 schema 内多技能 DAG 组合');
    expect(result.sessionId).toBe('s2');
  });

  it('regimeExtended=true → discovery', () => {
    const signal: OperationSignal = {
      regimeExtended: true,
      newArtifactTypes: ['TypeA'],
    };
    const result = classifyOperation(signal, 's3');

    expect(result.kind).toBe('discovery');
    expect(result.reason).toContain('体制扩展');
    expect(result.reason).toContain('TypeA');
    expect(result.sessionId).toBe('s3');
  });

  it('priority: regimeExtended > dagComposed > ccrHit', () => {
    const signal: OperationSignal = {
      ccrHit: true,
      dagComposed: true,
      regimeExtended: true,
      newArtifactTypes: ['TypeX'],
    };
    const result = classifyOperation(signal, 's4');

    expect(result.kind).toBe('discovery');
  });

  it('dagComposed + ccrHit → search (dagComposed wins)', () => {
    const signal: OperationSignal = {
      ccrHit: true,
      dagComposed: true,
    };
    const result = classifyOperation(signal, 's5');

    expect(result.kind).toBe('search');
  });

  it('empty signal → default retrieval', () => {
    const signal: OperationSignal = {};
    const result = classifyOperation(signal, 's6');

    expect(result.kind).toBe('retrieval');
    expect(result.reason).toBe('无体制扩展无新组合，默认 retrieval');
  });

  it('discovery with multiple newArtifactTypes', () => {
    const signal: OperationSignal = {
      regimeExtended: true,
      newArtifactTypes: ['Alpha', 'Beta', 'Gamma'],
    };
    const result = classifyOperation(signal, 's7');

    expect(result.kind).toBe('discovery');
    expect(result.reason).toContain('Alpha');
    expect(result.reason).toContain('Beta');
    expect(result.reason).toContain('Gamma');
  });

  it('discovery with no newArtifactTypes defaults to empty list', () => {
    const signal: OperationSignal = {
      regimeExtended: true,
    };
    const result = classifyOperation(signal, 's8');

    expect(result.kind).toBe('discovery');
    expect(result.reason).toContain('[]');
  });
});
