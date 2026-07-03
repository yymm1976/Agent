// tests/policies/checkpoint-pipeline.test.ts
// Phase 66 Task 1：CheckpointPipeline 测试
//
// 覆盖：
//   1. 段位映射正确性（7 种 policyType）
//   2. 段位间短路（100s 失败则 400s 不执行）
//   3. 段位内不短路（同段位多 policy 都评估）
//   4. deny-overrides 聚合
//   5. 空段位通过
//   6. firstFailedSegment 正确性
//   7. 关闭时降级为 allow
//   8. enabledSegments 过滤（未启用段位跳过）

import { describe, it, expect } from 'vitest';
import {
  CheckpointPipeline,
  type CheckpointSegment,
} from '../../src/policies/checkpoint-pipeline.js';

describe('CheckpointPipeline (Phase 66 Task 1)', () => {
  // 辅助：构造 policy
  const makePolicy = (id: string, type: string, action: any = {}) => ({
    id,
    type,
    enabled: true,
    priority: 1,
    trigger: { mode: 'always' as const },
    action,
  });

  // 默认 matchTriggerFn：始终匹配
  const alwaysMatch = () => true;

  // 全段位启用配置
  const allSegmentsConfig = {
    enabled: true,
    enabledSegments: [100, 200, 300, 400, 500, 800, 999] as CheckpointSegment[],
    shortCircuit: true,
  };

  // ============================================================
  // 段位映射
  // ============================================================

  describe('段位映射', () => {
    it('1. mapTypeToSegment 正确映射 7 种 policyType', () => {
      const pipeline = new CheckpointPipeline(allSegmentsConfig, alwaysMatch);
      expect(pipeline.mapTypeToSegment('tool_approval')).toBe(100);
      expect(pipeline.mapTypeToSegment('intent_guard')).toBe(200);
      expect(pipeline.mapTypeToSegment('data_safety')).toBe(300);
      expect(pipeline.mapTypeToSegment('resource_limit')).toBe(400);
      expect(pipeline.mapTypeToSegment('workflow_gate')).toBe(500);
      expect(pipeline.mapTypeToSegment('audit_log')).toBe(800);
      expect(pipeline.mapTypeToSegment('fallback')).toBe(999);
    });

    it('未知 policyType 映射到 999（fallback）', () => {
      const pipeline = new CheckpointPipeline(allSegmentsConfig, alwaysMatch);
      expect(pipeline.mapTypeToSegment('unknown_type')).toBe(999);
      expect(pipeline.mapTypeToSegment('')).toBe(999);
    });

    it('SEGMENT_ORDER 常量正确', () => {
      expect(CheckpointPipeline.SEGMENT_ORDER).toEqual([
        100, 200, 300, 400, 500, 800, 999,
      ]);
    });
  });

  // ============================================================
  // 段位间短路
  // ============================================================

  describe('段位间短路', () => {
    it('2. shortCircuit=true 时 100s deny 则 400s 不执行', () => {
      const pipeline = new CheckpointPipeline(allSegmentsConfig, alwaysMatch);
      const policies = [
        makePolicy('p100', 'tool_approval', { block: true }),
        makePolicy('p400', 'resource_limit', { block: true }),
      ];
      const result = pipeline.evaluateAction({}, policies);

      expect(result.firstFailedSegment).toBe(100);
      expect(result.finalAction).toBe('deny');

      const executedSegments = result.segmentResults.map((s) => s.segment);
      expect(executedSegments).toContain(100);
      expect(executedSegments).not.toContain(400);
      expect(executedSegments).not.toContain(500);
      expect(executedSegments).not.toContain(999);
    });

    it('shortCircuit=false 时所有段位都执行', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100, 400], shortCircuit: false },
        alwaysMatch,
      );
      const policies = [
        makePolicy('p100', 'tool_approval', { block: true }),
        makePolicy('p400', 'resource_limit', { block: true }),
      ];
      const result = pipeline.evaluateAction({}, policies);

      const executedSegments = result.segmentResults.map((s) => s.segment);
      expect(executedSegments).toContain(100);
      expect(executedSegments).toContain(400);
      expect(result.firstFailedSegment).toBe(100);
    });
  });

  // ============================================================
  // 段位内不短路
  // ============================================================

  describe('段位内不短路', () => {
    it('3. 同段位多 policy 都评估（不短路）', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100], shortCircuit: true },
        alwaysMatch,
      );
      const policies = [
        makePolicy('p1', 'tool_approval', { block: true }),
        makePolicy('p2', 'tool_approval', { requireApproval: true }),
        makePolicy('p3', 'tool_approval', {}),
      ];
      const result = pipeline.evaluateAction({}, policies);

      expect(result.segmentResults).toHaveLength(1);
      const seg = result.segmentResults[0];
      expect(seg.results).toHaveLength(3);
      expect(seg.results.map((r) => r.policyId).sort()).toEqual(['p1', 'p2', 'p3']);
      // 段内 deny 标记触发短路（因 shortCircuit=true）
      expect(seg.shortCircuit).toBe(true);
    });
  });

  // ============================================================
  // deny-overrides 聚合
  // ============================================================

  describe('deny-overrides 聚合', () => {
    it('4. 任一 deny 则 finalAction=deny', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100, 200], shortCircuit: false },
        alwaysMatch,
      );
      const policies = [
        makePolicy('p1', 'tool_approval', { requireApproval: true }),
        makePolicy('p2', 'intent_guard', { block: true }),
      ];
      const result = pipeline.evaluateAction({}, policies);
      expect(result.finalAction).toBe('deny');
    });

    it('无 deny 但有 requireApproval 则 finalAction=requireApproval', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100], shortCircuit: false },
        alwaysMatch,
      );
      const policies = [makePolicy('p1', 'tool_approval', { requireApproval: true })];
      const result = pipeline.evaluateAction({}, policies);
      expect(result.finalAction).toBe('requireApproval');
    });

    it('全部 allow 则 finalAction=allow', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100, 200], shortCircuit: false },
        alwaysMatch,
      );
      const policies = [
        makePolicy('p1', 'tool_approval', {}),
        makePolicy('p2', 'intent_guard', {}),
      ];
      const result = pipeline.evaluateAction({}, policies);
      expect(result.finalAction).toBe('allow');
    });
  });

  // ============================================================
  // 空段位通过
  // ============================================================

  describe('空段位通过', () => {
    it('5. 无匹配 policy 则 finalAction=allow', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100, 200], shortCircuit: true },
        alwaysMatch,
      );
      const result = pipeline.evaluateAction({}, []);
      expect(result.finalAction).toBe('allow');
      expect(result.firstFailedSegment).toBeNull();
      // 段位仍被执行（只是无 results）
      expect(result.segmentResults).toHaveLength(2);
    });
  });

  // ============================================================
  // firstFailedSegment
  // ============================================================

  describe('firstFailedSegment', () => {
    it('6. 第一个 deny 的段位被记录为 firstFailedSegment', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100, 200, 300], shortCircuit: false },
        alwaysMatch,
      );
      const policies = [
        makePolicy('p100', 'tool_approval', {}),
        makePolicy('p200', 'intent_guard', { block: true }),
        makePolicy('p300', 'data_safety', { block: true }),
      ];
      const result = pipeline.evaluateAction({}, policies);
      expect(result.firstFailedSegment).toBe(200);
      expect(result.finalAction).toBe('deny');
    });

    it('无 deny 时 firstFailedSegment=null', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100, 200], shortCircuit: true },
        alwaysMatch,
      );
      const policies = [makePolicy('p1', 'tool_approval', { requireApproval: true })];
      const result = pipeline.evaluateAction({}, policies);
      expect(result.firstFailedSegment).toBeNull();
    });
  });

  // ============================================================
  // 配置关闭
  // ============================================================

  describe('配置关闭', () => {
    it('7. enabled=false 时降级为 allow', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: false, enabledSegments: [100], shortCircuit: true },
        alwaysMatch,
      );
      const policies = [makePolicy('p1', 'tool_approval', { block: true })];
      const result = pipeline.evaluateAction({}, policies);
      expect(result.finalAction).toBe('allow');
      expect(result.segmentResults).toHaveLength(0);
      expect(result.firstFailedSegment).toBeNull();
    });
  });

  // ============================================================
  // enabledSegments 过滤
  // ============================================================

  describe('enabledSegments 过滤', () => {
    it('8. 未启用段位跳过', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100], shortCircuit: false },
        alwaysMatch,
      );
      const policies = [
        makePolicy('p100', 'tool_approval', { block: true }),
        makePolicy('p400', 'resource_limit', { block: true }),
      ];
      const result = pipeline.evaluateAction({}, policies);

      expect(result.segmentResults).toHaveLength(1);
      expect(result.segmentResults[0].segment).toBe(100);
      // 400 段被跳过，但其 deny 不影响 finalAction（因没执行）
      expect(result.finalAction).toBe('deny');
    });
  });

  // ============================================================
  // matchPolicyToAction 委托
  // ============================================================

  describe('matchPolicyToAction', () => {
    it('委托 matchTriggerFn，仅匹配的 policy 进入 results', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100], shortCircuit: false },
        (policy: any) => policy.id === 'match',
      );
      const policies = [
        makePolicy('match', 'tool_approval'),
        makePolicy('no-match', 'tool_approval'),
      ];
      const result = pipeline.evaluateAction({}, policies);
      const seg = result.segmentResults[0];
      expect(seg.results).toHaveLength(1);
      expect(seg.results[0].policyId).toBe('match');
    });

    it('matchTriggerFn 异常时 fail-open（视为不匹配）', () => {
      const pipeline = new CheckpointPipeline(
        { enabled: true, enabledSegments: [100], shortCircuit: false },
        () => {
          throw new Error('trigger error');
        },
      );
      const policies = [makePolicy('p1', 'tool_approval', { block: true })];
      const result = pipeline.evaluateAction({}, policies);
      // 异常视为不匹配 → 无 results → finalAction=allow
      expect(result.finalAction).toBe('allow');
      expect(result.segmentResults[0].results).toHaveLength(0);
    });
  });
});
