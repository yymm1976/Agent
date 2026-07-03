// src/policies/checkpoint-pipeline.ts
// Phase 66 Task 1：策略管道编号分段与治理
//
// 设计目标：
//   1. 将策略按段位编号（100/200/300/400/500/800/999）分段治理
//   2. 段位顺序评估：100→200→300→400→500→800→999
//   3. shortCircuit=true 时，某段 deny 则后续段不执行
//   4. 段位内不短路：同段位多 policy 都评估
//   5. deny-overrides 聚合：任一 deny 则 finalAction=deny
//   6. fail-open：异常或关闭时降级为 allow
//
// 段位映射：
//   100 → tool_approval（工具审批）
//   200 → intent_guard（意图护栏）
//   300 → data_safety（数据安全）
//   400 → resource_limit（资源限制）
//   500 → workflow_gate（工作流闸门）
//   800 → audit_log（审计日志）
//   999 → fallback（兜底）

import { logger } from '../utils/logger.js';

// ============================================================
// 类型定义
// ============================================================

export type CheckpointSegment = 100 | 200 | 300 | 400 | 500 | 800 | 999;

export interface SegmentEvalResult {
  segment: CheckpointSegment;
  results: Array<{ policyId: string; action: 'allow' | 'deny' | 'requireApproval' }>;
  /** 本段是否触发短路（配置 shortCircuit=true 且本段出现 deny） */
  shortCircuit: boolean;
}

export interface PipelineEvalResult {
  /** 第一个失败的段位（deny），全部通过时为 null */
  firstFailedSegment: CheckpointSegment | null;
  segmentResults: SegmentEvalResult[];
  finalAction: 'allow' | 'deny' | 'requireApproval';
}

// ============================================================
// CheckpointPipeline
// ============================================================

/** policyType → 段位 映射表 */
const TYPE_TO_SEGMENT: Record<string, CheckpointSegment> = {
  tool_approval: 100,
  intent_guard: 200,
  data_safety: 300,
  resource_limit: 400,
  workflow_gate: 500,
  audit_log: 800,
  fallback: 999,
};

export class CheckpointPipeline {
  /** 段位评估顺序（从大到小语义：低段位先评估） */
  static readonly SEGMENT_ORDER: readonly CheckpointSegment[] = [
    100, 200, 300, 400, 500, 800, 999,
  ];

  private config: {
    enabled: boolean;
    enabledSegments: CheckpointSegment[];
    shortCircuit: boolean;
  };
  private matchTriggerFn: (policy: any, action: any) => boolean;

  constructor(
    config: { enabled: boolean; enabledSegments: CheckpointSegment[]; shortCircuit: boolean },
    matchTriggerFn: (policy: any, action: any) => boolean,
  ) {
    this.config = config;
    this.matchTriggerFn = matchTriggerFn;
  }

  /** 映射 policyType 到段位；未知类型映射到 999（fallback） */
  mapTypeToSegment(policyType: string): CheckpointSegment {
    return TYPE_TO_SEGMENT[policyType] ?? 999;
  }

  /** 委托 matchTriggerFn；异常时 fail-open（视为不匹配） */
  matchPolicyToAction(policy: any, action: any): boolean {
    try {
      return Boolean(this.matchTriggerFn(policy, action));
    } catch (err) {
      logger.warn('CheckpointPipeline: matchTriggerFn threw, treating as no match', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * 段内评估：同段位所有 policy 都评估（不短路）
   * 仅匹配当前段位且 matchTriggerFn 返回 true 的 policy 进入 results
   */
  evaluateSegment(
    segment: CheckpointSegment,
    action: any,
    policies: any[],
  ): SegmentEvalResult {
    const results: SegmentEvalResult['results'] = [];
    let hasDeny = false;

    for (const policy of policies ?? []) {
      // 段位过滤
      const seg = this.mapTypeToSegment(policy?.type ?? '');
      if (seg !== segment) continue;
      // 匹配过滤
      if (!this.matchPolicyToAction(policy, action)) continue;

      const act = this.deriveAction(policy);
      results.push({ policyId: String(policy?.id ?? ''), action: act });
      if (act === 'deny') hasDeny = true;
    }

    // 段内短路标记：仅当配置 shortCircuit=true 且本段有 deny 时才视为触发短路
    const shortCircuit = this.config.shortCircuit && hasDeny;

    return { segment, results, shortCircuit };
  }

  /**
   * 按段位顺序评估整个管道
   * - 关闭时 fail-open：返回 allow + 空 segmentResults
   * - shortCircuit=true 时，遇到 deny 段后后续段不再执行
   * - deny-overrides 聚合
   */
  evaluateAction(action: any, policies: any[]): PipelineEvalResult {
    // fail-open：关闭时降级为 allow
    if (!this.config.enabled) {
      return {
        firstFailedSegment: null,
        segmentResults: [],
        finalAction: 'allow',
      };
    }

    const segmentResults: SegmentEvalResult[] = [];
    let firstFailedSegment: CheckpointSegment | null = null;
    let finalDeny = false;
    let finalRequireApproval = false;

    try {
      for (const segment of CheckpointPipeline.SEGMENT_ORDER) {
        // enabledSegments 过滤：未启用段位跳过
        if (!this.config.enabledSegments.includes(segment)) continue;

        const segResult = this.evaluateSegment(segment, action, policies ?? []);
        segmentResults.push(segResult);

        const segHasDeny = segResult.results.some((r) => r.action === 'deny');
        const segHasRequireApproval = segResult.results.some(
          (r) => r.action === 'requireApproval',
        );

        if (segHasDeny) {
          finalDeny = true;
          if (firstFailedSegment === null) {
            firstFailedSegment = segment;
          }
          // shortCircuit=true 时遇到 deny 后续段不执行
          if (this.config.shortCircuit) {
            break;
          }
        }
        if (segHasRequireApproval) {
          finalRequireApproval = true;
        }
      }
    } catch (err) {
      // fail-open：异常时降级为 allow
      logger.warn('CheckpointPipeline: evaluateAction threw, failing open', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { firstFailedSegment, segmentResults, finalAction: 'allow' };
    }

    // deny-overrides 聚合
    const finalAction: PipelineEvalResult['finalAction'] = finalDeny
      ? 'deny'
      : finalRequireApproval
        ? 'requireApproval'
        : 'allow';

    return { firstFailedSegment, segmentResults, finalAction };
  }

  /** 从 policy.action 推导出动作语义 */
  private deriveAction(policy: any): 'allow' | 'deny' | 'requireApproval' {
    const act = policy?.action ?? {};
    if (act.block === true) return 'deny';
    if (act.requireApproval === true) return 'requireApproval';
    return 'allow';
  }
}
